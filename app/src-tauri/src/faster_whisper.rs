//! Local faster-whisper STT: model download + offline transcription for composer dictation.
//!
//! Models are cached under the OS-stable VibeSpace directory. Transcription uses a
//! managed Python venv with `faster-whisper` when Python is available on the host.

use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

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
    Base,
    Small,
    LargeV3,
}

impl ModelId {
    fn from_str(s: &str) -> Option<Self> {
        match s {
            "tiny" => Some(Self::Tiny),
            // Product catalog labels map onto Systran CTranslate2 packs.
            "base" | "base.en" | "whisper-base-en-q5" => Some(Self::Base),
            "small" | "small.en" | "whisper-small-en-q8" => Some(Self::Small),
            "large-v3" => Some(Self::LargeV3),
            _ => None,
        }
    }

    fn repo(&self) -> &'static str {
        match self {
            Self::Tiny => "faster-whisper-tiny",
            Self::Base => "faster-whisper-base.en",
            Self::Small => "faster-whisper-small.en",
            Self::LargeV3 => "faster-whisper-large-v3",
        }
    }

    fn dir_name(&self) -> &'static str {
        match self {
            Self::Tiny => "tiny",
            Self::Base => "base",
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
        home.join(".local")
            .join("share")
            .join("VibeSpace")
            .join("venvs")
            .join("faster-whisper")
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
        ModelId::Base => (145_000_000_u64, ""),
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
                name: "vocabulary.txt".into(),
                url: format!("{base}/vocabulary.txt"),
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
    let exists = python.exists();
    ensure_python_venv_with(
        python,
        exists,
        || create_python_venv(&venv_dir()),
        python_venv_package_ready,
        install_faster_whisper,
    )
}

// A venv can survive a failed/interrupted pip install. Interpreter presence alone
// is not package readiness; retry only when the probe explicitly reports absence.
fn ensure_python_venv_with(
    python: PathBuf,
    exists: bool,
    create: impl FnOnce() -> Result<(), String>,
    mut package_ready: impl FnMut(&Path) -> Result<bool, String>,
    install: impl FnOnce(&Path) -> Result<(), String>,
) -> Result<PathBuf, String> {
    if !exists {
        create()?;
    }
    if package_ready(&python)? {
        return Ok(python);
    }
    install(&python)?;
    if !package_ready(&python)? {
        return Err("faster-whisper package is unavailable after installation.".to_string());
    }
    Ok(python)
}

// Finding the top-level package does not import faster-whisper or load a model.
// A distinct missing-package exit code keeps interpreter/probe failures from
// silently initiating an installation.
const PYTHON_VENV_PROBE: &str = r#"
import importlib.util
import sys
sys.exit(0 if importlib.util.find_spec("faster_whisper") is not None else 42)
"#;

fn python_venv_probe_result(code: Option<i32>) -> Result<bool, String> {
    match code {
        Some(0) => Ok(true),
        Some(42) => Ok(false),
        _ => Err("Could not verify faster-whisper package readiness.".to_string()),
    }
}

fn python_venv_package_ready(python: &Path) -> Result<bool, String> {
    let mut child = hidden_command(python.to_str().unwrap_or("python"))
        .args(["-c", PYTHON_VENV_PROBE])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| format!("Could not check faster-whisper package readiness: {error}"))?;
    wait_python_venv_probe(&mut child, Duration::from_secs(5))
}

fn wait_python_venv_probe(child: &mut Child, timeout: Duration) -> Result<bool, String> {
    let started = Instant::now();
    let failure = loop {
        match child.try_wait() {
            Ok(Some(status)) => return python_venv_probe_result(status.code()),
            Ok(None) => {}
            Err(error) => break format!("Could not observe faster-whisper package probe: {error}"),
        }
        if started.elapsed() >= timeout {
            break "faster-whisper package readiness probe timed out.".to_string();
        }
        std::thread::sleep(Duration::from_millis(20).min(timeout.saturating_sub(started.elapsed())));
    };
    // Stop only the child created for this probe. try_wait also reaps it; never
    // turn a deadline into a second unbounded wait during cleanup.
    match stop_python_venv_probe(child) {
        Ok(()) => Err(failure),
        Err(cleanup) => Err(format!("{failure} {cleanup}")),
    }
}

