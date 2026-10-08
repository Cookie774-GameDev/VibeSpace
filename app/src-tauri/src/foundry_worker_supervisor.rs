use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::io::{BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, ExitStatus, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

#[path = "foundry_worker_job.rs"]
mod worker_job;
use worker_job::WorkerChild;

pub(crate) const WORKER_PROTOCOL: u8 = 1;
pub(crate) const TRAINING_WORKER_SOURCE: &str = include_str!("../workers/model_foundry/worker.py");
pub(crate) const TRAINING_CATALOG_SOURCE: &str =
    include_str!("../workers/model_foundry/training-models.json");
pub(crate) const TRAINING_ARTIFACT_MANIFEST: &str = ".vibespace-artifact.json";
pub(crate) const TRAINING_METADATA_FILE: &str = "vibespace-training.json";
pub(crate) const MODEL_MARKER_FILE: &str = ".vibespace-model.json";
pub(crate) const MAX_WORKER_LOG_BYTES: usize = 256 * 1024;
const MAX_ARTIFACT_FILES: usize = 4_096;
const MAX_ARTIFACT_DEPTH: usize = 8;
const MAX_ARTIFACT_MANIFEST_BYTES: u64 = 4 * 1024 * 1024;
const MAX_TRAINING_METADATA_BYTES: u64 = 1024 * 1024;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TrainingCatalogFile {
    pub(crate) path: String,
    pub(crate) bytes: u64,
    pub(crate) sha256: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TrainingCatalogModel {
    pub(crate) id: String,
    pub(crate) label: String,
    pub(crate) source_id: String,
    pub(crate) revision: String,
    pub(crate) license: String,
    pub(crate) license_url: String,
    pub(crate) gated: bool,
    pub(crate) parameters_b: f64,
    pub(crate) download_bytes: u64,
    pub(crate) expected_ram_gb: u16,
    pub(crate) expected_vram_gb: u16,
    pub(crate) context_tokens: u32,
    pub(crate) precision: String,
    pub(crate) modalities: Vec<String>,
    pub(crate) speed: String,
    pub(crate) quality: String,
    pub(crate) cpu_practical: bool,
    pub(crate) files: Vec<TrainingCatalogFile>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TrainingCatalogManifest {
    schema_version: u8,
    updated_at: String,
    source_host: String,
    models: Vec<TrainingCatalogModel>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct TrainingArtifactFile {
    path: String,
    bytes: u64,
    sha256: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct TrainingArtifactManifest {
    schema_version: u8,
    method: String,
    file_count: usize,
    storage_bytes: u64,
    sha256: String,
    files: Vec<TrainingArtifactFile>,
}

#[derive(Clone, Debug, Serialize)]
pub(crate) struct TrainingArtifactEvidence {
    pub(crate) file_count: usize,
    pub(crate) storage_bytes: u64,
    pub(crate) sha256: String,
}

#[derive(Clone, Debug, Serialize)]
pub(crate) struct TrainingMetadataEvidence {
    pub(crate) requested_device: String,
    pub(crate) effective_device: String,
    pub(crate) parameter_devices: Vec<String>,
    pub(crate) optimizer_state_devices: Vec<String>,
    pub(crate) gpu_name: Option<String>,
    pub(crate) peak_allocated_vram_bytes: Option<u64>,
    pub(crate) train_loss: f64,
    pub(crate) eval_loss: f64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TrainingRunReceipt {
    protocol: u8,
    local_only: bool,
    completed: bool,
    method: String,
    artifact_path: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct InferenceReceipt {
    pub(crate) protocol: u8,
    pub(crate) local_only: bool,
    pub(crate) completed: bool,
    pub(crate) method: String,
    pub(crate) text: String,
    pub(crate) input_tokens: u64,
    pub(crate) output_tokens: u64,
    #[serde(default)]
    pub(crate) device: Option<String>,
    #[serde(default)]
    pub(crate) compute_device: Option<String>,
    #[serde(default)]
    pub(crate) cpu_offload: Option<bool>,
}

pub(crate) struct WorkerExecution {
    pub(crate) status: ExitStatus,
    pub(crate) stdout: Vec<u8>,
    pub(crate) stderr: Vec<u8>,
    pub(crate) timed_out: bool,
}

#[derive(Default)]
pub(crate) struct WorkerRegistry {
    active: Mutex<BTreeMap<String, Arc<Mutex<WorkerChild>>>>,
}

impl WorkerRegistry {
    pub(crate) fn new() -> Self {
        Self::default()
    }

    #[allow(dead_code)] // Desktop command guards and scoped cancellation use these methods.
    pub(crate) fn is_empty(&self) -> Result<bool, String> {
        Ok(self
            .active
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .is_empty())
    }

    #[allow(dead_code)] // Used by desktop coordination tests and cancellation observers.
    pub(crate) fn is_active(&self, worker_id: &str) -> Result<bool, String> {
        Ok(self
            .active
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .contains_key(worker_id))
    }

    #[allow(dead_code)] // The desktop exposes cancellation; headless runs are synchronous.
    pub(crate) fn cancel(&self, worker_id: &str) -> Result<bool, String> {
        let child = self
            .active
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .get(worker_id)
            .cloned();
        let Some(child) = child else {
            return Ok(false);
        };
        let mut process = child
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        match process.try_wait()? {
            Some(_) => Ok(false),
            None => process.terminate_tree().map(|()| true),
        }
    }

    pub(crate) fn run(
        &self,
        worker_id: &str,
        mut command: Command,
        capture_limit: usize,
        timeout: Option<Duration>,
        operation: &str,
    ) -> Result<WorkerExecution, String> {
        validate_worker_id(worker_id)?;

        // Hold the registry while checking the identifier and spawning so a duplicate
        // operation can never start an unregistered child that races cancellation.
        let mut active = self
            .active
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if active.contains_key(worker_id) {
            return Err(format!("This Model Foundry {operation} is already active."));
        }
        command
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let mut process = WorkerChild::spawn(&mut command)?;
        let (stdout, stderr) = process.take_pipes();
        let child = Arc::new(Mutex::new(process));
        active.insert(worker_id.to_string(), child.clone());
        drop(active);

        let mut registration = WorkerRegistrationGuard {
            registry: &self.active,
            worker_id,
            child: child.clone(),
            confirmed_stopped: false,
        };
        let (stdout, stderr) = match (stdout, stderr) {
            (Some(stdout), Some(stderr)) => (stdout, stderr),
            _ => {
                let cleanup = stop_and_reap(&child);
                registration.confirmed_stopped = cleanup.is_ok();
                return Err(format!(
                    "Local Model Foundry {operation} output pipes were unavailable{}.",
                    cleanup
                        .err()
                        .map(|error| format!("; child cleanup failed: {error}"))
                        .unwrap_or_default()
                ));
            }
        };
        let stdout_thread = match thread::Builder::new()
            .name(format!("foundry-{worker_id}-stdout"))
            .spawn(move || drain_bounded(stdout, capture_limit))
        {
            Ok(thread) => thread,
            Err(error) => {
                let cleanup = stop_and_reap(&child);
                registration.confirmed_stopped = cleanup.is_ok();
                return Err(format!(
                    "Could not capture local Model Foundry {operation} stdout: {error}{}",
                    cleanup
                        .err()
                        .map(|error| format!("; child cleanup failed: {error}"))
                        .unwrap_or_default()
                ));
            }
        };
        let stderr_thread = match thread::Builder::new()
            .name(format!("foundry-{worker_id}-stderr"))
            .spawn(move || drain_bounded(stderr, capture_limit))
        {
            Ok(thread) => thread,
            Err(error) => {
                let cleanup = stop_and_reap(&child);
                registration.confirmed_stopped = cleanup.is_ok();
                if registration.confirmed_stopped {
                    let _ = stdout_thread.join();
                }
                return Err(format!(
                    "Could not capture local Model Foundry {operation} stderr: {error}{}",
                    cleanup
                        .err()
                        .map(|error| format!("; child cleanup failed: {error}"))
                        .unwrap_or_default()
                ));
            }
        };
        let started = Instant::now();
        let mut timed_out = false;
        let status = loop {
            let result = child
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .try_wait();
            match result {
                Ok(Some(status)) => {
                    registration.confirmed_stopped = true;
                    break status;
                }
                Ok(None) => {}
                Err(error) => {
                    registration.confirmed_stopped = stop_and_reap(&child).is_ok();
                    if registration.confirmed_stopped {
                        let _ = stdout_thread.join();
                        let _ = stderr_thread.join();
                    }
                    return Err(format!(
                        "Could not monitor the local Model Foundry {operation}: {error}"
                    ));
                }
            }
            if timeout.is_some_and(|limit| started.elapsed() >= limit) {
                timed_out = true;
                let status = match stop_and_reap(&child) {
                    Ok(status) => status,
                    Err(error) => {
                        return Err(format!(
                            "Could not stop the timed-out Model Foundry {operation}: {error}"
                        ));
                    }
                };
                registration.confirmed_stopped = true;
                break status;
            }
            thread::sleep(Duration::from_millis(100));
        };
        let stdout = stdout_thread
            .join()
            .map_err(|_| format!("Could not collect local Model Foundry {operation} stdout."))?;
        let stderr = stderr_thread
            .join()
            .map_err(|_| format!("Could not collect local Model Foundry {operation} stderr."))?;
        Ok(WorkerExecution {
            status,
            stdout,
            stderr,
            timed_out,
        })
    }
}

struct WorkerRegistrationGuard<'a> {
    registry: &'a Mutex<BTreeMap<String, Arc<Mutex<WorkerChild>>>>,
    worker_id: &'a str,
    child: Arc<Mutex<WorkerChild>>,
    confirmed_stopped: bool,
}

impl Drop for WorkerRegistrationGuard<'_> {
    fn drop(&mut self) {
        if !self.confirmed_stopped {
            self.confirmed_stopped = self
                .child
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .try_wait()
                .ok()
                .flatten()
                .is_some();
        }
        if !self.confirmed_stopped {
            // Keep the registration so a caller can still cancel/reap the exact child.
            return;
        }
        if let Ok(mut active) = self.registry.lock() {
            if active
                .get(self.worker_id)
                .is_some_and(|registered| Arc::ptr_eq(registered, &self.child))
            {
                active.remove(self.worker_id);
            }
        }
    }
}

fn stop_and_reap(child: &Arc<Mutex<WorkerChild>>) -> Result<ExitStatus, String> {
    let mut process = child
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    if let Some(status) = process.try_wait()? {
        return Ok(status);
    }
    let termination = process.terminate_tree();
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        match process.try_wait() {
            Ok(Some(status)) => return Ok(status),
            Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(25)),
            Ok(None) => {
                return Err(termination.err().unwrap_or_else(|| {
                    "Model Foundry worker tree did not close within five seconds.".to_string()
                }))
            }
            Err(error) => return Err(error),
        }
    }
}

pub(crate) fn configure_hidden_worker_command(command: &mut Command) {
    worker_job::configure_worker_command(command);
}

pub(crate) fn configure_worker_environment(
    command: &mut Command,
    root: &Path,
) -> Result<(), String> {
    let cache_root = root.join("worker-cache");
    let temp = cache_root.join("temp");
    let hf_home = cache_root.join("huggingface");
    let hf_hub = hf_home.join("hub");
    let paths = [
        ("TEMP", temp.clone()),
        ("TMP", temp.clone()),
        ("TMPDIR", temp),
        ("PIP_CACHE_DIR", cache_root.join("pip")),
        ("UV_CACHE_DIR", cache_root.join("uv")),
        ("HF_HOME", hf_home.clone()),
        ("HF_HUB_CACHE", hf_hub.clone()),
        ("HUGGINGFACE_HUB_CACHE", hf_hub),
        ("HF_XET_CACHE", hf_home.join("xet")),
        ("HF_ASSETS_CACHE", hf_home.join("assets")),
        ("HF_DATASETS_CACHE", hf_home.join("datasets")),
        ("TRANSFORMERS_CACHE", hf_home.join("transformers")),
        ("TORCH_HOME", cache_root.join("torch")),
        ("TORCHINDUCTOR_CACHE_DIR", cache_root.join("torch-inductor")),
        ("TRITON_CACHE_DIR", cache_root.join("triton")),
        ("CUDA_CACHE_PATH", cache_root.join("cuda")),
        ("PYTHONPYCACHEPREFIX", cache_root.join("python-bytecode")),
        ("XDG_CACHE_HOME", cache_root.join("xdg")),
        ("MPLCONFIGDIR", cache_root.join("matplotlib")),
    ];
    for (name, path) in paths {
        fs::create_dir_all(&path).map_err(|error| {
            format!("Could not prepare the private Model Foundry {name} directory: {error}")
        })?;
        command.env(name, path);
    }
    command
        .env("HF_HUB_OFFLINE", "1")
        .env("TRANSFORMERS_OFFLINE", "1")
        .env("HF_HUB_DISABLE_TELEMETRY", "1")
        .env("TOKENIZERS_PARALLELISM", "false");
    Ok(())
}

pub(crate) fn verify_worker_source_file(path: &Path) -> Result<PathBuf, String> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|_| "The local Model Foundry worker source is unavailable.".to_string())?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err("The local Model Foundry worker source is unsafe.".into());
    }
    let canonical = path
        .canonicalize()
        .map_err(|_| "The local Model Foundry worker source is unavailable.".to_string())?;
    let bytes = fs::read(&canonical).map_err(|error| {
        format!("Could not read the local Model Foundry worker source: {error}")
    })?;
    if bytes != TRAINING_WORKER_SOURCE.as_bytes() {
        return Err("The worker source does not match this headless supervisor build.".into());
    }
    Ok(canonical)
}

