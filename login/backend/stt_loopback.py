import logging
import os
import random
import time
from queue import Empty, Queue
from threading import Event
from typing import Any

from dotenv import load_dotenv
load_dotenv()
import numpy as np
from google.api_core import exceptions as google_exceptions
from google.cloud import speech_v1 as speech

logger = logging.getLogger(__name__)


def _env_bool(name: str, default: bool) -> bool:
    raw = str(os.getenv(name, "")).strip().lower()
    if not raw:
        return default
    return raw in {"1", "true", "yes", "y", "on"}


def _env_int(name: str, default: int) -> int:
    raw = str(os.getenv(name, "")).strip()
    if not raw:
        return default
    try:
        return int(raw)
    except ValueError:
        return default


def _env_float(name: str, default: float) -> float:
    raw = str(os.getenv(name, "")).strip()
    if not raw:
        return default
    try:
        return float(raw)
    except ValueError:
        return default


TARGET_RATE = int(os.getenv("STT_TARGET_RATE", "16000"))
STREAMING_SESSION_SECONDS = int(os.getenv("STT_STREAMING_SESSION_SECONDS", "240"))
RETRY_DELAY_SECONDS = float(os.getenv("STT_RETRY_DELAY_SECONDS", "1"))
CHUNK_SECONDS = float(os.getenv("STT_CHUNK_SECONDS", "0.02"))
QUEUE_POLL_SECONDS = float(os.getenv("STT_QUEUE_POLL_SECONDS", "0.02"))
KEEPALIVE_SECONDS = _env_float("STT_KEEPALIVE_SECONDS", 2.0)
INTERIM_MIN_INTERVAL_SECONDS = _env_float("STT_INTERIM_MIN_INTERVAL_SECONDS", 0.12)
LOG_EVERY_SECONDS = _env_float("STT_LOG_EVERY_SECONDS", 5.0)


_resample_index_cache: dict[tuple[int, int, int], tuple[np.ndarray, np.ndarray]] = {}


def convert_audio_chunk(data: bytes, input_rate: int, channels: int = 1) -> bytes:
    audio = np.frombuffer(data, dtype=np.int16)

    if channels > 1 and len(audio) >= channels:
        remainder = len(audio) % channels
        if remainder:
            audio = audio[:-remainder]
        audio = audio.reshape(-1, channels)
        audio = audio.mean(axis=1)

    if input_rate != TARGET_RATE and len(audio) > 0:
        if input_rate > TARGET_RATE and input_rate % TARGET_RATE == 0:
            factor = input_rate // TARGET_RATE
            remainder = len(audio) % factor
            if remainder:
                audio = audio[:-remainder]
            if len(audio) > 0:
                audio = audio.reshape(-1, factor).mean(axis=1)
        else:
            new_length = max(1, int(round(len(audio) * (TARGET_RATE / float(input_rate)))))
            key = (len(audio), input_rate, TARGET_RATE)
            cached = _resample_index_cache.get(key)
            if cached is None:
                old_idx = np.arange(len(audio), dtype=np.float32)
                new_idx = np.linspace(0, len(audio) - 1, new_length, dtype=np.float32)
                _resample_index_cache[key] = (old_idx, new_idx)
            else:
                old_idx, new_idx = cached
                if len(new_idx) != new_length:
                    old_idx = np.arange(len(audio), dtype=np.float32)
                    new_idx = np.linspace(0, len(audio) - 1, new_length, dtype=np.float32)
                    _resample_index_cache[key] = (old_idx, new_idx)
            audio = np.interp(new_idx, old_idx, audio).astype(np.float32, copy=False)

    return audio.astype(np.int16).tobytes()


RETRYABLE_STREAMING_EXCEPTIONS = (
    getattr(google_exceptions, "Aborted", google_exceptions.Unknown),
    google_exceptions.Cancelled,
    google_exceptions.DeadlineExceeded,
    google_exceptions.OutOfRange,
    getattr(google_exceptions, "ResourceExhausted", google_exceptions.Unknown),
    google_exceptions.ServiceUnavailable,
    google_exceptions.InternalServerError,
    google_exceptions.Unknown,
)


def create_speech_client():
    service_account_file = str(os.getenv("GOOGLE_APPLICATION_CREDENTIALS") or "").strip()
    if not service_account_file:
        raise RuntimeError(
            "Missing GOOGLE_APPLICATION_CREDENTIALS. Provide a service account JSON path via env var."
        )
    return speech.SpeechClient.from_service_account_file(service_account_file)


def close_speech_client(client):
    try:
        client.close()
    except Exception:
        logger.debug("Failed to close Google Speech client transport cleanly.", exc_info=True)


