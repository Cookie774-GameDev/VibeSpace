//! Local faster-whisper STT: model download + offline transcription for composer dictation.
//!
//! Models are cached under the OS-stable VibeSpace directory. Transcription uses a
//! managed Python venv with `faster-whisper` when Python is available on the host.

use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Mutex;

use base64::Engine;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::Emitter;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

const CHUNK: usize = 65_536;
const HF_BASE: &str = "https://huggingface.co/Systran";

static LAST_MANIFEST: Mutex<Option<Manifest>> = Mutex::new(None);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ModelId {
    Tiny,
    Small,
    LargeV3,
}

impl ModelId {
    fn from_str(s: &str) -> Option<Self> {
        match s {
            "tiny" => Some(Self::Tiny),
            "small" | "small.en" => Some(Self::Small),
            "large-v3" => Some(Self::LargeV3),
            _ => None,
        }
    }

    fn repo(&self) -> &'static str {
        match self {
            Self::Tiny => "faster-whisper-tiny",
            Self::Small => "faster-whisper-small.en",
            Self::LargeV3 => "faster-whisper-large-v3",
        }
    }

    fn dir_name(&self) -> &'static str {
        match self {
            Self::Tiny => "tiny",
            Self::Small => "small",
            Self::LargeV3 => "large-v3",
        }
    }
}

#[derive(Deserialize, Clone, Serialize)]
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

