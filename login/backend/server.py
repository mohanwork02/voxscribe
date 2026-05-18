import asyncio
import json
import logging
import os
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from queue import Empty, Full, Queue
from threading import Event, Lock, Thread
from uuid import uuid4

from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from stt_loopback import stream_transcripts, stream_transcripts_from_audio_queue


def _configure_app_logging() -> None:
    level_name = str(os.getenv("LOG_LEVEL") or "INFO").strip().upper()
    level = getattr(logging, level_name, logging.INFO)
    root_logger = logging.getLogger()

    if not root_logger.handlers:
        logging.basicConfig(
            level=level,
            format="%(asctime)s %(levelname)s [%(name)s] %(message)s",
        )
    else:
        root_logger.setLevel(level)

    logging.getLogger("login.backend").setLevel(level)
    logging.getLogger("interview_langgraph").setLevel(level)


_configure_app_logging()
logger = logging.getLogger(__name__)
HEARTBEAT_SECONDS = 15
STT_AUDIO_QUEUE_MAX_CHUNKS = int(os.getenv("STT_AUDIO_QUEUE_MAX_CHUNKS", "250"))
STT_AUDIO_QUEUE_DROP_BATCH = int(os.getenv("STT_AUDIO_QUEUE_DROP_BATCH", "25"))
ALLOWED_ORIGINS = [
    "http://localhost:3000",
    "http://127.0.0.1:3000",
    "http://localhost:5173",
    "http://127.0.0.1:5173",
]

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


transcript_sessions: dict[str, dict] = {}
transcript_sessions_lock = Lock()

TENANT_HEADER = "x-voxscribe-tenant-id"
USER_HEADER = "x-voxscribe-user-id"
_tenant_io_lock = Lock()


llm_jobs: dict[str, dict] = {}
llm_jobs_lock = Lock()
llm_graph = None
llm_graph_lock = Lock()
LLM_JOB_TTL_SECONDS = 30 * 60


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _preview_query(value: str, *, limit: int = 160) -> str:
    text = " ".join(str(value or "").split())
    if len(text) <= limit:
        return text
    return text[: max(0, limit - 3)] + "..."


def _normalize_domain(value: object) -> str:
    return " ".join(str(value or "").split())


def _get_tenant_context_from_headers(headers) -> tuple[str, str]:
    tenant_id = str(getattr(headers, "get", lambda *_: "")(TENANT_HEADER) or "").strip()
    user_id = str(getattr(headers, "get", lambda *_: "")(USER_HEADER) or "").strip()
    if not tenant_id or not user_id:
        raise HTTPException(status_code=401, detail="Missing tenant context.")
    return tenant_id, user_id


def _push_audio_chunk(queue: Queue, payload: bytes | None, *, label: str) -> int:
    try:
        queue.put_nowait(payload)
        return 0
    except Full:
        dropped = 0
        for _ in range(max(1, STT_AUDIO_QUEUE_DROP_BATCH)):
            try:
                queue.get_nowait()
                dropped += 1
            except Empty:
                break
        try:
            queue.put_nowait(payload)
        except Full:
            pass
        if dropped:
            logger.warning("STT audio queue overflow label=%s dropped=%s qsize=%s", label, dropped, queue.qsize())
        return dropped


def _configure_tenant_artifacts_dir(*, tenant_id: str, user_id: str) -> Path:
    repo_root = _ensure_repo_root_on_path()
    out_dir = repo_root / "interview_langgraph" / "artifacts" / "tenants" / tenant_id / user_id
    out_dir.mkdir(parents=True, exist_ok=True)

    # IMPORTANT: smart_input_llm stores artifact paths in module-level globals.
    # We reconfigure it per request under a lock to avoid cross-tenant mixing.
    import smart_input_llm as s

    s.configure_output_dir(out_dir)
    return out_dir