pub(crate) fn drain_bounded<R: Read>(mut reader: R, maximum: usize) -> Vec<u8> {
    let mut output = Vec::with_capacity(maximum.min(16 * 1024));
    let mut buffer = [0_u8; 8 * 1024];
    loop {
        let count = match reader.read(&mut buffer) {
            Ok(0) | Err(_) => break,
            Ok(count) => count,
        };
        let remaining = maximum.saturating_sub(output.len());
        if remaining > 0 {
            output.extend_from_slice(&buffer[..count.min(remaining)]);
        }
    }
    output
}

pub(crate) fn write_bounded_log(path: &Path, bytes: &[u8]) -> Result<(), String> {
    fs::write(path, &bytes[..bytes.len().min(MAX_WORKER_LOG_BYTES)])
        .map_err(|error| format!("Could not persist bounded Model Foundry worker log: {error}"))
}

pub(crate) fn training_catalog() -> Result<Vec<TrainingCatalogModel>, String> {
    let manifest: TrainingCatalogManifest = serde_json::from_str(TRAINING_CATALOG_SOURCE)
        .map_err(|error| format!("Verified training model catalog is invalid: {error}"))?;
    if manifest.schema_version != 1
        || manifest.source_host != "huggingface.co"
        || manifest.updated_at.trim().is_empty()
        || manifest.models.len() < 5
    {
        return Err("Verified training model catalog metadata is incomplete.".into());
    }
    let mut ids = BTreeSet::new();
    let mut sources = BTreeSet::new();
    for model in &manifest.models {
        let download_bytes = model.files.iter().try_fold(0_u64, |total, file| {
            total
                .checked_add(file.bytes)
                .ok_or_else(|| "Training model download size overflowed.".to_string())
        })?;
        let mut paths = BTreeSet::new();
        let source_parts = model.source_id.split('/').collect::<Vec<_>>();
        if !safe_catalog_component(&model.id)
            || model.label.trim().is_empty()
            || !ids.insert(model.id.clone())
            || !sources.insert((model.source_id.clone(), model.revision.clone()))
            || source_parts.len() != 2
            || !source_parts
                .iter()
                .all(|component| safe_catalog_component(component))
            || !valid_hex(&model.revision, 40)
            || model.license != "apache-2.0"
            || model.license_url != "https://www.apache.org/licenses/LICENSE-2.0"
            || model.gated
            || !model.parameters_b.is_finite()
            || model.parameters_b <= 0.0
            || model.expected_ram_gb == 0
            || model.expected_vram_gb == 0
            || model.context_tokens == 0
            || model.modalities.is_empty()
            || !model
                .modalities
                .iter()
                .all(|modality| matches!(modality.as_str(), "text" | "image" | "video" | "audio"))
            || !model.modalities.iter().any(|modality| modality == "text")
            || !matches!(model.speed.as_str(), "fast" | "medium" | "slow")
            || !matches!(model.quality.as_str(), "efficient" | "balanced" | "high")
            || model.files.is_empty()
            || model.download_bytes != download_bytes
            || !model.files.iter().all(|file| {
                file.bytes > 0
                    && valid_hex(&file.sha256, 64)
                    && !file.path.is_empty()
                    && !file.path.contains("..")
                    && !file.path.contains(['/', '\\'])
                    && safe_catalog_component(&file.path)
                    && paths.insert(file.path.clone())
            })
            || !paths.contains("config.json")
            || !paths.contains("model.safetensors")
        {
            return Err("Verified training model catalog contains an unsafe entry.".into());
        }
    }
    Ok(manifest.models)
}

pub(crate) fn catalog_model(model_id: &str) -> Result<TrainingCatalogModel, String> {
    training_catalog()?
        .into_iter()
        .find(|model| model.id == model_id)
        .ok_or_else(|| "The selected model has no verified local training manifest.".to_string())
}

pub(crate) fn verify_training_model_directory(
    model_root: &Path,
    model: &TrainingCatalogModel,
) -> Result<u64, String> {
    let root_metadata = fs::symlink_metadata(model_root)
        .map_err(|_| "The verified trainable base model is not installed.".to_string())?;
    if !root_metadata.is_dir() || root_metadata.file_type().is_symlink() {
        return Err("The verified trainable base model directory is unsafe.".into());
    }
    let entries = fs::read_dir(model_root)
        .map_err(|error| format!("Could not inspect trainable base model: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Could not inspect trainable base model: {error}"))?;
    if entries.iter().any(|entry| {
        entry.file_name().to_str().is_none_or(|name| {
            name != MODEL_MARKER_FILE && !model.files.iter().any(|file| file.path == name)
        })
    }) {
        return Err("Trainable base model contains unexpected or missing files.".into());
    }
    let mut total = 0_u64;
    for expected in &model.files {
        let path = model_root.join(&expected.path);
        let metadata = fs::symlink_metadata(&path)
            .map_err(|_| format!("Trainable base model file is missing: {}", expected.path))?;
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            return Err("Trainable base model contains an unsafe filesystem entry.".into());
        }
        let (bytes, sha256) = file_sha256(&path)?;
        if bytes != expected.bytes || sha256 != expected.sha256 {
            return Err(format!(
                "Trainable base model file failed integrity verification: {}",
                expected.path
            ));
        }
        total = total
            .checked_add(bytes)
            .ok_or_else(|| "Trainable base model size overflowed.".to_string())?;
    }
    if total != model.download_bytes {
        return Err("Trainable base model size does not match its verified manifest.".into());
    }
    Ok(total)
}

pub(crate) fn verify_catalog_model_directory(
    supplied_model_path: &Path,
    model_id: &str,
) -> Result<(TrainingCatalogModel, PathBuf), String> {
    let model = catalog_model(model_id)?;
    let model_path = supplied_model_path
        .canonicalize()
        .map_err(|_| "The verified trainable base model is not installed.".to_string())?;
    if model_path.file_name().and_then(|name| name.to_str()) != Some(model.id.as_str()) {
        return Err("The request base model path does not match the pinned catalog model.".into());
    }
    verify_training_model_directory(&model_path, &model)?;
    Ok((model, model_path))
}

pub(crate) fn validate_training_receipt(
    bytes: &[u8],
    method: &str,
    expected_artifact: &Path,
) -> Result<TrainingRunReceipt, String> {
    let response: TrainingRunReceipt = serde_json::from_slice(bytes).map_err(|_| {
        "The local training worker returned invalid completion evidence.".to_string()
    })?;
    if response.protocol != WORKER_PROTOCOL
        || !response.local_only
        || !response.completed
        || response.method != method
        || PathBuf::from(&response.artifact_path) != expected_artifact
    {
        return Err("The local training worker returned mismatched completion evidence.".into());
    }
    Ok(response)
}

pub(crate) fn validate_training_metadata(
    artifact_root: &Path,
    expected_device: &str,
    required: bool,
) -> Result<Option<TrainingMetadataEvidence>, String> {
    if !matches!(expected_device, "gpu" | "cpu") {
        return Err("Model Foundry requested an unsupported training device.".into());
    }
    let path = artifact_root.join(TRAINING_METADATA_FILE);
    let metadata = match fs::symlink_metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) if !required && error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("Training worker omitted its device and evaluation evidence.".into()),
    };
    if !metadata.is_file()
        || metadata.file_type().is_symlink()
        || metadata.len() > MAX_TRAINING_METADATA_BYTES
    {
        return Err("Training device and evaluation evidence is not a safe file.".into());
    }
    let contents = fs::read(&path).map_err(|error| {
        format!("Could not read training device and evaluation evidence: {error}")
    })?;
    let value: serde_json::Value = serde_json::from_slice(&contents)
        .map_err(|_| "Training device and evaluation evidence is malformed.".to_string())?;
    let has_new_device_evidence = value.get("deviceEvidence").is_some()
        || value
            .get("effectiveConfig")
            .and_then(serde_json::Value::as_object)
            .is_some_and(|effective| {
                effective.contains_key("device") || effective.contains_key("cpuOffload")
            });
    if !required && !has_new_device_evidence {
        // Older desktop artifacts contain their requested/effective configs but predate
        // device placement evidence. Keep those reloadable; once any new evidence appears,
        // validate the complete new contract below and reject partial/contradictory proof.
        return Ok(None);
    }
    let requested = value
        .get("requestedConfig")
        .and_then(serde_json::Value::as_object)
        .ok_or_else(|| "Training metadata omitted its requested configuration.".to_string())?;
    let effective = value
        .get("effectiveConfig")
        .and_then(serde_json::Value::as_object)
        .ok_or_else(|| "Training metadata omitted its effective configuration.".to_string())?;
    if requested
        .get("computeDevice")
        .and_then(serde_json::Value::as_str)
        != Some(expected_device)
    {
        return Err("Training metadata does not match the requested compute device.".into());
    }
    let mut effective_config = effective.clone();
    let effective_device = effective_config
        .remove("device")
        .and_then(|value| value.as_str().map(str::to_string))
        .ok_or_else(|| "Training metadata omitted the effective device.".to_string())?;
    if effective_config
        .remove("cpuOffload")
        .and_then(|value| value.as_bool())
        != Some(false)
    {
        return Err("Training metadata reports CPU offload or omitted its offload state.".into());
    }
    let precision = effective_config
        .remove("precision")
        .and_then(|value| value.as_str().map(str::to_string))
        .ok_or_else(|| "Training metadata omitted the effective precision.".to_string())?;
    if requested != &effective_config {
        return Err("Training metadata changed the requested training configuration.".into());
    }
    if !matches!(precision.as_str(), "bf16" | "fp16" | "fp32") {
        return Err("Training metadata reports an unsupported effective precision.".into());
    }
    let device_evidence = value
        .get("deviceEvidence")
        .and_then(serde_json::Value::as_object)
        .ok_or_else(|| "Training metadata omitted parameter device evidence.".to_string())?;
    if device_evidence
        .get("requested")
        .and_then(serde_json::Value::as_str)
        != Some(expected_device)
    {
        return Err("Training parameter device evidence does not match the request.".into());
    }
    let parameter_devices = device_evidence
        .get("parameterDevices")
        .and_then(serde_json::Value::as_array)
        .filter(|devices| !devices.is_empty())
        .ok_or_else(|| "Training metadata omitted parameter devices.".to_string())?
        .iter()
        .map(|device| {
            device
                .as_str()
                .map(str::to_string)
                .filter(|device| !device.is_empty())
                .ok_or_else(|| {
                    "Training metadata contains an invalid parameter device.".to_string()
                })
        })
        .collect::<Result<Vec<_>, _>>()?;
    let unique_devices = parameter_devices.iter().collect::<BTreeSet<_>>();
    if unique_devices.len() != parameter_devices.len() {
        return Err("Training metadata repeats parameter device evidence.".into());
    }
    let optimizer_state_devices = device_evidence
        .get("optimizerStateDevices")
        .and_then(serde_json::Value::as_array)
        .filter(|devices| !devices.is_empty())
        .ok_or_else(|| "Training metadata omitted optimizer-state devices.".to_string())?
        .iter()
        .map(|device| {
            device
                .as_str()
                .map(str::to_string)
                .filter(|device| !device.is_empty())
                .ok_or_else(|| {
                    "Training metadata contains an invalid optimizer-state device.".to_string()
                })
        })
        .collect::<Result<Vec<_>, _>>()?;
    let unique_optimizer_devices = optimizer_state_devices.iter().collect::<BTreeSet<_>>();
    if unique_optimizer_devices.len() != optimizer_state_devices.len() {
        return Err("Training metadata repeats optimizer-state device evidence.".into());
    }
    let expected_device_name = match expected_device {
        "gpu" => "cuda:",
        "cpu" => "cpu",
        _ => unreachable!(),
    };
    let devices_match = parameter_devices
        .iter()
        .all(|device| match expected_device {
            "gpu" => device
                .strip_prefix(expected_device_name)
                .is_some_and(|index| {
                    !index.is_empty() && index.chars().all(|c| c.is_ascii_digit())
                }),
            "cpu" => device == expected_device_name,
            _ => false,
        });
    let optimizer_devices_match =
        optimizer_state_devices
            .iter()
            .all(|device| match expected_device {
                "gpu" => device
                    .strip_prefix(expected_device_name)
                    .is_some_and(|index| {
                        !index.is_empty() && index.chars().all(|c| c.is_ascii_digit())
                    }),
                "cpu" => device == expected_device_name,
                _ => false,
            });
    let expected_effective_device = parameter_devices.contains(&effective_device)
        && match expected_device {
            "gpu" => effective_device.starts_with("cuda:"),
            "cpu" => effective_device == "cpu",
            _ => false,
        };
    if !devices_match || !optimizer_devices_match || !expected_effective_device {
        return Err(
            "Training metadata shows parameters or optimizer state outside the requested compute device.".into(),
        );
    }
    let gpu_name = device_evidence
        .get("gpuName")
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .map(str::to_string);
    let peak_allocated_vram_bytes = device_evidence
        .get("peakAllocatedVramBytes")
        .and_then(serde_json::Value::as_u64);
    if expected_device == "gpu"
        && (gpu_name.is_none() || peak_allocated_vram_bytes.unwrap_or(0) == 0)
    {
        return Err("GPU training metadata omitted the GPU identity or peak VRAM evidence.".into());
    }
    let train_loss = finite_metric(&value, "trainingMetrics", "train_loss")?;
    let eval_loss = finite_metric(&value, "evaluationMetrics", "eval_loss")?;
    Ok(Some(TrainingMetadataEvidence {
        requested_device: expected_device.into(),
        effective_device,
        parameter_devices,
        optimizer_state_devices,
        gpu_name,
        peak_allocated_vram_bytes,
        train_loss,
        eval_loss,
    }))
}

