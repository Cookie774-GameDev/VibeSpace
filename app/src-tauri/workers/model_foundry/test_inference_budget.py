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

    def infer_case(self, prompt_size, expect_overflow, *, method="full", config=None,
                   loaded_config=None, adapter_config=None, expected_context_error=False,
                   expect_preweight=False, require_config_identity=False, multimodal=False, mutate_config=False):
        tokenizer = ExactTokenizer()
        generated, model_loads, adapter_loads, config_loads = [], [], [], []
        config = SimpleNamespace(max_position_embeddings=256) if config is None else config
        compute_device = "gpu" if method == "qlora" else "cpu"
        device = "cuda:0" if compute_device == "gpu" else "cpu"
        model = SimpleNamespace(config=config, to=lambda device: None,
            parameters=lambda: iter([SimpleNamespace(device=device, numel=lambda: 1)]), eval=lambda: None)
        def generate(**kwargs):
            generated.append(kwargs)
            return Tensor(list(kwargs["input_ids"][0]) + list(b"synthetic reply"))
        model.generate = generate
        def load_config(source, **kwargs):
            config_loads.append((source, dict(kwargs)))
            return config
        def load_model(source, **kwargs):
            model_loads.append((source, dict(kwargs), len(tokenizer.calls)))
            if mutate_config:
                config.max_position_embeddings = 512
            if loaded_config is not None:
                model.config = loaded_config
            return model
        def load_adapter(base, source, **kwargs):
            self.assertIs(base, model)
            adapter_loads.append((source, dict(kwargs)))
            if adapter_config is not None:
                model.config = adapter_config
            return model
        fake_transformers = SimpleNamespace(
            AutoConfig=SimpleNamespace(from_pretrained=load_config),
            AutoTokenizer=SimpleNamespace(from_pretrained=lambda *args, **kwargs: tokenizer),
            AutoProcessor=SimpleNamespace(from_pretrained=lambda *args, **kwargs: ExactProcessor(tokenizer)),
            AutoModelForCausalLM=SimpleNamespace(from_pretrained=load_model),
            AutoModelForImageTextToText=SimpleNamespace(from_pretrained=load_model))
        fake_torch = SimpleNamespace(cuda=SimpleNamespace(is_available=lambda: compute_device == "gpu"), inference_mode=contextlib.nullcontext)
        fake_peft = SimpleNamespace(PeftModel=SimpleNamespace(from_pretrained=load_adapter))
        with tempfile.TemporaryDirectory() as directory:
            response = Path(directory) / "response.json"
            base_path, artifact_path = str(Path(directory) / "base"), str(Path(directory) / "artifact")
            request = {"baseModelPath": base_path, "artifactPath": artifact_path, "method": method,
                "modelModalities": ["text", "image"] if multimodal else ["text"], "trainingMetadata": {"requestedConfig": {"computeDevice": compute_device}},
                "messages": [{"role": "system", "content": "POLICY " * prompt_size},
                             {"role": "user", "content": "LATEST_PUBLIC_REQUEST"}],
                "maxOutputTokens": 64, "responsePath": str(response)}
            with patch.object(worker, "_read_inference_request", return_value=request), patch.dict(
                sys.modules, {"torch": fake_torch, "transformers": fake_transformers, "peft": fake_peft}
            ):
                if expect_overflow or expected_context_error:
                    expression = "context" if expected_context_error else "input.*budget|context.*overflow"
                    with self.assertRaisesRegex(ValueError, expression) as raised:
                        worker.infer("synthetic-request")
                    self.assertEqual(generated, [])
                    self.assertFalse(response.exists())
                    if expect_preweight:
                        self.assertEqual(model_loads, [])
                        self.assertEqual(adapter_loads, [])
                    failure = raised.exception
                else:
                    self.assertEqual(worker.infer("synthetic-request"), 0)
                    self.assertEqual(len(generated), 1)
                    self.assertEqual(generated[0]["max_new_tokens"], 64)
                    actual = bytes(generated[0]["input_ids"][0]).decode()
                    self.assertEqual(actual, tokenizer.apply_chat_template(request["messages"], add_generation_prompt=True))
                    self.assertEqual(json.loads(response.read_text())["text"], "synthetic reply")
                    failure = None
                    if require_config_identity:
                        self.assertEqual(len(config_loads), 1)
                        self.assertEqual(len(model_loads), 1)
                        expected_source = artifact_path if method == "full" else base_path
                        self.assertEqual(config_loads[0], (expected_source, {"local_files_only": True, "trust_remote_code": False}))
                        self.assertEqual(model_loads[0][0], expected_source)
                        self.assertIs(model_loads[0][1].get("config"), config)
                        self.assertEqual(model_loads[0][2], 1)
                        self.assertEqual(len(tokenizer.calls), 1)
                        self.assertEqual(model_loads[0][1], {"config": config, "local_files_only": True,
                            "trust_remote_code": False, "torch_dtype": "auto", "low_cpu_mem_usage": True,
                            "device_map": {"": 0 if compute_device == "gpu" else "cpu"}})
                        if method in ("lora", "qlora"):
                            self.assertEqual(adapter_loads, [(artifact_path, {"is_trainable": False, "local_files_only": True})])
                        else:
                            self.assertEqual(adapter_loads, [])
            return {"failure": failure, "model_loads": model_loads, "adapter_loads": adapter_loads,
                    "config_loads": config_loads, "tokenizer_calls": tokenizer.calls}

    def test_preweight_overflow_constructs_no_model_or_adapter_for_any_method(self):
        for method in ("full", "lora", "qlora"):
            with self.subTest(method=method):
                self.infer_case(40, True, method=method, expect_preweight=True)

    def test_fitting_input_passes_exact_counted_config_and_original_loader_contract(self):
        for method in ("full", "lora", "qlora"):
            with self.subTest(method=method):
                self.infer_case(1, False, method=method, require_config_identity=True)

    def test_changed_loaded_limit_refuses_before_generate_without_reencoding(self):
        result = self.infer_case(1, False, loaded_config=SimpleNamespace(max_position_embeddings=512), expected_context_error=True)
        self.assertEqual(len(result["model_loads"]), 1)
        self.assertEqual(len(result["tokenizer_calls"]), 1)

    def test_adapter_changed_limit_is_checked_after_attachment_before_generate(self):
        result = self.infer_case(1, False, method="lora", adapter_config=SimpleNamespace(max_position_embeddings=512), expected_context_error=True)
        self.assertEqual(len(result["adapter_loads"]), 1)
        self.assertEqual(len(result["tokenizer_calls"]), 1)

    def test_missing_or_invalid_limits_are_not_invented_before_model_loading(self):
        values = [SimpleNamespace(), *[SimpleNamespace(max_position_embeddings=value)
                  for value in (None, True, False, 0, -1, "8192", 1.5, float("nan"), float("inf"), 1)]]
        for config in values:
            with self.subTest(config=config):
                self.infer_case(1, False, config=config, expected_context_error=True, expect_preweight=True)

    def test_small_declared_limit_is_not_silently_inflated_to_256(self):
        result = self.infer_case(40, True, config=SimpleNamespace(max_position_embeddings=128), expect_preweight=True)
        self.assertEqual(result["failure"].input_token_budget, 64)

    def test_upper_cap_remains_16384_and_equivalent_loaded_cap_is_accepted(self):
        self.infer_case(1, False, config=SimpleNamespace(max_position_embeddings=32768),
                        loaded_config=SimpleNamespace(max_position_embeddings=20000), require_config_identity=True)
        result = self.infer_case(2400, True, config=SimpleNamespace(max_position_embeddings=32768), expect_preweight=True)
        self.assertEqual(result["failure"].input_token_budget, 16320)

    def test_in_place_config_mutation_cannot_change_the_admitted_budget(self):
        result = self.infer_case(1, False, mutate_config=True, expected_context_error=True)
        self.assertEqual(len(result["tokenizer_calls"]), 1)

    def test_multimodal_nested_text_limit_is_explicit_and_passed_unchanged(self):
        nested = SimpleNamespace(text_config=SimpleNamespace(max_position_embeddings=256))
        self.infer_case(1, False, config=nested, multimodal=True, require_config_identity=True)

    def test_multimodal_conflicting_or_invalid_limits_do_not_guess(self):
        for config in [SimpleNamespace(max_position_embeddings=256, text_config=SimpleNamespace(max_position_embeddings=128)),
                       SimpleNamespace(text_config=SimpleNamespace(max_position_embeddings=True)),
                       SimpleNamespace(max_position_embeddings=False, text_config=SimpleNamespace(max_position_embeddings=256))]:
            with self.subTest(config=config):
                self.infer_case(1, False, config=config, multimodal=True, expected_context_error=True, expect_preweight=True)

    def test_text_model_cannot_borrow_an_unadvertised_nested_limit(self):
        self.infer_case(1, False, config=SimpleNamespace(text_config=SimpleNamespace(max_position_embeddings=256)),
                        expected_context_error=True, expect_preweight=True)

    def test_actual_infer_never_generates_a_response_from_an_overflowed_prompt(self):
        self.infer_case(prompt_size=40, expect_overflow=True)

    def test_actual_infer_still_generates_once_when_complete_prompt_fits(self):
        self.infer_case(prompt_size=1, expect_overflow=False)


if __name__ == "__main__":
    unittest.main()
