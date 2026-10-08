use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::io::{BufReader, Cursor, Read};
use std::path::{Component, Path, PathBuf};
use std::process::Command;
use std::sync::{Mutex, OnceLock};
use tauri::{Emitter, Manager};
use tauri_plugin_notification::NotificationExt;

#[path = "model_foundry_resources.rs"]
mod resources;
use resources::{weight_training_requirements, WeightTrainingRequirements};

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

const MAX_DOCUMENT_SOURCE_BYTES: u64 = 64 * 1024 * 1024;
const MAX_MEDIA_SOURCE_BYTES: u64 = 2 * 1024 * 1024 * 1024;
const FOUNDRY_STORAGE_DIRECTORY: &str = "VibeSpace-Model-Foundry";
const FOUNDRY_STORAGE_CONFIG: &str = "model-foundry-storage.json";
const FOUNDRY_STORAGE_MIGRATION_MARKER: &str = ".vibespace-storage-migration-v1";
const MAX_STORAGE_CONFIG_BYTES: u64 = 4 * 1024;
const MAX_STORAGE_MIGRATION_FILES: usize = 100_000;
const ALLOWED_MODELS: &[&str] = &[
    "qwen2.5:1.5b-instruct-q4_K_M",
    "qwen2.5:7b-instruct-q4_K_M",
    "llama3.1:8b-instruct-q4_K_M",
];
static ACTIVE_JOBS: OnceLock<Mutex<BTreeSet<String>>> = OnceLock::new();

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum FoundryMethod {
    Knowledge,
    Weight,
}

fn parsed_method(value: &str) -> Result<FoundryMethod, String> {
    match value {
        "knowledge" => Ok(FoundryMethod::Knowledge),
        "lora" | "qlora" | "full" => Ok(FoundryMethod::Weight),
        _ => Err("Unsupported Model Foundry build method.".into()),
    }
}

fn allowed_model_for_method(base_model_id: &str, method: FoundryMethod) -> bool {
    match method {
        FoundryMethod::Knowledge => ALLOWED_MODELS.contains(&base_model_id),
        FoundryMethod::Weight => {
            crate::model_foundry_training::training_model_id_allowed(base_model_id)
        }
    }
}

fn active_jobs() -> &'static Mutex<BTreeSet<String>> {
    ACTIVE_JOBS.get_or_init(|| Mutex::new(BTreeSet::new()))
}

struct ActiveJobGuard(String);

impl Drop for ActiveJobGuard {
    fn drop(&mut self) {
        if let Ok(mut jobs) = active_jobs().lock() {
            jobs.remove(&self.0);
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StartRequest {
    #[serde(default)]
    schema_version: Option<u8>,
    #[serde(default)]
    project_id: Option<String>,
    name: String,
    description: String,
    purpose: String,
    instructions: Option<String>,
    base_model_id: String,
    method: String,
    source_paths: Vec<String>,
    local_only: bool,
    #[serde(default)]
    version: Option<u32>,
    #[serde(default)]
    epochs: Option<u8>,
    #[serde(default)]
    max_steps: Option<u32>,
    #[serde(default)]
    dataset_jsonl: Option<String>,
    #[serde(default)]
    validation_dataset_jsonl: Option<String>,
    #[serde(default)]
    dataset_version_id: Option<String>,
    #[serde(default)]
    dataset_manifest_hash: Option<String>,
    #[serde(default)]
    dataset_fingerprint: Option<String>,
    #[serde(default, deserialize_with = "deserialize_present_payload_digest", skip_serializing_if = "Option::is_none")]
    dataset_payload_sha256: Option<String>,
    #[serde(default, deserialize_with = "deserialize_present_payload_digest", skip_serializing_if = "Option::is_none")]
    validation_payload_sha256: Option<String>,
    #[serde(default)]
    training_config: Option<crate::model_foundry_training::TrainingConfiguration>,
    #[serde(default)]
    target_modules: Option<Vec<String>>,
    #[serde(default)]
    training_examples: Vec<SupervisedMediaExample>,
}

// Omitted optional digests select the legacy contract; explicit null is invalid
// and must not silently downgrade a caller that supplied a new digest field.
fn deserialize_present_payload_digest<'de, D>(deserializer: D) -> Result<Option<String>, D::Error>
where D: serde::Deserializer<'de> {
    String::deserialize(deserializer).map(Some)
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct SupervisedMediaExample {
    path: String,
    media_type: String,
    prompt: String,
    response: String,
    #[serde(default = "default_planned_frames")]
    planned_frames: u8,
}

fn default_planned_frames() -> u8 {
    8
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FoundryJob {
    id: String,
    #[serde(default)]
    project_id: Option<String>,
    name: String,
    base_model_id: String,
    method: String,
    status: String,
    progress: u8,
    artifact_path: Option<String>,
    #[serde(default)]
    artifact_verified: bool,
    #[serde(default)]
    artifact_sha256: Option<String>,
    #[serde(default)]
    storage_bytes: u64,
    #[serde(default)]
    source_count: usize,
    #[serde(default = "default_version")]
    version: u32,
    #[serde(default)]
    resume_available: bool,
    error: Option<String>,
    created_at: String,
    updated_at: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct KnowledgeArtifact {
    schema_version: u8,
    version: u32,
    model_name: String,
    description: String,
    purpose: String,
    default_behavior: Option<String>,
    base_model_id: String,
    processing: String,
    source_count: usize,
    #[serde(default)]
    sources: Vec<SourceManifestEntry>,
    chunks: Vec<KnowledgeChunk>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct SourceManifestEntry {
    source_name: String,
    format: String,
    source_bytes: u64,
    source_sha256: String,
    prepared_sha256: String,
    chunk_count: usize,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct KnowledgeChunk {
    id: String,
    source_name: String,
    #[serde(default)]
    source_anchor: Option<String>,
    text: String,
    sha256: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FoundryRetrieval {
    artifact_id: String,
    model_name: String,
    version: u32,
    base_model_id: String,
    default_behavior: Option<String>,
    context: String,
    source_names: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FoundryChatPreparation {
    kind: String,
    artifact_id: String,
    model_name: String,
    version: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    method: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    base_model_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    default_behavior: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    context: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    source_names: Option<Vec<String>>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FoundryChatMessage {
    role: String,
    content: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FoundryChatResponse {
    artifact_id: String,
    artifact_sha256: String,
    model_name: String,
    version: u32,
    method: String,
    text: String,
    input_tokens: u64,
    output_tokens: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FoundryHardwareProfile {
    cpu: String,
    gpu: Option<String>,
    ram_gb: f64,
    vram_gb: f64,
    free_storage_gb: f64,
    os: String,
    accelerators: Vec<String>,
    storage_root: String,
    recommended_storage_root: Option<String>,
}

fn validate_weight_hardware(
    method: &str,
    compute_device: &str,
    hardware: &FoundryHardwareProfile,
    requirements: WeightTrainingRequirements,
) -> Result<(), String> {
    const MEMORY_REPORTING_TOLERANCE_GB: f64 = 0.01;
    let vram_fits = hardware.vram_gb + MEMORY_REPORTING_TOLERANCE_GB >= requirements.vram_gb;
    let ram_fits = hardware.ram_gb + MEMORY_REPORTING_TOLERANCE_GB >= requirements.ram_gb;
    if hardware.free_storage_gb < requirements.storage_gb {
        return Err(format!(
            "{method} training requires about {} GB free managed storage; {:.1} GB is available at {}.",
            requirements.storage_gb, hardware.free_storage_gb, hardware.storage_root
        ));
    }
    match compute_device {
        "gpu" if !vram_fits => {
            return Err(format!(
                "{method} GPU-only training requires about {} GB verified CUDA VRAM; {:.1} GB is available.",
                requirements.vram_gb, hardware.vram_gb
            ));
        }
        "cpu" if !ram_fits => {
            return Err(format!(
                "{method} CPU-only training requires about {} GB system RAM; {:.1} GB is available.",
                requirements.ram_gb, hardware.ram_gb
            ));
        }
        "gpu" | "cpu" => {}
        _ => return Err("Training compute device must be explicitly GPU or CPU.".into()),
    }
    Ok(())
}

fn parse_nvidia_smi_csv(value: &str) -> Option<(String, f64)> {
    value.lines().find_map(|line| {
        let (name, memory_mib) = line.rsplit_once(',')?;
        let name = name.trim();
        let memory_mib = memory_mib.trim().parse::<f64>().ok()?;
        (!name.is_empty() && memory_mib.is_finite() && memory_mib > 0.0)
            .then(|| (name.to_string(), memory_mib / 1_024.0))
    })
}

#[cfg(target_os = "windows")]
fn detect_nvidia_accelerator() -> Option<(String, f64)> {
    let output = Command::new("nvidia-smi")
        .args([
            "--query-gpu=name,memory.total",
            "--format=csv,noheader,nounits",
        ])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .ok()?;
    output
        .status
        .success()
        .then(|| String::from_utf8(output.stdout).ok())
        .flatten()
        .and_then(|value| parse_nvidia_smi_csv(&value))
}

fn now() -> String {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .to_string()
}

fn default_version() -> u32 {
    1
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FoundryStorageConfiguration {
    schema_version: u8,
    root: String,
}

fn default_foundry_root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|path| path.join("model-foundry"))
        .map_err(|error| format!("Model Foundry app-data directory unavailable: {error}"))
}

fn selected_foundry_storage_root(data_dir: &Path, configured_root: Option<PathBuf>) -> PathBuf {
    configured_root.unwrap_or_else(|| data_dir.join("model-foundry"))
}

fn nearest_existing_storage_probe_path(path: &Path) -> PathBuf {
    let mut candidate = path.to_path_buf();
    while !candidate.exists() {
        let Some(parent) = candidate.parent() else {
            break;
        };
        if parent == candidate {
            break;
        }
        candidate = parent.to_path_buf();
    }
    candidate
}

fn storage_config_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|path| path.join(FOUNDRY_STORAGE_CONFIG))
        .map_err(|error| format!("Model Foundry app-data directory unavailable: {error}"))
}

fn normalize_requested_storage_root(requested: &Path) -> Result<PathBuf, String> {
    if !requested.is_absolute()
        || requested
            .components()
            .any(|component| matches!(component, Component::ParentDir | Component::CurDir))
    {
        return Err("Choose an absolute local drive or folder for Model Foundry storage.".into());
    }
    #[cfg(target_os = "windows")]
    {
        use std::path::Prefix;
        let is_drive = matches!(
            requested.components().next(),
            Some(Component::Prefix(prefix)) if matches!(prefix.kind(), Prefix::Disk(_))
        );
        if !is_drive {
            return Err("Model Foundry storage must use a local drive such as C: or D:.".into());
        }
    }
    Ok(
        if requested
            .file_name()
            .is_some_and(|name| name == FOUNDRY_STORAGE_DIRECTORY)
        {
            requested.to_path_buf()
        } else {
            requested.join(FOUNDRY_STORAGE_DIRECTORY)
        },
    )
}

fn storage_paths_equal(left: &Path, right: &Path) -> bool {
    #[cfg(target_os = "windows")]
    {
        let left = left.to_string_lossy();
        let right = right.to_string_lossy();
        return left
            .trim_end_matches(&['\\', '/'][..])
            .eq_ignore_ascii_case(right.trim_end_matches(&['\\', '/'][..]));
    }
    #[cfg(not(target_os = "windows"))]
    {
        left == right
    }
}

fn reject_linked_path(path: &Path) -> Result<(), String> {
    for ancestor in path.ancestors() {
        if !ancestor.exists() {
            continue;
        }
        let metadata = fs::symlink_metadata(ancestor)
            .map_err(|error| format!("Could not inspect the selected storage path: {error}"))?;
        if metadata.file_type().is_symlink() {
            return Err("Model Foundry storage cannot use a symbolic link.".into());
        }
        #[cfg(target_os = "windows")]
        {
            use std::os::windows::fs::MetadataExt;
            const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
            if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
                return Err("Model Foundry storage cannot use a junction or reparse point.".into());
            }
        }
    }
    Ok(())
}

fn sha256_file(path: &Path) -> Result<(u64, String), String> {
    let file = fs::File::open(path)
        .map_err(|error| format!("Could not verify migrated Model Foundry data: {error}"))?;
    let mut reader = BufReader::new(file);
    let mut digest = Sha256::new();
    let mut bytes = 0_u64;
    let mut buffer = [0_u8; 1024 * 1024];
    loop {
        let count = reader
            .read(&mut buffer)
            .map_err(|error| format!("Could not verify migrated Model Foundry data: {error}"))?;
        if count == 0 {
            break;
        }
        bytes = bytes.saturating_add(count as u64);
        digest.update(&buffer[..count]);
    }
    Ok((bytes, format!("{:x}", digest.finalize())))
}

fn collect_storage_files(
    root: &Path,
    prefix: &Path,
    output: &mut BTreeMap<PathBuf, (u64, String)>,
) -> Result<(), String> {
    if !root.exists() {
        return Ok(());
    }
    reject_linked_path(root)?;
    let mut pending = vec![(root.to_path_buf(), prefix.to_path_buf())];
    while let Some((directory, relative)) = pending.pop() {
        for entry in fs::read_dir(&directory)
            .map_err(|error| format!("Could not inspect existing Model Foundry data: {error}"))?
        {
            let entry = entry.map_err(|error| {
                format!("Could not inspect existing Model Foundry data: {error}")
            })?;
            let metadata = entry.metadata().map_err(|error| {
                format!("Could not inspect existing Model Foundry data: {error}")
            })?;
            if entry
                .file_type()
                .map(|kind| kind.is_symlink())
                .unwrap_or(true)
            {
                return Err("Existing Model Foundry storage contains an unsafe link.".into());
            }
            #[cfg(target_os = "windows")]
            {
                use std::os::windows::fs::MetadataExt;
                if metadata.file_attributes() & 0x400 != 0 {
                    return Err("Existing Model Foundry storage contains a reparse point.".into());
                }
            }
            let child_relative = relative.join(entry.file_name());
            if metadata.is_dir() {
                pending.push((entry.path(), child_relative));
            } else if metadata.is_file() {
                if output.len() >= MAX_STORAGE_MIGRATION_FILES {
                    return Err(
                        "Model Foundry storage contains too many files to migrate safely.".into(),
                    );
                }
                output.insert(child_relative, sha256_file(&entry.path())?);
            } else {
                return Err("Existing Model Foundry storage contains an unsupported entry.".into());
            }
        }
    }
    Ok(())
}

fn copy_storage_files(source: &Path, prefix: &Path, target: &Path) -> Result<(), String> {
    let mut files = BTreeMap::new();
    collect_storage_files(source, prefix, &mut files)?;
    let managed_runtime = target.join("training-runtime");
    let preserve_managed_runtime = match fs::symlink_metadata(&managed_runtime) {
        Ok(metadata) => {
            reject_linked_path(&managed_runtime)?;
            if !metadata.is_dir() {
                return Err(
                    "Model Foundry storage target conflicts with its training runtime.".into(),
                );
            }
            true
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
        Err(error) => {
            return Err(format!(
                "Could not inspect selected Model Foundry storage: {error}"
            ));
        }
    };
    let mut missing_files = Vec::new();
    for (relative, expected) in files {
        if preserve_managed_runtime && relative.starts_with(Path::new("training-runtime")) {
            // Python environments are an atomic managed unit. Never merge files from a
            // different environment into an existing target runtime.
            continue;
        }
        let from = source.join(relative.strip_prefix(prefix).unwrap_or(&relative));
        let destination = target.join(&relative);
        reject_linked_path(&destination)?;
        match fs::symlink_metadata(&destination) {
            Ok(metadata) => {
                if metadata.file_type().is_symlink() {
                    return Err("Model Foundry storage target contains an unsafe link.".into());
                }
                #[cfg(target_os = "windows")]
                {
                    use std::os::windows::fs::MetadataExt;
                    if metadata.file_attributes() & 0x400 != 0 {
                        return Err("Model Foundry storage target contains a reparse point.".into());
                    }
                }
                if !metadata.is_file() {
                    return Err(
                        "Model Foundry storage target conflicts with migrated file data.".into(),
                    );
                }
                if sha256_file(&destination)? != expected {
                    return Err(
                        "Existing Model Foundry storage conflicts with migrated file data.".into(),
                    );
                }
                continue;
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                return Err(format!(
                    "Could not inspect selected Model Foundry storage: {error}"
                ));
            }
        }
        missing_files.push((from, destination, expected));
    }
    for (from, destination, expected) in missing_files {
        if let Some(parent) = destination.parent() {
            fs::create_dir_all(parent).map_err(|error| {
                format!("Could not prepare selected Model Foundry storage: {error}")
            })?;
        }
        fs::copy(&from, &destination)
            .map_err(|error| format!("Could not copy Model Foundry data: {error}"))?;
        if sha256_file(&destination)? != expected {
            return Err("Copied Model Foundry data failed integrity verification.".into());
        }
    }
    Ok(())
}

pub(crate) fn configured_foundry_root(app: &tauri::AppHandle) -> Result<Option<PathBuf>, String> {
    let config_path = storage_config_path(app)?;
    if !config_path.exists() {
        return Ok(None);
    }
    let metadata = fs::symlink_metadata(&config_path)
        .map_err(|error| format!("Could not inspect Model Foundry storage settings: {error}"))?;
    if metadata.file_type().is_symlink()
        || !metadata.is_file()
        || metadata.len() > MAX_STORAGE_CONFIG_BYTES
    {
        return Err("Model Foundry storage settings are unsafe or corrupt.".into());
    }
    let config: FoundryStorageConfiguration = serde_json::from_slice(
        &fs::read(&config_path)
            .map_err(|error| format!("Could not read Model Foundry storage settings: {error}"))?,
    )
    .map_err(|_| "Model Foundry storage settings are corrupt.".to_string())?;
    if config.schema_version != 1 {
        return Err("Model Foundry storage settings use an unsupported version.".into());
    }
    let root = PathBuf::from(config.root);
    reject_linked_path(&root)?;
    if !root.is_dir() {
        return Err("The selected Model Foundry storage drive is unavailable.".into());
    }
    Ok(Some(root))
}

pub(crate) fn configure_foundry_storage(
    app: &tauri::AppHandle,
    requested: &str,
) -> Result<PathBuf, String> {
    if active_jobs()
        .lock()
        .map_err(|_| "Model Foundry job registry is unavailable.".to_string())?
        .is_empty()
        && !crate::model_foundry_training::foundry_storage_busy()?
    {
        // Safe to continue below.
    } else {
        return Err("Stop active Model Foundry jobs and downloads before changing storage.".into());
    }
    let target = normalize_requested_storage_root(Path::new(requested.trim()))?;
    if configured_foundry_root(app)?
        .as_deref()
        .is_some_and(|configured| storage_paths_equal(configured, &target))
    {
        return Ok(target);
    }
    let current_root = configured_foundry_root(app)?.unwrap_or(default_foundry_root(app)?);
    if target.starts_with(&current_root) || current_root.starts_with(&target) {
        return Err("Choose a storage folder outside the current Model Foundry directory.".into());
    }
    let parent = target
        .parent()
        .ok_or_else(|| "The selected storage folder has no safe parent.".to_string())?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("Could not prepare the selected storage folder: {error}"))?;
    reject_linked_path(parent)?;
    if target.exists() {
        reject_linked_path(&target)?;
        if !target.is_dir() {
            return Err("The selected Model Foundry storage path is not a folder.".into());
        }
        let marker = target.join(FOUNDRY_STORAGE_MIGRATION_MARKER);
        let has_content = fs::read_dir(&target)
            .map_err(|error| format!("Could not inspect selected storage: {error}"))?
            .next()
            .is_some();
        if has_content && !marker.is_file() {
            return Err(
                "The selected Model Foundry folder is not empty. Choose a new or empty folder."
                    .into(),
            );
        }
    } else {
        fs::create_dir(&target)
            .map_err(|error| format!("Could not create selected Model Foundry storage: {error}"))?;
    }
    let marker = target.join(FOUNDRY_STORAGE_MIGRATION_MARKER);
    fs::write(&marker, b"VibeSpace Model Foundry storage migration v1")
        .map_err(|error| format!("Could not prepare safe Model Foundry migration: {error}"))?;
    let mut existing_files = BTreeMap::new();
    collect_storage_files(&current_root, Path::new(""), &mut existing_files)?;
    let required_bytes = existing_files
        .values()
        .try_fold(0_u64, |total, (bytes, _)| total.checked_add(*bytes))
        .ok_or_else(|| "Model Foundry storage size overflowed.".to_string())?;
    let available_bytes = fs4::available_space(&target)
        .map_err(|error| format!("Could not measure selected Model Foundry storage: {error}"))?;
    if available_bytes < required_bytes.saturating_add(512 * 1024 * 1024) {
        return Err(
            "The selected drive does not have enough free space for a verified copy.".into(),
        );
    }
    if !storage_paths_equal(&current_root, &target) && current_root.exists() {
        copy_storage_files(&current_root, Path::new(""), &target)?;
    }
    let config_path = storage_config_path(app)?;
    if let Some(parent) = config_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("Could not prepare Model Foundry settings: {error}"))?;
    }
    let config = FoundryStorageConfiguration {
        schema_version: 1,
        root: target.to_string_lossy().into_owned(),
    };
    write_atomic(
        &config_path,
        &serde_json::to_vec_pretty(&config)
            .map_err(|error| format!("Could not encode Model Foundry storage settings: {error}"))?,
    )?;
    fs::remove_file(&marker)
        .map_err(|error| format!("Could not finish Model Foundry storage migration: {error}"))?;
    Ok(target)
}

fn foundry_root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    configured_foundry_root(app)?.map_or_else(|| default_foundry_root(app), Ok)
}

fn write_job(path: &Path, job: &FoundryJob) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(job)
        .map_err(|error| format!("Could not encode training job: {error}"))?;
    let temporary = path.with_extension("json.tmp");
    fs::write(&temporary, bytes)
        .map_err(|error| format!("Could not persist training job: {error}"))?;
    fs::rename(&temporary, path).map_err(|error| format!("Could not commit training job: {error}"))
}

fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let temporary = path.with_extension("json.tmp");
    fs::write(&temporary, bytes)
        .map_err(|error| format!("Could not write temporary artifact: {error}"))?;
    fs::rename(&temporary, path).map_err(|error| format!("Could not commit artifact: {error}"))
}

fn validate_artifact(path: &Path) -> Result<KnowledgeArtifact, String> {
    let bytes = fs::read(path).map_err(|error| format!("Could not read artifact: {error}"))?;
    validate_artifact_bytes(&bytes)
}

fn validate_artifact_bytes(bytes: &[u8]) -> Result<KnowledgeArtifact, String> {
    let artifact: KnowledgeArtifact = serde_json::from_slice(bytes)
        .map_err(|error| format!("Artifact is not valid JSON: {error}"))?;
    if artifact.schema_version != 1
        || artifact.processing != "local-rag-knowledge"
        || artifact.version == 0
        || artifact.model_name.trim().is_empty()
        || artifact.chunks.is_empty()
        || !ALLOWED_MODELS.contains(&artifact.base_model_id.as_str())
    {
        return Err("Artifact metadata is incomplete or unsupported.".into());
    }
    if !artifact.sources.is_empty()
        && (artifact.sources.len() != artifact.source_count
            || artifact.sources.iter().any(|source| {
                source.source_name.trim().is_empty()
                    || source.format.trim().is_empty()
                    || source.source_bytes == 0
                    || source.chunk_count == 0
                    || !is_sha256(&source.source_sha256)
                    || !is_sha256(&source.prepared_sha256)
            }))
    {
        return Err("Artifact source provenance is incomplete or unsupported.".into());
    }
    for chunk in &artifact.chunks {
        let digest = format!("{:x}", Sha256::digest(chunk.text.as_bytes()));
        if chunk.id.trim().is_empty()
            || chunk.source_name.trim().is_empty()
            || chunk
                .source_anchor
                .as_deref()
                .is_some_and(|anchor| anchor.trim().is_empty())
            || chunk.text.trim().is_empty()
            || chunk.sha256 != digest
        {
            return Err(format!(
                "Artifact chunk {} failed integrity validation.",
                chunk.id
            ));
        }
    }
    Ok(artifact)
}

fn is_sha256(value: &str) -> bool {
    value.len() == 64 && value.chars().all(|character| character.is_ascii_hexdigit())
}

fn query_terms(value: &str) -> BTreeSet<String> {
    value
        .split(|character: char| !character.is_alphanumeric())
        .map(str::to_lowercase)
        .filter(|term| term.chars().count() > 2)
        .collect()
}

fn rank_chunks(chunks: &[KnowledgeChunk], query: &str, limit: usize) -> Vec<KnowledgeChunk> {
    let wanted = query_terms(query);
    let mut scored = chunks
        .iter()
        .map(|chunk| {
            let available = query_terms(&chunk.text);
            let score = wanted.intersection(&available).count();
            (score, chunk)
        })
        .filter(|(score, _)| *score > 0)
        .collect::<Vec<_>>();
    scored.sort_by(|(left_score, left), (right_score, right)| {
        right_score
            .cmp(left_score)
            .then_with(|| left.id.cmp(&right.id))
    });
    scored
        .into_iter()
        .take(limit.clamp(1, 8))
        .map(|(_, chunk)| chunk.clone())
        .collect()
}

fn validated_job_id(value: &str) -> Result<&str, String> {
    if value.len() < 5
        || value.len() > 80
        || !value.chars().all(|character| {
            character.is_ascii_alphanumeric() || character == '_' || character == '-'
        })
    {
        return Err("Invalid Model Foundry artifact identifier.".into());
    }
    Ok(value)
}

#[cfg(target_os = "windows")]
fn detect_hardware(app: &tauri::AppHandle) -> Result<FoundryHardwareProfile, String> {
    use windows::core::HSTRING;
    use windows::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;
    use windows::Win32::System::SystemInformation::{GlobalMemoryStatusEx, MEMORYSTATUSEX};

    let mut memory = MEMORYSTATUSEX {
        dwLength: std::mem::size_of::<MEMORYSTATUSEX>() as u32,
        ..Default::default()
    };
    unsafe { GlobalMemoryStatusEx(&mut memory) }
        .map_err(|error| format!("Could not inspect system memory: {error}"))?;

    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Could not resolve app-data storage: {error}"))?;
    let storage_root = selected_foundry_storage_root(&data_dir, configured_foundry_root(app)?);
    let probe_directory = nearest_existing_storage_probe_path(&storage_root);
    let directory = HSTRING::from(probe_directory.to_string_lossy().as_ref());
    let mut free_bytes = 0_u64;
    unsafe { GetDiskFreeSpaceExW(&directory, Some(&mut free_bytes), None, None) }
        .map_err(|error| format!("Could not inspect free storage: {error}"))?;
    let mut recommended_storage_root = None;
    let mut secondary_free_bytes = 0_u64;
    let secondary = HSTRING::from("D:\\");
    if unsafe { GetDiskFreeSpaceExW(&secondary, Some(&mut secondary_free_bytes), None, None) }
        .is_ok()
        && secondary_free_bytes > free_bytes.saturating_add(20 * 1024 * 1024 * 1024)
    {
        recommended_storage_root = Some("D:\\VibeSpace-Model-Foundry".into());
    }

    let threads = std::thread::available_parallelism()
        .map(|value| value.get())
        .unwrap_or(1);
    let accelerator = detect_nvidia_accelerator();
    Ok(FoundryHardwareProfile {
        cpu: format!("{threads} logical CPU threads"),
        gpu: accelerator.as_ref().map(|(name, _)| name.clone()),
        ram_gb: memory.ullTotalPhys as f64 / 1024_f64.powi(3),
        vram_gb: accelerator.as_ref().map(|(_, vram)| *vram).unwrap_or(0.0),
        free_storage_gb: free_bytes as f64 / 1024_f64.powi(3),
        os: "Windows".into(),
        accelerators: accelerator
            .map(|_| vec!["NVIDIA CUDA (runtime verification required)".into()])
            .unwrap_or_default(),
        storage_root: storage_root.to_string_lossy().into_owned(),
        recommended_storage_root,
    })
}

#[cfg(not(target_os = "windows"))]
fn detect_hardware(_app: &tauri::AppHandle) -> Result<FoundryHardwareProfile, String> {
    let threads = std::thread::available_parallelism()
        .map(|value| value.get())
        .unwrap_or(1);
    Ok(FoundryHardwareProfile {
        cpu: format!("{threads} logical CPU threads"),
        gpu: None,
        ram_gb: 0.0,
        vram_gb: 0.0,
        free_storage_gb: 0.0,
        os: std::env::consts::OS.into(),
        accelerators: Vec::new(),
        storage_root: "application-data/model-foundry".into(),
        recommended_storage_root: None,
    })
}

const MAX_INLINE_DATASET_BYTES: usize = 5 * 1024 * 1024;
const MAX_INLINE_DATASET_EXAMPLES: usize = 20_000;
const MAX_INLINE_RECORD_BYTES: usize = 64 * 1024;

/// Validate a bounded inline Dataset Studio export and canonicalize every
/// record to the training worker's `{"prompt","response"}` JSONL shape.
/// Fail-closed: malformed, oversized, or unfingerprinted exports are rejected
/// before anything is written to the private job directory.
fn canonicalize_inline_dataset(
    dataset: &str,
    expected_fingerprint: Option<&str>,
) -> Result<String, String> {
    if dataset.len() > MAX_INLINE_DATASET_BYTES {
        return Err("Inline dataset exceeds the 5 MB bounded export limit.".into());
    }
    if let Some(expected) = expected_fingerprint
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        let actual = format!("{:x}", Sha256::digest(dataset.as_bytes()));
        if !actual.eq_ignore_ascii_case(expected) {
            return Err("Inline dataset fingerprint does not match the reviewed manifest.".into());
        }
    }
    let mut count = 0usize;
    let mut canonical = Vec::new();
    for line in dataset.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        if trimmed.len() > MAX_INLINE_RECORD_BYTES {
            return Err("Inline dataset record exceeds the 64 KiB per-record bound.".into());
        }
        count += 1;
        if count > MAX_INLINE_DATASET_EXAMPLES {
            return Err("Inline dataset exceeds the 20000 example bound.".into());
        }
        let value: serde_json::Value = serde_json::from_str(trimmed)
            .map_err(|_| "Inline dataset rows must be valid JSON objects.".to_string())?;
        let object = value
            .as_object()
            .ok_or_else(|| "Inline dataset rows must be JSON objects.".to_string())?;
        let prompt = object
            .get("prompt")
            .and_then(|entry| entry.as_str())
            .map(str::trim)
            .filter(|entry| !entry.is_empty())
            .ok_or_else(|| {
                "Inline dataset examples require a non-empty prompt field.".to_string()
            })?;
        let response = object
            .get("response")
            .or_else(|| object.get("completion"))
            .and_then(|entry| entry.as_str())
            .map(str::trim)
            .filter(|entry| !entry.is_empty())
            .ok_or_else(|| {
                "Inline dataset examples require a non-empty response or completion field."
                    .to_string()
            })?;
        let record = serde_json::json!({ "prompt": prompt, "response": response });
        canonical.push(record.to_string());
    }
    if count == 0 {
        return Err("Inline dataset must contain at least one example.".into());
    }
    Ok(canonical.join("\n"))
}

/// New inline callers bind canonical worker bytes separately from the logical
/// Studio dataset fingerprint. Legacy callers without either new field retain
/// their existing raw-wire fingerprint validation and source-selection path.
fn canonicalize_reviewed_inline_datasets(
    request: &StartRequest,
) -> Result<Option<(String, String)>, String> {
    let (training_digest, validation_digest) = match (
        request.dataset_payload_sha256.as_deref(),
        request.validation_payload_sha256.as_deref(),
    ) {
        (None, None) => return Ok(None),
        (Some(training), Some(validation)) => (training, validation),
        _ => return Err("Inline payload digests must include both training and validation.".into()),
    };
    if request.schema_version != Some(2) || parsed_method(&request.method)? != FoundryMethod::Weight {
        return Err("Inline payload digests require a schema-2 weight-training request.".into());
    }
    if !request.source_paths.is_empty() || !request.training_examples.is_empty() {
        return Err("Inline payload digests cannot be combined with picker sources or media.".into());
    }
    for digest in [training_digest, validation_digest] {
        if digest.len() != 64 || !digest.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)) {
            return Err("Inline payload digests must be lowercase 64-character SHA-256 values.".into());
        }
    }
    let dataset = request.dataset_jsonl.as_deref()
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "Inline payload digests require an approved training dataset.".to_string())?;
    let validation = request.validation_dataset_jsonl.as_deref()
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "Inline payload digests require an approved validation dataset.".to_string())?;
    // Keep the existing raw byte/record/count limits and canonicalization rules.
    // Neither split is written until both canonical digests have been checked.
    let canonical_training = canonicalize_inline_dataset(dataset, None)?;
    let canonical_validation = canonicalize_inline_dataset(validation, None)?;
    if format!("{:x}", Sha256::digest(canonical_training.as_bytes())) != training_digest {
        return Err("Inline training payload SHA-256 does not match the canonical data.".into());
    }
    if format!("{:x}", Sha256::digest(canonical_validation.as_bytes())) != validation_digest {
        return Err("Inline validation payload SHA-256 does not match the canonical data.".into());
    }
    Ok(Some((canonical_training, canonical_validation)))
}

