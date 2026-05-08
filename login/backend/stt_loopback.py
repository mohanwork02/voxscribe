import logging
import os
import time
from queue import Empty, Queue
from threading import Event

from dotenv import load_dotenv
load_dotenv()
import numpy as np
import pyaudiowpatch as pyaudio
from google.api_core import exceptions as google_exceptions
from google.cloud import speech_v1 as speech

logger = logging.getLogger(__name__)
SERVICE_ACCOUNT_FILE = os.getenv("GOOGLE_APPLICATION_CREDENTIALS")
print("path from .env ",SERVICE_ACCOUNT_FILE)
TARGET_RATE = int(os.getenv("STT_TARGET_RATE", "16000"))
STREAMING_SESSION_SECONDS = int(os.getenv("STT_STREAMING_SESSION_SECONDS", "240"))
RETRY_DELAY_SECONDS = float(os.getenv("STT_RETRY_DELAY_SECONDS", "1"))
CHUNK_SECONDS = float(os.getenv("STT_CHUNK_SECONDS", "0.02"))
QUEUE_POLL_SECONDS = float(os.getenv("STT_QUEUE_POLL_SECONDS", "0.02"))


def convert_audio_chunk(data, input_rate, channels=1):
    audio = np.frombuffer(data, dtype=np.int16)

    if channels > 1 and len(audio) >= channels:
        remainder = len(audio) % channels
        if remainder:
            audio = audio[:-remainder]
        audio = audio.reshape(-1, channels)
        audio = audio.mean(axis=1)

    if input_rate != TARGET_RATE and len(audio) > 0:
        duration = len(audio) / input_rate
        new_length = max(1, int(duration * TARGET_RATE))

        old_idx = np.linspace(0, 1, len(audio))
        new_idx = np.linspace(0, 1, new_length)
        audio = np.interp(new_idx, old_idx, audio)

    return audio.astype(np.int16).tobytes()


RETRYABLE_STREAMING_EXCEPTIONS = (
    google_exceptions.Cancelled,
    google_exceptions.DeadlineExceeded,
    google_exceptions.OutOfRange,
    google_exceptions.ServiceUnavailable,
    google_exceptions.InternalServerError,
    google_exceptions.Unknown,
)


def create_speech_client():
    return speech.SpeechClient.from_service_account_file(SERVICE_ACCOUNT_FILE)


def close_speech_client(client):
    try:
        client.close()
    except Exception:
        logger.debug("Failed to close Google Speech client transport cleanly.", exc_info=True)


def build_streaming_config():
    config = speech.RecognitionConfig(
        encoding=speech.RecognitionConfig.AudioEncoding.LINEAR16,
        sample_rate_hertz=TARGET_RATE,
        language_code="en-US",
        enable_automatic_punctuation=True,
    )

    return speech.StreamingRecognitionConfig(
        config=config,
        interim_results=True,
    )


def build_silence_chunk(input_rate, channels=1):
    frame_count = max(1, int(input_rate * CHUNK_SECONDS))
    silence = np.zeros(frame_count * max(1, channels), dtype=np.int16).tobytes()
    return convert_audio_chunk(silence, input_rate, channels)


def iter_streaming_transcripts(audio_source, stop_event: Event):
    streaming_config = build_streaming_config()

    while not stop_event.is_set():
        session_started = time.monotonic()
        client = create_speech_client()
        responses = None

        def request_generator():
            while not stop_event.is_set():
                if time.monotonic() - session_started >= STREAMING_SESSION_SECONDS:
                    logger.info("Rotating Google Speech streaming session after %ss.", STREAMING_SESSION_SECONDS)
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
                        yield {
                            "type": "final" if result.is_final else "interim",
                            "transcript": transcript,
                            "is_final": result.is_final,
                        }
        except RETRYABLE_STREAMING_EXCEPTIONS as exc:
            if stop_event.is_set():
                return

            logger.warning("Google Speech streaming session interrupted: %s", exc)
            if stop_event.wait(RETRY_DELAY_SECONDS):
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
):
    stop_event = stop_event or Event()
    silence_chunk = build_silence_chunk(sample_rate, channels)

    def audio_chunks():
        while not stop_event.is_set():
            try:
                data = audio_queue.get(timeout=QUEUE_POLL_SECONDS)
            except Empty:
                if silence_chunk:
                    yield silence_chunk
                continue

            if data is None:
                return

            converted = convert_audio_chunk(data, sample_rate, channels)
            if converted:
                yield converted
            elif silence_chunk:
                yield silence_chunk

    audio_source = audio_chunks()

    try:
        yield from iter_streaming_transcripts(audio_source, stop_event)
    finally:
        stop_event.set()


def stream_transcripts(stop_event: Event | None = None):
    stop_event = stop_event or Event()
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
