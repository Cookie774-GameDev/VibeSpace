"""Pure input-budget regressions. No model, GPU, network, or app invocation."""
import contextlib
import io
import json
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import worker


class Vector(list):
    @property
    def shape(self):
        return (len(self),)

    def __getitem__(self, item):
        result = super().__getitem__(item)
        return Vector(result) if isinstance(item, slice) else result


class Tensor:
    def __init__(self, ids):
        self.ids = Vector(ids)
        self.shape = (1, len(ids))

    def to(self, device):
        return self

    def __getitem__(self, item):
        if item != 0:
            raise AssertionError("Only the single synthetic batch is supported")
        return self.ids


class ExactTokenizer:
    chat_template = "synthetic-role-template"
    pad_token_id = 0
    eos_token_id = 1
    truncation_side = "right"

    def __init__(self):
        self.calls = []

    def apply_chat_template(self, messages, tokenize=False, add_generation_prompt=False):
        return "".join(f"<{m['role']}>{m['content']}" for m in messages) + ("<assistant>" if add_generation_prompt else "")

    def __call__(self, text, **kwargs):
        self.calls.append((text, dict(kwargs)))
        ids = list(text.encode("utf-8"))
        if kwargs.get("add_special_tokens", True):
            ids = [0] + ids
        if kwargs.get("truncation"):
            ids = ids[:kwargs["max_length"]]
        return {"input_ids": Tensor(ids), "attention_mask": Tensor([1] * len(ids))}

    def decode(self, ids, **kwargs):
        return bytes(ids).decode("utf-8")


class ExactProcessor:
    def __init__(self, tokenizer):
        self.tokenizer = tokenizer
        self.calls = []

    def __call__(self, **kwargs):
        self.calls.append(dict(kwargs))
        text = kwargs.pop("text")
        self.assert_no_images(kwargs.pop("images"))
        return self.tokenizer(text, **kwargs)

    @staticmethod
    def assert_no_images(value):
        if value is not None:
            raise AssertionError("This boundary preserves the existing text-only processor route")


