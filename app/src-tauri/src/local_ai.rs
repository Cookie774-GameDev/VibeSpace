use reqwest::blocking::Client;
use serde::Serialize;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

const DEFAULT_OLLAMA_BASE: &str = "http://127.0.0.1:11434";
const API_HEALTH_TIMEOUT: Duration = Duration::from_secs(3);
const STARTUP_WAIT_TIMEOUT: Duration = Duration::from_secs(90);
const STARTUP_POLL_INTERVAL: Duration = Duration::from_millis(500);
const INSTALL_WAIT_TIMEOUT: Duration = Duration::from_secs(600);
const INSTALL_POLL_INTERVAL: Duration = Duration::from_secs(3);
const OLLAMA_WINDOWS_INSTALLER_URL: &str = "https://ollama.com/download/OllamaSetup.exe";

static STARTUP_MUTEX: OnceLock<Mutex<()>> = OnceLock::new();
static SERVE_CHILD: Mutex<Option<Child>> = Mutex::new(None);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OllamaInstallationStatus {
    installed: bool,
    version: Option<String>,
    executable: Option<String>,
    detail: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OllamaRunningStatus {
    running: bool,
    pids: Vec<u32>,
    listening_port_11434: bool,
    detail: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OllamaEnsureResult {
    ready: bool,
    api_reachable: bool,
    installed: bool,
    version: Option<String>,
    phase: String,
    detail: Option<String>,
}

fn startup_mutex() -> &'static Mutex<()> {
    STARTUP_MUTEX.get_or_init(|| Mutex::new(()))
}

fn hidden_command(executable: &Path) -> Command {
    // `mut` is only needed on Windows for creation_flags; cfg the binding so
    // the unix build doesn't warn about an unused `mut`.
    #[cfg_attr(not(windows), allow(unused_mut))]
    let mut command = Command::new(executable);
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);
    command
}

fn is_cli_candidate(candidate: &Path) -> bool {
    if candidate == Path::new("ollama") {
        return true;
    }

    let Some(name) = candidate.file_name().and_then(|value| value.to_str()) else {
        return false;
    };

    name.eq_ignore_ascii_case("ollama.exe") || name.eq_ignore_ascii_case("ollama")
}

#[cfg(windows)]
fn find_ollama_in_path() -> Option<PathBuf> {
    let output = Command::new("where")
        .arg("ollama")
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .ok()?;

    if !output.status.success() {
        return None;
    }

    String::from_utf8_lossy(&output.stdout)
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map(PathBuf::from)
        .filter(|path| is_cli_candidate(path))
}

#[cfg(not(windows))]
fn find_ollama_in_path() -> Option<PathBuf> {
    let output = Command::new("which").arg("ollama").output().ok()?;
    if !output.status.success() {
        return None;
    }

    String::from_utf8_lossy(&output.stdout)
        .lines()
        .next()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(PathBuf::from)
}

fn ollama_cli_candidates() -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    let mut seen = std::collections::HashSet::new();

    let mut push = |candidate: PathBuf| {
        if is_cli_candidate(&candidate) && seen.insert(candidate.clone()) {
            candidates.push(candidate);
        }
    };

    push(PathBuf::from("ollama"));

    if let Some(path_hit) = find_ollama_in_path() {
        push(path_hit);
    }

    if let Some(local_app_data) = std::env::var_os("LOCALAPPDATA") {
        let root = PathBuf::from(local_app_data);
        push(root.join("Programs").join("Ollama").join("ollama.exe"));
        push(root.join("Ollama").join("ollama.exe"));
    }

    if let Some(program_files) = std::env::var_os("ProgramFiles") {
        let pf = PathBuf::from(program_files);
        push(pf.join("Ollama").join("ollama.exe"));
    }

    #[cfg(target_os = "macos")]
    {
        push(PathBuf::from("/usr/local/bin/ollama"));
        push(PathBuf::from("/opt/homebrew/bin/ollama"));
        if let Some(home) = std::env::var_os("HOME") {
            push(PathBuf::from(home).join(".ollama").join("bin").join("ollama"));
        }
    }

    #[cfg(target_os = "linux")]
    {
        push(PathBuf::from("/usr/bin/ollama"));
        push(PathBuf::from("/usr/local/bin/ollama"));
        if let Some(home) = std::env::var_os("HOME") {
            push(PathBuf::from(home).join(".ollama").join("bin").join("ollama"));
        }
    }

    candidates
}

