import base64
import mimetypes
import os
import sys
import logging
import time
import re
from datetime import datetime
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

from dotenv import load_dotenv
from openai import OpenAI

# -------------------- CONFIG --------------------

load_dotenv(Path(__file__).with_name(".env"), override=True)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(levelname)s - %(message)s"
)

client = OpenAI()

CODE_MODEL = os.getenv("CHAT_MODEL_VISION_CODE")
TEXT_MODEL = os.getenv("CHAT_MODEL")

def get_env_bool(name: str, default: bool) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    value = raw.strip().lower()
    return value in {"1", "true", "yes", "y", "on"}

def get_env_optional_bool(name: str) -> Optional[bool]:
    raw = os.getenv(name)
    if raw is None:
        return None
    return get_env_bool(name, False)


def get_env_float(name: str, default: float) -> float:
    try:
        return float(os.getenv(name, default))
    except ValueError:
        return default


CODE_TEMPERATURE = get_env_float("CHAT_TEMPERATURE_VISION", 0.3)
TEXT_TEMPERATURE = get_env_float("CHAT_TEMPERATURE", 0.3)


# -------------------- HELPERS --------------------

def encode_image(image_path: str) -> str:
    path = Path(image_path)

    if not path.is_file():
        raise FileNotFoundError(f"Image not found: {image_path}")

    mime, _ = mimetypes.guess_type(str(path))
    mime = mime or "image/png"

    with path.open("rb") as f:
        encoded = base64.b64encode(f.read()).decode("utf-8")

    return f"data:{mime};base64,{encoded}"


def split_image_paths(raw_paths: str) -> list[str]:
    raw_paths = raw_paths.strip()

    if not raw_paths:
        return []

    if Path(raw_paths).is_file():
        return [raw_paths]

    if "," in raw_paths or ";" in raw_paths:
        return [
            path.strip().strip('"').strip("'")
            for path in re.split(r"[,;]", raw_paths)
            if path.strip()
        ]

    return [
        path.strip().strip('"').strip("'")
        for path in raw_paths.split()
        if path.strip()
    ]


def normalize_image_paths(
    image_path: Optional[str] = None,
    image_paths: Optional[list[str]] = None,
) -> list[str]:
    paths: list[str] = []

    if image_paths:
        paths.extend(str(path).strip() for path in image_paths if str(path).strip())

    if image_path:
        paths.extend(split_image_paths(image_path))

    return paths


def strip_code_fences(text: str) -> str:
    return "\n".join(
        line for line in text.splitlines()
        if not line.strip().startswith("```")
    ).strip()


def normalize_text(text: Optional[str]) -> str:
    return (text or "").strip().lower()


def contains_any(text: str, keywords: tuple[str, ...]) -> bool:
    for keyword in keywords:
        pattern = r"\b" + re.escape(keyword.lower()) + r"\b"
        if re.search(pattern, text):
            return True
    return False


def starts_with_any(text: str, prefixes: tuple[str, ...]) -> bool:
    return any(text.startswith(prefix.lower()) for prefix in prefixes)


def wants_explanation(query: Optional[str]) -> bool:
    q = normalize_text(query)

    explanation_keywords = (
        "exp",
        "expl",
        "expln",
        "explain",
        "explanation",
        "explaination",
        "why",
        "how",
        "describe",
        "brief",
        "details",
        "walkthrough",
        "step by step",
    )

    return contains_any(q, explanation_keywords)


def is_concept_query(query: Optional[str]) -> bool:
    q = normalize_text(query)

    concept_prefixes = (
        "what is",
        "what are",
        "explain",
        "explain about",
        "tell me about",
        "define",
        "meaning of",
        "describe",
        "brief about",
    )

    concept_keywords = (
        "meaning",
        "definition",
        "overview",
        "introduction",
        "concept",
    )

    return starts_with_any(q, concept_prefixes) or contains_any(q, concept_keywords)


def has_answer_structure(text: str) -> bool:
    output = text.lower()
    return "answer:" in output and "- " in output


def has_code_explanation_structure(text: str) -> bool:
    output = text.lower()
    return "code:" in output and "explanation:" in output


# -------------------- PROMPT INTENT --------------------

