use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::io::{BufReader, Read};
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;
    use std::time::{SystemTime, UNIX_EPOCH};

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
