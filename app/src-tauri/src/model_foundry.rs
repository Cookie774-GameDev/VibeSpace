use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use tauri::{Emitter, Manager};
use tauri_plugin_notification::NotificationExt;

const MAX_SOURCE_BYTES: u64 = 64 * 1024 * 1024;
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
    dataset_jsonl: Option<String>,
    #[serde(default)]
    dataset_manifest_hash: Option<String>,
    #[serde(default)]
    dataset_fingerprint: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FoundryJob {
    id: String,
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
    chunks: Vec<KnowledgeChunk>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct KnowledgeChunk {
    id: String,
    source_name: String,
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

fn foundry_root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|path| path.join("model-foundry"))
        .map_err(|error| format!("Model Foundry app-data directory unavailable: {error}"))
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
    let artifact: KnowledgeArtifact = serde_json::from_slice(&bytes)
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
    for chunk in &artifact.chunks {
        let digest = format!("{:x}", Sha256::digest(chunk.text.as_bytes()));
        if chunk.id.trim().is_empty()
            || chunk.source_name.trim().is_empty()
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
    let directory = HSTRING::from(data_dir.to_string_lossy().as_ref());
    let mut free_bytes = 0_u64;
    unsafe { GetDiskFreeSpaceExW(&directory, Some(&mut free_bytes), None, None) }
        .map_err(|error| format!("Could not inspect free storage: {error}"))?;

    let threads = std::thread::available_parallelism()
        .map(|value| value.get())
        .unwrap_or(1);
    Ok(FoundryHardwareProfile {
        cpu: format!("{threads} logical CPU threads"),
        gpu: None,
        ram_gb: memory.ullTotalPhys as f64 / 1024_f64.powi(3),
        vram_gb: 0.0,
        free_storage_gb: free_bytes as f64 / 1024_f64.powi(3),
        os: "Windows".into(),
        accelerators: Vec::new(),
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
            let metadata = fs::metadata(&canonical)
                .map_err(|error| format!("Could not inspect source {value}: {error}"))?;
            if metadata.len() > MAX_SOURCE_BYTES {
                return Err(format!(
                    "{} exceeds the 64 MB per-source safety limit.",
                    canonical.display()
                ));
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
            ) {
                return Err(format!(
                    "{} requires a verified extractor or transcription backend that is not currently available.",
                    canonical.display()
                ));
            }
            Ok(canonical)
        })
        .collect()
}

fn clean_chunks(sources: &[PathBuf]) -> Result<Vec<KnowledgeChunk>, String> {
    let mut seen = BTreeSet::new();
    let mut chunks = Vec::new();
    for source in sources {
        let text = fs::read_to_string(source).map_err(|error| {
            format!("Could not read {} as UTF-8 text: {error}", source.display())
        })?;
        for part in text
            .split("\n\n")
            .map(str::trim)
            .filter(|value| value.len() >= 20)
        {
            let normalized = part.split_whitespace().collect::<Vec<_>>().join(" ");
            let digest = format!("{:x}", Sha256::digest(normalized.as_bytes()));
            if !seen.insert(digest.clone()) {
                continue;
            }
            chunks.push(KnowledgeChunk {
                id: format!("chunk-{}", &digest[..16]),
                source_name: source
                    .file_name()
                    .and_then(|value| value.to_str())
                    .unwrap_or("source")
                    .to_string(),
                text: normalized,
                sha256: digest,
            });
        }
    }
    if chunks.is_empty() {
        return Err("Sources did not contain enough usable text after cleaning.".into());
    }
    Ok(chunks)
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
        Ok(chunks) => {
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
                source_count: sources.len(),
                chunks,
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

    match crate::model_foundry_training::run_training_worker(
        &app,
        &job.id,
        &request.base_model_id,
        &request.method,
        &dataset,
        &job_dir,
        1,
        1_000,
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
    if request.name.trim().is_empty() || request.name.chars().count() > 80 {
        return Err("Model name must contain 1 to 80 characters.".into());
    }
    let method = parsed_method(&request.method)?;
    if !allowed_model_for_method(&request.base_model_id, method) {
        return Err("The selected base model is not in the verified local catalog.".into());
    }
    let inline_dataset = request
        .dataset_jsonl
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    if inline_dataset.is_some() && !request.source_paths.is_empty() {
        return Err(
            "Provide picker-selected sources or an inline Dataset Studio export, not both.".into(),
        );
    }
    let mut canonicalized: Option<String> = None;
    let mut sources: Vec<PathBuf> = if let Some(dataset) = inline_dataset {
        if method != FoundryMethod::Weight {
            return Err("Inline Dataset Studio exports are only valid for weight training.".into());
        }
        let canonical_dataset =
            canonicalize_inline_dataset(dataset, request.dataset_fingerprint.as_deref())?;
        canonicalized = Some(canonical_dataset);
        Vec::new()
    } else {
        validated_sources(&request.source_paths)?
    };
    if method == FoundryMethod::Weight
        && inline_dataset.is_none()
        && (sources.len() != 1
            || sources[0]
                .extension()
                .and_then(|value| value.to_str())
                .is_none_or(|value| !value.eq_ignore_ascii_case("jsonl")))
    {
        return Err("Weight training requires exactly one validated local JSONL dataset.".into());
    }
    let id = format!("job_{}", nanoid::nanoid!(14));
    let job_dir = foundry_root(&app)?.join("jobs").join(&id);
    fs::create_dir_all(&job_dir)
        .map_err(|error| format!("Could not create private job directory: {error}"))?;
    if let Some(canonical_dataset) = canonicalized.as_deref() {
        let dataset_path = job_dir.join("dataset.jsonl");
        write_atomic(&dataset_path, canonical_dataset.as_bytes())
            .map_err(|error| format!("Could not store the private inline dataset: {error}"))?;
        sources = vec![dataset_path];
    }
    let timestamp = now();
    let job = FoundryJob {
        id,
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
            process_weight(app, request, dataset, job_dir, worker_job, None);
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
    let model_name = job.name.clone();
    let version = job.version;
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
    Ok(FoundryChatResponse {
        artifact_id,
        model_name,
        version,
        method,
        text: result.text,
        input_tokens: result.input_tokens,
        output_tokens: result.output_tokens,
    })
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
    let sources = validated_sources(&request.source_paths)?;
    if sources.len() != 1
        || sources[0]
            .extension()
            .and_then(|value| value.to_str())
            .is_none_or(|value| !value.eq_ignore_ascii_case("jsonl"))
    {
        return Err("The private resume dataset is unavailable or invalid.".into());
    }
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
    let dataset = sources
        .into_iter()
        .next()
        .expect("resume validation requires exactly one dataset");
    std::thread::spawn(move || {
        process_weight(app, request, dataset, job_dir, worker_job, Some(checkpoint))
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
    let job_id = validated_job_id(job_id.trim())?;
    let name = name.trim();
    if name.is_empty() || name.chars().count() > 80 {
        return Err("Model name must contain 1 to 80 characters.".into());
    }
    let job_dir = foundry_root(&app)?.join("jobs").join(job_id);
    let job_path = job_dir.join("job.json");
    let artifact_path = job_dir.join("knowledge-artifact.json");
    let mut job: FoundryJob = serde_json::from_slice(
        &fs::read(&job_path).map_err(|_| "Model Foundry job was not found.".to_string())?,
    )
    .map_err(|error| format!("Model Foundry job metadata is invalid: {error}"))?;
    if job.status != "completed" || !job.artifact_verified {
        return Err("Only a verified completed artifact can be renamed.".into());
    }
    let mut artifact = validate_artifact(&artifact_path)?;
    artifact.model_name = name.to_string();
    write_atomic(
        &artifact_path,
        &serde_json::to_vec_pretty(&artifact)
            .map_err(|error| format!("Could not encode renamed artifact: {error}"))?,
    )?;
    validate_artifact(&artifact_path)?;
    let bytes =
        fs::read(&artifact_path).map_err(|error| format!("Could not reopen artifact: {error}"))?;
    job.name = name.to_string();
    job.artifact_sha256 = Some(format!("{:x}", Sha256::digest(&bytes)));
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
pub fn model_foundry_duplicate_artifact(
    app: tauri::AppHandle,
    job_id: String,
    name: String,
) -> Result<FoundryJob, String> {
    let source_id = validated_job_id(job_id.trim())?;
    let name = name.trim();
    if name.is_empty() || name.chars().count() > 80 {
        return Err("Model name must contain 1 to 80 characters.".into());
    }
    let jobs_root = foundry_root(&app)?.join("jobs");
    let source_dir = jobs_root.join(source_id);
    let source_job: FoundryJob = serde_json::from_slice(
        &fs::read(source_dir.join("job.json"))
            .map_err(|_| "Model Foundry job was not found.".to_string())?,
    )
    .map_err(|error| format!("Model Foundry job metadata is invalid: {error}"))?;
    if source_job.status != "completed" || !source_job.artifact_verified {
        return Err("Only a verified completed artifact can be duplicated.".into());
    }
    let mut artifact = validate_artifact(&source_dir.join("knowledge-artifact.json"))?;
    artifact.model_name = name.to_string();
    artifact.version = 1;
    let id = format!("job_{}", nanoid::nanoid!(14));
    let destination_dir = jobs_root.join(&id);
    fs::create_dir_all(&destination_dir)
        .map_err(|error| format!("Could not create duplicate artifact directory: {error}"))?;
    let artifact_path = destination_dir.join("knowledge-artifact.json");
    write_atomic(
        &artifact_path,
        &serde_json::to_vec_pretty(&artifact)
            .map_err(|error| format!("Could not encode duplicate artifact: {error}"))?,
    )?;
    validate_artifact(&artifact_path)?;
    let bytes =
        fs::read(&artifact_path).map_err(|error| format!("Could not reopen artifact: {error}"))?;
    let timestamp = now();
    let job = FoundryJob {
        id,
        name: name.to_string(),
        base_model_id: artifact.base_model_id,
        method: source_job.method,
        status: "completed".into(),
        progress: 100,
        artifact_path: Some(artifact_path.to_string_lossy().into_owned()),
        artifact_verified: true,
        artifact_sha256: Some(format!("{:x}", Sha256::digest(&bytes))),
        storage_bytes: bytes.len() as u64,
        source_count: artifact.source_count,
        version: 1,
        resume_available: false,
        error: None,
        created_at: timestamp.clone(),
        updated_at: timestamp,
    };
    write_job(&destination_dir.join("job.json"), &job)?;
    if let Ok(bytes) = fs::read(source_dir.join("request.json")) {
        if let Ok(mut request) = serde_json::from_slice::<StartRequest>(&bytes) {
            request.name = name.to_string();
            request.version = Some(1);
            write_atomic(
                &destination_dir.join("request.json"),
                &serde_json::to_vec_pretty(&request)
                    .map_err(|error| format!("Could not encode duplicate retry record: {error}"))?,
            )?;
        }
    }
    Ok(job)
}

#[tauri::command]
pub fn model_foundry_export_artifact(
    app: tauri::AppHandle,
    job_id: String,
    destination: String,
) -> Result<(), String> {
    let job_id = validated_job_id(job_id.trim())?;
    let job_dir = foundry_root(&app)?.join("jobs").join(job_id);
    let artifact_path = job_dir.join("knowledge-artifact.json");
    validate_artifact(&artifact_path)?;
    let requested = PathBuf::from(destination);
    if !requested
        .extension()
        .and_then(|value| value.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("json"))
    {
        return Err("Model Foundry exports must use a .json file.".into());
    }
    let parent = requested
        .parent()
        .ok_or_else(|| "Export destination has no parent directory.".to_string())?
        .canonicalize()
        .map_err(|_| "Export destination directory is unavailable.".to_string())?;
    let file_name = requested
        .file_name()
        .ok_or_else(|| "Export destination has no file name.".to_string())?;
    let safe_destination = parent.join(file_name);
    let bytes =
        fs::read(&artifact_path).map_err(|error| format!("Could not read artifact: {error}"))?;
    fs::write(&safe_destination, bytes)
        .map_err(|error| format!("Could not export Model Foundry artifact: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

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
        let chunks = clean_chunks(&[path]).unwrap();
        assert_eq!(chunks.len(), 1);
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
            chunks: vec![KnowledgeChunk {
                id: format!("chunk-{}", &digest[..16]),
                source_name: "release.md".into(),
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
                text: "Stripe webhooks reconcile subscriptions and credits.".into(),
                sha256: "unused".into(),
            },
            KnowledgeChunk {
                id: "two".into(),
                source_name: "release.md".into(),
                text: "Release manifests require signatures and checksums.".into(),
                sha256: "unused".into(),
            },
        ];
        let selected = rank_chunks(&chunks, "How are subscription credits reconciled?", 1);
        assert_eq!(selected.len(), 1);
        assert_eq!(selected[0].source_name, "billing.md");
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
}
