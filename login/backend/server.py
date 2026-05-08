import asyncio
import json
import logging
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from queue import Empty, Queue
from threading import Event, Lock, Thread
from uuid import uuid4

from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from stt_loopback import stream_transcripts, stream_transcripts_from_audio_queue

logger = logging.getLogger(__name__)
HEARTBEAT_SECONDS = 15
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


def _get_tenant_context_from_headers(headers) -> tuple[str, str]:
    tenant_id = str(getattr(headers, "get", lambda *_: "")(TENANT_HEADER) or "").strip()
    user_id = str(getattr(headers, "get", lambda *_: "")(USER_HEADER) or "").strip()
    if not tenant_id or not user_id:
        raise HTTPException(status_code=401, detail="Missing tenant context.")
    return tenant_id, user_id


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


def _run_llm_query(*, query: str, files: list[str], top_k: int | None = None) -> dict:
    graph = _get_llm_graph()
    state: dict = {"query": query, "files": files}
    if top_k is not None:
        state["top_k"] = top_k

    final_state: dict | None = None
    for snapshot in graph.stream(state, stream_mode="values"):
        if isinstance(snapshot, dict):
            final_state = snapshot
    return final_state or {}


def _iter_openai_chat_deltas(
    *,
    model: str,
    messages: list[dict[str, str]],
    temperature: float,
    max_tokens: int,
):
    """
    Yield incremental text deltas from the OpenAI Chat Completions streaming API.
    """
    from openai import OpenAI

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


