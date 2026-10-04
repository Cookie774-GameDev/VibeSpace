"""Portable text-format and explicit device-policy regressions (no GPU needed)."""
import unittest
from types import SimpleNamespace

import worker


class Tokenizer:
    chat_template = "supported"

    def apply_chat_template(self, messages, tokenize=False, add_generation_prompt=False):
        text = "".join(f"<{m['role']}>{m['content']}" for m in messages)
        return text + ("<assistant>" if add_generation_prompt else "<end>")

    def __call__(self, text, truncation=True, max_length=512, **kwargs):
        ids = list(text.encode())[:max_length]
        return {"input_ids": ids, "attention_mask": [1] * len(ids)}


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


if __name__ == "__main__":
    unittest.main()
