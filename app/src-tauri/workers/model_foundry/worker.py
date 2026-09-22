"""VibeSpace Model Foundry local training worker.

This source is embedded in the signed desktop application and copied into the
private app-data runtime only after an explicit user action. It never performs
cloud execution or uploads.
"""

from __future__ import annotations

import argparse
import contextlib
import importlib
import importlib.metadata
import importlib.util
import hashlib
import inspect
import json
import math
import os
import statistics
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any

PROTOCOL = 1
LOCAL_ONLY = True
MAX_REQUEST_BYTES = 128 * 1024
MAX_CALIBRATION_REQUEST_BYTES = 128 * 1024
CALIBRATION_WARMUP_STEPS = 3
CALIBRATION_MEASURED_STEPS = 10
MAX_DATASET_BYTES = 512 * 1024 * 1024
MAX_EXAMPLES = 1_000_000
MAX_LINE_CHARS = 1_000_000
ALLOWED_METHODS = frozenset(("lora", "qlora", "full"))
ALLOWED_REQUEST_KEYS = frozenset(
    (
        "schemaVersion",
        "protocol",
        "localOnly",
        "method",
        "baseModelPath",
        "modelModalities",
        "datasetPath",
        "validationDatasetPath",
        "outputDir",
        "resumeFromCheckpoint",
        "epochs",
        "maxSteps",
        "trainingConfig",
        "targetModules",
    )
)
ALLOWED_CALIBRATION_KEYS = frozenset(
    (
        "protocol",
        "localOnly",
        "modelId",
        "method",
        "baseModelPath",
        "modelModalities",
        "trainingConfig",
        "targetModules",
    )
)
ALLOWED_TRAINING_CONFIG_KEYS = frozenset(
    (
        "method",
        "computeDevice",
        "seed",
        "epochs",
        "maxSteps",
        "batchSize",
        "gradientAccumulation",
        "maxSequenceLength",
        "learningRate",
        "loraRank",
        "loraAlpha",
        "loraDropout",
    )
)
ALLOWED_INFERENCE_KEYS = frozenset(
    (
        "protocol",
        "localOnly",
        "method",
        "baseModelPath",
        "artifactPath",
        "responsePath",
        "messages",
        "maxOutputTokens",
    )
)
ALLOWED_MESSAGE_ROLES = frozenset(("system", "user", "assistant"))
MAX_INFERENCE_CHARS = 128 * 1024
MAX_INFERENCE_MESSAGES = 64
OPTIONAL_PROBE_TIMEOUT_SECONDS = 20.0
_OPTIONAL_DISTRIBUTIONS = {
    "PIL": "Pillow",
    "av": "av",
    "bitsandbytes": "bitsandbytes",
    "datasets": "datasets",
    "peft": "peft",
    "trl": "trl",
}
_PEFT_PROBE = "from peft import LoraConfig, get_peft_model, prepare_model_for_kbit_training\n"
_MEDIA_PROBE = "from PIL import Image\nimport av\n"
_QLORA_PROBE = """import bitsandbytes.functional as bnb_functional
import torch
from peft import LoraConfig, get_peft_model, prepare_model_for_kbit_training

if not torch.cuda.is_available():
    raise SystemExit(1)
probe_tensor = torch.zeros(64, device="cuda", dtype=torch.float16)
quantized, quantization_state = bnb_functional.quantize_4bit(
    probe_tensor, quant_type="nf4"
)
restored = bnb_functional.dequantize_4bit(
    quantized, quant_state=quantization_state
)
if restored.shape != probe_tensor.shape:
    raise SystemExit(1)
"""


def _module_installed(name: str) -> bool:
    try:
        return importlib.util.find_spec(name) is not None
    except (ImportError, AttributeError, ValueError):
        return False


def _installed_version(name: str) -> str | None:
    if not _module_installed(name):
        return None
    distribution = _OPTIONAL_DISTRIBUTIONS.get(name, name)
    try:
        return str(importlib.metadata.version(distribution))
    except importlib.metadata.PackageNotFoundError:
        return "unknown"
    except Exception:
        return None