pub(crate) fn validate_inference_receipt(
    bytes: &[u8],
    method: &str,
    expected_device: Option<&str>,
) -> Result<InferenceReceipt, String> {
    let response: InferenceReceipt = serde_json::from_slice(bytes)
        .map_err(|_| "Local inference completion evidence is malformed.".to_string())?;
    if response.protocol != WORKER_PROTOCOL
        || !response.local_only
        || !response.completed
        || response.method != method
        || response.text.trim().is_empty()
    {
        return Err("Local inference completion evidence did not match the request.".into());
    }
    let has_any_device = response.device.is_some()
        || response.compute_device.is_some()
        || response.cpu_offload.is_some();
    let has_all_device = response.device.is_some()
        && response.compute_device.is_some()
        && response.cpu_offload.is_some();
    if has_any_device && !has_all_device {
        return Err("Local inference returned incomplete device evidence.".into());
    }
    if expected_device.is_some() && !has_all_device {
        return Err("Local inference omitted required device evidence.".into());
    }
    if let (Some(expected), Some(requested), Some(device), Some(cpu_offload)) = (
        expected_device,
        response.compute_device.as_deref(),
        response.device.as_deref(),
        response.cpu_offload,
    ) {
        if requested != expected
            || cpu_offload
            || !match expected {
                "gpu" => device.starts_with("cuda:"),
                "cpu" => device == "cpu",
                _ => false,
            }
        {
            return Err("Local inference ran on a different device or used CPU offload.".into());
        }
    }
    Ok(response)
}

fn finite_metric(value: &serde_json::Value, group: &str, name: &str) -> Result<f64, String> {
    value
        .get(group)
        .and_then(|group| group.get(name))
        .and_then(serde_json::Value::as_f64)
        .filter(|metric| metric.is_finite())
        .ok_or_else(|| format!("Training metadata omitted a finite {name} metric."))
}

pub(crate) fn safe_catalog_component(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | '-')
        })
}

pub(crate) fn valid_hex(value: &str, length: usize) -> bool {
    value.len() == length && value.chars().all(|character| character.is_ascii_hexdigit())
}

fn validate_worker_id(value: &str) -> Result<(), String> {
    if value.len() < 5
        || value.len() > 80
        || !value
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '_' | '-'))
    {
        return Err("Invalid Model Foundry worker identifier.".into());
    }
    Ok(())
}

pub(crate) fn file_sha256(path: &Path) -> Result<(u64, String), String> {
    let file = fs::File::open(path)
        .map_err(|error| format!("Could not inspect Model Foundry file: {error}"))?;
    let bytes = file
        .metadata()
        .map_err(|error| format!("Could not inspect Model Foundry file: {error}"))?
        .len();
    let mut reader = BufReader::new(file);
    let mut digest = Sha256::new();
    // CLI main threads and worker threads can have small stacks on Windows.
    // Keep the bounded streaming buffer on the heap rather than reserving 1 MiB
    // in every hashing call frame.
    let mut buffer = vec![0_u8; 1024 * 1024];
    loop {
        let count = reader
            .read(&mut buffer)
            .map_err(|error| format!("Could not hash Model Foundry file: {error}"))?;
        if count == 0 {
            break;
        }
        digest.update(&buffer[..count]);
    }
    Ok((bytes, format!("{:x}", digest.finalize())))
}

fn collect_artifact_files(
    root: &Path,
    directory: &Path,
    depth: usize,
    files: &mut Vec<TrainingArtifactFile>,
) -> Result<(), String> {
    if depth > MAX_ARTIFACT_DEPTH {
        return Err("Training artifact directory nesting exceeds the safe limit.".into());
    }
    let mut entries = fs::read_dir(directory)
        .map_err(|error| format!("Could not inspect training artifact directory: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Could not inspect training artifact directory: {error}"))?;
    entries.sort_by_key(|entry| entry.file_name());
    for entry in entries {
        let path = entry.path();
        let metadata = fs::symlink_metadata(&path)
            .map_err(|error| format!("Could not inspect training artifact entry: {error}"))?;
        if metadata.file_type().is_symlink() {
            return Err("Training artifacts may not contain symbolic links.".into());
        }
        if metadata.is_dir() {
            collect_artifact_files(root, &path, depth + 1, files)?;
            continue;
        }
        if !metadata.is_file() {
            return Err("Training artifact contains an unsupported filesystem entry.".into());
        }
        let relative = path
            .strip_prefix(root)
            .map_err(|_| "Training artifact escaped its verified root.".to_string())?
            .to_string_lossy()
            .replace('\\', "/");
        if relative == TRAINING_ARTIFACT_MANIFEST {
            continue;
        }
        if files.len() >= MAX_ARTIFACT_FILES {
            return Err("Training artifact contains too many files.".into());
        }
        let (bytes, sha256) = file_sha256(&path)?;
        files.push(TrainingArtifactFile {
            path: relative,
            bytes,
            sha256,
        });
    }
    Ok(())
}

fn artifact_manifest_from_files(
    method: &str,
    files: Vec<TrainingArtifactFile>,
) -> Result<TrainingArtifactManifest, String> {
    if !matches!(method, "lora" | "qlora" | "full") {
        return Err("Training artifact method is unsupported.".into());
    }
    if files.is_empty() {
        return Err("Training produced no artifact files.".into());
    }
    let storage_bytes = files.iter().try_fold(0_u64, |total, file| {
        total
            .checked_add(file.bytes)
            .ok_or_else(|| "Training artifact size overflowed.".to_string())
    })?;
    let mut aggregate = Sha256::new();
    for file in &files {
        aggregate.update(file.path.as_bytes());
        aggregate.update([0]);
        aggregate.update(file.bytes.to_le_bytes());
        aggregate.update(file.sha256.as_bytes());
        aggregate.update([0]);
    }
    Ok(TrainingArtifactManifest {
        schema_version: 1,
        method: method.to_string(),
        file_count: files.len(),
        storage_bytes,
        sha256: format!("{:x}", aggregate.finalize()),
        files,
    })
}

fn current_artifact_manifest(
    root: &Path,
    method: &str,
) -> Result<TrainingArtifactManifest, String> {
    let metadata = fs::symlink_metadata(root)
        .map_err(|_| "Training artifact directory is missing.".to_string())?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err("Training artifact directory is unsafe.".into());
    }
    let mut files = Vec::new();
    collect_artifact_files(root, root, 0, &mut files)?;
    files.sort_by(|left, right| left.path.cmp(&right.path));
    artifact_manifest_from_files(method, files)
}

pub(crate) fn write_and_verify_training_artifact(
    root: &Path,
    method: &str,
) -> Result<TrainingArtifactEvidence, String> {
    let manifest = current_artifact_manifest(root, method)?;
    let bytes = serde_json::to_vec_pretty(&manifest)
        .map_err(|error| format!("Could not encode training artifact manifest: {error}"))?;
    if bytes.len() as u64 > MAX_ARTIFACT_MANIFEST_BYTES {
        return Err("Training artifact manifest exceeds the safe size limit.".into());
    }
    let path = root.join(TRAINING_ARTIFACT_MANIFEST);
    let temporary = root.join(format!("{TRAINING_ARTIFACT_MANIFEST}.tmp"));
    fs::write(&temporary, bytes)
        .map_err(|error| format!("Could not write training artifact manifest: {error}"))?;
    fs::rename(&temporary, &path)
        .map_err(|error| format!("Could not activate training artifact manifest: {error}"))?;
    verify_training_artifact(root)
}

pub(crate) fn verify_training_artifact(root: &Path) -> Result<TrainingArtifactEvidence, String> {
    let path = root.join(TRAINING_ARTIFACT_MANIFEST);
    let metadata = fs::symlink_metadata(&path)
        .map_err(|_| "Training artifact manifest is missing.".to_string())?;
    if !metadata.is_file()
        || metadata.file_type().is_symlink()
        || metadata.len() > MAX_ARTIFACT_MANIFEST_BYTES
    {
        return Err("Training artifact manifest is invalid or exceeds the safe size limit.".into());
    }
    let expected: TrainingArtifactManifest = serde_json::from_slice(
        &fs::read(&path)
            .map_err(|error| format!("Could not read training artifact manifest: {error}"))?,
    )
    .map_err(|error| format!("Training artifact manifest is invalid: {error}"))?;
    if expected.schema_version != 1
        || expected.file_count != expected.files.len()
        || expected.file_count == 0
        || expected.file_count > MAX_ARTIFACT_FILES
    {
        return Err("Training artifact manifest metadata is invalid.".into());
    }
    let current = current_artifact_manifest(root, &expected.method)?;
    if current.files != expected.files
        || current.file_count != expected.file_count
        || current.storage_bytes != expected.storage_bytes
        || current.sha256 != expected.sha256
    {
        return Err("Training artifact failed integrity verification.".into());
    }
    Ok(TrainingArtifactEvidence {
        file_count: current.file_count,
        storage_bytes: current.storage_bytes,
        sha256: current.sha256,
    })
}

pub(crate) fn verify_training_artifact_for_method(
    root: &Path,
    method: &str,
) -> Result<TrainingArtifactEvidence, String> {
    let path = root.join(TRAINING_ARTIFACT_MANIFEST);
    let metadata = fs::symlink_metadata(&path)
        .map_err(|_| "Training artifact manifest is missing.".to_string())?;
    if !metadata.is_file()
        || metadata.file_type().is_symlink()
        || metadata.len() > MAX_ARTIFACT_MANIFEST_BYTES
    {
        return Err("Training artifact manifest is invalid or exceeds the safe size limit.".into());
    }
    let manifest: TrainingArtifactManifest = serde_json::from_slice(
        &fs::read(&path)
            .map_err(|error| format!("Could not read training artifact manifest: {error}"))?,
    )
    .map_err(|error| format!("Training artifact manifest is invalid: {error}"))?;
    if manifest.method != method {
        return Err("Training artifact method does not match the inference request.".into());
    }
    verify_training_artifact(root)
}

fn validate_export_member(name: &str) -> Result<(), String> {
    if name.is_empty()
        || name.contains(['\\', ':', '\0', '<', '>', '"', '|', '?', '*'])
        || name.starts_with('/')
    {
        return Err("Artifact export contains an unsafe relative path.".into());
    }
    for component in name.split('/') {
        let stem = component
            .split('.')
            .next()
            .unwrap_or("")
            .to_ascii_uppercase();
        if component.is_empty()
            || component == "."
            || component == ".."
            || component.ends_with(['.', ' '])
            || component.chars().any(char::is_control)
            || matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
            || (stem.len() == 4
                && (stem.starts_with("COM") || stem.starts_with("LPT"))
                && matches!(stem.as_bytes()[3], b'1'..=b'9'))
        {
            return Err("Artifact export contains a non-portable relative path.".into());
        }
    }
    Ok(())
}

fn export_metadata_is_link(metadata: &fs::Metadata) -> bool {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::fs::MetadataExt;
        // Junctions and other reparse points also redirect filesystem access.
        metadata.file_attributes() & 0x400 != 0
    }
    #[cfg(not(target_os = "windows"))]
    {
        metadata.file_type().is_symlink()
    }
}

pub(crate) fn checked_export_source(path: &Path, protected_root: &Path) -> Result<PathBuf, String> {
    let protected = protected_root
        .canonicalize()
        .map_err(|_| "Model Foundry private storage is unavailable.".to_string())?;
    // Accept the configured spelling or its canonical spelling, never a foreign alias.
    let relative = path
        .strip_prefix(protected_root)
        .or_else(|_| path.strip_prefix(&protected))
        .map_err(|_| "Export source escaped Model Foundry private storage.".to_string())?;
    let mut checked = protected.clone();
    for part in relative.components() {
        let std::path::Component::Normal(name) = part else {
            return Err("Export source contains an unsafe path component.".into());
        };
        checked.push(name);
        let metadata =
            fs::symlink_metadata(&checked).map_err(|_| "Export source is missing.".to_string())?;
        if export_metadata_is_link(&metadata) {
            return Err("Export source may not traverse a symbolic link or junction.".into());
        }
    }
    let canonical = checked
        .canonicalize()
        .map_err(|_| "Export source is missing.".to_string())?;
    if !canonical.starts_with(&protected) {
        return Err("Export source escaped Model Foundry private storage.".into());
    }
    Ok(canonical)
}

fn checked_export_destination(
    destination: &Path,
    extension: &str,
    protected_root: &Path,
) -> Result<PathBuf, String> {
    if !destination.is_absolute()
        || destination.components().any(|part| {
            matches!(
                part,
                std::path::Component::ParentDir | std::path::Component::CurDir
            )
        })
        || !destination
            .extension()
            .and_then(|value| value.to_str())
            .is_some_and(|value| value.eq_ignore_ascii_case(extension))
    {
        return Err(format!(
            "Model Foundry exports require an absolute .{extension} destination."
        ));
    }
    let name = destination
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "Export destination has no valid file name.".to_string())?;
    validate_export_member(name)?;
    let requested_parent = destination
        .parent()
        .ok_or_else(|| "Export destination has no parent directory.".to_string())?;
    // Do not let a chosen path traverse a link into another directory after admission.
    for ancestor in requested_parent.ancestors() {
        let metadata = fs::symlink_metadata(ancestor)
            .map_err(|_| "Export destination directory is unavailable.".to_string())?;
        if export_metadata_is_link(&metadata) || !metadata.is_dir() {
            return Err("Export destination directories may not be symbolic links.".into());
        }
    }
    let parent = requested_parent
        .canonicalize()
        .map_err(|_| "Export destination directory is unavailable.".to_string())?;
    let protected = protected_root
        .canonicalize()
        .map_err(|_| "Model Foundry private storage is unavailable.".to_string())?;
    if parent.starts_with(&protected) {
        return Err("Export destination must be outside Model Foundry private storage.".into());
    }
    let target = parent.join(name);
    match fs::symlink_metadata(&target) {
        Ok(_) => return Err("Export destination already exists; choose a new file.".into()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(format!("Could not inspect export destination: {error}")),
    }
    Ok(target)
}

// Publication keeps this exact file open. The scratch name is never reopened
// as the source of a successful export.
struct ExportScratch {
    path: PathBuf,
    file: fs::File,
    published: bool,
}