fn find_ollama_cli() -> Result<(PathBuf, String), String> {
    let mut last_error = None;

    for candidate in ollama_cli_candidates() {
        let output = hidden_command(&candidate).arg("--version").output();
        match output {
            Ok(output) if output.status.success() => {
                let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
                let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
                let version = if stdout.is_empty() { stderr } else { stdout };
                return Ok((candidate, version));
            }
            Ok(output) => {
                last_error = Some(format!("Ollama exited with {}", output.status));
            }
            Err(err) => {
                last_error = Some(err.to_string());
            }
        }
    }

    Err(last_error.unwrap_or_else(|| "Ollama CLI executable was not found".to_string()))
}

fn normalize_base_url(base_url: Option<String>) -> String {
    let trimmed = base_url
        .unwrap_or_else(|| DEFAULT_OLLAMA_BASE.to_string())
        .trim()
        .trim_end_matches('/')
        .to_string();

    if trimmed.is_empty() {
        DEFAULT_OLLAMA_BASE.to_string()
    } else {
        trimmed
    }
}

fn is_allowed_local_endpoint(base_url: &str) -> bool {
    let Ok(url) = reqwest::Url::parse(base_url) else {
        return false;
    };

    if url.scheme() != "http" {
        return false;
    }

    matches!(
        url.host_str(),
        Some("127.0.0.1") | Some("localhost") | Some("[::1]")
    )
}

fn check_ollama_api(base_url: &str, timeout: Duration) -> bool {
    if !is_allowed_local_endpoint(base_url) {
        return false;
    }

    let client = match Client::builder().timeout(timeout).build() {
        Ok(client) => client,
        Err(_) => return false,
    };

    client
        .get(format!("{base_url}/api/version"))
        .send()
        .map(|response| response.status().is_success())
        .unwrap_or(false)
}

fn wait_for_ollama_api(base_url: &str, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if check_ollama_api(base_url, API_HEALTH_TIMEOUT) {
            return true;
        }
        std::thread::sleep(STARTUP_POLL_INTERVAL);
    }
    false
}

fn port_11434_listening() -> bool {
    #[cfg(windows)]
    {
        Command::new("netstat")
            .args(["-ano"])
            .creation_flags(CREATE_NO_WINDOW)
            .output()
            .map(|output| {
                let stdout = String::from_utf8_lossy(&output.stdout);
                stdout.contains(":11434") && stdout.contains("LISTENING")
            })
            .unwrap_or(false)
    }

    #[cfg(not(windows))]
    {
        false
    }
}