def build_streaming_config():
    language_code = str(os.getenv("STT_LANGUAGE_CODE") or "en-US").strip() or "en-US"
    model = str(os.getenv("STT_MODEL") or "").strip()
    use_enhanced = _env_bool("STT_USE_ENHANCED", False)
    enable_punctuation = _env_bool("STT_ENABLE_PUNCTUATION", True)
    max_alternatives = _env_int("STT_MAX_ALTERNATIVES", 1)
    profanity_filter = _env_bool("STT_PROFANITY_FILTER", False)

    phrase_hints_raw = str(os.getenv("STT_PHRASE_HINTS") or "").strip()
    speech_contexts = []
    if phrase_hints_raw:
        phrases = [p.strip() for p in phrase_hints_raw.split(",") if p.strip()]
        if phrases:
            boost = float(os.getenv("STT_PHRASE_BOOST", "10") or 10)
            speech_contexts = [speech.SpeechContext(phrases=phrases, boost=boost)]

    diarization_enabled = _env_bool("STT_ENABLE_DIARIZATION", False)
    diarization_min = _env_int("STT_DIARIZATION_MIN_SPEAKERS", 2)
    diarization_max = _env_int("STT_DIARIZATION_MAX_SPEAKERS", 6)
    enable_word_time_offsets = diarization_enabled or _env_bool("STT_ENABLE_WORD_TIME_OFFSETS", False)

    config = speech.RecognitionConfig(
        encoding=speech.RecognitionConfig.AudioEncoding.LINEAR16,
        sample_rate_hertz=TARGET_RATE,
        audio_channel_count=1,
        language_code=language_code,
        enable_automatic_punctuation=enable_punctuation,
        max_alternatives=max_alternatives,
        profanity_filter=profanity_filter,
        speech_contexts=speech_contexts,
        enable_word_time_offsets=enable_word_time_offsets,
    )
    if model:
        config.model = model
    if use_enhanced:
        config.use_enhanced = True
    if diarization_enabled:
        config.diarization_config = speech.SpeakerDiarizationConfig(
            enable_speaker_diarization=True,
            min_speaker_count=diarization_min,
            max_speaker_count=diarization_max,
        )

    return speech.StreamingRecognitionConfig(
        config=config,
        interim_results=True,
    )


def build_silence_chunk(input_rate, channels=1):
    frame_count = max(1, int(input_rate * CHUNK_SECONDS))
    silence = np.zeros(frame_count * max(1, channels), dtype=np.int16).tobytes()
    return convert_audio_chunk(silence, input_rate, channels)


def _format_ctx(ctx: dict[str, Any] | None) -> str:
    if not ctx:
        return ""
    parts = []
    for key in ("conn_id", "session_id", "tenant_id", "user_id"):
        value = ctx.get(key)
        if value:
            parts.append(f"{key}={value}")
    return " ".join(parts)


def iter_streaming_transcripts(audio_source, stop_event: Event, *, log_context: dict[str, Any] | None = None):
    streaming_config = build_streaming_config()
    ctx = _format_ctx(log_context)
    last_interim_sent_at = 0.0
    last_interim_text = ""
    retry_attempt = 0

    while not stop_event.is_set():
        session_started = time.monotonic()
        client = create_speech_client()
        responses = None
        logger.info(
            "STT streaming session start %s target_rate=%s model=%s lang=%s diarization=%s",
            ctx,
            TARGET_RATE,
            getattr(streaming_config.config, "model", "") or "-",
            getattr(streaming_config.config, "language_code", "") or "-",
            bool(getattr(streaming_config.config, "diarization_config", None)),
        )

        def request_generator():
            while not stop_event.is_set():
                if time.monotonic() - session_started >= STREAMING_SESSION_SECONDS:
                    logger.info(
                        "STT streaming session rotate %s after=%ss",
                        ctx,
                        STREAMING_SESSION_SECONDS,
                    )
                    return

                try:
                    chunk = next(audio_source)
                except StopIteration:
                    return

                yield speech.StreamingRecognizeRequest(audio_content=chunk)

        try:
            responses = client.streaming_recognize(
                streaming_config,
                request_generator(),
            )

            for response in responses:
                if stop_event.is_set():
                    return

                for result in response.results:
                    transcript = result.alternatives[0].transcript.strip()
                    if transcript:
                        now = time.monotonic()
                        if not result.is_final:
                            if transcript == last_interim_text:
                                continue
                            if now - last_interim_sent_at < INTERIM_MIN_INTERVAL_SECONDS:
                                continue
                            last_interim_sent_at = now
                            last_interim_text = transcript
                        yield {
                            "type": "final" if result.is_final else "interim",
                            "transcript": transcript,
                            "is_final": result.is_final,
                            "stability": float(getattr(result, "stability", 0.0) or 0.0),
                        }
            retry_attempt = 0
        except RETRYABLE_STREAMING_EXCEPTIONS as exc:
            if stop_event.is_set():
                return

            logger.warning("STT streaming session interrupted %s err=%s", ctx, exc)
            retry_attempt += 1
            base = max(0.1, RETRY_DELAY_SECONDS)
            delay = min(10.0, base * (2 ** min(retry_attempt, 5)))
            delay = delay * (0.7 + (random.random() * 0.6))
            if stop_event.wait(delay):
                return
        finally:
            if responses is not None:
                cancel = getattr(responses, "cancel", None)

                if callable(cancel):
                    try:
                        cancel()
                    except Exception:
                        logger.debug("Failed to cancel Google Speech response stream cleanly.", exc_info=True)

            close_speech_client(client)


