use serde::Serialize;
use std::path::PathBuf;
use std::process::{Command, Stdio};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OllamaInstallationStatus {
    installed: bool,
    version: Option<String>,
    executable: Option<String>,
    detail: Option<String>,
}

fn ollama_candidates() -> Vec<PathBuf> {
    let mut candidates = vec![PathBuf::from("ollama")];

    if let Some(local_app_data) = std::env::var_os("LOCALAPPDATA") {
        let root = PathBuf::from(local_app_data);
        candidates.push(root.join("Programs").join("Ollama").join("ollama.exe"));
        candidates.push(root.join("Ollama").join("ollama.exe"));
    }

    if let Some(program_files) = std::env::var_os("ProgramFiles") {
        candidates.push(
            PathBuf::from(program_files)
                .join("Ollama")
                .join("ollama.exe"),
        );
    }

    candidates
}

fn hidden_command(executable: &PathBuf) -> Command {
    let mut command = Command::new(executable);
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);
    command
}

fn find_ollama() -> Result<(PathBuf, String), String> {
    let mut last_error = None;
    for candidate in ollama_candidates() {
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

    Err(last_error.unwrap_or_else(|| "Ollama executable was not found".to_string()))
}

#[tauri::command]
pub fn ollama_installation_status() -> OllamaInstallationStatus {
    match find_ollama() {
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

#[tauri::command]
pub fn ollama_start() -> Result<(), String> {
    let (executable, _) = find_ollama()?;
    hidden_command(&executable)
        .arg("serve")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map(|_| ())
        .map_err(|err| format!("Could not start Ollama: {err}"))
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
