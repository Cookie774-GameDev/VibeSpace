"""Focused tests for the canonical Model Foundry worker's bounded helpers.

Stdlib-only: exercises the pure label-masking and record-shaping helpers
without requiring torch/transformers to be installed.
"""

from __future__ import annotations

import importlib.util
import contextlib
import io
import json
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

WORKER_PATH = Path(__file__).resolve().parent / "worker.py"


def load_worker():
    spec = importlib.util.spec_from_file_location("vibespace_foundry_worker", WORKER_PATH)
    module = importlib.util.module_from_spec(spec)
    assert spec is not None and spec.loader is not None
    spec.loader.exec_module(module)
    return module


class OptionalProbeTests(unittest.TestCase):
    def setUp(self):
        self.worker = load_worker()

    def test_optional_probe_timeout_fails_closed(self):
        timeout = subprocess.TimeoutExpired(["python", "-c", "probe"], 20)
        with patch.object(self.worker.subprocess, "run", side_effect=timeout):
            self.assertFalse(self.worker._optional_probe("raise SystemExit(0)"))

    def test_optional_probe_nonzero_fails_closed(self):
        result = subprocess.CompletedProcess(["python"], returncode=1)
        with patch.object(self.worker.subprocess, "run", return_value=result):
            self.assertFalse(self.worker._optional_probe("raise SystemExit(1)"))

    def test_optional_probe_timeout_reports_category_without_exception_text(self):
        diagnostic = {}
        timeout = subprocess.TimeoutExpired(["private-path", "private-script"], 20)
        with patch.object(self.worker.subprocess, "run", side_effect=timeout):
            self.assertFalse(self.worker._optional_probe("probe", diagnostic))
        self.assertEqual(diagnostic["status"], "timeout")
        self.assertEqual(diagnostic["timeoutSeconds"], 20.0)
        self.assertNotIn("private", json.dumps(diagnostic))

    def test_optional_probe_distinguishes_launch_and_import_failure(self):
        for failure, expected_status, expected_exit in (
            (OSError("private-path"), "launch_error", None),
            (subprocess.CompletedProcess(["python"], 7), "failed", 7),
        ):
            diagnostic = {}
            with self.subTest(status=expected_status), patch.object(
                self.worker.subprocess,
                "run",
                side_effect=failure if isinstance(failure, Exception) else None,
                return_value=failure,
            ):
                self.assertFalse(self.worker._optional_probe("probe", diagnostic))
            self.assertEqual(diagnostic["status"], expected_status)
            self.assertEqual(diagnostic["exitCode"], expected_exit)
            self.assertNotIn("private", json.dumps(diagnostic))

    def test_optional_probe_success_preserves_offline_and_bounded_execution(self):
        diagnostic = {}
        with patch.object(
            self.worker.subprocess, "run", return_value=subprocess.CompletedProcess(["python"], 0)
        ) as run:
            self.assertTrue(self.worker._optional_probe("probe", diagnostic))
        self.assertEqual(diagnostic["status"], "ready")
        self.assertEqual(diagnostic["exitCode"], 0)
        self.assertEqual(run.call_args.kwargs["timeout"], 20.0)
        self.assertEqual(run.call_args.kwargs["env"]["HF_HUB_OFFLINE"], "1")
        self.assertEqual(run.call_args.kwargs["stderr"], subprocess.DEVNULL)

    def test_probe_keeps_installed_metadata_when_peft_times_out(self):
        class FakeCuda:
            @staticmethod
            def is_available():
                return True

            @staticmethod
            def is_bf16_supported():
                return False

        class FakeTorch:
            cuda = FakeCuda()

        with (
            patch.object(self.worker, "_core_module_version", return_value="installed"),
            patch.object(self.worker.importlib, "import_module", return_value=FakeTorch()),
            patch.object(self.worker, "_module_installed", side_effect=lambda name: name in ("peft", "bitsandbytes")),
            patch.object(self.worker, "_installed_version", side_effect=lambda name: {"peft": "0.16.0", "bitsandbytes": "0.46.1"}.get(name)),
            patch.object(self.worker.subprocess, "run", side_effect=subprocess.TimeoutExpired(["python"], 20)),
            patch.object(self.worker.sys, "stdout", new_callable=io.StringIO) as stdout,
        ):
            self.assertEqual(self.worker.probe(), 0)
        report = json.loads(stdout.getvalue())
        self.assertEqual(report["packages"]["peft"], "0.16.0")
        self.assertEqual(report["packages"]["bitsandbytes"], "0.46.1")
        self.assertEqual(report["optionalProbeDiagnostics"]["lora"]["status"], "timeout")
        self.assertEqual(report["optionalProbeDiagnostics"]["qlora"]["status"], "lora_unavailable")
        self.assertEqual(report["optionalProbeDiagnostics"]["media"]["status"], "not_installed")
        self.assertEqual(report["methods"], ["full"])
        self.assertIn("LoRA library check timed out after 20 seconds", report["reason"])

    def test_full_capability_does_not_depend_on_optional_probes(self):
        class FakeCuda:
            @staticmethod
            def is_available():
                return False

            @staticmethod
            def is_bf16_supported():
                return False

        class FakeTorch:
            cuda = FakeCuda()

        with (
            patch.object(
                self.worker,
                "_core_module_version",
                side_effect=lambda name: {"torch": "2", "transformers": "4", "accelerate": "1"}[name],
            ),
            patch.object(self.worker.importlib, "import_module", return_value=FakeTorch()),
            patch.object(self.worker, "_module_installed", return_value=False),
            patch.object(self.worker, "_installed_version", return_value=None),
            patch.object(self.worker.sys, "stdout", new_callable=io.StringIO) as stdout,
        ):
            self.assertEqual(self.worker.probe(), 0)

        report = json.loads(stdout.getvalue())
        self.assertTrue(report["ready"])
        self.assertEqual(report["methods"], ["full"])
        self.assertEqual(report["modalities"], ["text"])
        self.assertIn("optional capabilities unavailable", report["reason"])


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

    def test_plain_text_rows_keep_tokens_and_ignore_padding(self):
        self.assertEqual(
            self.worker.training_labels(
                [10, 11, 12, 13],
                attention_mask=[1, 1, 1, 0],
            ),
            [10, 11, 12, -100],
        )

    def test_prompt_and_padding_are_both_ignored(self):
        self.assertEqual(
            self.worker.training_labels(
                [10, 11, 12, 13, 14],
                prompt_token_count=2,
                attention_mask=[1, 1, 1, 1, 0],
            ),
            [-100, -100, 12, 13, -100],
        )

    def test_attention_mask_must_match_inputs(self):
        with self.assertRaisesRegex(ValueError, "match the encoded input"):
            self.worker.training_labels([1, 2], attention_mask=[1])

    def test_one_step_real_torch_loss_is_finite_when_runtime_is_available(self):
        try:
            import torch
        except ImportError:
            self.skipTest("torch runtime is not installed in this stdlib test environment")

        input_ids = torch.tensor([[2, 3, 4, 0]], dtype=torch.long)
        labels = torch.tensor(
            [
                self.worker.training_labels(
                    input_ids[0].tolist(), attention_mask=[1, 1, 1, 0]
                )
            ],
            dtype=torch.long,
        )
        model = torch.nn.Sequential(
            torch.nn.Embedding(8, 12),
            torch.nn.Linear(12, 8),
        )
        optimizer = torch.optim.SGD(model.parameters(), lr=0.01)
        logits = model(input_ids)
        loss = torch.nn.functional.cross_entropy(
            logits.reshape(-1, 8), labels.reshape(-1), ignore_index=-100
        )
        self.assertTrue(torch.isfinite(loss).item())
        loss.backward()
        optimizer.step()


