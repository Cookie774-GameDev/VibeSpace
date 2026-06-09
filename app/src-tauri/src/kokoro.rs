//! Kokoro-82M local TTS command surface for the Tauri core.
//!
//! Scope: resolve the OS-stable model directory; download model assets with
//! progress events, resume, and real SHA-256 verification; detect/repair
//! corrupt files; expose a `kokoro_speak` command.
//!
//! IMPORTANT — audio generation:
//!   This module does NOT bundle an ONNX inference runtime or Kokoro weights
//!   yet. `kokoro_speak` returns a structured `engine_not_available` error and
//!   `kokoro_status` reports `ready = false`, so the frontend TtsService falls
//!   back to system TTS automatically — no crash, no UI freeze. Wiring a real
//!   runtime (e.g. the `ort` crate) + publishing the model release asset is the
//!   remaining step. See docs/10-voice-subscription-system.md.
//!
//! Registration (add to lib.rs):
//!   mod kokoro;
//!   // in invoke_handler: kokoro::kokoro_model_path, kokoro::kokoro_check_installed,
//!   //   kokoro::kokoro_verify_checksums, kokoro::kokoro_status, kokoro::kokoro_warmup,
//!   //   kokoro::kokoro_download, kokoro::kokoro_resume_download, kokoro::kokoro_repair,
//!   //   kokoro::kokoro_delete_corrupt, kokoro::kokoro_speak, kokoro::kokoro_stop,
//! Cargo.toml needs: sha2 = "0.10"  (reqwest is already present).

use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::Emitter;

const CHUNK: usize = 65_536;
const PLACEHOLDER_SHA: &str = "REPLACE_WITH_REAL_SHA256";

/// Last manifest seen by a download, so resume/repair can re-run without the
/// frontend re-sending it.
static LAST_MANIFEST: Mutex<Option<Manifest>> = Mutex::new(None);

#[derive(Deserialize, Clone)]
pub struct ManifestFile {
    name: String,
    url: String,
    #[serde(default)]
    sha256: String,
    #[serde(default)]
    size_bytes: u64,
    #[serde(default = "default_true")]
    required: bool,
}

fn default_true() -> bool {
    true
}

