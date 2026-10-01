use reqwest::blocking::Client;
use reqwest::header::{CONTENT_LENGTH, RANGE};
use reqwest::{redirect, StatusCode, Url};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;
use tauri::{Emitter, Manager};

const MAX_SNAPSHOT_BYTES: u64 = 2 * 1024 * 1024 * 1024;
const CHUNK_BYTES: usize = 256 * 1024;
const SMOLLM2_ID: &str = "smollm2-135m-instruct";
const SMOLLM2_REVISION: &str = "a91318be21aeaf0879874faa161dcb40c68847e9";
const SMOLLM2_LICENSE: &str = "Apache-2.0";
const SMOLLM2_PREFIX: &str = "https://huggingface.co/HuggingFaceTB/SmolLM2-135M-Instruct/resolve/a91318be21aeaf0879874faa161dcb40c68847e9/";
const PINNED_SMOLLM2_FILES: &[(&str, &str, u64)] = &[
    (
        "config.json",
        "8eb740e8bbe4cff95ea7b4588d17a2432deb16e8075bc5828ff7ba9be94d982a",
        861,
    ),
    (
        "generation_config.json",
        "87b916edaaab66b3899b9d0dd0752727dff6666686da0504d89ae0a6e055a013",
        132,
    ),
    (
        "model.safetensors",
        "5af571cbf074e6d21a03528d2330792e532ca608f24ac70a143f6b369968ab8c",
        300_000_000,
    ),
    (
        "special_tokens_map.json",
        "2b7379f3ae813529281a5c602bc5a11c1d4e0a99107aaa597fe936c1e813ca52",
        655,
    ),
    (
        "tokenizer.json",
        "9ca9acddb6525a194ec8ac7a87f24fbba7232a9a15ffa1af0c1224fcd888e47c",
        2_104_556,
    ),
    (
        "tokenizer_config.json",
        "4ec77d44f62efeb38d7e044a1db318f6a939438425312dfa333b8382dbad98df",
        3_764,
    ),
];
static DOWNLOADS: OnceLock<Mutex<HashMap<String, Arc<AtomicBool>>>> = OnceLock::new();

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelDownloadFileRequest {
    path: String,
    url: String,
    expected_sha256: String,
    expected_size_bytes: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelDownloadRequest {
    project_id: String,
    model_id: String,
    revision: String,
    license: String,
    files: Vec<ModelDownloadFileRequest>,
    license_approved: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotFileResult {
    path: String,
    sha256: String,
    size_bytes: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelDownloadResult {
    model_id: String,
    path: String,
    manifest_path: String,
    size_bytes: u64,
    resumed: bool,
    files: Vec<SnapshotFileResult>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DownloadProgress {
    project_id: String,
    model_id: String,
    file_path: String,
    downloaded_bytes: u64,
    expected_size_bytes: u64,
    resumed: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SnapshotManifest<'a> {
    format_version: u8,
    model_id: &'a str,
    revision: &'a str,
    license: &'a str,
    files: &'a [SnapshotFileResult],
}

fn downloads() -> &'static Mutex<HashMap<String, Arc<AtomicBool>>> {
    DOWNLOADS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn validate_id(value: &str) -> Result<(), String> {
    if value.is_empty()
        || value.len() > 64
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err("Model download identifier is invalid.".into());
    }
    Ok(())
}

fn validate_file_name(value: &str) -> Result<(), String> {
    if value.is_empty()
        || value.len() > 128
        || value.starts_with('.')
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
    {
        return Err("Model snapshot file name is invalid.".into());
    }
    Ok(())
}

fn validate_checksum(value: &str) -> Result<(), String> {
    if value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        Ok(())
    } else {
        Err("Expected model checksum must be a SHA-256 hex digest.".into())
    }
}

fn allowed_download_url(url: &Url) -> bool {
    if url.scheme() != "https" {
        return false;
    }
    matches!(
        url.host_str(),
        Some("huggingface.co")
            | Some("cdn-lfs.huggingface.co")
            | Some("cdn-lfs-us-1.huggingface.co")
            | Some("cdn-lfs-eu-1.huggingface.co")
            | Some("cas-bridge.xethub.hf.co")
    )
}

fn validate_pinned_request(request: &ModelDownloadRequest) -> Result<(), String> {
    if request.model_id != SMOLLM2_ID
        || request.revision != SMOLLM2_REVISION
        || request.license != SMOLLM2_LICENSE
        || request.files.len() != PINNED_SMOLLM2_FILES.len()
    {
        return Err("The requested model snapshot is not in the native trusted catalog.".into());
    }
    for (path, sha256, maximum_bytes) in PINNED_SMOLLM2_FILES {
        let expected_url = format!("{SMOLLM2_PREFIX}{path}");
        let matches = request.files.iter().filter(|file| {
            file.path == *path
                && file.url == expected_url
                && file.expected_sha256.eq_ignore_ascii_case(sha256)
                && file.expected_size_bytes == *maximum_bytes
        });
        if matches.count() != 1 {
            return Err(
                "The requested model snapshot differs from the native trusted catalog.".into(),
            );
        }
    }
    Ok(())
}

fn model_root(app: &tauri::AppHandle, model_id: &str) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|path| path.join("model-foundry").join("models").join(model_id))
        .map_err(|error| format!("Unable to resolve the application data directory: {error}"))
}

