from pathlib import Path


def _get_prompt_domain_values() -> dict[str, str]:
    try:
        from smart_input_llm import read_saved_domain
    except Exception:
        return {"domain": "", "domain_guidance": ""}

    domain = str(read_saved_domain() or "").strip()
    if not domain:
        return {"domain": "", "domain_guidance": ""}

    guidance = (
        f"- The active interview domain is {domain}. "
        "Use it to align terminology, examples, and framing only when it is relevant. "
        "Do not force the domain into unrelated answers."
    )
    return {"domain": domain, "domain_guidance": guidance}


def _render_prompt_placeholders(text: str) -> str:
    rendered = str(text or "")
    for key, value in _get_prompt_domain_values().items():
        rendered = rendered.replace(f"{{{key}}}", value)
    return rendered


def read_prompt(path: Path) -> str:
    if not path.is_file():
        raise FileNotFoundError(
            f"Prompt file not found: {path}. Create it or update the path in config."
        )
    raw_text = path.read_text(encoding="utf-8").strip()
    return _render_prompt_placeholders(raw_text).strip()


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