class ExplicitTrainingDeviceTests(unittest.TestCase):
    def setUp(self):
        self.worker = load_worker()

    def test_gpu_only_requires_cuda_and_never_falls_back_to_cpu(self):
        fake_torch = type(
            "FakeTorch",
            (),
            {"cuda": type("Cuda", (), {"is_available": staticmethod(lambda: False)})()},
        )()
        with self.assertRaisesRegex(ValueError, "GPU-only.*CUDA"):
            self.worker._require_training_device(fake_torch, "gpu")

    def test_cpu_only_is_explicit(self):
        fake_torch = type(
            "FakeTorch",
            (),
            {"cuda": type("Cuda", (), {"is_available": staticmethod(lambda: True)})()},
        )()
        self.assertEqual(self.worker._require_training_device(fake_torch, "cpu"), "cpu")


class CalibrationDevicePlacementTests(unittest.TestCase):
    def setUp(self):
        self.worker = load_worker()

    def test_rejects_mixed_cpu_and_gpu_model_tensors(self):
        class Parameter:
            def __init__(self, device):
                self.device = device

            def numel(self):
                return 1

        class Model:
            def parameters(self):
                return [Parameter("cuda:0"), Parameter("cpu")]

        with self.assertRaisesRegex(ValueError, "cannot fall back or offload"):
            self.worker._assert_model_device(Model(), "gpu")

    def test_accepts_all_tensors_on_requested_gpu(self):
        class Device:
            def __init__(self, value):
                self.value = value

            def __str__(self):
                return self.value

        class Parameter:
            device = Device("cuda:0")

            def numel(self):
                return 1

        class Model:
            def parameters(self):
                return [Parameter(), Parameter()]

        self.assertEqual(self.worker._assert_model_device(Model(), "gpu"), "cuda:0")


