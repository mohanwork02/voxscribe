import os
from pathlib import Path

from langchain_text_splitters import RecursiveCharacterTextSplitter
from openai import OpenAI

from interview_langgraph.config import CHUNK_OVERLAP, CHUNK_SIZE, EMBEDDING_MODEL
from interview_langgraph.state import WorkflowState
from smart_input_llm import (
    FAISS_INDEX_FILE,
    FAISS_META_FILE,
    VERIFICATION_FILE,
    build_faiss_index,
    compute_sources_metadata,
    extract_text,
    reset_output_files,
    save_faiss,
)


def chunk_text(text: str) -> list[str]:
    splitter = RecursiveCharacterTextSplitter(
        chunk_size=CHUNK_SIZE,
        chunk_overlap=CHUNK_OVERLAP,
        separators=["\n\n", "\n", ". ", " ", ""],
    )
    chunks = [chunk.strip() for chunk in splitter.split_text(text) if chunk.strip()]
    return list(dict.fromkeys(chunks))
_client = None


def create_embeddings(chunks: list[str], cache: dict[str, list[float]]) -> list[dict]:
    global _client
    _client = _client or OpenAI()
    embeddings: list[dict] = []
    for chunk in chunks:
        vector = cache.get(chunk)
        if vector is None:
            response = _client.embeddings.create(model=EMBEDDING_MODEL, input=chunk)
            vector = response.data[0].embedding
            cache[chunk] = vector
        embeddings.append({"text": chunk, "embedding": vector})
    return embeddings
def ingest_documents(state: WorkflowState) -> WorkflowState:
    files = state.get("files") or []
    if not files:
        raise ValueError("No input files provided. Pass one or more .pdf/.docx paths.")

    if not os.getenv("OPENAI_API_KEY"):
        raise ValueError(
            "OPENAI_API_KEY is required. Set it in your environment "
            "(PowerShell: `$env:OPENAI_API_KEY=\"...\"`) or put it in `.env`."
        )
    paths = [Path(p) for p in files]
    missing = [str(p) for p in paths if not p.is_file()]
    if missing:
        raise FileNotFoundError(f"File not found: {', '.join(missing)}")

    reset_output_files()

    sources = compute_sources_metadata(paths)

    all_embeddings: list[dict] = []
    embedding_cache: dict[str, list[float]] = {}
    total_chunks = 0

    write_verification = str(os.getenv("WRITE_VERIFICATION") or "").strip().lower() in {
        "1",
        "true",
        "yes",
    }
    output = VERIFICATION_FILE.open("w", encoding="utf-8") if write_verification else None
    try:
        for path in paths:
            text = extract_text(path)
            chunks = chunk_text(text)
            total_chunks += len(chunks)

            if output is not None:
                output.write(f"\n\n===== EXTRACTED TEXT: {path} =====\n{text}")
                output.write(f"\n\n===== CHUNKED TEXT: {path} =====\n")
                for chunk_index, chunk in enumerate(chunks, 1):
                    output.write(f"\n--- Chunk {chunk_index} ---\n{chunk}\n")

            embeddings = create_embeddings(chunks, embedding_cache)
            all_embeddings.append({"file": str(path), "embeddings": embeddings})
    finally:
        if output is not None:
            output.close()

    index, texts = build_faiss_index(all_embeddings)
    save_faiss(index, texts, sources=sources)

    result: WorkflowState = {
        "chunk_count": total_chunks,
        "vector_count": len(texts),
        "faiss_index_file": str(FAISS_INDEX_FILE),
        "faiss_meta_file": str(FAISS_META_FILE),
    }
    if write_verification:
        result["verification_file"] = str(VERIFICATION_FILE)
    return result