def _ensure_repo_root_on_path() -> Path:
    repo_root = Path(__file__).resolve().parents[2]
    repo_root_str = str(repo_root)
    if repo_root_str not in sys.path:
        sys.path.insert(0, repo_root_str)

    # `interview_langgraph` imports `smart_input_llm` as a top-level module (e.g. `from smart_input_llm import ...`).
    # That works when running from inside the `interview_langgraph` directory. When serving via FastAPI from
    # `login/backend`, we also need to add the `interview_langgraph` directory itself to `sys.path` so that
    # `import smart_input_llm` resolves.
    langgraph_root = repo_root / "interview_langgraph"
    langgraph_root_str = str(langgraph_root)
    if langgraph_root.is_dir() and langgraph_root_str not in sys.path:
        sys.path.insert(0, langgraph_root_str)
    return repo_root


def _get_default_kb_files() -> list[str]:
    repo_root = _ensure_repo_root_on_path()
    default_pdf = repo_root / "interview_langgraph" / "Venkatesh_Updated_CV.pdf"
    if default_pdf.is_file():
        return [str(default_pdf)]
    return []


def _cleanup_llm_jobs() -> None:
    cutoff = time.time() - LLM_JOB_TTL_SECONDS
    with llm_jobs_lock:
        stale_ids = [job_id for job_id, job in llm_jobs.items() if float(job.get("created_ts", 0)) < cutoff]
        for job_id in stale_ids:
            llm_jobs.pop(job_id, None)


def _get_llm_graph():
    global llm_graph
    with llm_graph_lock:
        if llm_graph is not None:
            return llm_graph
        _ensure_repo_root_on_path()
        from interview_langgraph.graph_connect.builder import build_graph

        llm_graph = build_graph()
        return llm_graph


def _run_llm_query(
    *,
    query: str,
    files: list[str],
    top_k: int | None = None,
    domain: str = "",
) -> dict:
    graph = _get_llm_graph()
    state: dict = {"query": query, "files": files}
    if top_k is not None:
        state["top_k"] = top_k
    normalized_domain = _normalize_domain(domain)
    if normalized_domain:
        state["domain"] = normalized_domain

    final_state: dict | None = None
    for snapshot in graph.stream(state, stream_mode="values"):
        if isinstance(snapshot, dict):
            final_state = snapshot
    return final_state or {}


def _sse_event(payload: dict) -> str:
    return f"data: {json.dumps(payload, ensure_ascii=False)}\n\n"


@app.post("/api/smart-input/ingest")
async def ingest_smart_input_kb(request: Request):
    """
    Build/update the local KB index for the provided files.

    This is meant to be called right after a user uploads a document so that
    embeddings/index are ready before the UI enables "Generate".
    """
    payload = await request.json()
    tenant_id, user_id = _get_tenant_context_from_headers(request.headers)

    raw_files = payload.get("files")
    files: list[str] = []
    if isinstance(raw_files, list):
        files = [str(item) for item in raw_files if str(item or "").strip()]
    if not files:
        files = _get_default_kb_files()

    if not files:
        raise HTTPException(status_code=400, detail="Missing files list.")

    raw_top_k = payload.get("top_k", payload.get("topK"))
    top_k: int | None = None
    if raw_top_k is not None:
        try:
            top_k = int(raw_top_k)
        except (TypeError, ValueError):
            raise HTTPException(status_code=400, detail="Invalid top_k value.")

    domain = _normalize_domain(payload.get("domain"))

    logger.info(
        "SmartInput ingest start tenant=%s user=%s domain=%s files=%s",
        tenant_id,
        user_id,
        domain or "-",
        len(files),
    )

    with _tenant_io_lock:
        _configure_tenant_artifacts_dir(tenant_id=tenant_id, user_id=user_id)
        result = _run_llm_query(query="", files=files, top_k=top_k, domain=domain)

    logger.info(
        "SmartInput ingest done tenant=%s user=%s domain=%s chunks=%s vectors=%s",
        tenant_id,
        user_id,
        domain or "-",
        result.get("chunk_count") or 0,
        result.get("vector_count") or 0,
    )

    return {
        "success": True,
        "files": files,
        "domain": domain,
        "chunkCount": result.get("chunk_count") or 0,
        "vectorCount": result.get("vector_count") or 0,
        "faissIndexFile": result.get("faiss_index_file") or "",
        "faissMetaFile": result.get("faiss_meta_file") or "",
    }


