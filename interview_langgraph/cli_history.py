from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from memory import coerce_history
from smart_input_llm import OUTPUT_DIR


HISTORY_FILE: Path = OUTPUT_DIR / "chat_history.json"


def load_history(*, max_turns: int = 2) -> list[dict[str, str]]:
    """
    Load persisted history (best-effort). Returns a normalized list of messages.
    """
    try:
        if not HISTORY_FILE.is_file():
            return []
        raw = json.loads(HISTORY_FILE.read_text(encoding="utf-8"))
    except Exception:
        return []
    return coerce_history(raw, max_turns=max_turns)


def save_history(history: Any, *, max_turns: int = 2) -> None:
    """
    Persist history (best-effort). Stores only last `max_turns` exchanges.
    """
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    trimmed = coerce_history(history, max_turns=max_turns)
    HISTORY_FILE.write_text(json.dumps(trimmed, ensure_ascii=False, indent=2), encoding="utf-8")