def _optional_probe(script: str) -> bool:
    """Run one optional capability check in a bounded child process.

    Optional libraries can import large ML stacks or initialize native codecs.
    A slow/broken optional probe must never hold up the verified Full path.
    The child is local-only and offline; a timeout is an unavailable capability.
    """
    environment = os.environ.copy()
    environment["HF_HUB_OFFLINE"] = "1"
    environment["TRANSFORMERS_OFFLINE"] = "1"
    try:
        result = subprocess.run(
            [sys.executable, "-c", script],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            env=environment,
            timeout=OPTIONAL_PROBE_TIMEOUT_SECONDS,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        return False
    return result.returncode == 0


def _core_module_version(name: str) -> str | None:
    try:
        module = importlib.import_module(name)
        return str(getattr(module, "__version__", "unknown"))
    except Exception:
        return None


def probe() -> int:
    """Report installed training libraries without installing or downloading."""
    packages: dict[str, str | None] = {
        name: _core_module_version(name)
        for name in ("torch", "transformers", "accelerate")
    }
    packages.update({name: _installed_version(name) for name in ("datasets", "trl")})
    core_ready = all(packages.get(name) for name in ("torch", "transformers", "accelerate"))
    methods: list[str] = []
    precisions: list[str] = []
    cuda_ready = False
    bf16_ready = False
    if core_ready:
        methods.append("full")
        precisions.append("fp32")
        try:
            torch = importlib.import_module("torch")

            cuda_ready = bool(torch.cuda.is_available())
            bf16_ready = bool(
                cuda_ready
                and hasattr(torch.cuda, "is_bf16_supported")
                and torch.cuda.is_bf16_supported()
            )
        except Exception:
            cuda_ready = False
        if cuda_ready:
            precisions.append("fp16")
        if bf16_ready:
            precisions.append("bf16")

    lora_ready = False
    media_ready = False
    qlora_smoke_ready = False
    if core_ready:
        with ThreadPoolExecutor(max_workers=2, thread_name_prefix="optional-probe") as executor:
            lora_future = (
                executor.submit(_optional_probe, _PEFT_PROBE)
                if _module_installed("peft")
                else None
            )
            media_future = (
                executor.submit(_optional_probe, _MEDIA_PROBE)
                if _module_installed("PIL") and _module_installed("av")
                else None
            )
            lora_ready = lora_future.result() if lora_future is not None else False
            media_ready = media_future.result() if media_future is not None else False
        if lora_ready:
            packages["peft"] = _installed_version("peft")
            methods.append("lora")
        if media_ready:
            packages["PIL"] = _installed_version("PIL")
            packages["av"] = _installed_version("av")
        if lora_ready and cuda_ready and _module_installed("bitsandbytes"):
            qlora_smoke_ready = _optional_probe(_QLORA_PROBE)
            if qlora_smoke_ready:
                packages["bitsandbytes"] = _installed_version("bitsandbytes")
    if qlora_smoke_ready:
        methods.append("qlora")
        precisions.extend(("int8", "int4"))
    ready = "full" in methods
    optional_unavailable: list[str] = []
    if ready:
        if not lora_ready:
            optional_unavailable.append("lora")
        if not media_ready:
            optional_unavailable.append("image/video")
        if cuda_ready and not qlora_smoke_ready:
            optional_unavailable.append("qlora")
    reason = None
    if not ready:
        reason = "Verified local training libraries are incomplete; cloud execution is disabled."
    elif optional_unavailable:
        reason = (
            "Full training is ready; optional capabilities unavailable: "
            + ", ".join(optional_unavailable)
            + "."
        )
    print(
        json.dumps(
            {
                "protocol": PROTOCOL,
                "localOnly": LOCAL_ONLY,
                "ready": ready,
                "packages": packages,
                "methods": methods,
                "modalities": (["text", "image", "video"] if media_ready else ["text"]) if ready else [],
                "precisions": list(dict.fromkeys(precisions)),
                "optionalCapabilities": {
                    "lora": lora_ready,
                    "qlora": qlora_smoke_ready,
                    "media": media_ready,
                },
                "reason": reason,
            },
            separators=(",", ":"),
        )
    )
    return 0


def _read_request(request_path: str) -> tuple[dict[str, Any], dict[str, Any]]:
    path = _absolute_path(request_path, "requestPath")
    if not path.is_file() or path.stat().st_size > MAX_REQUEST_BYTES:
        _fail("Training request is missing or exceeds the safe size limit.")
    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, dict) or set(payload) - ALLOWED_REQUEST_KEYS:
        _fail("Training request contains unsupported fields.")
    if payload.get("protocol") != PROTOCOL or payload.get("localOnly") is not True:
        _fail("Training request must match the local-only worker protocol.")
    method = payload.get("method")
    if method not in ALLOWED_METHODS:
        _fail("Training method is not supported.")
    model = _absolute_path(payload.get("baseModelPath"), "baseModelPath")
    model_modalities = payload.get("modelModalities", ["text"])
    if (
        not isinstance(model_modalities, list)
        or not model_modalities
        or "text" not in model_modalities
        or any(value not in ("text", "image", "video", "audio") for value in model_modalities)
    ):
        _fail("Verified model modalities are invalid.")
    dataset = _absolute_path(payload.get("datasetPath"), "datasetPath")
    schema_version = payload.get("schemaVersion", 1)
    if schema_version not in (1, 2):
        _fail("Training request schema version is not supported.")
    validation_dataset = (
        _absolute_path(payload.get("validationDatasetPath"), "validationDatasetPath")
        if schema_version == 2
        else dataset
    )
    output = _absolute_path(payload.get("outputDir"), "outputDir")
    resume_checkpoint_value = payload.get("resumeFromCheckpoint")
    resume_checkpoint: Path | None = None
    if resume_checkpoint_value is not None:
        resume_checkpoint = _absolute_path(
            resume_checkpoint_value, "resumeFromCheckpoint"
        )
        checkpoint_suffix = resume_checkpoint.name.removeprefix("checkpoint-")
        if (
            resume_checkpoint.parent != output
            or not resume_checkpoint.name.startswith("checkpoint-")
            or not checkpoint_suffix.isdigit()
            or not resume_checkpoint.is_dir()
            or not (resume_checkpoint / "trainer_state.json").is_file()
        ):
            _fail(
                "Resume checkpoint must be a verified Trainer checkpoint inside the output directory."
            )
    if not model.is_dir() or not (model / "config.json").is_file():
        _fail("Base model must be a local Transformers directory with config.json.")
    if not dataset.is_file() or dataset.suffix.lower() != ".jsonl":
        _fail("Dataset must be a local JSONL file.")
    if not validation_dataset.is_file() or validation_dataset.suffix.lower() != ".jsonl":
        _fail("Validation dataset must be a local JSONL file.")
    if dataset.stat().st_size > MAX_DATASET_BYTES:
        _fail("Dataset exceeds the safe local size limit.")
    if output == model or output == dataset or model in output.parents:
        _fail("Output directory must be separate from source and base-model paths.")
    if schema_version == 2:
        raw_config = payload.get("trainingConfig")
        if not isinstance(raw_config, dict) or set(raw_config) - ALLOWED_TRAINING_CONFIG_KEYS:
            _fail("TrainingRequestV2 requires a closed trainingConfig object.")
        if raw_config.get("method") != method:
            _fail("Training method and trainingConfig method must match.")
        config = {
            "method": method,
            "computeDevice": _training_compute_device(raw_config.get("computeDevice")),
            "seed": _bounded_integer(raw_config.get("seed"), "seed", 0, 2**32 - 1),
            "epochs": _bounded_integer(raw_config.get("epochs"), "epochs", 1, 20),
            "maxSteps": (
                None
                if raw_config.get("maxSteps") is None
                else _bounded_integer(raw_config.get("maxSteps"), "maxSteps", 1, 1_000_000)
            ),
            "batchSize": _bounded_integer(raw_config.get("batchSize"), "batchSize", 1, 64),
            "gradientAccumulation": _bounded_integer(
                raw_config.get("gradientAccumulation"), "gradientAccumulation", 1, 1_024
            ),
            "maxSequenceLength": _bounded_integer(
                raw_config.get("maxSequenceLength"), "maxSequenceLength", 64, 32_768
            ),
            "learningRate": _bounded_float(raw_config.get("learningRate"), "learningRate", 0.0, 1.0),
            "loraRank": _bounded_integer(raw_config.get("loraRank"), "loraRank", 1, 512),
            "loraAlpha": _bounded_integer(raw_config.get("loraAlpha"), "loraAlpha", 1, 1_024),
            "loraDropout": _bounded_float(
                raw_config.get("loraDropout"),
                "loraDropout",
                0.0,
                1.0,
                minimum_inclusive=True,
                maximum_inclusive=False,
            ),
        }
        if payload.get("epochs") is not None and payload.get("epochs") != config["epochs"]:
            _fail("Legacy epochs and TrainingRequestV2 configuration disagree.")
        if payload.get("maxSteps") is not None and payload.get("maxSteps") != config["maxSteps"]:
            _fail("Legacy maxSteps and TrainingRequestV2 configuration disagree.")
    else:
        epochs = _bounded_integer(payload.get("epochs"), "epochs", 1, 20)
        raw_max_steps = payload.get("maxSteps")
        max_steps = (
            None
            if raw_max_steps is None
            else _bounded_integer(raw_max_steps, "maxSteps", 1, 1_000_000)
        )
        config = {
            "method": method,
            "computeDevice": "gpu",
            "seed": 7,
            "epochs": epochs,
            "maxSteps": max_steps,
            "batchSize": 1,
            "gradientAccumulation": 4,
            "maxSequenceLength": 2_048,
            "learningRate": 2e-5 if method == "full" else 2e-4,
            "loraRank": 16,
            "loraAlpha": 32,
            "loraDropout": 0.05,
        }
    if method == "qlora" and config["computeDevice"] != "gpu":
        _fail("QLoRA requires computeDevice gpu.")
    target_modules = payload.get("targetModules")
    if target_modules is not None and (
        not isinstance(target_modules, list)
        or not target_modules
        or len(target_modules) > 128
        or any(
            not isinstance(module, str)
            or not module
            or len(module) > 128
            or not all(character.isalnum() or character == "_" for character in module)
            for module in target_modules
        )
    ):
        _fail("targetModules must be a bounded list of module names.")

    def validate_examples(path: Path, label: str) -> int:
        examples = 0
        with path.open("r", encoding="utf-8") as stream:
            for line_number, line in enumerate(stream, start=1):
                if len(line) > MAX_LINE_CHARS:
                    _fail(f"{label} line {line_number} exceeds the safe size limit.")
                if not line.strip():
                    continue
                try:
                    record = json.loads(line)
                except json.JSONDecodeError as error:
                    _fail(f"{label} line {line_number} is invalid JSON: {error.msg}.")
                if not isinstance(record, dict):
                    _fail(f"{label} line {line_number} must be a JSON object.")
                text = record.get("text")
                prompt = record.get("prompt")
                response = record.get("response", record.get("completion"))
                has_text = isinstance(text, str) and bool(text.strip())
                has_pair = (
                    isinstance(prompt, str)
                    and bool(prompt.strip())
                    and isinstance(response, str)
                    and bool(response.strip())
                )
                if not has_text and not has_pair:
                    _fail(
                        f"{label} line {line_number} needs non-empty text or prompt/response fields."
                    )
                media_type = record.get("mediaType")
                if media_type is not None:
                    if media_type not in ("image", "video") or media_type not in model_modalities:
                        _fail(f"{label} line {line_number} uses an unsupported model modality.")
                    media_path = _absolute_path(record.get("mediaPath"), "mediaPath")
                    expected_sha256 = record.get("mediaSha256")
                    planned_frames = record.get("plannedFrames", 1)
                    suffixes = (
                        frozenset((".png", ".jpg", ".jpeg", ".webp"))
                        if media_type == "image"
                        else frozenset((".mp4", ".mov", ".webm"))
                    )
                    if (
                        not media_path.is_file()
                        or media_path.is_symlink()
                        or not media_path.is_relative_to(path.parent)
                        or media_path.suffix.lower() not in suffixes
                        or not isinstance(expected_sha256, str)
                        or len(expected_sha256) != 64
                        or any(character not in "0123456789abcdefABCDEF" for character in expected_sha256)
                        or _sha256_file(media_path).lower() != expected_sha256.lower()
                        or not isinstance(planned_frames, int)
                        or isinstance(planned_frames, bool)
                        or not 1 <= planned_frames <= 32
                    ):
                        _fail(f"{label} line {line_number} has unsafe or altered local media.")
                examples += 1
                if examples > MAX_EXAMPLES:
                    _fail(f"{label} exceeds the safe example limit.")
        if examples == 0:
            _fail(f"{label} contains no usable examples.")
        return examples

    examples = validate_examples(dataset, "Training dataset")
    validation_examples = validate_examples(validation_dataset, "Validation dataset")

    normalized = {
        **payload,
        "baseModelPath": str(model),
        "datasetPath": str(dataset),
        "validationDatasetPath": str(validation_dataset),
        "outputDir": str(output),
        "resumeFromCheckpoint": (
            str(resume_checkpoint) if resume_checkpoint is not None else None
        ),
        "trainingConfig": config,
        "targetModules": target_modules,
        "modelModalities": model_modalities,
    }
    summary = {
        "protocol": PROTOCOL,
        "localOnly": LOCAL_ONLY,
        "valid": True,
        "method": method,
        "examples": examples,
        "validationExamples": validation_examples,
        "trainingConfig": config,
        "modelModalities": model_modalities,
    }
    return normalized, summary