@app.post("/api/smart-input/stream")
async def stream_smart_input_query(request: Request):
    """
    Stream Smart Input answer tokens to the frontend (Insights) via SSE.

    This does not replace the existing /api/smart-input/query polling flow; it
    provides an additional streaming endpoint for lower latency UX.
    """
    payload = await request.json()
    tenant_id, user_id = _get_tenant_context_from_headers(request.headers)

    query = str(payload.get("query") or "").strip()
    if not query:
        raise HTTPException(status_code=400, detail="Missing query text.")

    raw_top_k = payload.get("top_k", payload.get("topK"))
    top_k: int | None = None
    if raw_top_k is not None:
        try:
            top_k = int(raw_top_k)
        except (TypeError, ValueError):
            raise HTTPException(status_code=400, detail="Invalid top_k value.")

    history = payload.get("history")

    raw_files = payload.get("files")
    files: list[str] = []
    if isinstance(raw_files, list):
        files = [str(item) for item in raw_files if str(item or "").strip()]

    raw_image_files = payload.get("imageFiles", payload.get("image_files"))
    image_files: list[str] = []
    if isinstance(raw_image_files, list):
        image_files = [str(item) for item in raw_image_files if str(item or "").strip()][:8]

    def event_generator():
        yield ": connected\n\n"
        try:
            _ensure_repo_root_on_path()

            from interview_langgraph.answer_runtime import (
                iter_openai_chat_deltas,
                prepare_answer_request,
            )

            # If the caller provided KB files, ensure the local index is built for them before retrieval.
            with _tenant_io_lock:
                _configure_tenant_artifacts_dir(tenant_id=tenant_id, user_id=user_id)
                if files:
                    _run_llm_query(query="", files=files, top_k=top_k)
                prepared = prepare_answer_request(query=query, history=history, top_k=top_k, image_files=image_files)

            logger.info(
                "SmartInput retrieval route=%s tenant=%s user=%s chunks=%s images=%s",
                prepared.route,
                tenant_id,
                user_id,
                len(prepared.context_chunks),
                len(image_files),
            )
            logger.info(
                "SmartInput stream route=%s tenant=%s user=%s top_k=%s images=%s query=%s",
                prepared.route,
                tenant_id,
                user_id,
                prepared.top_k,
                len(image_files),
                _preview_query(query),
            )
            yield _sse_event({"type": "route", "route": prepared.route})

            answer_parts: list[str] = []
            for delta in iter_openai_chat_deltas(
                model=prepared.model,
                messages=prepared.messages,
                temperature=prepared.temperature,
                max_tokens=prepared.max_tokens,
            ):
                answer_parts.append(delta)
                yield _sse_event({"type": "delta", "delta": delta})

            yield _sse_event({"type": "done", "route": prepared.route, "answer": "".join(answer_parts).strip()})
        except Exception as exc:
            yield _sse_event({"type": "error", "error": str(exc)})

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )
def get_transcript_session(session_id: str, *, tenant_id: str, user_id: str) -> dict:
    with transcript_sessions_lock:
        session = transcript_sessions.get(session_id)

    if session is None:
        raise HTTPException(status_code=404, detail="Transcript session not found.")

    if str(session.get("tenant_id") or "") != tenant_id or str(session.get("user_id") or "") != user_id:
        raise HTTPException(status_code=404, detail="Transcript session not found.")

    return session


def stop_transcript_session(
    session_id: str,
    *,
    tenant_id: str,
    user_id: str,
    join_timeout: float = 1.0,
) -> bool:
    with transcript_sessions_lock:
        session = transcript_sessions.get(session_id)

    if session is None:
        return False

    if str(session.get("tenant_id") or "") != tenant_id or str(session.get("user_id") or "") != user_id:
        return False

    with transcript_sessions_lock:
        transcript_sessions.pop(session_id, None)

    session["stop_event"].set()
    _push_audio_chunk(session["audio_queue"], None, label=f"session:{session_id}")
    session["worker"].join(timeout=join_timeout)
    logger.info("Transcript session stopped: %s", session_id)
    return True

@app.get("/health")
def health():
    return {"status": "ok"}