fn stop_python_venv_probe(child: &mut Child) -> Result<(), String> {
    let kill_error = child.kill().err();
    let started = Instant::now();
    let timeout = Duration::from_secs(3);
    let mut wait_error = None;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => return Ok(()),
            Ok(None) => {}
            Err(error) => wait_error = Some(error),
        }
        if started.elapsed() >= timeout {
            return Err(format!(
                "Owned faster-whisper probe child {} cleanup remains pending (kill: {:?}; reap: {:?}).",
                child.id(),
                kill_error,
                wait_error,
            ));
        }
        std::thread::sleep(Duration::from_millis(20).min(timeout.saturating_sub(started.elapsed())));
    }
}

fn create_python_venv(vdir: &Path) -> Result<(), String> {
    let system = find_system_python().ok_or_else(|| {
        "Python 3 is required for faster-whisper transcription. Install Python 3 from python.org.".to_string()
    })?;
    fs::create_dir_all(vdir.parent().unwrap_or(vdir)).map_err(|e| e.to_string())?;

    let mut create = hidden_command(&system);
    if system == "py" {
        create.arg("-3");
    }
    create.args(["-m", "venv"]);
    create.arg(vdir);
    let status = create
        .status()
        .map_err(|e| format!("Could not create Python venv: {e}"))?;
    if !status.success() {
        return Err("Could not create Python venv for faster-whisper.".to_string());
    }
    Ok(())
}

