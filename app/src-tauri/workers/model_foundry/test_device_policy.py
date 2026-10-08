"""Portable text-format and explicit device-policy regressions (no GPU needed)."""
import unittest
import json
import shutil
import tempfile
from pathlib import Path
from types import SimpleNamespace

import worker


class InputIds(list):
    # The production inference helper requests one tensor batch. Retain list
    # operations for the pure training-label assertions while exposing its shape.
    @property
    def shape(self):
        return (1, len(self))


class Tokenizer:
    chat_template = "supported"

    def apply_chat_template(self, messages, tokenize=False, add_generation_prompt=False):
        text = "".join(f"<{m['role']}>{m['content']}" for m in messages)
        return text + ("<assistant>" if add_generation_prompt else "<end>")

    def __call__(self, text, truncation=True, max_length=512, **kwargs):
        ids = list(text.encode())
        if truncation:
            ids = ids[:max_length]
        return {"input_ids": InputIds(ids), "attention_mask": [1] * len(ids)}


class TextTrainingTests(unittest.TestCase):
    def test_inference_chat_tokens_match_training_prefix_without_duplicate_special_tokens(self):
        class SpecialTokenizer(Tokenizer):
            def __call__(self, text, **kwargs):
                encoded = super().__call__(text, **kwargs)
                if kwargs.get("add_special_tokens", True):
                    encoded["input_ids"].insert(0, 0)
                return encoded

        tokenizer = SpecialTokenizer()
        prompt = tokenizer.apply_chat_template(
            [{"role": "user", "content": "claim"}], add_generation_prompt=True
        )
        training = worker._tokenize_training_text(tokenizer, {"prompt": "claim", "response": "reason"}, 512)
        for processor in (None, tokenizer):
            with self.subTest(processor=processor is not None):
                inference = worker._encode_inference_prompt(tokenizer, processor, prompt, 512)
                self.assertEqual(inference["input_ids"], training["input_ids"][:len(inference["input_ids"])])

    def test_inference_legacy_tokenizer_retains_special_token_defaults(self):
        class SpecialTokenizer(Tokenizer):
            chat_template = None

            def __call__(self, text, **kwargs):
                encoded = super().__call__(text, **kwargs)
                if kwargs.get("add_special_tokens", True):
                    encoded["input_ids"].insert(0, 0)
                return encoded

        encoded = worker._encode_inference_prompt(SpecialTokenizer(), None, "User: claim", 512)
        self.assertEqual(encoded["input_ids"], [0] + list(b"User: claim"))

    def test_chat_training_uses_same_template_as_inference_and_masks_prompt(self):
        encoded = worker._tokenize_training_text(Tokenizer(), {"prompt": "claim", "response": "reason"}, 512)
        prefix = len("<user>claim<assistant>")
        self.assertEqual(bytes(encoded["input_ids"]).decode(), "<user>claim<assistant>reason<end>")
        self.assertEqual(encoded["labels"][:prefix], [-100] * prefix)
        self.assertEqual(encoded["labels"][prefix:], encoded["input_ids"][prefix:])

    def test_plain_text_still_trains_every_nonpad_token(self):
        encoded = worker._tokenize_training_text(Tokenizer(), {"text": "disposable debate lesson"}, 512)
        self.assertEqual(encoded["labels"], encoded["input_ids"])

    def test_truncation_of_entire_completion_fails_before_training(self):
        with self.assertRaisesRegex(ValueError, "completion.*maxSequenceLength"):
            worker._tokenize_training_text(Tokenizer(), {"prompt": "long claim", "response": "reason"}, 5)

    def test_legacy_tokenizer_keeps_existing_user_assistant_format(self):
        tokenizer = Tokenizer()
        tokenizer.chat_template = None
        encoded = worker._tokenize_training_text(tokenizer, {"prompt": "claim", "response": "reason"}, 512)
        self.assertEqual(bytes(encoded["input_ids"]).decode(), "User: claim\nAssistant: reason")


class DevicePolicyTests(unittest.TestCase):
    def test_inference_preserves_explicit_gpu_even_without_cuda(self):
        torch = SimpleNamespace(cuda=SimpleNamespace(is_available=lambda: False))
        with self.assertRaisesRegex(ValueError, "GPU-only.*CUDA"):
            worker._inference_compute_device(torch, {"requestedConfig": {"computeDevice": "gpu"}})

    def test_cpu_artifact_stays_cpu_on_cuda_computer(self):
        torch = SimpleNamespace(cuda=SimpleNamespace(is_available=lambda: True))
        self.assertEqual(worker._inference_compute_device(torch, {"requestedConfig": {"computeDevice": "cpu"}}), "cpu")

    def test_legacy_artifact_keeps_automatic_device_selection(self):
        torch = SimpleNamespace(cuda=SimpleNamespace(is_available=lambda: True))
        self.assertEqual(worker._inference_compute_device(torch, {}), "gpu")

    def test_mixed_parameter_placement_is_rejected(self):
        model = SimpleNamespace(parameters=lambda: iter([SimpleNamespace(device="cuda:0"), SimpleNamespace(device="cpu")]))
        with self.assertRaisesRegex(ValueError, "cannot fall back or offload"):
            worker._assert_model_device(model, "gpu")

    def test_optimizer_moments_cannot_be_cpu_offloaded_for_gpu_training(self):
        tensor = SimpleNamespace(device="cpu", numel=lambda: 16)
        optimizer = SimpleNamespace(state={"parameter": {"exp_avg": tensor}})
        with self.assertRaisesRegex(ValueError, "optimizer.*offload"):
            worker._optimizer_device_evidence(optimizer, "gpu")

    def test_scalar_optimizer_step_counter_may_stay_on_host(self):
        moment = SimpleNamespace(device="cuda:0", numel=lambda: 16)
        step = SimpleNamespace(device="cpu", numel=lambda: 1)
        optimizer = SimpleNamespace(state={"parameter": {"exp_avg": moment, "step": step}})
        self.assertEqual(worker._optimizer_device_evidence(optimizer, "gpu"), ["cuda:0"])