fn split_training_dataset(dataset: &Path) -> Result<(String, String), String> {
    let raw = fs::read_to_string(dataset)
        .map_err(|error| format!("Could not read the local JSONL dataset: {error}"))?;
    let canonical = canonicalize_inline_dataset(&raw, None)?;
    let rows = canonical.lines().collect::<Vec<_>>();
    if rows.len() < 2 {
        return Err(
            "Weight training requires at least two reviewed examples so validation remains separate."
                .into(),
        );
    }
    let validation_count = (rows.len() / 10).max(1).min(rows.len() - 1);
    let split_at = rows.len() - validation_count;
    Ok((rows[..split_at].join("\n"), rows[split_at..].join("\n")))
}

fn prepare_supervised_media_dataset(
    examples: &[SupervisedMediaExample],
    base_model_id: &str,
    job_dir: &Path,
) -> Result<(String, String), String> {
    let rows = prepare_supervised_media_rows(examples, base_model_id, job_dir)?;
    split_training_rows(rows)
}

fn prepare_supervised_media_rows(
    examples: &[SupervisedMediaExample],
    base_model_id: &str,
    job_dir: &Path,
) -> Result<Vec<String>, String> {
    if examples.len() > MAX_INLINE_DATASET_EXAMPLES {
        return Err("Multimodal training exceeds the 20000 example bound.".into());
    }
    let modalities = crate::model_foundry_training::training_model_modalities(base_model_id)?;
    let media_dir = job_dir.join("media");
    fs::create_dir_all(&media_dir)
        .map_err(|error| format!("Could not create the private media directory: {error}"))?;
    let mut rows = Vec::with_capacity(examples.len());
    for (index, example) in examples.iter().enumerate() {
        let media_type = example.media_type.trim().to_ascii_lowercase();
        if !matches!(media_type.as_str(), "image" | "video")
            || !modalities.iter().any(|value| value == &media_type)
        {
            return Err(format!(
                "The selected base model does not support labeled {media_type} training."
            ));
        }
        let prompt = example.prompt.trim();
        let response = example.response.trim();
        if prompt.is_empty()
            || response.is_empty()
            || prompt.len() > 16_384
            || response.len() > 16_384
        {
            return Err(
                "Every media example requires a bounded training question and expected answer."
                    .into(),
            );
        }
        let canonical = PathBuf::from(example.path.trim())
            .canonicalize()
            .map_err(|_| "A selected media example is missing or inaccessible.".to_string())?;
        let metadata = fs::symlink_metadata(&canonical)
            .map_err(|error| format!("Could not inspect a selected media example: {error}"))?;
        if !metadata.is_file() || metadata.file_type().is_symlink() {
            return Err("A selected media example is not a safe regular file.".into());
        }
        let extension = canonical
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or_default()
            .to_ascii_lowercase();
        let extension_ok = match media_type.as_str() {
            "image" => matches!(extension.as_str(), "png" | "jpg" | "jpeg" | "webp"),
            "video" => matches!(extension.as_str(), "mp4" | "mov" | "webm"),
            _ => false,
        };
        if !extension_ok {
            return Err("A selected media file extension does not match its declared type.".into());
        }
        validate_source_size(&canonical, &extension, metadata.len())?;
        let target = media_dir.join(format!("{index:06}.{extension}"));
        fs::copy(&canonical, &target)
            .map_err(|error| format!("Could not copy a selected media example locally: {error}"))?;
        let source_sha256 = stream_file_sha256(&canonical)?;
        let copied_sha256 = stream_file_sha256(&target)?;
        if source_sha256 != copied_sha256 {
            return Err("A copied media example failed its integrity check.".into());
        }
        rows.push(
            serde_json::json!({
                "prompt": prompt,
                "response": response,
                "mediaType": media_type,
                "mediaPath": target.to_string_lossy(),
                "mediaSha256": copied_sha256,
                "plannedFrames": if media_type == "video" { example.planned_frames.clamp(1, 32) } else { 1 },
            })
            .to_string(),
        );
    }
    Ok(rows)
}

fn split_training_rows(rows: Vec<String>) -> Result<(String, String), String> {
    if rows.len() < 2 {
        return Err("Weight training requires at least two reviewed examples so validation remains separate.".into());
    }
    let validation_count = (rows.len() / 10).max(1).min(rows.len() - 1);
    let split_at = rows.len() - validation_count;
    Ok((rows[..split_at].join("\n"), rows[split_at..].join("\n")))
}

fn prepare_weight_text_rows(sources: &[PathBuf]) -> Result<Vec<String>, String> {
    let prepared = clean_chunks(sources)?;
    let rows = prepared
        .chunks
        .into_iter()
        .map(|chunk| serde_json::json!({ "text": chunk.text }).to_string())
        .collect::<Vec<_>>();
    if rows.is_empty() {
        return Err("The selected documents produced no safe local training text.".into());
    }
    Ok(rows)
}

fn validated_sources(paths: &[String]) -> Result<Vec<PathBuf>, String> {
    if paths.is_empty() {
        return Err("Choose at least one local source with the native picker.".into());
    }
    paths
        .iter()
        .map(|value| {
            let canonical = PathBuf::from(value)
                .canonicalize()
                .map_err(|_| format!("Source is missing or inaccessible: {value}"))?;
            if !canonical.is_file() {
                return Err(format!("Source is not a regular file: {value}"));
            }
            let extension = canonical
                .extension()
                .and_then(|value| value.to_str())
                .unwrap_or_default()
                .to_ascii_lowercase();
            if !matches!(
                extension.as_str(),
                "txt"
                    | "md"
                    | "json"
                    | "jsonl"
                    | "csv"
                    | "ts"
                    | "tsx"
                    | "js"
                    | "jsx"
                    | "py"
                    | "rs"
                    | "pdf"
                    | "docx"
                    | "wav"
                    | "mp3"
                    | "m4a"
                    | "flac"
                    | "mp4"
                    | "mov"
                    | "webm"
                    | "mkv"
            ) {
                return Err(format!(
                    "{} requires a verified extractor or transcription backend that is not currently available.",
                    canonical.display()
                ));
            }
            let metadata = fs::metadata(&canonical)
                .map_err(|error| format!("Could not inspect source {value}: {error}"))?;
            validate_source_size(&canonical, &extension, metadata.len())?;
            Ok(canonical)
        })
        .collect()
}

fn is_media_extension(extension: &str) -> bool {
    matches!(
        extension,
        "wav" | "mp3" | "m4a" | "flac" | "mp4" | "mov" | "webm" | "mkv"
    )
}

fn source_size_limit(extension: &str) -> u64 {
    if is_media_extension(extension) {
        MAX_MEDIA_SOURCE_BYTES
    } else {
        MAX_DOCUMENT_SOURCE_BYTES
    }
}

fn validate_source_size(source: &Path, extension: &str, source_bytes: u64) -> Result<(), String> {
    if source_bytes <= source_size_limit(extension) {
        return Ok(());
    }
    let limit = if is_media_extension(extension) {
        "2 GB media"
    } else {
        "64 MB document"
    };
    Err(format!(
        "{} exceeds the {limit} per-source safety limit.",
        source.display()
    ))
}

struct PreparedKnowledge {
    chunks: Vec<KnowledgeChunk>,
    sources: Vec<SourceManifestEntry>,
}

fn contains_high_confidence_secret(value: &str) -> bool {
    let upper = value.to_ascii_uppercase();
    if upper.contains("-----BEGIN PRIVATE KEY-----")
        || upper.contains("-----BEGIN RSA PRIVATE KEY-----")
    {
        return true;
    }
    value
        .split(|character: char| character.is_whitespace() || "\"'=:,;()[]{}".contains(character))
        .any(|token| {
            (token.starts_with("sk-") && token.len() >= 23)
                || (token.starts_with("ghp_") && token.len() >= 24)
                || (token.starts_with("AKIA")
                    && token.len() == 20
                    && token
                        .chars()
                        .all(|character| character.is_ascii_alphanumeric()))
        })
}

fn parse_csv_records(value: &str) -> Result<Vec<Vec<String>>, String> {
    let mut records = Vec::new();
    let mut record = Vec::new();
    let mut field = String::new();
    let mut quoted = false;
    let mut characters = value.chars().peekable();
    while let Some(character) = characters.next() {
        match character {
            '"' if quoted && characters.peek() == Some(&'"') => {
                field.push('"');
                characters.next();
            }
            '"' => quoted = !quoted,
            ',' if !quoted => record.push(std::mem::take(&mut field)),
            '\n' if !quoted => {
                if field.ends_with('\r') {
                    field.pop();
                }
                record.push(std::mem::take(&mut field));
                if record.iter().any(|entry| !entry.trim().is_empty()) {
                    records.push(std::mem::take(&mut record));
                } else {
                    record.clear();
                }
            }
            _ => field.push(character),
        }
    }
    if quoted {
        return Err("CSV source contains an unterminated quoted field.".into());
    }
    if !field.is_empty() || !record.is_empty() {
        record.push(field);
        if record.iter().any(|entry| !entry.trim().is_empty()) {
            records.push(record);
        }
    }
    let width = records.first().map(Vec::len).unwrap_or(0);
    if records.len() < 2 || width == 0 || records.iter().any(|row| row.len() != width) {
        return Err("CSV source requires one header row and consistently shaped data rows.".into());
    }
    Ok(records)
}

fn decode_docx_xml(value: &str) -> String {
    let with_boundaries = value
        .replace("</w:p>", "\n\n")
        .replace("</w:tr>", "\n\n")
        .replace("</w:tc>", "\t")
        .replace("<w:tab/>", "\t")
        .replace("<w:br/>", "\n");
    let mut output = String::new();
    let mut in_tag = false;
    for character in with_boundaries.chars() {
        match character {
            '<' => in_tag = true,
            '>' => in_tag = false,
            _ if !in_tag => output.push(character),
            _ => {}
        }
    }
    output
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
}

fn extract_docx_text(source: &Path, bytes: &[u8]) -> Result<String, String> {
    let mut archive = zip::ZipArchive::new(Cursor::new(bytes))
        .map_err(|_| format!("{} is not a valid DOCX container.", source.display()))?;
    let mut document = archive
        .by_name("word/document.xml")
        .map_err(|_| format!("{} has no Word document body.", source.display()))?;
    if document.size() > 32 * 1024 * 1024 {
        return Err(format!(
            "{} exceeds the 32 MB decompressed DOCX text limit.",
            source.display()
        ));
    }
    let mut xml = String::new();
    document
        .read_to_string(&mut xml)
        .map_err(|_| format!("{} contains invalid DOCX XML text.", source.display()))?;
    let text = decode_docx_xml(&xml);
    if text.trim().is_empty() {
        return Err(format!(
            "{} contains no extractable DOCX text.",
            source.display()
        ));
    }
    Ok(text)
}

