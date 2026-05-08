from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path


def _bootstrap_imports() -> None:
    # This repo directory is the package itself (it contains `__init__.py`).
    # If the user runs from inside the directory, `import interview_langgraph`
    # won't work (Python expects the *parent* directory on sys.path). We create
    # the package module dynamically so absolute imports resolve reliably.
    here = Path(__file__).resolve().parent

    try:
        import interview_langgraph  # noqa: F401
        return
    except Exception:
        pass

    import importlib.util

    init_py = here / "__init__.py"
    spec = importlib.util.spec_from_file_location(
        "interview_langgraph",
        init_py,
        submodule_search_locations=[str(here)],
    )
    if spec is None or spec.loader is None:
        raise RuntimeError("Unable to bootstrap package imports for interview_langgraph.")
    module = importlib.util.module_from_spec(spec)
    sys.modules["interview_langgraph"] = module
    spec.loader.exec_module(module)


def _parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        prog="interview_langgraph",
        description="Ingest documents and answer questions using a LangGraph workflow.",
    )

    sub = parser.add_subparsers(dest="cmd", required=True)

    p_ingest = sub.add_parser("ingest", help="Create embeddings + build the local index.")
    p_ingest.add_argument("--files", nargs="+", required=True, help="One or more .pdf/.docx paths.")

    p_ask = sub.add_parser("ask", help="Answer a question using the existing local index.")
    p_ask.add_argument("--query", required=True, help="The user question.")
    p_ask.add_argument("--top-k", type=int, default=None, help="Number of chunks to retrieve.")
    p_ask.add_argument(
        "--show-route",
        action="store_true",
        help="Print the selected route (introduction/project_explaination/code/scenario/qa) before the answer.",
    )
    p_ask.add_argument(
        "--no-timing",
        action="store_true",
        help="Disable timing output (enabled by default).",
    )

    p_full = sub.add_parser("run", help="Ingest then answer (single end-to-end run).")
    p_full.add_argument("--files", nargs="+", required=True, help="One or more .pdf/.docx paths.")
    p_full.add_argument("--query", required=False, help="The user question (omit to enter a loop).")
    p_full.add_argument("--top-k", type=int, default=None, help="Number of chunks to retrieve.")
    p_full.add_argument(
        "--show-route",
        action="store_true",
        help="Print the selected route (introduction/project_explaination/code/scenario/qa) before the answer.",
    )
    p_full.add_argument(
        "--no-timing",
        action="store_true",
        help="Disable timing output (enabled by default).",
    )

    p_chat = sub.add_parser("chat", help="Interactive loop: type questions and see the route + answer.")
    p_chat.add_argument(
        "--files",
        nargs="+",
        default=None,
        help="Optional .pdf/.docx paths for knowledge-base intro questions.",
    )
    p_chat.add_argument("--top-k", type=int, default=None, help="Number of chunks to retrieve.")
    p_chat.add_argument(
        "--no-timing",
        action="store_true",
        help="Disable timing output (enabled by default).",
    )

    return parser.parse_args(argv)


def _timing_start() -> float:
    return time.perf_counter()


