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


def _looks_like_code_query(query: str) -> bool:
    q = (query or "").strip().lower()
    if not q:
        return False
    triggers = [
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
    return any(t in q for t in triggers)


def _looks_like_intro_query(query: str) -> bool:
    q = (query or "").strip().lower()
    if not q:
        return False
    triggers = [
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
    return any(t in q for t in triggers)


def _looks_like_project_query(query: str) -> bool:
    q = (query or "").strip().lower()
    if not q:
        return False
    triggers = [
        "project",
        "projects",
        "capstone",
        "portfolio",
        "explain my project",
        "describe my project",
        "tell me about my project",
        "project details",
    ]
    return any(t in q for t in triggers)


def _looks_like_scenario_query(query: str) -> bool:
    q = (query or "").strip().lower()
    if not q:
        return False
    triggers = [
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
    return any(t in q for t in triggers)


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

        if _looks_like_intro_query(combined):
            return {"route": "introduction"}
        if _looks_like_code_query(combined):
            return {"route": "code"}
        if _looks_like_scenario_query(combined):
            return {"route": "scenario"}
        if _looks_like_project_query(combined):
            return {"route": "project_explaination"}
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
        messages.extend(coerce_history(history))
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
    except Exception:
        route = "qa"

    if route not in {"introduction", "project_explaination", "code", "scenario", "qa"}:
        route = "qa"
    logger.info("Router decision mode=llm route=%s", route)
    return {"route": route}