impl Drop for ExportScratch {
    fn drop(&mut self) {
        #[cfg(target_os = "windows")]
        if !self.published {
            use std::os::windows::io::AsRawHandle;
            use windows::Win32::Foundation::HANDLE;
            use windows::Win32::Storage::FileSystem::{
                SetFileInformationByHandle, FileDispositionInfo, FILE_DISPOSITION_INFO,
            };
            let disposition = FILE_DISPOSITION_INFO { DeleteFile: true.into() };
            // Mark the retained handle for deletion, never a possibly replaced name.
            let _ = unsafe {
                SetFileInformationByHandle(HANDLE(self.file.as_raw_handle()), FileDispositionInfo,
                    (&disposition as *const FILE_DISPOSITION_INFO).cast(),
                    std::mem::size_of::<FILE_DISPOSITION_INFO>() as u32)
            };
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            // Do not remove a replacement that is no longer our scratch object.
            if let (Ok(opened), Ok(named)) = (self.file.metadata(), fs::symlink_metadata(&self.path)) {
                if opened.dev() == named.dev() && opened.ino() == named.ino() {
                    let _ = fs::remove_file(&self.path);
                }
            }
        }
    }
}

struct ExportDirectory {
    path: PathBuf,
    file: fs::File,
}

fn open_export_directory_file(path: &Path) -> Result<fs::File, String> {
    let mut options = fs::OpenOptions::new();
    options.read(true);
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::fs::OpenOptionsExt;
        // BACKUP_SEMANTICS | OPEN_REPARSE_POINT: inspect the named directory
        // itself, and deny delete/rename while its handle remains open.
        options.custom_flags(0x0220_0000).share_mode(3);
    }
    let file = options
        .open(path)
        .map_err(|error| format!("Could not retain export directory: {error}"))?;
    let metadata = file
        .metadata()
        .map_err(|error| format!("Could not inspect export directory: {error}"))?;
    if !metadata.is_dir() || export_metadata_is_link(&metadata) {
        return Err("Export directory must not be a link or reparse point.".into());
    }
    Ok(file)
}

fn open_export_directories(parent: &Path) -> Result<Vec<ExportDirectory>, String> {
    #[cfg(target_os = "windows")]
    let paths = parent
        .ancestors()
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect::<Vec<_>>();
    #[cfg(not(target_os = "windows"))]
    let paths = vec![parent];
    let mut retained = Vec::new();
    for path in paths {
        retained.push(ExportDirectory {
            path: path.to_path_buf(),
            file: open_export_directory_file(path)?,
        });
    }
    Ok(retained)
}

#[cfg(target_os = "windows")]
fn export_directory_identity(file: &fs::File) -> Result<(u64, [u8; 16]), String> {
    use std::os::windows::io::AsRawHandle;
    use windows::Win32::Foundation::HANDLE;
    use windows::Win32::Storage::FileSystem::{
        FileIdInfo, GetFileInformationByHandleEx, FILE_ID_INFO,
    };
    let mut identity = FILE_ID_INFO::default();
    unsafe {
        GetFileInformationByHandleEx(
            HANDLE(file.as_raw_handle()),
            FileIdInfo,
            (&mut identity as *mut FILE_ID_INFO).cast(),
            std::mem::size_of::<FILE_ID_INFO>() as u32,
        )
    }
    .map_err(|error| format!("Could not verify retained export directory identity: {error}"))?;
    Ok((identity.VolumeSerialNumber, identity.FileId.Identifier))
}

fn revalidate_export_directories(directories: &[ExportDirectory]) -> Result<(), String> {
    for directory in directories {
        let retained = directory
            .file
            .metadata()
            .map_err(|error| format!("Could not inspect retained export directory: {error}"))?;
        let named = fs::symlink_metadata(&directory.path)
            .map_err(|_| "Export directory changed during writing.")?;
        if !retained.is_dir()
            || export_metadata_is_link(&retained)
            || !named.is_dir()
            || export_metadata_is_link(&named)
        {
            return Err(
                "Export directory changed or became a reparse point during writing.".into(),
            );
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            if retained.dev() != named.dev() || retained.ino() != named.ino() {
                return Err("Export directory changed during writing.".into());
            }
        }
        #[cfg(target_os = "windows")]
        {
            let current = open_export_directory_file(&directory.path)?;
            if export_directory_identity(&directory.file)? != export_directory_identity(&current)? {
                return Err("Export directory no longer matches its retained handle.".into());
            }
        }
    }
    Ok(())
}

#[cfg(target_os = "linux")]
fn publish_export_handle(
    file: &fs::File,
    directory: &fs::File,
    destination: &Path,
) -> Result<(), String> {
    use std::ffi::{c_char, c_int, CString};
    use std::os::fd::AsRawFd;
    use std::os::unix::ffi::OsStrExt;
    unsafe extern "C" {
        fn linkat(
            old_dir: c_int,
            old_path: *const c_char,
            new_dir: c_int,
            new_path: *const c_char,
            flags: c_int,
        ) -> c_int;
    }
    let source = CString::new(format!("/proc/self/fd/{}", file.as_raw_fd())).unwrap();
    let name = destination
        .file_name()
        .ok_or("Export filename is missing.")?;
    let destination = CString::new(name.as_bytes()).map_err(|_| "Export filename contains NUL.")?;
    // Linux documents this descriptor-backed link as the unprivileged alternative
    // to AT_EMPTY_PATH. The destination is relative to the retained directory;
    // linkat never replaces an existing entry. No scratch pathname is resolved.
    let result = unsafe {
        linkat(
            -100,
            source.as_ptr(),
            directory.as_raw_fd(),
            destination.as_ptr(),
            0x400,
        )
    };
    if result != 0 {
        return Err(format!(
            "Could not publish the retained export file without overwriting: {}",
            std::io::Error::last_os_error()
        ));
    }
    Ok(())
}

#[cfg(target_os = "windows")]
fn publish_export_handle(
    file: &fs::File,
    _directory: &fs::File,
    destination: &Path,
) -> Result<(), String> {
    use std::os::windows::{ffi::OsStrExt, io::AsRawHandle};
    use windows::Win32::Foundation::HANDLE;
    use windows::Win32::Storage::FileSystem::{
        FileRenameInfo, SetFileInformationByHandle, FILE_RENAME_INFO,
    };
    let name = destination.as_os_str().encode_wide().collect::<Vec<_>>();
    let name_bytes = name
        .len()
        .checked_mul(2)
        .ok_or("Export filename is too long.")?;
    let buffer_bytes = std::mem::offset_of!(FILE_RENAME_INFO, FileName)
        .checked_add(name_bytes)
        .and_then(|size| size.checked_add(2))
        .ok_or("Export filename is too long.")?;
    let buffer_len = u32::try_from(buffer_bytes).map_err(|_| "Export filename is too long.")?;
    // usize backing gives the C header its required pointer alignment. Zeroing the
    // union selects ReplaceIfExists=false; the following UTF-16 name is bounded.
    let mut storage = vec![0_usize; buffer_bytes.div_ceil(std::mem::size_of::<usize>())];
    let info = storage.as_mut_ptr().cast::<FILE_RENAME_INFO>();
    unsafe {
        // The Windows0.61.3 native matrix requires this absolute-path/NULL pair.
        // Source identity remains the retained file handle; ancestor handles below
        // keep the validated destination namespace stable.
        (*info).RootDirectory = HANDLE::default();
        (*info).FileNameLength = name_bytes as u32;
        std::ptr::copy_nonoverlapping(
            name.as_ptr(),
            std::ptr::addr_of_mut!((*info).FileName).cast::<u16>(),
            name.len(),
        );
        SetFileInformationByHandle(
            HANDLE(file.as_raw_handle()),
            FileRenameInfo,
            info.cast(),
            buffer_len,
        )
    }
    .map_err(|error| {
        format!("Could not publish the retained export file without overwriting: {error}")
    })
}

#[cfg(not(any(target_os = "linux", target_os = "windows")))]
fn publish_export_handle(
    _file: &fs::File,
    _directory: &fs::File,
    _destination: &Path,
) -> Result<(), String> {
    Err("Verified weight ZIP publication is not supported on this platform.".into())
}

fn write_export_atomically(
    destination: &Path,
    extension: &str,
    protected_root: &Path,
    write: impl FnOnce(&mut fs::File) -> Result<(), String>,
) -> Result<(), String> {
    if !cfg!(any(target_os = "linux", target_os = "windows")) {
        return Err("Verified weight ZIP publication is not supported on this platform.".into());
    }
    static SEQUENCE: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let destination = checked_export_destination(destination, extension, protected_root)?;
    let parent = destination
        .parent()
        .ok_or("Export destination has no parent directory.")?;
    // Windows absolute publication retains every ancestor, not just the leaf directory.
    let directories = open_export_directories(parent)?;
    let directory = &directories
        .last()
        .ok_or("Export directory is missing.")?
        .file;
    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|_| "Export clock is unavailable.".to_string())?
        .as_nanos();
    let sequence = SEQUENCE.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let temporary = parent.join(format!(
        ".vibespace-export-{}-{nonce}-{sequence}.tmp",
        std::process::id()
    ));
    let mut options = fs::OpenOptions::new();
    options.write(true).read(true).create_new(true);
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::fs::OpenOptionsExt;
        // GENERIC_READ | GENERIC_WRITE | DELETE permits handle rename/disposition.
        // Exclusive sharing prevents name replacement or external writes while open.
        options.access_mode(0xC001_0000).share_mode(0);
    }
    let file = options
        .open(&temporary)
        .map_err(|error| format!("Could not create export scratch file: {error}"))?;
    let mut scratch = ExportScratch {
        path: temporary,
        file,
        published: false,
    };
    write(&mut scratch.file)?;
    scratch
        .file
        .sync_all()
        .map_err(|error| format!("Could not finish artifact export: {error}"))?;
    revalidate_export_directories(&directories)?;
    publish_export_handle(&scratch.file, directory, &destination)?;
    scratch.published = true;
    Ok(())
}

// Preserve knowledge JSON on other platforms. Its validated bytes are already
// in memory; this legacy direct-write path has no scratch source to substitute.
// It is no-replace but not atomic: a write error can leave a partial new file.
#[cfg(any(test, not(any(target_os = "linux", target_os = "windows"))))]
fn write_knowledge_direct(bytes: &[u8], destination: &Path, protected_root: &Path,
    before_publish: impl FnOnce() -> Result<(), String>) -> Result<(), String> {
    let destination = checked_export_destination(destination, "json", protected_root)?;
    before_publish()?;
    let mut file = fs::OpenOptions::new().write(true).create_new(true).open(destination)
        .map_err(|error| format!("Could not create knowledge export without overwriting: {error}"))?;
    file.write_all(bytes).and_then(|()| file.sync_all())
        .map_err(|error| format!("Knowledge export could not finish; the new destination may be incomplete: {error}"))
}

pub(crate) fn export_knowledge_json(bytes: &[u8], destination: &Path, protected_root: &Path,
    before_publish: impl FnOnce() -> Result<(), String>) -> Result<(), String> {
    #[cfg(not(any(target_os = "linux", target_os = "windows")))]
    { write_knowledge_direct(bytes, destination, protected_root, before_publish) }
    #[cfg(any(target_os = "linux", target_os = "windows"))]
    {
        write_export_atomically(destination, "json", protected_root, |file| {
            file.write_all(bytes).map_err(|error| format!("Could not write knowledge export: {error}"))?;
            before_publish()
        })
    }
}

fn open_verified_payload(root: &Path, entry: &TrainingArtifactFile) -> Result<fs::File, String> {
    validate_export_member(&entry.path)?;
    let source = root.join(&entry.path);
    let mut current = root.to_path_buf();
    for component in entry.path.split('/') {
        current.push(component);
        let metadata = fs::symlink_metadata(&current)
            .map_err(|_| "Artifact export source is missing.".to_string())?;
        if export_metadata_is_link(&metadata) {
            return Err("Artifact export source may not contain symbolic links.".into());
        }
    }
    if !source
        .canonicalize()
        .map_err(|_| "Artifact export source is missing.".to_string())?
        .starts_with(root)
    {
        return Err("Artifact export source escaped its verified root.".into());
    }
    let input = fs::File::open(&source)
        .map_err(|error| format!("Could not open artifact export source: {error}"))?;
    let metadata = input
        .metadata()
        .map_err(|error| format!("Could not inspect artifact export source: {error}"))?;
    if !metadata.is_file() || metadata.len() != entry.bytes {
        return Err("Artifact export source size changed after verification.".into());
    }
    Ok(input)
}

fn stream_verified_payload(
    input: &mut impl Read, output: &mut impl Write, entry: &TrainingArtifactFile,
) -> Result<(), String> {
    let mut digest = Sha256::new();
    let mut copied = 0_u64;
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let count = input
            .read(&mut buffer)
            .map_err(|error| format!("Could not read artifact export source: {error}"))?;
        if count == 0 {
            break;
        }
        copied = copied
            .checked_add(count as u64)
            .ok_or("Artifact export size overflowed.")?;
        if copied > entry.bytes {
            return Err("Artifact export source grew after verification.".into());
        }
        digest.update(&buffer[..count]);
        output
            .write_all(&buffer[..count])
            .map_err(|error| format!("Could not write artifact payload export: {error}"))?;
    }
    if copied != entry.bytes || format!("{:x}", digest.finalize()) != entry.sha256 {
        return Err("Artifact export source changed after verification.".into());
    }
    Ok(())
}

