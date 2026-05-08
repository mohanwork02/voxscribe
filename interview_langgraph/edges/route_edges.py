from langgraph.constants import END

from interview_langgraph.state import WorkflowState
from smart_input_llm import FAISS_INDEX_FILE, FAISS_META_FILE, VECTORS_FILE, index_matches_files


def _index_ready() -> bool:
    return FAISS_META_FILE.is_file() and (FAISS_INDEX_FILE.is_file() or VECTORS_FILE.is_file())


def start_path(state: WorkflowState) -> str:
    files = state.get("files") or []
    # If files were provided, ensure the KB index exists and matches the provided sources.
    if files and (not _index_ready() or not index_matches_files(files)):
        return "ingest"
    return "route"


def route_path(state: WorkflowState) -> str:
    route = str(state.get("route") or "").strip().lower()
    if route == "introduction":
        return "introduction"
    if route == "project_explaination":
        return "project_explaination"
    if route == "code":
        return "code"
    if route == "scenario":
        return "scenario"
    if route == "qa":
        return "qa"
    query = (state.get("query") or "").strip()
    return "end" if not query else "qa"


def answer_path(state: WorkflowState) -> str:
    query = (state.get("query") or "").strip()
    answer = str(state.get("answer") or "").strip()
    route = str(state.get("route") or "").strip().lower()
    if not query or answer or route == "qa":
        return "end"
    return "qa"


START_TO_NODE = {"ingest": "ingest", "route": "route"}
ROUTE_TO_NODE = {
    "introduction": "introduction",
    "project_explaination": "project_explaination",
    "code": "code",
    "scenario": "scenario",
    "qa": "qa",
    "end": END,
}
ANSWER_TO_NODE = {"qa": "qa", "end": END}