def _build_context_chunks(*, query: str, top_k: int) -> list[str]:
    """
    Best-effort KB retrieval using the existing local index (if present).
    Mirrors the same retrieval logic used by the LangGraph nodes.
    """
    try:
        from interview_langgraph.config import RETRIEVAL_MODE, get_openai_setup_issues
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

    with _tenant_io_lock:
        _configure_tenant_artifacts_dir(tenant_id=tenant_id, user_id=user_id)
        result = _run_llm_query(query="", files=files, top_k=top_k)

    return {
        "success": True,
        "files": files,
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

    def event_generator():
        yield ": connected\n\n"
        try:
            _ensure_repo_root_on_path()

            from interview_langgraph.config import (
                CODE_MODEL,
                CODE_PROMPT_PATH,
                INTRO_PROMPT_PATH,
                PROJECT_EXPLAINATION_MODEL,
                PROJECT_EXPLAINATION_PROMPT_PATH,
                QA_MODEL,
                QA_PROMPT_PATH,
                SCENARIO_MODEL,
                SCENARIO_PROMPT_PATH,
                SELF_INTRO_MODEL,
                get_env_int,
                get_openai_setup_issues,
            )
            from interview_langgraph.memory import coerce_history
            from interview_langgraph.prompt_loader import read_prompt, read_prompt_sections
            from interview_langgraph.route.router import route_node

            issues = get_openai_setup_issues()
            if issues:
                yield _sse_event({"type": "error", "error": "Cannot call LLM API:\n- " + "\n- ".join(issues)})
                return

            top_k_value = int(top_k if top_k is not None else get_env_int("TOP_K"))

            route = str(route_node({"query": query, "history": history}).get("route") or "qa").strip().lower()
            if route not in {"introduction", "project_explaination", "code", "scenario", "qa"}:
                route = "qa"
            yield _sse_event({"type": "route", "route": route})

            # If the caller provided KB files, ensure the local index is built for them before retrieval.
            with _tenant_io_lock:
                _configure_tenant_artifacts_dir(tenant_id=tenant_id, user_id=user_id)
                if files:
                    _run_llm_query(query="", files=files, top_k=top_k_value)

            context_chunks: list[str] = []
            if route in {"introduction", "project_explaination", "scenario", "qa"}:
                with _tenant_io_lock:
                    _configure_tenant_artifacts_dir(tenant_id=tenant_id, user_id=user_id)
                    context_chunks = _build_context_chunks(query=query, top_k=top_k_value)
            context = "\n\n".join(context_chunks).strip()

            messages: list[dict[str, str]] = []
            model = QA_MODEL
            temperature = 0.5
            max_tokens = 1000

            if route == "code":
                system_prompt = read_prompt(CODE_PROMPT_PATH)
                messages = [{"role": "system", "content": system_prompt}]
                messages.extend(coerce_history(history))
                messages.append({"role": "user", "content": query})
                model = CODE_MODEL
                temperature = 0.7
                max_tokens = 5000
            elif route == "introduction":
                sections = read_prompt_sections(INTRO_PROMPT_PATH)
                system_prompt = sections.get("system") or ""
                user_template = sections.get("user") or ""
                messages = [{"role": "system", "content": system_prompt}]
                messages.extend(coerce_history(history))
                messages.append({"role": "user", "content": user_template.format(context=context, query=query)})
                model = SELF_INTRO_MODEL
                temperature = 0.7
                max_tokens = 5000
            elif route == "project_explaination":
                sections = read_prompt_sections(PROJECT_EXPLAINATION_PROMPT_PATH)
                system_prompt = sections.get("system") or ""
                user_template = sections.get("user") or ""
                messages = [{"role": "system", "content": system_prompt}]
                messages.extend(coerce_history(history))
                messages.append({"role": "user", "content": user_template.format(context=context, query=query)})
                model = PROJECT_EXPLAINATION_MODEL
                temperature = 0.2
                max_tokens = 600
            elif route == "scenario":
                sections = read_prompt_sections(SCENARIO_PROMPT_PATH)
                system_prompt = sections.get("system") or ""
                user_template = sections.get("user") or ""
                messages = [{"role": "system", "content": system_prompt}]
                messages.extend(coerce_history(history))
                messages.append({"role": "user", "content": user_template.format(context=context, query=query)})
                model = SCENARIO_MODEL
                temperature = 0.7
                max_tokens = 5000
            else:
                sections = read_prompt_sections(QA_PROMPT_PATH)
                system_prompt = sections.get("system") or ""
                user_template = sections.get("user") or ""
                messages = [{"role": "system", "content": system_prompt}]
                messages.extend(coerce_history(history))
                messages.append({"role": "user", "content": user_template.format(context=context, query=query)})
                model = QA_MODEL
                temperature = 0.5
                max_tokens = 1000

            answer_parts: list[str] = []
            for delta in _iter_openai_chat_deltas(
                model=model,
                messages=messages,
                temperature=temperature,
                max_tokens=max_tokens,
            ):
                answer_parts.append(delta)
                yield _sse_event({"type": "delta", "delta": delta})

            yield _sse_event({"type": "done", "route": route, "answer": "".join(answer_parts).strip()})
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
    session["audio_queue"].put(None)
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

    def worker():
        try:
            with _tenant_io_lock:
                _configure_tenant_artifacts_dir(tenant_id=tenant_id, user_id=user_id)
                result = _run_llm_query(query=query, files=files, top_k=top_k)
            answer = str(result.get("answer") or "").strip()
            route = str(result.get("route") or "").strip()
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

    audio_queue: Queue[bytes | None] = Queue()
    result_queue: Queue[dict] = Queue()
    stop_event = Event()
    session_id = uuid4().hex

    def producer():
        try:
            for transcript_event in stream_transcripts_from_audio_queue(
                audio_queue=audio_queue,
                sample_rate=sample_rate,
                channels=channels,
                stop_event=stop_event,
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
    logger.info("Transcript session started: %s", session_id)
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

    session["audio_queue"].put(audio_payload)
    return {"success": True}


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

    audio_queue: Queue[bytes | None] = Queue()
    result_queue: Queue[dict] = Queue()
    stop_event = Event()

    def producer():
        try:
            for transcript_event in stream_transcripts_from_audio_queue(
                audio_queue=audio_queue,
                sample_rate=sample_rate,
                channels=channels,
                stop_event=stop_event,
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
                    audio_queue.put(message["bytes"])
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
            audio_queue.put(None)

    logger.info("Transcript websocket started")
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
                await websocket.send_text(json.dumps(message["payload"]))
                continue

            if message["type"] == "error":
                await websocket.send_text(json.dumps(message["payload"]))
                break

            if message["type"] == "done":
                break
    finally:
        stop_event.set()
        audio_queue.put(None)
        await receiver_task
        worker.join(timeout=1)
        try:
            await websocket.close()
        except RuntimeError:
            logger.debug("Transcript websocket already closed")
        logger.info("Transcript websocket stopped")