#[cfg(windows)]
fn install_ollama_windows() -> Result<(), String> {
    let winget = hidden_command(Path::new("winget"))
        .args([
            "install",
            "-e",
            "--id",
            "Ollama.Ollama",
            "--silent",
            "--accept-package-agreements",
            "--accept-source-agreements",
        ])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();

    if winget.map(|status| status.success()).unwrap_or(false) {
        return Ok(());
    }

    let installer_path = std::env::temp_dir().join("OllamaSetup.exe");
    let client = Client::builder()
        .timeout(Duration::from_secs(600))
        .build()
        .map_err(|err| format!("Could not prepare Ollama installer download: {err}"))?;

    let mut response = client
        .get(OLLAMA_WINDOWS_INSTALLER_URL)
        .send()
        .map_err(|err| format!("Could not download Ollama installer: {err}"))?;

    if !response.status().is_success() {
        return Err(format!(
            "Ollama installer download failed with HTTP {}",
            response.status().as_u16()
        ));
    }

    let mut file = std::fs::File::create(&installer_path)
        .map_err(|err| format!("Could not write Ollama installer: {err}"))?;
    std::io::copy(&mut response, &mut file)
        .map_err(|err| format!("Could not save Ollama installer: {err}"))?;
    file.flush()
        .map_err(|err| format!("Could not finalize Ollama installer: {err}"))?;

    let status = hidden_command(&installer_path)
        .arg("/SILENT")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map_err(|err| format!("Could not run Ollama installer: {err}"))?;

    if !status.success() {
        return Err(format!(
            "Ollama installer exited with status {}",
            status.code().unwrap_or(-1)
        ));
    }

    Ok(())
}

#[cfg(not(windows))]
fn install_ollama_unix() -> Result<(), String> {
    let output = Command::new("sh")
        .arg("-c")
        .arg("curl -fsSL https://ollama.com/install.sh | sh")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .output()
        .map_err(|err| format!("Could not run Ollama install script: {err}"))?;

    if output.status.success() {
        return Ok(());
    }

    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    Err(if stderr.is_empty() {
        format!(
            "Ollama install script exited with status {}",
            output.status.code().unwrap_or(-1)
        )
    } else {
        stderr
    })
}

fn install_ollama_silent() -> Result<(), String> {
    #[cfg(windows)]
    {
        return install_ollama_windows();
    }
    #[cfg(not(windows))]
    {
        return install_ollama_unix();
    }
}

fn wait_for_ollama_cli_after_install() -> Result<(PathBuf, String), String> {
    let deadline = Instant::now() + INSTALL_WAIT_TIMEOUT;
    while Instant::now() < deadline {
        if let Ok(found) = find_ollama_cli() {
            return Ok(found);
        }
        std::thread::sleep(INSTALL_POLL_INTERVAL);
    }
    Err(
        "Ollama install finished but the CLI was not detected yet. Restart Jarvis and try again."
            .to_string(),
    )
}

fn start_ollama_serve_silent(executable: &Path) -> Result<(), String> {
    if port_11434_listening() {
        return Ok(());
    }

    {
        let child_guard = SERVE_CHILD.lock().map_err(|_| "Ollama startup lock poisoned".to_string())?;
        if child_guard.is_some() {
            return Ok(());
        }
    }

    let child = hidden_command(executable)
        .arg("serve")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|err| format!("Could not start Ollama server silently: {err}"))?;

    if let Ok(mut child_guard) = SERVE_CHILD.lock() {
        *child_guard = Some(child);
    }

    Ok(())
}

