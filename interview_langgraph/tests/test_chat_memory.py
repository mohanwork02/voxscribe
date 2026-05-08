import unittest


class TestChatMemory(unittest.TestCase):
    def test_coerce_history_trims_to_two_turns(self) -> None:
        from memory import coerce_history

        history = [
            {"role": "user", "content": "u1"},
            {"role": "assistant", "content": "a1"},
            {"role": "user", "content": "u2"},
            {"role": "assistant", "content": "a2"},
            {"role": "user", "content": "u3"},
            {"role": "assistant", "content": "a3"},
        ]
        self.assertEqual(
            coerce_history(history, max_turns=2),
            [
                {"role": "user", "content": "u2"},
                {"role": "assistant", "content": "a2"},
                {"role": "user", "content": "u3"},
                {"role": "assistant", "content": "a3"},
            ],
        )

    def test_coerce_history_filters_invalid_items(self) -> None:
        from memory import coerce_history

        history = [
            {"role": "system", "content": "nope"},
            {"role": "user", "content": ""},
            {"role": "assistant", "content": " ok "},
            "not a dict",
            {"role": "user", "content": "hi"},
        ]
        self.assertEqual(
            coerce_history(history, max_turns=2),
            [
                {"role": "assistant", "content": "ok"},
                {"role": "user", "content": "hi"},
            ],
        )


if __name__ == "__main__":
    unittest.main()