class CalibrationGradientValidationTests(unittest.TestCase):
    def setUp(self):
        self.worker = load_worker()

    def test_allows_unused_trainable_parameters_but_requires_a_finite_gradient(self):
        class FiniteResult:
            def all(self):
                return self

            def item(self):
                return True

        class FakeTorch:
            @staticmethod
            def isfinite(_gradient):
                return FiniteResult()

            @staticmethod
            def count_nonzero(_gradient):
                return FiniteResult()

        class Parameter:
            def __init__(self, gradient):
                self.grad = gradient

        self.assertEqual(
            self.worker._check_finite_gradients(
                FakeTorch,
                [("unused.adapter", Parameter(None)), ("used.adapter", Parameter(object()))],
            ),
            {
                "trainableParameterCount": 2,
                "gradientParameterCount": 1,
                "nonzeroGradientParameterCount": 1,
                "missingGradientParameterNames": ["unused.adapter"],
            },
        )

    def test_rejects_a_forward_with_no_trainable_gradients(self):
        class Parameter:
            grad = None

        with self.assertRaisesRegex(ValueError, "no trainable parameter with a gradient"):
            self.worker._check_finite_gradients(object(), [("missing.adapter", Parameter())])

    def test_requires_a_nonzero_gradient_even_when_finite(self):
        class FiniteResult:
            def all(self):
                return self

            def item(self):
                return True

        class ZeroResult:
            def item(self):
                return False

        class FakeTorch:
            @staticmethod
            def isfinite(_gradient):
                return FiniteResult()

            @staticmethod
            def count_nonzero(_gradient):
                return ZeroResult()

        class Parameter:
            grad = object()

        with self.assertRaisesRegex(ValueError, "only zero trainable gradients"):
            self.worker._check_finite_gradients(FakeTorch, [("zero.adapter", Parameter())])

    def test_rejects_a_nonfinite_gradient(self):
        class NonFiniteResult:
            def all(self):
                return self

            def item(self):
                return False

        class FakeTorch:
            @staticmethod
            def isfinite(_gradient):
                return NonFiniteResult()

        class Parameter:
            grad = object()

        with self.assertRaisesRegex(ValueError, "non-finite gradient in bad.adapter"):
            self.worker._check_finite_gradients(FakeTorch, [("bad.adapter", Parameter())])


class TrainingTargetModuleDefaultsTests(unittest.TestCase):
    def setUp(self):
        self.worker = load_worker()

    def test_text_training_and_calibration_share_peft_target_discovery(self):
        self.assertIsNone(self.worker._target_modules_for_training({}, multimodal=False))
        self.assertEqual(
            self.worker._target_modules_for_training({}, multimodal=True), "all-linear"
        )
        self.assertEqual(
            self.worker._target_modules_for_training(
                {"targetModules": ["q_proj", "v_proj"]}, multimodal=False
            ),
            ["q_proj", "v_proj"],
        )


