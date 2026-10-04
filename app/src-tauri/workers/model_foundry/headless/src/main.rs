#[path = "../../../../src/foundry_worker_supervisor.rs"]
mod worker_supervisor;

use serde::Deserialize;
use serde_json::json;
use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, ExitCode};
use std::time::Duration;
use worker_supervisor::{
    configure_hidden_worker_command, configure_worker_environment, validate_inference_receipt,
    validate_training_metadata, validate_training_receipt, verify_catalog_model_directory,
    verify_training_artifact_for_method, verify_worker_source_file,
    write_and_verify_training_artifact, write_bounded_log, WorkerRegistry, MAX_WORKER_LOG_BYTES,
    TRAINING_ARTIFACT_MANIFEST,
};

const INFERENCE_TIMEOUT: Duration = Duration::from_secs(10 * 60);
const MAX_REQUEST_BYTES: u64 = 1024 * 1024;
const MAX_INFERENCE_RESPONSE_BYTES: u64 = 4 * 1024 * 1024;

fn main() -> ExitCode {
    match execute() {
        Ok(result) => {
            println!("{result}");
            ExitCode::SUCCESS
        }
        Err(error) => {
            eprintln!("{error}");
            ExitCode::FAILURE
        }
    }
}

#[derive(Debug)]
struct Options {
    python: PathBuf,
    worker: PathBuf,
    runtime_root: PathBuf,
    request: PathBuf,
    model_id: String,
    job_id: String,
    compute_device: Option<String>,
    timeout_seconds: Option<u64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TrainingRequest {
    schema_version: u8,
    protocol: u8,
    local_only: bool,
    method: String,
    base_model_path: String,
    dataset_path: String,
    validation_dataset_path: String,
    output_dir: String,
    #[serde(default)]
    resume_from_checkpoint: Option<String>,
    training_config: serde_json::Value,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct InferenceRequest {
    protocol: u8,
    local_only: bool,
    method: String,
    base_model_path: String,
    artifact_path: String,
    response_path: String,
    messages: Vec<InferenceMessage>,
    max_output_tokens: u32,
    #[serde(default)]
    compute_device: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct InferenceMessage {
    role: String,
    content: String,
}

fn execute() -> Result<String, String> {
    let mut args = env::args_os().skip(1);
    let action = args
        .next()
        .and_then(|value| value.into_string().ok())
        .ok_or_else(usage)?;
    if matches!(action.as_str(), "-h" | "--help") {
        return Ok(usage());
    }
    let options = parse_options(args.collect())?;
    let python = regular_file(&options.python, "Python executable")?;
    let worker = verify_worker_source_file(&options.worker)?;
    fs::create_dir_all(&options.runtime_root)
        .map_err(|error| format!("Could not prepare the Model Foundry runtime root: {error}"))?;
    let runtime_root = safe_directory(&options.runtime_root, "Model Foundry runtime root")?;
    let request = regular_file(&options.request, "worker request")?;
    match action.as_str() {
        "train" => run_training(&options, &python, &worker, &runtime_root, &request),
        "infer" => run_inference(&options, &python, &worker, &runtime_root, &request),
        _ => Err(usage()),
    }
}

fn parse_options(args: Vec<std::ffi::OsString>) -> Result<Options, String> {
    let mut python = None;
    let mut worker = None;
    let mut runtime_root = None;
    let mut request = None;
    let mut model_id = None;
    let mut job_id = None;
    let mut compute_device = None;
    let mut timeout_seconds = None;
    let mut values = args.into_iter();
    while let Some(key) = values.next() {
        let key = key
            .into_string()
            .map_err(|_| "Headless worker flags must be valid UTF-8.".to_string())?;
        let value = values
            .next()
            .ok_or_else(|| format!("Missing value for {key}. {}", usage()))?;
        match key.as_str() {
            "--python" if python.is_none() => python = Some(PathBuf::from(value)),
            "--worker" if worker.is_none() => worker = Some(PathBuf::from(value)),
            "--runtime-root" if runtime_root.is_none() => runtime_root = Some(PathBuf::from(value)),
            "--request" if request.is_none() => request = Some(PathBuf::from(value)),
            "--model-id" if model_id.is_none() => {
                model_id = Some(
                    value
                        .into_string()
                        .map_err(|_| "Model id must be valid UTF-8.".to_string())?,
                )
            }
            "--job-id" if job_id.is_none() => {
                job_id = Some(
                    value
                        .into_string()
                        .map_err(|_| "Job id must be valid UTF-8.".to_string())?,
                )
            }
            "--compute-device" if compute_device.is_none() => {
                compute_device = Some(
                    value
                        .into_string()
                        .map_err(|_| "Compute device must be valid UTF-8.".to_string())?,
                )
            }
            "--timeout-seconds" if timeout_seconds.is_none() => {
                let timeout = value
                    .into_string()
                    .map_err(|_| "Timeout must be valid UTF-8.".to_string())?
                    .parse::<u64>()
                    .map_err(|_| "Timeout must be between 1 and 86400 seconds.".to_string())?;
                if !(1..=86_400).contains(&timeout) {
                    return Err("Timeout must be between 1 and 86400 seconds.".into());
                }
                timeout_seconds = Some(timeout);
            }
            _ => {
                return Err(format!(
                    "Unknown or duplicate headless worker option {key}. {}",
                    usage()
                ))
            }
        }
    }
    let options = Options {
        python: python.ok_or_else(usage)?,
        worker: worker.ok_or_else(usage)?,
        runtime_root: runtime_root.ok_or_else(usage)?,
        request: request.ok_or_else(usage)?,
        model_id: model_id.ok_or_else(usage)?,
        job_id: job_id.ok_or_else(usage)?,
        compute_device,
        timeout_seconds,
    };
    if options.job_id.len() < 5
        || options.job_id.len() > 80
        || !options
            .job_id
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '_' | '-'))
    {
        return Err("Invalid headless Model Foundry job identifier.".into());
    }
    Ok(options)
}

fn run_training(
    options: &Options,
    python: &Path,
    worker: &Path,
    runtime_root: &Path,
    request_path: &Path,
) -> Result<String, String> {
    let request_bytes = read_request(request_path)?;
    let request: TrainingRequest = serde_json::from_slice(&request_bytes)
        .map_err(|_| "The training request is malformed.".to_string())?;
    if request.schema_version != 2
        || request.protocol != worker_supervisor::WORKER_PROTOCOL
        || !request.local_only
        || !matches!(request.method.as_str(), "lora" | "qlora" | "full")
        || request.resume_from_checkpoint.is_some()
    {
        return Err(
            "The headless training request is unsupported or not a clean local run.".into(),
        );
    }
    if request
        .training_config
        .get("method")
        .and_then(serde_json::Value::as_str)
        != Some(request.method.as_str())
    {
        return Err("The requested training method does not match its configuration.".into());
    }
    let compute_device = request
        .training_config
        .get("computeDevice")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| "The training request omitted its compute device.".to_string())?;
    if !matches!(compute_device, "gpu" | "cpu") {
        return Err("The training request selected an unsupported compute device.".into());
    }
    if options
        .compute_device
        .as_deref()
        .is_some_and(|value| value != compute_device)
    {
        return Err("The CLI compute device does not match the training request.".into());
    }
    let (model, model_path) =
        verify_catalog_model_directory(Path::new(&request.base_model_path), &options.model_id)?;
    let job_dir = request_path
        .parent()
        .ok_or_else(|| "The training request has no private job directory.".to_string())?
        .canonicalize()
        .map_err(|_| "The private training job directory is unavailable.".to_string())?;
    verify_jsonl_file(&request.dataset_path, "training dataset")?;
    verify_jsonl_file(&request.validation_dataset_path, "validation dataset")?;
    let expected_artifact = PathBuf::from(&request.output_dir);
    verify_new_artifact_path(&expected_artifact, &job_dir)?;