fn write_weight_archive(
    output: &mut fs::File,
    root: &Path,
    manifest: &TrainingArtifactManifest,
    manifest_bytes: &[u8],
) -> Result<(), String> {
    let mut archive = zip::ZipWriter::new(output);
    let options = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Stored)
        .last_modified_time(zip::DateTime::default())
        .unix_permissions(0o600);
    archive
        .start_file(TRAINING_ARTIFACT_MANIFEST, options)
        .map_err(|error| format!("Could not start artifact manifest export: {error}"))?;
    archive
        .write_all(manifest_bytes)
        .map_err(|error| format!("Could not write artifact manifest export: {error}"))?;
    for entry in &manifest.files {
        let mut input = open_verified_payload(root, entry)?;
        archive
            .start_file(
                &entry.path,
                options.large_file(entry.bytes > u32::MAX as u64),
            )
            .map_err(|error| format!("Could not start artifact payload export: {error}"))?;
        stream_verified_payload(&mut input, &mut archive, entry)?;
    }
    archive
        .finish()
        .map_err(|error| format!("Could not finish artifact archive: {error}"))?;
    Ok(())
}

pub(crate) struct VerifiedCopyManifest {
    protected_root: PathBuf,
    root: PathBuf,
    manifest_path: PathBuf,
    manifest: TrainingArtifactManifest,
    manifest_bytes: Vec<u8>,
    manifest_hash: String,
}

pub(crate) fn prepare_verified_artifact_copy(
    root: &Path, method: &str, expected_sha256: &str,
    expected_storage_bytes: u64, protected_root: &Path,
) -> Result<VerifiedCopyManifest, String> {
    let root = checked_export_source(root, protected_root)?;
    let evidence = verify_training_artifact_for_method(&root, method)?;
    if evidence.sha256 != expected_sha256 || evidence.storage_bytes != expected_storage_bytes {
        return Err("Training artifact no longer matches its recorded job identity.".into());
    }
    let manifest_path =
        checked_export_source(&root.join(TRAINING_ARTIFACT_MANIFEST), protected_root)?;
    let mut manifest_bytes = Vec::new();
    fs::File::open(&manifest_path)
        .map_err(|error| format!("Could not open verified artifact manifest: {error}"))?
        .take(MAX_ARTIFACT_MANIFEST_BYTES + 1)
        .read_to_end(&mut manifest_bytes)
        .map_err(|error| format!("Could not read verified artifact manifest: {error}"))?;
    if manifest_bytes.len() as u64 > MAX_ARTIFACT_MANIFEST_BYTES {
        return Err("Training artifact manifest exceeds the safe size limit.".into());
    }
    let manifest: TrainingArtifactManifest = serde_json::from_slice(&manifest_bytes)
        .map_err(|error| format!("Training artifact manifest is invalid: {error}"))?;
    let declared = artifact_manifest_from_files(method, manifest.files.clone())?;
    if manifest.schema_version != 1
        || manifest.method != method
        || manifest.file_count != declared.file_count
        || manifest.storage_bytes != declared.storage_bytes
        || manifest.sha256 != declared.sha256
        || declared.sha256 != expected_sha256
        || manifest.file_count > MAX_ARTIFACT_FILES
    {
        return Err("Training artifact manifest changed after verification.".into());
    }
    // Include the manifest and directory prefixes in the portable namespace.
    // Whole-file comparisons alone miss a reserved manifest alias or A versus a/file.
    let mut paths = BTreeMap::from([(
        TRAINING_ARTIFACT_MANIFEST.to_lowercase(),
        (TRAINING_ARTIFACT_MANIFEST.to_string(), true),
    )]);
    for entry in &manifest.files {
        validate_export_member(&entry.path)?;
        let components = entry.path.split('/').collect::<Vec<_>>();
        let mut prefix = String::new();
        for (index, component) in components.iter().enumerate() {
            if index != 0 { prefix.push('/'); }
            prefix.push_str(component);
            let is_file = index + 1 == components.len();
            let key = prefix.to_lowercase();
            if let Some((original, was_file)) = paths.get(&key) {
                if original != &prefix || *was_file || is_file {
                    return Err("Artifact export contains colliding paths.".into());
                }
            } else {
                paths.insert(key, (prefix.clone(), is_file));
            }
        }
    }
    let manifest_hash = format!("{:x}", Sha256::digest(&manifest_bytes));
    Ok(VerifiedCopyManifest { protected_root: protected_root.to_path_buf(), root, manifest_path, manifest, manifest_bytes, manifest_hash })
}

impl VerifiedCopyManifest {
    pub(crate) fn revalidate_source(&self) -> Result<(), String> {
        checked_export_source(&self.root, &self.protected_root)?;
        checked_export_source(&self.manifest_path, &self.protected_root)?;
        let evidence = verify_training_artifact_for_method(&self.root, &self.manifest.method)?;
        if evidence.sha256 != self.manifest.sha256 || evidence.storage_bytes != self.manifest.storage_bytes
            || file_sha256(&self.manifest_path)?.1 != self.manifest_hash {
            return Err("Source artifact changed during duplication.".into());
        }
        Ok(())
    }
}

pub(crate) fn export_training_artifact(
    root: &Path,
    method: &str,
    expected_sha256: &str,
    expected_storage_bytes: u64,
    destination: &Path,
    protected_root: &Path,
    before_publish: impl FnOnce() -> Result<(), String>,
) -> Result<(), String> {
    if !cfg!(any(target_os = "linux", target_os = "windows")) {
        return Err("Verified weight ZIP publication is not supported on this platform.".into());
    }
    let VerifiedCopyManifest { root, manifest_path, manifest, manifest_bytes, manifest_hash, .. } =
        prepare_verified_artifact_copy(root, method, expected_sha256, expected_storage_bytes, protected_root)?;
    write_export_atomically(destination, "zip", protected_root, |file| {
        write_weight_archive(file, &root, &manifest, &manifest_bytes)?;
        checked_export_source(&manifest_path, protected_root)?;
        if file_sha256(&manifest_path)?.1 != manifest_hash {
            return Err("Artifact manifest changed during export.".into());
        }
        before_publish()
    })
}

// The only selectable commit is job.json. Payloads are independent new files.
// Linux keeps .duplicate-commit.json as an intentional bounded private copy of
// the existing job representation: the proven no-replace publisher links its
// retained handle, so successful publication needs no fallible cleanup afterward.
const DUPLICATE_COMMIT_RECORD: &str = ".duplicate-commit.json";

struct DuplicateFile { path: PathBuf, file: fs::File }

pub(crate) struct PrivateDuplicate {
    root: PathBuf,
    ancestors: Vec<ExportDirectory>,
    directories: Vec<ExportDirectory>,
    files: Vec<DuplicateFile>,
    committed: bool,
}

impl PrivateDuplicate {
    pub(crate) fn create(protected_root: &Path, id: &str) -> Result<Self, String> {
        if !cfg!(any(target_os = "linux", target_os = "windows")) {
            return Err("Verified artifact duplication is unavailable on this platform.".into());
        }
        if !id.starts_with("job_") || !(5..=80).contains(&id.len())
            || !id.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-')) {
            return Err("Invalid duplicate job identifier.".into());
        }
        let parent = checked_export_source(&protected_root.join("jobs"), protected_root)?;
        let ancestors = open_export_directories(&parent)?;
        revalidate_export_directories(&ancestors)?;
        let root = parent.join(id);
        fs::create_dir(&root).map_err(|error| format!("Could not exclusively create duplicate directory: {error}"))?;
        let file = open_export_directory_file(&root)
            .map_err(|error| format!("{error}; duplicate cleanup is pending."))?;
        Ok(Self { root: root.clone(), ancestors, directories: vec![ExportDirectory { path: root, file }],
            files: Vec::new(), committed: false })
    }

    pub(crate) fn root(&self) -> &Path { &self.root }

    fn revalidate(&self) -> Result<(), String> {
        revalidate_export_directories(&self.ancestors)?;
        revalidate_export_directories(&self.directories)
    }

    fn ensure_parent(&mut self, relative: &str) -> Result<PathBuf, String> {
        validate_export_member(relative)?;
        self.revalidate()?;
        let destination = self.root.join(relative);
        let mut directory = self.root.clone();
        let components = relative.split('/').collect::<Vec<_>>();
        for component in &components[..components.len() - 1] {
            directory.push(component);
            if self.directories.iter().any(|owned| owned.path == directory) { continue; }
            fs::create_dir(&directory).map_err(|error| format!("Could not exclusively create duplicate payload directory: {error}"))?;
            let file = open_export_directory_file(&directory)
                .map_err(|error| format!("{error}; duplicate cleanup is pending."))?;
            self.directories.push(ExportDirectory { path: directory.clone(), file });
        }
        self.revalidate()?;
        Ok(destination)
    }

    fn write_owned_file(&mut self, relative: &str, write: impl FnOnce(&mut fs::File) -> Result<(), String>) -> Result<(), String> {
        self.write_owned_file_with_sync(relative, write, |file| file.sync_all()
            .map_err(|error| format!("Could not sync duplicate file: {error}")))
    }

    fn write_owned_file_with_sync(&mut self, relative: &str,
        write: impl FnOnce(&mut fs::File) -> Result<(), String>,
        sync: impl FnOnce(&fs::File) -> Result<(), String>,
    ) -> Result<(), String> {
        if self.committed || self.files.len() >= MAX_ARTIFACT_FILES + 3 {
            return Err("Duplicate file collection is unavailable or exceeds its bound.".into());
        }
        let path = self.ensure_parent(relative)?;
        let mut options = fs::OpenOptions::new();
        options.read(true).write(true).create_new(true);
        #[cfg(target_os = "windows")]
        {
            use std::os::windows::fs::OpenOptionsExt;
            // Retain deletion authority over this new file; allow verifier reads,
            // while denying external writes and replacement until commit/cleanup.
            options.access_mode(0xC001_0000).share_mode(1);
        }
        let file = options.open(&path).map_err(|error| format!("Could not create independent duplicate file: {error}"))?;
        self.files.push(DuplicateFile { path, file });
        let file = &mut self.files.last_mut().ok_or("Duplicate file is missing.")?.file;
        write(file)?;
        sync(file)?;
        self.revalidate()
    }

    pub(crate) fn write_bytes(&mut self, relative: &str, bytes: &[u8]) -> Result<(), String> {
        if matches!(relative, "job.json" | DUPLICATE_COMMIT_RECORD) {
            return Err("Duplicate job metadata must be published last.".into());
        }
        self.write_owned_file(relative, |file| file.write_all(bytes)
            .map_err(|error| format!("Could not write duplicate file: {error}")))
    }

    pub(crate) fn copy_weights(&mut self, verified: &VerifiedCopyManifest,
        mut after_payload: impl FnMut(&Path) -> Result<(), String>,
    ) -> Result<TrainingArtifactEvidence, String> {
        for entry in &verified.manifest.files {
            let mut input = open_verified_payload(&verified.root, entry)?;
            self.write_owned_file(&format!("weight-artifact/{}", entry.path), |output|
                stream_verified_payload(&mut input, output, entry))?;
            after_payload(&self.root)?;
        }
        self.write_bytes(&format!("weight-artifact/{TRAINING_ARTIFACT_MANIFEST}"), &verified.manifest_bytes)?;
        checked_export_source(&verified.manifest_path, &verified.protected_root)?;
        if file_sha256(&verified.manifest_path)?.1 != verified.manifest_hash {
            return Err("Artifact manifest changed during duplication.".into());
        }
        let evidence = verify_training_artifact_for_method(&self.root.join("weight-artifact"), &verified.manifest.method)?;
        if evidence.sha256 != verified.manifest.sha256 || evidence.storage_bytes != verified.manifest.storage_bytes {
            return Err("Independent duplicate failed artifact verification.".into());
        }
        Ok(evidence)
    }

    pub(crate) fn commit(&mut self, bytes: &[u8], before_publish: impl FnOnce() -> Result<(), String>) -> Result<(), String> {
        if bytes.is_empty() || bytes.len() > 1024 * 1024 { return Err("Duplicate job record exceeds its bound.".into()); }
        self.write_owned_file(DUPLICATE_COMMIT_RECORD, |file| file.write_all(bytes)
            .map_err(|error| format!("Could not write duplicate commit record: {error}")))?;
        before_publish()?;
        self.revalidate()?;
        for owned in &self.files {
            let opened = owned.file.metadata().map_err(|_| "Duplicate file ownership is unavailable.")?;
            let named = fs::symlink_metadata(&owned.path).map_err(|_| "Duplicate file path changed.")?;
            if !named.is_file() || export_metadata_is_link(&named) { return Err("Duplicate file path was replaced.".into()); }
            #[cfg(unix)]
            {
                use std::os::unix::fs::MetadataExt;
                if opened.dev() != named.dev() || opened.ino() != named.ino() { return Err("Duplicate file path was replaced.".into()); }
            }
            #[cfg(target_os = "windows")]
            {
                let current = fs::File::open(&owned.path).map_err(|_| "Duplicate file ownership is unavailable.")?;
                if export_directory_identity(&owned.file)? != export_directory_identity(&current)? { return Err("Duplicate file path was replaced.".into()); }
                let _ = opened;
            }
        }
        let record = self.files.last().ok_or("Duplicate commit record is missing.")?;
        use std::io::{Seek, SeekFrom};
        let mut record_reader = record.file.try_clone().map_err(|_| "Duplicate commit record is unavailable.")?;
        record_reader.seek(SeekFrom::Start(0)).map_err(|_| "Duplicate commit record is unavailable.")?;
        let mut actual = Vec::new();
        record_reader.take(1024 * 1024 + 1).read_to_end(&mut actual).map_err(|_| "Duplicate commit record is unavailable.")?;
        if actual != bytes { return Err("Duplicate commit record changed before publication.".into()); }
        let directory = &self.directories.first().ok_or("Duplicate directory is missing.")?.file;
        publish_export_handle(&record.file, directory, &self.root.join("job.json"))?;
        // This must be the last fallible operation. Windows moved the retained
        // record; Linux retained its private bounded source name intentionally.
        self.committed = true;
        Ok(())
    }

    pub(crate) fn cleanup(mut self, before_cleanup: impl FnOnce() -> Result<(), String>) -> Result<(), String> {
        if self.committed { return Ok(()); }
        before_cleanup()?;
        let mut failures = Vec::new();
        for owned in self.files.drain(..).rev() {
            if let Err(error) = remove_duplicate_file(owned) { failures.push(error); }
        }
        // Empty-directory removal never recursively deletes a collision winner.
        for owned in self.directories.drain(..).rev() {
            if let Err(error) = remove_duplicate_directory(owned) { failures.push(error); }
        }
        if failures.is_empty() { Ok(()) } else { Err("Duplicate cleanup is pending; retained or foreign entries were preserved.".into()) }
    }
}