def _read_calibration_request(request_path: str) -> dict[str, Any]:
    path = _absolute_path(request_path, "requestPath")
    if not path.is_file() or path.stat().st_size > MAX_CALIBRATION_REQUEST_BYTES:
        _fail("Calibration request is missing or exceeds the safe size limit.")
    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, dict) or set(payload) - ALLOWED_CALIBRATION_KEYS:
        _fail("Calibration request contains unsupported fields.")
    if payload.get("protocol") != PROTOCOL or payload.get("localOnly") is not True:
        _fail("Calibration request must match the local-only worker protocol.")
    method = payload.get("method")
    if method not in ALLOWED_METHODS:
        _fail("Calibration method is not supported.")
    model_id = payload.get("modelId")
    if not isinstance(model_id, str) or not model_id.strip() or len(model_id) > 256:
        _fail("Calibration modelId is invalid.")
    model = _absolute_path(payload.get("baseModelPath"), "baseModelPath")
    if not model.is_dir() or not (model / "config.json").is_file():
        _fail("Base model must be a local Transformers directory with config.json.")
    model_modalities = payload.get("modelModalities", ["text"])
    if (
        not isinstance(model_modalities, list)
        or not model_modalities
        or "text" not in model_modalities
        or any(value not in ("text", "image", "video", "audio") for value in model_modalities)
    ):
        _fail("Verified model modalities are invalid.")
    raw_config = payload.get("trainingConfig")
    if not isinstance(raw_config, dict) or set(raw_config) - ALLOWED_TRAINING_CONFIG_KEYS:
        _fail("Calibration requires a closed trainingConfig object.")
    if raw_config.get("method") != method:
        _fail("Calibration method and trainingConfig method must match.")
    config = {
        "method": method,
        "computeDevice": _training_compute_device(raw_config.get("computeDevice")),
        "seed": _bounded_integer(raw_config.get("seed"), "seed", 0, 2**32 - 1),
        "epochs": _bounded_integer(raw_config.get("epochs"), "epochs", 1, 20),
        "maxSteps": (
            None
            if raw_config.get("maxSteps") is None
            else _bounded_integer(raw_config.get("maxSteps"), "maxSteps", 1, 1_000_000)
        ),
        "batchSize": _bounded_integer(raw_config.get("batchSize"), "batchSize", 1, 64),
        "gradientAccumulation": _bounded_integer(
            raw_config.get("gradientAccumulation"), "gradientAccumulation", 1, 1_024
        ),
        "maxSequenceLength": _bounded_integer(
            raw_config.get("maxSequenceLength"), "maxSequenceLength", 64, 32_768
        ),
        "learningRate": _bounded_float(raw_config.get("learningRate"), "learningRate", 0.0, 1.0),
        "loraRank": _bounded_integer(raw_config.get("loraRank"), "loraRank", 1, 512),
        "loraAlpha": _bounded_integer(raw_config.get("loraAlpha"), "loraAlpha", 1, 1_024),
        "loraDropout": _bounded_float(
            raw_config.get("loraDropout"),
            "loraDropout",
            0.0,
            1.0,
            minimum_inclusive=True,
            maximum_inclusive=False,
        ),
    }
    if method == "qlora" and config["computeDevice"] != "gpu":
        _fail("QLoRA requires computeDevice gpu.")
    target_modules = payload.get("targetModules")
    if target_modules is not None and (
        not isinstance(target_modules, list)
        or not target_modules
        or len(target_modules) > 128
        or any(
            not isinstance(module, str)
            or not module
            or len(module) > 128
            or not all(character.isalnum() or character == "_" for character in module)
            for module in target_modules
        )
    ):
        _fail("targetModules must be a bounded list of module names.")
    return {
        "protocol": PROTOCOL,
        "localOnly": LOCAL_ONLY,
        "modelId": model_id,
        "method": method,
        "baseModelPath": str(model),
        "modelModalities": model_modalities,
        "trainingConfig": config,
        "targetModules": target_modules,
    }


def _assert_model_device(model: Any, requested: str) -> str:
    expected = "cuda" if requested == "gpu" else "cpu"
    devices = {
        str(parameter.device).split(":", 1)[0]
        for parameter in model.parameters()
        if getattr(parameter, "numel", lambda: 0)() > 0
    }
    if not devices or devices != {expected}:
        _fail(
            f"Calibration found model tensors on {sorted(devices) or ['no device']}; "
            f"requested {requested}-only training cannot fall back or offload."
        )
    return f"{expected}:0" if expected == "cuda" else expected


def _target_modules_for_training(request: dict[str, Any], multimodal: bool) -> Any:
    explicit = request.get("targetModules")
    if explicit is not None:
        return explicit
    return "all-linear" if multimodal else None