@dataclass(frozen=True)
class PromptSettings:
    assistant_role: str
    task_type: str
    output_type: str
    extra_instructions: str
    intent: str


def infer_prompt_settings(query: Optional[str], is_vision: bool) -> PromptSettings:
    q = normalize_text(query)

    debug_keywords = (
        "debug",
        "error",
        "exception",
        "traceback",
        "bug",
        "fix",
        "not working",
        "issue",
        "failed",
        "failure",
    )

    interview_keywords = (
        "interview",
        "candidate",
        "resume",
        "self introduction",
        "introduce",
        "hr",
        "technical round",
        "answer like",
        "about yourself",
        "project explanation",
        "recent project",
    )

    coding_keywords = (
        "code",
        "program",
        "function",
        "implement",
        "implementation",
        "algorithm",
        "solve",
        "leetcode",
        "python",
        "java",
        "javascript",
        "typescript",
        "react",
        "node",
        "django",
        "fastapi",
        "sql",
    )

    qa_keywords = (
        "qa",
        "bug report",
        "ui issue",
        "ux issue",
        "screen issue",
        "alignment",
        "raise bug",
    )

    if contains_any(q, debug_keywords):
        return PromptSettings(
            assistant_role="debugging assistant",
            task_type="bug, error, or broken code",
            output_type="corrected code",
            extra_instructions=(
                "Preserve the existing logic unless a change is required to fix the issue. "
                "Do not rewrite unrelated parts."
            ),
            intent="debug",
        )

    if contains_any(q, qa_keywords):
        return PromptSettings(
            assistant_role="QA assistant",
            task_type="UI issue or screenshot review",
            output_type="clear QA bug report",
            extra_instructions=(
                "Focus on visible UI behavior, expected behavior, actual behavior, and impact. "
                "Do not assume backend logic unless it is visible."
            ),
            intent="formatted_answer",
        )

    if contains_any(q, interview_keywords):
        return PromptSettings(
            assistant_role="AI interview copilot",
            task_type="interview question or candidate answer",
            output_type="interview-style answer",
            extra_instructions=(
                "Answer like a real candidate. Keep it simple, practical, and easy to speak. "
                "Avoid textbook tone."
            ),
            intent="formatted_answer",
        )

    if not is_vision and is_concept_query(query):
        return PromptSettings(
            assistant_role="technical explanation assistant",
            task_type="concept explanation",
            output_type="structured explanation",
            extra_instructions=(
                "Explain the topic in a practical and informative way. "
                "Do not return a single plain paragraph."
            ),
            intent="formatted_answer",
        )

    if is_vision or contains_any(q, coding_keywords):
        return PromptSettings(
            assistant_role="expert coding assistant",
            task_type="coding problem or technical requirement",
            output_type="clean code",
            extra_instructions=(
                "Use the programming language requested by the user. "
                "If no language is mentioned, infer the language from the image or problem context."
            ),
            intent="coding",
        )

    return PromptSettings(
        assistant_role="helpful assistant",
        task_type="user request",
        output_type="structured answer",
        extra_instructions="Answer clearly and practically.",
        intent="formatted_answer",
    )


# -------------------- PROMPTS --------------------

def build_human_explanation_rules() -> str:
    return (
        "Explanation style rules:\n"
        "- Explain like a real developer talking to another person.\n"
        "- Use simple, natural English.\n"
        "- Do not sound like documentation or a textbook.\n"
        "- Do not over-explain basic theory.\n"
        "- Focus on what the code does, why it works, and the key logic.\n"
        "- Keep it short and practical.\n"
        "- Avoid long bullet lists unless they are really needed."
    )


