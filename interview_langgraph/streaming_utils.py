from __future__ import annotations

from typing import Any, List, Tuple


def stream_chat_completion_text(
    *,
    client: Any,
    model: str,
    messages: list[dict[str, str]],
    temperature: float,
    max_tokens: int,
) -> Tuple[str, bool]:
    """
    Stream tokens to stdout while accumulating the final text.
    Uses the OpenAI chat.completions streaming interface.
    """
    stream = client.chat.completions.create(
        model=model,
        messages=messages,
        temperature=temperature,
        max_tokens=max_tokens,
        stream=True,
    )

    parts: List[str] = []
    streamed_ok = True
    for chunk in stream:
        try:
            delta = chunk.choices[0].delta
            text = getattr(delta, "content", None)
        except Exception:
            text = None
        if text:
            print(text, end="", flush=True)
            parts.append(text)

    if parts and not parts[-1].endswith("\n"):
        print()
    return "".join(parts).strip(), streamed_ok