def _check_finite_gradients(
    torch_module: Any, trainable: list[tuple[str, Any]]
) -> dict[str, Any]:
    """Validate gradients that participated in this forward pass.

    Some PEFT adapter parameters can be registered as trainable while no
    gradient reaches them for a particular model forward. Their names remain
    in the calibration evidence for review. Calibration fails closed when no
    trainable parameter receives a gradient or all received gradients are
    zero, and every gradient that does exist must be finite.
    """
    with_gradient: list[tuple[str, Any]] = []
    missing: list[str] = []
    nonzero: list[str] = []
    for name, parameter in trainable:
        if parameter.grad is None:
            missing.append(name)
            continue
        if not bool(torch_module.isfinite(parameter.grad).all().item()):
            _fail(f"Calibration produced a non-finite gradient in {name}.")
        with_gradient.append((name, parameter))
        if bool(torch_module.count_nonzero(parameter.grad).item() > 0):
            nonzero.append(name)
    if not with_gradient:
        missing_names = ", ".join(missing[:8]) or "none"
        if len(missing) > 8:
            missing_names += ", …"
        _fail(
            "Calibration found no trainable parameter with a gradient "
            f"(trainable={len(trainable)}, missing={len(missing)}: {missing_names})."
        )
    if not nonzero:
        gradient_names = ", ".join(name for name, _ in with_gradient[:8]) or "none"
        if len(with_gradient) > 8:
            gradient_names += ", …"
        _fail(
            "Calibration produced only zero trainable gradients "
            f"(trainable={len(trainable)}, withGradient={len(with_gradient)}: {gradient_names})."
        )
    return {
        "trainableParameterCount": len(trainable),
        "gradientParameterCount": len(with_gradient),
        "nonzeroGradientParameterCount": len(nonzero),
        "missingGradientParameterNames": missing[:32],
    }


def _nearest_rank_p95(values: list[float]) -> float:
    if not values:
        raise ValueError("Calibration requires at least one measured step.")
    ordered = sorted(values)
    rank = max(1, math.ceil(len(ordered) * 0.95))
    return ordered[min(len(ordered) - 1, rank - 1)]


def _conservative_vram_headroom_mb(
    total_vram_bytes: int,
    peak_reserved_bytes: int,
    observed_global_free_bytes: list[int],
) -> int:
    if total_vram_bytes <= 0 or peak_reserved_bytes < 0 or not observed_global_free_bytes:
        raise ValueError("Calibration requires valid global CUDA memory observations.")
    global_free_bytes = min(max(0, value) for value in observed_global_free_bytes)
    own_headroom_bytes = max(0, total_vram_bytes - peak_reserved_bytes)
    return max(0, min(own_headroom_bytes, global_free_bytes)) // (1024 * 1024)