fn extract_pdf_text(source: &Path, bytes: &[u8]) -> Result<String, String> {
    const MAX_EXTRACTED_PDF_TEXT_BYTES: usize = 32 * 1024 * 1024;
    let pages = pdf_extract::extract_text_from_mem_by_pages(bytes).map_err(|_| {
        format!(
            "{} is malformed, encrypted, or uses unsupported PDF content.",
            source.display()
        )
    })?;
    let mut prepared = String::new();
    for (index, page) in pages.iter().enumerate() {
        let text = page.trim();
        if text.is_empty() {
            continue;
        }
        if !prepared.is_empty() {
            prepared.push_str("\n\n");
        }
        prepared.push_str(&format!("PDF page {}\n{text}", index + 1));
        if prepared.len() > MAX_EXTRACTED_PDF_TEXT_BYTES {
            return Err(format!(
                "{} exceeds the 32 MB extracted PDF text limit.",
                source.display()
            ));
        }
    }
    if prepared.trim().is_empty() {
        return Err(format!(
            "{} contains no extractable PDF text. Image-only or scanned PDFs require a verified local OCR processor, which is not installed.",
            source.display()
        ));
    }
    Ok(prepared)
}

fn prepare_source_text(source: &Path, bytes: &[u8]) -> Result<(String, String), String> {
    let extension = source
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    if matches!(extension.as_str(), "docx" | "pdf") {
        let prepared = if extension == "docx" {
            extract_docx_text(source, bytes)?
        } else {
            extract_pdf_text(source, bytes)?
        };
        if contains_high_confidence_secret(&prepared) {
            return Err(format!(
                "{} contains a high-confidence credential or private-key pattern. Redact and review it before training.",
                source.display()
            ));
        }
        return Ok((prepared, extension));
    }
    let decoded = std::str::from_utf8(bytes)
        .map_err(|_| format!("{} is not valid UTF-8 text.", source.display()))?
        .trim_start_matches('\u{feff}');
    let prepared = match extension.as_str() {
        "json" => {
            let parsed: serde_json::Value = serde_json::from_str(decoded)
                .map_err(|_| format!("{} is not valid JSON.", source.display()))?;
            serde_json::to_string_pretty(&parsed)
                .map_err(|error| format!("Could not normalize JSON: {error}"))?
        }
        "jsonl" => {
            let mut records = Vec::new();
            for (index, line) in decoded.lines().enumerate() {
                if line.trim().is_empty() {
                    continue;
                }
                let parsed: serde_json::Value = serde_json::from_str(line).map_err(|_| {
                    format!(
                        "{} has invalid JSON on line {}.",
                        source.display(),
                        index + 1
                    )
                })?;
                records.push(parsed.to_string());
            }
            if records.is_empty() {
                return Err(format!("{} contains no JSONL records.", source.display()));
            }
            records.join("\n\n")
        }
        "csv" => {
            let records = parse_csv_records(decoded)?;
            let headers = &records[0];
            records[1..]
                .iter()
                .map(|row| {
                    headers
                        .iter()
                        .zip(row)
                        .map(|(header, value)| format!("{}: {}", header.trim(), value.trim()))
                        .collect::<Vec<_>>()
                        .join("\n")
                })
                .collect::<Vec<_>>()
                .join("\n\n")
        }
        _ => decoded.replace("\r\n", "\n"),
    };
    if contains_high_confidence_secret(&prepared) {
        return Err(format!(
            "{} contains a high-confidence credential or private-key pattern. Redact and review it before training.",
            source.display()
        ));
    }
    Ok((prepared, extension))
}

fn prepare_media_source(source: &Path, extension: &str) -> Result<(String, String), String> {
    let transcript = crate::faster_whisper::faster_whisper_transcribe_file("base", source)
        .map_err(|error| {
            format!(
                "{} requires the installed verified local speech model: {error}",
                source.display()
            )
        })?;
    if transcript.trim().is_empty() {
        return Err(format!(
            "{} produced no reviewable local transcript.",
            source.display()
        ));
    }
    if contains_high_confidence_secret(&transcript) {
        return Err(format!(
            "{} produced a transcript containing a high-confidence credential or private-key pattern. Redact and review it before training.",
            source.display()
        ));
    }
    let media_label = if matches!(extension, "mp4" | "mov" | "webm" | "mkv") {
        "Video audio-track transcript"
    } else {
        "Audio transcript"
    };
    Ok((
        format!("{media_label}\n\n{}", transcript.trim()),
        format!("{extension}-transcript"),
    ))
}

fn stream_file_sha256(source: &Path) -> Result<String, String> {
    let file = fs::File::open(source)
        .map_err(|error| format!("Could not read {}: {error}", source.display()))?;
    let mut reader = BufReader::new(file);
    let mut digest = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let read = reader
            .read(&mut buffer)
            .map_err(|error| format!("Could not read {}: {error}", source.display()))?;
        if read == 0 {
            break;
        }
        digest.update(&buffer[..read]);
    }
    Ok(format!("{:x}", digest.finalize()))
}

fn prepare_source(source: &Path) -> Result<(String, String, u64, String), String> {
    let extension = source
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    let before = fs::metadata(source)
        .map_err(|error| format!("Could not inspect {}: {error}", source.display()))?;
    let source_bytes = before.len();
    validate_source_size(source, &extension, source_bytes)?;
    if is_media_extension(&extension) {
        let source_sha256 = stream_file_sha256(source)?;
        let (text, format) = prepare_media_source(source, &extension)?;
        let after = fs::metadata(source)
            .map_err(|error| format!("Could not recheck {}: {error}", source.display()))?;
        if after.len() != source_bytes || after.modified().ok() != before.modified().ok() {
            return Err(format!(
                "{} changed during local transcription. Review the source and try again.",
                source.display()
            ));
        }
        return Ok((text, format, source_bytes, source_sha256));
    }
    let bytes = fs::read(source)
        .map_err(|error| format!("Could not read {}: {error}", source.display()))?;
    let source_sha256 = format!("{:x}", Sha256::digest(&bytes));
    let (text, format) = prepare_source_text(source, &bytes)?;
    Ok((text, format, source_bytes, source_sha256))
}

fn clean_chunks(sources: &[PathBuf]) -> Result<PreparedKnowledge, String> {
    let mut seen = BTreeSet::new();
    let mut chunks = Vec::new();
    let mut source_manifests = Vec::new();
    for source in sources {
        let (text, format, source_bytes, source_sha256) = prepare_source(source)?;
        let source_name = source
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("source")
            .to_string();
        let chunk_start = chunks.len();
        let mut offset = 0usize;
        for raw_part in text.split("\n\n") {
            let line_start = text[..offset].bytes().filter(|byte| *byte == b'\n').count() + 1;
            let line_end = line_start + raw_part.bytes().filter(|byte| *byte == b'\n').count();
            offset = offset.saturating_add(raw_part.len() + 2).min(text.len());
            let part = raw_part.trim();
            if part.len() < 20 {
                continue;
            }
            let normalized = part.split_whitespace().collect::<Vec<_>>().join(" ");
            let digest = format!("{:x}", Sha256::digest(normalized.as_bytes()));
            if !seen.insert(digest.clone()) {
                continue;
            }
            chunks.push(KnowledgeChunk {
                id: format!("chunk-{}", &digest[..16]),
                source_name: source_name.clone(),
                source_anchor: Some(format!("lines {line_start}-{line_end}")),
                text: normalized,
                sha256: digest,
            });
        }
        let chunk_count = chunks.len() - chunk_start;
        if chunk_count > 0 {
            source_manifests.push(SourceManifestEntry {
                source_name,
                format,
                source_bytes,
                source_sha256,
                prepared_sha256: format!("{:x}", Sha256::digest(text.as_bytes())),
                chunk_count,
            });
        }
    }
    if chunks.is_empty() {
        return Err("Sources did not contain enough usable text after cleaning.".into());
    }
    Ok(PreparedKnowledge {
        chunks,
        sources: source_manifests,
    })
}

fn verified_source_count(prepared: &PreparedKnowledge) -> usize {
    prepared.sources.len()
}

fn process_knowledge(
    app: tauri::AppHandle,
    request: StartRequest,
    sources: Vec<PathBuf>,
    job_dir: PathBuf,
    mut job: FoundryJob,
) {
    let _active_guard = ActiveJobGuard(job.id.clone());
    let job_path = job_dir.join("job.json");
    let cancellation_path = job_dir.join("cancel.requested");
    let finish = |job: &FoundryJob| {
        let _ = write_job(&job_path, job);
        let _ = app.emit("model-foundry:job-updated", job);
    };
    job.status = "preparing".into();
    job.progress = 25;
    job.updated_at = now();
    finish(&job);
    if cancellation_path.exists() {
        job.status = "cancelled".into();
        job.error = Some("Cancelled before local source processing.".into());
        job.updated_at = now();
        finish(&job);
        return;
    }

    match clean_chunks(&sources) {
        Ok(prepared) => {
            if cancellation_path.exists() {
                job.status = "cancelled".into();
                job.error = Some("Cancelled after local source processing.".into());
                job.updated_at = now();
                finish(&job);
                return;
            }
            job.status = "packaging".into();
            job.progress = 80;
            job.updated_at = now();
            finish(&job);
            let artifact = KnowledgeArtifact {
                schema_version: 1,
                version: request.version.unwrap_or(1).max(1),
                model_name: request.name,
                description: request.description,
                purpose: request.purpose,
                default_behavior: request.instructions,
                base_model_id: request.base_model_id,
                processing: "local-rag-knowledge".into(),
                source_count: verified_source_count(&prepared),
                sources: prepared.sources,
                chunks: prepared.chunks,
            };
            let artifact_path = job_dir.join("knowledge-artifact.json");
            let result = serde_json::to_vec_pretty(&artifact)
                .map_err(|error| error.to_string())
                .and_then(|bytes| {
                    write_atomic(&artifact_path, &bytes)?;
                    let validated = validate_artifact(&artifact_path)?;
                    let stored = fs::read(&artifact_path)
                        .map_err(|error| format!("Could not reopen artifact: {error}"))?;
                    Ok((
                        validated.source_count,
                        stored.len() as u64,
                        format!("{:x}", Sha256::digest(&stored)),
                    ))
                });
            match result {
                Ok((source_count, storage_bytes, artifact_sha256)) => {
                    if cancellation_path.exists() {
                        let _ = fs::remove_file(&artifact_path);
                        job.status = "cancelled".into();
                        job.error = Some("Cancelled before artifact activation.".into());
                    } else {
                        job.status = "completed".into();
                        job.progress = 100;
                        job.artifact_path = Some(artifact_path.to_string_lossy().into_owned());
                        job.artifact_verified = true;
                        job.artifact_sha256 = Some(artifact_sha256);
                        job.storage_bytes = storage_bytes;
                        job.source_count = source_count;
                    }
                }
                Err(error) => {
                    job.status = "failed".into();
                    job.error = Some(format!("Artifact packaging failed: {error}"));
                }
            }
        }
        Err(error) => {
            job.status = "failed".into();
            job.error = Some(error);
        }
    }
    job.updated_at = now();
    finish(&job);
    if job.status == "completed" && job.artifact_verified {
        let _ = app
            .notification()
            .builder()
            .title("Your VibeSpace model is ready")
            .body(format!(
                "{} finished local processing and passed artifact verification.",
                job.name
            ))
            .show();
    }
}

fn process_weight(
    app: tauri::AppHandle,
    request: StartRequest,
    dataset: PathBuf,
    validation_dataset: PathBuf,
    job_dir: PathBuf,
    mut job: FoundryJob,
    resume_checkpoint: Option<PathBuf>,
) {
    let _active_guard = ActiveJobGuard(job.id.clone());
    let job_path = job_dir.join("job.json");
    let cancellation_path = job_dir.join("cancel.requested");
    let finish = |job: &FoundryJob| {
        let _ = write_job(&job_path, job);
        let _ = app.emit("model-foundry:job-updated", job);
    };
    job.status = "training".into();
    job.progress = 35;
    job.updated_at = now();
    finish(&job);
    if cancellation_path.exists() {
        job.status = "cancelled".into();
        job.error = Some("Cancelled before local weight training.".into());
        job.updated_at = now();
        finish(&job);
        return;
    }

    let training_config = match request.training_config.clone() {
        Some(config) => match config.validated(&request.method) {
            Ok(config) => config,
            Err(error) => {
                job.status = "failed".into();
                job.error = Some(error);
                job.updated_at = now();
                finish(&job);
                return;
            }
        },
        None => match crate::model_foundry_training::TrainingConfiguration::legacy_defaults(
            &request.method,
            request.epochs,
            request.max_steps,
        ) {
            Ok(config) => config,
            Err(error) => {
                job.status = "failed".into();
                job.error = Some(error);
                job.updated_at = now();
                finish(&job);
                return;
            }
        },
    };
    match crate::model_foundry_training::run_training_worker(
        &app,
        &job.id,
        &request.base_model_id,
        &request.method,
        &dataset,
        &validation_dataset,
        &job_dir,
        training_config,
        request.target_modules.clone(),
        resume_checkpoint.as_deref(),
    ) {
        Ok(result) if !cancellation_path.exists() => {
            job.status = "completed".into();
            job.progress = 100;
            job.artifact_path = Some(result.artifact_path.to_string_lossy().into_owned());
            job.artifact_verified = true;
            job.artifact_sha256 = Some(result.evidence.sha256);
            job.storage_bytes = result.evidence.storage_bytes;
            job.source_count = 1;
            job.resume_available = false;
            job.error = None;
        }
        Ok(_) => {
            job.status = "cancelled".into();
            job.error = Some("Cancelled before the trained artifact was activated.".into());
        }
        Err(_error) if cancellation_path.exists() => {
            job.status = "cancelled".into();
            job.error = Some("Local weight training was cancelled.".into());
            let _ = fs::remove_dir_all(job_dir.join("weight-artifact"));
        }
        Err(error) => {
            job.status = "failed".into();
            job.error = Some(error);
            job.resume_available = crate::model_foundry_training::latest_training_checkpoint(
                &job_dir.join("weight-artifact"),
            )
            .ok()
            .flatten()
            .is_some();
            if !job.resume_available {
                let _ = fs::remove_dir_all(job_dir.join("weight-artifact"));
            }
        }
    }
    job.updated_at = now();
    finish(&job);
    if job.status == "completed" && job.artifact_verified {
        let _ = app
            .notification()
            .builder()
            .title("Your VibeSpace model is ready")
            .body(format!(
                "{} finished local weight training and passed artifact verification.",
                job.name
            ))
            .show();
    }
}

#[tauri::command]
pub fn model_foundry_start_training(
    app: tauri::AppHandle,
    request: StartRequest,
) -> Result<FoundryJob, String> {
    if !request.local_only {
        return Err("Model Foundry only accepts local processing in this build.".into());
    }
    if request.schema_version.is_some_and(|version| version != 2) {
        return Err("Unsupported Model Foundry training request version.".into());
    }
    if let Some(project_id) = request.project_id.as_deref() {
        validated_job_id(project_id)
            .map_err(|_| "Invalid Model Foundry project identifier.".to_string())?;
    }
    if request.name.trim().is_empty() || request.name.chars().count() > 80 {
        return Err("Model name must contain 1 to 80 characters.".into());
    }
    let method = parsed_method(&request.method)?;
    if !allowed_model_for_method(&request.base_model_id, method) {
        return Err("The selected base model is not in the verified local catalog.".into());
    }
    if method == FoundryMethod::Weight {
        if request
            .epochs
            .is_some_and(|value| !(1..=20).contains(&value))
        {
            return Err("Model Foundry epochs must be between 1 and 20.".into());
        }
        if request
            .max_steps
            .is_some_and(|value| !(1..=1_000_000).contains(&value))
        {
            return Err("Model Foundry max steps must be between 1 and 1000000.".into());
        }
        if let Some(config) = request.training_config.clone() {
            let config = config.validated(&request.method)?;
            if request.epochs.is_some_and(|epochs| epochs != config.epochs)
                || request
                    .max_steps
                    .is_some_and(|max_steps| Some(max_steps) != config.max_steps)
            {
                return Err("Model Foundry legacy and versioned training limits disagree.".into());
            }
        } else if request.schema_version == Some(2) {
            return Err("TrainingRequestV2 requires an explicit training configuration.".into());
        }
        let parameters_b =
            crate::model_foundry_training::training_model_parameters_b(&request.base_model_id)?;
        let requirements = weight_training_requirements(&request.method, parameters_b);
        let compute_device = request
            .training_config
            .as_ref()
            .map(|config| config.compute_device.as_str())
            .unwrap_or("gpu");
        validate_weight_hardware(
            &request.method,
            compute_device,
            &detect_hardware(&app)?,
            requirements,
        )?;
    }
    let reviewed_payloads = canonicalize_reviewed_inline_datasets(&request)?;
    let inline_dataset = request
        .dataset_jsonl
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    if method == FoundryMethod::Knowledge && !request.training_examples.is_empty() {
        return Err(
            "Labeled image and video examples require a verified multimodal weight-training model."
                .into(),
        );
    }
    if !request.training_examples.is_empty() && inline_dataset.is_some() {
        return Err(
            "Inline Dataset Studio exports cannot be mixed with picker-selected media.".into(),
        );
    }
    if inline_dataset.is_some() && !request.source_paths.is_empty() {
        return Err(
            "Provide picker-selected sources or an inline Dataset Studio export, not both.".into(),
        );
    }
    let mut canonicalized: Option<String> = None;
    let mut canonicalized_validation: Option<String> = None;
    let mut sources: Vec<PathBuf> = if let Some(dataset) = inline_dataset {
        if method != FoundryMethod::Weight {
            return Err("Inline Dataset Studio exports are only valid for weight training.".into());
        }
        let (canonical_dataset, canonical_validation) = match reviewed_payloads {
            Some(payloads) => payloads,
            None => {
                let training = canonicalize_inline_dataset(dataset, request.dataset_fingerprint.as_deref())?;
                let validation = request.validation_dataset_jsonl.as_deref()
                    .map(str::trim).filter(|value| !value.is_empty())
                    .ok_or_else(|| "TrainingRequestV2 requires an approved validation dataset.".to_string())?;
                (training, canonicalize_inline_dataset(validation, None)?)
            }
        };
        canonicalized = Some(canonical_dataset);
        canonicalized_validation = Some(canonical_validation);
        Vec::new()
    } else if request.source_paths.is_empty() && !request.training_examples.is_empty() {
        Vec::new()
    } else {
        validated_sources(&request.source_paths)?
    };
    if method == FoundryMethod::Weight
        && inline_dataset.is_none()
        && sources.is_empty()
        && request.training_examples.is_empty()
    {
        return Err("Weight training requires reviewed local data.".into());
    }
    let id = format!("job_{}", nanoid::nanoid!(14));
    let job_dir = foundry_root(&app)?.join("jobs").join(&id);
    fs::create_dir_all(&job_dir)
        .map_err(|error| format!("Could not create private job directory: {error}"))?;
    let one_jsonl = sources.len() == 1
        && sources[0]
            .extension()
            .and_then(|value| value.to_str())
            .is_some_and(|value| value.eq_ignore_ascii_case("jsonl"));
    if method == FoundryMethod::Weight
        && inline_dataset.is_none()
        && (!request.training_examples.is_empty() || !one_jsonl)
    {
        if sources.iter().any(|source| {
            source
                .extension()
                .and_then(|value| value.to_str())
                .is_some_and(|value| value.eq_ignore_ascii_case("jsonl"))
        }) {
            return Err("Use one reviewed JSONL dataset by itself, or combine documents with labeled media.".into());
        }
        let mut rows = if sources.is_empty() {
            Vec::new()
        } else {
            prepare_weight_text_rows(&sources)?
        };
        if !request.training_examples.is_empty() {
            rows.extend(prepare_supervised_media_rows(
                &request.training_examples,
                &request.base_model_id,
                &job_dir,
            )?);
        }
        let (train, validation) = split_training_rows(rows)?;
        let dataset_path = job_dir.join("dataset.jsonl");
        write_atomic(&dataset_path, train.as_bytes()).map_err(|error| {
            format!("Could not store the private prepared training split: {error}")
        })?;
        let validation_path = job_dir.join("validation-dataset.jsonl");
        write_atomic(&validation_path, validation.as_bytes()).map_err(|error| {
            format!("Could not store the private prepared validation split: {error}")
        })?;
        sources = vec![dataset_path];
    } else if let Some(canonical_dataset) = canonicalized.as_deref() {
        let dataset_path = job_dir.join("dataset.jsonl");
        write_atomic(&dataset_path, canonical_dataset.as_bytes())
            .map_err(|error| format!("Could not store the private inline dataset: {error}"))?;
        sources = vec![dataset_path];
    } else if method == FoundryMethod::Weight {
        let (train, validation) = split_training_dataset(
            sources
                .first()
                .ok_or_else(|| "A local training dataset is required.".to_string())?,
        )?;
        let dataset_path = job_dir.join("dataset.jsonl");
        write_atomic(&dataset_path, train.as_bytes())
            .map_err(|error| format!("Could not store the private training split: {error}"))?;
        let validation_path = job_dir.join("validation-dataset.jsonl");
        write_atomic(&validation_path, validation.as_bytes())
            .map_err(|error| format!("Could not store the private validation split: {error}"))?;
        sources = vec![dataset_path];
    }
    let validation_dataset = if let Some(canonical_validation) = canonicalized_validation.as_deref()
    {
        let validation_path = job_dir.join("validation-dataset.jsonl");
        write_atomic(&validation_path, canonical_validation.as_bytes())
            .map_err(|error| format!("Could not store the private validation dataset: {error}"))?;
        validation_path
    } else if job_dir.join("validation-dataset.jsonl").is_file() {
        job_dir.join("validation-dataset.jsonl")
    } else {
        sources
            .first()
            .cloned()
            .ok_or_else(|| "A local validation dataset is required.".to_string())?
    };
    let timestamp = now();
    let job = FoundryJob {
        id,
        project_id: request.project_id.clone(),
        name: request.name.clone(),
        base_model_id: request.base_model_id.clone(),
        method: request.method.clone(),
        status: "queued".into(),
        progress: 5,
        artifact_path: None,
        artifact_verified: false,
        artifact_sha256: None,
        storage_bytes: 0,
        source_count: 0,
        version: request.version.unwrap_or(1).max(1),
        resume_available: false,
        error: None,
        created_at: timestamp.clone(),
        updated_at: timestamp,
    };
    write_job(&job_dir.join("job.json"), &job)?;
    write_atomic(
        &job_dir.join("request.json"),
        &serde_json::to_vec_pretty(&request)
            .map_err(|error| format!("Could not encode private job request: {error}"))?,
    )?;
    let worker_job = job.clone();
    active_jobs()
        .lock()
        .map_err(|_| "Model Foundry active-job registry is unavailable.".to_string())?
        .insert(job.id.clone());
    std::thread::spawn(move || match method {
        FoundryMethod::Knowledge => process_knowledge(app, request, sources, job_dir, worker_job),
        FoundryMethod::Weight => {
            let dataset = sources
                .into_iter()
                .next()
                .expect("weight source validation requires exactly one path");
            process_weight(
                app,
                request,
                dataset,
                validation_dataset,
                job_dir,
                worker_job,
                None,
            );
        }
    });
    Ok(job)
}

