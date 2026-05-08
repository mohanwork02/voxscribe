from __future__ import annotations

import json
import os
import hashlib
from pathlib import Path
from typing import Any, Iterable, Tuple

import numpy as np

OUTPUT_DIR = Path(__file__).resolve().parent / "artifacts"
FAISS_INDEX_FILE = OUTPUT_DIR / "faiss.index"
FAISS_META_FILE = OUTPUT_DIR / "faiss_meta.json"
VECTORS_FILE = OUTPUT_DIR / "vectors.npy"
VERIFICATION_FILE = OUTPUT_DIR / "verification.txt"

_LOADED_INDEX = None
_LOADED_TEXTS: list[str] | None = None
_QUERY_EMBED_CACHE: dict[str, np.ndarray] = {}


def _ensure_output_dir() -> None:
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)


def configure_output_dir(output_dir: str | Path) -> None:
    """
    Re-point all artifact file paths (FAISS index, metadata, vectors, history, etc.) to a new directory.

    This is used by the shared backend to provide tenant-based isolation on local disk.
    Note: call-site should ensure concurrent requests do not reconfigure output dirs mid-flight.
    """
    global OUTPUT_DIR, FAISS_INDEX_FILE, FAISS_META_FILE, VECTORS_FILE, VERIFICATION_FILE
    global _LOADED_INDEX, _LOADED_TEXTS

    OUTPUT_DIR = Path(output_dir).expanduser().resolve()
    FAISS_INDEX_FILE = OUTPUT_DIR / "faiss.index"
    FAISS_META_FILE = OUTPUT_DIR / "faiss_meta.json"
    VECTORS_FILE = OUTPUT_DIR / "vectors.npy"
    VERIFICATION_FILE = OUTPUT_DIR / "verification.txt"
    _LOADED_INDEX = None
    _LOADED_TEXTS = None
    _QUERY_EMBED_CACHE.clear()


def compute_sources_metadata(paths: Iterable[Path]) -> list[dict[str, object]]:
    """
    Build a stable, comparable description of the files used to build the index.
    Stored in `faiss_meta.json` to decide when re-ingestion is required.
    """
    items: list[dict[str, object]] = []
    for path in paths:
        p = Path(path)
        try:
            resolved = p.resolve()
        except Exception:
            resolved = p

        stat = resolved.stat()
        items.append(
            {
                "path": str(resolved),
                "size": int(stat.st_size),
                "mtime": int(stat.st_mtime),
            }
        )
    items.sort(key=lambda x: str(x.get("path") or ""))
    return items


def _sources_signature(sources: list[dict[str, object]]) -> str:
    payload = json.dumps(sources, ensure_ascii=False, sort_keys=True).encode("utf-8")
    return hashlib.sha256(payload).hexdigest()


def index_matches_files(files: Iterable[str | Path]) -> bool:
    """
    Return True if the existing local index metadata indicates it was built from the
    same set of files (path + size + mtime).
    """
    _ensure_output_dir()
    if not FAISS_META_FILE.is_file():
        return False

    try:
        meta = json.loads(FAISS_META_FILE.read_text(encoding="utf-8"))
    except Exception:
        return False

    sources = meta.get("sources")
    if not isinstance(sources, list) or not sources:
        return False

    try:
        paths = [Path(p) for p in files]
        desired = compute_sources_metadata(paths)
    except Exception:
        return False

    existing_sig = meta.get("sources_sig")
    if isinstance(existing_sig, str) and existing_sig.strip():
        return existing_sig.strip() == _sources_signature(desired)

    # Back-compat: if signature wasn't stored, compare the list itself.
    try:
        return sources == desired
    except Exception:
        return False


def reset_output_files() -> None:
    global _LOADED_INDEX, _LOADED_TEXTS
    _ensure_output_dir()
    _LOADED_INDEX = None
    _LOADED_TEXTS = None
    _QUERY_EMBED_CACHE.clear()
    for path in (FAISS_INDEX_FILE, FAISS_META_FILE, VECTORS_FILE, VERIFICATION_FILE):
        if path.exists():
            path.unlink()


def extract_text(path: Path) -> str:
    suffix = path.suffix.lower()
    if suffix == ".pdf":
        try:
            from pypdf import PdfReader
        except Exception as exc:  # pragma: no cover
            raise ImportError("Missing dependency: pypdf. Install it to read PDFs.") from exc

        reader = PdfReader(str(path))
        parts: list[str] = []
        for page in reader.pages:
            parts.append(page.extract_text() or "")
        return "\n".join(p.strip() for p in parts if p and p.strip())

    if suffix == ".docx":
        try:
            import docx  # type: ignore[import-not-found]
        except Exception as exc:  # pragma: no cover
            raise ImportError(
                "Missing dependency: python-docx. Install it to read DOCX files."
            ) from exc

        document = docx.Document(str(path))
        lines = [p.text.strip() for p in document.paragraphs if p.text and p.text.strip()]
        return "\n".join(lines)

    if suffix in {".txt", ".md"}:
        return path.read_text(encoding="utf-8", errors="ignore").strip()

    raise ValueError(f"Unsupported file type: {path.suffix}. Use .pdf, .docx, .txt, or .md.")


def _iter_embeddings(all_embeddings: list[dict[str, Any]]) -> Iterable[Tuple[str, list[float]]]:
    for file_item in all_embeddings:
        for item in file_item.get("embeddings", []):
            yield str(item.get("text") or ""), item.get("embedding") or []