#[cfg(target_os = "windows")]
fn mark_duplicate_handle_for_deletion(file: &fs::File) -> Result<(), String> {
    use std::os::windows::io::AsRawHandle;
    use windows::Win32::Foundation::HANDLE;
    use windows::Win32::Storage::FileSystem::{SetFileInformationByHandle, FileDispositionInfo, FILE_DISPOSITION_INFO};
    let disposition = FILE_DISPOSITION_INFO { DeleteFile: true.into() };
    unsafe { SetFileInformationByHandle(HANDLE(file.as_raw_handle()), FileDispositionInfo,
        (&disposition as *const FILE_DISPOSITION_INFO).cast(), std::mem::size_of::<FILE_DISPOSITION_INFO>() as u32) }
        .map_err(|_| "Duplicate owned-object cleanup is unavailable.".to_string())
}

fn remove_duplicate_file(owned: DuplicateFile) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    { mark_duplicate_handle_for_deletion(&owned.file) }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let opened = owned.file.metadata().map_err(|_| "Duplicate ownership is unavailable.")?;
        let named = fs::symlink_metadata(&owned.path).map_err(|_| "Duplicate path changed.")?;
        if opened.dev() != named.dev() || opened.ino() != named.ino() { return Err("Duplicate path no longer belongs to this copy.".into()); }
        fs::remove_file(&owned.path).map_err(|_| "Duplicate owned-file cleanup is unavailable.".into())
    }
    #[cfg(not(any(unix, target_os = "windows")))]
    { let _ = owned; Err("Verified duplicate cleanup is unsupported.".into()) }
}

