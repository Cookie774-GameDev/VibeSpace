//! Download lifecycle and local Piper inference for the Jarvis High voice.

use base64::Engine as _;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs::{self, File};
use std::io::{BufReader, Cursor, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use tauri::Emitter;

const MODEL_FILE: &str = "jarvis-high.onnx";
const CONFIG_FILE: &str = "jarvis-high.onnx.json";
const MODEL_BYTES: u64 = 114_199_011;
const CONFIG_BYTES: u64 = 7_262;
const MODEL_SHA256: &str = "9791877d9c099fabbf30be2825e011451c39b3431e21e81e866f5b6507e72993";
const CONFIG_SHA256: &str = "d0b8772d81c1da2fcdfd79e90bff027f46f040450e1deb89b43a9f6b1946c5a7";

static CANCEL_DOWNLOAD: AtomicBool = AtomicBool::new(false);
static LAST_MANIFEST: OnceLock<Mutex<Option<Manifest>>> = OnceLock::new();
#[cfg(feature = "jarvis-voice")]
static PIPER: OnceLock<Mutex<Option<piper_rs::Piper>>> = OnceLock::new();

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct ModelFile {
    name: String,
    url: String,
    sha256: String,
    size_bytes: u64,
    required: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    model: String,
    version: String,
    runtime: String,
    source_url: String,
    files: Vec<ModelFile>,
    voices: Vec<String>,
}

#[derive(Debug, Serialize)]
pub struct InstalledCheck {
    installed: bool,
    files: Vec<String>,
}

#[derive(Debug, Serialize)]
pub struct ChecksumResult {
    ok: bool,
    corrupt: Vec<String>,
}

#[derive(Debug, Serialize)]
pub struct ModelStatus {
    installed: bool,
    ready: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DownloadProgress {
    file: String,
    received_bytes: u64,
    total_bytes: u64,
    percent: f64,
}

#[derive(Debug, Serialize)]
pub struct SpeakResult {
    audio: String,
    mime: &'static str,
}

fn model_dir() -> PathBuf {
    #[cfg(target_os = "windows")]
    {
        let base = std::env::var_os("APPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(r"C:\Users\Default\AppData\Roaming"));
        return base.join("VibeSpace").join("models").join("jarvis-high");
    }
    #[cfg(target_os = "macos")]
    {
        let home = std::env::var_os("HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("/Users/Shared"));
        return home
            .join("Library")
            .join("Application Support")
            .join("VibeSpace")
            .join("models")
            .join("jarvis-high");
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let home = std::env::var_os("HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("/root"));
        home.join(".local")
            .join("share")
            .join("VibeSpace")
            .join("models")
            .join("jarvis-high")
    }
}

fn expected_file(name: &str) -> Option<(u64, &'static str)> {
    match name {
        MODEL_FILE => Some((MODEL_BYTES, MODEL_SHA256)),
        CONFIG_FILE => Some((CONFIG_BYTES, CONFIG_SHA256)),
        _ => None,
    }
}

fn sha256_file(path: &Path) -> Result<String, String> {
    let file = File::open(path).map_err(|error| error.to_string())?;
    let mut reader = BufReader::new(file);
    let mut digest = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let count = reader
            .read(&mut buffer)
            .map_err(|error| error.to_string())?;
        if count == 0 {
            break;
        }
        digest.update(&buffer[..count]);
    }
    Ok(format!("{:x}", digest.finalize()))
}

fn file_is_valid(path: &Path, expected_bytes: u64, expected_sha: &str) -> bool {
    fs::metadata(path)
        .map(|metadata| metadata.len() == expected_bytes)
        .unwrap_or(false)
        && sha256_file(path)
            .map(|actual| actual.eq_ignore_ascii_case(expected_sha))
            .unwrap_or(false)
}

fn validate_manifest(manifest: &Manifest) -> Result<(), String> {
    if manifest.model != "jarvis-high" || manifest.runtime != "piper" {
        return Err("invalid_jarvis_voice_manifest".into());
    }
    for required_name in [MODEL_FILE, CONFIG_FILE] {
        let file = manifest
            .files
            .iter()
            .find(|file| file.name == required_name && file.required)
            .ok_or_else(|| format!("missing_required_file:{required_name}"))?;
        let (bytes, sha) = expected_file(required_name).expect("known file");
        if file.size_bytes != bytes || !file.sha256.eq_ignore_ascii_case(sha) {
            return Err(format!("untrusted_file_metadata:{required_name}"));
        }
        let parsed = url::Url::parse(&file.url).map_err(|_| "invalid_model_url")?;
        if parsed.scheme() != "https" || parsed.host_str() != Some("huggingface.co") {
            return Err(format!("untrusted_model_url:{required_name}"));
        }
    }
    Ok(())
}

fn download_file(
    app: &tauri::AppHandle,
    client: &reqwest::blocking::Client,
    file: &ModelFile,
    destination: &Path,
) -> Result<(), String> {
    let partial = destination.with_extension(format!(
        "{}.part",
        destination
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or("")
    ));
    let _ = fs::remove_file(&partial);
    let mut response = client
        .get(&file.url)
        .send()
        .and_then(reqwest::blocking::Response::error_for_status)
        .map_err(|error| format!("download_failed:{}:{error}", file.name))?;
    let mut output = File::create(&partial).map_err(|error| error.to_string())?;
    let mut received = 0_u64;
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        if CANCEL_DOWNLOAD.load(Ordering::Relaxed) {
            let _ = fs::remove_file(&partial);
            return Err("download_cancelled".into());
        }
        let count = response
            .read(&mut buffer)
            .map_err(|error| error.to_string())?;
        if count == 0 {
            break;
        }
        output
            .write_all(&buffer[..count])
            .map_err(|error| error.to_string())?;
        received += count as u64;
        let _ = app.emit(
            "jarvis-voice:progress",
            DownloadProgress {
                file: file.name.clone(),
                received_bytes: received,
                total_bytes: file.size_bytes,
                percent: (received as f64 / file.size_bytes as f64 * 100.0).min(100.0),
            },
        );
    }
    output.sync_all().map_err(|error| error.to_string())?;
    if !file_is_valid(&partial, file.size_bytes, &file.sha256) {
        let _ = fs::remove_file(&partial);
        return Err(format!("checksum_mismatch:{}", file.name));
    }
    fs::rename(&partial, destination).map_err(|error| error.to_string())
}

fn install_manifest(app: &tauri::AppHandle, manifest: &Manifest) -> Result<(), String> {
    validate_manifest(manifest)?;
    CANCEL_DOWNLOAD.store(false, Ordering::Relaxed);
    let directory = model_dir();
    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(300))
        .build()
        .map_err(|error| error.to_string())?;
    for file in manifest.files.iter().filter(|file| file.required) {
        let destination = directory.join(&file.name);
        if file_is_valid(&destination, file.size_bytes, &file.sha256) {
            continue;
        }
        if destination.is_file() {
            fs::remove_file(&destination).map_err(|error| error.to_string())?;
        }
        download_file(app, &client, file, &destination)?;
    }
    #[cfg(feature = "jarvis-voice")]
    {
        *PIPER
            .get_or_init(|| Mutex::new(None))
            .lock()
            .map_err(|_| "voice_lock")? = None;
    }
    Ok(())
}

#[tauri::command]
pub fn jarvis_voice_model_path() -> String {
    model_dir().to_string_lossy().into_owned()
}

#[tauri::command]
pub fn jarvis_voice_check_installed() -> InstalledCheck {
    let directory = model_dir();
    let files = [MODEL_FILE, CONFIG_FILE]
        .into_iter()
        .filter(|name| directory.join(name).is_file())
        .map(str::to_owned)
        .collect::<Vec<_>>();
    InstalledCheck {
        installed: files.len() == 2,
        files,
    }
}

#[tauri::command]
pub fn jarvis_voice_verify_checksums() -> ChecksumResult {
    let directory = model_dir();
    let corrupt = [MODEL_FILE, CONFIG_FILE]
        .into_iter()
        .filter(|name| {
            let (bytes, sha) = expected_file(name).expect("known file");
            !file_is_valid(&directory.join(name), bytes, sha)
        })
        .map(str::to_owned)
        .collect::<Vec<_>>();
    ChecksumResult {
        ok: corrupt.is_empty(),
        corrupt,
    }
}

#[tauri::command]
pub fn jarvis_voice_status() -> ModelStatus {
    let installed = jarvis_voice_check_installed().installed;
    let verified = installed && jarvis_voice_verify_checksums().ok;
    ModelStatus {
        installed,
        ready: verified && cfg!(feature = "jarvis-voice"),
    }
}

#[tauri::command]
pub fn jarvis_voice_download(app: tauri::AppHandle, manifest: Manifest) -> Result<(), String> {
    *LAST_MANIFEST
        .get_or_init(|| Mutex::new(None))
        .lock()
        .map_err(|_| "manifest_lock")? = Some(manifest.clone());
    install_manifest(&app, &manifest)
}

#[tauri::command]
pub fn jarvis_voice_resume_download(app: tauri::AppHandle) -> Result<(), String> {
    let manifest = LAST_MANIFEST
        .get_or_init(|| Mutex::new(None))
        .lock()
        .map_err(|_| "manifest_lock")?
        .clone()
        .ok_or("manifest_unavailable")?;
    install_manifest(&app, &manifest)
}

#[tauri::command]
pub fn jarvis_voice_delete_corrupt() -> Result<(), String> {
    let directory = model_dir();
    for name in jarvis_voice_verify_checksums().corrupt {
        let path = directory.join(name);
        if path.is_file() {
            fs::remove_file(path).map_err(|error| error.to_string())?;
        }
    }
    Ok(())
}

#[tauri::command]
pub fn jarvis_voice_repair(app: tauri::AppHandle) -> Result<(), String> {
    jarvis_voice_delete_corrupt()?;
    jarvis_voice_resume_download(app)
}

#[tauri::command]
pub fn jarvis_voice_cancel_download() {
    CANCEL_DOWNLOAD.store(true, Ordering::Relaxed);
}

#[cfg(feature = "jarvis-voice")]
fn with_piper<T>(
    operation: impl FnOnce(&mut piper_rs::Piper) -> Result<T, String>,
) -> Result<T, String> {
    let mut guard = PIPER
        .get_or_init(|| Mutex::new(None))
        .lock()
        .map_err(|_| "voice_lock")?;
    if guard.is_none() {
        let directory = model_dir();
        *guard = Some(
            piper_rs::Piper::new(&directory.join(MODEL_FILE), &directory.join(CONFIG_FILE))
                .map_err(|error| error.to_string())?,
        );
    }
    operation(guard.as_mut().expect("initialized"))
}

#[tauri::command]
pub fn jarvis_voice_warmup() -> Result<(), String> {
    if !jarvis_voice_verify_checksums().ok {
        return Err("jarvis_voice_model_not_ready".into());
    }
    #[cfg(feature = "jarvis-voice")]
    with_piper(|_| Ok(()))?;
    #[cfg(not(feature = "jarvis-voice"))]
    return Err("jarvis_voice_engine_not_compiled".into());
    Ok(())
}

#[tauri::command]
pub fn jarvis_voice_speak(text: String, speed: f32) -> Result<SpeakResult, String> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Err("speech_text_empty".into());
    }
    #[cfg(feature = "jarvis-voice")]
    {
        let (samples, sample_rate) = with_piper(|piper| {
            piper
                .create(
                    trimmed,
                    false,
                    None,
                    Some(1.0 / speed.clamp(0.75, 1.35)),
                    None,
                    None,
                )
                .map_err(|error| error.to_string())
        })?;
        let mut bytes = Vec::new();
        let spec = hound::WavSpec {
            channels: 1,
            sample_rate,
            bits_per_sample: 16,
            sample_format: hound::SampleFormat::Int,
        };
        {
            let cursor = Cursor::new(&mut bytes);
            let mut writer =
                hound::WavWriter::new(cursor, spec).map_err(|error| error.to_string())?;
            for sample in samples {
                let pcm = (sample.clamp(-1.0, 1.0) * i16::MAX as f32) as i16;
                writer
                    .write_sample(pcm)
                    .map_err(|error| error.to_string())?;
            }
            writer.finalize().map_err(|error| error.to_string())?;
        }
        return Ok(SpeakResult {
            audio: base64::engine::general_purpose::STANDARD.encode(bytes),
            mime: "audio/wav",
        });
    }
    #[cfg(not(feature = "jarvis-voice"))]
    Err("jarvis_voice_engine_not_compiled".into())
}