@app.post("/api/smart-input/query")
async def create_smart_input_query(request: Request):
    _cleanup_llm_jobs()
    tenant_id, user_id = _get_tenant_context_from_headers(request.headers)
    payload = await request.json()

    query = str(payload.get("query") or "").strip()
    if not query:
        raise HTTPException(status_code=400, detail="Missing query text.")

    raw_files = payload.get("files")
    files: list[str] = []
    if isinstance(raw_files, list):
        files = [str(item) for item in raw_files if str(item or "").strip()]
    if not files:
        files = _get_default_kb_files()

    raw_top_k = payload.get("top_k", payload.get("topK"))
    top_k: int | None = None
    if raw_top_k is not None:
        try:
            top_k = int(raw_top_k)
        except (TypeError, ValueError):
            raise HTTPException(status_code=400, detail="Invalid top_k value.")

    query_id = uuid4().hex
    created_iso = _utc_now_iso()
    created_ts = time.time()

    logger.info(
        "SmartInput query start id=%s tenant=%s user=%s top_k=%s query=%s",
        query_id,
        tenant_id,
        user_id,
        top_k,
        _preview_query(query),
    )

    def worker():
        try:
            with _tenant_io_lock:
                _configure_tenant_artifacts_dir(tenant_id=tenant_id, user_id=user_id)
                result = _run_llm_query(query=query, files=files, top_k=top_k)
            answer = str(result.get("answer") or "").strip()
            route = str(result.get("route") or "").strip()
            logger.info(
                "SmartInput query done id=%s route=%s tenant=%s user=%s",
                query_id,
                route or "-",
                tenant_id,
                user_id,
            )
            with llm_jobs_lock:
                job = llm_jobs.get(query_id)
                if job is None:
                    return
                job.update(
                    {
                        "status": "done",
                        "answer": answer,
                        "route": route,
                        "updated_at": _utc_now_iso(),
                    }
                )
        except Exception as exc:
            with llm_jobs_lock:
                job = llm_jobs.get(query_id)
                if job is None:
                    return
                job.update(
                    {
                        "status": "error",
                        "error": str(exc),
                        "updated_at": _utc_now_iso(),
                    }
                )

    thread = Thread(target=worker, daemon=True)
    with llm_jobs_lock:
        llm_jobs[query_id] = {
            "status": "running",
            "query": query,
            "files": files,
            "top_k": top_k,
            "tenant_id": tenant_id,
            "user_id": user_id,
            "answer": "",
            "route": "",
            "error": "",
            "created_at": created_iso,
            "updated_at": created_iso,
            "created_ts": created_ts,
        }
    thread.start()

    return {"success": True, "queryId": query_id, "status": "running"}


@app.get("/api/smart-input/query/{query_id}")
async def get_smart_input_query(query_id: str, request: Request):
    _cleanup_llm_jobs()
    tenant_id, user_id = _get_tenant_context_from_headers(request.headers)
    with llm_jobs_lock:
        job = llm_jobs.get(query_id)

    if job is None:
        raise HTTPException(status_code=404, detail="Query not found.")

    if str(job.get("tenant_id") or "") != tenant_id or str(job.get("user_id") or "") != user_id:
        raise HTTPException(status_code=404, detail="Query not found.")

    return {
        "success": True,
        "queryId": query_id,
        "status": job.get("status"),
        "answer": job.get("answer") or "",
        "route": job.get("route") or "",
        "error": job.get("error") or "",
        "createdAt": job.get("created_at"),
        "updatedAt": job.get("updated_at"),
    }


@app.post("/api/transcript/sessions")
async def create_transcript_session(request: Request):
    tenant_id, user_id = _get_tenant_context_from_headers(request.headers)
    payload = await request.json()

    try:
        sample_rate = int(payload.get("sampleRate", 48000))
        channels = int(payload.get("channels", 1))
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail="Invalid audio stream configuration.")

    audio_queue: Queue[bytes | None] = Queue(maxsize=STT_AUDIO_QUEUE_MAX_CHUNKS)
    result_queue: Queue[dict] = Queue()
    stop_event = Event()
    session_id = uuid4().hex
    label = f"session:{session_id}"

    def producer():
        try:
            for transcript_event in stream_transcripts_from_audio_queue(
                audio_queue=audio_queue,
                sample_rate=sample_rate,
                channels=channels,
                stop_event=stop_event,
                log_context={"session_id": session_id, "tenant_id": tenant_id, "user_id": user_id, "conn_id": label},
            ):
                if stop_event.is_set():
                    break
                result_queue.put({"type": "transcript", "payload": transcript_event})
        except Exception as exc:
            logger.exception("Transcript session failed")
            result_queue.put({"type": "error", "payload": {"error": str(exc)}})
        finally:
            result_queue.put({"type": "done", "payload": None})

    worker = Thread(target=producer, daemon=True)

    with transcript_sessions_lock:
        transcript_sessions[session_id] = {
            "audio_queue": audio_queue,
            "result_queue": result_queue,
            "stop_event": stop_event,
            "worker": worker,
            "tenant_id": tenant_id,
            "user_id": user_id,
        }

    worker.start()
    logger.info(
        "Transcript session started id=%s tenant=%s user=%s sample_rate=%s channels=%s qmax=%s",
        session_id,
        tenant_id,
        user_id,
        sample_rate,
        channels,
        STT_AUDIO_QUEUE_MAX_CHUNKS,
    )
    return {"success": True, "sessionId": session_id}


