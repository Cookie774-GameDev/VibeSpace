"""Focused tests for the canonical Model Foundry worker's bounded helpers.

Stdlib-only: exercises the pure label-masking and record-shaping helpers
without requiring torch/transformers to be installed.
"""

from __future__ import annotations

import importlib.util
import unittest
from pathlib import Path

WORKER_PATH = Path(__file__).resolve().parent / "worker.py"


def load_worker():
    spec = importlib.util.spec_from_file_location("vibespace_foundry_worker", WORKER_PATH)
    module = importlib.util.module_from_spec(spec)
    assert spec is not None and spec.loader is not None
    spec.loader.exec_module(module)
    return module


class CompletionOnlyLabelsTests(unittest.TestCase):
    def setUp(self):
        self.worker = load_worker()

    def test_masks_prompt_tokens_with_ignore_index(self):
        labels = self.worker.completion_only_labels([10, 11, 12, 13, 14], 3)
        self.assertEqual(labels, [-100, -100, -100, 13, 14])

    def test_never_masks_more_tokens_than_present(self):
        labels = self.worker.completion_only_labels([10, 11], 99)
        self.assertEqual(labels, [-100, -100])

    def test_zero_or_negative_prompt_count_keeps_all_tokens(self):
        self.assertEqual(self.worker.completion_only_labels([1, 2, 3], 0), [1, 2, 3])
        self.assertEqual(self.worker.completion_only_labels([1, 2, 3], -4), [1, 2, 3])

    def test_empty_record_returns_empty_labels(self):
        self.assertEqual(self.worker.completion_only_labels([], 5), [])


class ExampleShapingTests(unittest.TestCase):
    def setUp(self):
        self.worker = load_worker()

    def test_prompt_response_records_build_user_assistant_text(self):
        record = {"prompt": "  Say hi  ", "response": " Hello. "}
        self.assertEqual(
            self.worker._example_text(record),
            "User: Say hi\nAssistant: Hello.",
        )
        self.assertEqual(self.worker._example_prompt_prefix(record), "User: Say hi\nAssistant: ")

    def test_plain_text_records_skip_prompt_masking(self):
        record = {"text": "  A plain note.  "}
        self.assertEqual(self.worker._example_text(record), "A plain note.")
        self.assertEqual(self.worker._example_prompt_prefix(record), "")


if __name__ == "__main__":
    unittest.main()
