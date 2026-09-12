use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, OpenOptions};
use std::io::{BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{Duration, Instant};
use tauri::{Emitter, Manager};

const WORKER_PROTOCOL: u8 = 1;
const WORKER_SOURCE: &str = include_str!("../workers/model_foundry/worker.py");
const TRAINING_CATALOG_SOURCE: &str = include_str!("../workers/model_foundry/training-models.json");
const TRAINING_ARTIFACT_MANIFEST: &str = ".vibespace-artifact.json";
const MAX_ARTIFACT_FILES: usize = 4_096;
const MAX_ARTIFACT_DEPTH: usize = 8;
const MAX_ARTIFACT_MANIFEST_BYTES: u64 = 4 * 1024 * 1024;
const MAX_WORKER_LOG_BYTES: usize = 256 * 1024;
const MAX_INFERENCE_RESPONSE_BYTES: u64 = 4 * 1024 * 1024;
const INFERENCE_TIMEOUT: Duration = Duration::from_secs(10 * 60);
const TRAINING_MODEL_MARKER: &str = ".vibespace-model.json";
const MAX_TRAINING_MODEL_MARKER_BYTES: u64 = 4 * 1024;
const DOWNLOAD_BUFFER_BYTES: usize = 1024 * 1024;
static ACTIVE_TRAINING: LazyLock<Mutex<BTreeMap<String, Arc<Mutex<Child>>>>> =
    LazyLock::new(|| Mutex::new(BTreeMap::new()));
static ACTIVE_INFERENCE: LazyLock<Mutex<BTreeMap<String, Arc<Mutex<Child>>>>> =
    LazyLock::new(|| Mutex::new(BTreeMap::new()));
static ACTIVE_MODEL_DOWNLOAD: LazyLock<Mutex<Option<String>>> = LazyLock::new(|| Mutex::new(None));
static MODEL_STORAGE_LOCK: LazyLock<Mutex<()>> = LazyLock::new(|| Mutex::new(()));
static MODEL_DOWNLOAD_CANCELLED: AtomicBool = AtomicBool::new(false);

struct TrainingRegistryGuard(String);

impl Drop for TrainingRegistryGuard {
    fn drop(&mut self) {
        if let Ok(mut active) = ACTIVE_TRAINING.lock() {
            active.remove(&self.0);
        }
    }
}

struct InferenceRegistryGuard(String);

impl Drop for InferenceRegistryGuard {
    fn drop(&mut self) {
        if let Ok(mut active) = ACTIVE_INFERENCE.lock() {
            active.remove(&self.0);
        }
    }
}

struct ModelDownloadGuard;

impl Drop for ModelDownloadGuard {
    fn drop(&mut self) {
        if let Ok(mut active) = ACTIVE_MODEL_DOWNLOAD.lock() {
            *active = None;
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TrainingCatalogFile {
    path: String,
    bytes: u64,
    sha256: String,
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
    pub(crate) speed: String,
    pub(crate) quality: String,
    pub(crate) cpu_practical: bool,
    pub(crate) files: Vec<TrainingCatalogFile>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrainingCatalogEntry {
    #[serde(flatten)]
    model: TrainingCatalogModel,
    installed: bool,
    verified: bool,
    installed_bytes: u64,
    status: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct TrainingModelMarker {
    schema_version: u8,
    id: String,
    revision: String,
    manifest_sha256: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct TrainingModelDownloadProgress {
    model_id: String,
    file: String,
    downloaded_bytes: u64,
    total_bytes: u64,
    percent: u8,
    phase: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TrainingCatalogManifest {
    schema_version: u8,
    updated_at: String,
    source_host: String,
    models: Vec<TrainingCatalogModel>,
}

fn valid_hex(value: &str, length: usize) -> bool {
    value.len() == length && value.chars().all(|character| character.is_ascii_hexdigit())
}

fn safe_catalog_component(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | '-')
        })
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

fn training_model_download_url(
    model: &TrainingCatalogModel,
    file: &TrainingCatalogFile,
) -> Result<url::Url, String> {
    if !safe_catalog_component(&model.id)
        || !valid_hex(&model.revision, 40)
        || !safe_catalog_component(&file.path)
    {
        return Err("Verified training model download metadata is unsafe.".into());
    }
    let source_parts = model.source_id.split('/').collect::<Vec<_>>();
    if source_parts.len() != 2
        || !source_parts
            .iter()
            .all(|component| safe_catalog_component(component))
    {
        return Err("Verified training model source is unsafe.".into());
    }
    let url = url::Url::parse(&format!(
        "https://huggingface.co/{}/resolve/{}/{}",
        model.source_id, model.revision, file.path
    ))
    .map_err(|_| "Verified training model URL is invalid.".to_string())?;
    if url.scheme() != "https" || url.host_str() != Some("huggingface.co") {
        return Err("Verified training model URL is not trusted.".into());
    }
    Ok(url)
}

fn trusted_training_download_host(host: Option<&str>) -> bool {
    host.is_some_and(|host| {
        host == "huggingface.co"
            || host.ends_with(".huggingface.co")
            || host == "hf.co"
            || host.ends_with(".hf.co")
    })
}

fn training_model_redirect_policy() -> reqwest::redirect::Policy {
    reqwest::redirect::Policy::custom(|attempt| {
        if attempt.previous().len() >= 8 {
            return attempt.error("Training model download exceeded the redirect limit.");
        }
        let target = attempt.url();
        if target.scheme() == "https" && trusted_training_download_host(target.host_str()) {
            attempt.follow()
        } else {
            attempt.error("Training model download redirect left the trusted source.")
        }
    })
}

fn training_model_manifest_sha256(model: &TrainingCatalogModel) -> Result<String, String> {
    serde_json::to_vec(model)
        .map(|bytes| source_sha256(&bytes))
        .map_err(|error| format!("Could not encode training model manifest: {error}"))
}

fn write_training_model_marker(
    directory: &Path,
    model: &TrainingCatalogModel,
) -> Result<(), String> {
    let marker = TrainingModelMarker {
        schema_version: 1,
        id: model.id.clone(),
        revision: model.revision.clone(),
        manifest_sha256: training_model_manifest_sha256(model)?,
    };
    let bytes = serde_json::to_vec_pretty(&marker)
        .map_err(|error| format!("Could not encode training model marker: {error}"))?;
    let marker_path = directory.join(TRAINING_MODEL_MARKER);
    let temporary = directory.join(format!("{TRAINING_MODEL_MARKER}.tmp"));
    if temporary.exists() {
        fs::remove_file(&temporary)
            .map_err(|error| format!("Could not clear stale training model marker: {error}"))?;
    }
    fs::write(&temporary, bytes)
        .map_err(|error| format!("Could not persist training model marker: {error}"))?;
    if marker_path.exists() {
        fs::remove_file(&marker_path)
            .map_err(|error| format!("Could not replace training model marker: {error}"))?;
    }
    fs::rename(&temporary, &marker_path)
        .map_err(|error| format!("Could not activate training model marker: {error}"))
}

fn verify_training_model_directory(
    model_root: &Path,
    model: &TrainingCatalogModel,
) -> Result<u64, String> {
    if !model_root.is_dir() {
        return Err("The verified trainable base model is not installed.".into());
    }
    let entries = fs::read_dir(&model_root)
        .map_err(|error| format!("Could not inspect trainable base model: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Could not inspect trainable base model: {error}"))?;
    if entries.iter().any(|entry| {
        entry.file_name().to_str().is_none_or(|name| {
            name != TRAINING_MODEL_MARKER && !model.files.iter().any(|file| file.path == name)
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
        let (bytes, sha256) = artifact_file_sha256(&path)?;
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

fn verify_training_model_files(root: &Path, model: &TrainingCatalogModel) -> Result<u64, String> {
    verify_training_model_directory(&root.join("base-models").join(&model.id), model)
}

fn training_model_status(root: &Path, model: TrainingCatalogModel) -> TrainingCatalogEntry {
    let directory = root.join("base-models").join(&model.id);
    if !directory.is_dir() {
        return TrainingCatalogEntry {
            model,
            installed: false,
            verified: false,
            installed_bytes: 0,
            status: "not-installed".into(),
        };
    }
    let expected_fingerprint = training_model_manifest_sha256(&model).ok();
    let marker_path = directory.join(TRAINING_MODEL_MARKER);
    let marker = fs::symlink_metadata(&marker_path)
        .ok()
        .filter(|metadata| {
            metadata.is_file()
                && !metadata.file_type().is_symlink()
                && metadata.len() <= MAX_TRAINING_MODEL_MARKER_BYTES
        })
        .and_then(|_| fs::read(marker_path).ok())
        .and_then(|bytes| serde_json::from_slice::<TrainingModelMarker>(&bytes).ok());
    let verified = marker.is_some_and(|marker| {
        marker.schema_version == 1
            && marker.id == model.id
            && marker.revision == model.revision
            && Some(marker.manifest_sha256) == expected_fingerprint
            && model.files.iter().all(|file| {
                fs::symlink_metadata(directory.join(&file.path))
                    .map(|metadata| {
                        metadata.is_file()
                            && !metadata.file_type().is_symlink()
                            && metadata.len() == file.bytes
                    })
                    .unwrap_or(false)
            })
    });
    TrainingCatalogEntry {
        installed_bytes: if verified { model.download_bytes } else { 0 },
        model,
        installed: true,
        verified,
        status: if verified {
            "ready".into()
        } else {
            "repair-required".into()
        },
    }
}

pub(crate) fn training_model_id_allowed(base_model_id: &str) -> bool {
    training_catalog()
        .map(|models| models.iter().any(|model| model.id == base_model_id))
        .unwrap_or(false)
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrainingWorkerStatus {
    installed: bool,
    attested: bool,
    protocol: u8,
    source_sha256: String,
    python: Option<String>,
    methods: Vec<String>,
    modalities: Vec<String>,
    precisions: Vec<String>,
    reason: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TrainingWorkerProbe {
    protocol: u8,
    local_only: bool,
    ready: bool,
    #[serde(default)]
    methods: Vec<String>,
    #[serde(default)]
    modalities: Vec<String>,
    #[serde(default)]
    precisions: Vec<String>,
    reason: Option<String>,
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

#[derive(Clone, Debug)]
pub(crate) struct TrainingArtifactEvidence {
    pub(crate) file_count: usize,
    pub(crate) storage_bytes: u64,
    pub(crate) sha256: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct TrainingRunRequest {
    protocol: u8,
    local_only: bool,
    method: String,
    base_model_path: String,
    dataset_path: String,
    output_dir: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    resume_from_checkpoint: Option<String>,
    epochs: u8,
    max_steps: u32,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TrainingRunResponse {
    protocol: u8,
    local_only: bool,
    completed: bool,
    method: String,
    artifact_path: String,
}

#[derive(Clone, Debug)]
pub(crate) struct TrainingRunResult {
    pub(crate) artifact_path: PathBuf,
    pub(crate) evidence: TrainingArtifactEvidence,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct InferenceMessage {
    role: String,
    content: String,
}

#[derive(Debug, Serialize)]
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
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct InferenceResponse {
    protocol: u8,
    local_only: bool,
    completed: bool,
    method: String,
    text: String,
    input_tokens: u64,
    output_tokens: u64,
}

#[derive(Clone, Debug)]
pub(crate) struct FoundryInferenceResult {
    pub(crate) text: String,
    pub(crate) input_tokens: u64,
    pub(crate) output_tokens: u64,
}

fn source_sha256(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn expected_source_sha256() -> String {
    source_sha256(WORKER_SOURCE.as_bytes())
}

fn training_root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|path| path.join("model-foundry").join("training-runtime"))
        .map_err(|error| format!("Model Foundry training directory unavailable: {error}"))
}

fn worker_path(root: &Path) -> PathBuf {
    root.join("worker.py")
}

pub(crate) fn training_model_path(root: &Path, base_model_id: &str) -> Result<PathBuf, String> {
    let model = training_catalog()?
        .into_iter()
        .find(|model| model.id == base_model_id)
        .ok_or_else(|| "The selected model has no verified local training manifest.".to_string())?;
    Ok(root.join("base-models").join(model.id))
}

fn artifact_file_sha256(path: &Path) -> Result<(u64, String), String> {
    let file = fs::File::open(path)
        .map_err(|error| format!("Could not inspect training artifact: {error}"))?;
    let bytes = file
        .metadata()
        .map_err(|error| format!("Could not inspect training artifact: {error}"))?
        .len();
    let mut reader = BufReader::new(file);
    let mut digest = Sha256::new();
    let mut buffer = [0_u8; 1024 * 1024];
    loop {
        let count = reader
            .read(&mut buffer)
            .map_err(|error| format!("Could not hash training artifact: {error}"))?;
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
        let (bytes, sha256) = artifact_file_sha256(&path)?;
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
    if !root.is_dir() {
        return Err("Training artifact directory is missing.".into());
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
    let metadata =
        fs::metadata(&path).map_err(|_| "Training artifact manifest is missing.".to_string())?;
    if metadata.len() > MAX_ARTIFACT_MANIFEST_BYTES {
        return Err("Training artifact manifest exceeds the safe size limit.".into());
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

fn locate_python() -> Option<String> {
    ["python3", "python", "py"]
        .into_iter()
        .find_map(|candidate| {
            Command::new(candidate)
                .arg("--version")
                .output()
                .ok()
                .filter(|output| output.status.success())
                .map(|_| candidate.to_string())
        })
}

fn validated_probe(bytes: &[u8]) -> Result<TrainingWorkerProbe, String> {
    let probe: TrainingWorkerProbe = serde_json::from_slice(bytes)
        .map_err(|error| format!("Training worker returned invalid status: {error}"))?;
    if probe.protocol != WORKER_PROTOCOL {
        return Err("Training worker protocol does not match this VibeSpace build.".into());
    }
    if !probe.local_only {
        return Err("Training worker did not attest to local-only execution.".into());
    }
    if probe
        .methods
        .iter()
        .any(|value| !matches!(value.as_str(), "lora" | "qlora" | "full"))
        || probe
            .modalities
            .iter()
            .any(|value| !matches!(value.as_str(), "text" | "image" | "video" | "audio"))
        || probe
            .precisions
            .iter()
            .any(|value| !matches!(value.as_str(), "fp32" | "fp16" | "bf16" | "int8" | "int4"))
    {
        return Err("Training worker advertised an unsupported capability.".into());
    }
    Ok(probe)
}

fn probe_worker(python: &str, path: &Path) -> Result<TrainingWorkerProbe, String> {
    let output = Command::new(python)
        .arg(path)
        .arg("probe")
        .output()
        .map_err(|error| format!("Could not start the verified local training worker: {error}"))?;
    if !output.status.success() {
        return Err("The verified local training worker could not inspect its libraries.".into());
    }
    validated_probe(&output.stdout)
}

fn inspect_worker(root: &Path) -> TrainingWorkerStatus {
    let expected = expected_source_sha256();
    let path = worker_path(root);
    if !path.is_file() {
        return TrainingWorkerStatus {
            installed: false,
            attested: false,
            protocol: WORKER_PROTOCOL,
            source_sha256: expected,
            python: locate_python(),
            methods: Vec::new(),
            modalities: Vec::new(),
            precisions: Vec::new(),
            reason: Some("The verified local training worker has not been installed.".into()),
        };
    }
    let bytes = match fs::read(&path) {
        Ok(bytes) => bytes,
        Err(error) => {
            return TrainingWorkerStatus {
                installed: true,
                attested: false,
                protocol: WORKER_PROTOCOL,
                source_sha256: expected,
                python: locate_python(),
                methods: Vec::new(),
                modalities: Vec::new(),
                precisions: Vec::new(),
                reason: Some(format!(
                    "Could not inspect the local training worker: {error}"
                )),
            }
        }
    };
    if source_sha256(&bytes) != expected {
        return TrainingWorkerStatus {
            installed: true,
            attested: false,
            protocol: WORKER_PROTOCOL,
            source_sha256: expected,
            python: locate_python(),
            methods: Vec::new(),
            modalities: Vec::new(),
            precisions: Vec::new(),
            reason: Some("The local training worker failed integrity verification.".into()),
        };
    }
    let python = locate_python();
    if python.is_none() {
        return TrainingWorkerStatus {
            installed: true,
            attested: true,
            protocol: WORKER_PROTOCOL,
            source_sha256: expected,
            python: None,
            methods: Vec::new(),
            modalities: Vec::new(),
            precisions: Vec::new(),
            reason: Some("Python 3 is required to run the local training worker.".into()),
        };
    }
    let python = python.unwrap_or_default();
    match probe_worker(&python, &path) {
        Ok(probe) if probe.ready => TrainingWorkerStatus {
            installed: true,
            attested: true,
            protocol: WORKER_PROTOCOL,
            source_sha256: expected,
            python: Some(python),
            methods: probe.methods,
            modalities: probe.modalities,
            precisions: probe.precisions,
            reason: probe.reason,
        },
        Ok(probe) => TrainingWorkerStatus {
            installed: true,
            attested: true,
            protocol: WORKER_PROTOCOL,
            source_sha256: expected,
            python: Some(python),
            methods: Vec::new(),
            modalities: Vec::new(),
            precisions: Vec::new(),
            reason: probe
                .reason
                .or_else(|| Some("Verified local training libraries are incomplete.".into())),
        },
        Err(error) => TrainingWorkerStatus {
            installed: true,
            attested: true,
            protocol: WORKER_PROTOCOL,
            source_sha256: expected,
            python: Some(python),
            methods: Vec::new(),
            modalities: Vec::new(),
            precisions: Vec::new(),
            reason: Some(error),
        },
    }
}

fn catalog_model(base_model_id: &str) -> Result<TrainingCatalogModel, String> {
    training_catalog()?
        .into_iter()
        .find(|model| model.id == base_model_id)
        .ok_or_else(|| "The selected model has no verified local training manifest.".to_string())
}

fn emit_model_download_progress(
    app: &tauri::AppHandle,
    model: &TrainingCatalogModel,
    file: &TrainingCatalogFile,
    downloaded_bytes: u64,
    phase: &str,
) {
    let percent = if model.download_bytes == 0 {
        0
    } else {
        ((downloaded_bytes.saturating_mul(100) / model.download_bytes).min(100)) as u8
    };
    let _ = app.emit(
        "model-foundry:training-model-download",
        TrainingModelDownloadProgress {
            model_id: model.id.clone(),
            file: file.path.clone(),
            downloaded_bytes,
            total_bytes: model.download_bytes,
            percent,
            phase: phase.into(),
        },
    );
}

fn download_training_model_file(
    app: &tauri::AppHandle,
    client: &reqwest::blocking::Client,
    model: &TrainingCatalogModel,
    file: &TrainingCatalogFile,
    staging: &Path,
    completed_before: u64,
) -> Result<(), String> {
    let destination = staging.join(&file.path);
    if destination.is_file() {
        let (bytes, sha256) = artifact_file_sha256(&destination)?;
        if bytes == file.bytes && sha256 == file.sha256 {
            emit_model_download_progress(
                app,
                model,
                file,
                completed_before.saturating_add(bytes),
                "downloading",
            );
            return Ok(());
        }
        fs::remove_file(&destination)
            .map_err(|error| format!("Could not replace corrupt model file: {error}"))?;
    }

    let partial = staging.join(format!("{}.part", file.path));
    let mut existing = fs::metadata(&partial).map(|value| value.len()).unwrap_or(0);
    if existing == file.bytes {
        let (_, sha256) = artifact_file_sha256(&partial)?;
        if sha256 == file.sha256 {
            fs::rename(&partial, &destination)
                .map_err(|error| format!("Could not activate verified model file: {error}"))?;
            return Ok(());
        }
        fs::remove_file(&partial)
            .map_err(|error| format!("Could not reset corrupt model download: {error}"))?;
        existing = 0;
    } else if existing > file.bytes {
        fs::remove_file(&partial)
            .map_err(|error| format!("Could not reset oversized model download: {error}"))?;
        existing = 0;
    }

    let url = training_model_download_url(model, file)?;
    let mut request = client.get(url);
    if existing > 0 {
        request = request.header(reqwest::header::RANGE, format!("bytes={existing}-"));
    }
    let mut response = request
        .send()
        .map_err(|error| format!("Could not download {}: {error}", file.path))?;
    let append = existing > 0 && response.status() == reqwest::StatusCode::PARTIAL_CONTENT;
    if !response.status().is_success() {
        return Err(format!(
            "Training model download failed with HTTP {} for {}.",
            response.status(),
            file.path
        ));
    }
    if existing > 0 && !append {
        existing = 0;
    }
    let mut output = OpenOptions::new()
        .create(true)
        .write(true)
        .append(append)
        .truncate(!append)
        .open(&partial)
        .map_err(|error| format!("Could not prepare model download: {error}"))?;
    let mut downloaded = existing;
    let mut buffer = vec![0_u8; DOWNLOAD_BUFFER_BYTES];
    loop {
        if MODEL_DOWNLOAD_CANCELLED.load(Ordering::Relaxed) {
            return Err("Training model download cancelled.".into());
        }
        let count = response
            .read(&mut buffer)
            .map_err(|error| format!("Training model download was interrupted: {error}"))?;
        if count == 0 {
            break;
        }
        downloaded = downloaded
            .checked_add(count as u64)
            .ok_or_else(|| "Training model download size overflowed.".to_string())?;
        if downloaded > file.bytes {
            return Err("Training model download exceeded its verified size.".into());
        }
        output
            .write_all(&buffer[..count])
            .map_err(|error| format!("Could not persist model download: {error}"))?;
        emit_model_download_progress(
            app,
            model,
            file,
            completed_before.saturating_add(downloaded),
            "downloading",
        );
    }
    output
        .sync_all()
        .map_err(|error| format!("Could not flush model download: {error}"))?;
    if downloaded != file.bytes {
        return Err("Training model download ended before the verified size was reached.".into());
    }
    let (_, sha256) = artifact_file_sha256(&partial)?;
    if sha256 != file.sha256 {
        let _ = fs::remove_file(&partial);
        return Err(format!(
            "Training model file failed checksum verification: {}",
            file.path
        ));
    }
    fs::rename(&partial, &destination)
        .map_err(|error| format!("Could not activate verified model file: {error}"))
}

fn activate_training_model(
    staging: &Path,
    destination: &Path,
    replace: bool,
) -> Result<(), String> {
    if !destination.exists() {
        return fs::rename(staging, destination)
            .map_err(|error| format!("Could not activate verified training model: {error}"));
    }
    if !replace {
        return Err("The installed training model requires repair before replacement.".into());
    }
    let backup = destination.with_extension("repair-backup");
    if backup.exists() {
        fs::remove_dir_all(&backup)
            .map_err(|error| format!("Could not clear stale model repair backup: {error}"))?;
    }
    fs::rename(destination, &backup)
        .map_err(|error| format!("Could not prepare training model repair: {error}"))?;
    if let Err(error) = fs::rename(staging, destination) {
        let _ = fs::rename(&backup, destination);
        return Err(format!(
            "Could not activate repaired training model: {error}"
        ));
    }
    fs::remove_dir_all(backup)
        .map_err(|error| format!("Could not remove replaced training model: {error}"))
}

fn remove_owned_training_directory(path: &Path) -> Result<(), String> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(format!("Could not inspect training model storage: {error}")),
    };
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err("Training model storage contains an unsafe filesystem entry.".into());
    }
    fs::remove_dir_all(path)
        .map_err(|error| format!("Could not remove training model storage: {error}"))
}

fn remove_training_model_directory(
    root: &Path,
    model: &TrainingCatalogModel,
) -> Result<(), String> {
    if !safe_catalog_component(&model.id) {
        return Err("The selected training model identifier is unsafe.".into());
    }
    let base_models = root.join("base-models");
    let destination = base_models.join(&model.id);
    let removing = base_models.join(format!(".{}.removing", model.id));
    if removing.exists() {
        return Err("A previous training model removal requires recovery.".into());
    }
    if destination.exists() {
        let metadata = fs::symlink_metadata(&destination)
            .map_err(|error| format!("Could not inspect training model storage: {error}"))?;
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            return Err("Training model storage contains an unsafe filesystem entry.".into());
        }
        fs::rename(&destination, &removing).map_err(|error| {
            format!("Could not isolate the training model for removal: {error}")
        })?;
        if let Err(error) = remove_owned_training_directory(&removing) {
            let _ = fs::rename(&removing, &destination);
            return Err(error);
        }
    }
    remove_owned_training_directory(&base_models.join(format!(".{}.download", model.id)))?;
    remove_owned_training_directory(&base_models.join(format!("{}.repair-backup", model.id)))?;
    Ok(())
}

fn install_training_model(
    app: &tauri::AppHandle,
    base_model_id: &str,
    replace: bool,
) -> Result<TrainingCatalogEntry, String> {
    let model = catalog_model(base_model_id)?;
    {
        let mut active = ACTIVE_MODEL_DOWNLOAD
            .lock()
            .map_err(|_| "Training model download registry is unavailable.".to_string())?;
        if active.is_some() {
            return Err("Another verified training model download is already active.".into());
        }
        *active = Some(model.id.clone());
    }
    let _guard = ModelDownloadGuard;
    MODEL_DOWNLOAD_CANCELLED.store(false, Ordering::Relaxed);

    let root = training_root(app)?;
    let base_models = root.join("base-models");
    fs::create_dir_all(&base_models)
        .map_err(|error| format!("Could not prepare training model storage: {error}"))?;
    let destination = base_models.join(&model.id);
    if verify_training_model_directory(&destination, &model).is_ok() {
        write_training_model_marker(&destination, &model)?;
        return Ok(training_model_status(&root, model));
    }
    if destination.exists() && !replace {
        return Err("The installed training model is incomplete or corrupt. Choose Repair.".into());
    }
    let staging = base_models.join(format!(".{}.download", model.id));
    fs::create_dir_all(&staging)
        .map_err(|error| format!("Could not prepare resumable model download: {error}"))?;
    let partial_bytes = fs::read_dir(&staging)
        .ok()
        .into_iter()
        .flatten()
        .filter_map(Result::ok)
        .filter_map(|entry| entry.metadata().ok())
        .filter(|metadata| metadata.is_file())
        .map(|metadata| metadata.len())
        .sum::<u64>();
    let remaining = model.download_bytes.saturating_sub(partial_bytes);
    let available = fs4::available_space(&base_models)
        .map_err(|error| format!("Could not inspect training model storage: {error}"))?;
    if available < remaining.saturating_add(512 * 1024 * 1024) {
        return Err(format!(
            "Not enough free storage for {}. Keep at least {} bytes available.",
            model.label,
            remaining.saturating_add(512 * 1024 * 1024)
        ));
    }
    let client = reqwest::blocking::Client::builder()
        .connect_timeout(Duration::from_secs(20))
        .timeout(Duration::from_secs(6 * 60 * 60))
        .redirect(training_model_redirect_policy())
        .user_agent("VibeSpace/1.5 ModelFoundry")
        .build()
        .map_err(|error| format!("Could not prepare training model download: {error}"))?;
    let mut completed = 0_u64;
    for file in &model.files {
        download_training_model_file(app, &client, &model, file, &staging, completed)?;
        completed = completed.saturating_add(file.bytes);
    }
    verify_training_model_directory(&staging, &model)?;
    write_training_model_marker(&staging, &model)?;
    let _storage_guard = MODEL_STORAGE_LOCK
        .lock()
        .map_err(|_| "Training model storage lock is unavailable.".to_string())?;
    if !ACTIVE_TRAINING
        .lock()
        .map_err(|_| "Model Foundry training registry is unavailable.".to_string())?
        .is_empty()
    {
        return Err("Stop active local training before activating a base model update.".into());
    }
    activate_training_model(&staging, &destination, replace)?;
    emit_model_download_progress(
        app,
        &model,
        model
            .files
            .last()
            .ok_or_else(|| "Training model manifest has no files.".to_string())?,
        model.download_bytes,
        "ready",
    );
    Ok(training_model_status(&root, model))
}

#[tauri::command]
pub fn model_foundry_training_worker_status(
    app: tauri::AppHandle,
) -> Result<TrainingWorkerStatus, String> {
    Ok(inspect_worker(&training_root(&app)?))
}

#[tauri::command]
pub fn model_foundry_training_catalog(
    app: tauri::AppHandle,
) -> Result<Vec<TrainingCatalogEntry>, String> {
    let root = training_root(&app)?;
    training_catalog().map(|models| {
        models
            .into_iter()
            .map(|model| training_model_status(&root, model))
            .collect()
    })
}

#[tauri::command]
pub async fn model_foundry_download_training_model(
    app: tauri::AppHandle,
    model_id: String,
) -> Result<TrainingCatalogEntry, String> {
    tauri::async_runtime::spawn_blocking(move || install_training_model(&app, &model_id, false))
        .await
        .map_err(|error| format!("Training model download worker failed: {error}"))?
}

#[tauri::command]
pub async fn model_foundry_repair_training_model(
    app: tauri::AppHandle,
    model_id: String,
) -> Result<TrainingCatalogEntry, String> {
    tauri::async_runtime::spawn_blocking(move || install_training_model(&app, &model_id, true))
        .await
        .map_err(|error| format!("Training model repair worker failed: {error}"))?
}

#[tauri::command]
pub fn model_foundry_cancel_training_model_download() -> Result<bool, String> {
    let active = ACTIVE_MODEL_DOWNLOAD
        .lock()
        .map_err(|_| "Training model download registry is unavailable.".to_string())?
        .is_some();
    if active {
        MODEL_DOWNLOAD_CANCELLED.store(true, Ordering::Relaxed);
    }
    Ok(active)
}

#[tauri::command]
pub fn model_foundry_remove_training_model(
    app: tauri::AppHandle,
    model_id: String,
) -> Result<TrainingCatalogEntry, String> {
    let model = catalog_model(&model_id)?;
    let _storage_guard = MODEL_STORAGE_LOCK
        .lock()
        .map_err(|_| "Training model storage lock is unavailable.".to_string())?;
    if ACTIVE_MODEL_DOWNLOAD
        .lock()
        .map_err(|_| "Training model download registry is unavailable.".to_string())?
        .is_some()
    {
        return Err("Cancel the active training model download before removing a model.".into());
    }
    if !ACTIVE_TRAINING
        .lock()
        .map_err(|_| "Model Foundry training registry is unavailable.".to_string())?
        .is_empty()
    {
        return Err("Stop active local training before removing a base model.".into());
    }
    let root = training_root(&app)?;
    remove_training_model_directory(&root, &model)?;
    Ok(training_model_status(&root, model))
}

#[tauri::command]
pub fn model_foundry_install_training_worker(
    app: tauri::AppHandle,
) -> Result<TrainingWorkerStatus, String> {
    let root = training_root(&app)?;
    fs::create_dir_all(&root)
        .map_err(|error| format!("Could not create the private training directory: {error}"))?;
    let path = worker_path(&root);
    let temporary = root.join("worker.py.tmp");
    fs::write(&temporary, WORKER_SOURCE.as_bytes())
        .map_err(|error| format!("Could not write the verified local training worker: {error}"))?;
    fs::rename(&temporary, &path).map_err(|error| {
        format!("Could not activate the verified local training worker: {error}")
    })?;
    let status = inspect_worker(&root);
    if !status.attested {
        let _ = fs::remove_file(&path);
        return Err(status
            .reason
            .unwrap_or_else(|| "Training worker attestation failed.".into()));
    }
    Ok(status)
}

fn safe_job_id(value: &str) -> Result<&str, String> {
    if value.len() < 5
        || value.len() > 80
        || !value
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '_' | '-'))
    {
        return Err("Invalid Model Foundry training job identifier.".into());
    }
    Ok(value)
}

fn drain_bounded<R: Read>(mut reader: R, maximum: usize) -> Vec<u8> {
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

fn write_bounded_log(path: &Path, bytes: &[u8]) {
    let _ = fs::write(path, &bytes[..bytes.len().min(MAX_WORKER_LOG_BYTES)]);
}

pub(crate) fn latest_training_checkpoint(output: &Path) -> Result<Option<PathBuf>, String> {
    if !output.exists() {
        return Ok(None);
    }
    let metadata = fs::symlink_metadata(output)
        .map_err(|error| format!("Could not inspect training checkpoint storage: {error}"))?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err("Training checkpoint storage is not a safe directory.".into());
    }
    let mut latest: Option<(u64, PathBuf)> = None;
    for entry in fs::read_dir(output)
        .map_err(|error| format!("Could not inspect training checkpoints: {error}"))?
    {
        let entry =
            entry.map_err(|error| format!("Could not inspect training checkpoint: {error}"))?;
        let name = entry.file_name();
        let Some(name) = name.to_str() else {
            continue;
        };
        let Some(step) = name
            .strip_prefix("checkpoint-")
            .and_then(|value| value.parse::<u64>().ok())
        else {
            continue;
        };
        let path = entry.path();
        let checkpoint_metadata = fs::symlink_metadata(&path)
            .map_err(|error| format!("Could not inspect training checkpoint: {error}"))?;
        if !checkpoint_metadata.is_dir() || checkpoint_metadata.file_type().is_symlink() {
            continue;
        }
        let state = path.join("trainer_state.json");
        let state_metadata = match fs::symlink_metadata(&state) {
            Ok(metadata) => metadata,
            Err(_) => continue,
        };
        if !state_metadata.is_file() || state_metadata.file_type().is_symlink() {
            continue;
        }
        if latest.as_ref().is_none_or(|(current, _)| step > *current) {
            latest = Some((step, path));
        }
    }
    Ok(latest.map(|(_, path)| path))
}

pub(crate) fn run_training_worker(
    app: &tauri::AppHandle,
    job_id: &str,
    base_model_id: &str,
    method: &str,
    dataset_path: &Path,
    job_dir: &Path,
    epochs: u8,
    max_steps: u32,
    resume_checkpoint: Option<&Path>,
) -> Result<TrainingRunResult, String> {
    let job_id = safe_job_id(job_id)?;
    if !matches!(method, "lora" | "qlora" | "full") {
        return Err("Unsupported Model Foundry weight-training method.".into());
    }
    if !(1..=20).contains(&epochs) || !(1..=1_000_000).contains(&max_steps) {
        return Err("Model Foundry training limits are invalid.".into());
    }
    let root = training_root(app)?;
    let storage_guard = MODEL_STORAGE_LOCK
        .lock()
        .map_err(|_| "Training model storage lock is unavailable.".to_string())?;
    let status = inspect_worker(&root);
    if !status.installed || !status.attested || !status.methods.iter().any(|value| value == method)
    {
        return Err(format!(
            "The verified local training worker cannot run {} on this computer.",
            method.to_uppercase()
        ));
    }
    let python = status
        .python
        .ok_or_else(|| "Python 3 is required for local training.".to_string())?;
    let worker = worker_path(&root);
    let model_manifest = catalog_model(base_model_id)?;
    verify_training_model_files(&root, &model_manifest)?;
    let model = training_model_path(&root, base_model_id)?;
    let model = model
        .canonicalize()
        .map_err(|_| "The verified trainable base model is not installed.".to_string())?;
    if !model.is_dir() || !model.join("config.json").is_file() {
        return Err("The verified trainable base model is incomplete.".into());
    }
    let dataset = dataset_path
        .canonicalize()
        .map_err(|_| "The local training dataset is unavailable.".to_string())?;
    if !dataset.is_file()
        || dataset
            .extension()
            .and_then(|value| value.to_str())
            .is_none_or(|value| !value.eq_ignore_ascii_case("jsonl"))
    {
        return Err("Weight training requires one local JSONL dataset.".into());
    }
    fs::create_dir_all(job_dir)
        .map_err(|error| format!("Could not prepare the private training job: {error}"))?;
    let output = job_dir.join("weight-artifact");
    let verified_resume = match resume_checkpoint {
        Some(checkpoint) => {
            let latest = latest_training_checkpoint(&output)?.ok_or_else(|| {
                "No verified local training checkpoint is available to resume.".to_string()
            })?;
            if checkpoint != latest {
                return Err("The requested training checkpoint is stale or unsafe.".into());
            }
            Some(latest)
        }
        None if output.exists() => {
            return Err("This Model Foundry version already has a training artifact.".into());
        }
        None => None,
    };
    let request_path = job_dir.join("worker-request.json");
    let request = TrainingRunRequest {
        protocol: WORKER_PROTOCOL,
        local_only: true,
        method: method.to_string(),
        base_model_path: model.to_string_lossy().into_owned(),
        dataset_path: dataset.to_string_lossy().into_owned(),
        output_dir: output.to_string_lossy().into_owned(),
        resume_from_checkpoint: verified_resume
            .as_ref()
            .map(|path| path.to_string_lossy().into_owned()),
        epochs,
        max_steps,
    };
    let request_bytes = serde_json::to_vec_pretty(&request)
        .map_err(|error| format!("Could not encode the local training request: {error}"))?;
    let temporary = job_dir.join("worker-request.json.tmp");
    fs::write(&temporary, request_bytes)
        .map_err(|error| format!("Could not persist the local training request: {error}"))?;
    fs::rename(&temporary, &request_path)
        .map_err(|error| format!("Could not activate the local training request: {error}"))?;

    let mut child = Command::new(python)
        .arg(&worker)
        .arg("train")
        .arg(&request_path)
        .current_dir(&root)
        .env("HF_HUB_OFFLINE", "1")
        .env("TRANSFORMERS_OFFLINE", "1")
        .env("TOKENIZERS_PARALLELISM", "false")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("Could not start the verified local training worker: {error}"))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Local training stdout was unavailable.".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "Local training stderr was unavailable.".to_string())?;
    let stdout_thread = std::thread::spawn(move || drain_bounded(stdout, MAX_WORKER_LOG_BYTES));
    let stderr_thread = std::thread::spawn(move || drain_bounded(stderr, MAX_WORKER_LOG_BYTES));
    let child = Arc::new(Mutex::new(child));
    {
        let mut active = ACTIVE_TRAINING
            .lock()
            .map_err(|_| "Model Foundry training registry is unavailable.".to_string())?;
        if active.insert(job_id.to_string(), child.clone()).is_some() {
            let _ = child.lock().map(|mut process| process.kill());
            return Err("This Model Foundry training job is already active.".into());
        }
    }
    drop(storage_guard);
    let _registry_guard = TrainingRegistryGuard(job_id.to_string());
    let exit = loop {
        let result = child
            .lock()
            .map_err(|_| "Model Foundry training process is unavailable.".to_string())?
            .try_wait()
            .map_err(|error| format!("Could not monitor the local training worker: {error}"))?;
        if let Some(status) = result {
            break status;
        }
        std::thread::sleep(Duration::from_millis(250));
    };
    let stdout = stdout_thread.join().unwrap_or_default();
    let stderr = stderr_thread.join().unwrap_or_default();
    write_bounded_log(&job_dir.join("worker.stdout.log"), &stdout);
    write_bounded_log(&job_dir.join("worker.stderr.log"), &stderr);
    if !exit.success() {
        return Err("The local training worker failed. Review its bounded local job log.".into());
    }
    let response: TrainingRunResponse = serde_json::from_slice(&stdout).map_err(|_| {
        "The local training worker returned invalid completion evidence.".to_string()
    })?;
    if response.protocol != WORKER_PROTOCOL
        || !response.local_only
        || !response.completed
        || response.method != method
        || PathBuf::from(response.artifact_path) != output
    {
        return Err("The local training worker returned mismatched completion evidence.".into());
    }
    let evidence = write_and_verify_training_artifact(&output, method)?;
    Ok(TrainingRunResult {
        artifact_path: output,
        evidence,
    })
}

pub(crate) fn run_foundry_inference(
    app: &tauri::AppHandle,
    request_id: &str,
    job_id: &str,
    base_model_id: &str,
    method: &str,
    job_dir: &Path,
    messages: &[(String, String)],
    max_output_tokens: u32,
) -> Result<FoundryInferenceResult, String> {
    let request_id = safe_job_id(request_id)?;
    let job_id = safe_job_id(job_id)?;
    if !matches!(method, "lora" | "qlora" | "full") {
        return Err("Unsupported Model Foundry inference method.".into());
    }
    if messages.is_empty()
        || messages.len() > 64
        || messages.iter().any(|(role, content)| {
            !matches!(role.as_str(), "system" | "user" | "assistant") || content.trim().is_empty()
        })
        || messages
            .iter()
            .try_fold(0_usize, |total, (_, content)| {
                total.checked_add(content.chars().count())
            })
            .is_none_or(|total| total > 128 * 1024)
    {
        return Err("Model Foundry inference messages are invalid or too large.".into());
    }
    if !(1..=4_096).contains(&max_output_tokens) {
        return Err("Model Foundry output limit must be between 1 and 4,096 tokens.".into());
    }

    let root = training_root(app)?;
    let _storage_guard = MODEL_STORAGE_LOCK
        .lock()
        .map_err(|_| "Training model storage lock is unavailable.".to_string())?;
    let status = inspect_worker(&root);
    let method_available = match method {
        "full" => status.methods.iter().any(|value| value == "full"),
        "lora" | "qlora" => status
            .methods
            .iter()
            .any(|value| matches!(value.as_str(), "lora" | "qlora")),
        _ => false,
    };
    if !status.installed || !status.attested || !method_available {
        return Err(
            "The verified local worker cannot run this trained model on this computer.".into(),
        );
    }
    let python = status
        .python
        .ok_or_else(|| "Python 3 is required for local trained-model inference.".to_string())?;
    let worker = worker_path(&root);
    let model_manifest = catalog_model(base_model_id)?;
    verify_training_model_files(&root, &model_manifest)?;
    let model = training_model_path(&root, base_model_id)?
        .canonicalize()
        .map_err(|_| "The verified trainable base model is not installed.".to_string())?;
    let job_dir = job_dir
        .canonicalize()
        .map_err(|_| "The private Model Foundry job directory is unavailable.".to_string())?;
    let artifact = job_dir
        .join("weight-artifact")
        .canonicalize()
        .map_err(|_| "The verified Model Foundry weight artifact is unavailable.".to_string())?;
    if artifact.parent() != Some(job_dir.as_path()) {
        return Err("Model Foundry weight artifact escaped its private job directory.".into());
    }
    verify_training_artifact(&artifact)?;

    let request_path = job_dir.join(format!("inference-{request_id}.request.json"));
    let response_path = job_dir.join(format!("inference-{request_id}.response.json"));
    let request = InferenceRequest {
        protocol: WORKER_PROTOCOL,
        local_only: true,
        method: method.into(),
        base_model_path: model.to_string_lossy().into_owned(),
        artifact_path: artifact.to_string_lossy().into_owned(),
        response_path: response_path.to_string_lossy().into_owned(),
        messages: messages
            .iter()
            .map(|(role, content)| InferenceMessage {
                role: role.clone(),
                content: content.clone(),
            })
            .collect(),
        max_output_tokens,
    };
    let temporary = request_path.with_extension("json.tmp");
    fs::write(
        &temporary,
        serde_json::to_vec(&request)
            .map_err(|error| format!("Could not encode local inference request: {error}"))?,
    )
    .map_err(|error| format!("Could not persist local inference request: {error}"))?;
    fs::rename(&temporary, &request_path)
        .map_err(|error| format!("Could not activate local inference request: {error}"))?;

    let result: Result<FoundryInferenceResult, String> = (|| {
        let child = Command::new(python)
            .arg(&worker)
            .arg("infer")
            .arg(&request_path)
            .current_dir(&root)
            .env("HF_HUB_OFFLINE", "1")
            .env("TRANSFORMERS_OFFLINE", "1")
            .env("TOKENIZERS_PARALLELISM", "false")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|error| {
                format!("Could not start the verified local inference worker: {error}")
            })?;
        let child = Arc::new(Mutex::new(child));
        {
            let mut active = ACTIVE_INFERENCE
                .lock()
                .map_err(|_| "Model Foundry inference registry is unavailable.".to_string())?;
            if active
                .insert(request_id.to_string(), child.clone())
                .is_some()
            {
                let _ = child.lock().map(|mut process| process.kill());
                return Err("This Model Foundry inference request is already active.".into());
            }
        }
        let _registry_guard = InferenceRegistryGuard(request_id.to_string());
        let started = Instant::now();
        loop {
            if let Some(status) = child
                .lock()
                .map_err(|_| "Model Foundry inference process is unavailable.".to_string())?
                .try_wait()
                .map_err(|error| format!("Could not monitor local model inference: {error}"))?
            {
                if !status.success() {
                    return Err("The verified local model could not complete inference.".into());
                }
                break;
            }
            if started.elapsed() >= INFERENCE_TIMEOUT {
                if let Ok(mut process) = child.lock() {
                    let _ = process.kill();
                    let _ = process.wait();
                }
                return Err("Local trained-model inference exceeded the safe time limit.".into());
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        let metadata = fs::metadata(&response_path)
            .map_err(|_| "Local inference returned no completion evidence.".to_string())?;
        if !metadata.is_file() || metadata.len() > MAX_INFERENCE_RESPONSE_BYTES {
            return Err("Local inference completion evidence is invalid.".into());
        }
        let response: InferenceResponse = serde_json::from_slice(
            &fs::read(&response_path)
                .map_err(|error| format!("Could not read local inference evidence: {error}"))?,
        )
        .map_err(|_| "Local inference completion evidence is malformed.".to_string())?;
        if response.protocol != WORKER_PROTOCOL
            || !response.local_only
            || !response.completed
            || response.method != method
            || response.text.trim().is_empty()
        {
            return Err("Local inference completion evidence did not match the request.".into());
        }
        Ok(FoundryInferenceResult {
            text: response.text,
            input_tokens: response.input_tokens,
            output_tokens: response.output_tokens,
        })
    })();
    let _ = fs::remove_file(&request_path);
    let _ = fs::remove_file(&response_path);
    result.map_err(|error| format!("{error} (Model Foundry job {job_id})"))
}

pub(crate) fn cancel_foundry_inference(request_id: &str) -> Result<bool, String> {
    let request_id = safe_job_id(request_id)?;
    let child = ACTIVE_INFERENCE
        .lock()
        .map_err(|_| "Model Foundry inference registry is unavailable.".to_string())?
        .get(request_id)
        .cloned();
    let Some(child) = child else {
        return Ok(false);
    };
    child
        .lock()
        .map_err(|_| "Model Foundry inference process is unavailable.".to_string())?
        .kill()
        .map_err(|error| format!("Could not stop local trained-model inference: {error}"))?;
    Ok(true)
}

pub(crate) fn cancel_training_worker(job_id: &str) -> Result<bool, String> {
    let job_id = safe_job_id(job_id)?;
    let child = ACTIVE_TRAINING
        .lock()
        .map_err(|_| "Model Foundry training registry is unavailable.".to_string())?
        .get(job_id)
        .cloned();
    let Some(child) = child else {
        return Ok(false);
    };
    child
        .lock()
        .map_err(|_| "Model Foundry training process is unavailable.".to_string())?
        .kill()
        .map_err(|error| format!("Could not stop the local training worker: {error}"))?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture_training_model() -> TrainingCatalogModel {
        TrainingCatalogModel {
            id: "fixture-model".into(),
            label: "Fixture model".into(),
            source_id: "Fixture/Model".into(),
            revision: "1".repeat(40),
            license: "apache-2.0".into(),
            license_url: "https://www.apache.org/licenses/LICENSE-2.0".into(),
            gated: false,
            parameters_b: 0.1,
            download_bytes: 13,
            expected_ram_gb: 1,
            expected_vram_gb: 1,
            context_tokens: 1024,
            precision: "BF16 safetensors".into(),
            speed: "fast".into(),
            quality: "efficient".into(),
            cpu_practical: true,
            files: vec![
                TrainingCatalogFile {
                    path: "config.json".into(),
                    bytes: 6,
                    sha256: source_sha256(b"config"),
                },
                TrainingCatalogFile {
                    path: "model.safetensors".into(),
                    bytes: 7,
                    sha256: source_sha256(b"weights"),
                },
            ],
        }
    }

    #[test]
    fn embedded_worker_is_local_only_and_hash_attestable() {
        assert!(WORKER_SOURCE.contains("LOCAL_ONLY = True"));
        assert!(WORKER_SOURCE.contains("cloud execution is disabled"));
        assert_eq!(expected_source_sha256().len(), 64);
    }

    #[test]
    fn rejects_tampered_worker_source() {
        let root =
            std::env::temp_dir().join(format!("vibespace-foundry-training-{}", nanoid::nanoid!()));
        fs::create_dir_all(&root).unwrap();
        fs::write(worker_path(&root), b"tampered").unwrap();

        let status = inspect_worker(&root);
        assert!(status.installed);
        assert!(!status.attested);
        assert!(status.reason.unwrap().contains("integrity"));

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn accepts_only_local_ready_matching_protocol_probe() {
        let probe = validated_probe(
            br#"{"protocol":1,"localOnly":true,"ready":true,"packages":{"torch":"2"},"methods":["lora","full"],"modalities":["text"],"precisions":["fp32","bf16"],"reason":null}"#
        )
        .expect("matching local probe should validate");
        assert_eq!(probe.methods, vec!["lora", "full"]);
        assert_eq!(probe.modalities, vec!["text"]);
        assert_eq!(probe.precisions, vec!["fp32", "bf16"]);
        assert!(validated_probe(
            br#"{"protocol":2,"localOnly":true,"ready":true,"packages":{},"methods":[],"modalities":[],"precisions":[],"reason":null}"#
        )
        .is_err());
        assert!(validated_probe(
            br#"{"protocol":1,"localOnly":false,"ready":true,"packages":{},"methods":[],"modalities":[],"precisions":[],"reason":null}"#
        )
        .is_err());
    }

    #[test]
    fn worker_probe_advertises_only_closed_supported_capability_values() {
        let root =
            std::env::temp_dir().join(format!("vibespace-foundry-training-{}", nanoid::nanoid!()));
        fs::create_dir_all(&root).unwrap();
        fs::write(worker_path(&root), WORKER_SOURCE.as_bytes()).unwrap();

        let status = inspect_worker(&root);
        assert!(status.installed);
        assert!(status.attested);
        assert!(status
            .methods
            .iter()
            .all(|value| matches!(value.as_str(), "lora" | "qlora" | "full")));
        assert!(status
            .modalities
            .iter()
            .all(|value| matches!(value.as_str(), "text" | "image" | "video" | "audio")));
        assert!(status
            .precisions
            .iter()
            .all(|value| matches!(value.as_str(), "fp32" | "fp16" | "bf16" | "int8" | "int4")));
        if status.methods.is_empty() {
            assert!(status.reason.is_some());
        }

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn worker_validates_a_bounded_local_text_training_request_without_loading_a_model() {
        let Some(python) = locate_python() else {
            return;
        };
        let root =
            std::env::temp_dir().join(format!("vibespace-foundry-validate-{}", nanoid::nanoid!()));
        let model = root.join("model");
        let output = root.join("output");
        fs::create_dir_all(&model).unwrap();
        fs::write(worker_path(&root), WORKER_SOURCE.as_bytes()).unwrap();
        fs::write(model.join("config.json"), br#"{"model_type":"qwen2"}"#).unwrap();
        let dataset = root.join("examples.jsonl");
        fs::write(
            &dataset,
            b"{\"prompt\":\"Say hello\",\"response\":\"Hello.\"}\n",
        )
        .unwrap();
        let request_path = root.join("request.json");
        fs::write(
            &request_path,
            serde_json::to_vec(&serde_json::json!({
                "protocol": WORKER_PROTOCOL,
                "localOnly": true,
                "method": "lora",
                "baseModelPath": model,
                "datasetPath": dataset,
                "outputDir": output,
                "epochs": 1,
                "maxSteps": 2
            }))
            .unwrap(),
        )
        .unwrap();

        let result = Command::new(python)
            .arg(worker_path(&root))
            .arg("validate")
            .arg(&request_path)
            .output()
            .unwrap();
        assert!(
            result.status.success(),
            "{}",
            String::from_utf8_lossy(&result.stderr)
        );
        let value: serde_json::Value = serde_json::from_slice(&result.stdout).unwrap();
        assert_eq!(value["valid"], true);
        assert_eq!(value["examples"], 1);
        assert_eq!(value["method"], "lora");
        assert_eq!(value["localOnly"], true);

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn worker_accepts_only_an_in_output_trainer_checkpoint_for_resume() {
        let Some(python) = locate_python() else {
            return;
        };
        let root =
            std::env::temp_dir().join(format!("vibespace-foundry-resume-{}", nanoid::nanoid!()));
        let model = root.join("model");
        let output = root.join("output");
        let checkpoint = output.join("checkpoint-20");
        fs::create_dir_all(&model).unwrap();
        fs::create_dir_all(&checkpoint).unwrap();
        fs::write(worker_path(&root), WORKER_SOURCE.as_bytes()).unwrap();
        fs::write(model.join("config.json"), br#"{"model_type":"qwen2"}"#).unwrap();
        fs::write(checkpoint.join("trainer_state.json"), b"{}").unwrap();
        let dataset = root.join("examples.jsonl");
        fs::write(&dataset, b"{\"text\":\"A local training example.\"}\n").unwrap();
        let request_path = root.join("request.json");
        let request = serde_json::json!({
            "protocol": WORKER_PROTOCOL,
            "localOnly": true,
            "method": "lora",
            "baseModelPath": model,
            "datasetPath": dataset,
            "outputDir": output,
            "resumeFromCheckpoint": checkpoint,
            "epochs": 1,
            "maxSteps": 20
        });
        fs::write(&request_path, serde_json::to_vec(&request).unwrap()).unwrap();

        let valid = Command::new(&python)
            .arg(worker_path(&root))
            .arg("validate")
            .arg(&request_path)
            .output()
            .unwrap();
        assert!(
            valid.status.success(),
            "{}",
            String::from_utf8_lossy(&valid.stderr)
        );

        let outside = root.join("checkpoint-99");
        fs::create_dir_all(&outside).unwrap();
        fs::write(outside.join("trainer_state.json"), b"{}").unwrap();
        let mut unsafe_request = request;
        unsafe_request["resumeFromCheckpoint"] = outside.to_string_lossy().into_owned().into();
        fs::write(&request_path, serde_json::to_vec(&unsafe_request).unwrap()).unwrap();
        let rejected = Command::new(python)
            .arg(worker_path(&root))
            .arg("validate")
            .arg(&request_path)
            .output()
            .unwrap();
        assert!(!rejected.status.success());

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn selects_latest_complete_direct_checkpoint() {
        let root = std::env::temp_dir().join(format!(
            "vibespace-foundry-checkpoints-{}",
            nanoid::nanoid!()
        ));
        fs::create_dir_all(root.join("checkpoint-2")).unwrap();
        fs::create_dir_all(root.join("checkpoint-10")).unwrap();
        fs::create_dir_all(root.join("checkpoint-20")).unwrap();
        fs::create_dir_all(root.join("nested").join("checkpoint-99")).unwrap();
        fs::write(root.join("checkpoint-2").join("trainer_state.json"), b"{}").unwrap();
        fs::write(root.join("checkpoint-10").join("trainer_state.json"), b"{}").unwrap();
        fs::write(
            root.join("nested")
                .join("checkpoint-99")
                .join("trainer_state.json"),
            b"{}",
        )
        .unwrap();

        assert_eq!(
            latest_training_checkpoint(&root).unwrap(),
            Some(root.join("checkpoint-10"))
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn worker_training_failure_is_structured_and_never_falls_back_to_cloud() {
        let Some(python) = locate_python() else {
            return;
        };
        let root =
            std::env::temp_dir().join(format!("vibespace-foundry-train-{}", nanoid::nanoid!()));
        let model = root.join("model");
        let output = root.join("output");
        fs::create_dir_all(&model).unwrap();
        fs::write(worker_path(&root), WORKER_SOURCE.as_bytes()).unwrap();
        fs::write(model.join("config.json"), br#"{"model_type":"qwen2"}"#).unwrap();
        let dataset = root.join("examples.jsonl");
        fs::write(&dataset, b"{\"text\":\"A local training example.\"}\n").unwrap();
        let request_path = root.join("request.json");
        fs::write(
            &request_path,
            serde_json::to_vec(&serde_json::json!({
                "protocol": WORKER_PROTOCOL,
                "localOnly": true,
                "method": "lora",
                "baseModelPath": model,
                "datasetPath": dataset,
                "outputDir": output,
                "epochs": 1,
                "maxSteps": 1
            }))
            .unwrap(),
        )
        .unwrap();

        let result = Command::new(python)
            .arg(worker_path(&root))
            .arg("train")
            .arg(&request_path)
            .output()
            .unwrap();
        assert!(!result.status.success());
        let value: serde_json::Value = serde_json::from_slice(&result.stderr).unwrap();
        assert_eq!(value["valid"], false);
        assert_eq!(value["localOnly"], true);
        assert!(value["error"]
            .as_str()
            .is_some_and(|error| !error.is_empty()));
        assert!(!output.exists());

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn training_model_directories_are_registry_owned_and_path_safe() {
        let root =
            std::env::temp_dir().join(format!("vibespace-foundry-model-{}", nanoid::nanoid!()));
        assert_eq!(
            training_model_path(&root, "qwen2.5-1.5b-instruct").unwrap(),
            root.join("base-models").join("qwen2.5-1.5b-instruct")
        );
        assert!(training_model_path(&root, "qwen2.5:1.5b-instruct-q4_K_M").is_err());
        assert!(training_model_path(&root, "../outside").is_err());
        assert!(training_model_path(&root, "unknown:model").is_err());
    }

    #[test]
    fn weight_artifact_manifest_detects_post_training_tampering() {
        let root =
            std::env::temp_dir().join(format!("vibespace-foundry-artifact-{}", nanoid::nanoid!()));
        let artifact = root.join("artifact");
        fs::create_dir_all(&artifact).unwrap();
        fs::write(artifact.join("adapter_model.safetensors"), b"adapter-bytes").unwrap();
        fs::write(
            artifact.join("adapter_config.json"),
            br#"{"base_model_name_or_path":"local"}"#,
        )
        .unwrap();

        let evidence = write_and_verify_training_artifact(&artifact, "lora").unwrap();
        assert_eq!(evidence.file_count, 2);
        assert!(evidence.storage_bytes > 0);
        assert_eq!(evidence.sha256.len(), 64);

        fs::write(artifact.join("adapter_model.safetensors"), b"tampered").unwrap();
        assert!(verify_training_artifact(&artifact).is_err());

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn worker_logs_are_bounded_and_missing_job_cancellation_is_safe() {
        let input = vec![b'x'; MAX_WORKER_LOG_BYTES + 1024];
        assert_eq!(
            drain_bounded(std::io::Cursor::new(input), MAX_WORKER_LOG_BYTES).len(),
            MAX_WORKER_LOG_BYTES
        );
        assert!(!cancel_training_worker("job_missing").unwrap());
    }

    #[test]
    fn training_catalog_is_pinned_public_and_hash_complete() {
        let catalog = training_catalog().unwrap();
        assert_eq!(catalog.len(), 5);
        for model in catalog {
            assert_eq!(model.license, "apache-2.0");
            assert!(!model.gated);
            assert_eq!(model.revision.len(), 40);
            assert!(model
                .revision
                .chars()
                .all(|character| character.is_ascii_hexdigit()));
            assert!(model.source_id.contains('/'));
            assert!(model.download_bytes > 0);
            assert!(model
                .files
                .iter()
                .any(|file| file.path == "model.safetensors"));
            assert!(model.files.iter().any(|file| file.path == "config.json"));
            assert_eq!(
                model.download_bytes,
                model.files.iter().map(|file| file.bytes).sum::<u64>()
            );
            assert!(model.files.iter().all(|file| {
                file.bytes > 0
                    && file.sha256.len() == 64
                    && file
                        .sha256
                        .chars()
                        .all(|character| character.is_ascii_hexdigit())
                    && !file.path.contains("..")
                    && !file.path.contains(['/', '\\'])
            }));
        }
    }

    #[test]
    fn training_download_urls_are_revision_pinned_and_host_locked() {
        let model = training_catalog().unwrap().remove(0);
        let file = model
            .files
            .iter()
            .find(|file| file.path == "config.json")
            .unwrap();
        assert_eq!(
            training_model_download_url(&model, file).unwrap().as_str(),
            format!(
                "https://huggingface.co/{}/resolve/{}/config.json",
                model.source_id, model.revision
            )
        );
    }

    #[test]
    fn training_download_redirects_cannot_leave_the_trusted_host() {
        let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            let mut request = [0_u8; 1024];
            let _ = socket.read(&mut request);
            socket
                .write_all(
                    b"HTTP/1.1 302 Found\r\nLocation: https://example.com/model.safetensors\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                )
                .unwrap();
        });
        let client = reqwest::blocking::Client::builder()
            .redirect(training_model_redirect_policy())
            .build()
            .unwrap();
        let error = client
            .get(format!("http://{address}/model.safetensors"))
            .send()
            .unwrap_err();
        server.join().unwrap();
        assert!(error.is_redirect());
    }

    #[test]
    fn installed_training_model_verification_detects_tampering() {
        let root =
            std::env::temp_dir().join(format!("vibespace-foundry-install-{}", nanoid::nanoid!()));
        let model_root = root.join("base-models").join("fixture-model");
        fs::create_dir_all(&model_root).unwrap();
        fs::write(model_root.join("config.json"), b"config").unwrap();
        fs::write(model_root.join("model.safetensors"), b"weights").unwrap();
        let model = fixture_training_model();

        assert_eq!(verify_training_model_files(&root, &model).unwrap(), 13);
        fs::write(model_root.join("model.safetensors"), b"tampered").unwrap();
        assert!(verify_training_model_files(&root, &model).is_err());

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn verified_training_model_marker_makes_catalog_status_ready() {
        let root =
            std::env::temp_dir().join(format!("vibespace-foundry-marker-{}", nanoid::nanoid!()));
        let model_root = root.join("base-models").join("fixture-model");
        fs::create_dir_all(&model_root).unwrap();
        fs::write(model_root.join("config.json"), b"config").unwrap();
        fs::write(model_root.join("model.safetensors"), b"weights").unwrap();
        let model = fixture_training_model();

        assert_eq!(
            training_model_status(&root, model.clone()).status,
            "repair-required"
        );
        write_training_model_marker(&model_root, &model).unwrap();
        let status = training_model_status(&root, model);
        assert!(status.installed);
        assert!(status.verified);
        assert_eq!(status.installed_bytes, 13);
        assert_eq!(status.status, "ready");

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn training_model_removal_is_bounded_and_idempotent() {
        let root =
            std::env::temp_dir().join(format!("vibespace-foundry-remove-{}", nanoid::nanoid!()));
        let model = fixture_training_model();
        let model_root = root.join("base-models").join(&model.id);
        fs::create_dir_all(&model_root).unwrap();
        fs::write(model_root.join("config.json"), b"config").unwrap();
        fs::write(model_root.join("model.safetensors"), b"weights").unwrap();
        write_training_model_marker(&model_root, &model).unwrap();
        let unrelated = root.join("base-models").join("keep-me");
        fs::create_dir_all(&unrelated).unwrap();
        fs::write(unrelated.join("sentinel.txt"), b"safe").unwrap();

        remove_training_model_directory(&root, &model).unwrap();
        assert!(!model_root.exists());
        assert_eq!(fs::read(unrelated.join("sentinel.txt")).unwrap(), b"safe");
        remove_training_model_directory(&root, &model).unwrap();

        let _ = fs::remove_dir_all(root);
    }
}
