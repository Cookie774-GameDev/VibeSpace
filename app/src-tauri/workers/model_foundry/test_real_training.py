from __future__ import annotations

import hashlib
import json
import tempfile
import unittest
from pathlib import Path

from real_training import (
    IGNORE_INDEX,
    OOM_SUGGESTIONS,
    TrainingFailure,
    completion_only_labels,
    out_of_memory_failure,
    qlora_support_error,
    validate_manifest,
)


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


class RealTrainingContractTests(unittest.TestCase):
    def make_manifest(self, root: Path) -> tuple[dict, Path, Path]:
        job = root / "job"
        model = root / "models" / "pinned-model"
        job.mkdir()
        model.mkdir(parents=True)
        files = {
            "config.json": "{}",
            "tokenizer_config.json": "{}",
            "tokenizer.json": "{}",
            "model.safetensors": "safe-placeholder",
        }
        for name, contents in files.items():
            (model / name).write_text(contents, encoding="utf-8")
        train = job / "train.jsonl"
        validation = job / "validation.jsonl"
        train.write_text('{"prompt":"p","completion":"c"}\n', encoding="utf-8")
        validation.write_text('{"prompt":"v","completion":"x"}\n', encoding="utf-8")
        manifest = {
            "backend": "real",
            "modelDir": str(model),
            "modelFiles": {name: digest(model / name) for name in files},
            "trainDatasetPath": str(train),
            "validationDatasetPath": str(validation),
            "trainDatasetSha256": digest(train),
            "validationDatasetSha256": digest(validation),
            "outputDir": str(job / "output"),
            "trainingConfig": {
                "method": "lora",
                "seed": 7,
                "epochs": 1,
                "batchSize": 1,
                "gradientAccumulation": 4,
                "maxSequenceLength": 256,
                "learningRate": 0.0002,
                "loraRank": 8,
                "loraAlpha": 16,
                "loraDropout": 0.05,
            },
        }
        return manifest, job, root / "models"

    def test_manifest_requires_confined_pinned_local_inputs(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            manifest, job, model_root = self.make_manifest(Path(temporary))
            validated = validate_manifest(manifest, job, model_root)
            self.assertEqual(validated["config"]["method"], "lora")
            manifest["outputDir"] = str(Path(temporary) / "escape")
            with self.assertRaisesRegex(TrainingFailure, "outside its allowed root"):
                validate_manifest(manifest, job, model_root)

    def test_manifest_rejects_tampered_model_and_dataset(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            manifest, job, model_root = self.make_manifest(Path(temporary))
            Path(manifest["modelDir"], "model.safetensors").write_text("tampered", encoding="utf-8")
            with self.assertRaisesRegex(TrainingFailure, "verification failed"):
                validate_manifest(manifest, job, model_root)

    def test_completion_loss_masks_every_prompt_token(self) -> None:
        self.assertEqual(completion_only_labels([11, 12, 21, 22], 2), [IGNORE_INDEX, IGNORE_INDEX, 21, 22])
        with self.assertRaises(TrainingFailure):
            completion_only_labels([1], 2)

    def test_qlora_fails_closed_without_required_runtime(self) -> None:
        no_cuda = qlora_support_error(False, True)
        self.assertEqual(no_cuda.code, "training.qlora_cuda_required")
        no_bits = qlora_support_error(True, False)
        self.assertEqual(no_bits.code, "training.qlora_bitsandbytes_missing")
        self.assertIsNone(qlora_support_error(True, True))

    def test_oom_error_preserves_configuration_and_gives_actions(self) -> None:
        failure = out_of_memory_failure()
        self.assertEqual(failure.code, "training.out_of_memory")
        self.assertTrue(failure.recoverable)
        self.assertEqual(failure.suggestions, OOM_SUGGESTIONS)
        self.assertGreaterEqual(len(failure.suggestions), 4)


if __name__ == "__main__":
    unittest.main()