#[derive(Deserialize, Clone)]
pub struct Manifest {
    files: Vec<ManifestFile>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledCheck {
    installed: bool,
    files: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChecksumResult {
    ok: bool,
    corrupt: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelStatus {
    installed: bool,
    ready: bool,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct DownloadProgress {
    file: String,
    received_bytes: u64,
    total_bytes: u64,
    percent: f64,
}

/// OS-stable Kokoro model directory.
///   Windows: %APPDATA%/Jarvis-One/models/kokoro
///   macOS:   ~/Library/Application Support/Jarvis-One/models/kokoro
///   Linux:   ~/.local/share/Jarvis-One/models/kokoro
fn model_dir() -> PathBuf {
    #[cfg(target_os = "windows")]
    {
        let base = std::env::var_os("APPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("."));
        base.join("Jarvis-One").join("models").join("kokoro")
    }
    #[cfg(target_os = "macos")]
    {
        let home = std::env::var_os("HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("."));
        home.join("Library")
            .join("Application Support")
            .join("Jarvis-One")
            .join("models")
            .join("kokoro")
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        let home = std::env::var_os("HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("."));
        home.join(".local")
            .join("share")
            .join("Jarvis-One")
            .join("models")
            .join("kokoro")
    }
}

fn sha256_file(path: &Path) -> Option<String> {
    let mut f = fs::File::open(path).ok()?;
    let mut hasher = Sha256::new();
    let mut buf = [0u8; CHUNK];
    loop {
        let n = f.read(&mut buf).ok()?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Some(format!("{:x}", hasher.finalize()))
}

/// True when the file matches the manifest. When no real checksum is provided
/// (placeholder/empty), accept on presence so a partial manifest doesn't block
/// development.
fn verify_one(path: &Path, file: &ManifestFile) -> bool {
    if !path.exists() {
        return false;
    }
    if file.sha256.is_empty() || file.sha256 == PLACEHOLDER_SHA {
        return true;
    }
    sha256_file(path)
        .map(|h| h.eq_ignore_ascii_case(&file.sha256))
        .unwrap_or(false)
}

fn download_file(app: &tauri::AppHandle, file: &ManifestFile, dir: &Path) -> Result<(), String> {
    fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let final_path = dir.join(&file.name);
    if verify_one(&final_path, file) {
        return Ok(());
    }

    let part_path = dir.join(format!("{}.part", file.name));
    let mut start: u64 = 0;
    if part_path.exists() {
        start = fs::metadata(&part_path).map(|m| m.len()).unwrap_or(0);
    }

    let client = reqwest::blocking::Client::builder()
        .timeout(None)
        .build()
        .map_err(|e| e.to_string())?;
    let mut req = client.get(&file.url);
    if start > 0 {
        req = req.header("Range", format!("bytes={start}-"));
    }
    let mut resp = req.send().map_err(|e| e.to_string())?;
    let status = resp.status();
    if !status.is_success() && status.as_u16() != 206 {
        return Err(format!("download_failed_{}", status.as_u16()));
    }
    // Server ignored Range (200 not 206): restart from scratch.
    if start > 0 && status.as_u16() == 200 {
        start = 0;
        let _ = fs::remove_file(&part_path);
    }

    let total = file
        .size_bytes
        .max(resp.content_length().unwrap_or(0).saturating_add(start));

    let mut out = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&part_path)
        .map_err(|e| e.to_string())?;

    let mut buf = [0u8; CHUNK];
    let mut received = start;
    loop {
        let n = resp.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        out.write_all(&buf[..n]).map_err(|e| e.to_string())?;
        received += n as u64;
        let percent = if total > 0 {
            (received as f64 / total as f64) * 100.0
        } else {
            0.0
        };
        let _ = app.emit(
            "kokoro:progress",
            DownloadProgress {
                file: file.name.clone(),
                received_bytes: received,
                total_bytes: total,
                percent,
            },
        );
    }
    drop(out);

    if !verify_one(&part_path, file) {
        let _ = fs::remove_file(&part_path);
        return Err("checksum_mismatch".to_string());
    }
    fs::rename(&part_path, &final_path).map_err(|e| e.to_string())?;
    Ok(())
}

// ─── Commands ────────────────────────────────────────────────────────────────

#[tauri::command]
pub fn kokoro_model_path() -> String {
    model_dir().to_string_lossy().to_string()
}

#[tauri::command]
pub fn kokoro_check_installed() -> InstalledCheck {
    let dir = model_dir();
    let mut files = Vec::new();
    if let Ok(entries) = fs::read_dir(&dir) {
        for e in entries.flatten() {
            if let Some(name) = e.file_name().to_str() {
                if !name.ends_with(".part") {
                    files.push(name.to_string());
                }
            }
        }
    }
    let manifest = LAST_MANIFEST.lock().ok().and_then(|m| m.clone());
    let installed = match manifest {
        Some(m) => m
            .files
            .iter()
            .filter(|f| f.required)
            .all(|f| dir.join(&f.name).exists()),
        None => files.iter().any(|f| f.ends_with(".onnx")),
    };
    InstalledCheck { installed, files }
}

#[tauri::command]
pub fn kokoro_verify_checksums() -> ChecksumResult {
    let dir = model_dir();
    let manifest = LAST_MANIFEST.lock().ok().and_then(|m| m.clone());
    let Some(manifest) = manifest else {
        return ChecksumResult {
            ok: false,
            corrupt: Vec::new(),
        };
    };
    let mut corrupt = Vec::new();
    for f in &manifest.files {
        if f.required && !verify_one(&dir.join(&f.name), f) {
            corrupt.push(f.name.clone());
        }
    }
    ChecksumResult {
        ok: corrupt.is_empty(),
        corrupt,
    }
}

#[tauri::command]
pub fn kokoro_status() -> ModelStatus {
    let installed = kokoro_check_installed().installed;
    // `ready` stays false until an ONNX runtime + weights are wired, so the
    // frontend falls back to system TTS instead of pretending audio works.
    ModelStatus {
        installed,
        ready: false,
    }
}

#[tauri::command]
pub fn kokoro_warmup() -> Result<(), String> {
    Ok(())
}

#[tauri::command]
pub fn kokoro_download(app: tauri::AppHandle, manifest: Manifest) -> Result<(), String> {
    if let Ok(mut slot) = LAST_MANIFEST.lock() {
        *slot = Some(manifest.clone());
    }
    let dir = model_dir();
    for file in &manifest.files {
        download_file(&app, file, &dir)?;
    }
    Ok(())
}

#[tauri::command]
pub fn kokoro_resume_download(app: tauri::AppHandle) -> Result<(), String> {
    let manifest = LAST_MANIFEST
        .lock()
        .ok()
        .and_then(|m| m.clone())
        .ok_or_else(|| "no_manifest".to_string())?;
    let dir = model_dir();
    for file in &manifest.files {
        download_file(&app, file, &dir)?;
    }
    Ok(())
}

#[tauri::command]
pub fn kokoro_delete_corrupt() -> Result<(), String> {
    let dir = model_dir();
    let manifest = LAST_MANIFEST.lock().ok().and_then(|m| m.clone());
    if let Some(manifest) = manifest {
        for f in &manifest.files {
            let p = dir.join(&f.name);
            if p.exists() && !verify_one(&p, f) {
                let _ = fs::remove_file(&p);
            }
            let part = dir.join(format!("{}.part", f.name));
            if part.exists() {
                let _ = fs::remove_file(&part);
            }
        }
    }
    Ok(())
}

#[tauri::command]
pub fn kokoro_repair(app: tauri::AppHandle) -> Result<(), String> {
    kokoro_delete_corrupt()?;
    kokoro_resume_download(app)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeakResult {
    audio: String,
    mime: String,
}

#[tauri::command]
pub fn kokoro_speak(_text: String, _voice: String, _speed: f32) -> Result<SpeakResult, String> {
    // ONNX runtime + Kokoro weights not bundled yet: return a structured error
    // that the frontend maps to an automatic system-TTS fallback. Do NOT fake
    // audio output.
    Err("engine_not_available".to_string())
}

#[tauri::command]
pub fn kokoro_stop() {
    // No persistent local synthesis process to stop yet.
}
