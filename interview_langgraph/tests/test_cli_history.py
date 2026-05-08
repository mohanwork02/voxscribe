import json
import tempfile
import unittest
from pathlib import Path


class TestCliHistory(unittest.TestCase):
    def setUp(self) -> None:
        import smart_input_llm as s

        self.s = s
        self.tmpdir = Path(tempfile.mkdtemp(prefix="cli_hist_test_"))

        self._orig = {
            "OUTPUT_DIR": s.OUTPUT_DIR,
        }

        s.OUTPUT_DIR = self.tmpdir

    def tearDown(self) -> None:
        s = self.s
        for k, v in self._orig.items():
            setattr(s, k, v)
        try:
            for child in self.tmpdir.glob("*"):
                child.unlink(missing_ok=True)
            self.tmpdir.rmdir()
        except Exception:
            pass

    def test_load_save_roundtrip(self) -> None:
        import cli_history

        # Patch module-level HISTORY_FILE to point at the temp OUTPUT_DIR
        cli_history.HISTORY_FILE = self.tmpdir / "chat_history.json"

        cli_history.save_history(
            [
                {"role": "user", "content": "u1"},
                {"role": "assistant", "content": "a1"},
                {"role": "user", "content": "u2"},
                {"role": "assistant", "content": "a2"},
                {"role": "user", "content": "u3"},
                {"role": "assistant", "content": "a3"},
            ],
            max_turns=2,
        )

        loaded = cli_history.load_history(max_turns=2)
        self.assertEqual(
            loaded,
            [
                {"role": "user", "content": "u2"},
                {"role": "assistant", "content": "a2"},
                {"role": "user", "content": "u3"},
                {"role": "assistant", "content": "a3"},
            ],
        )

        # Ensure file is valid JSON list
        data = json.loads((self.tmpdir / "chat_history.json").read_text(encoding="utf-8"))
        self.assertIsInstance(data, list)


if __name__ == "__main__":
    unittest.main()