def stream_transcripts_from_audio_queue(
    audio_queue: Queue,
    sample_rate: int,
    channels: int = 1,
    stop_event: Event | None = None,
    log_context: dict[str, Any] | None = None,
):
    stop_event = stop_event or Event()
    silence_chunk = build_silence_chunk(sample_rate, channels)
    ctx = _format_ctx(log_context)
    last_keepalive_at = 0.0
    last_stats_at = 0.0

    logger.info(
        "STT audio input start %s sample_rate=%s channels=%s target_rate=%s keepalive=%ss queue_poll=%ss",
        ctx,
        sample_rate,
        channels,
        TARGET_RATE,
        KEEPALIVE_SECONDS,
        QUEUE_POLL_SECONDS,
    )

    def audio_chunks():
        nonlocal last_keepalive_at, last_stats_at
        while not stop_event.is_set():
            try:
                data = audio_queue.get(timeout=QUEUE_POLL_SECONDS)
            except Empty:
                now = time.monotonic()
                if LOG_EVERY_SECONDS and now - last_stats_at >= LOG_EVERY_SECONDS:
                    try:
                        queue_size = audio_queue.qsize()
                    except Exception:
                        queue_size = -1
                    logger.debug("STT audio queue idle %s qsize=%s", ctx, queue_size)
                    last_stats_at = now

                if silence_chunk and KEEPALIVE_SECONDS:
                    now = time.monotonic()
                    if now - last_keepalive_at >= KEEPALIVE_SECONDS:
                        last_keepalive_at = now
                        yield silence_chunk
                continue

            if data is None:
                return

            converted = convert_audio_chunk(data, sample_rate, channels)
            if converted:
                yield converted
            elif silence_chunk and KEEPALIVE_SECONDS:
                yield silence_chunk

    audio_source = audio_chunks()

    try:
        yield from iter_streaming_transcripts(audio_source, stop_event, log_context=log_context)
    finally:
        stop_event.set()


def stream_transcripts(stop_event: Event | None = None):
    stop_event = stop_event or Event()

    try:
        import pyaudiowpatch as pyaudio  # type: ignore[import-not-found]
    except Exception as exc:
        raise RuntimeError(
            "System-audio loopback capture is not available (missing dependency: pyaudiowpatch). "
            "This is expected on Linux/Ubuntu containers; use the session upload endpoints instead."
        ) from exc

    p = pyaudio.PyAudio()

    # Get default loopback device
    loopback = p.get_default_wasapi_loopback()
    input_rate = int(loopback["defaultSampleRate"])
    channels = 2
    chunk = max(1, int(input_rate * CHUNK_SECONDS))
    silence_chunk = build_silence_chunk(input_rate, channels)

    stream = p.open(
        format=pyaudio.paInt16,
        channels=channels,
        rate=input_rate,
        input=True,
        input_device_index=loopback["index"],
        frames_per_buffer=chunk,
    )

    def audio_chunks():
        while not stop_event.is_set():
            read_available = getattr(stream, "get_read_available", lambda: chunk)()

            if read_available < chunk:
                if stop_event.wait(CHUNK_SECONDS):
                    return

                if silence_chunk:
                    yield silence_chunk
                continue

            try:
                data = stream.read(chunk, exception_on_overflow=False)
            except OSError as exc:
                if stop_event.is_set():
                    return

                logger.warning("System audio read interrupted: %s", exc)

                if stop_event.wait(CHUNK_SECONDS):
                    return

                if silence_chunk:
                    yield silence_chunk
                continue

            converted = convert_audio_chunk(data, input_rate, channels)
            if converted:
                yield converted
            elif silence_chunk:
                yield silence_chunk

    audio_source = audio_chunks()

    try:
        yield from iter_streaming_transcripts(audio_source, stop_event)
    finally:
        stream.stop_stream()
        stream.close()
        p.terminate()