#[tauri::command]
pub fn model_foundry_list_jobs(app: tauri::AppHandle) -> Result<Vec<FoundryJob>, String> {
    let jobs_dir = foundry_root(&app)?.join("jobs");
    if !jobs_dir.exists() {
        return Ok(Vec::new());
    }
    let mut jobs = Vec::new();
    for entry in fs::read_dir(jobs_dir).map_err(|error| error.to_string())? {
        let path = entry
            .map_err(|error| error.to_string())?
            .path()
            .join("job.json");
        if let Ok(bytes) = fs::read(&path) {
            if let Ok(mut job) = serde_json::from_slice::<FoundryJob>(&bytes) {
                let active = active_jobs()
                    .lock()
                    .map(|active| active.contains(&job.id))
                    .unwrap_or(false);
                if !active
                    && matches!(
                        job.status.as_str(),
                        "queued"
                            | "validating"
                            | "preparing"
                            | "training"
                            | "evaluating"
                            | "packaging"
                    )
                {
                    job.status = "failed".into();
                    let job_dir = path.parent().unwrap_or_else(|| Path::new(""));
                    job.resume_available = job.method != "knowledge"
                        && crate::model_foundry_training::latest_training_checkpoint(
                            &job_dir.join("weight-artifact"),
                        )
                        .ok()
                        .flatten()
                        .is_some();
                    job.error = Some(if job.resume_available {
                        "The previous local process was interrupted. A verified checkpoint is ready to resume."
                            .into()
                    } else {
                        "The previous local process was interrupted. Retry to start a fresh verified run."
                            .into()
                    });
                    job.updated_at = now();
                    let _ = write_job(&path, &job);
                }
                jobs.push(job);
            }
        }
    }
    jobs.sort_by(|left, right| right.updated_at.cmp(&left.updated_at));
    Ok(jobs)
}

#[tauri::command]
pub fn model_foundry_retrieve(
    app: tauri::AppHandle,
    artifact_id: String,
    query: String,
    limit: Option<usize>,
) -> Result<FoundryRetrieval, String> {
    let artifact_id = validated_job_id(artifact_id.trim())?;
    if query.trim().is_empty() || query.chars().count() > 4_000 {
        return Err("Retrieval query must contain 1 to 4,000 characters.".into());
    }
    let job_dir = foundry_root(&app)?.join("jobs").join(artifact_id);
    let job_path = job_dir.join("job.json");
    let job: FoundryJob = serde_json::from_slice(
        &fs::read(&job_path).map_err(|_| "Model Foundry artifact was not found.".to_string())?,
    )
    .map_err(|error| format!("Model Foundry job metadata is invalid: {error}"))?;
    if job.status != "completed" || !job.artifact_verified {
        return Err("Model Foundry artifact is not verified and cannot be used.".into());
    }
    let artifact = validate_artifact(&job_dir.join("knowledge-artifact.json"))?;
    let selected = rank_chunks(&artifact.chunks, &query, limit.unwrap_or(4));
    let source_names = selected
        .iter()
        .map(|chunk| chunk.source_name.clone())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect::<Vec<_>>();
    let context = selected
        .iter()
        .map(|chunk| format!("[Source: {}]\n{}", chunk.source_name, chunk.text))
        .collect::<Vec<_>>()
        .join("\n\n");
    Ok(FoundryRetrieval {
        artifact_id: artifact_id.to_string(),
        model_name: artifact.model_name,
        version: artifact.version,
        base_model_id: artifact.base_model_id,
        default_behavior: artifact.default_behavior,
        context,
        source_names,
    })
}

fn prepare_chat_from_job_dir(
    job_dir: &Path,
    artifact_id: &str,
    query: &str,
    limit: Option<usize>,
) -> Result<FoundryChatPreparation, String> {
    if query.trim().is_empty() || query.chars().count() > 4_000 {
        return Err("Model Foundry chat query must contain 1 to 4,000 characters.".into());
    }
    let job: FoundryJob = serde_json::from_slice(
        &fs::read(job_dir.join("job.json"))
            .map_err(|_| "Model Foundry artifact was not found.".to_string())?,
    )
    .map_err(|error| format!("Model Foundry job metadata is invalid: {error}"))?;
    if job.id != artifact_id || job.status != "completed" || !job.artifact_verified {
        return Err("Model Foundry artifact is not verified and cannot be used.".into());
    }
    match parsed_method(&job.method)? {
        FoundryMethod::Knowledge => {
            let artifact = validate_artifact(&job_dir.join("knowledge-artifact.json"))?;
            if artifact.base_model_id != job.base_model_id
                || artifact.model_name != job.name
                || artifact.version != job.version
            {
                return Err("Model Foundry knowledge metadata failed integrity validation.".into());
            }
            let selected = rank_chunks(&artifact.chunks, query, limit.unwrap_or(4));
            let source_names = selected
                .iter()
                .map(|chunk| chunk.source_name.clone())
                .collect::<BTreeSet<_>>()
                .into_iter()
                .collect::<Vec<_>>();
            let context = selected
                .iter()
                .map(|chunk| format!("[Source: {}]\n{}", chunk.source_name, chunk.text))
                .collect::<Vec<_>>()
                .join("\n\n");
            Ok(FoundryChatPreparation {
                kind: "knowledge".into(),
                artifact_id: artifact_id.into(),
                model_name: artifact.model_name,
                version: artifact.version,
                method: None,
                base_model_id: Some(artifact.base_model_id),
                default_behavior: artifact.default_behavior,
                context: Some(context),
                source_names: Some(source_names),
            })
        }
        FoundryMethod::Weight => {
            let expected = job_dir.join("weight-artifact");
            let recorded = job
                .artifact_path
                .as_deref()
                .map(PathBuf::from)
                .ok_or_else(|| "Model Foundry weight artifact path is missing.".to_string())?;
            let expected = expected
                .canonicalize()
                .map_err(|_| "Model Foundry weight artifact is missing.".to_string())?;
            let recorded = recorded
                .canonicalize()
                .map_err(|_| "Model Foundry weight artifact is missing.".to_string())?;
            if recorded != expected {
                return Err(
                    "Model Foundry weight artifact escaped its private job directory.".into(),
                );
            }
            crate::model_foundry_training::verify_training_artifact(&expected)?;
            Ok(FoundryChatPreparation {
                kind: "weight".into(),
                artifact_id: artifact_id.into(),
                model_name: job.name,
                version: job.version,
                method: Some(job.method),
                base_model_id: None,
                default_behavior: None,
                context: None,
                source_names: None,
            })
        }
    }
}

#[tauri::command]
pub fn model_foundry_prepare_chat(
    app: tauri::AppHandle,
    artifact_id: String,
    query: String,
    limit: Option<usize>,
) -> Result<FoundryChatPreparation, String> {
    let artifact_id = validated_job_id(artifact_id.trim())?;
    let job_dir = foundry_root(&app)?.join("jobs").join(artifact_id);
    prepare_chat_from_job_dir(&job_dir, artifact_id, &query, limit)
}

#[tauri::command]
pub async fn model_foundry_chat(
    app: tauri::AppHandle,
    request_id: String,
    artifact_id: String,
    messages: Vec<FoundryChatMessage>,
    max_output_tokens: Option<u32>,
) -> Result<FoundryChatResponse, String> {
    let request_id = validated_job_id(request_id.trim())?.to_string();
    let artifact_id = validated_job_id(artifact_id.trim())?.to_string();
    let query = messages
        .iter()
        .rev()
        .find(|message| message.role == "user" && !message.content.trim().is_empty())
        .map(|message| message.content.as_str())
        .ok_or_else(|| "Model Foundry chat requires a user message.".to_string())?;
    let job_dir = foundry_root(&app)?.join("jobs").join(&artifact_id);
    let prepared = prepare_chat_from_job_dir(&job_dir, &artifact_id, query, Some(1))?;
    if prepared.kind != "weight" {
        return Err("Knowledge artifacts must use the verified retrieval route.".into());
    }
    let job: FoundryJob = serde_json::from_slice(
        &fs::read(job_dir.join("job.json"))
            .map_err(|_| "Model Foundry artifact was not found.".to_string())?,
    )
    .map_err(|error| format!("Model Foundry job metadata is invalid: {error}"))?;
    let method = job.method.clone();
    let base_model_id = job.base_model_id.clone();
    let normalized_messages = messages
        .into_iter()
        .map(|message| (message.role, message.content))
        .collect::<Vec<_>>();
    let inference_artifact_id = artifact_id.clone();
    let inference_method = method.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        crate::model_foundry_training::run_foundry_inference(
            &app,
            &request_id,
            &inference_artifact_id,
            &base_model_id,
            &inference_method,
            &job_dir,
            &normalized_messages,
            max_output_tokens.unwrap_or(1_024),
        )
    })
    .await
    .map_err(|error| format!("Model Foundry inference worker failed: {error}"))??;
    Ok(weight_chat_response(artifact_id, job, result))
}

fn weight_chat_response(
    artifact_id: String,
    job: FoundryJob,
    result: crate::model_foundry_training::FoundryInferenceResult,
) -> FoundryChatResponse {
    FoundryChatResponse {
        artifact_id,
        // This digest is the already-verified inference artifact, not job metadata.
        artifact_sha256: result.artifact_sha256,
        model_name: job.name,
        version: job.version,
        method: job.method,
        text: result.text,
        input_tokens: result.input_tokens,
        output_tokens: result.output_tokens,
    }
}

#[tauri::command]
pub fn model_foundry_cancel_chat(request_id: String) -> Result<bool, String> {
    crate::model_foundry_training::cancel_foundry_inference(request_id.trim())
}

#[tauri::command]
pub fn model_foundry_detect_hardware(
    app: tauri::AppHandle,
) -> Result<FoundryHardwareProfile, String> {
    detect_hardware(&app)
}

#[tauri::command]
pub fn model_foundry_cancel_job(
    app: tauri::AppHandle,
    job_id: String,
) -> Result<FoundryJob, String> {
    let job_id = validated_job_id(job_id.trim())?;
    let job_dir = foundry_root(&app)?.join("jobs").join(job_id);
    let job_path = job_dir.join("job.json");
    let mut job: FoundryJob = serde_json::from_slice(
        &fs::read(&job_path).map_err(|_| "Model Foundry job was not found.".to_string())?,
    )
    .map_err(|error| format!("Model Foundry job metadata is invalid: {error}"))?;
    if matches!(job.status.as_str(), "completed" | "failed" | "cancelled") {
        return Err("Only an active Model Foundry job can be cancelled.".into());
    }
    fs::write(job_dir.join("cancel.requested"), b"cancel")
        .map_err(|error| format!("Could not persist cancellation: {error}"))?;
    let _ = crate::model_foundry_training::cancel_training_worker(job_id);
    job.status = "cancelled".into();
    job.error = Some("Cancellation requested by the user.".into());
    job.updated_at = now();
    write_job(&job_path, &job)?;
    Ok(job)
}

fn restart_job(
    app: tauri::AppHandle,
    job_id: String,
    allow_completed: bool,
) -> Result<FoundryJob, String> {
    let job_id = validated_job_id(job_id.trim())?;
    let job_dir = foundry_root(&app)?.join("jobs").join(job_id);
    let job: FoundryJob = serde_json::from_slice(
        &fs::read(job_dir.join("job.json"))
            .map_err(|_| "Model Foundry job was not found.".to_string())?,
    )
    .map_err(|error| format!("Model Foundry job metadata is invalid: {error}"))?;
    if !matches!(job.status.as_str(), "failed" | "cancelled")
        && !(allow_completed && job.status == "completed" && job.artifact_verified)
    {
        return Err("Only a failed, cancelled, or verified completed artifact can restart.".into());
    }
    let mut request: StartRequest = serde_json::from_slice(
        &fs::read(job_dir.join("request.json"))
            .map_err(|_| "The private retry record is unavailable.".to_string())?,
    )
    .map_err(|error| format!("The private retry record is invalid: {error}"))?;
    request.version = Some(job.version.saturating_add(1));
    model_foundry_start_training(app, request)
}

fn validate_resume_dataset_path(path: &Path) -> Result<PathBuf, String> {
    reject_linked_path(path)?;
    let sources = validated_sources(&[path.to_string_lossy().into_owned()])?;
    if sources.len() != 1
        || sources[0]
            .extension()
            .and_then(|value| value.to_str())
            .is_none_or(|value| !value.eq_ignore_ascii_case("jsonl"))
    {
        return Err("The private resume dataset is unavailable or invalid.".into());
    }
    Ok(sources
        .into_iter()
        .next()
        .expect("resume validation requires exactly one dataset"))
}

fn resume_dataset_path(job_dir: &Path, source_paths: &[String]) -> Result<PathBuf, String> {
    let private_dataset = job_dir.join("dataset.jsonl");
    if private_dataset.exists() {
        return validate_resume_dataset_path(&private_dataset);
    }

    if source_paths.is_empty() {
        return Err("The private resume dataset is unavailable or invalid.".into());
    }
    let sources = validated_sources(source_paths)?;
    if sources.len() != 1
        || sources[0]
            .extension()
            .and_then(|value| value.to_str())
            .is_none_or(|value| !value.eq_ignore_ascii_case("jsonl"))
    {
        return Err("The private resume dataset is unavailable or invalid.".into());
    }
    Ok(sources.into_iter().next().expect("validated source exists"))
}

#[tauri::command]
pub fn model_foundry_retry_job(
    app: tauri::AppHandle,
    job_id: String,
) -> Result<FoundryJob, String> {
    restart_job(app, job_id, false)
}

#[tauri::command]
pub fn model_foundry_resume_job(
    app: tauri::AppHandle,
    job_id: String,
) -> Result<FoundryJob, String> {
    let job_id = validated_job_id(job_id.trim())?;
    let job_dir = foundry_root(&app)?.join("jobs").join(job_id);
    let job_path = job_dir.join("job.json");
    let mut job: FoundryJob = serde_json::from_slice(
        &fs::read(&job_path).map_err(|_| "Model Foundry job was not found.".to_string())?,
    )
    .map_err(|error| format!("Model Foundry job metadata is invalid: {error}"))?;
    if job.status != "failed" || job.method == "knowledge" {
        return Err("Only an interrupted local weight-training job can resume.".into());
    }
    let checkpoint = crate::model_foundry_training::latest_training_checkpoint(
        &job_dir.join("weight-artifact"),
    )?
    .ok_or_else(|| "No verified local training checkpoint is available to resume.".to_string())?;
    let request: StartRequest = serde_json::from_slice(
        &fs::read(job_dir.join("request.json"))
            .map_err(|_| "The private resume record is unavailable.".to_string())?,
    )
    .map_err(|error| format!("The private resume record is invalid: {error}"))?;
    if !request.local_only
        || parsed_method(&request.method)? != FoundryMethod::Weight
        || request.method != job.method
        || request.base_model_id != job.base_model_id
        || !allowed_model_for_method(&request.base_model_id, FoundryMethod::Weight)
    {
        return Err("The private resume record does not match this verified local job.".into());
    }
    let dataset = resume_dataset_path(&job_dir, &request.source_paths)?;
    let mut active = active_jobs()
        .lock()
        .map_err(|_| "Model Foundry active-job registry is unavailable.".to_string())?;
    if !active.insert(job.id.clone()) {
        return Err("This Model Foundry training job is already active.".into());
    }
    drop(active);
    let _ = fs::remove_file(job_dir.join("cancel.requested"));
    job.status = "queued".into();
    job.resume_available = false;
    job.error = None;
    job.updated_at = now();
    if let Err(error) = write_job(&job_path, &job) {
        if let Ok(mut active) = active_jobs().lock() {
            active.remove(&job.id);
        }
        return Err(error);
    }
    let worker_job = job.clone();
    let validation_dataset = if job_dir.join("validation-dataset.jsonl").is_file() {
        job_dir.join("validation-dataset.jsonl")
    } else {
        dataset.clone()
    };
    std::thread::spawn(move || {
        process_weight(
            app,
            request,
            dataset,
            validation_dataset,
            job_dir,
            worker_job,
            Some(checkpoint),
        )
    });
    Ok(job)
}

#[tauri::command]
pub fn model_foundry_retrain_artifact(
    app: tauri::AppHandle,
    job_id: String,
) -> Result<FoundryJob, String> {
    restart_job(app, job_id, true)
}

#[tauri::command]
pub fn model_foundry_delete_job(app: tauri::AppHandle, job_id: String) -> Result<(), String> {
    let job_id = validated_job_id(job_id.trim())?;
    let job_dir = foundry_root(&app)?.join("jobs").join(job_id);
    let job: FoundryJob = serde_json::from_slice(
        &fs::read(job_dir.join("job.json"))
            .map_err(|_| "Model Foundry job was not found.".to_string())?,
    )
    .map_err(|error| format!("Model Foundry job metadata is invalid: {error}"))?;
    if !matches!(job.status.as_str(), "completed" | "failed" | "cancelled") {
        return Err("Cancel the active Model Foundry job before deleting it.".into());
    }
    fs::remove_dir_all(&job_dir)
        .map_err(|error| format!("Could not delete the private Model Foundry job: {error}"))
}

#[tauri::command]
pub fn model_foundry_rename_artifact(
    app: tauri::AppHandle,
    job_id: String,
    name: String,
) -> Result<FoundryJob, String> {
    rename_artifact_from_root(&foundry_root(&app)?, &job_id, &name)
}

fn rename_artifact_from_root(
    protected_root: &Path,
    job_id: &str,
    name: &str,
) -> Result<FoundryJob, String> {
    use crate::model_foundry_training::{
        checked_export_source, verify_training_artifact_for_method,
    };
    let job_id = validated_job_id(job_id.trim())?;
    let name = name.trim();
    if name.is_empty() || name.chars().count() > 80 {
        return Err("Model name must contain 1 to 80 characters.".into());
    }
    let job_dir = checked_export_source(&protected_root.join("jobs").join(job_id), protected_root)?;
    let job_path = checked_export_source(&job_dir.join("job.json"), protected_root)?;
    let metadata = fs::metadata(&job_path)
        .map_err(|_| "Model Foundry job was not found.".to_string())?;
    if !metadata.is_file() || metadata.len() > 1024 * 1024 {
        return Err("Rename job metadata is not a bounded regular file.".into());
    }
    let mut job: FoundryJob = serde_json::from_slice(
        &fs::read(&job_path).map_err(|_| "Model Foundry job was not found.".to_string())?,
    )
    .map_err(|error| format!("Model Foundry job metadata is invalid: {error}"))?;
    if job.id != job_id || job.status != "completed" || !job.artifact_verified {
        return Err("Only a verified completed artifact can be renamed.".into());
    }
    let method = parsed_method(&job.method)?;
    let artifact_name = match method {
        FoundryMethod::Knowledge => "knowledge-artifact.json",
        FoundryMethod::Weight => "weight-artifact",
    };
    let artifact_path = checked_export_source(&job_dir.join(artifact_name), protected_root)?;
    let recorded_path = job.artifact_path.as_deref().ok_or("Rename artifact path is missing.")?;
    if checked_export_source(Path::new(recorded_path), protected_root)? != artifact_path {
        return Err("Rename artifact does not match its recorded job path.".into());
    }
    let expected_hash = job.artifact_sha256.as_deref()
        .filter(|value| is_sha256(value))
        .ok_or("Rename artifact has no recorded integrity hash.")?;
    match method {
        FoundryMethod::Knowledge => {
            let bytes = fs::read(&artifact_path)
                .map_err(|error| format!("Could not read artifact: {error}"))?;
            let mut artifact = validate_artifact_bytes(&bytes)?;
            if artifact.base_model_id != job.base_model_id
                || artifact.model_name != job.name
                || artifact.version != job.version
                || bytes.len() as u64 != job.storage_bytes
                || format!("{:x}", Sha256::digest(&bytes)) != expected_hash
            {
                return Err("Knowledge rename no longer matches its verified job.".into());
            }
            artifact.model_name = name.to_string();
            let renamed_bytes = serde_json::to_vec_pretty(&artifact)
                .map_err(|error| format!("Could not encode renamed artifact: {error}"))?;
            write_atomic(&artifact_path, &renamed_bytes)?;
            validate_artifact(&artifact_path)?;
            let bytes = fs::read(&artifact_path)
                .map_err(|error| format!("Could not reopen artifact: {error}"))?;
            job.artifact_sha256 = Some(format!("{:x}", Sha256::digest(&bytes)));
            job.storage_bytes = bytes.len() as u64;
        }
        FoundryMethod::Weight => {
            let evidence = verify_training_artifact_for_method(&artifact_path, &job.method)?;
            if evidence.sha256 != expected_hash || evidence.storage_bytes != job.storage_bytes {
                return Err("Weight rename no longer matches its verified job.".into());
            }
            // Names belong to the job/request, not the verified weight payload or manifest.
        }
    }
    job.name = name.to_string();
    job.updated_at = now();
    write_job(&job_path, &job)?;
    if let Ok(bytes) = fs::read(job_dir.join("request.json")) {
        if let Ok(mut request) = serde_json::from_slice::<StartRequest>(&bytes) {
            request.name = name.to_string();
            if let Ok(encoded) = serde_json::to_vec_pretty(&request) {
                let _ = write_atomic(&job_dir.join("request.json"), &encoded);
            }
        }
    }
    Ok(job)
}

#[tauri::command]
pub async fn model_foundry_duplicate_artifact(
    app: tauri::AppHandle,
    job_id: String,
    name: String,
) -> Result<FoundryJob, String> {
    tauri::async_runtime::spawn_blocking(move ||
        duplicate_artifact_with_root(&job_id, &name, || foundry_root(&app)))
        .await.map_err(|error| format!("Artifact duplication task could not finish: {error}"))?
}

