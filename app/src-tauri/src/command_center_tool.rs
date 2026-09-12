//! Secure lifecycle for the preloaded Codex Command Center tool.
//!
//! The renderer supplies release metadata baked into the VibeSpace build, but
//! native code owns every filesystem and process action. Install and launch
//! never accept arbitrary local paths.

use reqwest::blocking::Client;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;
use tauri::{Emitter, Manager};
use url::Url;

const MAX_INSTALLER_BYTES: u64 = 256 * 1024 * 1024;
static DOWNLOAD_CANCELLED: AtomicBool = AtomicBool::new(false);

#[derive(Debug, Deserialize)]
#[serde(tag = "action", rename_all = "snake_case")]
pub enum CommandCenterToolRequest {
    Inspect,
    Download {
        url: String,
        sha256: String,
        version: String,
    },
    Install {
        sha256: String,
        version: String,
    },
    Launch,
    CancelDownload,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandCenterToolState {
    installed: bool,
    executable_path: Option<String>,
    installer_ready: bool,
    phase: &'static str,
    detail: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DownloadProgress {
    received_bytes: u64,
    total_bytes: Option<u64>,
}

fn safe_release_value(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'_'))
}

fn valid_sha256(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn valid_download_url(value: &str) -> bool {
    Url::parse(value)
        .ok()
        .is_some_and(|url| url.scheme() == "https" && url.host_str().is_some())
}

fn tool_root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|root| root.join("tools").join("codex-command-center"))
        .map_err(|error| format!("Could not resolve the VibeSpace tool directory: {error}"))
}

fn installer_path(app: &tauri::AppHandle, version: &str) -> Result<PathBuf, String> {
    if !safe_release_value(version) {
        return Err("The Command Center release version is invalid.".into());
    }
    Ok(tool_root(app)?
        .join("downloads")
        .join(format!("CodexCommandCenter-{version}-Setup.exe")))
}

fn executable_candidates() -> Vec<PathBuf> {
    let mut paths = Vec::new();
    if let Some(local) = std::env::var_os("LOCALAPPDATA") {
        let local = PathBuf::from(local);
        paths.push(
            local
                .join("Programs")
                .join("Codex Command Center")
                .join("Codex Command Center.exe"),
        );
        paths.push(
            local
                .join("Codex Command Center")
                .join("Codex Command Center.exe"),
        );
    }
    if let Some(program_files) = std::env::var_os("ProgramFiles") {
        paths.push(
            PathBuf::from(program_files)
                .join("Codex Command Center")
                .join("Codex Command Center.exe"),
        );
    }
    paths
}

fn find_executable() -> Option<PathBuf> {
    executable_candidates()
        .into_iter()
        .find(|candidate| candidate.is_file())
}

fn has_downloaded_installer(app: &tauri::AppHandle) -> bool {
    tool_root(app)
        .ok()
        .and_then(|root| fs::read_dir(root.join("downloads")).ok())
        .is_some_and(|entries| {
            entries.filter_map(Result::ok).any(|entry| {
                entry.path().is_file()
                    && entry
                        .path()
                        .extension()
                        .and_then(|value| value.to_str())
                        .is_some_and(|extension| extension.eq_ignore_ascii_case("exe"))
            })
        })
}

fn sha256_file(path: &Path) -> Result<String, String> {
    let mut file = File::open(path)
        .map_err(|error| format!("Could not open the Command Center installer: {error}"))?;
    let mut digest = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|error| format!("Could not verify the Command Center installer: {error}"))?;
        if read == 0 {
            break;
        }
        digest.update(&buffer[..read]);
    }
    Ok(format!("{:x}", digest.finalize()))
}

fn inspect(app: &tauri::AppHandle) -> CommandCenterToolState {
    let executable = find_executable();
    CommandCenterToolState {
        installed: executable.is_some(),
        executable_path: executable.map(|path| path.to_string_lossy().into_owned()),
        installer_ready: has_downloaded_installer(app),
        phase: "idle",
        detail: None,
    }
}