def build_answer_format_rules() -> str:
    return (
        "You must return the answer in this exact style:\n\n"
        "Answer:\n"
        "- <start with a direct natural answer>\n\n"
        "- **Main Point / Problem Statement / What it means:**\n"
        "  - <important point 1>\n"
        "  - <important point 2>\n\n"
        "- **Flow / How it works / Key Details:**\n"
        "  - <important point 1>\n"
        "  - <important point 2>\n\n"
        "- **Example / Real-world Use:**\n"
        "  - <practical example>\n\n"
        "- **Impact / Result / Why it is useful:**\n"
        "  - <final useful takeaway>\n\n"
        "Strict formatting rules:\n"
        "- Start directly with 'Answer:'.\n"
        "- Do not include 'Question:'.\n"
        "- Use bullet points starting with '-'.\n"
        "- Use bold markdown like **RAG**, **CI/CD**, **AWS** for important keywords.\n"
        "- Do not use HTML tags.\n"
        "- Do not use markdown tables.\n"
        "- Do not wrap output inside code fences.\n"
        "- Do not give only one paragraph.\n"
        "- Keep the answer natural, practical, and interview-friendly."
    )


def build_code_explanation_rules() -> str:
    return (
        "Return exactly in this format:\n\n"
        "CODE:\n"
        "<provide the corrected or requested code first>\n\n"
        "EXPLANATION:\n"
        "<provide a short human-style explanation after the code>\n\n"
        "Strict rules:\n"
        "- CODE must always come before EXPLANATION.\n"
        "- EXPLANATION is mandatory when the user asks to explain.\n"
        "- Do not skip the EXPLANATION section.\n"
        "- Do not use markdown code fences.\n"
        "- Do not use ```.\n"
        "- Keep the explanation human, simple, and practical."
    )


def build_multi_image_rules(image_count: int) -> str:
    return (
        f"The user uploaded {image_count} images.\n"
        "Multi-image handling rules:\n"
        "- First decide whether the images are parts of the same task or separate independent tasks.\n"
        "- If the images are parts of the same task, combine their information and return one complete answer.\n"
        "- If the images are separate independent tasks, answer every image separately.\n"
        "- For separate tasks, use clear section labels like 'Image 1', 'Image 2', and so on.\n"
        "- For each image, infer the right answer style from that image and the user's instruction.\n"
        "- Do not ignore any uploaded image unless it is unreadable; if unreadable, say that for that image.\n"
        "- These multi-image rules override any single-answer-only instruction when the images are separate tasks."
    )


def build_system_prompt(
    is_vision: bool,
    explanation: bool,
    assistant_role: str,
    task_type: str,
    output_type: str,
    intent: str,
    image_count: int = 0,
    extra_instructions: str = "",
) -> str:
    prompt_parts = [
        f"You are a {assistant_role}."
    ]

    if is_vision:
        prompt_parts.append(
            f"You may receive a {task_type} through an image, text, or both."
        )
        prompt_parts.append(
            "Use the image content and the user's text instructions together."
        )
    else:
        prompt_parts.append(
            f"Help the user with the given {task_type}."
        )

    if intent == "formatted_answer":
        prompt_parts.append(build_answer_format_rules())

    elif explanation:
        if intent in {"coding", "debug"}:
            prompt_parts.append(build_code_explanation_rules())
            prompt_parts.append(build_human_explanation_rules())
        else:
            prompt_parts.append(build_answer_format_rules())

    else:
        if intent in {"coding", "debug"}:
            prompt_parts.append(
                "Return only the corrected or requested code. "
                "No explanations. No markdown code fences."
            )
        else:
            prompt_parts.append(build_answer_format_rules())

    if extra_instructions:
        prompt_parts.append(extra_instructions.strip())

    if image_count > 1:
        prompt_parts.append(build_multi_image_rules(image_count))

    return "\n".join(prompt_parts)


def build_user_text(query: str, intent: str, explanation: bool) -> str:
    if intent == "formatted_answer":
        return (
            "Answer the following input in the required Answer-only bullet format.\n"
            "Do not include a Question section.\n"
            "Use simple human language and bold important keywords.\n\n"
            f"User input:\n{query}"
        )

    if intent in {"coding", "debug"} and explanation:
        return (
            "Solve the coding problem from the image/text.\n"
            "Return CODE first and EXPLANATION after it.\n"
            "Do not skip EXPLANATION.\n\n"
            f"User instruction:\n{query}"
        )

    return query


