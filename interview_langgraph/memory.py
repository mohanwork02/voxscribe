from __future__ import annotations

from typing import Any


def coerce_history(value: Any, *, max_turns: int = 2) -> list[dict[str, str]]:
    """
    Normalize a user-provided history payload into OpenAI chat messages.

    We only keep "user" and "assistant" roles, and trim to the last `max_turns`
    exchanges (2 turns => up to 4 messages).
    """
    if not value:
        return []

    try:
        items = list(value)
    except Exception:
        return []

    cleaned: list[dict[str, str]] = []
    for item in items:
        if not isinstance(item, dict):
            continue
        role = str(item.get("role") or "").strip().lower()
        content = str(item.get("content") or "").strip()
        if role not in {"user", "assistant"}:
            continue
        if not content:
            continue
        cleaned.append({"role": role, "content": content})

    max_items = max(0, int(max_turns)) * 2
    if max_items <= 0:
        return []
    return cleaned[-max_items:]