fn remove_duplicate_directory(owned: ExportDirectory) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::fs::OpenOptionsExt;
        let identity = export_directory_identity(&owned.file)?;
        let path = owned.path;
        drop(owned.file); // Release our deny-delete read handle before acquiring deletion authority.
        let file = fs::OpenOptions::new().read(true).access_mode(0x8001_0000)
            .custom_flags(0x0220_0000).share_mode(7).open(&path)
            .map_err(|_| "Duplicate directory cleanup is unavailable.")?;
        let metadata = file.metadata().map_err(|_| "Duplicate directory ownership is unavailable.")?;
        if !metadata.is_dir() || export_metadata_is_link(&metadata) || export_directory_identity(&file)? != identity {
            return Err("Duplicate directory was replaced; cleanup is pending.".into());
        }
        mark_duplicate_handle_for_deletion(&file)
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let opened = owned.file.metadata().map_err(|_| "Duplicate ownership is unavailable.")?;
        let named = fs::symlink_metadata(&owned.path).map_err(|_| "Duplicate directory changed.")?;
        if opened.dev() != named.dev() || opened.ino() != named.ino() { return Err("Duplicate directory no longer belongs to this copy.".into()); }
        fs::remove_dir(&owned.path).map_err(|_| "Duplicate nonempty directory was preserved; cleanup is pending.".into())
    }
    #[cfg(not(any(unix, target_os = "windows")))]
    { let _ = owned; Err("Verified duplicate cleanup is unsupported.".into()) }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;
    use std::time::{SystemTime, UNIX_EPOCH};


    fn copy_fixture_root(label: &str) -> PathBuf {
        let root = scratch_dir(label); fs::create_dir_all(root.join("private/jobs")).unwrap(); root
    }

    #[test]
    fn artifact_duplicate_stream_rejects_short_growing_changed_and_failed_io() {
        let bytes = b"verified payload";
        let entry = TrainingArtifactFile { path: "weights.bin".into(), bytes: bytes.len() as u64,
            sha256: format!("{:x}", Sha256::digest(bytes)) };
        let mut output = Vec::new();
        stream_verified_payload(&mut Cursor::new(bytes), &mut output, &entry).unwrap(); assert_eq!(output, bytes);
        for source in [&bytes[..3], b"verified payload with growth".as_slice(), b"different payload".as_slice()] {
            assert!(stream_verified_payload(&mut Cursor::new(source), &mut Vec::new(), &entry).is_err());
        }
        struct FailedRead;
        impl Read for FailedRead { fn read(&mut self, _: &mut [u8]) -> std::io::Result<usize> { Err(std::io::Error::other("injected read")) } }
        struct FailedWrite;
        impl Write for FailedWrite {
            fn write(&mut self, _: &[u8]) -> std::io::Result<usize> { Err(std::io::Error::other("injected write")) }
            fn flush(&mut self) -> std::io::Result<()> { Ok(()) }
        }
        assert!(stream_verified_payload(&mut FailedRead, &mut Vec::new(), &entry).is_err());
        assert!(stream_verified_payload(&mut Cursor::new(bytes), &mut FailedWrite, &entry).is_err());
    }

    #[cfg(any(target_os = "linux", target_os = "windows"))]
    #[test]
    fn artifact_duplicate_partial_write_cleans_only_owned_files_and_never_publishes() {
        let root = copy_fixture_root("copy-partial-write");
        let mut copy = PrivateDuplicate::create(&root.join("private"), "job_copy").unwrap();
        let destination = copy.root().to_path_buf();
        assert!(copy.write_owned_file("weight-artifact/nested/weights.bin", |file| {
            file.write_all(b"partial").unwrap(); Err("injected disk failure".into())
        }).is_err());
        assert!(!destination.join("job.json").exists()); copy.cleanup(|| Ok(())).unwrap();
        assert!(!destination.exists()); fs::remove_dir_all(root).unwrap();
    }

    #[cfg(any(target_os = "linux", target_os = "windows"))]
    #[test]
    fn artifact_duplicate_sync_failure_is_not_a_successful_copy() {
        let root = copy_fixture_root("copy-sync-failure");
        let mut copy = PrivateDuplicate::create(&root.join("private"), "job_copy").unwrap();
        let destination = copy.root().to_path_buf();
        let error = copy.write_owned_file_with_sync("request.json", |file| file.write_all(b"complete but unsynced")
            .map_err(|error| error.to_string()), |_| Err("injected sync failure".into())).unwrap_err();
        assert_eq!(error, "injected sync failure"); assert!(!destination.join("job.json").exists());
        copy.cleanup(|| Ok(())).unwrap(); assert!(!destination.exists()); fs::remove_dir_all(root).unwrap();
    }

    #[cfg(any(target_os = "linux", target_os = "windows"))]
    #[test]
    fn artifact_duplicate_file_collision_is_never_adopted_or_deleted_by_cleanup() {
        let root = copy_fixture_root("copy-file-collision");
        let mut copy = PrivateDuplicate::create(&root.join("private"), "job_copy").unwrap();
        let destination = copy.root().to_path_buf();
        fs::write(destination.join("request.json"), b"foreign winner").unwrap();
        assert!(copy.write_bytes("request.json", b"our content").is_err());
        assert!(copy.cleanup(|| Ok(())).unwrap_err().contains("cleanup is pending"));
        assert_eq!(fs::read(destination.join("request.json")).unwrap(), b"foreign winner");
        assert!(!destination.join("job.json").exists()); fs::remove_dir_all(root).unwrap();
    }

    #[cfg(any(target_os = "linux", target_os = "windows"))]
    #[test]
    fn artifact_duplicate_commit_is_last_bounded_no_replace_and_uses_exact_retained_record() {
        let root = copy_fixture_root("copy-commit");
        let mut copy = PrivateDuplicate::create(&root.join("private"), "job_copy").unwrap();
        let destination = copy.root().to_path_buf();
        assert!(copy.write_bytes("job.json", b"premature").is_err());
        assert!(copy.write_bytes(DUPLICATE_COMMIT_RECORD, b"premature").is_err());
        assert!(copy.commit(&vec![b'x'; 1024 * 1024 + 1], || Ok(())).is_err());
        copy.write_bytes("request.json", b"bounded compatible record").unwrap();
        let record = b"{\"id\":\"job_copy\",\"status\":\"completed\"}";
        copy.commit(record, || { assert!(!destination.join("job.json").exists()); Ok(()) }).unwrap();
        assert!(copy.write_bytes("late-write", b"not allowed").is_err());
        drop(copy);
        assert_eq!(fs::read(destination.join("job.json")).unwrap(), record);
        #[cfg(target_os = "linux")]
        assert_eq!(fs::read(destination.join(DUPLICATE_COMMIT_RECORD)).unwrap(), record);
        #[cfg(target_os = "windows")]
        assert!(!destination.join(DUPLICATE_COMMIT_RECORD).exists());
        assert!(PrivateDuplicate::create(&root.join("private"), "job_copy").is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn artifact_duplicate_rejects_replaced_owned_file_directory_and_commit_content() {
        for case in 0..3 {
            let root = copy_fixture_root("copy-replaced-owned-entry");
            let mut copy = PrivateDuplicate::create(&root.join("private"), "job_copy").unwrap();
            let destination = copy.root().to_path_buf();
            copy.write_bytes("request.json", b"our record").unwrap();
            let result = copy.commit(b"{\"id\":\"job_copy\"}", || {
                match case {
                    0 => { fs::rename(destination.join("request.json"), root.join("moved-own-record")).unwrap(); fs::write(destination.join("request.json"), b"foreign winner").unwrap(); }
                    1 => { fs::rename(&destination, root.join("moved-own-directory")).unwrap(); fs::create_dir(&destination).unwrap(); fs::write(destination.join("foreign"), b"foreign winner").unwrap(); }
                    _ => fs::write(destination.join(DUPLICATE_COMMIT_RECORD), b"changed commit content").unwrap(),
                }
                Ok(())
            });
            assert!(result.is_err()); assert!(!destination.join("job.json").exists());
            let cleanup = copy.cleanup(|| Ok(()));
            if case != 2 { assert!(cleanup.is_err()); } else { cleanup.unwrap(); }
            if case == 0 { assert_eq!(fs::read(destination.join("request.json")).unwrap(), b"foreign winner"); }
            if case == 1 { assert_eq!(fs::read(destination.join("foreign")).unwrap(), b"foreign winner"); }
            fs::remove_dir_all(root).unwrap();
        }
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn artifact_duplicate_windows_retains_payload_and_directory_names_through_publication() {
        let root = copy_fixture_root("copy-retained-windows");
        let mut copy = PrivateDuplicate::create(&root.join("private"), "job_copy").unwrap();
        let destination = copy.root().to_path_buf();
        copy.write_bytes("request.json", b"our record").unwrap();
        copy.commit(b"{\"id\":\"job_copy\"}", || {
            assert!(fs::rename(&destination, root.join("moved-directory")).is_err());
            assert!(fs::rename(destination.join("request.json"), root.join("moved-record")).is_err());
            assert!(fs::write(destination.join("request.json"), b"foreign writer").is_err());
            assert!(fs::write(destination.join(DUPLICATE_COMMIT_RECORD), b"foreign writer").is_err()); Ok(())
        }).unwrap();
        drop(copy); assert_eq!(fs::read(destination.join("request.json")).unwrap(), b"our record");
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(any(target_os = "linux", target_os = "windows"))]
    #[test]
    fn artifact_duplicate_preflight_reuses_method_hash_and_portable_namespace_admission() {
        for method in ["full", "lora", "qlora"] {
            let root = copy_fixture_root("copy-manifest-admission"); let source = root.join("private/source");
            fs::create_dir(&source).unwrap(); fs::write(source.join("weights.bin"), b"tiny weights").unwrap();
            let evidence = write_and_verify_training_artifact(&source, method).unwrap();
            assert!(prepare_verified_artifact_copy(&source, "knowledge", &evidence.sha256, evidence.storage_bytes, &root.join("private")).is_err());
            assert!(prepare_verified_artifact_copy(&source, method, &"f".repeat(64), evidence.storage_bytes, &root.join("private")).is_err());
            assert!(prepare_verified_artifact_copy(&source, method, &evidence.sha256, evidence.storage_bytes + 1, &root.join("private")).is_err());
            let verified = prepare_verified_artifact_copy(&source, method, &evidence.sha256, evidence.storage_bytes, &root.join("private")).unwrap();
            let mut copy = PrivateDuplicate::create(&root.join("private"), "job_copy").unwrap();
            let copied = copy.copy_weights(&verified, |_| Ok(())).unwrap(); assert_eq!(copied.sha256, evidence.sha256);
            copy.cleanup(|| Ok(())).unwrap();
            // Never address a reserved Windows device name on Windows.
            #[cfg(target_os = "linux")]
            {
                fs::remove_file(source.join("weights.bin")).unwrap();
                fs::write(source.join("CON.txt"), b"not portable").unwrap();
                let evidence = write_and_verify_training_artifact(&source, method).unwrap();
                assert!(prepare_verified_artifact_copy(&source, method, &evidence.sha256, evidence.storage_bytes, &root.join("private")).is_err());
            }
            fs::remove_dir_all(root).unwrap();
        }
    }

    #[cfg(any(target_os = "linux", target_os = "windows"))]
    #[test]
    fn artifact_export_atomic_failure_and_destination_race_leave_no_partial_file() {
        let root = scratch_dir("export-cleanup");
        let private = root.join("private");
        fs::create_dir_all(&private).unwrap();
        let destination = root.join("result.zip");
        let result = write_export_atomically(&destination, "zip", &private, |file| {
            file.write_all(b"partial").unwrap();
            Err("injected disk failure".into())
        });
        assert!(result.is_err());
        assert!(!destination.exists());
        assert_eq!(root.read_dir().unwrap().count(), 1);
        let result = write_export_atomically(&destination, "zip", &private, |file| {
            file.write_all(b"complete").unwrap();
            fs::write(&destination, b"unrelated race winner").unwrap();
            Ok(())
        });
        assert!(result.is_err());
        assert_eq!(fs::read(&destination).unwrap(), b"unrelated race winner");
        assert_eq!(root.read_dir().unwrap().count(), 2);
        fs::remove_file(&destination).unwrap();
        export_knowledge_json(b"retry", &root.join("retry.json"), &private, || Ok(())).unwrap();
        assert_eq!(fs::read(root.join("retry.json")).unwrap(), b"retry");
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(any(target_os = "linux", target_os = "windows"))]
    #[test]
    fn artifact_export_preserves_valid_shared_nested_directories() {
        let root = scratch_dir("export-nested");
        let private = root.join("private");
        let artifact = private.join("artifact");
        fs::create_dir_all(artifact.join("tokenizer/nested")).unwrap();
        for name in ["tokenizer/config.json", "tokenizer/vocab.json", "tokenizer/nested/special.json"] {
            fs::write(artifact.join(name), name.as_bytes()).unwrap();
        }
        let evidence = write_and_verify_training_artifact(&artifact, "lora").unwrap();
        let destination = root.join("nested.zip");
        export_training_artifact(&artifact, "lora", &evidence.sha256, evidence.storage_bytes,
            &destination, &private, || Ok(())).unwrap();
        let mut archive = zip::ZipArchive::new(fs::File::open(&destination).unwrap()).unwrap();
        assert_eq!(archive.len(), 4);
        for name in ["tokenizer/config.json", "tokenizer/vocab.json", "tokenizer/nested/special.json"] {
            let mut bytes = Vec::new(); archive.by_name(name).unwrap().read_to_end(&mut bytes).unwrap();
            assert_eq!(bytes, name.as_bytes());
        }
        drop(archive);
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn artifact_export_publishes_retained_file_after_named_scratch_replacement() {
        let root = scratch_dir("export-replaced-scratch");
        fs::create_dir_all(root.join("private")).unwrap();
        let destination = root.join("result.zip");
        let mut replaced = None;
        write_export_atomically(&destination, "zip", &root.join("private"), |file| {
            file.write_all(b"verified bytes").unwrap();
            let named = root.read_dir().unwrap().map(|entry| entry.unwrap().path())
                .find(|path| path.file_name().unwrap().to_string_lossy().starts_with(".vibespace-export-")).unwrap();
            fs::rename(&named, root.join("renamed-original")).unwrap();
            fs::write(&named, b"replacement bytes").unwrap();
            replaced = Some(named);
            Ok(())
        }).unwrap();
        assert_eq!(fs::read(&destination).unwrap(), b"verified bytes");
        assert_eq!(fs::read(replaced.unwrap()).unwrap(), b"replacement bytes");
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn artifact_export_unlinked_source_and_replaced_directory_fail_closed() {
        for replace_directory in [false, true] {
            let root = scratch_dir("export-revoked-path"); let chosen = root.join("chosen");
            fs::create_dir_all(&chosen).unwrap(); fs::create_dir_all(root.join("private")).unwrap();
            let destination = chosen.join("result.zip");
            let result = write_export_atomically(&destination, "zip", &root.join("private"), |file| {
                file.write_all(b"verified bytes").unwrap();
                if replace_directory {
                    fs::rename(&chosen, root.join("moved-chosen")).unwrap();
                    fs::create_dir(&chosen).unwrap();
                } else {
                    let scratch = chosen.read_dir().unwrap().next().unwrap().unwrap().path();
                    fs::remove_file(scratch).unwrap();
                }
                Ok(())
            });
            assert!(result.is_err()); assert!(!destination.exists());
            assert!(!root.join("moved-chosen/result.zip").exists());
            fs::remove_dir_all(root).unwrap();
        }
    }

    #[test]
    fn artifact_export_legacy_knowledge_direct_path_preserves_valid_bytes_and_no_replace() {
        let root = scratch_dir("export-legacy-knowledge"); fs::create_dir_all(root.join("private")).unwrap();
        let destination = root.join("knowledge.json");
        write_knowledge_direct(b"validated immutable JSON", &destination, &root.join("private"), || Ok(())).unwrap();
        assert_eq!(fs::read(&destination).unwrap(), b"validated immutable JSON");
        assert!(write_knowledge_direct(b"other", &destination, &root.join("private"), || Ok(())).is_err());
        assert_eq!(fs::read(&destination).unwrap(), b"validated immutable JSON");
        let rejected = root.join("revoked.json");
        assert!(write_knowledge_direct(b"other", &rejected, &root.join("private"), || Err("revoked".into())).is_err());
        assert!(!rejected.exists()); fs::remove_dir_all(root).unwrap();
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn artifact_export_windows_retained_scratch_refuses_external_replacement() {
        let root = scratch_dir("export-exclusive-scratch"); fs::create_dir_all(root.join("private")).unwrap();
        let destination = root.join("result.zip");
        write_export_atomically(&destination, "zip", &root.join("private"), |file| {
            file.write_all(b"verified bytes").unwrap();
            let scratch = root.read_dir().unwrap().map(|entry| entry.unwrap().path())
                .find(|path| path.file_name().unwrap().to_string_lossy().starts_with(".vibespace-export-")).unwrap();
            assert!(fs::rename(&scratch, root.join("renamed-scratch")).is_err());
            assert!(fs::write(&scratch, b"replacement").is_err());
            Ok(())
        }).unwrap();
        assert_eq!(fs::read(&destination).unwrap(), b"verified bytes");
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(not(any(target_os = "linux", target_os = "windows")))]
    #[test]
    fn artifact_export_reports_unsupported_weight_publication_before_file_io() {
        let missing = Path::new("/synthetic-not-created");
        let result = export_training_artifact(missing, "full", &"0".repeat(64), 1,
            missing, missing, || panic!("Unsupported weight export must not publish"));
        assert!(result.unwrap_err().contains("not supported on this platform"));
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn artifact_export_windows_retains_parent_and_ancestor_names() {
        let root = scratch_dir("export-ancestor-locks");
        let private = root.join("private");
        let ancestor = root.join("chosen");
        let parent = ancestor.join("parent");
        fs::create_dir_all(&private).unwrap();
        fs::create_dir_all(&parent).unwrap();
        let destination = parent.join("result.zip");
        write_export_atomically(&destination, "zip", &private, |file| {
            file.write_all(b"verified synthetic bytes").unwrap();
            assert!(fs::rename(&parent, ancestor.join("changed-parent")).is_err());
            assert!(fs::rename(&ancestor, root.join("changed-ancestor")).is_err());
            Ok(())
        })
        .unwrap();
        assert_eq!(fs::read(&destination).unwrap(), b"verified synthetic bytes");
        assert!(parent.is_dir());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn artifact_export_rejects_unsafe_portable_member_names() {
        for name in [
            "",
            "../secret",
            "/absolute",
            "C:/secret",
            "a\\b",
            "a//b",
            "./config",
            "a/../b",
            "a/",
            "NUL.txt",
            "aux",
            "COM1/x",
            "a. ",
            "a/b.",
            "a?b",
            "a\0b",
        ] {
            assert!(validate_export_member(name).is_err(), "{name:?}");
        }
        for name in [
            "config.json",
            "nested/tokenizer.json",
            ".vibespace-artifact.json",
            "adapter_model.safetensors",
        ] {
            validate_export_member(name).unwrap();
        }
    }

    #[cfg(any(target_os = "linux", target_os = "windows"))]
    #[test]
    fn artifact_export_weight_tamper_and_revocation_remove_scratch() {
        let root = scratch_dir("export-integrity");
        let private = root.join("private");
        let artifact = private.join("artifact");
        fs::create_dir_all(&artifact).unwrap();
        fs::write(artifact.join("model.safetensors"), b"synthetic").unwrap();
        let evidence = write_and_verify_training_artifact(&artifact, "full").unwrap();
        let destination = root.join("result.zip");
        let manifest_bytes = fs::read(artifact.join(TRAINING_ARTIFACT_MANIFEST)).unwrap();
        let manifest: TrainingArtifactManifest = serde_json::from_slice(&manifest_bytes).unwrap();
        let result = write_export_atomically(&destination, "zip", &private, |file| {
            // A same-size payload change between verification and copying must fail.
            fs::write(artifact.join("model.safetensors"), b"tampered!").unwrap();
            write_weight_archive(file, &artifact, &manifest, &manifest_bytes)
        });
        assert!(result.is_err());
        assert!(!destination.exists());
        assert_eq!(root.read_dir().unwrap().count(), 1);
        fs::write(artifact.join("model.safetensors"), b"synthetic").unwrap();
        let result = export_training_artifact(
            &artifact,
            "full",
            &evidence.sha256,
            evidence.storage_bytes,
            &destination,
            &private,
            || Err("job revoked during export".into()),
        );
        assert!(result.is_err());
        assert!(!destination.exists());
        assert_eq!(root.read_dir().unwrap().count(), 1);
        export_training_artifact(
            &artifact,
            "full",
            &evidence.sha256,
            evidence.storage_bytes,
            &destination,
            &private,
            || Ok(()),
        )
        .unwrap();
        assert!(destination.exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(any(target_os = "linux", target_os = "windows"))]
    #[test]
    fn artifact_export_rejects_extra_or_colliding_payloads_and_manifest_changes() {
        for case in [
            "extra",
            "tamper",
            "manifest",
            "collision",
            "reserved-manifest",
            "nested-collision",
            "nonportable",
        ] {
            // These fixture names cannot coexist/be created on Windows. The portable
            // name validator above runs on every platform; this filesystem proof is Unix-only.
            if cfg!(windows)
                && matches!(
                    case,
                    "collision" | "reserved-manifest" | "nested-collision" | "nonportable"
                )
            {
                continue;
            }
            let root = scratch_dir(case);
            let private = root.join("private");
            let artifact = private.join("artifact");
            fs::create_dir_all(&artifact).unwrap();
            fs::write(artifact.join("config.json"), b"{}").unwrap();
            let mut evidence = write_and_verify_training_artifact(&artifact, "full").unwrap();
            match case {
                "extra" => fs::write(artifact.join("extra.txt"), b"unexpected").unwrap(),
                "tamper" => fs::write(artifact.join("config.json"), b"[]").unwrap(),
                "manifest" => fs::write(artifact.join(TRAINING_ARTIFACT_MANIFEST), b"{}").unwrap(),
                "collision" => {
                    fs::write(artifact.join("CONFIG.json"), b"{}").unwrap();
                    evidence = write_and_verify_training_artifact(&artifact, "full").unwrap();
                }
                "reserved-manifest" => {
                    fs::write(artifact.join(".VIBESPACE-ARTIFACT.JSON"), b"{}").unwrap();
                    evidence = write_and_verify_training_artifact(&artifact, "full").unwrap();
                }
                "nested-collision" => {
                    fs::write(artifact.join("NESTED"), b"{}").unwrap();
                    fs::create_dir(artifact.join("nested")).unwrap();
                    fs::write(artifact.join("nested/payload"), b"{}").unwrap();
                    evidence = write_and_verify_training_artifact(&artifact, "full").unwrap();
                }
                "nonportable" => {
                    fs::write(artifact.join("NUL.txt"), b"synthetic").unwrap();
                    evidence = write_and_verify_training_artifact(&artifact, "full").unwrap();
                }
                _ => unreachable!(),
            }
            let destination = root.join("rejected.zip");
            assert!(
                export_training_artifact(
                    &artifact,
                    "full",
                    &evidence.sha256,
                    evidence.storage_bytes,
                    &destination,
                    &private,
                    || Ok(())
                )
                .is_err(),
                "{case}"
            );
            assert!(!destination.exists());
            fs::remove_dir_all(root).unwrap();
        }
    }

    #[cfg(unix)]
    #[test]
    fn artifact_export_rejects_symbolic_sources_destinations_and_foreign_roots() {
        use std::os::unix::fs::symlink;
        let root = scratch_dir("export-links");
        let private = root.join("private");
        let foreign = root.join("foreign");
        fs::create_dir_all(&private).unwrap();
        fs::create_dir_all(&foreign).unwrap();
        fs::write(foreign.join("payload"), b"private foreign bytes").unwrap();
        symlink(&foreign, private.join("linked")).unwrap();
        assert!(checked_export_source(&private.join("linked/payload"), &private).is_err());
        assert!(checked_export_source(&foreign.join("payload"), &private).is_err());
        assert!(checked_export_source(&private.join("../foreign/payload"), &private).is_err());
        symlink(&foreign, root.join("output-link")).unwrap();
        assert!(export_knowledge_json(
            b"{}",
            &root.join("output-link/result.json"),
            &private,
            || Ok(())
        )
        .is_err());
        let existing = root.join("existing.json");
        symlink(foreign.join("payload"), &existing).unwrap();
        assert!(export_knowledge_json(b"{}", &existing, &private, || Ok(())).is_err());
        assert_eq!(
            fs::read(foreign.join("payload")).unwrap(),
            b"private foreign bytes"
        );
        let artifact = private.join("artifact");
        fs::create_dir_all(&artifact).unwrap();
        fs::write(artifact.join("payload"), b"synthetic").unwrap();
        let evidence = write_and_verify_training_artifact(&artifact, "full").unwrap();
        fs::remove_file(artifact.join("payload")).unwrap();
        symlink(foreign.join("payload"), artifact.join("payload")).unwrap();
        assert!(export_training_artifact(
            &artifact,
            "full",
            &evidence.sha256,
            evidence.storage_bytes,
            &root.join("rejected.zip"),
            &private,
            || Ok(())
        )
        .is_err());
        fs::remove_dir_all(root).unwrap();
    }

    fn scratch_dir(name: &str) -> PathBuf {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!("vibespace-foundry-{name}-{suffix}"))
    }

    fn test_command(script: &str) -> Command {
        #[cfg(target_os = "windows")]
        let mut command = {
            let mut command = Command::new("powershell.exe");
            command.args(["-NoProfile", "-NonInteractive", "-Command", script]);
            command
        };
        #[cfg(not(target_os = "windows"))]
        let mut command = {
            let mut command = Command::new("sh");
            command.args(["-c", script]);
            command
        };
        configure_hidden_worker_command(&mut command);
        command
    }

    #[cfg(windows)]
    fn descendant_launcher_command(marker: &Path, seconds: u8) -> Command {
        let marker = marker.to_string_lossy().replace('\'', "''");
        test_command(&format!(
            "$null = Start-Process -FilePath 'powershell.exe' -WindowStyle Hidden -ArgumentList '-NoProfile -NonInteractive -Command Start-Sleep -Seconds {seconds}'; Set-Content -LiteralPath '{marker}' -Value ready; exit 0"
        ))
    }

    #[test]
    fn catalog_pins_the_small_text_model_and_validates_file_inventory() {
        let model = catalog_model("smollm2-135m-instruct").unwrap();
        assert_eq!(model.source_id, "HuggingFaceTB/SmolLM2-135M-Instruct");
        assert!(model.modalities.iter().any(|modality| modality == "text"));
        assert_eq!(
            model.download_bytes,
            model.files.iter().map(|file| file.bytes).sum::<u64>()
        );
        assert!(model.files.iter().all(|file| valid_hex(&file.sha256, 64)));
    }

    #[test]
    fn bounded_reader_drains_large_output_without_retaining_it() {
        let input = vec![b'x'; MAX_WORKER_LOG_BYTES + 1024];
        assert_eq!(
            drain_bounded(Cursor::new(input), MAX_WORKER_LOG_BYTES).len(),
            MAX_WORKER_LOG_BYTES
        );
    }

    #[test]
    fn file_hash_works_on_a_small_stack() {
        const CHILD_PATH: &str = "VIBESPACE_FOUNDRY_TEST_HASH_STACK_FILE";
        if let Some(path) = std::env::var_os(CHILD_PATH) {
            let path = PathBuf::from(path);
            let result = thread::Builder::new()
                .stack_size(128 * 1024)
                .spawn(move || file_sha256(&path))
                .unwrap()
                .join()
                .unwrap()
                .unwrap();
            assert_eq!(result.0, 1024 * 1024 + 1);
            let expected = format!("{:x}", Sha256::digest(vec![b'x'; 1024 * 1024 + 1]));
            assert_eq!(result.1, expected);
            return;
        }
        // Stack overflow aborts the process; contain the regression in an owned
        // child test executable so it cannot abort the rest of the suite.
        let root = scratch_dir("small-stack-hash");
        fs::create_dir_all(&root).unwrap();
        let path = root.join("weights.bin");
        fs::write(&path, vec![b'x'; 1024 * 1024 + 1]).unwrap();
        let mut command = Command::new(std::env::current_exe().unwrap());
        command
            .args([
                "--exact",
                "worker_supervisor::tests::file_hash_works_on_a_small_stack",
                "--nocapture",
            ])
            .env(CHILD_PATH, &path);
        configure_hidden_worker_command(&mut command);
        let output = WorkerRegistry::new()
            .run(
                "hash_stack_probe",
                command,
                8 * 1024,
                Some(Duration::from_secs(20)),
                "small-stack hash probe",
            )
            .unwrap();
        fs::remove_file(&path).unwrap();
        fs::remove_dir(&root).unwrap();
        assert!(
            output.status.success(),
            "small-stack file hashing failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    #[test]
    fn supervisor_captures_both_streams_and_releases_registry() {
        let registry = WorkerRegistry::new();
        #[cfg(target_os = "windows")]
        let execution = registry
            .run(
                "job_supervisor_test",
                test_command(
                    "[Console]::Out.Write('stdout'); [Console]::Error.Write('stderr'); exit 7",
                ),
                1024,
                None,
                "test worker",
            )
            .unwrap();
        #[cfg(not(target_os = "windows"))]
        let execution = registry
            .run(
                "job_supervisor_test",
                test_command("printf stdout; printf stderr >&2; exit 7"),
                1024,
                None,
                "test worker",
            )
            .unwrap();
        assert!(!execution.status.success());
        assert_eq!(execution.stdout, b"stdout");
        assert_eq!(execution.stderr, b"stderr");
        assert!(!execution.timed_out);
        assert!(registry.is_empty().unwrap());
    }

    #[test]
    fn cancellation_kills_only_the_registered_worker_and_releases_its_slot() {
        let registry = Arc::new(WorkerRegistry::new());
        let runner = registry.clone();
        let task = thread::spawn(move || {
            #[cfg(target_os = "windows")]
            let command = test_command("[System.Threading.Thread]::Sleep(30000)");
            #[cfg(not(target_os = "windows"))]
            let command = test_command("sleep 30");
            runner.run("job_cancel_test", command, 1024, None, "test worker")
        });
        let until = Instant::now() + Duration::from_secs(3);
        while !registry.is_active("job_cancel_test").unwrap() && Instant::now() < until {
            thread::sleep(Duration::from_millis(10));
        }
        assert!(registry.cancel("job_cancel_test").unwrap());
        let execution = task.join().unwrap().unwrap();
        assert!(!execution.status.success());
        assert!(registry.is_empty().unwrap());
        assert!(!registry.cancel("job_cancel_test").unwrap());
    }

    #[cfg(windows)]
    #[test]
    fn cancellation_kills_launcher_descendant_after_readiness() {
        let root = scratch_dir("tree-cancel");
        fs::create_dir_all(&root).unwrap();
        let marker = root.join("descendant-ready.txt");
        let registry = Arc::new(WorkerRegistry::new());
        let runner = registry.clone();
        let marker_path = marker.clone();
        let task = thread::spawn(move || {
            runner.run(
                "job_tree_cancel",
                descendant_launcher_command(&marker_path, 8),
                1024,
                None,
                "test worker",
            )
        });
        let deadline = Instant::now() + Duration::from_secs(8);
        while !marker.exists() && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(20));
        }
        thread::sleep(Duration::from_millis(300));
        let launcher_remained_supervised = !task.is_finished();
        let cancelled = registry.cancel("job_tree_cancel");
        let execution = task.join().unwrap();
        assert!(
            marker.exists(),
            "the launcher did not report that it started its descendant"
        );
        assert!(
            launcher_remained_supervised,
            "the launcher exited but its descendant escaped the job"
        );
        assert!(cancelled.unwrap());
        let execution = execution.unwrap();
        assert!(execution.status.success());
        assert!(!execution.timed_out);
        assert!(registry.is_empty().unwrap());
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn timeout_kills_launcher_descendant_after_readiness() {
        let root = scratch_dir("tree-timeout");
        fs::create_dir_all(&root).unwrap();
        let marker = root.join("descendant-ready.txt");
        let registry = WorkerRegistry::new();
        let start = Instant::now();
        let execution = registry
            .run(
                "job_tree_timeout",
                descendant_launcher_command(&marker, 10),
                1024,
                Some(Duration::from_secs(5)),
                "test worker",
            )
            .unwrap();
        assert!(
            marker.exists(),
            "the launcher did not report that it started its descendant"
        );
        assert!(
            execution.timed_out,
            "the launcher exited but its descendant escaped the job"
        );
        assert!(
            execution.status.success(),
            "the launcher should exit successfully before the timeout"
        );
        assert!(start.elapsed() < Duration::from_secs(10));
        assert!(registry.is_empty().unwrap());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn training_artifact_inventory_detects_tampering() {
        let root = scratch_dir("artifact");
        fs::create_dir_all(&root).unwrap();
        let file = root.join("adapter_model.safetensors");
        fs::write(&file, b"adapter").unwrap();
        let evidence = write_and_verify_training_artifact(&root, "lora").unwrap();
        assert_eq!(evidence.file_count, 1);
        assert_eq!(evidence.sha256.len(), 64);
        fs::write(&file, b"tampered").unwrap();
        assert!(verify_training_artifact(&root).is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn gpu_metadata_requires_cuda_devices_finite_evaluation_and_no_offload() {
        let root = scratch_dir("metadata");
        fs::create_dir_all(&root).unwrap();
        let metadata = serde_json::json!({
            "requestedConfig": {"method":"lora", "computeDevice":"gpu", "batchSize":1},
            "effectiveConfig": {"method":"lora", "computeDevice":"gpu", "batchSize":1, "device":"cuda:0", "cpuOffload":false, "precision":"bf16"},
            "deviceEvidence": {"requested":"gpu", "parameterDevices":["cuda:0"], "optimizerStateDevices":["cuda:0"], "gpuName":"RTX", "peakAllocatedVramBytes":1024},
            "trainingMetrics": {"train_loss":1.25},
            "evaluationMetrics": {"eval_loss":1.5}
        });
        fs::write(
            root.join(TRAINING_METADATA_FILE),
            serde_json::to_vec(&metadata).unwrap(),
        )
        .unwrap();
        let evidence = validate_training_metadata(&root, "gpu", true)
            .unwrap()
            .unwrap();
        assert_eq!(evidence.effective_device, "cuda:0");
        assert_eq!(evidence.optimizer_state_devices, vec!["cuda:0"]);
        assert_eq!(evidence.eval_loss, 1.5);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn legacy_metadata_without_device_evidence_remains_reloadable() {
        let root = scratch_dir("legacy-metadata");
        fs::create_dir_all(&root).unwrap();
        let metadata = serde_json::json!({
            "requestedConfig": {"method":"lora", "computeDevice":"gpu", "batchSize":1},
            "effectiveConfig": {"method":"lora", "computeDevice":"gpu", "batchSize":1},
            "trainingMetrics": {"train_loss":1.25}
        });
        fs::write(
            root.join(TRAINING_METADATA_FILE),
            serde_json::to_vec(&metadata).unwrap(),
        )
        .unwrap();
        assert!(validate_training_metadata(&root, "gpu", false)
            .unwrap()
            .is_none());
        assert!(validate_training_metadata(&root, "gpu", true).is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn partial_new_device_evidence_is_not_treated_as_legacy() {
        let root = scratch_dir("partial-device-metadata");
        fs::create_dir_all(&root).unwrap();
        let metadata = serde_json::json!({
            "requestedConfig": {"method":"lora", "computeDevice":"gpu", "batchSize":1},
            "effectiveConfig": {"method":"lora", "computeDevice":"gpu", "batchSize":1, "device":"cuda:0", "cpuOffload":true},
            "trainingMetrics": {"train_loss":1.25},
            "evaluationMetrics": {"eval_loss":1.5}
        });
        fs::write(
            root.join(TRAINING_METADATA_FILE),
            serde_json::to_vec(&metadata).unwrap(),
        )
        .unwrap();
        assert!(validate_training_metadata(&root, "gpu", false).is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn gpu_metadata_rejects_cpu_parameter_or_nonfinite_evaluation_evidence() {
        let root = scratch_dir("bad-metadata");
        fs::create_dir_all(&root).unwrap();
        let metadata = serde_json::json!({
            "requestedConfig": {"method":"lora", "computeDevice":"gpu", "batchSize":1},
            "effectiveConfig": {"method":"lora", "computeDevice":"gpu", "batchSize":1, "device":"cuda:0", "cpuOffload":false, "precision":"bf16"},
            "deviceEvidence": {"requested":"gpu", "parameterDevices":["cpu"], "optimizerStateDevices":["cpu"], "gpuName":"RTX", "peakAllocatedVramBytes":1024},
            "trainingMetrics": {"train_loss":1.25},
            "evaluationMetrics": {"eval_loss":1.5}
        });
        fs::write(
            root.join(TRAINING_METADATA_FILE),
            serde_json::to_vec(&metadata).unwrap(),
        )
        .unwrap();
        assert!(validate_training_metadata(&root, "gpu", true).is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn gpu_metadata_rejects_cpu_optimizer_state_even_when_parameters_are_cuda() {
        let root = scratch_dir("cpu-optimizer-state");
        fs::create_dir_all(&root).unwrap();
        let metadata = serde_json::json!({
            "requestedConfig": {"method":"lora", "computeDevice":"gpu", "batchSize":1},
            "effectiveConfig": {"method":"lora", "computeDevice":"gpu", "batchSize":1, "device":"cuda:0", "cpuOffload":false, "precision":"bf16"},
            "deviceEvidence": {"requested":"gpu", "parameterDevices":["cuda:0"], "optimizerStateDevices":["cpu"], "gpuName":"RTX", "peakAllocatedVramBytes":1024},
            "trainingMetrics": {"train_loss":1.25},
            "evaluationMetrics": {"eval_loss":1.5}
        });
        fs::write(
            root.join(TRAINING_METADATA_FILE),
            serde_json::to_vec(&metadata).unwrap(),
        )
        .unwrap();
        assert!(validate_training_metadata(&root, "gpu", true).is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn receipt_validation_rejects_wrong_artifact_and_inference_cpu_offload() {
        let receipt = serde_json::json!({
            "protocol":1, "localOnly":true, "completed":true,
            "method":"lora", "artifactPath":"D:/job/weight-artifact"
        });
        assert!(validate_training_receipt(
            &serde_json::to_vec(&receipt).unwrap(),
            "lora",
            Path::new("D:/other/weight-artifact")
        )
        .is_err());
        let inference = serde_json::json!({
            "protocol":1, "localOnly":true, "completed":true, "method":"lora",
            "text":"argument", "inputTokens":1, "outputTokens":1,
            "device":"cuda:0", "computeDevice":"gpu", "cpuOffload":true
        });
        assert!(validate_inference_receipt(
            &serde_json::to_vec(&inference).unwrap(),
            "lora",
            Some("gpu")
        )
        .is_err());
    }
}