def build_format_retry_prompt(query: Optional[str], previous_output: str) -> str:
    return (
        "Your previous answer did not follow the required format.\n"
        "Rewrite it exactly in this format:\n\n"
        "Answer:\n"
        "- <direct answer>\n\n"
        "- **What it means:**\n"
        "  - <point>\n"
        "  - <point>\n\n"
        "- **How it works:**\n"
        "  - <point>\n"
        "  - <point>\n\n"
        "- **Example:**\n"
        "  - <example>\n\n"
        "- **Why it is useful:**\n"
        "  - <takeaway>\n\n"
        "Rules:\n"
        "- Start directly with Answer:.\n"
        "- Do not include Question:.\n"
        "- Do not use HTML.\n"
        "- Do not use code fences.\n"
        "- Use bullets.\n"
        "- Use bold markdown for important keywords.\n\n"
        f"Original user input: {query or ''}\n\n"
        f"Previous answer:\n{previous_output}"
    )


def build_code_explanation_retry_prompt(
    query: Optional[str],
    previous_output: str,
) -> str:
    return (
        "Your previous answer missed the EXPLANATION section.\n"
        "Regenerate the answer exactly in this format:\n\n"
        "CODE:\n"
        "<complete code>\n\n"
        "EXPLANATION:\n"
        "<short human-style explanation>\n\n"
        "Rules:\n"
        "- CODE must come first.\n"
        "- EXPLANATION must be included.\n"
        "- Do not use markdown code fences.\n"
        "- Do not use ```.\n"
        "- Explanation should sound like a real developer explaining the logic.\n\n"
        f"Original user instruction: {query or ''}\n\n"
        f"Previous output:\n{previous_output}"
    )


def select_model_and_temperature(
    is_vision: bool,
    intent: str,
    model: Optional[str],
    temperature: Optional[float],
) -> tuple[str, float]:
    if model is None:
        if is_vision:
            selected_model = CODE_MODEL or TEXT_MODEL
        elif intent in {"coding", "debug"}:
            selected_model = CODE_MODEL or TEXT_MODEL
        else:
            selected_model = TEXT_MODEL or CODE_MODEL
    else:
        selected_model = model

    if not selected_model:
        raise ValueError(
            "Missing model configuration: set CHAT_MODEL_VISION_CODE or CHAT_MODEL."
        )

    if temperature is None:
        if selected_model == CODE_MODEL:
            selected_temperature = CODE_TEMPERATURE
        else:
            selected_temperature = TEXT_TEMPERATURE
    else:
        selected_temperature = temperature

    return selected_model, selected_temperature


# -------------------- OPENAI CALL --------------------

def call_openai(
    model: str,
    temperature: float,
    system_prompt: str,
    user_content: list[dict],
    stream: bool = False,
    stream_to_stdout: bool = False,
    show_timing: bool = False,
    timing_to_stdout: bool = False,
    timings: Optional[list[dict]] = None,
) -> str:
    timing_stream = sys.stdout if timing_to_stdout else sys.stderr
    request = {
        "model": model,
        "temperature": temperature,
        "input": [
            {
                "role": "system",
                "content": [
                    {
                        "type": "input_text",
                        "text": system_prompt,
                    }
                ],
            },
            {
                "role": "user",
                "content": user_content,
            },
        ],
    }

    if not stream:
        start = time.perf_counter()
        response = client.responses.create(**request)
        total_s = time.perf_counter() - start
        if timings is not None:
            timings.append({
                "model": model,
                "stream": False,
                "ttft_s": None,
                "total_s": total_s,
            })
        if show_timing:
            print(
                f"[timing] total={total_s:.2f}s model={model} stream=False",
                file=timing_stream,
            )
        return strip_code_fences(response.output_text)

    chunks: list[str] = []
    start = time.perf_counter()
    first_token_s: Optional[float] = None
    stream_events = client.responses.create(**request, stream=True)

    for event in stream_events:
        event_type = getattr(event, "type", None)
        if event_type is None and isinstance(event, dict):
            event_type = event.get("type")

        if event_type == "response.output_text.delta":
            delta = getattr(event, "delta", None)
            if delta is None and isinstance(event, dict):
                delta = event.get("delta")
            if not delta:
                continue

            if first_token_s is None:
                first_token_s = time.perf_counter() - start

            chunks.append(delta)
            if stream_to_stdout:
                sys.stdout.write(delta)
                sys.stdout.flush()

        elif event_type == "error":
            error = getattr(event, "error", None)
            if error is None and isinstance(event, dict):
                error = event.get("error")
            raise RuntimeError(str(error or "Unknown streaming error"))

    total_s = time.perf_counter() - start
    if show_timing:
        if timing_to_stdout and stream_to_stdout:
            print("", file=sys.stdout)
        if first_token_s is None:
            print(
                f"[timing] ttft=N/A total={total_s:.2f}s model={model} stream=True",
                file=timing_stream,
            )
        else:
            print(
                f"[timing] ttft={first_token_s:.2f}s total={total_s:.2f}s model={model} stream=True",
                file=timing_stream,
            )

    if timings is not None:
        timings.append({
            "model": model,
            "stream": True,
            "ttft_s": first_token_s,
            "total_s": total_s,
        })

    return strip_code_fences("".join(chunks))