    let mut command = Command::new(python);
    command
        .arg(worker)
        .arg("train")
        .arg(request_path)
        .current_dir(runtime_root);
    configure_hidden_worker_command(&mut command);
    configure_worker_environment(&mut command, runtime_root)?;
    let registry = WorkerRegistry::new();
    let execution = registry.run(
        &options.job_id,
        command,
        MAX_WORKER_LOG_BYTES,
        Some(Duration::from_secs(
            options.timeout_seconds.unwrap_or(3_600),
        )),
        "training worker",
    )?;
    write_bounded_log(&job_dir.join("worker.stdout.log"), &execution.stdout)?;
    write_bounded_log(&job_dir.join("worker.stderr.log"), &execution.stderr)?;
    if execution.timed_out {
        return Err("The headless training worker timed out; its bounded logs were saved.".into());
    }
    if !execution.status.success() {
        return Err(format!(
            "The headless training worker exited with {}; its bounded logs were saved.",
            execution.status
        ));
    }
    validate_training_receipt(&execution.stdout, &request.method, &expected_artifact)?;
    let metadata = validate_training_metadata(&expected_artifact, compute_device, true)?
        .ok_or_else(|| {
            "The training worker returned no device or evaluation evidence.".to_string()
        })?;
    let artifact = write_and_verify_training_artifact(&expected_artifact, &request.method)?;
    let result = json!({
        "operation": "train",
        "completed": true,
        "modelId": model.id,
        "modelSource": model.source_id,
        "modelRevision": model.revision,
        "baseModelPath": model_path,
        "method": request.method,
        "artifactPath": expected_artifact,
        "artifactManifest": expected_artifact.join(TRAINING_ARTIFACT_MANIFEST),
        "artifactFileCount": artifact.file_count,
        "artifactStorageBytes": artifact.storage_bytes,
        "artifactSha256": artifact.sha256,
        "deviceEvidence": metadata,
    });
    serde_json::to_string(&result)
        .map_err(|error| format!("Could not encode training result: {error}"))
}