fn file_sha256(path: &Path) -> Result<String, String> {
    let mut file =
        File::open(path).map_err(|error| format!("Unable to read model file: {error}"))?;
    let mut digest = Sha256::new();
    let mut buffer = vec![0_u8; CHUNK_BYTES];
    loop {
        let count = file
            .read(&mut buffer)
            .map_err(|error| format!("Unable to checksum model file: {error}"))?;
        if count == 0 {
            break;
        }
        digest.update(&buffer[..count]);
    }
    Ok(format!("{:x}", digest.finalize()))
}

fn write_snapshot_manifest(path: &Path, manifest: &SnapshotManifest<'_>) -> Result<(), String> {
    let bytes = serde_json::to_vec(manifest)
        .map_err(|error| format!("Unable to serialize model snapshot manifest: {error}"))?;
    let temporary = path.with_extension("json.partial");
    let mut file = File::create(&temporary)
        .map_err(|error| format!("Unable to stage model snapshot manifest: {error}"))?;
    file.write_all(&bytes)
        .and_then(|_| file.sync_all())
        .map_err(|error| format!("Unable to persist model snapshot manifest: {error}"))?;
    drop(file);
    if path.exists() {
        fs::remove_file(path)
            .map_err(|error| format!("Unable to replace model snapshot manifest: {error}"))?;
    }
    fs::rename(&temporary, path)
        .map_err(|error| format!("Unable to promote model snapshot manifest: {error}"))
}