# -------------------- CORE FUNCTION --------------------

def generate_output(
    query: Optional[str] = None,
    image_path: Optional[str] = None,
    image_paths: Optional[list[str]] = None,
    model: Optional[str] = None,
    temperature: Optional[float] = None,
    stream: bool = False,
    stream_to_stdout: bool = False,
    show_timing: bool = False,
    timing_to_stdout: bool = False,
    timings: Optional[list[dict]] = None,
) -> str:
    normalized_image_paths = normalize_image_paths(
        image_path=image_path,
        image_paths=image_paths,
    )

    if not query and not normalized_image_paths:
        raise ValueError("Provide at least query or image_path.")

    is_vision = bool(normalized_image_paths)
    explanation = wants_explanation(query)

    prompt_settings = infer_prompt_settings(
        query=query,
        is_vision=is_vision,
    )

    selected_model, selected_temperature = select_model_and_temperature(
        is_vision=is_vision,
        intent=prompt_settings.intent,
        model=model,
        temperature=temperature,
    )

    system_prompt = build_system_prompt(
        is_vision=is_vision,
        explanation=explanation,
        assistant_role=prompt_settings.assistant_role,
        task_type=prompt_settings.task_type,
        output_type=prompt_settings.output_type,
        intent=prompt_settings.intent,
        image_count=len(normalized_image_paths),
        extra_instructions=prompt_settings.extra_instructions,
    )

    user_content = []

    if query:
        user_content.append({
            "type": "input_text",
            "text": build_user_text(query, prompt_settings.intent, explanation),
        })

    for index, current_image_path in enumerate(normalized_image_paths, start=1):
        if len(normalized_image_paths) > 1:
            user_content.append({
                "type": "input_text",
                "text": f"Image {index}:",
            })

        user_content.append({
            "type": "input_image",
            "image_url": encode_image(current_image_path),
        })

    try:
        output = call_openai(
            model=selected_model,
            temperature=selected_temperature,
            system_prompt=system_prompt,
            user_content=user_content,
            stream=stream,
            stream_to_stdout=stream_to_stdout,
            show_timing=show_timing,
            timing_to_stdout=timing_to_stdout,
            timings=timings,
        )

        if (
            prompt_settings.intent == "formatted_answer"
            and len(normalized_image_paths) <= 1
            and not has_answer_structure(output)
        ):
            retry_output = call_openai(
                model=selected_model,
                temperature=selected_temperature,
                system_prompt=build_answer_format_rules(),
                user_content=[
                    {
                        "type": "input_text",
                        "text": build_format_retry_prompt(query, output),
                    }
                ],
                stream=stream,
                stream_to_stdout=stream_to_stdout,
                show_timing=show_timing,
                timing_to_stdout=timing_to_stdout,
                timings=timings,
            )

            if has_answer_structure(retry_output):
                return retry_output

        if (
            prompt_settings.intent in {"coding", "debug"}
            and explanation
            and not has_code_explanation_structure(output)
        ):
            retry_user_content = [
                {
                    "type": "input_text",
                    "text": build_code_explanation_retry_prompt(query, output),
                }
            ]

            for index, current_image_path in enumerate(normalized_image_paths, start=1):
                if len(normalized_image_paths) > 1:
                    retry_user_content.append({
                        "type": "input_text",
                        "text": f"Image {index}:",
                    })

                retry_user_content.append({
                    "type": "input_image",
                    "image_url": encode_image(current_image_path),
                })

            retry_output = call_openai(
                model=selected_model,
                temperature=selected_temperature,
                system_prompt=(
                    build_code_explanation_rules()
                    + "\n"
                    + build_human_explanation_rules()
                    + (
                        "\n" + build_multi_image_rules(len(normalized_image_paths))
                        if len(normalized_image_paths) > 1
                        else ""
                    )
                ),
                user_content=retry_user_content,
                stream=stream,
                stream_to_stdout=stream_to_stdout,
                show_timing=show_timing,
                timing_to_stdout=timing_to_stdout,
                timings=timings,
            )

            if has_code_explanation_structure(retry_output):
                return retry_output

        return output

    except Exception as e:
        logging.error(f"OpenAI API error: {e}")
        return "Error generating response."