def calibrate(request_path: str) -> int:
    request = _read_calibration_request(request_path)
    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["TRANSFORMERS_OFFLINE"] = "1"
    os.environ["TOKENIZERS_PARALLELISM"] = "false"
    try:
        import torch
        from transformers import AutoModelForCausalLM, AutoTokenizer
    except Exception as error:
        _fail(f"Verified local training libraries are unavailable: {type(error).__name__}.")

    config = request["trainingConfig"]
    method = str(request["method"])
    requested_device = _require_training_device(torch, str(config["computeDevice"]))
    use_gpu = requested_device == "gpu"
    if any(value != "text" for value in request["modelModalities"]):
        _fail("Calibration currently requires a text-only verified model.")
    try:
        torch.manual_seed(int(config["seed"]))
        if use_gpu:
            torch.cuda.manual_seed_all(int(config["seed"]))
        torch.set_num_threads(1)
        torch.set_num_interop_threads(1)
    except RuntimeError:
        pass
    started = time.perf_counter()
    model_kwargs: dict[str, Any] = {"local_files_only": True, "trust_remote_code": False}
    use_bf16 = bool(
        use_gpu
        and hasattr(torch.cuda, "is_bf16_supported")
        and torch.cuda.is_bf16_supported()
    )
    if method == "qlora":
        try:
            from transformers import BitsAndBytesConfig
            import bitsandbytes  # noqa: F401
        except Exception as error:
            _fail(f"QLoRA libraries are unavailable: {type(error).__name__}.")
        model_kwargs["quantization_config"] = BitsAndBytesConfig(
            load_in_4bit=True,
            bnb_4bit_quant_type="nf4",
            bnb_4bit_use_double_quant=True,
            bnb_4bit_compute_dtype=torch.bfloat16 if use_bf16 else torch.float16,
        )
        model_kwargs["device_map"] = {"": 0}
    elif use_gpu:
        model_kwargs["torch_dtype"] = torch.bfloat16 if use_bf16 else torch.float16
    tokenizer = AutoTokenizer.from_pretrained(
        str(request["baseModelPath"]), local_files_only=True, trust_remote_code=False
    )
    if tokenizer.pad_token_id is None:
        tokenizer.pad_token = tokenizer.eos_token
    model = AutoModelForCausalLM.from_pretrained(str(request["baseModelPath"]), **model_kwargs)
    if method in ("lora", "qlora"):
        try:
            from peft import LoraConfig, get_peft_model, prepare_model_for_kbit_training
        except Exception as error:
            _fail(f"PEFT libraries are unavailable: {type(error).__name__}.")
        if method == "qlora":
            model = prepare_model_for_kbit_training(model)
        model = get_peft_model(
            model,
            LoraConfig(
                r=int(config["loraRank"]),
                lora_alpha=int(config["loraAlpha"]),
                lora_dropout=float(config["loraDropout"]),
                bias="none",
                task_type="CAUSAL_LM",
            # Match real training: text-only requests leave target discovery to
            # PEFT. Calibration must not add adapters to every linear layer
            # when the training path will use the model's architecture map.
            target_modules=_target_modules_for_training(request, multimodal=False),
            ),
        )
    if use_gpu and method != "qlora":
        model.to("cuda")
    device_name = _assert_model_device(model, requested_device)
    sequence_length = int(config["maxSequenceLength"])
    model_context = getattr(getattr(model, "config", None), "max_position_embeddings", None)
    if isinstance(model_context, int) and sequence_length > model_context:
        _fail(
            f"Calibration sequence length {sequence_length} exceeds the verified model context "
            f"of {model_context}."
        )
    batch_size = int(config["batchSize"])
    gradient_accumulation = int(config["gradientAccumulation"])
    calibration_text = (
        "Calibration example: the verified local trainer must complete a bounded civil-debater "
        "optimizer step using the selected batch and sequence settings. "
    )
    calibration_text *= max(1, sequence_length // 12)
    encoded = tokenizer(
        [calibration_text] * batch_size,
        truncation=True,
        max_length=sequence_length,
        padding="max_length",
        return_tensors="pt",
    )
    device = torch.device("cuda" if use_gpu else "cpu")
    batch = {key: value.to(device) for key, value in encoded.items()}
    attention_mask = batch.get("attention_mask")
    if attention_mask is None:
        attention_mask = torch.ones_like(batch["input_ids"])
        batch["attention_mask"] = attention_mask
    batch["labels"] = batch["input_ids"].clone()
    batch["labels"] = batch["labels"].masked_fill(attention_mask == 0, -100)
    trainable = [
        (name, parameter)
        for name, parameter in model.named_parameters()
        if parameter.requires_grad
    ]
    if not trainable:
        _fail("Calibration found no trainable parameters for the selected method.")
    optimizer = torch.optim.AdamW(
        [parameter for _, parameter in trainable], lr=float(config["learningRate"])
    )
    model.train()
    observed_global_free_vram_bytes: list[int] = []

    def record_global_free_vram() -> None:
        try:
            free_bytes, _ = torch.cuda.mem_get_info()
        except Exception as error:
            _fail(
                "Calibration could not inspect global CUDA memory: "
                f"{type(error).__name__}."
            )
        observed_global_free_vram_bytes.append(int(free_bytes))

    if use_gpu:
        torch.cuda.synchronize()
        record_global_free_vram()

    gradient_summary: dict[str, Any] | None = None

    def check_finite_parameters() -> None:
        for _, parameter in trainable:
            if not bool(torch.isfinite(parameter.data).all().item()):
                _fail("Calibration produced a non-finite parameter after the optimizer step.")

    def optimizer_step() -> float:
        optimizer.zero_grad(set_to_none=True)
        if use_gpu:
            torch.cuda.synchronize()
        step_started = time.perf_counter()
        for _ in range(gradient_accumulation):
            autocast = (
                torch.autocast(
                    device_type="cuda",
                    dtype=torch.bfloat16 if use_bf16 else torch.float16,
                )
                if use_gpu
                else contextlib.nullcontext()
            )
            with autocast:
                output = model(**batch)
                loss = getattr(output, "loss", None)
                if loss is None or not bool(torch.isfinite(loss).item()):
                    _fail("Calibration produced a non-finite loss.")
                (loss / gradient_accumulation).backward()
        nonlocal gradient_summary
        current_summary = _check_finite_gradients(torch, trainable)
        if gradient_summary is None:
            gradient_summary = current_summary
        optimizer.step()
        check_finite_parameters()
        optimizer.zero_grad(set_to_none=True)
        if use_gpu:
            torch.cuda.synchronize()
            record_global_free_vram()
        return (time.perf_counter() - step_started) * 1000

    if use_gpu:
        torch.cuda.reset_peak_memory_stats()
    for _ in range(CALIBRATION_WARMUP_STEPS):
        optimizer_step()
    if use_gpu:
        torch.cuda.reset_peak_memory_stats()
        record_global_free_vram()
    measured_step_times = [
        optimizer_step() for _ in range(CALIBRATION_MEASURED_STEPS)
    ]
    if use_gpu:
        torch.cuda.synchronize()
        peak_vram_mb = int(torch.cuda.max_memory_reserved() / (1024 * 1024))
        total_vram_bytes = int(
            torch.cuda.get_device_properties(torch.cuda.current_device()).total_memory
        )
        total_vram_mb = int(total_vram_bytes / (1024 * 1024))
        vram_headroom_mb = _conservative_vram_headroom_mb(
            total_vram_bytes,
            int(torch.cuda.max_memory_reserved()),
            observed_global_free_vram_bytes,
        )
        torch.cuda.empty_cache()
    else:
        peak_vram_mb = None
        total_vram_mb = None
        vram_headroom_mb = None
    elapsed_ms = int((time.perf_counter() - started) * 1000)
    print(
        json.dumps(
            {
                "protocol": PROTOCOL,
                "localOnly": LOCAL_ONLY,
                "qualified": True,
                "modelId": request["modelId"],
                "method": method,
                "computeDevice": requested_device,
                "device": device_name,
                "precision": "bf16" if use_bf16 else "fp16" if use_gpu else "fp32",
                "forwardBackward": True,
                "optimizerStep": True,
                "batchSize": batch_size,
                "gradientAccumulation": gradient_accumulation,
                "maxSequenceLength": sequence_length,
                "warmupSteps": CALIBRATION_WARMUP_STEPS,
                "measuredSteps": CALIBRATION_MEASURED_STEPS,
                "stepTimeMs": int(round(statistics.median(measured_step_times))),
                "stepTimeMsP95": int(round(_nearest_rank_p95(measured_step_times))),
                "peakVramMb": peak_vram_mb,
                "vramTotalMb": total_vram_mb,
                "vramHeadroomMb": vram_headroom_mb,
                "elapsedMs": elapsed_ms,
                "reason": None,
                **(
                    gradient_summary
                    or {
                        "trainableParameterCount": len(trainable),
                        "gradientParameterCount": 0,
                        "nonzeroGradientParameterCount": 0,
                        "missingGradientParameterNames": [],
                    }
                ),
            },
            separators=(",", ":"),
        )
    )
    return 0


def _example_text(record: dict[str, Any]) -> str:
    text = record.get("text")
    if isinstance(text, str) and text.strip():
        return text.strip()
    response = record.get("response", record.get("completion"))
    return f"User: {str(record['prompt']).strip()}\nAssistant: {str(response).strip()}"


def _example_prompt_prefix(record: dict[str, Any]) -> str:
    """Return the prompt-only prefix for completion-masked training labels.

    Plain-text records have no prompt/response split, so no masking applies.
    """
    text = record.get("text")
    if isinstance(text, str) and text.strip():
        return ""
    return f"User: {str(record['prompt']).strip()}\nAssistant: "


def completion_only_labels(input_ids: list[int], prompt_token_count: int) -> list[int]:
    """Mask prompt tokens (HF ignore index -100) so loss trains only on the
    completion. Bounded: never masks more tokens than the record contains."""
    if prompt_token_count <= 0:
        return list(input_ids)
    masked = min(int(prompt_token_count), len(input_ids))
    return [-100] * masked + list(input_ids[masked:])


def training_labels(
    input_ids: list[int],
    prompt_token_count: int = 0,
    attention_mask: list[int] | None = None,
) -> list[int]:
    """Build loss labels for every text row, masking prompt and pad positions.

    Plain ``text`` records still need labels: otherwise the Transformers
    collator omits ``labels`` and a causal model returns logits without a
    supervised loss. Padding is masked here as well as in the collator so the
    contract remains correct for both single rows and padded batches.
    """
    if attention_mask is not None and len(attention_mask) != len(input_ids):
        raise ValueError("Attention mask must match the encoded input length.")
    labels = completion_only_labels(input_ids, prompt_token_count)
    if attention_mask is None:
        return labels
    return [label if int(mask) else -100 for label, mask in zip(labels, attention_mask)]


def _load_media_frames(record: dict[str, Any]) -> list[Any]:
    """Decode one verified local image or uniformly sample bounded video frames."""
    from PIL import Image

    path = Path(str(record["mediaPath"]))
    if record.get("mediaType") == "image":
        with Image.open(path) as image:
            return [image.convert("RGB").copy()]
    import av

    planned = int(record.get("plannedFrames", 8))
    frames: list[Any] = []
    with av.open(str(path), mode="r") as container:
        stream = container.streams.video[0]
        total = int(stream.frames or 0)
        if total > 0:
            targets = {
                round(index * max(0, total - 1) / max(1, planned - 1))
                for index in range(planned)
            }
            for index, frame in enumerate(container.decode(stream)):
                if index in targets:
                    frames.append(frame.to_image().convert("RGB"))
                if len(frames) >= min(planned, total):
                    break
        else:
            import random

            reservoir: list[tuple[int, Any]] = []
            generator = random.Random(7)
            for index, frame in enumerate(container.decode(stream)):
                image = frame.to_image().convert("RGB")
                if len(reservoir) < planned:
                    reservoir.append((index, image))
                else:
                    replacement = generator.randint(0, index)
                    if replacement < planned:
                        reservoir[replacement] = (index, image)
            frames = [image for _, image in sorted(reservoir)]
    if not frames:
        _fail("A verified local video example contains no decodable frames.")
    return frames


def train(request_path: str) -> int:
    request, summary = _read_request(request_path)

    # Force the model/runtime libraries into offline mode. The parent process
    # must prepare a verified local model directory before this command runs.
    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["TRANSFORMERS_OFFLINE"] = "1"
    os.environ["TOKENIZERS_PARALLELISM"] = "false"

    try:
        import torch
        from transformers import (
            AutoModelForCausalLM,
            AutoModelForImageTextToText,
            AutoProcessor,
            AutoTokenizer,
            DataCollatorForSeq2Seq,
            Trainer,
            TrainingArguments,
        )
    except Exception as error:
        _fail(f"Verified local training libraries are unavailable: {type(error).__name__}.")

    method = str(request["method"])
    config = request["trainingConfig"]
    training_device = _require_training_device(torch, str(config["computeDevice"]))
    use_gpu = training_device == "gpu"
    model_path = str(request["baseModelPath"])
    output_dir = Path(str(request["outputDir"]))
    resume_checkpoint = request.get("resumeFromCheckpoint")
    if output_dir.exists() and not resume_checkpoint:
        _fail("Output directory already exists; choose a new version directory.")
    if resume_checkpoint and not output_dir.is_dir():
        _fail("Resume output directory is unavailable.")

    def load_records(path: str) -> list[dict[str, Any]]:
        records: list[dict[str, Any]] = []
        with Path(path).open("r", encoding="utf-8") as stream:
            for line in stream:
                if line.strip():
                    records.append(json.loads(line))
        return records

    dataset = load_records(str(request["datasetPath"]))
    validation_dataset = load_records(str(request["validationDatasetPath"]))
    multimodal = any(record.get("mediaType") in ("image", "video") for record in dataset + validation_dataset)

    model_kwargs: dict[str, Any] = {
        "local_files_only": True,
        "trust_remote_code": False,
    }
    if method == "qlora":
        try:
            from transformers import BitsAndBytesConfig
            import bitsandbytes  # noqa: F401
        except Exception as error:
            _fail(f"QLoRA libraries are unavailable: {type(error).__name__}.")
        model_kwargs["quantization_config"] = BitsAndBytesConfig(
            load_in_4bit=True,
            bnb_4bit_quant_type="nf4",
            bnb_4bit_use_double_quant=True,
            bnb_4bit_compute_dtype=(
                torch.bfloat16
                if hasattr(torch.cuda, "is_bf16_supported")
                and torch.cuda.is_bf16_supported()
                else torch.float16
            ),
        )
        # `auto` may offload weights to host RAM. A GPU-only request must keep
        # the complete trainable model on the selected CUDA device or fail.
        model_kwargs["device_map"] = {"": 0}
    elif use_gpu:
        model_kwargs["torch_dtype"] = (
            torch.bfloat16
            if hasattr(torch.cuda, "is_bf16_supported")
            and torch.cuda.is_bf16_supported()
            else torch.float16
        )

    processor = None
    if multimodal:
        processor = AutoProcessor.from_pretrained(
            model_path, local_files_only=True, trust_remote_code=False
        )
        tokenizer = processor.tokenizer
    else:
        tokenizer = AutoTokenizer.from_pretrained(
            model_path,
            local_files_only=True,
            trust_remote_code=False,
        )
    if tokenizer.pad_token_id is None:
        tokenizer.pad_token = tokenizer.eos_token
    model = (
        AutoModelForImageTextToText.from_pretrained(model_path, **model_kwargs)
        if multimodal
        else AutoModelForCausalLM.from_pretrained(model_path, **model_kwargs)
    )

    if method in ("lora", "qlora"):
        try:
            from peft import LoraConfig, get_peft_model, prepare_model_for_kbit_training
        except Exception as error:
            _fail(f"PEFT libraries are unavailable: {type(error).__name__}.")
        if method == "qlora":
            model = prepare_model_for_kbit_training(model)
        model = get_peft_model(
            model,
            LoraConfig(
                r=int(config["loraRank"]),
                lora_alpha=int(config["loraAlpha"]),
                lora_dropout=float(config["loraDropout"]),
                bias="none",
                task_type="CAUSAL_LM",
                target_modules=_target_modules_for_training(request, multimodal),
            ),
        )

    max_length = min(
        int(getattr(tokenizer, "model_max_length", config["maxSequenceLength"])),
        int(config["maxSequenceLength"]),
    )

    def tokenize(record: dict[str, Any]) -> dict[str, Any]:
        if record.get("mediaType") in ("image", "video"):
            if processor is None:
                _fail("The verified multimodal processor is unavailable.")
            frames = _load_media_frames(record)
            media_content = [{"type": "image"} for _ in frames]
            user_content = [*media_content, {"type": "text", "text": str(record["prompt"]).strip()}]
            prompt_messages = [{"role": "user", "content": user_content}]
            full_messages = [
                *prompt_messages,
                {"role": "assistant", "content": [{"type": "text", "text": str(record.get("response", record.get("completion"))).strip()}]},
            ]
            prompt_text = processor.apply_chat_template(prompt_messages, add_generation_prompt=True)
            full_text = processor.apply_chat_template(full_messages, add_generation_prompt=False)
            encoded_batch = processor(
                text=full_text,
                images=frames,
                truncation=True,
                max_length=max_length,
                return_tensors="pt",
            )
            prompt_batch = processor(
                text=prompt_text,
                images=frames,
                truncation=True,
                max_length=max_length,
                return_tensors="pt",
            )
            encoded = {key: value.squeeze(0) for key, value in encoded_batch.items()}
            attention_mask = encoded.get("attention_mask")
            encoded["labels"] = torch.tensor(
                training_labels(
                    encoded["input_ids"].tolist(),
                    int(prompt_batch["input_ids"].shape[-1]),
                    attention_mask.tolist() if attention_mask is not None else None,
                ),
                dtype=torch.long,
            )
            return encoded
        encoded = tokenizer(
            _example_text(record),
            truncation=True,
            max_length=max_length,
        )
        prompt_prefix = _example_prompt_prefix(record)
        prompt_token_count = 0
        if prompt_prefix:
            prompt_ids = tokenizer(
                prompt_prefix,
                truncation=True,
                max_length=max_length,
            )["input_ids"]
            prompt_token_count = len(prompt_ids)
        encoded["labels"] = training_labels(
            encoded["input_ids"],
            prompt_token_count,
            encoded.get("attention_mask"),
        )
        return encoded

    tokenized = [tokenize(record) for record in dataset]
    tokenized_validation = [tokenize(record) for record in validation_dataset]

    class ListDataset(torch.utils.data.Dataset):
        def __init__(self, rows: list[dict[str, Any]]) -> None:
            self.rows = rows

        def __len__(self) -> int:
            return len(self.rows)

        def __getitem__(self, index: int) -> dict[str, Any]:
            return self.rows[index]

    class MultimodalCollator:
        def __call__(self, features: list[dict[str, Any]]) -> dict[str, Any]:
            text_rows = [
                {key: row[key] for key in ("input_ids", "attention_mask", "labels") if key in row}
                for row in features
            ]
            batch = DataCollatorForSeq2Seq(
                tokenizer=tokenizer, padding=True, label_pad_token_id=-100
            )(text_rows)
            tensor_keys = set().union(*(set(row) for row in features)) - {
                "input_ids", "attention_mask", "labels"
            }
            for key in tensor_keys:
                template = next(row[key] for row in features if key in row)
                values = [
                    row.get(key, template.new_zeros((0, *template.shape[1:])))
                    for row in features
                ]
                maximum = max(value.shape[0] for value in values)
                padded = []
                for value in values:
                    if value.shape[0] < maximum:
                        padding = value.new_zeros((maximum - value.shape[0], *value.shape[1:]))
                        value = torch.cat((value, padding), dim=0)
                    padded.append(value)
                batch[key] = torch.stack(padded)
            return batch
    output_dir.mkdir(parents=True, exist_ok=bool(resume_checkpoint))
    use_bf16 = bool(
        use_gpu
        and hasattr(torch.cuda, "is_bf16_supported")
        and torch.cuda.is_bf16_supported()
    )
    arguments = TrainingArguments(
        **_compatible_training_arguments(
            TrainingArguments,
            {
                "output_dir": str(output_dir),
                "overwrite_output_dir": False,
                "num_train_epochs": float(config["epochs"]),
                "max_steps": (
                    int(config["maxSteps"]) if config["maxSteps"] is not None else -1
                ),
                "per_device_train_batch_size": int(config["batchSize"]),
                "per_device_eval_batch_size": int(config["batchSize"]),
                "gradient_accumulation_steps": int(config["gradientAccumulation"]),
                "learning_rate": float(config["learningRate"]),
                "seed": int(config["seed"]),
                "data_seed": int(config["seed"]),
                "do_eval": True,
                "eval_strategy": "epoch",
                "logging_steps": 1,
                "save_strategy": "steps",
                "save_steps": max(1, min(50, int(config["maxSteps"] or 50))),
                "save_total_limit": 2,
                "report_to": [],
                "dataloader_num_workers": 0,
                "use_cpu": not use_gpu,
                "fp16": bool(use_gpu and not use_bf16),
                "bf16": use_bf16,
            },
        )
    )
    trainer = Trainer(
        model=model,
        args=arguments,
        train_dataset=ListDataset(tokenized),
        eval_dataset=ListDataset(tokenized_validation),
        data_collator=(
            MultimodalCollator()
            if multimodal
            else DataCollatorForSeq2Seq(
                tokenizer=tokenizer,
                padding=True,
                label_pad_token_id=-100,
            )
        ),
    )
    # Native Rust consumes stdout as one strict JSON completion receipt. The
    # Transformers trainer writes progress and metric dictionaries to stdout,
    # so keep the whole noisy lifecycle on stderr and reserve stdout for the
    # final protocol object below.
    training_result, evaluation_metrics = _run_training_lifecycle(
        trainer,
        resume_checkpoint,
        output_dir,
        tokenizer,
        processor,
    )
    (output_dir / "vibespace-training.json").write_text(
        json.dumps(
            {
                **summary,
                "artifactType": "adapter" if method in ("lora", "qlora") else "full-model",
                "baseModelPath": model_path,
                "schemaVersion": request.get("schemaVersion", 1),
                "requestedConfig": config,
                "effectiveConfig": {
                    **config,
                    "precision": (
                        "bf16"
                        if use_bf16
                        else "fp16"
                        if use_gpu
                        else "fp32"
                    ),
                },
                "targetModules": request.get("targetModules"),
                "datasetSha256": _sha256_file(Path(str(request["datasetPath"]))),
                "validationDatasetSha256": _sha256_file(
                    Path(str(request["validationDatasetPath"]))
                ),
                "evaluationMetrics": {
                    key: value
                    for key, value in evaluation_metrics.items()
                    if isinstance(value, (int, float))
                },
                "trainingMetrics": {
                    key: value
                    for key, value in training_result.metrics.items()
                    if isinstance(value, (int, float))
                },
            },
            separators=(",", ":"),
        ),
        encoding="utf-8",
    )
    print(
        json.dumps(
            {
                **summary,
                "completed": True,
                "artifactPath": str(output_dir),
            },
            separators=(",", ":"),
        )
    )
    return 0


def validate_request(request_path: str) -> int:
    _, summary = _read_request(request_path)
    print(json.dumps(summary, separators=(",", ":")))
    return 0


def _run_training_lifecycle(
    trainer: Any,
    resume_checkpoint: str | None,
    output_dir: Path,
    tokenizer: Any,
    processor: Any,
) -> tuple[Any, dict[str, Any]]:
    """Run noisy Transformers work away from the stdout protocol channel."""
    with contextlib.redirect_stdout(sys.stderr):
        training_result = trainer.train(resume_from_checkpoint=resume_checkpoint or None)
        evaluation_metrics = trainer.evaluate()
        trainer.save_model(str(output_dir))
        tokenizer.save_pretrained(str(output_dir))
        if processor is not None:
            processor.save_pretrained(str(output_dir))
    return training_result, evaluation_metrics


def _read_inference_request(request_path: str) -> dict[str, Any]:
    path = _absolute_path(request_path, "requestPath")
    if not path.is_file() or path.stat().st_size > MAX_REQUEST_BYTES:
        _fail("Inference request is missing or exceeds the safe size limit.")
    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, dict) or set(payload) - ALLOWED_INFERENCE_KEYS:
        _fail("Inference request contains unsupported fields.")
    if payload.get("protocol") != PROTOCOL or payload.get("localOnly") is not True:
        _fail("Inference request must match the local-only worker protocol.")
    method = payload.get("method")
    if method not in ALLOWED_METHODS:
        _fail("Inference method is not supported.")
    model = _absolute_path(payload.get("baseModelPath"), "baseModelPath")
    artifact = _absolute_path(payload.get("artifactPath"), "artifactPath")
    response = _absolute_path(payload.get("responsePath"), "responsePath")
    if not model.is_dir() or not (model / "config.json").is_file():
        _fail("Base model must be a verified local Transformers directory.")
    if not artifact.is_dir() or not (artifact / "vibespace-training.json").is_file():
        _fail("Training artifact metadata is missing.")
    if response.parent != artifact.parent or response.exists():
        _fail("Inference response must be a new file inside the private job directory.")
    metadata = json.loads(
        (artifact / "vibespace-training.json").read_text(encoding="utf-8")
    )
    if (
        not isinstance(metadata, dict)
        or metadata.get("protocol") != PROTOCOL
        or metadata.get("localOnly") is not True
        or metadata.get("valid") is not True
        or metadata.get("method") != method
        or Path(str(metadata.get("baseModelPath", ""))).resolve(strict=False) != model
    ):
        _fail("Training artifact metadata does not match the inference request.")
    messages = payload.get("messages")
    if (
        not isinstance(messages, list)
        or not messages
        or len(messages) > MAX_INFERENCE_MESSAGES
    ):
        _fail("Inference requires 1 to 64 messages.")
    total_chars = 0
    normalized_messages: list[dict[str, str]] = []
    for message in messages:
        if not isinstance(message, dict) or set(message) != {"role", "content"}:
            _fail("Inference messages contain unsupported fields.")
        role = message.get("role")
        content = message.get("content")
        if (
            role not in ALLOWED_MESSAGE_ROLES
            or not isinstance(content, str)
            or not content.strip()
        ):
            _fail("Inference messages require a supported role and non-empty text.")
        total_chars += len(content)
        if total_chars > MAX_INFERENCE_CHARS:
            _fail("Inference context exceeds the safe size limit.")
        normalized_messages.append({"role": role, "content": content})
    return {
        **payload,
        "baseModelPath": str(model),
        "artifactPath": str(artifact),
        "responsePath": str(response),
        "messages": normalized_messages,
        "modelModalities": metadata.get("modelModalities", ["text"]),
        "maxOutputTokens": _bounded_integer(
            payload.get("maxOutputTokens"), "maxOutputTokens", 1, 4096
        ),
    }