fn duplicate_artifact_with_root(
    job_id: &str,
    name: &str,
    resolve_root: impl FnOnce() -> Result<PathBuf, String>,
) -> Result<FoundryJob, String> {
    validated_job_id(job_id.trim())?;
    let name = name.trim();
    if name.is_empty() || name.chars().count() > 80 {
        return Err("Model name must contain 1 to 80 characters.".into());
    }
    duplicate_artifact_controlled(&resolve_root()?, job_id, name, &format!("job_{}", nanoid::nanoid!(14)), |_, _| Ok(()))
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum DuplicatePoint { Created, PayloadCopied, ArtifactReady, BeforeRequestWrite, BeforeCommitRecord, BeforePublish, Cleanup }

fn read_duplicate_bytes(path: &Path, protected_root: &Path, limit: u64) -> Result<Vec<u8>, String> {
    let path = crate::model_foundry_training::checked_export_source(path, protected_root)?;
    let file = fs::File::open(path).map_err(|error| format!("Duplicate source is unavailable: {error}"))?;
    let metadata = file.metadata().map_err(|_| "Duplicate source metadata is unavailable.")?;
    if !metadata.is_file() || metadata.len() > limit { return Err("Duplicate source exceeds its bounded regular-file contract.".into()); }
    let mut bytes = Vec::new();
    file.take(limit + 1).read_to_end(&mut bytes).map_err(|error| format!("Could not read duplicate source: {error}"))?;
    if bytes.len() as u64 != metadata.len() || bytes.len() as u64 > limit { return Err("Duplicate source changed while reading.".into()); }
    Ok(bytes)
}

fn optional_duplicate_request(path: &Path, protected_root: &Path) -> Result<Option<Vec<u8>>, String> {
    match fs::symlink_metadata(path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("Could not inspect duplicate retry record: {error}")),
        Ok(_) => read_duplicate_bytes(path, protected_root, 64 * 1024 * 1024).map(Some),
    }
}

fn duplicate_artifact_controlled(
    protected_root: &Path, job_id: &str, name: &str, destination_id: &str,
    mut at: impl FnMut(DuplicatePoint, &Path) -> Result<(), String>,
) -> Result<FoundryJob, String> {
    use crate::model_foundry_training::{checked_export_source, prepare_verified_artifact_copy, PrivateDuplicate};
    let source_id = validated_job_id(job_id.trim())?;
    let name = name.trim();
    if name.is_empty() || name.chars().count() > 80 { return Err("Model name must contain 1 to 80 characters.".into()); }
    validated_job_id(destination_id)?;
    if destination_id == source_id { return Err("A duplicate requires its own job identity.".into()); }
    let source_dir = checked_export_source(&protected_root.join("jobs").join(source_id), protected_root)?;
    let job_path = source_dir.join("job.json");
    let job_bytes = read_duplicate_bytes(&job_path, protected_root, 1024 * 1024)?;
    let source_job: FoundryJob = serde_json::from_slice(&job_bytes)
        .map_err(|error| format!("Model Foundry job metadata is invalid: {error}"))?;
    if source_job.id != source_id || source_job.status != "completed" || !source_job.artifact_verified
        || source_job.version == 0 || source_job.name.trim().is_empty() || source_job.base_model_id.trim().is_empty() {
        return Err("Only the matching verified completed artifact can be duplicated.".into());
    }
    let method = parsed_method(&source_job.method)?;
    let artifact_name = if method == FoundryMethod::Knowledge { "knowledge-artifact.json" } else { "weight-artifact" };
    let artifact_path = checked_export_source(&source_dir.join(artifact_name), protected_root)?;
    let recorded_path = source_job.artifact_path.as_deref().ok_or("Duplicate artifact path is missing.")?;
    if checked_export_source(Path::new(recorded_path), protected_root)? != artifact_path {
        return Err("Duplicate artifact does not match its recorded job path.".into());
    }
    let expected_hash = source_job.artifact_sha256.as_deref().filter(|value| is_sha256(value))
        .ok_or("Duplicate artifact has no recorded integrity hash.")?;
    let mut knowledge_original = None;
    let mut knowledge_copy = None;
    let weights = if method == FoundryMethod::Weight {
        Some(prepare_verified_artifact_copy(&artifact_path, &source_job.method, expected_hash, source_job.storage_bytes, protected_root)?)
    } else {
        let bytes = read_duplicate_bytes(&artifact_path, protected_root, 64 * 1024 * 1024)?;
        let mut artifact = validate_artifact_bytes(&bytes)?;
        if artifact.base_model_id != source_job.base_model_id || artifact.model_name != source_job.name
            || artifact.version != source_job.version || artifact.source_count != source_job.source_count
            || bytes.len() as u64 != source_job.storage_bytes || format!("{:x}", Sha256::digest(&bytes)) != expected_hash {
            return Err("Knowledge duplicate no longer matches its verified job.".into());
        }
        artifact.model_name = name.to_owned(); artifact.version = 1;
        knowledge_copy = Some(serde_json::to_vec_pretty(&artifact).map_err(|error| format!("Could not encode duplicate artifact: {error}"))?);
        knowledge_original = Some(bytes);
        None
    };
    let request_path = source_dir.join("request.json");
    let original_request = optional_duplicate_request(&request_path, protected_root)?;
    let copied_request = if let Some(bytes) = &original_request {
        let request: StartRequest = serde_json::from_slice(bytes).map_err(|error| format!("Private duplicate retry record is invalid: {error}"))?;
        if !request.local_only || request.method != source_job.method || request.base_model_id != source_job.base_model_id
            || request.project_id != source_job.project_id || request.name != source_job.name
            || request.version.unwrap_or(1) != source_job.version || request.schema_version.is_some_and(|value| value != 2) {
            return Err("Private duplicate retry record does not match the source job.".into());
        }
        // Preserve compatible/future metadata rather than dropping unknown keys.
        let mut value: serde_json::Value = serde_json::from_slice(bytes).map_err(|_| "Private duplicate retry record is invalid.")?;
        value["name"] = name.into(); value["version"] = 1.into();
        Some(serde_json::to_vec_pretty(&value).map_err(|error| format!("Could not encode duplicate retry record: {error}"))?)
    } else { None };

    let mut copy = PrivateDuplicate::create(protected_root, destination_id)?;
    let destination = copy.root().to_path_buf();
    let result = (|| {
        at(DuplicatePoint::Created, &destination)?;
        let (sha256, storage_bytes) = if let Some(weights) = &weights {
            let evidence = copy.copy_weights(weights, |path| at(DuplicatePoint::PayloadCopied, path))?;
            (evidence.sha256, evidence.storage_bytes)
        } else {
            let bytes = knowledge_copy.as_deref().ok_or("Verified knowledge copy is missing.")?;
            copy.write_bytes(artifact_name, bytes)?;
            at(DuplicatePoint::PayloadCopied, &destination)?;
            let reopened = read_duplicate_bytes(&destination.join(artifact_name), protected_root, 64 * 1024 * 1024)?;
            validate_artifact_bytes(&reopened)?;
            if reopened != bytes { return Err("Knowledge duplicate changed after writing.".into()); }
            (format!("{:x}", Sha256::digest(&reopened)), reopened.len() as u64)
        };
        at(DuplicatePoint::ArtifactReady, &destination)?;
        if let Some(bytes) = &copied_request {
            at(DuplicatePoint::BeforeRequestWrite, &destination)?;
            copy.write_bytes("request.json", bytes)?;
        }
        let timestamp = now();
        let job = FoundryJob {
            id: destination_id.to_owned(), project_id: source_job.project_id.clone(), name: name.to_owned(),
            base_model_id: source_job.base_model_id.clone(), method: source_job.method.clone(), status: "completed".into(),
            progress: 100, artifact_path: Some(destination.join(artifact_name).to_string_lossy().into_owned()),
            artifact_verified: true, artifact_sha256: Some(sha256), storage_bytes, source_count: source_job.source_count,
            version: 1, resume_available: false, error: None, created_at: timestamp.clone(), updated_at: timestamp,
        };
        let encoded = serde_json::to_vec_pretty(&job).map_err(|error| format!("Could not encode duplicate job: {error}"))?;
        at(DuplicatePoint::BeforeCommitRecord, &destination)?;
        copy.commit(&encoded, || {
            at(DuplicatePoint::BeforePublish, &destination)?;
            if read_duplicate_bytes(&job_path, protected_root, 1024 * 1024)? != job_bytes
                || optional_duplicate_request(&request_path, protected_root)? != original_request {
                return Err("Source job or retry record changed during duplication.".into());
            }
            if let Some(weights) = &weights {
                weights.revalidate_source()?;
                let staged = crate::model_foundry_training::verify_training_artifact_for_method(&destination.join(artifact_name), &job.method)?;
                if Some(&staged.sha256) != job.artifact_sha256.as_ref() || staged.storage_bytes != job.storage_bytes {
                    return Err("Staged duplicate changed before publication.".into());
                }
            }
            if let Some(bytes) = &copied_request {
                if read_duplicate_bytes(&destination.join("request.json"), protected_root, 64 * 1024 * 1024)? != *bytes {
                    return Err("Staged retry record changed before publication.".into());
                }
            }
            if let Some(original) = &knowledge_original {
                if read_duplicate_bytes(&destination.join(artifact_name), protected_root, 64 * 1024 * 1024)?.as_slice()
                    != knowledge_copy.as_deref().ok_or("Verified knowledge copy is missing.")? {
                    return Err("Staged knowledge duplicate changed before publication.".into());
                }
                if read_duplicate_bytes(&artifact_path, protected_root, 64 * 1024 * 1024)? != *original {
                    return Err("Source knowledge artifact changed during duplication.".into());
                }
            }
            Ok(())
        })?;
        Ok(job)
    })();
    match result {
        Ok(job) => Ok(job),
        Err(error) => match copy.cleanup(|| at(DuplicatePoint::Cleanup, &destination)) {
            Ok(()) => Err(error),
            Err(cleanup) => Err(format!("{error} {cleanup}")),
        },
    }
}

#[tauri::command]
pub async fn model_foundry_export_artifact(
    app: tauri::AppHandle,
    job_id: String,
    destination: String,
) -> Result<(), String> {
    let job_id = validated_job_id(job_id.trim())?.to_owned();
    let root = foundry_root(&app)?;
    let job_dir = root.join("jobs").join(&job_id);
    tauri::async_runtime::spawn_blocking(move || {
        export_artifact_from_job_dir(&job_dir, &job_id, &destination, &root)
    })
    .await
    .map_err(|error| format!("Artifact export task could not finish: {error}"))?
}

