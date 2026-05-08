from openai import OpenAI

from interview_langgraph.config import (
    PROJECT_EXPLAINATION_MODEL,
    PROJECT_EXPLAINATION_PROMPT_PATH,
    STREAM_OUTPUT,
    get_env_int,
    RETRIEVAL_MODE,
    get_openai_setup_issues,
)
from interview_langgraph.prompt_loader import read_prompt_sections
from interview_langgraph.state import WorkflowState
from interview_langgraph.streaming_utils import stream_chat_completion_text
from interview_langgraph.memory import coerce_history
from smart_input_llm import load_faiss, retrieve, retrieve_lexical


_client = None


def _call_llm(
    query: str,
    context_chunks: list[str],
    *,
    history: list[dict[str, str]] | None = None,
) -> tuple[str, bool]:
    global _client
    _client = _client or OpenAI()

    sections = read_prompt_sections(PROJECT_EXPLAINATION_PROMPT_PATH)
    system_prompt = sections.get("system") or ""
    user_template = sections.get("user") or ""
    if not system_prompt or not user_template:
        return (
            f"Invalid project prompt file: {PROJECT_EXPLAINATION_PROMPT_PATH}. "
            "Expected sections ===SYSTEM=== and ===USER===."
        )

    context = "\n\n".join(context_chunks).strip()
    issues = get_openai_setup_issues()
    if issues:
        return "Cannot call LLM API:\n- " + "\n- ".join(issues), False

    messages = [{"role": "system", "content": system_prompt}]
    messages.extend(coerce_history(history))
    messages.append({"role": "user", "content": user_template.format(context=context, query=query)})

    if STREAM_OUTPUT:
        answer, streamed = stream_chat_completion_text(
            client=_client,
            model=PROJECT_EXPLAINATION_MODEL,
            messages=messages,
            temperature=0.2,
            max_tokens=600,
        )
        return answer, streamed

    response = _client.chat.completions.create(
        model=PROJECT_EXPLAINATION_MODEL,
        messages=messages,
        temperature=0.2,
        max_tokens=600,
    )
    return (response.choices[0].message.content or "").strip(), False


def explain_projects(state: WorkflowState) -> WorkflowState:
    """
    KB-first node:
    1) Try to retrieve context from the local index and answer using it.
    2) If no index exists OR retrieval yields no chunks, fall back to a general LLM answer
       that avoids inventing project-specific claims.
    """
    query = (state.get("query") or "").strip()
    if not query:
        return {"answer": ""}

    history = state.get("history")
    top_k = int(state.get("top_k") or get_env_int("TOP_K"))

    context_chunks: list[str] = []
    try:
        index, texts = load_faiss()
        if RETRIEVAL_MODE == "embedding" and not get_openai_setup_issues():
            context_chunks = retrieve(query, index, texts, top_k=top_k)
        else:
            context_chunks = retrieve_lexical(query, texts, top_k=top_k)
    except FileNotFoundError:
        context_chunks = []
    except Exception:
        # If retrieval fails for any reason, do not hallucinate—fall back to general guidance.
        context_chunks = []

    answer, streamed = _call_llm(query, context_chunks, history=history)
    return {"answer": answer, "streamed": streamed}