fn download_file(
    app: &tauri::AppHandle,
    client: &Client,
    root: &Path,
    project_id: &str,
    model_id: &str,
    file_request: &ModelDownloadFileRequest,
    cancelled: &AtomicBool,
    completed_bytes: u64,
    total_expected_bytes: u64,
) -> Result<(SnapshotFileResult, bool), String> {
    validate_file_name(&file_request.path)?;
    validate_checksum(&file_request.expected_sha256)?;
    if file_request.expected_size_bytes == 0
        || file_request.expected_size_bytes > MAX_SNAPSHOT_BYTES
    {
        return Err("Expected model file size is outside the supported limit.".into());
    }
    let url = Url::parse(&file_request.url).map_err(|_| "Model URL is invalid.".to_string())?;
    if !allowed_download_url(&url) {
        return Err("Model URL is not an approved HTTPS source.".into());
    }
    let final_path = root.join(&file_request.path);
    let partial_path = root.join(format!("{}.partial", file_request.path));
    if final_path.is_file() {
        let size_bytes = fs::metadata(&final_path)
            .map_err(|error| format!("Unable to inspect model file: {error}"))?
            .len();
        let sha256 = file_sha256(&final_path)?;
        if size_bytes <= file_request.expected_size_bytes
            && sha256.eq_ignore_ascii_case(&file_request.expected_sha256)
        {
            return Ok((
                SnapshotFileResult {
                    path: file_request.path.clone(),
                    sha256,
                    size_bytes,
                },
                false,
            ));
        }
        fs::remove_file(&final_path)
            .map_err(|error| format!("Unable to remove a corrupt model file: {error}"))?;
    }

    let existing_bytes = fs::metadata(&partial_path)
        .map(|metadata| metadata.len())
        .unwrap_or(0);
    if existing_bytes > file_request.expected_size_bytes {
        fs::remove_file(&partial_path)
            .map_err(|error| format!("Unable to remove oversized partial download: {error}"))?;
    }
    let resume_from = fs::metadata(&partial_path)
        .map(|metadata| metadata.len())
        .unwrap_or(0);
    let resumed = resume_from > 0;
    let mut request_builder = client.get(url);
    if resumed {
        request_builder = request_builder.header(RANGE, format!("bytes={resume_from}-"));
    }
    let mut response = request_builder
        .send()
        .map_err(|error| format!("Model download failed: {error}"))?;
    if !response.status().is_success() {
        return Err(format!(
            "Model source returned HTTP {}.",
            response.status().as_u16()
        ));
    }
    let append = resumed && response.status() == StatusCode::PARTIAL_CONTENT;
    let mut downloaded = if append { resume_from } else { 0 };
    if let Some(length) = response
        .headers()
        .get(CONTENT_LENGTH)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<u64>().ok())
    {
        if downloaded.saturating_add(length) > file_request.expected_size_bytes {
            return Err("Model response exceeds the approved file size.".into());
        }
    }
    let mut file = OpenOptions::new()
        .create(true)
        .write(true)
        .append(append)
        .truncate(!append)
        .open(&partial_path)
        .map_err(|error| format!("Unable to open partial model file: {error}"))?;
    let mut buffer = vec![0_u8; CHUNK_BYTES];
    loop {
        if cancelled.load(Ordering::Relaxed) {
            file.sync_all().ok();
            return Err(
                "Model snapshot download cancelled; partial data was retained for resume.".into(),
            );
        }
        let count = response
            .read(&mut buffer)
            .map_err(|error| format!("Model download stream failed: {error}"))?;
        if count == 0 {
            break;
        }
        downloaded = downloaded.saturating_add(count as u64);
        if downloaded > file_request.expected_size_bytes {
            drop(file);
            fs::remove_file(&partial_path).ok();
            return Err("Model download exceeded the approved file size.".into());
        }
        file.write_all(&buffer[..count])
            .map_err(|error| format!("Unable to write model download: {error}"))?;
        let _ = app.emit(
            "model-foundry:download-progress",
            DownloadProgress {
                project_id: project_id.to_string(),
                model_id: model_id.to_string(),
                file_path: file_request.path.clone(),
                downloaded_bytes: completed_bytes.saturating_add(downloaded),
                expected_size_bytes: total_expected_bytes,
                resumed,
            },
        );
    }
    file.sync_all()
        .map_err(|error| format!("Unable to persist model download: {error}"))?;
    drop(file);
    let sha256 = file_sha256(&partial_path)?;
    if !sha256.eq_ignore_ascii_case(&file_request.expected_sha256) {
        fs::remove_file(&partial_path).ok();
        return Err(format!(
            "Downloaded model file {} failed SHA-256 verification and was removed.",
            file_request.path
        ));
    }
    fs::rename(&partial_path, &final_path)
        .map_err(|error| format!("Unable to promote verified model file: {error}"))?;
    Ok((
        SnapshotFileResult {
            path: file_request.path.clone(),
            sha256,
            size_bytes: downloaded,
        },
        resumed,
    ))
}

#[tauri::command]
pub fn model_foundry_download_model(
    app: tauri::AppHandle,
    request: ModelDownloadRequest,
) -> Result<ModelDownloadResult, String> {
    validate_id(&request.project_id)?;
    validate_id(&request.model_id)?;
    if !request.license_approved {
        return Err("Explicit model license approval is required before download.".into());
    }
    validate_pinned_request(&request)?;
    let total_expected_bytes = request.files.iter().try_fold(0_u64, |total, file| {
        total
            .checked_add(file.expected_size_bytes)
            .filter(|sum| *sum <= MAX_SNAPSHOT_BYTES)
            .ok_or_else(|| "Approved model snapshot size exceeds the supported limit.".to_string())
    })?;

    let key = format!("{}:{}", request.project_id, request.model_id);
    let cancelled = Arc::new(AtomicBool::new(false));
    {
        let mut active = downloads()
            .lock()
            .map_err(|_| "Download state is unavailable.".to_string())?;
        if active.contains_key(&key) {
            return Err("This model snapshot download is already active.".into());
        }
        active.insert(key.clone(), cancelled.clone());
    }

    let result = (|| {
        let root = model_root(&app, &request.model_id)?;
        fs::create_dir_all(&root)
            .map_err(|error| format!("Unable to create model directory: {error}"))?;
        let policy = redirect::Policy::custom(|attempt| {
            if allowed_download_url(attempt.url()) {
                attempt.follow()
            } else {
                attempt.stop()
            }
        });
        let client = Client::builder()
            .redirect(policy)
            .connect_timeout(Duration::from_secs(20))
            .timeout(Duration::from_secs(30 * 60))
            .build()
            .map_err(|error| format!("Unable to initialize model download: {error}"))?;
        let mut completed_bytes = 0_u64;
        let mut resumed = false;
        let mut files = Vec::with_capacity(request.files.len());
        for file_request in &request.files {
            let (file, file_resumed) = download_file(
                &app,
                &client,
                &root,
                &request.project_id,
                &request.model_id,
                file_request,
                &cancelled,
                completed_bytes,
                total_expected_bytes,
            )?;
            completed_bytes = completed_bytes.saturating_add(file.size_bytes);
            resumed |= file_resumed;
            files.push(file);
        }
        files.sort_by(|left, right| left.path.cmp(&right.path));
        let manifest_path = root.join("snapshot-manifest.json");
        write_snapshot_manifest(
            &manifest_path,
            &SnapshotManifest {
                format_version: 1,
                model_id: &request.model_id,
                revision: &request.revision,
                license: &request.license,
                files: &files,
            },
        )?;
        Ok(ModelDownloadResult {
            model_id: request.model_id.clone(),
            path: root.to_string_lossy().into_owned(),
            manifest_path: manifest_path.to_string_lossy().into_owned(),
            size_bytes: completed_bytes,
            resumed,
            files,
        })
    })();

    if let Ok(mut active) = downloads().lock() {
        active.remove(&key);
    }
    result
}