def infer(request_path: str) -> int:
    request = _read_inference_request(request_path)
    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["TRANSFORMERS_OFFLINE"] = "1"
    os.environ["TOKENIZERS_PARALLELISM"] = "false"
    try:
        import torch
        from transformers import (
            AutoModelForCausalLM,
            AutoModelForImageTextToText,
            AutoProcessor,
            AutoTokenizer,
        )
    except Exception as error:
        _fail(f"Verified local inference libraries are unavailable: {type(error).__name__}.")

    model_path = str(request["baseModelPath"])
    artifact_path = str(request["artifactPath"])
    method = str(request["method"])
    multimodal = any(
        value in ("image", "video") for value in request.get("modelModalities", [])
    )
    processor = (
        AutoProcessor.from_pretrained(
            artifact_path, local_files_only=True, trust_remote_code=False
        )
        if multimodal
        else None
    )
    tokenizer = (
        processor.tokenizer
        if processor is not None
        else AutoTokenizer.from_pretrained(
            artifact_path,
            local_files_only=True,
            trust_remote_code=False,
        )
    )
    if tokenizer.pad_token_id is None:
        tokenizer.pad_token = tokenizer.eos_token
    if tokenizer.pad_token_id is None or tokenizer.eos_token_id is None:
        _fail("The trained model tokenizer has no safe generation boundary.")
    model_source = artifact_path if method == "full" else model_path
    model_class = AutoModelForImageTextToText if multimodal else AutoModelForCausalLM
    model = model_class.from_pretrained(
        model_source, local_files_only=True, trust_remote_code=False, torch_dtype="auto"
    )
    if method in ("lora", "qlora"):
        try:
            from peft import PeftModel
        except Exception as error:
            _fail(f"PEFT inference libraries are unavailable: {type(error).__name__}.")
        model = PeftModel.from_pretrained(
            model,
            artifact_path,
            is_trainable=False,
            local_files_only=True,
        )
    device = "cuda" if torch.cuda.is_available() else "cpu"
    model.to(device)
    model.eval()
    messages = request["messages"]
    if getattr(tokenizer, "chat_template", None):
        prompt = tokenizer.apply_chat_template(
            messages,
            tokenize=False,
            add_generation_prompt=True,
        )
    else:
        prompt = "\n\n".join(
            f"{message['role'].capitalize()}: {message['content']}"
            for message in messages
        )
        prompt += "\n\nAssistant:"
    configured_context = int(getattr(model.config, "max_position_embeddings", 4096))
    context_tokens = max(256, min(configured_context, 16384))
    output_budget = min(int(request["maxOutputTokens"]), context_tokens - 1)
    encoded = (
        processor(
            text=prompt,
            images=None,
            return_tensors="pt",
            truncation=True,
            max_length=context_tokens - output_budget,
        )
        if processor is not None
        else tokenizer(
            prompt,
            return_tensors="pt",
            truncation=True,
            max_length=context_tokens - output_budget,
        )
    )
    encoded = {key: value.to(device) for key, value in encoded.items()}
    input_tokens = int(encoded["input_ids"].shape[-1])
    with torch.inference_mode():
        generated = model.generate(
            **encoded,
            max_new_tokens=output_budget,
            do_sample=False,
            pad_token_id=tokenizer.pad_token_id,
            eos_token_id=tokenizer.eos_token_id,
        )
    output_ids = generated[0][input_tokens:]
    text = tokenizer.decode(output_ids, skip_special_tokens=True).strip()
    if not text:
        _fail("The verified local model returned an empty response.")
    response_path = Path(str(request["responsePath"]))
    temporary = response_path.with_suffix(".tmp")
    temporary.write_text(
        json.dumps(
            {
                "protocol": PROTOCOL,
                "localOnly": LOCAL_ONLY,
                "completed": True,
                "method": method,
                "text": text,
                "inputTokens": input_tokens,
                "outputTokens": int(output_ids.shape[-1]),
            },
            separators=(",", ":"),
        ),
        encoding="utf-8",
    )
    temporary.replace(response_path)
    return 0


