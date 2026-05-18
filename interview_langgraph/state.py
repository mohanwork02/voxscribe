from typing import TypedDict


class WorkflowState(TypedDict, total=False):
    files: list[str]
    domain: str
    query: str
    # Optional short-term memory: prior chat messages (role=user/assistant) passed in by the CLI.
    # We keep this lightweight and do not persist it to disk by default.
    history: list[dict[str, str]]
    top_k: int
    route: str
    answer: str
    streamed: bool
    chunk_count: int
    vector_count: int
    faiss_index_file: str
    faiss_meta_file: str
    verification_file: str
