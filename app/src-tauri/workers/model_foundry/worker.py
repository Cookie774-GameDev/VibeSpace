"""VibeSpace Model Foundry local training worker.

This source is embedded in the signed desktop application and copied into the
private app-data runtime only after an explicit user action. It never performs
cloud execution or uploads.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path
from typing import Any

PROTOCOL = 1
LOCAL_ONLY = True
MAX_REQUEST_BYTES = 128 * 1024
MAX_DATASET_BYTES = 512 * 1024 * 1024
MAX_EXAMPLES = 1_000_000
MAX_LINE_CHARS = 1_000_000
ALLOWED_METHODS = frozenset(("lora", "qlora", "full"))
ALLOWED_REQUEST_KEYS = frozenset(
    (
        "protocol",
        "localOnly",
        "method",
        "baseModelPath",
        "datasetPath",
        "outputDir",
        "resumeFromCheckpoint",
        "epochs",
        "maxSteps",
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


def probe() -> int:
    """Report installed training libraries without installing or downloading."""
    packages: dict[str, str | None] = {}
    for name in (
        "torch",
        "transformers",
        "datasets",
        "accelerate",
        "peft",
        "trl",
        "bitsandbytes",
    ):
        try:
            module = __import__(name)
            packages[name] = str(getattr(module, "__version__", "unknown"))
        except Exception:
            packages[name] = None
    core_ready = all(
        packages.get(name) for name in ("torch", "transformers", "datasets", "accelerate")
    )
    methods: list[str] = []
    precisions: list[str] = []
    cuda_ready = False
    bf16_ready = False
    if core_ready:
        methods.append("full")
        precisions.append("fp32")
        try:
            import torch

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
    if core_ready and packages.get("peft"):
        methods.append("lora")
    if (
        core_ready
        and packages.get("peft")
        and packages.get("bitsandbytes")
        and cuda_ready
    ):
        methods.append("qlora")
        precisions.extend(("int8", "int4"))
    ready = bool(methods)
    print(
        json.dumps(
            {
                "protocol": PROTOCOL,
                "localOnly": LOCAL_ONLY,
                "ready": ready,
                "packages": packages,
                "methods": methods,
                "modalities": ["text"] if ready else [],
                "precisions": list(dict.fromkeys(precisions)),
                "reason": (
                    None
                    if ready
                    else "Verified local training libraries are incomplete; cloud execution is disabled."
                ),
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
    dataset = _absolute_path(payload.get("datasetPath"), "datasetPath")
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
    if dataset.stat().st_size > MAX_DATASET_BYTES:
        _fail("Dataset exceeds the safe local size limit.")
    if output == model or output == dataset or model in output.parents:
        _fail("Output directory must be separate from source and base-model paths.")
    epochs = _bounded_integer(payload.get("epochs"), "epochs", 1, 20)
    max_steps = _bounded_integer(payload.get("maxSteps"), "maxSteps", 1, 1_000_000)

    examples = 0
    with dataset.open("r", encoding="utf-8") as stream:
        for line_number, line in enumerate(stream, start=1):
            if len(line) > MAX_LINE_CHARS:
                _fail(f"Dataset line {line_number} exceeds the safe size limit.")
            if not line.strip():
                continue
            try:
                record = json.loads(line)
            except json.JSONDecodeError as error:
                _fail(f"Dataset line {line_number} is invalid JSON: {error.msg}.")
            if not isinstance(record, dict):
                _fail(f"Dataset line {line_number} must be a JSON object.")
            text = record.get("text")
            prompt = record.get("prompt")
            response = record.get("response")
            has_text = isinstance(text, str) and bool(text.strip())
            has_pair = (
                isinstance(prompt, str)
                and bool(prompt.strip())
                and isinstance(response, str)
                and bool(response.strip())
            )
            if not has_text and not has_pair:
                _fail(
                    f"Dataset line {line_number} needs non-empty text or prompt/response fields."
                )
            examples += 1
            if examples > MAX_EXAMPLES:
                _fail("Dataset exceeds the safe example limit.")
    if examples == 0:
        _fail("Dataset contains no usable examples.")

    normalized = {
        **payload,
        "baseModelPath": str(model),
        "datasetPath": str(dataset),
        "outputDir": str(output),
        "resumeFromCheckpoint": (
            str(resume_checkpoint) if resume_checkpoint is not None else None
        ),
        "epochs": epochs,
        "maxSteps": max_steps,
    }
    summary = {
        "protocol": PROTOCOL,
        "localOnly": LOCAL_ONLY,
        "valid": True,
        "method": method,
        "examples": examples,
        "epochs": epochs,
        "maxSteps": max_steps,
    }
    return normalized, summary


def _example_text(record: dict[str, Any]) -> str:
    text = record.get("text")
    if isinstance(text, str) and text.strip():
        return text.strip()
    return f"User: {str(record['prompt']).strip()}\nAssistant: {str(record['response']).strip()}"


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


def train(request_path: str) -> int:
    request, summary = _read_request(request_path)

    # Force the model/runtime libraries into offline mode. The parent process
    # must prepare a verified local model directory before this command runs.
    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["TRANSFORMERS_OFFLINE"] = "1"
    os.environ["TOKENIZERS_PARALLELISM"] = "false"

    try:
        import torch
        from datasets import load_dataset
        from transformers import (
            AutoModelForCausalLM,
            AutoTokenizer,
            DataCollatorForLanguageModeling,
            Trainer,
            TrainingArguments,
        )
    except Exception as error:
        _fail(f"Verified local training libraries are unavailable: {type(error).__name__}.")

    method = str(request["method"])
    model_path = str(request["baseModelPath"])
    output_dir = Path(str(request["outputDir"]))
    resume_checkpoint = request.get("resumeFromCheckpoint")
    if output_dir.exists() and not resume_checkpoint:
        _fail("Output directory already exists; choose a new version directory.")
    if resume_checkpoint and not output_dir.is_dir():
        _fail("Resume output directory is unavailable.")

    model_kwargs: dict[str, Any] = {
        "local_files_only": True,
        "trust_remote_code": False,
    }
    if method == "qlora":
        if not torch.cuda.is_available():
            _fail("QLoRA requires a compatible local CUDA GPU.")
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
        model_kwargs["device_map"] = "auto"
    elif torch.cuda.is_available():
        model_kwargs["torch_dtype"] = (
            torch.bfloat16
            if hasattr(torch.cuda, "is_bf16_supported")
            and torch.cuda.is_bf16_supported()
            else torch.float16
        )

    tokenizer = AutoTokenizer.from_pretrained(
        model_path,
        local_files_only=True,
        trust_remote_code=False,
    )
    if tokenizer.pad_token_id is None:
        tokenizer.pad_token = tokenizer.eos_token
    model = AutoModelForCausalLM.from_pretrained(model_path, **model_kwargs)

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
                r=16,
                lora_alpha=32,
                lora_dropout=0.05,
                bias="none",
                task_type="CAUSAL_LM",
            ),
        )

    dataset = load_dataset(
        "json",
        data_files={"train": str(request["datasetPath"])},
        split="train",
    )

    max_length = min(int(getattr(tokenizer, "model_max_length", 2048)), 4096)

    def tokenize(record: dict[str, Any]) -> dict[str, Any]:
        encoded = tokenizer(
            _example_text(record),
            truncation=True,
            max_length=max_length,
        )
        prompt_prefix = _example_prompt_prefix(record)
        if prompt_prefix:
            prompt_ids = tokenizer(
                prompt_prefix,
                truncation=True,
                max_length=max_length,
            )["input_ids"]
            encoded["labels"] = completion_only_labels(encoded["input_ids"], len(prompt_ids))
        return encoded

    tokenized = dataset.map(
        tokenize,
        remove_columns=dataset.column_names,
        desc="Tokenizing local training examples",
    )
    output_dir.mkdir(parents=True, exist_ok=bool(resume_checkpoint))
    use_bf16 = bool(
        torch.cuda.is_available()
        and hasattr(torch.cuda, "is_bf16_supported")
        and torch.cuda.is_bf16_supported()
    )
    arguments = TrainingArguments(
        output_dir=str(output_dir),
        overwrite_output_dir=False,
        num_train_epochs=float(request["epochs"]),
        max_steps=int(request["maxSteps"]),
        per_device_train_batch_size=1,
        gradient_accumulation_steps=4,
        learning_rate=2e-4 if method in ("lora", "qlora") else 2e-5,
        logging_steps=1,
        save_strategy="steps",
        save_steps=max(1, min(50, int(request["maxSteps"]))),
        save_total_limit=2,
        report_to=[],
        dataloader_num_workers=0,
        fp16=bool(torch.cuda.is_available() and not use_bf16),
        bf16=use_bf16,
    )
    trainer = Trainer(
        model=model,
        args=arguments,
        train_dataset=tokenized,
        data_collator=DataCollatorForLanguageModeling(tokenizer=tokenizer, mlm=False),
    )
    trainer.train(resume_from_checkpoint=resume_checkpoint or None)
    trainer.save_model(str(output_dir))
    tokenizer.save_pretrained(str(output_dir))
    (output_dir / "vibespace-training.json").write_text(
        json.dumps(
            {
                **summary,
                "artifactType": "adapter" if method in ("lora", "qlora") else "full-model",
                "baseModelPath": model_path,
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
        from transformers import AutoModelForCausalLM, AutoTokenizer
    except Exception as error:
        _fail(f"Verified local inference libraries are unavailable: {type(error).__name__}.")

    model_path = str(request["baseModelPath"])
    artifact_path = str(request["artifactPath"])
    method = str(request["method"])
    tokenizer = AutoTokenizer.from_pretrained(
        artifact_path,
        local_files_only=True,
        trust_remote_code=False,
    )
    if tokenizer.pad_token_id is None:
        tokenizer.pad_token = tokenizer.eos_token
    if tokenizer.pad_token_id is None or tokenizer.eos_token_id is None:
        _fail("The trained model tokenizer has no safe generation boundary.")
    model_source = artifact_path if method == "full" else model_path
    model = AutoModelForCausalLM.from_pretrained(
        model_source,
        local_files_only=True,
        trust_remote_code=False,
        torch_dtype="auto",
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
    encoded = tokenizer(
        prompt,
        return_tensors="pt",
        truncation=True,
        max_length=context_tokens - output_budget,
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


def _bounded_integer(value: Any, field: str, minimum: int, maximum: int) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        _fail(f"{field} must be an integer.")
    if value < minimum or value > maximum:
        _fail(f"{field} must be between {minimum} and {maximum}.")
    return value


def main() -> int:
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("command", choices=("probe", "validate", "train", "infer"))
    parser.add_argument("request", nargs="?")
    args = parser.parse_args()
    try:
        if args.command == "probe":
            return probe()
        if args.command == "validate" and args.request:
            return validate_request(args.request)
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