fn ensure_ollama_ready_internal(base_url: Option<String>) -> OllamaEnsureResult {
    let base = normalize_base_url(base_url);

    if !is_allowed_local_endpoint(&base) {
        return OllamaEnsureResult {
            ready: false,
            api_reachable: false,
            installed: false,
            version: None,
            phase: "error".to_string(),
            detail: Some(
                "Only localhost Ollama endpoints are allowed (127.0.0.1, localhost, [::1])."
                    .to_string(),
            ),
        };
    }

    if check_ollama_api(&base, API_HEALTH_TIMEOUT) {
        return OllamaEnsureResult {
            ready: true,
            api_reachable: true,
            installed: true,
            version: None,
            phase: "ready".to_string(),
            detail: Some("Ollama API is reachable.".to_string()),
        };
    }

    let Ok(_guard) = startup_mutex().lock() else {
        return OllamaEnsureResult {
            ready: false,
            api_reachable: false,
            installed: false,
            version: None,
            phase: "error".to_string(),
            detail: Some("Could not acquire Ollama startup lock.".to_string()),
        };
    };

    if check_ollama_api(&base, API_HEALTH_TIMEOUT) {
        return OllamaEnsureResult {
            ready: true,
            api_reachable: true,
            installed: true,
            version: None,
            phase: "ready".to_string(),
            detail: Some("Ollama API became reachable.".to_string()),
        };
    }

    let (executable, version) = match find_ollama_cli() {
        Ok(found) => found,
        Err(initial_detail) => {
            if let Err(install_err) = install_ollama_silent() {
                return OllamaEnsureResult {
                    ready: false,
                    api_reachable: false,
                    installed: false,
                    version: None,
                    phase: "not_installed".to_string(),
                    detail: Some(format!(
                        "{initial_detail} Automatic install failed: {install_err}"
                    )),
                };
            }

            match wait_for_ollama_cli_after_install() {
                Ok(found) => found,
                Err(detail) => {
                    return OllamaEnsureResult {
                        ready: false,
                        api_reachable: false,
                        installed: false,
                        version: None,
                        phase: "error".to_string(),
                        detail: Some(detail),
                    };
                }
            }
        }
    };

    if let Err(detail) = start_ollama_serve_silent(&executable) {
        return OllamaEnsureResult {
            ready: false,
            api_reachable: false,
            installed: true,
            version: Some(version),
            phase: "error".to_string(),
            detail: Some(detail),
        };
    }

    if wait_for_ollama_api(&base, STARTUP_WAIT_TIMEOUT) {
        return OllamaEnsureResult {
            ready: true,
            api_reachable: true,
            installed: true,
            version: Some(version),
            phase: "ready".to_string(),
            detail: Some("Ollama server started silently and API is reachable.".to_string()),
        };
    }

    OllamaEnsureResult {
        ready: false,
        api_reachable: false,
        installed: true,
        version: Some(version),
        phase: "error".to_string(),
        detail: Some(format!(
            "Ollama server was started silently but the API at {base}/api/version did not respond within {} seconds.",
            STARTUP_WAIT_TIMEOUT.as_secs()
        )),
    }
}

/// Check if any Ollama process is currently running on the system.
/// Prefer `ensure_ollama_ready` for actual connectivity — this is diagnostic only.
#[tauri::command]
pub fn is_ollama_running() -> OllamaRunningStatus {
    let api_reachable = check_ollama_api(DEFAULT_OLLAMA_BASE, API_HEALTH_TIMEOUT);

    #[cfg(windows)]
    {
        let output = Command::new("tasklist")
            .args(["/FI", "IMAGENAME eq ollama.exe", "/FO", "CSV", "/NH"])
            .creation_flags(CREATE_NO_WINDOW)
            .output();

        match output {
            Ok(out) if out.status.success() => {
                let stdout = String::from_utf8_lossy(&out.stdout);
                let pids: Vec<u32> = stdout
                    .lines()
                    .filter_map(|line| {
                        let parts: Vec<&str> = line.split(',').collect();
                        let pid_str = parts.get(1)?.trim().trim_matches('"');
                        pid_str.parse::<u32>().ok()
                    })
                    .collect();

                let port_check = port_11434_listening();
                let running = api_reachable || !pids.is_empty() || port_check;
                let detail = if api_reachable {
                    Some("Ollama API responded on /api/version.".into())
                } else if running {
                    Some("Ollama process or port detected, but API is not responding yet.".into())
                } else {
                    Some("No Ollama API response, process, or listening port found.".into())
                };

                OllamaRunningStatus {
                    running,
                    pids,
                    listening_port_11434: port_check,
                    detail,
                }
            }
            _ => OllamaRunningStatus {
                running: api_reachable,
                pids: vec![],
                listening_port_11434: port_11434_listening(),
                detail: Some("Could not query tasklist".into()),
            },
        }
    }

    #[cfg(not(windows))]
    {
        let output = Command::new("pgrep").args(["-f", "ollama serve"]).output();

        match output {
            Ok(out) if out.status.success() => {
                let stdout = String::from_utf8_lossy(&out.stdout);
                let pids: Vec<u32> = stdout.lines().filter_map(|l| l.trim().parse().ok()).collect();
                // Compute before the struct literal: `pids` is moved into the
                // `pids` field, so later fields can't borrow it (E0382).
                let detail = if api_reachable {
                    Some("Ollama API responded on /api/version.".into())
                } else if pids.is_empty() {
                    Some("No Ollama serve process found".into())
                } else {
                    None
                };
                OllamaRunningStatus {
                    running: api_reachable || !pids.is_empty(),
                    pids,
                    listening_port_11434: api_reachable,
                    detail,
                }
            }
            _ => OllamaRunningStatus {
                running: api_reachable,
                pids: vec![],
                listening_port_11434: api_reachable,
                detail: Some("Could not query pgrep".into()),
            },
        }
    }
}