# -------------------- CLI --------------------

def main() -> int:
    if not os.getenv("OPENAI_API_KEY"):
        print("Missing OPENAI_API_KEY", file=sys.stderr)
        return 1

    print("AI Assistant Ready (Ctrl+C to exit)\n")

    stream_output = get_env_bool("CHAT_STREAM", True)
    show_timing_overall = get_env_optional_bool("CHAT_SHOW_TIMING")
    if show_timing_overall is None:
        show_timing_overall = True

    show_api_timing = get_env_optional_bool("CHAT_SHOW_API_TIMING")
    if show_api_timing is None:
        show_api_timing = False

    timing_to_stdout = get_env_optional_bool("CHAT_SHOW_TIMING_TO_STDOUT")
    if timing_to_stdout is None:
        timing_to_stdout = bool(show_timing_overall)

    while True:
        try:
            image_path = input("Image path: ").strip()
            query = input("Query: ").strip()

            if not query and not image_path:
                print("Provide at least query or image\n")
                continue

            if stream_output:
                print("\n--- OUTPUT ---\n")

            start_dt = datetime.now().astimezone()
            start_total = time.perf_counter()
            llm_timings: list[dict] = []
            result = generate_output(
                query=query or None,
                image_path=image_path or None,
                stream=stream_output,
                stream_to_stdout=stream_output,
                show_timing=show_api_timing,
                timing_to_stdout=timing_to_stdout,
                timings=llm_timings,
            )
            total_s = time.perf_counter() - start_total
            end_dt = datetime.now().astimezone()

            if not stream_output:
                print("\n--- OUTPUT ---\n")
                print(result)

            if show_timing_overall:
                if timing_to_stdout and stream_output:
                    print("", file=sys.stdout)

                if llm_timings:
                    llm_total_s = sum(t.get("total_s", 0.0) or 0.0 for t in llm_timings)
                    llm_models = ", ".join(sorted({str(t.get("model")) for t in llm_timings if t.get("model")}))
                    first_ttft = next(
                        (t.get("ttft_s") for t in llm_timings if t.get("ttft_s") is not None),
                        None,
                    )

                    if first_ttft is None:
                        llm_part = f"llm_calls={len(llm_timings)} llm_total={llm_total_s:.2f}s llm_models={llm_models}"
                    else:
                        llm_part = (
                            f"llm_calls={len(llm_timings)} ttft={float(first_ttft):.2f}s "
                            f"llm_total={llm_total_s:.2f}s llm_models={llm_models}"
                        )
                else:
                    llm_part = "llm_calls=0 llm_total=0.00s"

                print(
                    (
                        f"[timing] start={start_dt.isoformat(timespec='seconds')} "
                        f"end={end_dt.isoformat(timespec='seconds')} "
                        f"end_to_end={total_s:.2f}s stream={stream_output} "
                        f"{llm_part}"
                    ),
                    file=(sys.stdout if timing_to_stdout else sys.stderr),
                )

            print("\n" + "=" * 50 + "\n")

        except KeyboardInterrupt:
            print("\nExiting...")
            return 0

        except Exception as e:
            logging.error(f"Runtime error: {e}")
            print("Something went wrong. Check logs for details.\n")


if __name__ == "__main__":
    sys.exit(main())