fn download(
    app: &tauri::AppHandle,
    url: &str,
    expected_sha256: &str,
    version: &str,
) -> Result<CommandCenterToolState, String> {
    if !valid_download_url(url) {
        return Err("Command Center downloads require an HTTPS release URL.".into());
    }
    if !valid_sha256(expected_sha256) {
        return Err("The Command Center release checksum is invalid.".into());
    }
    let destination = installer_path(app, version)?;
    let parent = destination
        .parent()
        .ok_or_else(|| "The Command Center download path is invalid.".to_string())?;
    fs::create_dir_all(parent).map_err(|error| {
        format!("Could not create the Command Center download directory: {error}")
    })?;
    let partial = destination.with_extension("exe.part");
    let client = Client::builder()
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(30 * 60))
        .redirect(reqwest::redirect::Policy::limited(5))
        .build()
        .map_err(|error| format!("Could not prepare the Command Center download: {error}"))?;
    let mut response = client
        .get(url)
        .send()
        .map_err(|error| format!("Could not download Codex Command Center: {error}"))?;
    if !response.status().is_success() {
        return Err(format!(
            "Codex Command Center download failed with HTTP {}.",
            response.status().as_u16()
        ));
    }
    let total = response.content_length();
    if total.is_some_and(|bytes| bytes > MAX_INSTALLER_BYTES) {
        return Err("The Command Center installer exceeds the allowed download size.".into());
    }

    DOWNLOAD_CANCELLED.store(false, Ordering::SeqCst);
    let mut output = File::create(&partial)
        .map_err(|error| format!("Could not create the Command Center installer: {error}"))?;
    let mut received = 0_u64;
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        if DOWNLOAD_CANCELLED.load(Ordering::SeqCst) {
            drop(output);
            let _ = fs::remove_file(&partial);
            return Err("Command Center download cancelled.".into());
        }
        let read = response
            .read(&mut buffer)
            .map_err(|error| format!("Command Center download interrupted: {error}"))?;
        if read == 0 {
            break;
        }
        received = received.saturating_add(read as u64);
        if received > MAX_INSTALLER_BYTES {
            drop(output);
            let _ = fs::remove_file(&partial);
            return Err("The Command Center installer exceeds the allowed download size.".into());
        }
        output
            .write_all(&buffer[..read])
            .map_err(|error| format!("Could not save the Command Center installer: {error}"))?;
        let _ = app.emit(
            "command-center-tool-progress",
            DownloadProgress {
                received_bytes: received,
                total_bytes: total,
            },
        );
    }
    output
        .flush()
        .map_err(|error| format!("Could not finalize the Command Center installer: {error}"))?;
    drop(output);

    let actual = sha256_file(&partial)?;
    if !actual.eq_ignore_ascii_case(expected_sha256) {
        let _ = fs::remove_file(&partial);
        return Err("The downloaded Command Center installer failed checksum verification.".into());
    }
    fs::rename(&partial, &destination)
        .map_err(|error| format!("Could not finalize the Command Center installer: {error}"))?;

    Ok(CommandCenterToolState {
        installed: find_executable().is_some(),
        executable_path: find_executable().map(|path| path.to_string_lossy().into_owned()),
        installer_ready: true,
        phase: "downloaded",
        detail: Some("Installer downloaded and checksum verified.".into()),
    })
}

fn install(
    app: &tauri::AppHandle,
    expected_sha256: &str,
    version: &str,
) -> Result<CommandCenterToolState, String> {
    if !valid_sha256(expected_sha256) {
        return Err("The Command Center release checksum is invalid.".into());
    }
    let installer = installer_path(app, version)?;
    if !installer.is_file() || !sha256_file(&installer)?.eq_ignore_ascii_case(expected_sha256) {
        return Err("Download and verify Codex Command Center before installing it.".into());
    }
    Command::new(&installer)
        .spawn()
        .map_err(|error| format!("Could not open the Command Center installer: {error}"))?;
    Ok(CommandCenterToolState {
        installed: find_executable().is_some(),
        executable_path: find_executable().map(|path| path.to_string_lossy().into_owned()),
        installer_ready: true,
        phase: "installing",
        detail: Some("The verified installer is open. Complete the supported Windows flow.".into()),
    })
}

fn launch() -> Result<CommandCenterToolState, String> {
    let executable =
        find_executable().ok_or_else(|| "Codex Command Center is not installed.".to_string())?;
    Command::new(&executable)
        .spawn()
        .map_err(|error| format!("Could not launch Codex Command Center: {error}"))?;
    Ok(CommandCenterToolState {
        installed: true,
        executable_path: Some(executable.to_string_lossy().into_owned()),
        installer_ready: false,
        phase: "launched",
        detail: Some("Codex Command Center launched.".into()),
    })
}

#[tauri::command]
pub async fn command_center_tool(
    app: tauri::AppHandle,
    request: CommandCenterToolRequest,
) -> Result<CommandCenterToolState, String> {
    if matches!(request, CommandCenterToolRequest::CancelDownload) {
        DOWNLOAD_CANCELLED.store(true, Ordering::SeqCst);
        return Ok(inspect(&app));
    }
    tauri::async_runtime::spawn_blocking(move || match request {
        CommandCenterToolRequest::Inspect => Ok(inspect(&app)),
        CommandCenterToolRequest::Download {
            url,
            sha256,
            version,
        } => download(&app, &url, &sha256, &version),
        CommandCenterToolRequest::Install { sha256, version } => install(&app, &sha256, &version),
        CommandCenterToolRequest::Launch => launch(),
        CommandCenterToolRequest::CancelDownload => unreachable!(),
    })
    .await
    .map_err(|error| format!("Command Center tool operation failed: {error}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn release_authority_requires_https_checksum_and_safe_version() {
        assert!(valid_download_url(
            "https://github.com/vibespace/releases/download/v1/tool.exe"
        ));
        assert!(!valid_download_url("http://example.com/tool.exe"));
        assert!(!valid_download_url("file:///C:/tool.exe"));
        assert!(valid_sha256(&"a".repeat(64)));
        assert!(!valid_sha256(&"g".repeat(64)));
        assert!(safe_release_value("1.5.0-rc.1"));
        assert!(!safe_release_value("../escape"));
    }
}
