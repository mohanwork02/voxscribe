import json
import logging

from openai import OpenAI

from interview_langgraph.config import (
    ROUTER_MODEL,
    ROUTER_PROMPT_PATH,
    ROUTING_MODE,
    get_openai_setup_issues,
)
from interview_langgraph.memory import coerce_history
from interview_langgraph.prompt_loader import read_prompt
from interview_langgraph.state import WorkflowState


_client = None
logger = logging.getLogger(__name__)
CODE_TRIGGERS = [
    "code",
    "python",
    "javascript",
    "typescript",
    "java",
    "c++",
    "c#",
    "golang",
    "rust",
    "sql",
    "debug",
    "error",
    "traceback",
    "stack trace",
    "exception",
    "bug",
    "function",
    "class",
    "api",
    "endpoint",
    "algorithm",
    "regex",
]
INTRO_TRIGGERS = [
    "introduce yourself",
    "tell me about yourself",
    "about me",
    "self introduction",
    "self-introduction",
    "what is your name",
    "what's your name",
    "your name",
    "how many years of experience",
    "years of experience",
    "total experience",
    "resume",
    "cv",
    "my experience",
    "my skills",
    "my education",
    "summary of my",
    "summarize my",
    "who am i",
    "profile",
]
PROJECT_TRIGGERS = [
    "project",
    "projects",
    "capstone",
    "portfolio",
    "explain my project",
    "describe my project",
    "tell me about my project",
    "project details",
]
SCENARIO_TRIGGERS = [
    "scenario",
    "situational",
    "case study",
    "hypothetical",
    "suppose",
    "imagine",
    "what would you do",
    "how would you handle",
    "how would you approach",
    "walk me through",
    "tell me about a time",
    "how did you handle",
    "if you were",
    "given a situation",
]


def _preview_text(value: str, *, limit: int = 160) -> str:
    text = " ".join(str(value or "").split())
    if len(text) <= limit:
        return text
    return text[: max(0, limit - 1)] + "..."


def _find_trigger(query: str, triggers: list[str]) -> str | None:
    q = (query or "").strip().lower()
    if not q:
        return None
    for trigger in triggers:
        if trigger in q:
            return trigger
    return None


def _looks_like_code_query(query: str) -> bool:
    return _find_trigger(query, CODE_TRIGGERS) is not None


def _looks_like_intro_query(query: str) -> bool:
    return _find_trigger(query, INTRO_TRIGGERS) is not None


def _looks_like_project_query(query: str) -> bool:
    return _find_trigger(query, PROJECT_TRIGGERS) is not None


def _looks_like_scenario_query(query: str) -> bool:
    return _find_trigger(query, SCENARIO_TRIGGERS) is not None


def route_node(state: WorkflowState) -> WorkflowState:
    global _client
    query = (state.get("query") or "").strip()
    if not query:
        return {"route": "end"}

    history = state.get("history")

    def deterministic_route() -> WorkflowState:
        # In offline mode, include a small amount of prior context for better follow-ups.
        combined = query
        hist = coerce_history(history)
        if hist:
            combined = "\n".join([m["content"] for m in hist] + [query])
        history_count = len(hist)

        intro_trigger = _find_trigger(combined, INTRO_TRIGGERS)
        if intro_trigger:
            logger.info(
                "Router logic mode=deterministic route=introduction trigger=%s history_messages=%s query=%s combined=%s",
                intro_trigger,
                history_count,
                _preview_text(query),
                _preview_text(combined),
            )
            return {"route": "introduction"}

        code_trigger = _find_trigger(combined, CODE_TRIGGERS)
        if code_trigger:
            logger.info(
                "Router logic mode=deterministic route=code trigger=%s history_messages=%s query=%s combined=%s",
                code_trigger,
                history_count,
                _preview_text(query),
                _preview_text(combined),
            )
            return {"route": "code"}

        scenario_trigger = _find_trigger(combined, SCENARIO_TRIGGERS)
        if scenario_trigger:
            logger.info(
                "Router logic mode=deterministic route=scenario trigger=%s history_messages=%s query=%s combined=%s",
                scenario_trigger,
                history_count,
                _preview_text(query),
                _preview_text(combined),
            )
            return {"route": "scenario"}

        project_trigger = _find_trigger(combined, PROJECT_TRIGGERS)
        if project_trigger:
            logger.info(
                "Router logic mode=deterministic route=project_explaination trigger=%s history_messages=%s query=%s combined=%s",
                project_trigger,
                history_count,
                _preview_text(query),
                _preview_text(combined),
            )
            return {"route": "project_explaination"}

        logger.info(
            "Router logic mode=deterministic route=qa trigger=none history_messages=%s query=%s combined=%s",
            history_count,
            _preview_text(query),
            _preview_text(combined),
        )
        return {"route": "qa"}

    # Honour explicit routing mode preference.
    if ROUTING_MODE == "rules":
        result = deterministic_route()
        logger.info("Router decision mode=rules route=%s", str(result.get("route") or ""))
        return result

    # If OpenAI is not configured (key/proxy), fall back to deterministic routing.
    if get_openai_setup_issues():
        result = deterministic_route()
        logger.info("Router decision mode=fallback route=%s", str(result.get("route") or ""))
        return result

    _client = _client or OpenAI()
    system_prompt = read_prompt(ROUTER_PROMPT_PATH)

    try:
        messages = [{"role": "system", "content": system_prompt}]
        coerced_history = coerce_history(history)
        messages.extend(coerced_history)
        messages.append({"role": "user", "content": query})
        response = _client.chat.completions.create(
            model=ROUTER_MODEL,
            messages=messages,
            response_format={"type": "json_object"},
            temperature=0,
        )
        raw = (response.choices[0].message.content or "").strip()
        data = json.loads(raw)
        route = str(data.get("route") or "").strip().lower()
        logger.info(
            "Router logic mode=llm history_messages=%s query=%s raw_response=%s parsed_route=%s",
            len(coerced_history),
            _preview_text(query),
            _preview_text(raw),
            route or "-",
        )
    except Exception as exc:
        logger.warning(
            "Router logic mode=llm_error query=%s err=%s fallback=qa",
            _preview_text(query),
            str(exc),
        )
        route = "qa"

    if route not in {"introduction", "project_explaination", "code", "scenario", "qa"}:
        logger.warning(
            "Router logic mode=llm_invalid query=%s parsed_route=%s fallback=qa",
            _preview_text(query),
            route or "-",
        )
        route = "qa"
    logger.info("Router decision mode=llm route=%s", route)
    return {"route": route}