fn run_inference(
    options: &Options,
    python: &Path,
    worker: &Path,
    runtime_root: &Path,
    request_path: &Path,
) -> Result<String, String> {
    let request_bytes = read_request(request_path)?;
    let request: InferenceRequest = serde_json::from_slice(&request_bytes)
        .map_err(|_| "The inference request is malformed.".to_string())?;
    let compute_device = options
        .compute_device
        .as_deref()
        .filter(|value| matches!(*value, "gpu" | "cpu"))
        .ok_or_else(|| "Inference requires --compute-device gpu or cpu.".to_string())?;
    if request.protocol != worker_supervisor::WORKER_PROTOCOL
        || !request.local_only
        || !matches!(request.method.as_str(), "lora" | "qlora" | "full")
        || request
            .compute_device
            .as_deref()
            .is_some_and(|value| value != compute_device)
        || request.messages.is_empty()
        || request.messages.len() > 64
        || request.messages.iter().any(|message| {
            !matches!(message.role.as_str(), "system" | "user" | "assistant")
                || message.content.trim().is_empty()
        })
        || request
            .messages
            .iter()
            .try_fold(0_usize, |total, message| {
                total.checked_add(message.content.chars().count())
            })
            .is_none_or(|total| total > 128 * 1024)
        || !(1..=4_096).contains(&request.max_output_tokens)
    {
        return Err("The headless inference request is invalid or mismatched.".into());
    }
    let (model, model_path) =
        verify_catalog_model_directory(Path::new(&request.base_model_path), &options.model_id)?;
    if model_path
        != Path::new(&request.base_model_path)
            .canonicalize()
            .map_err(|_| "The verified trainable base model is unavailable.".to_string())?
    {
        return Err("The inference base model path changed during validation.".into());
    }
    let job_dir = request_path
        .parent()
        .ok_or_else(|| "The inference request has no private job directory.".to_string())?
        .canonicalize()
        .map_err(|_| "The private inference job directory is unavailable.".to_string())?;
    let artifact_path = PathBuf::from(&request.artifact_path);
    verify_existing_artifact_path(&artifact_path, &job_dir)?;
    let artifact = verify_training_artifact_for_method(&artifact_path, &request.method)?;
    let response_path = PathBuf::from(&request.response_path);
    verify_response_path(&response_path, &job_dir)?;

    let mut command = Command::new(python);
    command
        .arg(worker)
        .arg("infer")
        .arg(request_path)
        .current_dir(runtime_root);
    configure_hidden_worker_command(&mut command);
    configure_worker_environment(&mut command, runtime_root)?;
    let registry = WorkerRegistry::new();
    let execution = registry.run(
        &options.job_id,
        command,
        MAX_WORKER_LOG_BYTES,
        Some(Duration::from_secs(
            options
                .timeout_seconds
                .unwrap_or(INFERENCE_TIMEOUT.as_secs()),
        )),
        "inference worker",
    )?;
    write_bounded_log(&job_dir.join("inference.stdout.log"), &execution.stdout)?;
    write_bounded_log(&job_dir.join("inference.stderr.log"), &execution.stderr)?;
    if execution.timed_out {
        return Err(
            "The headless inference worker exceeded its time limit; bounded logs were saved."
                .into(),
        );
    }
    if !execution.status.success() {
        return Err(format!(
            "The headless inference worker exited with {}; its bounded logs were saved.",
            execution.status
        ));
    }
    let response_bytes = read_limited_response(&response_path)?;
    let response =
        validate_inference_receipt(&response_bytes, &request.method, Some(compute_device))?;
    let result = json!({
        "operation": "infer",
        "completed": true,
        "modelId": model.id,
        "modelSource": model.source_id,
        "modelRevision": model.revision,
        "method": request.method,
        "artifactPath": artifact_path,
        "artifactFileCount": artifact.file_count,
        "artifactStorageBytes": artifact.storage_bytes,
        "artifactSha256": artifact.sha256,
        "text": response.text,
        "inputTokens": response.input_tokens,
        "outputTokens": response.output_tokens,
        "device": response.device,
        "computeDevice": response.compute_device,
        "cpuOffload": response.cpu_offload,
    });
    serde_json::to_string(&result)
        .map_err(|error| format!("Could not encode inference result: {error}"))
}