@app.post("/api/transcript/sessions/{session_id}/audio")
async def upload_transcript_audio(session_id: str, request: Request):
    tenant_id, user_id = _get_tenant_context_from_headers(request.headers)
    session = get_transcript_session(session_id, tenant_id=tenant_id, user_id=user_id)
    audio_payload = await request.body()

    if not audio_payload:
        raise HTTPException(status_code=400, detail="Audio payload is empty.")

    if session["stop_event"].is_set():
        raise HTTPException(status_code=410, detail="Transcript session is no longer active.")

    dropped = _push_audio_chunk(session["audio_queue"], audio_payload, label=f"session:{session_id}")
    return {"success": True, "dropped": dropped}


@app.post("/api/transcript/sessions/{session_id}/stop")
async def stop_transcript_session_route(session_id: str, request: Request):
    tenant_id, user_id = _get_tenant_context_from_headers(request.headers)
    stopped = stop_transcript_session(session_id, tenant_id=tenant_id, user_id=user_id)
    return {"success": True, "stopped": stopped}


@app.get("/api/transcript/sessions/{session_id}/stream")
async def transcript_session_stream(session_id: str, request: Request):
    tenant_id, user_id = _get_tenant_context_from_headers(request.headers)
    session = get_transcript_session(session_id, tenant_id=tenant_id, user_id=user_id)

    async def event_generator():
        logger.info("Transcript session stream connected: %s", session_id)

        try:
            yield ": connected\n\n"

            while True:
                if await request.is_disconnected():
                    logger.info("Transcript session stream client disconnected: %s", session_id)
                    break

                try:
                    message = await asyncio.to_thread(
                        session["result_queue"].get,
                        True,
                        HEARTBEAT_SECONDS,
                    )
                except Empty:
                    yield ": keepalive\n\n"
                    continue

                if message["type"] == "transcript":
                    payload = json.dumps(message["payload"])
                    yield f"data: {payload}\n\n"
                    continue

                if message["type"] == "error":
                    payload = json.dumps(message["payload"])
                    yield f"data: {payload}\n\n"
                    break

                if message["type"] == "done":
                    break
        finally:
            stop_transcript_session(session_id, tenant_id=tenant_id, user_id=user_id)

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )

