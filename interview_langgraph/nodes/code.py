from openai import OpenAI

from interview_langgraph.config import CODE_MODEL, CODE_PROMPT_PATH, STREAM_OUTPUT, get_openai_setup_issues
from interview_langgraph.memory import coerce_history
from interview_langgraph.prompt_loader import read_prompt
from interview_langgraph.state import WorkflowState
from interview_langgraph.streaming_utils import stream_chat_completion_text


_client = None


def answer_code(state: WorkflowState) -> WorkflowState:
    global _client
    query = (state.get("query") or "").strip()
    if not query:
        return {"answer": ""}

    history = state.get("history")
    issues = get_openai_setup_issues()
    if issues:
        return {"answer": "Cannot call LLM API:\n- " + "\n- ".join(issues)}

    _client = _client or OpenAI()
    system_prompt = read_prompt(CODE_PROMPT_PATH)

    try:
        messages = [{"role": "system", "content": system_prompt}]
        messages.extend(coerce_history(history))
        messages.append({"role": "user", "content": query})
        if STREAM_OUTPUT:
            answer, streamed = stream_chat_completion_text(
                client=_client,
                model=CODE_MODEL,
                messages=messages,
                temperature=0.7,
                max_tokens=5000,
                
            )
            return {"answer": answer, "streamed": streamed}

        response = _client.chat.completions.create(
            model=CODE_MODEL,
            messages=messages,
            temperature=0.7,
            max_tokens=5000,
        )
        return {"answer": (response.choices[0].message.content or "").strip(), "streamed": False}
    except Exception:
        return {
            "answer": (
                "I couldn't reach the LLM API. Check your internet/proxy settings and OPENAI_API_KEY."
            )
        }