class TrainingEvidenceTests(unittest.TestCase):
    def test_cpu_optimizer_moments_fail_before_final_model_and_tokenizer_save(self):
        saved = []
        trainer = SimpleNamespace(
            optimizer=SimpleNamespace(state={"parameter": {"exp_avg": SimpleNamespace(device="cpu", numel=lambda: 16)}}),
            train=lambda **kwargs: SimpleNamespace(metrics={"train_loss": 1.0}),
            evaluate=lambda: {"eval_loss": 1.1},
            save_model=lambda path: saved.append("model"),
        )
        tokenizer = SimpleNamespace(save_pretrained=lambda path: saved.append("tokenizer"))
        with self.assertRaisesRegex(ValueError, "optimizer.*offload"):
            worker._run_training_lifecycle(trainer, None, "unused-output", tokenizer, None, requested_device="gpu")
        self.assertEqual(saved, [])

    def test_nonfinite_evaluation_cannot_produce_completed_artifact(self):
        for loss in (float("nan"), float("inf"), -float("inf")):
            with self.subTest(loss=loss), self.assertRaisesRegex(ValueError, "finite"):
                worker._validate_training_metrics({"train_loss": 1.0}, {"eval_loss": loss})

    def test_missing_evaluation_loss_is_not_success(self):
        with self.assertRaisesRegex(ValueError, "eval_loss"):
            worker._validate_training_metrics({"train_loss": 1.0}, {})

    def test_finite_measured_losses_are_accepted(self):
        worker._validate_training_metrics({"train_loss": 1.2}, {"eval_loss": 1.1})


class ArtifactPortabilityTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.original = self.root / "original"
        self.original.mkdir()
        (self.original / "config.json").write_text("{}")
        (self.original / "model.safetensors").write_bytes(b"original weights")
        self.relocated = self.root / "relocated model"
        shutil.copytree(self.original, self.relocated)
        self.artifact = self.root / "weight-artifact"
        self.artifact.mkdir()

    def request(self, model, fingerprint=None):
        metadata = {"protocol": 1, "localOnly": True, "valid": True,
                    "method": "lora", "baseModelPath": str(self.original)}
        if fingerprint is not None:
            metadata["baseModelFingerprint"] = fingerprint
        (self.artifact / "vibespace-training.json").write_text(json.dumps(metadata))
        request = {"protocol": 1, "localOnly": True, "method": "lora",
                   "baseModelPath": str(model), "artifactPath": str(self.artifact),
                   "responsePath": str(self.root / "inference-test.response.json"),
                   "messages": [{"role": "user", "content": "Debate a proposal."}],
                   "maxOutputTokens": 64}
        path = self.root / "request.json"
        path.write_text(json.dumps(request))
        return worker._read_inference_request(str(path))

    def test_identical_model_can_relocate_after_original_path_disappears(self):
        fingerprint = worker._base_model_fingerprint(self.original)
        for path in self.original.iterdir():
            path.unlink()
        self.original.rmdir()
        self.assertEqual(self.request(self.relocated, fingerprint)["baseModelPath"], str(self.relocated.resolve()))

    def test_relocated_weights_must_match_training_content(self):
        fingerprint = worker._base_model_fingerprint(self.original)
        (self.relocated / "model.safetensors").write_bytes(b"different weights")
        with self.assertRaisesRegex(ValueError, "fingerprint"):
            self.request(self.relocated, fingerprint)

    def test_same_path_model_replacement_is_rejected(self):
        fingerprint = worker._base_model_fingerprint(self.original)
        (self.original / "config.json").write_text('{"changed":true}')
        with self.assertRaisesRegex(ValueError, "fingerprint"):
            self.request(self.original, fingerprint)

    def test_extra_or_missing_model_file_is_rejected(self):
        fingerprint = worker._base_model_fingerprint(self.original)
        extra = self.relocated / "tokenizer.json"
        extra.write_text("{}")
        with self.assertRaisesRegex(ValueError, "fingerprint"):
            self.request(self.relocated, fingerprint)
        extra.unlink()
        (self.relocated / "model.safetensors").unlink()
        with self.assertRaisesRegex(ValueError, "fingerprint"):
            self.request(self.relocated, fingerprint)

    def test_catalog_marker_location_metadata_is_not_model_content(self):
        (self.original / ".vibespace-model.json").write_text('{"location":"old"}')
        (self.relocated / ".vibespace-model.json").write_text('{"location":"new"}')
        self.assertEqual(worker._base_model_fingerprint(self.original), worker._base_model_fingerprint(self.relocated))

    def test_invalid_fingerprint_never_falls_back_to_matching_path(self):
        with self.assertRaisesRegex(ValueError, "fingerprint"):
            self.request(self.original, {"algorithm": "sha256", "fileCount": True, "sha256": "0" * 64})

    def test_legacy_artifact_keeps_original_path_requirement(self):
        self.assertEqual(self.request(self.original)["baseModelPath"], str(self.original.resolve()))
        with self.assertRaisesRegex(ValueError, "metadata.*match"):
            self.request(self.relocated)


if __name__ == "__main__":
    unittest.main()