@app.get("/api/transcript/stream")
async def transcript_stream(request: Request):
    _get_tenant_context_from_headers(request.headers)
    queue: Queue[dict] = Queue()
    stop_event = Event()

    def producer():
        try:
            for transcript_event in stream_transcripts(stop_event=stop_event):
                if stop_event.is_set():
                    break
                queue.put({"type": "transcript", "payload": transcript_event})
        except Exception as exc:
            logger.exception("Transcript streaming failed")
            queue.put({"type": "error", "payload": {"error": str(exc)}})
        finally:
            queue.put({"type": "done", "payload": None})

    async def event_generator():
        logger.info("Transcript stream started")
        worker = Thread(target=producer, daemon=True)
        worker.start()

        try:
            yield ": connected\n\n"
            while True:
                if await request.is_disconnected():
                    logger.info("Transcript stream client disconnected")
                    break

                try:
                    message = await asyncio.to_thread(
                        queue.get,
                        True,
                        HEARTBEAT_SECONDS,
                    )
                except Empty:
                    yield ": keepalive\n\n"
                    continue

                if message["type"] == "transcript":
                    payload = json.dumps(message["payload"])
                    yield f"data: {payload}\n\n"
                    continue

                if message["type"] == "error":
                    payload = json.dumps(message["payload"])
                    yield f"data: {payload}\n\n"
                    break

                if message["type"] == "done":
                    break
        finally:
            stop_event.set()
            worker.join(timeout=1)
            logger.info("Transcript stream stopped")

    return StreamingResponse(   
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@app.websocket("/api/transcript/ws")
async def transcript_websocket(websocket: WebSocket):
    tenant_id, user_id = _get_tenant_context_from_headers(websocket.headers)
    tab_token = str(websocket.query_params.get("tabToken") or "").strip()
    conn_id = tab_token or uuid4().hex[:10]
    label = f"ws:{conn_id}"
    client_host = getattr(getattr(websocket, "client", None), "host", "") or "-"
    await websocket.accept()

    init_message = await websocket.receive_text()

    try:
        payload = json.loads(init_message)
        sample_rate = int(payload.get("sampleRate", 48000))
        channels = int(payload.get("channels", 1))
    except (ValueError, TypeError, json.JSONDecodeError):
        await websocket.send_json({"error": "Invalid audio stream configuration."})
        await websocket.close(code=1003)
        return

    audio_queue: Queue[bytes | None] = Queue(maxsize=STT_AUDIO_QUEUE_MAX_CHUNKS)
    result_queue: Queue[dict] = Queue()
    stop_event = Event()

    def producer():
        try:
            for transcript_event in stream_transcripts_from_audio_queue(
                audio_queue=audio_queue,
                sample_rate=sample_rate,
                channels=channels,
                stop_event=stop_event,
                log_context={
                    "conn_id": conn_id,
                    "tenant_id": tenant_id,
                    "user_id": user_id,
                },
            ):
                if stop_event.is_set():
                    break
                result_queue.put({"type": "transcript", "payload": transcript_event})
        except Exception as exc:
            logger.exception("Transcript websocket failed")
            result_queue.put({"type": "error", "payload": {"error": str(exc)}})
        finally:
            result_queue.put({"type": "done", "payload": None})

    async def receive_audio():
        try:
            while not stop_event.is_set():
                message = await websocket.receive()

                message_type = message.get("type")
                if message_type == "websocket.disconnect":
                    break

                if message.get("bytes") is not None:
                    _push_audio_chunk(audio_queue, message["bytes"], label=label)
                elif message.get("text"):
                    try:
                        control = json.loads(message["text"])
                    except json.JSONDecodeError:
                        continue

                    if control.get("type") == "stop":
                        break
        except WebSocketDisconnect:
            logger.info("Transcript websocket client disconnected")
        finally:
            stop_event.set()
            _push_audio_chunk(audio_queue, None, label=label)

    logger.info(
        "Transcript websocket started label=%s tenant=%s user=%s client=%s sample_rate=%s channels=%s qmax=%s",
        label,
        tenant_id,
        user_id,
        client_host,
        sample_rate,
        channels,
        STT_AUDIO_QUEUE_MAX_CHUNKS,
    )
    worker = Thread(target=producer, daemon=True)
    receiver_task = asyncio.create_task(receive_audio())
    worker.start()

    try:
        while True:
            if receiver_task.done() and result_queue.empty():
                break

            try:
                message = await asyncio.to_thread(result_queue.get, True, HEARTBEAT_SECONDS)
            except Empty:
                continue

            if message["type"] == "transcript":
                try:
                    await websocket.send_text(json.dumps(message["payload"]))
                except Exception as exc:
                    logger.info("Transcript websocket send failed label=%s err=%s", label, exc)
                    break
                continue

            if message["type"] == "error":
                try:
                    await websocket.send_text(json.dumps(message["payload"]))
                except Exception:
                    pass
                break

            if message["type"] == "done":
                break
    finally:
        stop_event.set()
        _push_audio_chunk(audio_queue, None, label=label)
        await receiver_task
        worker.join(timeout=1)
        try:
            await websocket.close()
        except RuntimeError:
            logger.debug("Transcript websocket already closed")
        logger.info("Transcript websocket stopped label=%s", label)