class InferenceBudgetTests(unittest.TestCase):
    def test_overflow_never_silently_loses_current_user_behind_system_prefix(self):
        tokenizer = ExactTokenizer()
        messages = [{"role": "system", "content": "REQUIRED " * 30},
                    {"role": "user", "content": "LATEST_PUBLIC_REQUEST_CL_041"}]
        prompt = tokenizer.apply_chat_template(messages, add_generation_prompt=True)
        with self.assertRaisesRegex(ValueError, "input.*budget|context.*overflow"):
            worker._encode_inference_prompt(tokenizer, None, prompt, 128)
        self.assertFalse(tokenizer.calls[-1][1]["truncation"])
        self.assertEqual(tokenizer.calls[-1][0], prompt)

    def test_exact_boundary_preserves_all_roles_content_and_generation_marker(self):
        tokenizer = ExactTokenizer()
        messages = [{"role": "system", "content": "POLICY"}, {"role": "user", "content": "old"},
                    {"role": "assistant", "content": "previous"}, {"role": "user", "content": "LATEST"}]
        prompt = tokenizer.apply_chat_template(messages, add_generation_prompt=True)
        encoded = worker._encode_inference_prompt(tokenizer, None, prompt, len(prompt.encode()))
        self.assertEqual(bytes(encoded["input_ids"][0]).decode(), prompt)
        self.assertFalse(tokenizer.calls[-1][1]["truncation"])
        self.assertFalse(tokenizer.calls[-1][1]["add_special_tokens"])

    def test_processor_route_refuses_the_same_overflow_without_losing_input(self):
        tokenizer = ExactTokenizer()
        processor = ExactProcessor(tokenizer)
        prompt = "<system>POLICY<user>" + "public data " * 20 + "LATEST<assistant>"
        with self.assertRaisesRegex(ValueError, "input.*budget|context.*overflow"):
            worker._encode_inference_prompt(tokenizer, processor, prompt, 64)
        self.assertEqual(processor.calls[0]["text"], prompt)
        self.assertFalse(processor.calls[0]["truncation"])
        self.assertFalse(processor.calls[0]["add_special_tokens"])

    def test_legacy_special_tokens_are_included_in_the_exact_budget(self):
        tokenizer = ExactTokenizer()
        tokenizer.chat_template = None
        with self.assertRaisesRegex(ValueError, "input.*budget|context.*overflow"):
            worker._encode_inference_prompt(tokenizer, None, "abc", 3)
        encoded = worker._encode_inference_prompt(tokenizer, None, "abc", 4)
        self.assertEqual(encoded["input_ids"][0], [0, 97, 98, 99])

    def test_multibyte_text_is_measured_as_actual_tokens_not_characters(self):
        tokenizer = ExactTokenizer()
        prompt = "é🙂"
        self.assertEqual(len(prompt), 2)
        with self.assertRaisesRegex(ValueError, "input.*budget|context.*overflow"):
            worker._encode_inference_prompt(tokenizer, None, prompt, 5)
        self.assertEqual(worker._encode_inference_prompt(tokenizer, None, prompt, 6)["input_ids"].shape, (1, 6))

    def test_main_emits_only_allowlisted_overflow_counts_without_prompt_text(self):
        tokenizer = ExactTokenizer()
        prompt = "PRIVATE_SYNTHETIC_CONTENT " * 12
        def overflowing_infer(_path):
            worker._encode_inference_prompt(tokenizer, None, prompt, 32)
            return 0
        stdout, stderr = io.StringIO(), io.StringIO()
        with patch.object(worker, "infer", side_effect=overflowing_infer), patch.object(
            worker.sys, "argv", ["worker.py", "infer", "synthetic-request"]
        ), contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            self.assertEqual(worker.main(), 2)
        diagnostic = json.loads(stdout.getvalue())
        self.assertEqual(diagnostic, {"protocol": 1, "localOnly": True, "valid": False,
            "errorCode": "input_context_overflow", "inputTokens": len(prompt.encode()), "inputTokenBudget": 32})
        self.assertEqual(stderr.getvalue(), "")
        self.assertNotIn("PRIVATE_SYNTHETIC_CONTENT", stdout.getvalue())

    def test_other_worker_errors_do_not_claim_input_overflow(self):
        stdout, stderr = io.StringIO(), io.StringIO()
        with patch.object(worker, "infer", side_effect=ValueError("synthetic ordinary failure")), patch.object(
            worker.sys, "argv", ["worker.py", "infer", "synthetic-request"]
        ), contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            self.assertEqual(worker.main(), 2)
        self.assertEqual(stdout.getvalue(), "")
        self.assertNotIn("errorCode", json.loads(stderr.getvalue()))

    def infer_case(self, prompt_size, expect_overflow):
        tokenizer = ExactTokenizer()
        generated = []
        model = SimpleNamespace(config=SimpleNamespace(max_position_embeddings=256),
            to=lambda device: None, parameters=lambda: iter([SimpleNamespace(device="cpu", numel=lambda: 1)]),
            eval=lambda: None)
        def generate(**kwargs):
            generated.append(kwargs)
            return Tensor(list(kwargs["input_ids"][0]) + list(b"synthetic reply"))
        model.generate = generate
        fake_transformers = SimpleNamespace(
            AutoTokenizer=SimpleNamespace(from_pretrained=lambda *args, **kwargs: tokenizer),
            AutoProcessor=SimpleNamespace(from_pretrained=lambda *args, **kwargs: None),
            AutoModelForCausalLM=SimpleNamespace(from_pretrained=lambda *args, **kwargs: model),
            AutoModelForImageTextToText=SimpleNamespace(from_pretrained=lambda *args, **kwargs: model))
        fake_torch = SimpleNamespace(cuda=SimpleNamespace(is_available=lambda: False), inference_mode=contextlib.nullcontext)
        with tempfile.TemporaryDirectory() as directory:
            response = Path(directory) / "response.json"
            request = {"baseModelPath": directory, "artifactPath": directory, "method": "full",
                "modelModalities": ["text"], "trainingMetadata": {"requestedConfig": {"computeDevice": "cpu"}},
                "messages": [{"role": "system", "content": "POLICY " * prompt_size},
                             {"role": "user", "content": "LATEST_PUBLIC_REQUEST"}],
                "maxOutputTokens": 64, "responsePath": str(response)}
            with patch.object(worker, "_read_inference_request", return_value=request), patch.dict(sys.modules, {"torch": fake_torch, "transformers": fake_transformers}):
                if expect_overflow:
                    with self.assertRaisesRegex(ValueError, "input.*budget|context.*overflow"):
                        worker.infer("synthetic-request")
                    self.assertEqual(generated, [])
                    self.assertFalse(response.exists())
                else:
                    self.assertEqual(worker.infer("synthetic-request"), 0)
                    self.assertEqual(len(generated), 1)
                    self.assertEqual(generated[0]["max_new_tokens"], 64)
                    actual = bytes(generated[0]["input_ids"][0]).decode()
                    self.assertIn("<system>POLICY", actual)
                    self.assertTrue(actual.endswith("<user>LATEST_PUBLIC_REQUEST<assistant>"))
                    self.assertEqual(json.loads(response.read_text())["text"], "synthetic reply")

    def test_actual_infer_never_generates_a_response_from_an_overflowed_prompt(self):
        self.infer_case(prompt_size=40, expect_overflow=True)

    def test_actual_infer_still_generates_once_when_complete_prompt_fits(self):
        self.infer_case(prompt_size=1, expect_overflow=False)


if __name__ == "__main__":
    unittest.main()