fn read_request(path: &Path) -> Result<Vec<u8>, String> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|_| "The Model Foundry worker request is unavailable.".to_string())?;
    if !metadata.is_file()
        || metadata.file_type().is_symlink()
        || metadata.len() > MAX_REQUEST_BYTES
    {
        return Err("The Model Foundry worker request is unsafe or too large.".into());
    }
    fs::read(path)
        .map_err(|error| format!("Could not read the Model Foundry worker request: {error}"))
}

fn read_limited_response(path: &Path) -> Result<Vec<u8>, String> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|_| "Local inference returned no completion evidence.".to_string())?;
    if !metadata.is_file()
        || metadata.file_type().is_symlink()
        || metadata.len() > MAX_INFERENCE_RESPONSE_BYTES
    {
        return Err("Local inference completion evidence is invalid.".into());
    }
    fs::read(path).map_err(|error| format!("Could not read local inference evidence: {error}"))
}

fn regular_file(path: &Path, label: &str) -> Result<PathBuf, String> {
    let metadata =
        fs::symlink_metadata(path).map_err(|_| format!("The {label} is unavailable."))?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err(format!("The {label} path is unsafe."));
    }
    path.canonicalize()
        .map_err(|_| format!("The {label} is unavailable."))
}

fn safe_directory(path: &Path, label: &str) -> Result<PathBuf, String> {
    let metadata =
        fs::symlink_metadata(path).map_err(|_| format!("The {label} is unavailable."))?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(format!("The {label} path is unsafe."));
    }
    path.canonicalize()
        .map_err(|_| format!("The {label} is unavailable."))
}

fn verify_jsonl_file(path: &str, label: &str) -> Result<PathBuf, String> {
    let path = Path::new(path);
    let canonical = path
        .canonicalize()
        .map_err(|_| format!("The local {label} is unavailable."))?;
    let metadata =
        fs::metadata(&canonical).map_err(|_| format!("The local {label} is unavailable."))?;
    if !metadata.is_file()
        || canonical
            .extension()
            .and_then(|value| value.to_str())
            .is_none_or(|value| !value.eq_ignore_ascii_case("jsonl"))
    {
        return Err(format!("The {label} must be one local JSONL file."));
    }
    Ok(canonical)
}

