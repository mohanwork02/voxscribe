from pathlib import Path


def read_prompt(path: Path) -> str:
    if not path.is_file():
        raise FileNotFoundError(
            f"Prompt file not found: {path}. Create it or update the path in config."
        )
    return path.read_text(encoding="utf-8").strip()


def read_prompt_sections(path: Path) -> dict[str, str]:
    """
    Reads a single prompt file that contains named sections, e.g.:

    ===SYSTEM===
    ...
    ===USER===
    ...
    """
    text = read_prompt(path)
    sections: dict[str, list[str]] = {}
    current: str | None = None

    for line in text.splitlines():
        stripped = line.strip()
        if stripped.startswith("===") and stripped.endswith("===") and len(stripped) > 6:
            name = stripped.strip("=").strip().lower()
            current = name
            sections.setdefault(current, [])
            continue
        if current is None:
            continue
        sections[current].append(line)

    return {k: "\n".join(v).strip() for k, v in sections.items() if "\n".join(v).strip()}
