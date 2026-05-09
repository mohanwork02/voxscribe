from openai import OpenAI

from interview_langgraph.config import (
    CODE_MODEL,
    CODE_PROMPT_PATH,
    RETRIEVAL_MODE,
    STREAM_OUTPUT,
    get_env_int,
    get_openai_setup_issues,
)
from interview_langgraph.memory import coerce_history
from interview_langgraph.prompt_loader import read_prompt
from interview_langgraph.state import WorkflowState
from interview_langgraph.streaming_utils import stream_chat_completion_text
from smart_input_llm import load_faiss, retrieve, retrieve_lexical


_client = None


def answer_code(state: WorkflowState) -> WorkflowState:
    global _client
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

    context = "\n\n".join(context_chunks).strip()
    issues = get_openai_setup_issues()
    if issues:
        return {"answer": "Cannot call LLM API:\n- " + "\n- ".join(issues)}

    _client = _client or OpenAI()
    system_prompt = read_prompt(CODE_PROMPT_PATH)

    try:
        messages = [{"role": "system", "content": system_prompt}]
        messages.extend(coerce_history(history))
        if context:
            messages.append({"role": "user", "content": f"Reference context:\n{context}\n\nQuestion:\n{query}"})
        else:
            messages.append({"role": "user", "content": query})
        if STREAM_OUTPUT:
            answer, streamed = stream_chat_completion_text(
                client=_client,
                model=CODE_MODEL,
                messages=messages,
                temperature=0.7,
                max_tokens=3000,
                
            )
            return {"answer": answer, "streamed": streamed}

        response = _client.chat.completions.create(
            model=CODE_MODEL,
            messages=messages,
            temperature=0.7,
            max_tokens=3000,
        )
        return {"answer": (response.choices[0].message.content or "").strip(), "streamed": False}
    except Exception:
        return {
            "answer": (
                "I couldn't reach the LLM API. Check your internet/proxy settings and OPENAI_API_KEY."
            )
        }
