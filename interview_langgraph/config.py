import os
from pathlib import Path

from dotenv import load_dotenv


ROOT_DIR = Path(__file__).resolve().parent
PROMPTS_DIR = ROOT_DIR / "prompts"

# Load .env early so all modules can read env vars reliably.
load_dotenv(ROOT_DIR / ".env", override=True)


def get_env(name: str) -> str:
    value = os.getenv(name)
    if value is None:
        raise ValueError(f"{name} must be set in .env.")
    return value


def get_env_int(name: str) -> int:
    value = get_env(name)
    try:
        return int(value)
    except ValueError as exc:
        raise ValueError(f"{name} must be an integer.") from exc


def get_env_optional(name: str, default: str) -> str:
    value = os.getenv(name)
    return default if value is None or not str(value).strip() else str(value).strip()


CHUNK_SIZE = get_env_int("CHUNK_SIZE")
CHUNK_OVERLAP = get_env_int("CHUNK_OVERLAP")
EMBEDDING_MODEL = get_env("EMBEDDING_MODEL")

SELF_INTRO_MODEL = get_env("SELF_INTRO_MODEL")

CHAT_MODEL = get_env("CHAT_MODEL")
ROUTER_MODEL = get_env_optional("ROUTER_MODEL", CHAT_MODEL)
PROJECT_EXPLAINATION_MODEL = get_env_optional("PROJECT_EXPLAINATION_MODEL", CHAT_MODEL)
CODE_MODEL = get_env_optional("CODE_MODEL", CHAT_MODEL)
SCENARIO_MODEL = get_env_optional("SCENARIO_MODEL", CHAT_MODEL)
QA_MODEL = get_env_optional("QA_MODEL", CHAT_MODEL)

# Performance knobs
ROUTING_MODE = get_env_optional("ROUTING_MODE", "llm").lower()  # rules|llm
RETRIEVAL_MODE = get_env_optional("RETRIEVAL_MODE", "lexical").lower()  # lexical|embedding
STREAM_OUTPUT = get_env_optional("STREAM_OUTPUT", "1").lower() in {"1", "true", "yes"}

if CHUNK_OVERLAP >= CHUNK_SIZE:
    raise ValueError(
        f"CHUNK_OVERLAP ({CHUNK_OVERLAP}) must be smaller than CHUNK_SIZE ({CHUNK_SIZE})."
    )


ROUTER_PROMPT_PATH = PROMPTS_DIR / "router.txt"
INTRO_PROMPT_PATH = PROMPTS_DIR / "introduction.txt"
PROJECT_EXPLAINATION_PROMPT_PATH = PROMPTS_DIR / "project_explaination.txt"
CODE_PROMPT_PATH = PROMPTS_DIR / "code.txt"
SCENARIO_PROMPT_PATH = PROMPTS_DIR / "scenario.txt"
QA_PROMPT_PATH = PROMPTS_DIR / "qa.txt"


def get_openai_setup_issues() -> list[str]:
    issues: list[str] = []

    api_key = os.getenv("OPENAI_API_KEY")
    if api_key is None or not str(api_key).strip():
        issues.append(
            "OPENAI_API_KEY is not set. PowerShell: `$env:OPENAI_API_KEY=\"sk-...\"` (or set it in `.env`)."
        )

    for var in ("HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY"):
        value = os.getenv(var)
        if not value:
            continue
        value_str = str(value).strip()
        # A very common misconfig: proxy set to localhost:9 (discard port) which always refuses.
        if "127.0.0.1:9" in value_str or value_str.rstrip("/").endswith(":9"):
            issues.append(
                f"{var} is set to `{value_str}` which will refuse connections. Unset it or set it to your real proxy."
            )

    return issues