def _fail(message: str) -> None:
    raise ValueError(message)


def _absolute_path(value: Any, field: str) -> Path:
    if not isinstance(value, str) or not value.strip():
        _fail(f"{field} must be a non-empty absolute path.")
    path = Path(value)
    if not path.is_absolute():
        _fail(f"{field} must be an absolute path.")
    return path.resolve(strict=False)


def _training_compute_device(value: Any) -> str:
    if value not in ("gpu", "cpu"):
        _fail("computeDevice must be either gpu or cpu.")
    return str(value)


def _require_training_device(torch_module: Any, requested: str) -> str:
    device = _training_compute_device(requested)
    if device == "gpu" and not bool(torch_module.cuda.is_available()):
        _fail("GPU-only training requires a compatible local CUDA GPU and runtime.")
    return device


def _compatible_training_arguments(
    training_arguments_type: Any, requested: dict[str, Any]
) -> dict[str, Any]:
    parameters = inspect.signature(training_arguments_type.__init__).parameters
    if any(parameter.kind is inspect.Parameter.VAR_KEYWORD for parameter in parameters.values()):
        return dict(requested)
    unsupported = set(requested) - set(parameters)
    unexpected = unsupported - {"overwrite_output_dir"}
    if unexpected:
        _fail(
            "The installed Transformers runtime has unsupported training arguments: "
            + ", ".join(sorted(unexpected))
            + "."
        )
    return {key: value for key, value in requested.items() if key not in unsupported}


