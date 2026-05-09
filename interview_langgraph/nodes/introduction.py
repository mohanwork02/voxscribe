from openai import OpenAI

from interview_langgraph.config import (
    SELF_INTRO_MODEL,
    INTRO_PROMPT_PATH,
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


_INTRO_SEED_QUERIES: tuple[str, ...] = (
    "professional summary",
    "summary",
    "profile",
    "about me",
    "experience",
    "work experience",
    "skills",
    "education",
    "projects",
    "certifications",
    "achievements",
    "objective",
)


def _dedupe_keep_order(items: list[str]) -> list[str]:
    seen: set[str] = set()
    out: list[str] = []
    for item in items:
        if not item or item in seen:
            continue
        seen.add(item)
        out.append(item)
    return out


def generate_introduction(
    query: str, context_chunks: list[str], *, history: list[dict[str, str]] | None = None
) -> tuple[str, bool]:
    global _client
    _client = _client or OpenAI()

    sections = read_prompt_sections(INTRO_PROMPT_PATH)
    system_prompt = sections.get("system") or ""
    user_template = sections.get("user") or ""
    if not system_prompt or not user_template:
        return (
            f"Invalid introduction prompt file: {INTRO_PROMPT_PATH}. "
            "Expected sections ===SYSTEM=== and ===USER===."
        ), False
    context = "\n\n".join(context_chunks)

    issues = get_openai_setup_issues()
    if issues:
        return "Cannot call LLM API:\n- " + "\n- ".join(issues), False

    try:
        messages = [{"role": "system", "content": system_prompt}]
        messages.extend(coerce_history(history))
        messages.append(
            {"role": "user", "content": user_template.format(context=context, query=query)}
        )

        if STREAM_OUTPUT:
            answer, streamed = stream_chat_completion_text(
                client=_client,
                model=SELF_INTRO_MODEL,
                messages=messages,
                temperature=0.7,
                max_tokens=3000,
                
            )
            return answer, streamed

        response = _client.chat.completions.create(
            model=SELF_INTRO_MODEL,
            messages=messages,
            temperature=0.7,
            max_tokens=3000,
            
        )
        return (response.choices[0].message.content or "").strip(), False
    except Exception:
        return (
            "I couldn't reach the LLM API. Check your internet/proxy settings and OPENAI_API_KEY."
        ), False



def answer_with_introduction(state: WorkflowState) -> WorkflowState:
    query = (state.get("query") or "").strip()
    if not query:
        return {"answer": ""}

    history = state.get("history")
    top_k = int(state.get("top_k") or get_env_int("TOP_K"))
    try:
        index, texts = load_faiss()
    except FileNotFoundError:
        return {
            "answer": (
                "Your knowledge base isn't ready yet. Run ingestion first "
                "(e.g. `python run.py ingest --files <your.pdf>`)."
            )
        }
    try:
        if RETRIEVAL_MODE == "embedding" and not get_openai_setup_issues():
            top_chunks = retrieve(query, index, texts, top_k=top_k)
        else:
            top_chunks = retrieve_lexical(query, texts, top_k=top_k)

        # "Introduce yourself" style prompts are often too generic for lexical search.
        # If retrieval yields nothing, fall back to common resume/profile sections.
        if not top_chunks and texts:
            seeded: list[str] = []
            per_seed = max(1, top_k // 2)
            for seed in _INTRO_SEED_QUERIES:
                seeded.extend(retrieve_lexical(seed, texts, top_k=per_seed))
            top_chunks = _dedupe_keep_order(seeded)[:top_k] or texts[:top_k]

        answer, streamed = generate_introduction(query, top_chunks, history=history)
        return {"answer": answer, "streamed": streamed}
    except Exception:
        answer, streamed = generate_introduction(query, [], history=history)
        return {"answer": answer, "streamed": streamed}