def _timing_line(start_perf: float) -> str:
    elapsed_s = time.perf_counter() - start_perf
    minutes = int(elapsed_s // 60)
    seconds = elapsed_s - (minutes * 60)
    if minutes > 0:
        return f"[timing] {minutes}m {seconds:05.2f}s"
    return f"[timing] {seconds:.2f}s"


def _invoke_capture(graph, state: dict, *, show_route: bool) -> dict:
    """
    Run the graph while optionally printing the selected route as soon as it's known.
    Returns the final state.
    """
    printed_route = False
    final_state: dict | None = None

    for snapshot in graph.stream(state, stream_mode="values"):
        if not isinstance(snapshot, dict):
            continue
        final_state = snapshot
        if show_route and not printed_route:
            route = snapshot.get("route")
            if isinstance(route, str) and route.strip():
                print(f"[route] {route.strip()}")
                printed_route = True

    return final_state or {}


def _trim_history(messages: list[dict[str, str]] | None, *, max_turns: int = 2) -> list[dict[str, str]]:
    """
    Keep only the last `max_turns` user+assistant exchanges (2 turns => up to 4 messages).
    Accepts/returns OpenAI chat-style message dicts: {"role": "...", "content": "..."}.
    """
    if not messages:
        return []
    max_items = max(0, int(max_turns)) * 2
    if max_items <= 0:
        return []
    cleaned: list[dict[str, str]] = []
    for m in messages:
        if not isinstance(m, dict):
            continue
        role = str(m.get("role") or "").strip().lower()
        content = str(m.get("content") or "").strip()
        if role not in {"user", "assistant"} or not content:
            continue
        cleaned.append({"role": role, "content": content})
    return cleaned[-max_items:]


def main(argv: list[str] | None = None) -> int:
    _bootstrap_imports()
    cli_args = list(argv or sys.argv[1:])
    # Default command when running: python run.py
    if not cli_args:
        cli_args = [
            "run",
            "--files",
            "./Venkatesh_Updated_CV.pdf"
        ]
    args = _parse_args(cli_args)

    if args.cmd == "ingest":
        from interview_langgraph.nodes.ingest import ingest_documents

        result = ingest_documents({"files": args.files})
        print(json.dumps(result, indent=2))
        return 0

    if args.cmd == "ask":
        from interview_langgraph.graph_connect.builder import build_graph
        from cli_history import load_history, save_history

        graph = build_graph()
        history = load_history(max_turns=2)
        state = {"query": args.query, "history": history}
        if args.top_k is not None:
            state["top_k"] = args.top_k
        start = _timing_start() if not args.no_timing else None
        try:
            result = _invoke_capture(graph, state, show_route=args.show_route)
            if not result.get("streamed"):
                print((result.get("answer") or "").strip())
            answer_text = str(result.get("answer") or "").strip()
            if answer_text:
                history.append({"role": "user", "content": args.query})
                history.append({"role": "assistant", "content": answer_text})
                save_history(history, max_turns=2)
            return 0
        except Exception as exc:
            print(str(exc).strip() or repr(exc))
            return 1
        finally:
            if start is not None:
                print(_timing_line(start))

    if args.cmd == "run":
        from interview_langgraph.graph_connect.builder import build_graph
        from cli_history import load_history, save_history

        graph = build_graph()
        base_state: dict = {"files": args.files}
        if args.top_k is not None:
            base_state["top_k"] = args.top_k

        # If query is omitted, enter a while-loop and ask for queries interactively.
        if args.query is None:
            # Warm up by ensuring ingestion happens once (if index isn't built yet).
            # This invocation uses an empty query so the router won't run.
            setup_start = _timing_start() if not args.no_timing else None
            try:
                _invoke_capture(graph, {**base_state, "query": ""}, show_route=False)
                if setup_start is not None:
                    print(_timing_line(setup_start))
            except Exception as exc:
                print(str(exc).strip() or repr(exc))
                if setup_start is not None:
                    print(_timing_line(setup_start))
                return 1

            print("Type your question. Type 'exit' to quit.")
            history: list[dict[str, str]] = load_history(max_turns=2)
            while True:
                query = input("You> ").strip()
                if not query or query.lower() in {"exit", "quit"}:
                    break
                start = _timing_start() if not args.no_timing else None
                try:
                    state = {**base_state, "query": query, "history": _trim_history(history)}
                    result = _invoke_capture(graph, state, show_route=True)
                    if not result.get("streamed"):
                        print((result.get("answer") or "").strip())
                    answer_text = str(result.get("answer") or "").strip()
                    if answer_text:
                        history.append({"role": "user", "content": query})
                        history.append({"role": "assistant", "content": answer_text})
                        save_history(history, max_turns=2)
                except Exception as exc:
                    print(str(exc).strip() or repr(exc))
                finally:
                    if start is not None:
                        print(_timing_line(start))
            return 0

        # One-shot mode.
        state = {**base_state, "query": args.query}
        history = load_history(max_turns=2)
        if history:
            state["history"] = history
        start = _timing_start() if not args.no_timing else None
        try:
            result = _invoke_capture(graph, state, show_route=args.show_route)
            if not result.get("streamed"):
                print((result.get("answer") or "").strip())
            answer_text = str(result.get("answer") or "").strip()
            if answer_text:
                history.append({"role": "user", "content": args.query})
                history.append({"role": "assistant", "content": answer_text})
                save_history(history, max_turns=2)
            return 0
        except Exception as exc:
            print(str(exc).strip() or repr(exc))
            return 1
        finally:
            if start is not None:
                print(_timing_line(start))

    if args.cmd == "chat":
        from interview_langgraph.graph_connect.builder import build_graph
        from cli_history import load_history, save_history

        graph = build_graph()
        files = args.files or []
        base_state: dict = {"files": files} if files else {}
        if args.top_k is not None:
            base_state["top_k"] = args.top_k

        print("Type your question. Type 'exit' to quit.")
        history: list[dict[str, str]] = load_history(max_turns=2)
        while True:
            query = input("You> ").strip()
            if not query or query.lower() in {"exit", "quit"}:
                break

            state = dict(base_state)
            state["query"] = query
            state["history"] = _trim_history(history)
            start = _timing_start() if not args.no_timing else None
            try:
                result = _invoke_capture(graph, state, show_route=True)
                if not result.get("streamed"):
                    print((result.get("answer") or "").strip())
                answer_text = str(result.get("answer") or "").strip()
                if answer_text:
                    history.append({"role": "user", "content": query})
                    history.append({"role": "assistant", "content": answer_text})
                    save_history(history, max_turns=2)
            except Exception as exc:
                print(str(exc).strip() or repr(exc))
            finally:
                if start is not None:
                    print(_timing_line(start))
        return 0

    raise SystemExit(f"Unknown command: {args.cmd}")


if __name__ == "__main__":
    raise SystemExit(main())