def _bounded_integer(value: Any, field: str, minimum: int, maximum: int) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        _fail(f"{field} must be an integer.")
    if value < minimum or value > maximum:
        _fail(f"{field} must be between {minimum} and {maximum}.")
    return value


def _bounded_float(
    value: Any,
    field: str,
    minimum: float,
    maximum: float,
    *,
    minimum_inclusive: bool = False,
    maximum_inclusive: bool = True,
) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        _fail(f"{field} must be numeric.")
    normalized = float(value)
    lower_ok = normalized >= minimum if minimum_inclusive else normalized > minimum
    upper_ok = normalized <= maximum if maximum_inclusive else normalized < maximum
    if not lower_ok or not upper_ok:
        comparator = "at most" if maximum_inclusive else "less than"
        _fail(f"{field} must be greater than {minimum} and {comparator} {maximum}.")
    return normalized


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def main() -> int:
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("command", choices=("probe", "validate", "calibrate", "train", "infer"))
    parser.add_argument("request", nargs="?")
    args = parser.parse_args()
    try:
        if args.command == "probe":
            return probe()
        if args.command == "validate" and args.request:
            return validate_request(args.request)
        if args.command == "calibrate" and args.request:
            return calibrate(args.request)
        if args.command == "train" and args.request:
            return train(args.request)
        if args.command == "infer" and args.request:
            return infer(args.request)
        _fail("A request path is required.")
    except (OSError, UnicodeError, json.JSONDecodeError, ValueError) as error:
        print(
            json.dumps(
                {
                    "protocol": PROTOCOL,
                    "localOnly": LOCAL_ONLY,
                    "valid": False,
                    "error": str(error),
                },
                separators=(",", ":"),
            ),
            file=sys.stderr,
        )
        return 2


if __name__ == "__main__":
    sys.exit(main())