#[derive(Deserialize, Clone, Serialize)]
pub struct Manifest {
    model: String,
    files: Vec<ManifestFile>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledCheck {
    installed: bool,
    model: String,
    files: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelStatus {
    model: String,
    installed: bool,
    ready: bool,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct DownloadProgress {
    model: String,
    file: String,
    received_bytes: u64,
    total_bytes: u64,
    percent: f64,
}

fn models_root() -> PathBuf {
    #[cfg(target_os = "windows")]
    {
        let base = std::env::var_os("APPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("."));
        base.join("VibeSpace").join("models").join("faster-whisper")
    }
    #[cfg(target_os = "macos")]
    {
        let home = std::env::var_os("HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("."));
        home.join("Library")
            .join("Application Support")
            .join("VibeSpace")
            .join("models")
            .join("faster-whisper")
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        let home = std::env::var_os("HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("."));
        home.join(".local")
            .join("share")
            .join("VibeSpace")
            .join("models")
            .join("faster-whisper")
    }
}

fn model_dir(id: ModelId) -> PathBuf {
    models_root().join(id.dir_name())
}

fn venv_dir() -> PathBuf {
    #[cfg(target_os = "windows")]
    {
        let base = std::env::var_os("LOCALAPPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("."));
        base.join("VibeSpace").join("venvs").join("faster-whisper")
    }
    #[cfg(not(target_os = "windows"))]
    {
        let home = std::env::var_os("HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("."));
        home.join(".local").join("share").join("VibeSpace").join("venvs").join("faster-whisper")
    }
}

fn venv_python() -> PathBuf {
    #[cfg(windows)]
    {
        venv_dir().join("Scripts").join("python.exe")
    }
    #[cfg(not(windows))]
    {
        venv_dir().join("bin").join("python3")
    }
}

fn hidden_command(program: &str) -> Command {
    #[cfg_attr(not(windows), allow(unused_mut))]
    let mut command = Command::new(program);
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);
    command
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

fn verify_one(path: &Path, file: &ManifestFile) -> bool {
    if !path.exists() {
        return false;
    }
    if file.sha256.is_empty() {
        return true;
    }
    sha256_file(path)
        .map(|h| h.eq_ignore_ascii_case(&file.sha256))
        .unwrap_or(false)
}

fn default_manifest(id: ModelId) -> Manifest {
    let repo = id.repo();
    let base = format!("{HF_BASE}/{repo}/resolve/main");
    let (model_bin_size, model_bin_sha) = match id {
        ModelId::Tiny => (75_389_248_u64, ""),
        ModelId::Small => (484_440_064_u64, ""),
        ModelId::LargeV3 => (3_094_963_200_u64, ""),
    };
    Manifest {
        model: id.dir_name().to_string(),
        files: vec![
            ManifestFile {
                name: "config.json".into(),
                url: format!("{base}/config.json"),
                sha256: String::new(),
                size_bytes: 2_000,
                required: true,
            },
            ManifestFile {
                name: "tokenizer.json".into(),
                url: format!("{base}/tokenizer.json"),
                sha256: String::new(),
                size_bytes: 2_200_000,
                required: true,
            },
            ManifestFile {
                name: "vocabulary.json".into(),
                url: format!("{base}/vocabulary.json"),
                sha256: String::new(),
                size_bytes: 1_100_000,
                required: true,
            },
            ManifestFile {
                name: "model.bin".into(),
                url: format!("{base}/model.bin"),
                sha256: model_bin_sha.into(),
                size_bytes: model_bin_size,
                required: true,
            },
        ],
    }
}

fn model_installed(id: ModelId) -> bool {
    let dir = model_dir(id);
    default_manifest(id)
        .files
        .iter()
        .filter(|f| f.required)
        .all(|f| dir.join(&f.name).exists())
}

fn download_file(
    app: &tauri::AppHandle,
    model: &str,
    file: &ManifestFile,
    dir: &Path,
) -> Result<(), String> {
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
            "faster-whisper:progress",
            DownloadProgress {
                model: model.to_string(),
                file: file.name.clone(),
                received_bytes: received,
                total_bytes: total,
                percent,
            },
        );
    }
    drop(out);

    if !file.sha256.is_empty() && !verify_one(&part_path, file) {
        let _ = fs::remove_file(&part_path);
        return Err("checksum_mismatch".into());
    }
    fs::rename(&part_path, &final_path).map_err(|e| e.to_string())?;
    Ok(())
}

fn resolve_manifest(model: &str) -> Result<Manifest, String> {
    if let Ok(guard) = LAST_MANIFEST.lock() {
        if let Some(m) = guard.as_ref() {
            if m.model == model {
                return Ok(m.clone());
            }
        }
    }
    let id = ModelId::from_str(model).ok_or_else(|| format!("unknown model: {model}"))?;
    let manifest = default_manifest(id);
    if let Ok(mut guard) = LAST_MANIFEST.lock() {
        *guard = Some(manifest.clone());
    }
    Ok(manifest)
}

fn find_system_python() -> Option<String> {
    for candidate in ["python3", "python", "py"] {
        let mut cmd = hidden_command(candidate);
        if candidate == "py" {
            cmd.arg("-3");
        }
        cmd.arg("--version");
        if cmd.output().map(|o| o.status.success()).unwrap_or(false) {
            return Some(candidate.to_string());
        }
    }
    None
}

fn ensure_python_venv() -> Result<PathBuf, String> {
    let python = venv_python();
    if python.exists() {
        return Ok(python);
    }
    let system = find_system_python().ok_or_else(|| {
        "Python 3 is required for faster-whisper transcription. Install Python 3 from python.org.".to_string()
    })?;
    let vdir = venv_dir();
    fs::create_dir_all(vdir.parent().unwrap_or(&vdir)).map_err(|e| e.to_string())?;

    let mut create = hidden_command(&system);
    if system == "py" {
        create.arg("-3");
    }
    create.args(["-m", "venv"]);
    create.arg(&vdir);
    let status = create
        .status()
        .map_err(|e| format!("Could not create Python venv: {e}"))?;
    if !status.success() {
        return Err("Could not create Python venv for faster-whisper.".to_string());
    }

    let mut pip = hidden_command(python.to_str().unwrap_or("python"));
    pip.args(["-m", "pip", "install", "--upgrade", "pip", "faster-whisper"]);
    let pip_status = pip
        .status()
        .map_err(|e| format!("Could not install faster-whisper: {e}"))?;
    if !pip_status.success() {
        return Err(
            "pip install faster-whisper failed. Check your network connection and try again.".to_string(),
        );
    }
    Ok(python)
}

const TRANSCRIBE_SCRIPT: &str = r#"
import sys
from faster_whisper import WhisperModel

model_path, wav_path = sys.argv[1], sys.argv[2]
model = WhisperModel(model_path, device="cpu", compute_type="int8")
segments, _ = model.transcribe(wav_path, beam_size=1, vad_filter=True)
text = "".join(segment.text for segment in segments).strip()
print(text, end="")
"#;

#[tauri::command]
pub fn faster_whisper_model_path(model: String) -> Result<String, String> {
    let id = ModelId::from_str(&model).ok_or_else(|| format!("unknown model: {model}"))?;
    Ok(model_dir(id).to_string_lossy().into_owned())
}

#[tauri::command]
pub fn faster_whisper_check_installed(model: String) -> Result<InstalledCheck, String> {
    let id = ModelId::from_str(&model).ok_or_else(|| format!("unknown model: {model}"))?;
    let dir = model_dir(id);
    let files: Vec<String> = default_manifest(id)
        .files
        .iter()
        .filter(|f| dir.join(&f.name).exists())
        .map(|f| f.name.clone())
        .collect();
    Ok(InstalledCheck {
        installed: model_installed(id),
        model: id.dir_name().to_string(),
        files,
    })
}

#[tauri::command]
pub fn faster_whisper_status(model: String) -> Result<ModelStatus, String> {
    let id = ModelId::from_str(&model).ok_or_else(|| format!("unknown model: {model}"))?;
    let installed = model_installed(id);
    Ok(ModelStatus {
        model: id.dir_name().to_string(),
        installed,
        ready: installed,
    })
}

#[tauri::command]
pub fn faster_whisper_download(
    app: tauri::AppHandle,
    model: String,
    manifest: Option<Manifest>,
) -> Result<(), String> {
    let id = ModelId::from_str(&model).ok_or_else(|| format!("unknown model: {model}"))?;
    let manifest = manifest.unwrap_or_else(|| default_manifest(id));
    if let Ok(mut guard) = LAST_MANIFEST.lock() {
        *guard = Some(manifest.clone());
    }
    let dir = model_dir(id);
    for file in &manifest.files {
        if file.required {
            download_file(&app, id.dir_name(), file, &dir)?;
        }
    }
    Ok(())
}

#[tauri::command]
pub fn faster_whisper_transcribe(model: String, audio_base64: String) -> Result<String, String> {
    let id = ModelId::from_str(&model).ok_or_else(|| format!("unknown model: {model}"))?;
    if !model_installed(id) {
        return Err(format!(
            "faster-whisper model '{}' is not downloaded. Open Settings → Speech to Text to download it.",
            id.dir_name()
        ));
    }

    let bytes = base64::engine::general_purpose::STANDARD
        .decode(audio_base64.trim())
        .map_err(|e| format!("invalid audio payload: {e}"))?;
    if bytes.is_empty() {
        return Ok(String::new());
    }

    let temp_dir = std::env::temp_dir().join(format!("vibespace-stt-{}", nanoid::nanoid!(8)));
    fs::create_dir_all(&temp_dir).map_err(|e| e.to_string())?;
    let wav_path = temp_dir.join("dictation.wav");
    fs::write(&wav_path, &bytes).map_err(|e| e.to_string())?;

    let python = ensure_python_venv()?;
    let script_path = temp_dir.join("transcribe.py");
    fs::write(&script_path, TRANSCRIBE_SCRIPT).map_err(|e| e.to_string())?;

    let output = hidden_command(python.to_str().unwrap_or("python"))
        .arg(&script_path)
        .arg(model_dir(id))
        .arg(&wav_path)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .map_err(|e| format!("faster-whisper process failed: {e}"))?;

    let _ = fs::remove_dir_all(&temp_dir);

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "faster-whisper transcription failed: {}",
            stderr.trim().chars().take(240).collect::<String>()
        ));
    }

    let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
    Ok(text)
}