fn verify_new_artifact_path(path: &Path, job_dir: &Path) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "The training artifact path is invalid.".to_string())?
        .canonicalize()
        .map_err(|_| "The private training job directory is unavailable.".to_string())?;
    if parent != job_dir
        || path.file_name().and_then(|name| name.to_str()) != Some("weight-artifact")
        || path_entry_exists(path)?
    {
        return Err(
            "The training artifact must be a new weight-artifact folder inside its job.".into(),
        );
    }
    Ok(())
}

fn verify_existing_artifact_path(path: &Path, job_dir: &Path) -> Result<(), String> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|_| "The verified Model Foundry weight artifact is unavailable.".to_string())?;
    let canonical = path
        .canonicalize()
        .map_err(|_| "The verified Model Foundry weight artifact is unavailable.".to_string())?;
    if !metadata.is_dir()
        || metadata.file_type().is_symlink()
        || canonical.parent() != Some(job_dir)
        || canonical.file_name().and_then(|name| name.to_str()) != Some("weight-artifact")
    {
        return Err("The Model Foundry weight artifact escaped its private job directory.".into());
    }
    Ok(())
}

fn verify_response_path(path: &Path, job_dir: &Path) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "The inference response path is invalid.".to_string())?
        .canonicalize()
        .map_err(|_| "The private inference job directory is unavailable.".to_string())?;
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or_default();
    if parent != job_dir
        || !name.starts_with("inference-")
        || !name.ends_with(".response.json")
        || path_entry_exists(path)?
    {
        return Err(
            "The inference response path is stale or outside its private job directory.".into(),
        );
    }
    Ok(())
}

fn path_entry_exists(path: &Path) -> Result<bool, String> {
    match fs::symlink_metadata(path) {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(format!(
            "Could not inspect the private worker path: {error}"
        )),
    }
}

fn usage() -> String {
    "Usage: foundry-headless <train|infer> --python <exe> --worker <worker.py> --runtime-root <dir> --request <json> --model-id <catalog-id> --job-id <id> [--compute-device <gpu|cpu>] [--timeout-seconds <1..86400>] (timeout defaults: train 3600s, infer 600s)".into()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::OsString;

    #[test]
    fn options_require_explicit_worker_runtime_request_model_and_job() {
        let result = parse_options(vec![
            OsString::from("--python"),
            OsString::from("python.exe"),
        ]);
        assert!(result.is_err());
        let options = parse_options(
            [
                ("--python", "python.exe"),
                ("--worker", "worker.py"),
                ("--runtime-root", "runtime"),
                ("--request", "request.json"),
                ("--model-id", "smollm2-135m-instruct"),
                ("--job-id", "debater-r1"),
                ("--compute-device", "gpu"),
            ]
            .into_iter()
            .flat_map(|(key, value)| [OsString::from(key), OsString::from(value)])
            .collect(),
        )
        .unwrap();
        assert_eq!(options.model_id, "smollm2-135m-instruct");
        assert_eq!(options.compute_device.as_deref(), Some("gpu"));
        assert_eq!(options.timeout_seconds, None);
    }

    #[test]
    fn timeout_option_rejects_zero_and_unbounded_values() {
        for value in ["0", "86401"] {
            let result = parse_options(vec![
                OsString::from("--timeout-seconds"),
                OsString::from(value),
            ]);
            assert!(result.is_err(), "accepted timeout {value}");
        }
    }

    #[test]
    fn output_path_must_be_new_and_nested_in_its_job_directory() {
        let job = env::temp_dir().join(format!("foundry-headless-job-{}", std::process::id()));
        fs::create_dir_all(&job).unwrap();
        assert!(verify_new_artifact_path(
            &job.join("weight-artifact"),
            &job.canonicalize().unwrap()
        )
        .is_ok());
        assert!(
            verify_new_artifact_path(&job.join("other"), &job.canonicalize().unwrap()).is_err()
        );
        fs::remove_dir_all(job).unwrap();
    }
}