class CalibrationMemoryEvidenceTests(unittest.TestCase):
    def setUp(self):
        self.worker = load_worker()

    def test_p95_uses_nearest_rank_for_ten_measured_steps(self):
        self.assertEqual(
            self.worker._nearest_rank_p95(
                [1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0, 8.0, 9.0, 10.0]
            ),
            10.0,
        )

    def test_headroom_is_bounded_by_external_global_memory_pressure(self):
        mebibyte = 1024 * 1024
        total = 6141 * mebibyte
        own_peak = 2000 * mebibyte
        observed_global_free = [4000 * mebibyte, 1800 * mebibyte]

        self.assertEqual(
            self.worker._conservative_vram_headroom_mb(
                total, own_peak, observed_global_free
            ),
            1800,
        )


class TrainingArgumentsCompatibilityTests(unittest.TestCase):
    def setUp(self):
        self.worker = load_worker()

    def test_drops_only_the_removed_overwrite_output_dir_argument(self):
        class CurrentTrainingArguments:
            def __init__(self, output_dir, use_cpu=False):
                del output_dir, use_cpu

        self.assertEqual(
            self.worker._compatible_training_arguments(
                CurrentTrainingArguments,
                {
                    "output_dir": "D:/bounded-output",
                    "use_cpu": False,
                    "overwrite_output_dir": False,
                },
            ),
            {"output_dir": "D:/bounded-output", "use_cpu": False},
        )

    def test_rejects_any_other_unexpected_training_argument(self):
        class CurrentTrainingArguments:
            def __init__(self, output_dir):
                del output_dir

        with self.assertRaisesRegex(ValueError, "unsupported training arguments"):
            self.worker._compatible_training_arguments(
                CurrentTrainingArguments,
                {"output_dir": "D:/bounded-output", "silentFallback": True},
            )


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


class LocalMediaDecodeTests(unittest.TestCase):
    def setUp(self):
        self.worker = load_worker()

    def test_decodes_a_local_image_as_rgb(self):
        from PIL import Image

        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "frame.png"
            Image.new("RGBA", (4, 3), (1, 2, 3, 255)).save(path)

            frames = self.worker._load_media_frames(
                {"mediaType": "image", "mediaPath": str(path), "plannedFrames": 1}
            )

            self.assertEqual(len(frames), 1)
            self.assertEqual(frames[0].mode, "RGB")
            self.assertEqual(frames[0].size, (4, 3))

    def test_samples_video_across_the_reported_frame_range(self):
        class FakeImage:
            def __init__(self, index):
                self.index = index

            def convert(self, _mode):
                return self

        class FakeFrame:
            def __init__(self, index):
                self.index = index

            def to_image(self):
                return FakeImage(self.index)

        class FakeContainer:
            def __init__(self):
                self.streams = type("Streams", (), {"video": [type("Stream", (), {"frames": 5})()]})()

            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return False

            def decode(self, _stream):
                return [FakeFrame(index) for index in range(5)]

        with patch("av.open", return_value=FakeContainer()):
            frames = self.worker._load_media_frames(
                {"mediaType": "video", "mediaPath": "C:/private/clip.mp4", "plannedFrames": 3}
            )

        self.assertEqual([frame.index for frame in frames], [0, 2, 4])


class TrainingProtocolOutputTests(unittest.TestCase):
    def setUp(self):
        self.worker = load_worker()

    def test_noisy_trainer_output_stays_off_stdout(self):
        class Result:
            metrics = {"train_loss": 1.0}

        class NoisyTrainer:
            def train(self, resume_from_checkpoint=None):
                del resume_from_checkpoint
                print({"loss": 1.0})
                return Result()

            def evaluate(self):
                print({"eval_loss": 2.0})
                return {"eval_loss": 2.0}

            def save_model(self, path):
                print(f"saved {path}")

        class NoisyTokenizer:
            def save_pretrained(self, path):
                print(f"tokenizer {path}")

        stdout = io.StringIO()
        stderr = io.StringIO()
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            result, metrics = self.worker._run_training_lifecycle(
                NoisyTrainer(),
                None,
                Path("D:/bounded-output"),
                NoisyTokenizer(),
                None,
            )

        self.assertEqual(result.metrics, {"train_loss": 1.0})
        self.assertEqual(metrics, {"eval_loss": 2.0})
        self.assertEqual(stdout.getvalue(), "")
        self.assertIn("loss", stderr.getvalue())


if __name__ == "__main__":
    unittest.main()