fn install_faster_whisper(python: &Path) -> Result<(), String> {
    let mut pip = hidden_command(python.to_str().unwrap_or("python"));
    pip.args(["-m", "pip", "install", "--upgrade", "pip", "faster-whisper"]);
    let pip_status = pip
        .status()
        .map_err(|e| format!("Could not install faster-whisper: {e}"))?;
    if !pip_status.success() {
        return Err(
            "pip install faster-whisper failed. Check your network connection and try again."
                .to_string(),
        );
    }
    Ok(())
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

struct TranscriptionTempDir(PathBuf);

impl Drop for TranscriptionTempDir {
    fn drop(&mut self) {
        // The directory contains the request audio. Best-effort cleanup must run on every
        // post-creation error path, including Python/venv startup failures.
        let _ = fs::remove_dir_all(&self.0);
    }
}

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
pub fn faster_whisper_remove(model: String) -> Result<(), String> {
    let id = ModelId::from_str(&model).ok_or_else(|| format!("unknown model: {model}"))?;
    let dir = model_dir(id);
    if dir.exists() {
        fs::remove_dir_all(&dir).map_err(|e| format!("Could not remove model files: {e}"))?;
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

    let temp_path = std::env::temp_dir().join(format!("vibespace-stt-{}", nanoid::nanoid!(8)));
    fs::create_dir_all(&temp_path).map_err(|e| e.to_string())?;
    let temp_dir = TranscriptionTempDir(temp_path);
    let wav_path = temp_dir.0.join("dictation.wav");
    fs::write(&wav_path, &bytes).map_err(|e| e.to_string())?;

    transcribe_local_file(id, &wav_path)
}

pub(crate) fn faster_whisper_transcribe_file(
    model: &str,
    source_path: &Path,
) -> Result<String, String> {
    let id = ModelId::from_str(model).ok_or_else(|| format!("unknown model: {model}"))?;
    if !model_installed(id) {
        return Err(format!(
            "faster-whisper model '{}' is not downloaded. Open Settings → Speech to Text to download it.",
            id.dir_name()
        ));
    }
    transcribe_local_file(id, source_path)
}

fn transcribe_local_file(id: ModelId, source_path: &Path) -> Result<String, String> {
    let source_path = source_path
        .canonicalize()
        .map_err(|error| format!("Could not open local transcription source: {error}"))?;
    if !source_path.is_file() {
        return Err("Local transcription source is not a regular file.".into());
    }

    let python = ensure_python_venv()?;
    let script_root =
        std::env::temp_dir().join(format!("vibespace-stt-script-{}", nanoid::nanoid!(8)));
    fs::create_dir_all(&script_root).map_err(|e| e.to_string())?;
    let script_dir = TranscriptionTempDir(script_root);
    let script_path = script_dir.0.join("transcribe.py");
    fs::write(&script_path, TRANSCRIBE_SCRIPT).map_err(|e| e.to_string())?;

    let output = hidden_command(python.to_str().unwrap_or("python"))
        .arg(&script_path)
        .arg(model_dir(id))
        .arg(&source_path)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .map_err(|e| format!("faster-whisper process failed: {e}"))?;

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

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::{Cell, RefCell};

    fn fixture_python() -> PathBuf {
        PathBuf::from("fixture-venv/Scripts/python.exe")
    }

    #[test]
    fn python_venv_reuses_a_ready_interpreter_without_installing() {
        let python = fixture_python();
        let checks = Cell::new(0);
        let result = ensure_python_venv_with(
            python.clone(),
            true,
            || panic!("healthy venv must not be recreated"),
            |path| {
                assert_eq!(path, python.as_path());
                checks.set(checks.get() + 1);
                Ok(true)
            },
            |_| panic!("healthy venv must not reinstall packages"),
        );
        assert_eq!(result, Ok(python));
        assert_eq!(checks.get(), 1);
    }

    #[test]
    fn python_venv_first_install_rechecks_readiness() {
        let events = RefCell::new(Vec::new());
        let ready = Cell::new(false);
        let python = fixture_python();
        let result = ensure_python_venv_with(
            python.clone(),
            false,
            || {
                events.borrow_mut().push("create");
                Ok(())
            },
            |path| {
                assert_eq!(path, python.as_path());
                events.borrow_mut().push("probe");
                Ok(ready.get())
            },
            |path| {
                assert_eq!(path, python.as_path());
                events.borrow_mut().push("install");
                ready.set(true);
                Ok(())
            },
        );
        assert_eq!(result, Ok(python));
        assert_eq!(*events.borrow(), ["create", "probe", "install", "probe"]);
    }

    #[test]
    fn python_venv_failed_install_retries_without_recreating_the_interpreter() {
        let exists = Cell::new(false);
        let ready = Cell::new(false);
        let creations = Cell::new(0);
        let installs = Cell::new(0);
        let probes = Cell::new(0);
        let python = fixture_python();
        let attempt = || {
            ensure_python_venv_with(
                python.clone(),
                exists.get(),
                || {
                    creations.set(creations.get() + 1);
                    exists.set(true);
                    Ok(())
                },
                |path| {
                    assert_eq!(path, python.as_path());
                    probes.set(probes.get() + 1);
                    Ok(ready.get())
                },
                |path| {
                    assert_eq!(path, python.as_path());
                    installs.set(installs.get() + 1);
                    if installs.get() == 1 {
                        return Err("interrupted installation".to_string());
                    }
                    ready.set(true);
                    Ok(())
                },
            )
        };
        assert_eq!(attempt(), Err("interrupted installation".to_string()));
        assert!(exists.get());
        assert!(!ready.get());
        assert_eq!(installs.get(), 1, "no retry inside the failed request");
        assert_eq!(attempt(), Ok(python.clone()));
        assert!(ready.get(), "retry must prepare the missing package");
        assert_eq!(creations.get(), 1);
        assert_eq!(installs.get(), 2);
        assert_eq!(probes.get(), 3);
    }

    #[test]
    fn python_venv_probe_failure_does_not_start_installation() {
        let result = ensure_python_venv_with(
            fixture_python(),
            true,
            || panic!("existing venv must not be recreated"),
            |_| Err("probe process interrupted".to_string()),
            |_| panic!("probe errors must not authorize installation"),
        );
        assert_eq!(result, Err("probe process interrupted".to_string()));
    }

    #[test]
    fn python_venv_successful_installer_must_leave_a_ready_package() {
        let installs = Cell::new(0);
        let probes = Cell::new(0);
        let result = ensure_python_venv_with(
            fixture_python(),
            true,
            || panic!("existing venv must not be recreated"),
            |_| {
                probes.set(probes.get() + 1);
                Ok(false)
            },
            |_| {
                installs.set(installs.get() + 1);
                Ok(())
            },
        );
        assert_eq!(
            result,
            Err("faster-whisper package is unavailable after installation.".to_string())
        );
        assert_eq!(installs.get(), 1);
        assert_eq!(probes.get(), 2);
    }

    #[test]
    fn python_venv_creation_failure_stops_before_other_commands() {
        let result = ensure_python_venv_with(
            fixture_python(),
            false,
            || Err("venv creation interrupted".to_string()),
            |_| panic!("failed creation must not probe"),
            |_| panic!("failed creation must not install"),
        );
        assert_eq!(result, Err("venv creation interrupted".to_string()));
    }

    #[test]
    fn python_venv_probe_exit_distinguishes_missing_package_from_failure() {
        assert_eq!(python_venv_probe_result(Some(0)), Ok(true));
        assert_eq!(python_venv_probe_result(Some(42)), Ok(false));
        for code in [Some(1), Some(2), Some(130), None] {
            assert!(python_venv_probe_result(code).is_err());
        }
    }

    // Invoked only as an owned child by the lifecycle cases below. It performs
    // no package import, installation, model work or network operation.
    #[test]
    #[ignore = "owned inert subprocess fixture; not a standalone test"]
    fn python_venv_probe_fixture_child() {
        let mode = std::env::var("VIBESPACE_VENV_PROBE_TEST_MODE")
            .expect("probe fixture mode must be explicit");
        if let Some(marker) = std::env::var_os("VIBESPACE_VENV_PROBE_TEST_CHILD_PID") {
            fs::write(marker, std::process::id().to_string()).unwrap();
        }
        match mode.as_str() {
            "present" => std::process::exit(0),
            "missing" => std::process::exit(42),
            "failed" => std::process::exit(1),
            "hang" => {
                std::thread::sleep(Duration::from_secs(30));
                std::process::exit(99);
            }
            _ => panic!("unknown probe fixture mode"),
        }
    }

    fn spawn_python_venv_probe_fixture(mode: &str) -> Child {
        // libtest names omit the crate prefix in module_path!().
        let module = module_path!().split_once("::").unwrap().1;
        let fixture = format!("{module}::python_venv_probe_fixture_child");
        Command::new(std::env::current_exe().unwrap())
            .args(["--exact", &fixture, "--ignored", "--nocapture"])
            .env("VIBESPACE_VENV_PROBE_TEST_MODE", mode)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap()
    }

    #[test]
    fn python_venv_probe_observes_real_owned_child_exit_codes() {
        for (mode, expected) in [("present", Some(true)), ("missing", Some(false)), ("failed", None)] {
            let mut child = spawn_python_venv_probe_fixture(mode);
            let result = wait_python_venv_probe(&mut child, Duration::from_secs(5));
            match expected {
                Some(value) => assert_eq!(result, Ok(value)),
                None => assert!(result.is_err()),
            }
            assert!(child.try_wait().unwrap().is_some());
        }
    }

    #[test]
    fn python_venv_probe_timeout_kills_and_reaps_only_its_owned_child() {
        let mut child = spawn_python_venv_probe_fixture("hang");
        let pid = child.id();
        let started = Instant::now();
        let result = ensure_python_venv_with(
            fixture_python(),
            true,
            || panic!("existing venv must not be recreated"),
            |_| wait_python_venv_probe(&mut child, Duration::from_millis(100)),
            |_| panic!("timed-out probe must not trigger installation"),
        );
        assert!(result.unwrap_err().contains("timed out"));
        assert!(started.elapsed() < Duration::from_secs(5));
        // On Linux inspect before a second try_wait could hide a missed reap.
        #[cfg(target_os = "linux")]
        assert!(!PathBuf::from(format!("/proc/{pid}")).exists());
        #[cfg(not(target_os = "linux"))]
        let _ = pid;
        assert!(child.try_wait().unwrap().is_some());
    }

    #[test]
    fn python_venv_probe_cancelled_child_cannot_trigger_installation() {
        let mut child = spawn_python_venv_probe_fixture("hang");
        child.kill().unwrap();
        let result = ensure_python_venv_with(
            fixture_python(),
            true,
            || panic!("existing venv must not be recreated"),
            |_| wait_python_venv_probe(&mut child, Duration::from_secs(5)),
            |_| panic!("cancelled probe must not trigger installation"),
        );
        assert!(result.is_err());
        assert!(child.try_wait().unwrap().is_some());
    }

    #[test]
    fn local_file_transcription_rejects_missing_sources_before_process_launch() {
        let missing = std::env::temp_dir().join(format!(
            "vibespace-missing-transcription-source-{}.wav",
            nanoid::nanoid!(8)
        ));
        let error = transcribe_local_file(ModelId::Base, &missing).unwrap_err();
        assert!(error.contains("Could not open local transcription source"));
    }
}