def _l2_normalize(vectors: np.ndarray) -> np.ndarray:
    norms = np.linalg.norm(vectors, axis=1, keepdims=True)
    return vectors / np.clip(norms, 1e-12, None)


def build_faiss_index(all_embeddings: list[dict[str, Any]]):
    texts: list[str] = []
    vectors_list: list[list[float]] = []

    for text, embedding in _iter_embeddings(all_embeddings):
        if not text or not embedding:
            continue
        texts.append(text)
        vectors_list.append(list(embedding))

    if not vectors_list:
        raise ValueError("No embeddings provided to build_faiss_index().")

    vectors = np.asarray(vectors_list, dtype=np.float32)
    vectors = _l2_normalize(vectors)

    # Prefer FAISS when available; otherwise fall back to a numpy matrix.
    try:
        import faiss  # type: ignore[import-not-found]

        index = faiss.IndexFlatIP(vectors.shape[1])
        index.add(vectors)
        return index, texts
    except Exception:
        return vectors, texts


def save_faiss(index, texts: list[str], *, sources: list[dict[str, object]] | None = None) -> None:
    _ensure_output_dir()

    meta: dict[str, object] = {"texts": texts}
    if sources:
        meta["sources"] = sources
        meta["sources_sig"] = _sources_signature(sources)
    FAISS_META_FILE.write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")

    try:
        import faiss  # type: ignore[import-not-found]

        if hasattr(faiss, "write_index") and getattr(index, "ntotal", None) is not None:
            faiss.write_index(index, str(FAISS_INDEX_FILE))
            if VECTORS_FILE.exists():
                VECTORS_FILE.unlink()
            return
    except Exception:
        pass

    np.save(VECTORS_FILE, np.asarray(index, dtype=np.float32))
    if FAISS_INDEX_FILE.exists():
        FAISS_INDEX_FILE.unlink()


def load_faiss():
    global _LOADED_INDEX, _LOADED_TEXTS
    if _LOADED_INDEX is not None and _LOADED_TEXTS is not None:
        return _LOADED_INDEX, _LOADED_TEXTS

    _ensure_output_dir()
    if not FAISS_META_FILE.is_file():
        raise FileNotFoundError(
            f"Missing FAISS metadata file: {FAISS_META_FILE}. Run ingestion first."
        )

    meta = json.loads(FAISS_META_FILE.read_text(encoding="utf-8"))
    texts = list(meta.get("texts") or [])

    # Try FAISS first.
    if FAISS_INDEX_FILE.is_file():
        try:
            import faiss  # type: ignore[import-not-found]

            _LOADED_INDEX = faiss.read_index(str(FAISS_INDEX_FILE))
            _LOADED_TEXTS = texts
            return _LOADED_INDEX, _LOADED_TEXTS
        except Exception:
            pass

    if VECTORS_FILE.is_file():
        _LOADED_INDEX = np.load(VECTORS_FILE)
        _LOADED_TEXTS = texts
        return _LOADED_INDEX, _LOADED_TEXTS

    raise FileNotFoundError(
        f"Missing index files: {FAISS_INDEX_FILE} and {VECTORS_FILE}. Run ingestion first."
    )


def _embed_query(query: str) -> np.ndarray:
    cached = _QUERY_EMBED_CACHE.get(query)
    if cached is not None:
        return cached

    try:
        from openai import OpenAI
    except Exception as exc:  # pragma: no cover
        raise ImportError("Missing dependency: openai. Install it to call embeddings.") from exc

    model = os.getenv("EMBEDDING_MODEL") or "text-embedding-3-small"
    client = OpenAI()
    response = client.embeddings.create(model=model, input=query)
    vector = np.asarray(response.data[0].embedding, dtype=np.float32)[None, :]
    vector = _l2_normalize(vector)
    if len(_QUERY_EMBED_CACHE) > 256:
        _QUERY_EMBED_CACHE.clear()
    _QUERY_EMBED_CACHE[query] = vector
    return vector


def retrieve_lexical(query: str, texts: list[str], top_k: int = 5) -> list[str]:
    """
    Fast local retrieval: token overlap + substring match. No API calls.
    """
    query = (query or "").strip().lower()
    if not query:
        return []

    top_k = max(1, int(top_k))
    q_tokens = {t for t in query.replace("/", " ").replace("-", " ").split() if len(t) >= 3}
    if not q_tokens:
        return []

    scored: list[tuple[int, int]] = []
    for idx, text in enumerate(texts):
        t = (text or "").lower()
        if not t:
            continue
        overlap = sum(1 for tok in q_tokens if tok in t)
        if overlap == 0:
            continue
        # small bonus if the full query appears
        bonus = 2 if query in t else 0
        scored.append((overlap + bonus, idx))

    scored.sort(reverse=True, key=lambda x: x[0])
    return [texts[i] for _, i in scored[: min(top_k, len(scored))]]


def retrieve(query: str, index, texts: list[str], top_k: int = 5) -> list[str]:
    if not query.strip():
        return []

    top_k = max(1, int(top_k))
    query_vec = _embed_query(query)

    # FAISS path (IndexFlatIP supports .search).
    if hasattr(index, "search"):
        scores, indices = index.search(query_vec, min(top_k, len(texts)))
        hits = [int(i) for i in indices[0] if int(i) >= 0]
        return [texts[i] for i in hits]

    # Numpy fallback (index is a normalized (n, d) matrix).
    vectors = np.asarray(index, dtype=np.float32)
    sims = (vectors @ query_vec[0]).astype(np.float32)
    best = np.argsort(-sims)[: min(top_k, len(texts))]
    return [texts[int(i)] for i in best]