#[tauri::command]
pub fn jarvis_voice_stop() {}

#[cfg(test)]
mod tests {
    use super::*;

    fn pinned_manifest() -> Manifest {
        Manifest {
            model: "jarvis-high".into(),
            version: "1.0.0".into(),
            runtime: "piper".into(),
            source_url:
                "https://huggingface.co/jgkawell/jarvis/tree/main/en/en_GB/jarvis/high".into(),
            files: vec![
                ModelFile {
                    name: MODEL_FILE.into(),
                    url: "https://huggingface.co/jgkawell/jarvis/resolve/main/en/en_GB/jarvis/high/jarvis-high.onnx".into(),
                    sha256: MODEL_SHA256.into(),
                    size_bytes: MODEL_BYTES,
                    required: true,
                },
                ModelFile {
                    name: CONFIG_FILE.into(),
                    url: "https://huggingface.co/jgkawell/jarvis/resolve/main/en/en_GB/jarvis/high/jarvis-high.onnx.json".into(),
                    sha256: CONFIG_SHA256.into(),
                    size_bytes: CONFIG_BYTES,
                    required: true,
                },
            ],
            voices: vec!["jarvis".into(), "friday".into()],
        }
    }

    #[test]
    fn accepts_only_the_pinned_upstream_artifacts() {
        assert!(validate_manifest(&pinned_manifest()).is_ok());
    }

    #[test]
    fn rejects_changed_model_metadata() {
        let mut manifest = pinned_manifest();
        manifest.files[0].sha256 = "0".repeat(64);
        assert_eq!(
            validate_manifest(&manifest),
            Err(format!("untrusted_file_metadata:{MODEL_FILE}")),
        );
    }
}