fn export_artifact_from_job_dir(
    job_dir: &Path,
    job_id: &str,
    destination: &str,
    protected_root: &Path,
) -> Result<(), String> {
    use crate::model_foundry_training::{
        checked_export_source, export_knowledge_json, export_training_artifact,
    };
    validated_job_id(job_id)?;
    let expected_dir =
        checked_export_source(&protected_root.join("jobs").join(job_id), protected_root)?;
    if checked_export_source(job_dir, protected_root)? != expected_dir {
        return Err("Model Foundry export job escaped its private directory.".into());
    }
    let job_path = checked_export_source(&expected_dir.join("job.json"), protected_root)?;
    let metadata = fs::metadata(&job_path).map_err(|_| "Export job metadata is unavailable.")?;
    if !metadata.is_file() || metadata.len() > 1024 * 1024 {
        return Err("Export job metadata is not a bounded regular file.".into());
    }
    let job_bytes =
        fs::read(&job_path).map_err(|error| format!("Could not read export job: {error}"))?;
    let job: FoundryJob = serde_json::from_slice(&job_bytes)
        .map_err(|error| format!("Export job metadata is invalid: {error}"))?;
    if job.id != job_id || job.status != "completed" || !job.artifact_verified {
        return Err("Only completed, verified Model Foundry artifacts can be exported.".into());
    }
    let method = parsed_method(&job.method)?;
    let artifact_name = match method {
        FoundryMethod::Knowledge => "knowledge-artifact.json",
        FoundryMethod::Weight => "weight-artifact",
    };
    let artifact_path = checked_export_source(&expected_dir.join(artifact_name), protected_root)?;
    let recorded_path = job
        .artifact_path
        .as_deref()
        .ok_or("Export artifact path is missing.")?;
    if checked_export_source(Path::new(recorded_path), protected_root)? != artifact_path {
        return Err("Export artifact does not match its recorded job path.".into());
    }
    let expected_hash = job
        .artifact_sha256
        .as_deref()
        .filter(|value| is_sha256(value))
        .ok_or("Export artifact has no recorded integrity hash.")?;
    let still_current = || {
        checked_export_source(&job_path, protected_root)?;
        if fs::read(&job_path)
            .map_err(|error| format!("Could not revalidate export job: {error}"))?
            != job_bytes
        {
            return Err(
                "Model Foundry job changed during export; retry the current artifact.".into(),
            );
        }
        Ok(())
    };
    match method {
        FoundryMethod::Knowledge => {
            let bytes = fs::read(&artifact_path)
                .map_err(|error| format!("Could not read artifact: {error}"))?;
            let artifact = validate_artifact_bytes(&bytes)?;
            if artifact.base_model_id != job.base_model_id
                || artifact.model_name != job.name
                || artifact.version != job.version
                || bytes.len() as u64 != job.storage_bytes
                || format!("{:x}", Sha256::digest(&bytes)) != expected_hash
            {
                return Err("Knowledge export no longer matches its verified job.".into());
            }
            export_knowledge_json(
                &bytes,
                Path::new(destination),
                protected_root,
                still_current,
            )
        }
        FoundryMethod::Weight => export_training_artifact(
            &artifact_path,
            &job.method,
            expected_hash,
            job.storage_bytes,
            Path::new(destination),
            protected_root,
            still_current,
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn artifact_export_fixture(method: &str) -> (PathBuf, PathBuf, FoundryJob) {
        static SEQUENCE: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let suffix = SEQUENCE.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let root = std::env::temp_dir().join(format!(
            "vibespace-export-test-{}-{}-{suffix}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
        ));
        let job_dir = root.join("private/jobs/job_export");
        fs::create_dir_all(&job_dir).unwrap();
        let (artifact_path, artifact_sha256, storage_bytes) = if method == "knowledge" {
            let artifact = KnowledgeArtifact {
                schema_version: 1,
                version: 1,
                model_name: "Synthetic export".into(),
                description: "Synthetic test only".into(),
                purpose: "Test".into(),
                default_behavior: None,
                base_model_id: ALLOWED_MODELS[0].into(),
                processing: "local-rag-knowledge".into(),
                source_count: 1,
                sources: vec![],
                chunks: vec![KnowledgeChunk {
                    id: "chunk-1".into(),
                    source_name: "fixture.txt".into(),
                    source_anchor: None,
                    text: "Synthetic text".into(),
                    sha256: format!("{:x}", Sha256::digest(b"Synthetic text")),
                }],
            };
            let bytes = serde_json::to_vec(&artifact).unwrap();
            let path = job_dir.join("knowledge-artifact.json");
            fs::write(&path, &bytes).unwrap();
            (
                path,
                format!("{:x}", Sha256::digest(&bytes)),
                bytes.len() as u64,
            )
        } else {
            let path = job_dir.join("weight-artifact");
            fs::create_dir_all(&path).unwrap();
            fs::write(path.join("model.safetensors"), b"synthetic weights only").unwrap();
            fs::write(path.join("config.json"), b"{}").unwrap();
            let evidence =
                crate::model_foundry_training::write_and_verify_training_artifact(&path, method)
                    .unwrap();
            (path, evidence.sha256, evidence.storage_bytes)
        };
        let job = FoundryJob {
            id: "job_export".into(),
            project_id: Some("synthetic-project".into()),
            name: "Synthetic export".into(),
            base_model_id: ALLOWED_MODELS[0].into(),
            method: method.into(),
            status: "completed".into(),
            progress: 100,
            artifact_path: Some(artifact_path.to_string_lossy().into_owned()),
            artifact_verified: true,
            artifact_sha256: Some(artifact_sha256),
            storage_bytes,
            source_count: 1,
            version: 1,
            resume_available: false,
            error: None,
            created_at: "2026-10-07".into(),
            updated_at: "2026-10-07".into(),
        };
        fs::write(job_dir.join("job.json"), serde_json::to_vec(&job).unwrap()).unwrap();
        (root, job_dir, job)
    }

    #[test]
    fn weight_chat_response_serializes_verified_digest_instead_of_recorded_job_hash() {
        for method in ["full", "lora", "qlora"] {
            let (root, job_dir, mut job) = artifact_export_fixture(method);
            let evidence = crate::model_foundry_training::verify_training_artifact_for_method(
                &job_dir.join("weight-artifact"), method,
            ).unwrap();
            let verified_digest = evidence.sha256;
            job.artifact_sha256 = Some("f".repeat(64));
            let result = crate::model_foundry_training::FoundryInferenceResult {
                artifact_sha256: verified_digest.clone(), text: "Public synthetic answer.".into(),
                input_tokens: 7, output_tokens: 4,
            };
            let response = weight_chat_response(job.id.clone(), job, result);
            let value = serde_json::to_value(response).unwrap();
            assert_eq!(value["artifactSha256"], verified_digest);
            assert_ne!(value["artifactSha256"], "f".repeat(64));
            assert_eq!(value["artifactId"], "job_export");
            assert_eq!(value["method"], method);
            assert_eq!(value["version"], 1);
            assert_eq!(value["inputTokens"], 7);
            assert_eq!(value["outputTokens"], 4);
            assert!(value.get("artifact_sha256").is_none());
            fs::remove_dir_all(root).unwrap();
        }
    }

    #[test]
    fn weight_chat_response_keeps_immutable_digest_across_metadata_only_rename() {
        let (root, job_dir, job) = artifact_export_fixture("full");
        let evidence = crate::model_foundry_training::verify_training_artifact_for_method(
            &job_dir.join("weight-artifact"), "full",
        ).unwrap();
        let renamed = rename_artifact_from_root(&root.join("private"), &job.id, "New display name").unwrap();
        let result = crate::model_foundry_training::FoundryInferenceResult {
            artifact_sha256: evidence.sha256, text: "Public synthetic answer.".into(),
            input_tokens: 7, output_tokens: 4,
        };
        let response = weight_chat_response(job.id.clone(), job, result);
        assert_ne!(response.model_name, renamed.name);
        assert_eq!(Some(response.artifact_sha256), renamed.artifact_sha256);
        assert_eq!(response.artifact_id, renamed.id);
        assert_eq!(response.version, renamed.version);
        assert_eq!(response.method, renamed.method);
        fs::remove_dir_all(root).unwrap();
    }

    fn duplicate_request_fixture(job: &FoundryJob) -> serde_json::Value {
        serde_json::json!({"schemaVersion":2,"projectId":job.project_id,"name":job.name,
            "description":"Public synthetic metadata","purpose":"Test","instructions":null,
            "baseModelId":job.base_model_id,"method":job.method,"sourcePaths":[],"localOnly":true,
            "version":job.version,"datasetJsonl":"{\"prompt\":\"Public synthetic training input\",\"response\":\"Public synthetic answer\"}\n",
            "futureMetadata":{"fixture":true}})
    }

    #[test]
    fn artifact_duplicate_preserves_payloads_request_fields_and_independent_file_ownership() {
        for method in ["full", "lora", "qlora", "knowledge"] {
            let (root, source_dir, mut source) = artifact_export_fixture(method);
            if method != "knowledge" { source.version = 7; write_job(&source_dir.join("job.json"), &source).unwrap(); }
            let request = duplicate_request_fixture(&source);
            let request_bytes = serde_json::to_vec_pretty(&request).unwrap();
            fs::write(source_dir.join("request.json"), &request_bytes).unwrap();
            let job_bytes = fs::read(source_dir.join("job.json")).unwrap();
            let source_payload = if method == "knowledge" { "knowledge-artifact.json" } else { "weight-artifact/model.safetensors" };
            let payload_bytes = fs::read(source_dir.join(source_payload)).unwrap();
            let mut barriers = 0;
            let copy = duplicate_artifact_controlled(&root.join("private"), &source.id, "  独立 copy  ", "job_copy", |point, destination| {
                assert!(!destination.join("job.json").exists(), "publication happened before the final commit");
                if point == DuplicatePoint::BeforePublish { barriers += 1; }
                Ok(())
            }).unwrap();
            assert_eq!(barriers, 1); assert_eq!(copy.name, "独立 copy"); assert_eq!(copy.version, 1);
            assert_eq!(copy.project_id, source.project_id); assert_eq!(copy.base_model_id, source.base_model_id);
            let destination = root.join("private/jobs/job_copy");
            let mut expected_request = request.clone(); expected_request["name"] = "独立 copy".into(); expected_request["version"] = 1.into();
            assert_eq!(serde_json::from_slice::<serde_json::Value>(&fs::read(destination.join("request.json")).unwrap()).unwrap(), expected_request);
            assert_eq!(fs::read(source_dir.join("request.json")).unwrap(), request_bytes);
            assert_eq!(fs::read(source_dir.join("job.json")).unwrap(), job_bytes);
            if method != "knowledge" {
                assert_eq!(fs::read(destination.join("weight-artifact/.vibespace-artifact.json")).unwrap(), fs::read(source_dir.join("weight-artifact/.vibespace-artifact.json")).unwrap());
                assert_eq!(copy.artifact_sha256, source.artifact_sha256); assert_eq!(copy.storage_bytes, source.storage_bytes);
            } else {
                let bytes = fs::read(destination.join(source_payload)).unwrap();
                assert_eq!(bytes.len() as u64, copy.storage_bytes);
                assert_eq!(Some(format!("{:x}", Sha256::digest(&bytes))), copy.artifact_sha256);
            }
            #[cfg(target_os = "linux")]
            assert_eq!(fs::read(destination.join(".duplicate-commit.json")).unwrap(), fs::read(destination.join("job.json")).unwrap());
            #[cfg(target_os = "windows")]
            assert!(!destination.join(".duplicate-commit.json").exists());
            fs::write(destination.join(source_payload), b"changed independent copy only").unwrap();
            assert_eq!(fs::read(source_dir.join(source_payload)).unwrap(), payload_bytes);
            fs::remove_dir_all(root).unwrap();
        }
    }

    #[test]
    fn artifact_duplicate_rejects_job_identity_and_integrity_drift_before_creation() {
        for case in 0..13 {
            let (root, source_dir, mut source) = artifact_export_fixture("full");
            let source_id = source.id.clone();
            match case {
                0 => source.id = "job_another".into(),
                1 => source.status = "training".into(),
                2 => source.artifact_verified = false,
                3 => source.artifact_path = None,
                4 => source.artifact_path = Some(source_dir.to_string_lossy().into_owned()),
                5 => source.method = "unsupported".into(),
                6 => source.artifact_sha256 = None,
                7 => source.artifact_sha256 = Some("not-a-digest".into()),
                8 => source.artifact_sha256 = Some("f".repeat(64)),
                9 => source.storage_bytes += 1,
                10 => source.version = 0,
                11 => source.name.clear(),
                _ => fs::write(source_dir.join("weight-artifact/model.safetensors"), b"tampered source").unwrap(),
            }
            write_job(&source_dir.join("job.json"), &source).unwrap();
            let before = fs::read(source_dir.join("job.json")).unwrap();
            let payload = fs::read(source_dir.join("weight-artifact/model.safetensors")).unwrap();
            assert!(duplicate_artifact_controlled(&root.join("private"), &source_id, "Refused", "job_copy", |_, _| Ok(())).is_err(), "case {case}");
            assert!(!root.join("private/jobs/job_copy").exists());
            assert_eq!(fs::read(source_dir.join("job.json")).unwrap(), before);
            assert_eq!(fs::read(source_dir.join("weight-artifact/model.safetensors")).unwrap(), payload);
            fs::remove_dir_all(root).unwrap();
        }
    }

    #[test]
    fn artifact_duplicate_rejects_invalid_names_ids_and_bounded_metadata_before_creation() {
        let (root, source_dir, source) = artifact_export_fixture("full");
        for (id, name, destination) in [("../escape", "Copy", "job_copy"), (source.id.as_str(), "   ", "job_copy"),
            (source.id.as_str(), "Copy", source.id.as_str()), (source.id.as_str(), "Copy", "../escape")] {
            assert!(duplicate_artifact_controlled(&root.join("private"), id, name, destination, |_, _| Ok(())).is_err());
        }
        assert!(duplicate_artifact_controlled(&root.join("private"), &source.id, &"x".repeat(81), "job_copy", |_, _| Ok(())).is_err());
        for bytes in [b"invalid JSON".to_vec(), vec![b' '; 1024 * 1024 + 1]] {
            fs::write(source_dir.join("job.json"), &bytes).unwrap();
            assert!(duplicate_artifact_controlled(&root.join("private"), &source.id, "Copy", "job_copy", |_, _| Ok(())).is_err());
            assert_eq!(fs::read(source_dir.join("job.json")).unwrap(), bytes);
        }
        assert!(!root.join("private/jobs/job_copy").exists()); fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn artifact_duplicate_rejects_present_invalid_retry_records_but_preserves_missing_legacy() {
        let (root, source_dir, source) = artifact_export_fixture("full");
        let original = duplicate_request_fixture(&source);
        for (key, value) in [("method", serde_json::json!("lora")), ("localOnly", serde_json::json!(false)),
            ("baseModelId", serde_json::json!("different")), ("projectId", serde_json::json!("different")),
            ("name", serde_json::json!("different")), ("version", serde_json::json!(2)), ("schemaVersion", serde_json::json!(1))] {
            let mut changed = original.clone(); changed[key] = value;
            let bytes = serde_json::to_vec(&changed).unwrap(); fs::write(source_dir.join("request.json"), &bytes).unwrap();
            assert!(duplicate_artifact_controlled(&root.join("private"), &source.id, "Copy", "job_copy", |_, _| Ok(())).is_err());
            assert!(!root.join("private/jobs/job_copy").exists()); assert_eq!(fs::read(source_dir.join("request.json")).unwrap(), bytes);
        }
        fs::write(source_dir.join("request.json"), b"invalid JSON").unwrap();
        assert!(duplicate_artifact_controlled(&root.join("private"), &source.id, "Copy", "job_copy", |_, _| Ok(())).is_err());
        fs::OpenOptions::new().write(true).open(source_dir.join("request.json")).unwrap().set_len(64 * 1024 * 1024 + 1).unwrap();
        assert!(duplicate_artifact_controlled(&root.join("private"), &source.id, "Copy", "job_copy", |_, _| Ok(())).is_err());
        fs::remove_file(source_dir.join("request.json")).unwrap();
        duplicate_artifact_controlled(&root.join("private"), &source.id, "Legacy copy", "job_copy", |_, _| Ok(())).unwrap();
        assert!(!root.join("private/jobs/job_copy/request.json").exists()); fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn artifact_duplicate_all_precommit_faults_cleanup_owned_files_and_preserve_source() {
        for point in [DuplicatePoint::Created, DuplicatePoint::PayloadCopied, DuplicatePoint::ArtifactReady,
            DuplicatePoint::BeforeRequestWrite, DuplicatePoint::BeforeCommitRecord, DuplicatePoint::BeforePublish] {
            let (root, source_dir, source) = artifact_export_fixture("full");
            fs::write(source_dir.join("request.json"), serde_json::to_vec(&duplicate_request_fixture(&source)).unwrap()).unwrap();
            let before = fs::read(source_dir.join("job.json")).unwrap();
            let payload = fs::read(source_dir.join("weight-artifact/model.safetensors")).unwrap();
            let mut injected = 0; let mut cleanup = 0;
            let result = duplicate_artifact_controlled(&root.join("private"), &source.id, "Failed copy", "job_copy", |current, destination| {
                assert!(!destination.join("job.json").exists());
                if current == DuplicatePoint::Cleanup { cleanup += 1; }
                if current == point { injected += 1; return Err("injected copy failure".into()); } Ok(())
            });
            assert!(result.unwrap_err().contains("injected copy failure")); assert_eq!(injected, 1); assert_eq!(cleanup, 1);
            assert!(!root.join("private/jobs/job_copy").exists(), "fault {point:?}");
            assert_eq!(fs::read(source_dir.join("job.json")).unwrap(), before);
            assert_eq!(fs::read(source_dir.join("weight-artifact/model.safetensors")).unwrap(), payload);
            fs::remove_dir_all(root).unwrap();
        }
    }

    #[test]
    fn artifact_duplicate_source_changes_and_staged_tamper_prevent_publication() {
        for case in 0..4 {
            let (root, source_dir, source) = artifact_export_fixture("full");
            let result = duplicate_artifact_controlled(&root.join("private"), &source.id, "Stale copy", "job_copy", |point, destination| {
                if point == DuplicatePoint::BeforePublish {
                    match case {
                        0 => { let mut changed = source.clone(); changed.name = "Concurrent rename".into(); write_job(&source_dir.join("job.json"), &changed)?; }
                        1 => fs::write(source_dir.join("weight-artifact/model.safetensors"), b"source replaced").unwrap(),
                        2 => {
                            let result = fs::write(destination.join("weight-artifact/model.safetensors"), b"staged replaced");
                            #[cfg(target_os = "windows")]
                            { assert!(result.is_err()); return Err("retained staged file rejects foreign writers".into()); }
                            #[cfg(not(target_os = "windows"))]
                            result.unwrap();
                        }
                        _ => fs::write(source_dir.join("request.json"), serde_json::to_vec(&duplicate_request_fixture(&source)).unwrap()).unwrap(),
                    }
                } Ok(())
            });
            assert!(result.is_err(), "case {case}"); assert!(!root.join("private/jobs/job_copy").exists());
            fs::remove_dir_all(root).unwrap();
        }
    }

    #[test]
    fn artifact_duplicate_preserves_initial_and_late_destination_collisions() {
        let (root, source_dir, source) = artifact_export_fixture("full");
        let destination = root.join("private/jobs/job_copy");
        fs::create_dir(&destination).unwrap(); fs::write(destination.join("foreign"), b"collision winner").unwrap();
        assert!(duplicate_artifact_controlled(&root.join("private"), &source.id, "Copy", "job_copy", |_, _| Ok(())).is_err());
        assert_eq!(fs::read(destination.join("foreign")).unwrap(), b"collision winner");
        fs::remove_file(destination.join("foreign")).unwrap(); fs::remove_dir(&destination).unwrap();
        let source_before = fs::read(source_dir.join("job.json")).unwrap();
        let error = duplicate_artifact_controlled(&root.join("private"), &source.id, "Copy", "job_copy", |point, path| {
            if point == DuplicatePoint::BeforePublish { fs::write(path.join("job.json"), b"foreign collision winner").unwrap(); } Ok(())
        }).unwrap_err();
        assert!(error.contains("cleanup is pending"));
        assert_eq!(fs::read(destination.join("job.json")).unwrap(), b"foreign collision winner");
        assert_eq!(destination.read_dir().unwrap().count(), 1);
        assert_eq!(fs::read(source_dir.join("job.json")).unwrap(), source_before); fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn artifact_duplicate_cleanup_failure_is_truthful_and_next_explicit_copy_is_independent() {
        let (root, _, source) = artifact_export_fixture("full");
        let error = duplicate_artifact_controlled(&root.join("private"), &source.id, "Failed", "job_partial", |point, _| {
            if point == DuplicatePoint::PayloadCopied { return Err("injected copy failure".into()); }
            if point == DuplicatePoint::Cleanup { return Err("injected cleanup pending".into()); } Ok(())
        }).unwrap_err();
        assert!(error.contains("injected copy failure")); assert!(error.contains("cleanup pending"));
        assert!(!root.join("private/jobs/job_partial/job.json").exists());
        for id in ["job_fresh1", "job_fresh2"] {
            let copy = duplicate_artifact_controlled(&root.join("private"), &source.id, "Fresh explicit copy", id, |_, _| Ok(())).unwrap();
            assert_eq!(copy.id, id); assert_eq!(copy.artifact_sha256, source.artifact_sha256);
        }
        assert!(!root.join("private/jobs/job_partial/job.json").exists()); fs::remove_dir_all(root).unwrap();
    }

    fn assert_duplicate_copies_declared_artifact(method: &str) {
        let (root, job_dir, source) = artifact_export_fixture(method);
        let source_job_before = fs::read(job_dir.join("job.json")).unwrap();
        let artifact_name = if method == "knowledge" { "knowledge-artifact.json" } else { "weight-artifact/model.safetensors" };
        let source_payload_before = fs::read(job_dir.join(artifact_name)).unwrap();
        let result = duplicate_artifact_with_root(&source.id, "Independent synthetic copy", || Ok(root.join("private")));
        assert_eq!(fs::read(job_dir.join("job.json")).unwrap(), source_job_before);
        assert_eq!(fs::read(job_dir.join(artifact_name)).unwrap(), source_payload_before);
        if let Ok(copy) = &result {
            assert_ne!(copy.id, source.id);
            assert_eq!(copy.name, "Independent synthetic copy");
            assert_eq!(copy.method, source.method);
            assert_eq!(copy.base_model_id, source.base_model_id);
            assert_eq!(copy.project_id, source.project_id);
            assert_eq!(copy.status, "completed");
            assert!(copy.artifact_verified);
            let copy_path = PathBuf::from(copy.artifact_path.as_ref().unwrap()).canonicalize().unwrap();
            let source_path = PathBuf::from(source.artifact_path.as_ref().unwrap()).canonicalize().unwrap();
            let expected_directory = root.join("private/jobs").join(&copy.id).canonicalize().unwrap();
            assert_ne!(copy_path, source_path);
            assert!(copy_path.starts_with(&expected_directory));
            let expected_artifact = if method == "knowledge" { "knowledge-artifact.json" } else { "weight-artifact" };
            assert_eq!(copy_path, expected_directory.join(expected_artifact).canonicalize().unwrap());
            if method == "knowledge" {
                assert_eq!(validate_artifact(&copy_path).unwrap().model_name, copy.name);
            } else {
                assert_eq!(fs::read(copy_path.join("model.safetensors")).unwrap(), source_payload_before);
                let evidence = crate::model_foundry_training::verify_training_artifact_for_method(&copy_path, method).unwrap();
                assert_eq!(Some(evidence.sha256), copy.artifact_sha256);
                assert_eq!(evidence.storage_bytes, copy.storage_bytes);
                assert_eq!(copy.artifact_sha256, source.artifact_sha256);
            }
        }
        fs::remove_dir_all(root).unwrap();
        result.expect("Duplicate should copy its declared verified artifact method");
    }

    #[test]
    fn artifact_duplicate_full_uses_weight_directory_without_mutating_source() {
        assert_duplicate_copies_declared_artifact("full");
    }

    #[test]
    fn artifact_duplicate_lora_uses_weight_directory_without_mutating_source() {
        assert_duplicate_copies_declared_artifact("lora");
    }

    #[test]
    fn artifact_duplicate_qlora_uses_weight_directory_without_mutating_source() {
        assert_duplicate_copies_declared_artifact("qlora");
    }

    #[test]
    fn artifact_duplicate_knowledge_retains_its_existing_method_route() {
        assert_duplicate_copies_declared_artifact("knowledge");
    }

    fn assert_weight_rename_preserves_payload(method: &str) {
        let (root, job_dir, job) = artifact_export_fixture(method);
        let artifact = job_dir.join("weight-artifact");
        let weights_before = fs::read(artifact.join("model.safetensors")).unwrap();
        let manifest_before = fs::read(artifact.join(".vibespace-artifact.json")).unwrap();
        let renamed = rename_artifact_from_root(&root.join("private"), &job.id, "  Renamed café model  ").unwrap();
        assert_eq!(renamed.name, "Renamed café model");
        assert_eq!(renamed.id, job.id); assert_eq!(renamed.project_id, job.project_id);
        assert_eq!(renamed.method, job.method); assert_eq!(renamed.base_model_id, job.base_model_id);
        assert_eq!(renamed.version, job.version); assert_eq!(renamed.artifact_path, job.artifact_path);
        assert_eq!(renamed.artifact_sha256, job.artifact_sha256); assert_eq!(renamed.storage_bytes, job.storage_bytes);
        assert_eq!(fs::read(artifact.join("model.safetensors")).unwrap(), weights_before);
        assert_eq!(fs::read(artifact.join(".vibespace-artifact.json")).unwrap(), manifest_before);
        assert!(!job_dir.join("knowledge-artifact.json").exists());
        let saved: FoundryJob = serde_json::from_slice(&fs::read(job_dir.join("job.json")).unwrap()).unwrap();
        assert_eq!(saved.name, renamed.name);
        let evidence = crate::model_foundry_training::verify_training_artifact(&artifact).unwrap();
        assert_eq!(Some(evidence.sha256), job.artifact_sha256);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn artifact_rename_full_preserves_verified_payload() { assert_weight_rename_preserves_payload("full"); }
    #[test]
    fn artifact_rename_lora_preserves_verified_payload() { assert_weight_rename_preserves_payload("lora"); }
    #[test]
    fn artifact_rename_qlora_preserves_verified_payload() { assert_weight_rename_preserves_payload("qlora"); }

    #[test]
    fn artifact_rename_knowledge_synchronizes_recorded_bytes() {
        let (root, job_dir, job) = artifact_export_fixture("knowledge");
        let renamed = rename_artifact_from_root(&root.join("private"), &job.id,
            "A different and longer knowledge label").unwrap();
        let bytes = fs::read(job_dir.join("knowledge-artifact.json")).unwrap();
        assert_eq!(renamed.storage_bytes, bytes.len() as u64);
        assert_eq!(renamed.artifact_sha256, Some(format!("{:x}", Sha256::digest(&bytes))));
        assert_eq!(validate_artifact_bytes(&bytes).unwrap().model_name, renamed.name);
        assert_eq!(renamed.version, job.version); assert_eq!(renamed.base_model_id, job.base_model_id);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn artifact_rename_knowledge_can_export_the_renamed_artifact() {
        let (root, job_dir, job) = artifact_export_fixture("knowledge");
        let renamed = rename_artifact_from_root(&root.join("private"), &job.id,
            "Knowledge renamed for export").unwrap();
        let destination = root.join("renamed.json");
        export_artifact_from_job_dir(&job_dir, &job.id, destination.to_str().unwrap(), &root.join("private")).unwrap();
        let artifact = validate_artifact(&destination).unwrap();
        assert_eq!(artifact.model_name, renamed.name);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn artifact_rename_rejects_stale_or_unverified_weight_identity_without_writing() {
        for boundary in ["id", "hash", "bytes", "method", "unfinished", "unverified"] {
            let (root, job_dir, mut job) = artifact_export_fixture("full");
            match boundary {
                "id" => job.id = "job_wrong".into(),
                "hash" => job.artifact_sha256 = Some("0".repeat(64)),
                "bytes" => job.storage_bytes += 1,
                "method" => job.method = "lora".into(),
                "unfinished" => job.status = "training".into(),
                "unverified" => job.artifact_verified = false,
                _ => unreachable!(),
            }
            write_job(&job_dir.join("job.json"), &job).unwrap();
            let before = fs::read(job_dir.join("job.json")).unwrap();
            let manifest = fs::read(job_dir.join("weight-artifact/.vibespace-artifact.json")).unwrap();
            assert!(rename_artifact_from_root(&root.join("private"), "job_export", "Refused rename").is_err(), "{boundary}");
            assert_eq!(fs::read(job_dir.join("job.json")).unwrap(), before, "{boundary}");
            assert_eq!(fs::read(job_dir.join("weight-artifact/.vibespace-artifact.json")).unwrap(), manifest, "{boundary}");
            fs::remove_dir_all(root).unwrap();
        }
    }

    #[test]
    fn artifact_rename_rejects_tampered_weights_and_foreign_recorded_paths() {
        for foreign_path in [false, true] {
            let (root, job_dir, mut job) = artifact_export_fixture("full");
            if foreign_path {
                let other = root.join("private/jobs/job_other/weight-artifact");
                fs::create_dir_all(&other).unwrap();
                fs::write(other.join("model.safetensors"), b"synthetic weights only").unwrap();
                fs::write(other.join("config.json"), b"{}").unwrap();
                crate::model_foundry_training::write_and_verify_training_artifact(&other, "full").unwrap();
                job.artifact_path = Some(other.to_string_lossy().into_owned());
                write_job(&job_dir.join("job.json"), &job).unwrap();
            } else {
                fs::write(job_dir.join("weight-artifact/model.safetensors"), b"tampered fixture").unwrap();
            }
            let before = fs::read(job_dir.join("job.json")).unwrap();
            assert!(rename_artifact_from_root(&root.join("private"), &job.id, "Refused rename").is_err());
            assert_eq!(fs::read(job_dir.join("job.json")).unwrap(), before);
            fs::remove_dir_all(root).unwrap();
        }
    }

    #[test]
    fn artifact_rename_refuses_invalid_names_and_oversized_job_metadata() {
        let (root, job_dir, job) = artifact_export_fixture("full");
        let before = fs::read(job_dir.join("job.json")).unwrap();
        for name in ["   ".to_string(), "x".repeat(81)] {
            assert!(rename_artifact_from_root(&root.join("private"), &job.id, &name).is_err());
            assert_eq!(fs::read(job_dir.join("job.json")).unwrap(), before);
        }
        let oversized = vec![b' '; 1024 * 1024 + 1];
        fs::write(job_dir.join("job.json"), &oversized).unwrap();
        assert!(rename_artifact_from_root(&root.join("private"), &job.id, "Refused rename").is_err());
        assert_eq!(fs::read(job_dir.join("job.json")).unwrap(), oversized);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn artifact_rename_weight_job_write_failure_never_mutates_verified_payload() {
        let (root, job_dir, job) = artifact_export_fixture("full");
        let job_before = fs::read(job_dir.join("job.json")).unwrap();
        let manifest_before = fs::read(job_dir.join("weight-artifact/.vibespace-artifact.json")).unwrap();
        fs::create_dir(job_dir.join("job.json.tmp")).unwrap();
        let error = rename_artifact_from_root(&root.join("private"), &job.id, "Cannot be committed").unwrap_err();
        assert!(error.contains("persist training job"), "{error}");
        assert_eq!(fs::read(job_dir.join("job.json")).unwrap(), job_before);
        assert_eq!(fs::read(job_dir.join("weight-artifact/.vibespace-artifact.json")).unwrap(), manifest_before);
        assert_eq!(fs::read(job_dir.join("weight-artifact/model.safetensors")).unwrap(), b"synthetic weights only");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn artifact_rename_preserves_optional_request_compatibility() {
        for malformed in [false, true] {
            let (root, job_dir, job) = artifact_export_fixture("full");
            let path = job_dir.join("request.json");
            if malformed { fs::write(&path, b"legacy unreadable request").unwrap(); }
            else {
                let mut request = reviewed_inline_request();
                request.name = job.name.clone(); request.method = job.method.clone();
                request.base_model_id = job.base_model_id.clone();
                fs::write(&path, serde_json::to_vec_pretty(&request).unwrap()).unwrap();
            }
            let renamed = rename_artifact_from_root(&root.join("private"), &job.id, "Renamed optional request").unwrap();
            assert_eq!(renamed.name, "Renamed optional request");
            if malformed { assert_eq!(fs::read(path).unwrap(), b"legacy unreadable request"); }
            else {
                let request: StartRequest = serde_json::from_slice(&fs::read(path).unwrap()).unwrap();
                assert_eq!(request.name, renamed.name);
                assert_eq!(request.method, job.method); assert_eq!(request.base_model_id, job.base_model_id);
                assert_eq!(request.dataset_fingerprint.as_deref(), Some("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"));
            }
            fs::remove_dir_all(root).unwrap();
        }
    }

    #[test]
    fn artifact_export_knowledge_preserves_exact_json() {
        let (root, job_dir, job) = artifact_export_fixture("knowledge");
        let destination = root.join("knowledge.json");
        let before = fs::read(job_dir.join("knowledge-artifact.json")).unwrap();
        export_artifact_from_job_dir(
            &job_dir,
            &job.id,
            destination.to_str().unwrap(),
            &root.join("private"),
        )
        .unwrap();
        assert_eq!(fs::read(&destination).unwrap(), before);
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(any(target_os = "linux", target_os = "windows"))]
    #[test]
    fn artifact_export_weight_does_not_require_a_knowledge_artifact() {
        let (root, job_dir, job) = artifact_export_fixture("full");
        let destination = root.join("weight.zip");
        assert!(!job_dir.join("knowledge-artifact.json").exists());
        let result = export_artifact_from_job_dir(
            &job_dir,
            &job.id,
            destination.to_str().unwrap(),
            &root.join("private"),
        );
        // Always release the synthetic fixture even when the baseline expectation fails.
        let exists = destination.is_file();
        fs::remove_dir_all(root).unwrap();
        assert!(result.is_ok(), "Verified weight export failed: {result:?}");
        assert!(exists);
    }

    #[cfg(any(target_os = "linux", target_os = "windows"))]
    #[test]
    fn artifact_export_weight_archives_are_exact_and_deterministic() {
        use std::io::Read;
        for method in ["full", "lora", "qlora"] {
            let (root, job_dir, job) = artifact_export_fixture(method);
            let destination = root.join("first.zip");
            let second = root.join("second.zip");
            for path in [&destination, &second] {
                export_artifact_from_job_dir(
                    &job_dir,
                    &job.id,
                    path.to_str().unwrap(),
                    &root.join("private"),
                )
                .unwrap();
            }
            assert_eq!(fs::read(&destination).unwrap(), fs::read(second).unwrap());
            let mut archive = zip::ZipArchive::new(fs::File::open(destination).unwrap()).unwrap();
            assert_eq!(archive.len(), 3);
            for (index, name) in [
                ".vibespace-artifact.json",
                "config.json",
                "model.safetensors",
            ]
            .iter()
            .enumerate()
            {
                let mut member = archive.by_index(index).unwrap();
                assert_eq!(member.name(), *name);
                let mut bytes = Vec::new();
                member.read_to_end(&mut bytes).unwrap();
                assert_eq!(
                    bytes,
                    fs::read(job_dir.join("weight-artifact").join(name)).unwrap()
                );
            }
            assert!(!root.read_dir().unwrap().any(|entry| entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .starts_with(".vibespace-export-")));
            fs::remove_dir_all(root).unwrap();
        }
    }

    #[cfg(any(target_os = "linux", target_os = "windows"))]
    #[test]
    fn artifact_export_rejects_stale_foreign_or_unverified_job_records() {
        for case in [
            "foreign-id",
            "running",
            "unverified",
            "foreign-path",
            "hash",
            "size",
            "method",
            "missing",
        ] {
            let (root, job_dir, mut job) = artifact_export_fixture("full");
            match case {
                "foreign-id" => job.id = "job_foreign".into(),
                "running" => job.status = "running".into(),
                "unverified" => job.artifact_verified = false,
                "foreign-path" => job.artifact_path = Some(root.to_string_lossy().into_owned()),
                "hash" => job.artifact_sha256 = Some("0".repeat(64)),
                "size" => job.storage_bytes += 1,
                "method" => job.method = "lora".into(),
                "missing" => {
                    fs::remove_file(job_dir.join("weight-artifact/model.safetensors")).unwrap();
                }
                _ => unreachable!(),
            }
            fs::write(job_dir.join("job.json"), serde_json::to_vec(&job).unwrap()).unwrap();
            let destination = root.join("rejected.zip");
            assert!(
                export_artifact_from_job_dir(
                    &job_dir,
                    "job_export",
                    destination.to_str().unwrap(),
                    &root.join("private")
                )
                .is_err(),
                "{case}"
            );
            assert!(!destination.exists(), "{case}");
            fs::remove_dir_all(root).unwrap();
        }
    }

    #[test]
    fn artifact_export_rejects_changed_knowledge_bytes_and_wrong_destination() {
        for case in ["metadata", "tamper", "extension", "existing", "private"] {
            let (root, job_dir, mut job) = artifact_export_fixture("knowledge");
            let mut destination = root.join("rejected.json");
            match case {
                "metadata" => job.name = "Other model".into(),
                "tamper" => {
                    fs::write(job_dir.join("knowledge-artifact.json"), b"{}").unwrap();
                }
                "extension" => destination = root.join("wrong.zip"),
                "existing" => fs::write(&destination, b"unrelated user file").unwrap(),
                "private" => destination = root.join("private/export.json"),
                _ => unreachable!(),
            }
            fs::write(job_dir.join("job.json"), serde_json::to_vec(&job).unwrap()).unwrap();
            assert!(
                export_artifact_from_job_dir(
                    &job_dir,
                    &job.id,
                    destination.to_str().unwrap(),
                    &root.join("private")
                )
                .is_err(),
                "{case}"
            );
            if case == "existing" {
                assert_eq!(fs::read(&destination).unwrap(), b"unrelated user file");
            } else {
                assert!(!destination.exists(), "{case}");
            }
            fs::remove_dir_all(root).unwrap();
        }
    }

    #[test]
    fn hardware_probe_uses_configured_storage_root_for_disk_measurement() {
        let data_dir = PathBuf::from(r"C:\Users\test\AppData");
        let configured_root = PathBuf::from(r"D:\VibeSpace-Model-Foundry");

        assert_eq!(
            selected_foundry_storage_root(&data_dir, Some(configured_root.clone())),
            configured_root
        );
        assert_eq!(
            selected_foundry_storage_root(&data_dir, None),
            data_dir.join("model-foundry")
        );
    }

    #[test]
    fn disk_probe_walks_to_an_existing_ancestor_for_a_new_storage_root() {
        let existing_root =
            std::env::temp_dir().join(format!("vibespace-foundry-probe-{}", nanoid::nanoid!()));
        fs::create_dir_all(&existing_root).unwrap();
        let planned_root = existing_root.join("planned").join("nested");

        assert_eq!(
            nearest_existing_storage_probe_path(&planned_root),
            existing_root
        );
        assert!(!planned_root.exists());
        let _ = fs::remove_dir_all(existing_root);
    }

    #[test]
    fn resume_prefers_private_prepared_dataset_for_raw_source_requests() {
        let root =
            std::env::temp_dir().join(format!("vibespace-foundry-resume-{}", nanoid::nanoid!()));
        fs::create_dir_all(&root).unwrap();
        let dataset = root.join("dataset.jsonl");
        let raw_source = root.join("source.txt");
        fs::write(&dataset, b"{\"text\":\"prepared\"}\n").unwrap();
        fs::write(&raw_source, b"raw source").unwrap();

        let resumed =
            resume_dataset_path(&root, &[raw_source.to_string_lossy().into_owned()]).unwrap();
        assert_eq!(resumed, fs::canonicalize(dataset).unwrap());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn resume_rejects_non_jsonl_source_when_private_dataset_is_missing() {
        let root =
            std::env::temp_dir().join(format!("vibespace-foundry-resume-{}", nanoid::nanoid!()));
        fs::create_dir_all(&root).unwrap();
        let raw_source = root.join("source.txt");
        fs::write(&raw_source, b"raw source").unwrap();

        let error =
            resume_dataset_path(&root, &[raw_source.to_string_lossy().into_owned()]).unwrap_err();
        assert_eq!(
            error,
            "The private resume dataset is unavailable or invalid."
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn resume_rejects_private_dataset_that_is_not_a_regular_file() {
        let root =
            std::env::temp_dir().join(format!("vibespace-foundry-resume-{}", nanoid::nanoid!()));
        fs::create_dir_all(root.join("dataset.jsonl")).unwrap();

        let error = resume_dataset_path(&root, &[]).unwrap_err();
        assert!(error.contains("not a regular file"));
        let _ = fs::remove_dir_all(root);
    }

    fn minimal_pdf_with_text(text: &str) -> Vec<u8> {
        let stream = format!("BT /F1 18 Tf 72 720 Td ({text}) Tj ET");
        let objects = [
            "<< /Type /Catalog /Pages 2 0 R >>".to_string(),
            "<< /Type /Pages /Kids [3 0 R] /Count 1 >>".to_string(),
            "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>".to_string(),
            "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>".to_string(),
            format!("<< /Length {} >>\nstream\n{stream}\nendstream", stream.len()),
        ];
        let mut pdf = b"%PDF-1.4\n".to_vec();
        let mut offsets = vec![0usize];
        for (index, object) in objects.iter().enumerate() {
            offsets.push(pdf.len());
            pdf.extend_from_slice(format!("{} 0 obj\n{}\nendobj\n", index + 1, object).as_bytes());
        }
        let xref = pdf.len();
        pdf.extend_from_slice(format!("xref\n0 {}\n", objects.len() + 1).as_bytes());
        pdf.extend_from_slice(b"0000000000 65535 f \n");
        for offset in offsets.into_iter().skip(1) {
            pdf.extend_from_slice(format!("{offset:010} 00000 n \n").as_bytes());
        }
        pdf.extend_from_slice(
            format!(
                "trailer\n<< /Size {} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n",
                objects.len() + 1
            )
            .as_bytes(),
        );
        pdf
    }

    #[test]
    fn extracts_bounded_pdf_text_with_page_provenance() {
        let bytes = minimal_pdf_with_text("Model Foundry reads PDF text locally");
        let text = extract_pdf_text(Path::new("manual.pdf"), &bytes).unwrap();
        assert!(text.contains("PDF page 1"));
        assert!(text.contains("Model Foundry reads PDF text locally"));
        assert!(extract_pdf_text(Path::new("broken.pdf"), b"not a pdf").is_err());
        let secret = minimal_pdf_with_text("sk-examplecredentialvalue123456789");
        assert!(prepare_source_text(Path::new("secret.pdf"), &secret)
            .unwrap_err()
            .contains("credential"));
    }

    #[test]
    fn media_uses_a_distinct_bounded_large_source_limit() {
        assert_eq!(source_size_limit("txt"), 64 * 1024 * 1024);
        assert_eq!(source_size_limit("pdf"), 64 * 1024 * 1024);
        assert_eq!(source_size_limit("mp3"), 2 * 1024 * 1024 * 1024);
        assert_eq!(source_size_limit("mp4"), 2 * 1024 * 1024 * 1024);
        assert!(!is_media_extension("png"));
        assert!(validate_source_size(
            Path::new("oversized.mp4"),
            "mp4",
            MAX_MEDIA_SOURCE_BYTES + 1
        )
        .unwrap_err()
        .contains("2 GB media"));
    }

    #[test]
    fn streams_source_hash_without_loading_the_whole_file() {
        let root = std::env::temp_dir().join(format!(
            "vibespace-foundry-stream-hash-{}",
            nanoid::nanoid!()
        ));
        fs::create_dir_all(&root).unwrap();
        let path = root.join("recording.mp4");
        let bytes = b"bounded local media provenance".repeat(8_192);
        fs::write(&path, &bytes).unwrap();
        assert_eq!(
            stream_file_sha256(&path).unwrap(),
            format!("{:x}", Sha256::digest(&bytes))
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn storage_selection_accepts_local_drives_and_rejects_network_roots() {
        assert_eq!(
            normalize_requested_storage_root(Path::new(r"D:\")).unwrap(),
            PathBuf::from(r"D:\VibeSpace-Model-Foundry")
        );
        assert_eq!(
            normalize_requested_storage_root(Path::new(r"D:\AI Models")).unwrap(),
            PathBuf::from(r"D:\AI Models\VibeSpace-Model-Foundry")
        );
        assert!(normalize_requested_storage_root(Path::new(r"\\server\models")).is_err());
        assert!(normalize_requested_storage_root(Path::new(r"relative\models")).is_err());
        assert!(storage_paths_equal(
            Path::new(r"D:\VibeSpace-Model-Foundry"),
            Path::new(r"d:\vibespace-model-foundry\")
        ));
    }

    #[test]
    fn storage_copy_preserves_nested_bytes_and_hashes() {
        let root = std::env::temp_dir().join(format!(
            "vibespace-foundry-storage-copy-{}",
            nanoid::nanoid!()
        ));
        let source = root.join("source");
        let target = root.join("target");
        fs::create_dir_all(source.join("nested")).unwrap();
        fs::create_dir_all(&target).unwrap();
        fs::write(source.join("model.bin"), b"verified-model").unwrap();
        fs::write(source.join("nested").join("job.json"), b"verified-job").unwrap();

        copy_storage_files(&source, Path::new(""), &target).unwrap();

        assert_eq!(
            fs::read(target.join("model.bin")).unwrap(),
            b"verified-model"
        );
        assert_eq!(
            fs::read(target.join("nested").join("job.json")).unwrap(),
            b"verified-job"
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn storage_copy_preserves_existing_managed_runtime_bytes() {
        let root = std::env::temp_dir().join(format!(
            "vibespace-foundry-storage-preserve-{}",
            nanoid::nanoid!()
        ));
        let source = root.join("source");
        let target = root.join("target");
        fs::create_dir_all(source.join("training-runtime")).unwrap();
        fs::create_dir_all(target.join("training-runtime")).unwrap();
        fs::write(
            source.join("training-runtime").join("worker.py"),
            b"embedded-worker-source",
        )
        .unwrap();
        fs::write(
            source
                .join("training-runtime")
                .join("source-only-package.dist-info"),
            b"incompatible-source-environment",
        )
        .unwrap();
        fs::write(
            target.join("training-runtime").join("worker.py"),
            b"verified-gpu-runtime",
        )
        .unwrap();

        copy_storage_files(&source, Path::new(""), &target).unwrap();

        assert_eq!(
            fs::read(target.join("training-runtime").join("worker.py")).unwrap(),
            b"verified-gpu-runtime"
        );
        assert!(!target
            .join("training-runtime")
            .join("source-only-package.dist-info")
            .exists());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn storage_copy_rejects_conflicting_existing_artifact_bytes() {
        let root = std::env::temp_dir().join(format!(
            "vibespace-foundry-storage-conflict-{}",
            nanoid::nanoid!()
        ));
        let source = root.join("source");
        let target = root.join("target");
        fs::create_dir_all(source.join("base-models")).unwrap();
        fs::create_dir_all(target.join("base-models")).unwrap();
        fs::write(
            source.join("base-models").join("model.safetensors"),
            b"source-artifact",
        )
        .unwrap();
        fs::write(
            target.join("base-models").join("model.safetensors"),
            b"verified-target-artifact",
        )
        .unwrap();

        let error = copy_storage_files(&source, Path::new(""), &target).unwrap_err();

        assert!(error.contains("conflicts"));
        assert_eq!(
            fs::read(target.join("base-models").join("model.safetensors")).unwrap(),
            b"verified-target-artifact"
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn parses_nvidia_smi_memory_without_trusting_wmi_adapter_ram() {
        let parsed = parse_nvidia_smi_csv("NVIDIA GeForce RTX 4050 Laptop GPU, 6141\r\n")
            .expect("valid nvidia-smi output");
        assert_eq!(parsed.0, "NVIDIA GeForce RTX 4050 Laptop GPU");
        assert!((parsed.1 - 5.997).abs() < 0.01);
        assert!(parse_nvidia_smi_csv("not a device").is_none());
    }

    #[test]
    fn weight_training_preflight_fails_closed_on_storage_and_cuda_vram() {
        let qlora = weight_training_requirements("qlora", 1.5);
        assert_eq!(qlora.vram_gb, 6.0);
        assert_eq!(qlora.ram_gb, 18.0);
        assert_eq!(qlora.storage_gb, 12.0);
        let mut hardware = FoundryHardwareProfile {
            cpu: "test".into(),
            gpu: Some("test GPU".into()),
            ram_gb: 64.0,
            vram_gb: 5.9,
            free_storage_gb: 100.0,
            os: "test".into(),
            accelerators: vec!["CUDA".into()],
            storage_root: "C:\\Foundry".into(),
            recommended_storage_root: Some("D:\\Foundry".into()),
        };
        assert!(validate_weight_hardware("qlora", "gpu", &hardware, qlora)
            .unwrap_err()
            .contains("CUDA VRAM"));
        hardware.vram_gb = 5.997;
        hardware.free_storage_gb = 11.9;
        assert!(validate_weight_hardware("qlora", "gpu", &hardware, qlora)
            .unwrap_err()
            .contains("managed storage"));
        hardware.free_storage_gb = 12.0;
        validate_weight_hardware("qlora", "gpu", &hardware, qlora).unwrap();
    }

    #[test]
    fn smallest_full_model_fits_cpu_without_weakening_larger_model_limits() {
        let small = weight_training_requirements("full", 0.135);
        assert_eq!(small.ram_gb, 8.0);
        let mut hardware = FoundryHardwareProfile {
            cpu: "test".into(),
            gpu: None,
            ram_gb: 16.0,
            vram_gb: 0.0,
            free_storage_gb: 6.0,
            os: "test".into(),
            accelerators: vec![],
            storage_root: "D:\\Foundry".into(),
            recommended_storage_root: None,
        };
        validate_weight_hardware("full", "cpu", &hardware, small).unwrap();
        hardware.ram_gb = 7.0;
        assert!(validate_weight_hardware("full", "cpu", &hardware, small).is_err());
        hardware.ram_gb = 16.0;
        hardware.free_storage_gb = 5.0;
        assert!(validate_weight_hardware("full", "cpu", &hardware, small).is_err());
        let large = weight_training_requirements("full", 7.0);
        assert_eq!(large.ram_gb, 224.0);
        assert_eq!(large.storage_gb, 280.0);
    }

    #[test]
    fn gpu_requests_never_use_system_ram_as_a_training_fallback() {
        let requirements = weight_training_requirements("full", 0.135);
        let hardware = FoundryHardwareProfile {
            cpu: "test".into(),
            gpu: None,
            ram_gb: 64.0,
            vram_gb: 0.0,
            free_storage_gb: 100.0,
            os: "test".into(),
            accelerators: vec![],
            storage_root: "D:\\Foundry".into(),
            recommended_storage_root: None,
        };
        let error = validate_weight_hardware("full", "gpu", &hardware, requirements)
            .expect_err("GPU-only requests must fail without CUDA VRAM");
        assert!(error.contains("GPU-only"));
        assert!(error.contains("VRAM"));
    }

    #[test]
    fn creates_a_deterministic_separate_validation_split_for_local_jsonl() {
        let root =
            std::env::temp_dir().join(format!("vibespace-foundry-split-{}", nanoid::nanoid!()));
        fs::create_dir_all(&root).unwrap();
        let dataset = root.join("dataset.jsonl");
        fs::write(
            &dataset,
            (0..10)
                .map(|index| {
                    serde_json::json!({
                        "prompt": format!("Prompt {index}"),
                        "completion": format!("Completion {index}")
                    })
                    .to_string()
                })
                .collect::<Vec<_>>()
                .join("\n"),
        )
        .unwrap();

        let (train, validation) = split_training_dataset(&dataset).unwrap();
        assert_eq!(train.lines().count(), 9);
        assert_eq!(validation.lines().count(), 1);
        assert!(validation.contains("Prompt 9"));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn accepts_only_the_distinct_supported_build_methods() {
        assert_eq!(
            parsed_method("knowledge").unwrap(),
            FoundryMethod::Knowledge
        );
        assert_eq!(parsed_method("lora").unwrap(), FoundryMethod::Weight);
        assert_eq!(parsed_method("qlora").unwrap(), FoundryMethod::Weight);
        assert_eq!(parsed_method("full").unwrap(), FoundryMethod::Weight);
        assert!(parsed_method("rag-as-training").is_err());
    }

    #[test]
    fn separates_verified_inference_models_from_trainable_weight_models() {
        assert!(allowed_model_for_method(
            "qwen2.5:1.5b-instruct-q4_K_M",
            FoundryMethod::Knowledge
        ));
        assert!(!allowed_model_for_method(
            "qwen2.5:1.5b-instruct-q4_K_M",
            FoundryMethod::Weight
        ));
        assert!(allowed_model_for_method(
            "qwen2.5-1.5b-instruct",
            FoundryMethod::Weight
        ));
        assert!(!allowed_model_for_method(
            "qwen2.5-1.5b-instruct",
            FoundryMethod::Knowledge
        ));
        assert!(!allowed_model_for_method(
            "../outside",
            FoundryMethod::Weight
        ));
    }

    #[test]
    fn deduplicates_local_source_chunks() {
        let root = std::env::temp_dir().join(format!("vibespace-foundry-{}", nanoid::nanoid!()));
        fs::create_dir_all(&root).unwrap();
        let path = root.join("notes.txt");
        fs::write(
            &path,
            "This is a sufficiently long training paragraph.\n\nThis is a sufficiently long training paragraph.",
        )
        .unwrap();
        let prepared = clean_chunks(&[path]).unwrap();
        assert_eq!(prepared.chunks.len(), 1);
        assert_eq!(prepared.sources.len(), 1);
        assert_eq!(verified_source_count(&prepared), 1);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn packaging_counts_only_sources_that_contribute_verified_chunks() {
        let root = std::env::temp_dir().join(format!(
            "vibespace-foundry-provenance-{}",
            nanoid::nanoid!()
        ));
        fs::create_dir_all(&root).unwrap();
        let first = root.join("first.md");
        let duplicate = root.join("duplicate.md");
        let content =
            "A sufficiently long reviewed paragraph that should become one verified chunk.";
        fs::write(&first, content).unwrap();
        fs::write(&duplicate, content).unwrap();

        let prepared = clean_chunks(&[first, duplicate]).unwrap();
        assert_eq!(prepared.chunks.len(), 1);
        assert_eq!(prepared.sources.len(), 1);
        assert_eq!(verified_source_count(&prepared), 1);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn validates_artifact_content_hashes_before_activation() {
        let root = std::env::temp_dir().join(format!("vibespace-foundry-{}", nanoid::nanoid!()));
        fs::create_dir_all(&root).unwrap();
        let path = root.join("knowledge-artifact.json");
        let text = "The launch checklist requires a signed manifest.";
        let digest = format!("{:x}", Sha256::digest(text.as_bytes()));
        let artifact = KnowledgeArtifact {
            schema_version: 1,
            version: 1,
            model_name: "Release specialist".into(),
            description: "Knows the release checklist".into(),
            purpose: "Review releases".into(),
            default_behavior: None,
            base_model_id: "qwen2.5:1.5b-instruct-q4_K_M".into(),
            processing: "local-rag-knowledge".into(),
            source_count: 1,
            sources: Vec::new(),
            chunks: vec![KnowledgeChunk {
                id: format!("chunk-{}", &digest[..16]),
                source_name: "release.md".into(),
                source_anchor: Some("lines 1-1".into()),
                text: text.into(),
                sha256: digest,
            }],
        };
        fs::write(&path, serde_json::to_vec_pretty(&artifact).unwrap()).unwrap();

        let validated = validate_artifact(&path).unwrap();
        assert_eq!(validated.model_name, "Release specialist");

        let mut tampered: serde_json::Value =
            serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        tampered["chunks"][0]["text"] = "tampered".into();
        fs::write(&path, serde_json::to_vec_pretty(&tampered).unwrap()).unwrap();
        assert!(validate_artifact(&path).is_err());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn retrieval_returns_the_most_relevant_bounded_chunks() {
        let chunks = vec![
            KnowledgeChunk {
                id: "one".into(),
                source_name: "billing.md".into(),
                source_anchor: None,
                text: "Stripe webhooks reconcile subscriptions and credits.".into(),
                sha256: "unused".into(),
            },
            KnowledgeChunk {
                id: "two".into(),
                source_name: "release.md".into(),
                source_anchor: None,
                text: "Release manifests require signatures and checksums.".into(),
                sha256: "unused".into(),
            },
        ];
        let selected = rank_chunks(&chunks, "How are subscription credits reconciled?", 1);
        assert_eq!(selected.len(), 1);
        assert_eq!(selected[0].source_name, "billing.md");
    }

    #[test]
    fn prepares_csv_as_source_anchored_reproducible_chunks() {
        let root = std::env::temp_dir().join(format!("vibespace-foundry-{}", nanoid::nanoid!()));
        fs::create_dir_all(&root).unwrap();
        let path = root.join("examples.csv");
        fs::write(
            &path,
            "prompt,response\r\n\"Explain, safely\",\"Use a reviewed local dataset only.\"\r\nSecond prompt,Second sufficiently detailed response",
        )
        .unwrap();

        let prepared = clean_chunks(&[path]).unwrap();
        assert_eq!(prepared.sources.len(), 1);
        assert_eq!(prepared.sources[0].format, "csv");
        assert!(is_sha256(&prepared.sources[0].source_sha256));
        assert!(is_sha256(&prepared.sources[0].prepared_sha256));
        assert_eq!(prepared.sources[0].chunk_count, prepared.chunks.len());
        assert!(prepared.chunks.iter().all(|chunk| chunk
            .source_anchor
            .as_deref()
            .is_some_and(|value| value.starts_with("lines "))));
        assert!(prepared.chunks[0].text.contains("prompt: Explain, safely"));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn quarantines_high_confidence_credentials_before_source_preparation() {
        let root = std::env::temp_dir().join(format!("vibespace-foundry-{}", nanoid::nanoid!()));
        fs::create_dir_all(&root).unwrap();
        let path = root.join("unsafe.md");
        fs::write(
            &path,
            "Deployment notes\n\nSecret: ghp_abcdefghijklmnopqrstuvwxyz123456",
        )
        .unwrap();

        let error = clean_chunks(&[path]).err().unwrap();
        assert!(error.contains("credential") || error.contains("private-key"));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn extracts_docx_text_locally_with_source_provenance() {
        use std::io::Write as _;

        let root = std::env::temp_dir().join(format!("vibespace-foundry-{}", nanoid::nanoid!()));
        fs::create_dir_all(&root).unwrap();
        let path = root.join("reviewed.docx");
        let file = fs::File::create(&path).unwrap();
        let mut archive = zip::ZipWriter::new(file);
        archive
            .start_file(
                "word/document.xml",
                zip::write::SimpleFileOptions::default(),
            )
            .unwrap();
        archive
            .write_all(
                br#"<?xml version="1.0"?><w:document xmlns:w="urn:test"><w:body><w:p><w:r><w:t>First reviewed document paragraph with enough local text.</w:t></w:r></w:p><w:p><w:r><w:t>Second paragraph &amp; source provenance.</w:t></w:r></w:p></w:body></w:document>"#,
            )
            .unwrap();
        archive.finish().unwrap();

        let prepared = clean_chunks(&[path]).unwrap();
        assert_eq!(prepared.sources[0].format, "docx");
        assert_eq!(prepared.chunks.len(), 2);
        assert!(prepared.chunks[1].text.contains("& source provenance"));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn prepares_verified_weight_artifacts_for_local_chat_without_rag() {
        let root = std::env::temp_dir().join(format!("vibespace-foundry-{}", nanoid::nanoid!()));
        let artifact = root.join("weight-artifact");
        fs::create_dir_all(&artifact).unwrap();
        fs::write(
            artifact.join("adapter_model.safetensors"),
            b"verified adapter",
        )
        .unwrap();
        crate::model_foundry_training::write_and_verify_training_artifact(&artifact, "lora")
            .unwrap();
        let job = FoundryJob {
            id: "job_123456".into(),
            project_id: Some("project-1".into()),
            name: "Release adapter".into(),
            base_model_id: "qwen2.5-1.5b-instruct".into(),
            method: "lora".into(),
            status: "completed".into(),
            progress: 100,
            artifact_path: Some(artifact.to_string_lossy().into_owned()),
            artifact_verified: true,
            artifact_sha256: None,
            storage_bytes: 16,
            source_count: 1,
            version: 2,
            resume_available: false,
            error: None,
            created_at: "1".into(),
            updated_at: "2".into(),
        };
        write_job(&root.join("job.json"), &job).unwrap();

        let prepared =
            prepare_chat_from_job_dir(&root, "job_123456", "Review release", Some(4)).unwrap();
        assert_eq!(prepared.kind, "weight");
        assert_eq!(prepared.method.as_deref(), Some("lora"));
        assert!(prepared.base_model_id.is_none());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn preserves_project_identity_in_serialized_job_events() {
        let job = FoundryJob {
            id: "job_123456".into(),
            project_id: Some("project-123".into()),
            name: "Release adapter".into(),
            base_model_id: "qwen2.5-1.5b-instruct".into(),
            method: "lora".into(),
            status: "training".into(),
            progress: 50,
            artifact_path: None,
            artifact_verified: false,
            artifact_sha256: None,
            storage_bytes: 0,
            source_count: 1,
            version: 1,
            resume_available: false,
            error: None,
            created_at: "1".into(),
            updated_at: "2".into(),
        };

        let serialized = serde_json::to_value(job).unwrap();
        assert_eq!(serialized["projectId"], "project-123");
    }

    #[test]
    fn refuses_tampered_weight_artifacts_before_chat_activation() {
        let root = std::env::temp_dir().join(format!("vibespace-foundry-{}", nanoid::nanoid!()));
        let artifact = root.join("weight-artifact");
        fs::create_dir_all(&artifact).unwrap();
        let weight = artifact.join("adapter_model.safetensors");
        fs::write(&weight, b"verified adapter").unwrap();
        crate::model_foundry_training::write_and_verify_training_artifact(&artifact, "lora")
            .unwrap();
        fs::write(&weight, b"tampered adapter").unwrap();
        let job = FoundryJob {
            id: "job_123456".into(),
            project_id: Some("project-1".into()),
            name: "Release adapter".into(),
            base_model_id: "qwen2.5-1.5b-instruct".into(),
            method: "lora".into(),
            status: "completed".into(),
            progress: 100,
            artifact_path: Some(artifact.to_string_lossy().into_owned()),
            artifact_verified: true,
            artifact_sha256: None,
            storage_bytes: 16,
            source_count: 1,
            version: 2,
            resume_available: false,
            error: None,
            created_at: "1".into(),
            updated_at: "2".into(),
        };
        write_job(&root.join("job.json"), &job).unwrap();

        assert!(prepare_chat_from_job_dir(&root, "job_123456", "Review release", Some(4)).is_err());
        let _ = fs::remove_dir_all(root);
    }

    fn reviewed_inline_request() -> StartRequest {
        serde_json::from_value(serde_json::json!({
            "schemaVersion": 2, "projectId": "public-project", "name": "Public contract fixture",
            "description": "Public authored data", "purpose": "Contract test", "instructions": null,
            "baseModelId": "smollm2-135m-instruct", "method": "lora", "sourcePaths": [], "localOnly": true,
            "datasetJsonl": "{\"prompt\":\"  Say hi  \",\"completion\":\" Hello. \"}",
            "validationDatasetJsonl": "{\"prompt\":\"Color?\",\"completion\":\"blue\"}",
            "datasetVersionId": "public-v1", "datasetManifestHash": "a".repeat(64),
            "datasetFingerprint": "b".repeat(64),
            "datasetPayloadSha256": "9c400c28703586fc716233ab30678181bc718e43006f3a30e7f0933cd2c0a30f",
            "validationPayloadSha256": "9a68a7b44c11e37bcf9d53271f47ddc86078ff33e58c50e30c4490eb8328a411"
        })).unwrap()
    }

    #[test]
    fn inline_payload_shared_vectors_pin_rust_unicode_and_json_bytes() {
        let fixture: serde_json::Value = serde_json::from_str(include_str!(
            "../../src/features/model-foundry/inlineDatasetCanonicalV2.fixture.json"
        )).unwrap();
        let vectors = fixture["vectors"].as_array().unwrap();
        assert_eq!(vectors.len(), 16);
        for vector in vectors {
            let raw = vector["inputJsonl"].as_str().unwrap();
            let actual = canonicalize_inline_dataset(raw, None);
            if let Some(expected) = vector["expectedCanonicalJsonl"].as_str() {
                let canonical = actual.unwrap_or_else(|error| panic!("{}: {error}", vector["id"]));
                assert_eq!(canonical, expected, "{}", vector["id"]);
                assert_eq!(format!("{:x}", Sha256::digest(canonical.as_bytes())),
                    vector["expectedCanonicalSha256"].as_str().unwrap(), "{}", vector["id"]);
                let mut request = reviewed_inline_request();
                request.dataset_jsonl = Some(raw.into());
                request.dataset_payload_sha256 = Some(vector["expectedCanonicalSha256"].as_str().unwrap().into());
                assert_eq!(canonicalize_reviewed_inline_datasets(&request).unwrap().unwrap().0,
                    canonical, "{}", vector["id"]);
            } else {
                assert!(actual.is_err(), "{}", vector["id"]);
            }
        }
    }

    #[test]
    fn inline_payload_pins_c0_control_escaping_and_no_final_newline() {
        let dataset = serde_json::json!({"prompt": "a\0\u{0008}\u{000c}\n\r\t\u{001f}b", "completion": "B"}).to_string();
        let canonical = canonicalize_inline_dataset(&dataset, None).unwrap();
        assert_eq!(canonical, r#"{"prompt":"a\u0000\b\f\n\r\t\u001fb","response":"B"}"#);
    }

    #[test]
    fn inline_payload_preserves_logical_identity_and_verifies_both_canonical_splits() {
        let request = reviewed_inline_request();
        // Retain the exact original counterexample: logical manifest identity is
        // not the SHA of the raw train wire payload expected by the legacy path.
        assert!(canonicalize_inline_dataset(request.dataset_jsonl.as_deref().unwrap(),
            request.dataset_fingerprint.as_deref()).is_err());
        let (train, validation) = canonicalize_reviewed_inline_datasets(&request).unwrap().unwrap();
        assert_eq!(train, "{\"prompt\":\"Say hi\",\"response\":\"Hello.\"}");
        assert_eq!(validation, "{\"prompt\":\"Color?\",\"response\":\"blue\"}");
        let saved = serde_json::to_value(&request).unwrap();
        assert_eq!(saved["datasetFingerprint"], "b".repeat(64));
        assert_eq!(saved["datasetManifestHash"], "a".repeat(64));
        assert_eq!(saved["datasetVersionId"], "public-v1");
    }

    #[test]
    fn inline_payload_rejects_train_validation_and_row_order_tampering() {
        let mut train = reviewed_inline_request();
        train.dataset_jsonl = Some("{\"prompt\":\"Say hi\",\"response\":\"Hello!\"}".into());
        assert!(canonicalize_reviewed_inline_datasets(&train).unwrap_err().contains("training payload"));
        let mut validation = reviewed_inline_request();
        validation.validation_dataset_jsonl = Some("{\"prompt\":\"Color?\",\"response\":\"red\"}".into());
        assert!(canonicalize_reviewed_inline_datasets(&validation).unwrap_err().contains("validation payload"));
        let mut ordered = reviewed_inline_request();
        ordered.dataset_jsonl = Some("{\"prompt\":\"A\",\"response\":\"B\"}\n{\"prompt\":\"C\",\"response\":\"D\"}".into());
        ordered.dataset_payload_sha256 = Some("70e3bfb0619144118df6ea969d12ee0c84129ff70d0c1a512c20425e12e7a8ce".into());
        assert!(canonicalize_reviewed_inline_datasets(&ordered).is_ok());
        ordered.dataset_jsonl = Some("{\"prompt\":\"C\",\"response\":\"D\"}\n{\"prompt\":\"A\",\"response\":\"B\"}".into());
        assert!(canonicalize_reviewed_inline_datasets(&ordered).is_err());
        let mut swapped = reviewed_inline_request();
        std::mem::swap(&mut swapped.dataset_payload_sha256, &mut swapped.validation_payload_sha256);
        assert!(canonicalize_reviewed_inline_datasets(&swapped).is_err());
    }

    #[test]
    fn inline_payload_rejects_one_missing_or_malformed_digest() {
        for missing_train in [true, false] {
            let mut request = reviewed_inline_request();
            if missing_train { request.dataset_payload_sha256 = None; }
            else { request.validation_payload_sha256 = None; }
            assert!(canonicalize_reviewed_inline_datasets(&request).is_err());
        }
        for invalid in [String::new(), "A".repeat(64), "g".repeat(64), "a".repeat(63),
            "a".repeat(65), format!(" {}", "a".repeat(64))] {
            for train in [true, false] {
                let mut request = reviewed_inline_request();
                if train { request.dataset_payload_sha256 = Some(invalid.clone()); }
                else { request.validation_payload_sha256 = Some(invalid.clone()); }
                assert!(canonicalize_reviewed_inline_datasets(&request).is_err());
            }
        }
    }

    #[test]
    fn inline_payload_rejects_inapplicable_or_conflicting_request_fields() {
        for version in [None, Some(1), Some(3)] {
            let mut request = reviewed_inline_request(); request.schema_version = version;
            assert!(canonicalize_reviewed_inline_datasets(&request).is_err());
        }
        for value in [None, Some(String::new()), Some(" \n ".into())] {
            let mut train = reviewed_inline_request(); train.dataset_jsonl = value.clone();
            assert!(canonicalize_reviewed_inline_datasets(&train).is_err());
            let mut validation = reviewed_inline_request(); validation.validation_dataset_jsonl = value;
            assert!(canonicalize_reviewed_inline_datasets(&validation).is_err());
        }
        let mut paths = reviewed_inline_request(); paths.source_paths = vec!["synthetic.jsonl".into()];
        assert!(canonicalize_reviewed_inline_datasets(&paths).is_err());
        let mut media = reviewed_inline_request(); media.training_examples = vec![SupervisedMediaExample {
            path: "synthetic.png".into(), media_type: "image".into(), prompt: "A".into(), response: "B".into(), planned_frames: 1,
        }];
        assert!(canonicalize_reviewed_inline_datasets(&media).is_err());
        let mut knowledge = reviewed_inline_request(); knowledge.method = "knowledge".into();
        assert!(canonicalize_reviewed_inline_datasets(&knowledge).is_err());
    }

    #[test]
    fn inline_payload_rejects_explicit_null_and_non_string_digest_fields() {
        for field in ["datasetPayloadSha256", "validationPayloadSha256"] {
            for invalid in [serde_json::Value::Null, serde_json::json!(42),
                serde_json::json!(false), serde_json::json!([]), serde_json::json!({})] {
                let mut wire = serde_json::to_value(reviewed_inline_request()).unwrap();
                wire[field] = invalid;
                assert!(serde_json::from_value::<StartRequest>(wire).is_err());
            }
        }
    }

    #[test]
    fn inline_payload_preserves_legacy_no_new_fields_behavior() {
        let mut request = reviewed_inline_request();
        request.dataset_payload_sha256 = None; request.validation_payload_sha256 = None;
        assert!(canonicalize_reviewed_inline_datasets(&request).unwrap().is_none());
        request.schema_version = None; request.dataset_jsonl = None;
        request.source_paths = vec!["synthetic.jsonl".into()];
        assert!(canonicalize_reviewed_inline_datasets(&request).unwrap().is_none());
        let saved = serde_json::to_value(&request).unwrap();
        assert!(saved.get("datasetPayloadSha256").is_none());
        assert!(saved.get("validationPayloadSha256").is_none());
    }

    #[test]
    fn inline_payload_new_contract_retains_original_resource_bounds() {
        let oversized = [
            (format!("{{\"prompt\":\"A\",\"response\":\"B\"}}{}", " ".repeat(MAX_INLINE_DATASET_BYTES)), "5 MB"),
            (vec!["{\"prompt\":\"A\",\"response\":\"B\"}"; MAX_INLINE_DATASET_EXAMPLES + 1].join("\n"), "20000"),
            (format!("{{\"prompt\":\"A\",\"response\":\"{}\"}}", "x".repeat(MAX_INLINE_RECORD_BYTES)), "64 KiB"),
            (format!("{{\"prompt\":\"A\",\"response\":\"{}\"}}", "é".repeat(MAX_INLINE_RECORD_BYTES / 2 + 1)), "64 KiB"),
        ];
        for (dataset, expected) in oversized {
            for training in [true, false] {
                let mut request = reviewed_inline_request();
                if training { request.dataset_jsonl = Some(dataset.clone()); }
                else { request.validation_dataset_jsonl = Some(dataset.clone()); }
                assert!(canonicalize_reviewed_inline_datasets(&request).unwrap_err().contains(expected));
            }
        }
    }

    #[test]
    fn inline_dataset_canonicalizes_completion_records_for_the_worker() {
        let dataset = "{\"prompt\":\"Say hi\",\"completion\":\"Hello.\"}\n{\"prompt\":\"Count\",\"response\":\"One.\"}";
        let canonical = canonicalize_inline_dataset(dataset, None).unwrap();
        let rows: Vec<&str> = canonical.lines().collect();
        assert_eq!(rows.len(), 2);
        let first: serde_json::Value = serde_json::from_str(rows[0]).unwrap();
        assert_eq!(first["prompt"], "Say hi");
        assert_eq!(first["response"], "Hello.");
        assert!(first.get("completion").is_none());
        let second: serde_json::Value = serde_json::from_str(rows[1]).unwrap();
        assert_eq!(second["response"], "One.");
    }

    #[test]
    fn inline_dataset_rejects_oversized_total_bytes() {
        let record = "{\"prompt\":\"p\",\"completion\":\"c\"}";
        let dataset = vec![record; (MAX_INLINE_DATASET_BYTES / record.len()) + 1].join("\n");
        let error = canonicalize_inline_dataset(&dataset, None).unwrap_err();
        assert!(error.contains("5 MB"));
    }

    #[test]
    fn inline_dataset_rejects_too_many_records() {
        let dataset =
            vec!["{\"prompt\":\"p\",\"completion\":\"c\"}"; MAX_INLINE_DATASET_EXAMPLES + 1]
                .join("\n");
        let error = canonicalize_inline_dataset(&dataset, None).unwrap_err();
        assert!(error.contains("20000"));
    }

    #[test]
    fn inline_dataset_rejects_oversized_single_record() {
        let long_completion = "x".repeat(MAX_INLINE_RECORD_BYTES + 1);
        let dataset = format!("{{\"prompt\":\"p\",\"completion\":\"{long_completion}\"}}");
        let error = canonicalize_inline_dataset(&dataset, None).unwrap_err();
        assert!(error.contains("64 KiB"));
    }

    #[test]
    fn inline_dataset_rejects_empty_and_blank_input() {
        assert!(canonicalize_inline_dataset("", None).is_err());
        assert!(canonicalize_inline_dataset("   \n  \n", None).is_err());
    }

    #[test]
    fn inline_dataset_rejects_malformed_or_incomplete_records() {
        assert!(canonicalize_inline_dataset("not-json", None)
            .unwrap_err()
            .contains("valid JSON"));
        assert!(canonicalize_inline_dataset("[1,2]", None)
            .unwrap_err()
            .contains("JSON objects"));
        assert!(canonicalize_dataset_missing_prompt());
        assert!(
            canonicalize_inline_dataset("{\"prompt\":\" \",\"completion\":\"c\"}", None).is_err()
        );
        assert!(
            canonicalize_inline_dataset("{\"prompt\":\"p\",\"completion\":\" \"}", None).is_err()
        );
        assert!(canonicalize_inline_dataset("{\"prompt\":\"p\"}", None).is_err());
    }

    fn canonicalize_dataset_missing_prompt() -> bool {
        canonicalize_inline_dataset("{\"completion\":\"c\"}", None).is_err()
    }

    #[test]
    fn inline_dataset_fingerprint_must_match_the_reviewed_manifest() {
        let dataset = "{\"prompt\":\"p\",\"completion\":\"c\"}";
        let good = format!("{:x}", Sha256::digest(dataset.as_bytes()));
        assert!(canonicalize_inline_dataset(dataset, Some(&good)).is_ok());
        assert!(canonicalize_inline_dataset(dataset, Some(&good.to_uppercase())).is_ok());
        let error = canonicalize_inline_dataset(dataset, Some("deadbeef")).unwrap_err();
        assert!(error.contains("fingerprint"));
    }

    #[test]
    fn supervised_media_is_copied_hashed_and_split_inside_the_private_job() {
        let root =
            std::env::temp_dir().join(format!("vibespace-foundry-media-{}", nanoid::nanoid!()));
        let source_a = root.join("a.png");
        let source_b = root.join("b.png");
        let job = root.join("job");
        fs::create_dir_all(&root).unwrap();
        fs::write(&source_a, b"first-reviewed-image").unwrap();
        fs::write(&source_b, b"second-reviewed-image").unwrap();
        let examples = vec![
            SupervisedMediaExample {
                path: source_a.to_string_lossy().into_owned(),
                media_type: "image".into(),
                prompt: "What is shown?".into(),
                response: "The first reviewed frame.".into(),
                planned_frames: 1,
            },
            SupervisedMediaExample {
                path: source_b.to_string_lossy().into_owned(),
                media_type: "image".into(),
                prompt: "What is shown?".into(),
                response: "The second reviewed frame.".into(),
                planned_frames: 1,
            },
        ];

        let (train, validation) =
            prepare_supervised_media_dataset(&examples, "smolvlm2-256m-video-instruct", &job)
                .unwrap();

        assert_eq!(train.lines().count(), 1);
        assert_eq!(validation.lines().count(), 1);
        for row in train.lines().chain(validation.lines()) {
            let value: serde_json::Value = serde_json::from_str(row).unwrap();
            let media = PathBuf::from(value["mediaPath"].as_str().unwrap());
            assert!(media.starts_with(job.join("media")));
            assert_eq!(value["mediaSha256"].as_str().unwrap().len(), 64);
        }
        let _ = fs::remove_dir_all(root);
    }
}
