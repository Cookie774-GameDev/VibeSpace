from __future__ import annotations

import json
import hashlib
import tempfile
import unittest
from pathlib import Path

from worker import _read_calibration_request, _read_request


class TrainingRequestV2Tests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.model = self.root / "model"
        self.model.mkdir()
        (self.model / "config.json").write_text("{}", encoding="utf-8")
        self.train = self.root / "train.jsonl"
        self.validation = self.root / "validation.jsonl"
        self.train.write_text(
            json.dumps({"prompt": "Train prompt", "response": "Train response"}),
            encoding="utf-8",
        )
        self.validation.write_text(
            json.dumps({"prompt": "Validation prompt", "response": "Validation response"}),
            encoding="utf-8",
        )
        self.request_path = self.root / "request.json"

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def request(self) -> dict[str, object]:
        return {
            "schemaVersion": 2,
            "protocol": 1,
            "localOnly": True,
            "method": "lora",
            "baseModelPath": str(self.model),
            "datasetPath": str(self.train),
            "validationDatasetPath": str(self.validation),
            "outputDir": str(self.root / "output"),
            "epochs": 3,
            "maxSteps": 77,
            "trainingConfig": {
                "method": "lora",
                "computeDevice": "gpu",
                "seed": 23,
                "epochs": 3,
                "maxSteps": 77,
                "batchSize": 2,
                "gradientAccumulation": 8,
                "maxSequenceLength": 1024,
                "learningRate": 0.00008,
                "loraRank": 32,
                "loraAlpha": 64,
                "loraDropout": 0.1,
            },
            "targetModules": ["q_proj", "v_proj"],
        }

    def test_preserves_the_closed_configuration_and_validation_split(self) -> None:
        self.request_path.write_text(json.dumps(self.request()), encoding="utf-8")

        normalized, summary = _read_request(str(self.request_path))

        self.assertEqual(normalized["trainingConfig"]["batchSize"], 2)
        self.assertEqual(normalized["trainingConfig"]["gradientAccumulation"], 8)
        self.assertEqual(normalized["trainingConfig"]["learningRate"], 0.00008)
        self.assertEqual(normalized["trainingConfig"]["loraRank"], 32)
        self.assertEqual(normalized["trainingConfig"]["computeDevice"], "gpu")
        self.assertEqual(normalized["targetModules"], ["q_proj", "v_proj"])
        self.assertEqual(normalized["validationDatasetPath"], str(self.validation.resolve()))
        self.assertEqual(summary["validationExamples"], 1)

    def test_rejects_a_legacy_limit_that_disagrees_with_v2(self) -> None:
        request = self.request()
        request["epochs"] = 2
        self.request_path.write_text(json.dumps(request), encoding="utf-8")

        with self.assertRaisesRegex(ValueError, "disagree"):
            _read_request(str(self.request_path))

    def test_rejects_unknown_configuration_fields(self) -> None:
        request = self.request()
        request["trainingConfig"]["silentlyFallback"] = True  # type: ignore[index]
        self.request_path.write_text(json.dumps(request), encoding="utf-8")

        with self.assertRaisesRegex(ValueError, "closed trainingConfig"):
            _read_request(str(self.request_path))

    def test_rejects_an_implicit_or_unknown_training_device(self) -> None:
        request = self.request()
        request["trainingConfig"]["computeDevice"] = "auto"  # type: ignore[index]
        self.request_path.write_text(json.dumps(request), encoding="utf-8")

        with self.assertRaisesRegex(ValueError, "computeDevice"):
            _read_request(str(self.request_path))

    def test_calibration_request_is_closed_and_matches_the_selected_model(self) -> None:
        request = {
            "protocol": 1,
            "localOnly": True,
            "modelId": "smollm2-135m-instruct",
            "method": "full",
            "baseModelPath": str(self.model),
            "modelModalities": ["text"],
            "trainingConfig": {
                **self.request()["trainingConfig"],
                "method": "full",
                "computeDevice": "gpu",
            },
        }
        self.request_path.write_text(json.dumps(request), encoding="utf-8")

        normalized = _read_calibration_request(str(self.request_path))

        self.assertEqual(normalized["modelId"], "smollm2-135m-instruct")
        self.assertEqual(normalized["trainingConfig"]["computeDevice"], "gpu")

    def test_calibration_rejects_unknown_fields_without_silent_fallback(self) -> None:
        request = {
            "protocol": 1,
            "localOnly": True,
            "modelId": "smollm2-135m-instruct",
            "method": "full",
            "baseModelPath": str(self.model),
            "trainingConfig": {
                **self.request()["trainingConfig"],
                "method": "full",
                "computeDevice": "auto",
            },
            "silentlyFallback": True,
        }
        self.request_path.write_text(json.dumps(request), encoding="utf-8")

        with self.assertRaisesRegex(ValueError, "unsupported fields"):
            _read_calibration_request(str(self.request_path))

    def test_accepts_hash_verified_media_only_for_declared_model_modality(self) -> None:
        media = self.root / "media" / "frame.png"
        media.parent.mkdir()
        media.write_bytes(b"bounded-test-image")
        record = {
            "prompt": "What is shown?",
            "response": "A reviewed test frame.",
            "mediaType": "image",
            "mediaPath": str(media),
            "mediaSha256": hashlib.sha256(media.read_bytes()).hexdigest(),
            "plannedFrames": 1,
        }
        self.train.write_text(json.dumps(record), encoding="utf-8")
        self.validation.write_text(json.dumps(record), encoding="utf-8")
        request = self.request()
        request["modelModalities"] = ["text", "image", "video"]
        self.request_path.write_text(json.dumps(request), encoding="utf-8")

        normalized, summary = _read_request(str(self.request_path))

        self.assertEqual(normalized["modelModalities"], ["text", "image", "video"])
        self.assertEqual(summary["examples"], 1)

    def test_rejects_media_for_a_text_only_model(self) -> None:
        media = self.root / "frame.png"
        media.write_bytes(b"bounded-test-image")
        record = {
            "prompt": "What is shown?",
            "response": "A reviewed test frame.",
            "mediaType": "image",
            "mediaPath": str(media),
            "mediaSha256": hashlib.sha256(media.read_bytes()).hexdigest(),
            "plannedFrames": 1,
        }
        self.train.write_text(json.dumps(record), encoding="utf-8")
        self.request_path.write_text(json.dumps(self.request()), encoding="utf-8")

        with self.assertRaisesRegex(ValueError, "unsupported model modality"):
            _read_request(str(self.request_path))


if __name__ == "__main__":
    unittest.main()
