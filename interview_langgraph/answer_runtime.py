from __future__ import annotations

from dataclasses import dataclass

from openai import OpenAI

from interview_langgraph.config import (
    CODE_MODEL,
    CODE_PROMPT_PATH,
    INTRO_PROMPT_PATH,
    PROJECT_EXPLAINATION_MODEL,
    PROJECT_EXPLAINATION_PROMPT_PATH,
    QA_MODEL,
    QA_PROMPT_PATH,
    RETRIEVAL_MODE,
    SCENARIO_MODEL,
    SCENARIO_PROMPT_PATH,
    SELF_INTRO_MODEL,
    get_env_int,
    get_openai_setup_issues,
)
from interview_langgraph.memory import coerce_history
from interview_langgraph.prompt_loader import read_prompt, read_prompt_sections
from interview_langgraph.route.router import route_node


VALID_ROUTES = {"introduction", "project_explaination", "code", "scenario", "qa"}
DEFAULT_TEMPERATURE = 0.7
DEFAULT_MAX_TOKENS = 5000
_INTRO_SEED_QUERIES: tuple[str, ...] = (
    "professional summary",
    "summary",
    "profile",
    "about me",
    "experience",
    "work history",
    "work experience",
    "skills",
    "education",
    "projects",
    "certifications",
    "achievements",
    "objective",
    "name",
    "years of experience",
)


@dataclass(frozen=True)
class PreparedAnswerRequest:
    route: str
    top_k: int
    context_chunks: list[str]
    model: str
    messages: list[dict[str, str]]
    temperature: float = DEFAULT_TEMPERATURE
    max_tokens: int = DEFAULT_MAX_TOKENS


def _normalize_route(value: str) -> str:
    route = str(value or "").strip().lower()
    return route if route in VALID_ROUTES else "qa"


def resolve_route(*, query: str, history: list[dict[str, str]] | None = None) -> str:
    return _normalize_route(route_node({"query": query, "history": history}).get("route") or "qa")


def resolve_top_k(top_k: int | None) -> int:
    return int(top_k if top_k is not None else get_env_int("TOP_K"))


def iter_openai_chat_deltas(
    *,
    model: str,
    messages: list[dict[str, str]],
    temperature: float,
    max_tokens: int,
):
    client = OpenAI()
    stream = client.chat.completions.create(
        model=model,
        messages=messages,
        temperature=temperature,
        max_tokens=max_tokens,
        stream=True,
    )

    for chunk in stream:
        try:
            if not chunk.choices:
                continue
            delta = chunk.choices[0].delta
            text = getattr(delta, "content", None)
        except Exception:
            text = None
        if text:
            yield str(text)


def build_context_chunks(*, query: str, top_k: int) -> list[str]:
    """
    IMPORTANT: import `smart_input_llm` via the top-level module name.
    The backend reconfigures tenant-specific artifact paths on that module instance.
    Importing it as `interview_langgraph.smart_input_llm` would create a second
    module object and break the existing dynamic path behavior.
    """
    try:
        from smart_input_llm import load_faiss, retrieve, retrieve_lexical
    except Exception:
        return []

    try:
        index, texts = load_faiss()
        if RETRIEVAL_MODE == "embedding" and not get_openai_setup_issues():
            return retrieve(query, index, texts, top_k=top_k)
        return retrieve_lexical(query, texts, top_k=top_k)
    except Exception:
        return []


def build_intro_context_chunks(*, query: str, top_k: int) -> list[str]:
    try:
        from smart_input_llm import load_faiss, retrieve_lexical

        _, texts = load_faiss()
    except Exception:
        return []

    chunks = build_context_chunks(query=query, top_k=top_k)
    if chunks:
        return chunks

    seeded: list[str] = []
    per_seed = max(1, top_k // 2)
    for seed in _INTRO_SEED_QUERIES:
        try:
            seeded.extend(retrieve_lexical(seed, texts, top_k=per_seed))
        except Exception:
            continue

    out: list[str] = []
    seen: set[str] = set()
    for item in seeded:
        if not item or item in seen:
            continue
        seen.add(item)
        out.append(item)
        if len(out) >= top_k:
            break

    return out or texts[:top_k]


def build_messages_for_route(
    *,
    route: str,
    query: str,
    context_chunks: list[str],
    history: list[dict[str, str]] | None = None,
) -> tuple[str, list[dict[str, str]], float, int]:
    normalized_route = _normalize_route(route)
    context = "\n\n".join(context_chunks).strip()
    messages: list[dict[str, str]] = []

    if normalized_route == "code":
        system_prompt = read_prompt(CODE_PROMPT_PATH)
        messages = [{"role": "system", "content": system_prompt}]
        messages.extend(coerce_history(history))
        if context:
            messages.append({"role": "user", "content": f"Reference context:\n{context}\n\nQuestion:\n{query}"})
        else:
            messages.append({"role": "user", "content": query})
        return CODE_MODEL, messages, DEFAULT_TEMPERATURE, DEFAULT_MAX_TOKENS

    if normalized_route == "introduction":
        sections = read_prompt_sections(INTRO_PROMPT_PATH)
        system_prompt = sections.get("system") or ""
        user_template = sections.get("user") or ""
        model = SELF_INTRO_MODEL
    elif normalized_route == "project_explaination":
        sections = read_prompt_sections(PROJECT_EXPLAINATION_PROMPT_PATH)
        system_prompt = sections.get("system") or ""
        user_template = sections.get("user") or ""
        model = PROJECT_EXPLAINATION_MODEL
    elif normalized_route == "scenario":
        sections = read_prompt_sections(SCENARIO_PROMPT_PATH)
        system_prompt = sections.get("system") or ""
        user_template = sections.get("user") or ""
        model = SCENARIO_MODEL
    else:
        sections = read_prompt_sections(QA_PROMPT_PATH)
        system_prompt = sections.get("system") or ""
        user_template = sections.get("user") or ""
        model = QA_MODEL

    messages = [{"role": "system", "content": system_prompt}]
    messages.extend(coerce_history(history))
    messages.append({"role": "user", "content": user_template.format(context=context, query=query)})
    return model, messages, DEFAULT_TEMPERATURE, DEFAULT_MAX_TOKENS


def prepare_answer_request(
    *,
    query: str,
    history: list[dict[str, str]] | None = None,
    top_k: int | None = None,
) -> PreparedAnswerRequest:
    query_text = str(query or "").strip()
    if not query_text:
        raise ValueError("Missing query text.")

    issues = get_openai_setup_issues()
    if issues:
        raise RuntimeError("Cannot call LLM API:\n- " + "\n- ".join(issues))

    top_k_value = resolve_top_k(top_k)
    route = resolve_route(query=query_text, history=history)
    context_chunks = (
        build_intro_context_chunks(query=query_text, top_k=top_k_value)
        if route == "introduction"
        else build_context_chunks(query=query_text, top_k=top_k_value)
    )
    model, messages, temperature, max_tokens = build_messages_for_route(
        route=route,
        query=query_text,
        context_chunks=context_chunks,
        history=history,
    )

    return PreparedAnswerRequest(
        route=route,
        top_k=top_k_value,
        context_chunks=context_chunks,
        model=model,
        messages=messages,
        temperature=temperature,
        max_tokens=max_tokens,
    )