#[tauri::command]
pub fn ollama_installation_status() -> OllamaInstallationStatus {
    match find_ollama_cli() {
        Ok((executable, version)) => OllamaInstallationStatus {
            installed: true,
            version: (!version.is_empty()).then_some(version),
            executable: Some(executable.to_string_lossy().to_string()),
            detail: None,
        },
        Err(detail) => OllamaInstallationStatus {
            installed: false,
            version: None,
            executable: None,
            detail: Some(detail),
        },
    }
}

/// Starts the Ollama background server silently via `ollama serve`.
/// Never launches the Ollama desktop GUI.
#[tauri::command]
pub fn ollama_start() -> Result<(), String> {
    let result = ensure_ollama_ready_internal(None);
    if result.ready {
        Ok(())
    } else {
        Err(result
            .detail
            .unwrap_or_else(|| "Could not start Ollama silently.".to_string()))
    }
}

/// API-first Ollama bootstrap: detect install, start `ollama serve` silently,
/// and wait until `/api/version` responds.
#[tauri::command]
pub fn ensure_ollama_ready(base_url: Option<String>) -> OllamaEnsureResult {
    ensure_ollama_ready_internal(base_url)
}

/// Manual troubleshooting only. Opens the Ollama desktop app if installed.
#[tauri::command]
pub fn open_ollama_troubleshooting() -> Result<(), String> {
    #[cfg(windows)]
    {
        let mut candidates = Vec::new();
        if let Some(local_app_data) = std::env::var_os("LOCALAPPDATA") {
            let root = PathBuf::from(local_app_data);
            candidates.push(root.join("Programs").join("Ollama").join("ollama app.exe"));
            candidates.push(root.join("Ollama").join("ollama app.exe"));
        }
        if let Some(program_files) = std::env::var_os("ProgramFiles") {
            candidates.push(PathBuf::from(program_files).join("Ollama").join("ollama app.exe"));
        }

        for app_exe in candidates {
            if app_exe.exists() {
                return Command::new(&app_exe)
                    .creation_flags(CREATE_NO_WINDOW)
                    .stdin(Stdio::null())
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .spawn()
                    .map(|_| ())
                    .map_err(|err| format!("Could not open Ollama troubleshooting app: {err}"));
            }
        }

        return Err(
            "Ollama desktop app was not found. Install Ollama from https://ollama.com/download."
                .to_string(),
        );
    }

    #[cfg(not(windows))]
    {
        Err("Open Ollama manually from your applications folder.".to_string())
    }
}

#[tauri::command]
pub fn open_system_speech_settings() -> Result<(), String> {
    #[cfg(windows)]
    {
        let mut command = Command::new("explorer.exe");
        command.creation_flags(CREATE_NO_WINDOW);
        command
            .arg("ms-settings:speech")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map(|_| ())
            .map_err(|err| format!("Could not open Windows speech settings: {err}"))
    }

    #[cfg(not(windows))]
    {
        Err("Open your operating system's accessibility or speech settings to install a local voice.".to_string())
    }
}
