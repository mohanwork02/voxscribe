from openai import OpenAI

from interview_langgraph.config import (
    QA_MODEL,
    QA_PROMPT_PATH,
    RETRIEVAL_MODE,
    STREAM_OUTPUT,
    get_env_int,
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

    sections = read_prompt_sections(QA_PROMPT_PATH)
    system_prompt = sections.get("system") or ""
    user_template = sections.get("user") or ""
    if not system_prompt or not user_template:
        return (
            f"Invalid QA prompt file: {QA_PROMPT_PATH}. "
            "Expected sections ===SYSTEM=== and ===USER===.",
            False,
        )

    context = "\n\n".join(context_chunks).strip()
    issues = get_openai_setup_issues()
    if issues:
        return "Cannot call LLM API:\n- " + "\n- ".join(issues), False

    messages = [{"role": "system", "content": system_prompt}]
    messages.extend(coerce_history(history))
    messages.append({"role": "user", "content": user_template.format(context=context, query=query)})

    if STREAM_OUTPUT:
        print("Streaming Running with 1")
        answer, streamed = stream_chat_completion_text(
            client=_client,
            model=QA_MODEL,
            messages=messages,
            temperature=0.5,
            max_tokens=1000,
        )
        return answer, streamed
    
    print("NOT Streaming Running with 0")
    response = _client.chat.completions.create(
        model=QA_MODEL,
        messages=messages,
        temperature=0.5,
        max_tokens=1000,
    )
    return (response.choices[0].message.content or "").strip(), False


def answer_qa(state: WorkflowState) -> WorkflowState:
    """
    Fallback KB-aware Q&A node:
    - Uses local retrieval when available.
    - Answers general questions directly.
    - Refuses to invent unsupported candidate-specific facts.
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
        context_chunks = []

    answer, streamed = _call_llm(query, context_chunks, history=history)
    return {"answer": answer, "streamed": streamed}