#[tauri::command]
pub fn model_foundry_cancel_download(project_id: String, model_id: String) -> Result<bool, String> {
    validate_id(&project_id)?;
    validate_id(&model_id)?;
    let key = format!("{project_id}:{model_id}");
    let active = downloads()
        .lock()
        .map_err(|_| "Download state is unavailable.".to_string())?;
    Ok(active
        .get(&key)
        .map(|flag| {
            flag.store(true, Ordering::Relaxed);
            true
        })
        .unwrap_or(false))
}

#[tauri::command]
pub fn model_foundry_cleanup_partial_download(
    app: tauri::AppHandle,
    model_id: String,
) -> Result<bool, String> {
    validate_id(&model_id)?;
    let root = model_root(&app, &model_id)?;
    if !root.is_dir() {
        return Ok(false);
    }
    let mut removed = false;
    for entry in fs::read_dir(&root)
        .map_err(|error| format!("Unable to inspect partial model downloads: {error}"))?
    {
        let path = entry
            .map_err(|error| format!("Unable to inspect partial model download: {error}"))?
            .path();
        if path.is_file()
            && path
                .file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.ends_with(".partial"))
        {
            fs::remove_file(&path)
                .map_err(|error| format!("Unable to remove partial model download: {error}"))?;
            removed = true;
        }
    }
    Ok(removed)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pinned_request() -> ModelDownloadRequest {
        ModelDownloadRequest {
            project_id: "project-1".into(),
            model_id: SMOLLM2_ID.into(),
            revision: SMOLLM2_REVISION.into(),
            license: SMOLLM2_LICENSE.into(),
            files: PINNED_SMOLLM2_FILES
                .iter()
                .map(|(path, sha256, size)| ModelDownloadFileRequest {
                    path: (*path).into(),
                    url: format!("{SMOLLM2_PREFIX}{path}"),
                    expected_sha256: (*sha256).into(),
                    expected_size_bytes: *size,
                })
                .collect(),
            license_approved: true,
        }
    }

    #[test]
    fn source_allowlist_requires_https_and_exact_hosts() {
        assert!(allowed_download_url(
            &Url::parse("https://huggingface.co/org/model/resolve/rev/model.safetensors").unwrap()
        ));
        assert!(allowed_download_url(
            &Url::parse("https://cas-bridge.xethub.hf.co/file").unwrap()
        ));
        assert!(!allowed_download_url(
            &Url::parse("http://huggingface.co/file").unwrap()
        ));
        assert!(!allowed_download_url(
            &Url::parse("https://huggingface.co.evil.example/file").unwrap()
        ));
    }

    #[test]
    fn identifiers_file_names_and_checksums_are_strict() {
        assert!(validate_id("smollm2-135m").is_ok());
        assert!(validate_id("../escape").is_err());
        assert!(validate_file_name("tokenizer.json").is_ok());
        assert!(validate_file_name("../tokenizer.json").is_err());
        assert!(validate_file_name("folder/tokenizer.json").is_err());
        assert!(validate_checksum(&"a".repeat(64)).is_ok());
        assert!(validate_checksum("not-a-checksum").is_err());
    }

    #[test]
    fn native_catalog_rejects_tampered_snapshot_requests() {
        let request = pinned_request();
        assert!(validate_pinned_request(&request).is_ok());
        let mut tampered = pinned_request();
        tampered.files[0].url = "https://huggingface.co/other/model".into();
        assert!(validate_pinned_request(&tampered).is_err());
        let mut duplicate = pinned_request();
        duplicate.files[1] = duplicate.files[0].clone();
        assert!(validate_pinned_request(&duplicate).is_err());
    }
}
