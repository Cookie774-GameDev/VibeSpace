use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::Read,
    path::PathBuf,
    process::{Command, Stdio},
    sync::Mutex,
    time::{Duration, Instant},
};
use tauri::{AppHandle, Manager};
use tauri_plugin_shell::ShellExt;

#[derive(Default)]
pub struct DesktopConnectorState(pub Mutex<()>);

fn state_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_local_data_dir()
        .map(|p| p.join("desktop-connector").join("state"))
        .map_err(|_| "Connector storage is unavailable.".into())
}
fn connection(app: &AppHandle) -> Result<(String, String), String> {
    let file = state_dir(app)?.join("connection.json");
    if fs::metadata(&file)
        .map_err(|_| "Connection file not found.")?
        .len()
        > 16_384
    {
        return Err("Invalid connection file.".into());
    }
    let data: Value =
        serde_json::from_slice(&fs::read(file).map_err(|_| "Connection file unavailable.")?)
            .map_err(|_| "Invalid connection file.")?;
    validate_connection(&data)
}
fn validate_connection(data: &Value) -> Result<(String, String), String> {
    let endpoint = data["endpoint"]
        .as_str()
        .ok_or("Invalid connection endpoint.")?;
    let token = data["token"]
        .as_str()
        .ok_or("Invalid connection credential.")?;
    let url = reqwest::Url::parse(endpoint).map_err(|_| "Invalid connection endpoint.")?;
    if data["version"] != 1
        || url.scheme() != "http"
        || url.host_str() != Some("127.0.0.1")
        || url.port().is_none()
        || url.path() != "/"
        || url.query().is_some()
        || url.fragment().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
        || token.len() != 64
        || !token.bytes().all(|c| c.is_ascii_hexdigit())
    {
        return Err("Invalid local connector identity.".into());
    }
    Ok((endpoint.trim_end_matches('/').into(), token.into()))
}
fn read_status(app: &AppHandle) -> Result<Value, String> {
    let (endpoint, token) = connection(app)?;
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(4))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| "Connector client unavailable.")?;
    let response = client
        .get(format!("{endpoint}/setup/state"))
        .bearer_auth(token)
        .send()
        .map_err(|_| "Connector is not running.")?;
    if !response.status().is_success() {
        return Err("Connector could not verify its connection.".into());
    }
    let data: Value = response.json().map_err(|_| "Invalid connector status.")?;
    // Return only public status fields. Never forward arbitrary gateway data or credentials.
    Ok(
        json!({ "packaged": true, "connectionDetected": true, "connectionFile": state_dir(app)?.join("connection.json").to_string_lossy(), "status": data["status"], "step": data["step"], "toolCount": data["toolCount"], "hasKey": data["hasKey"], "tunnelId": data["tunnelId"], "setupComplete": data["setupComplete"], "enabled": data["enabled"], "watchdog": data["watchdog"], "startOnComputer": data["startOnComputer"] }),
    )
}
fn resources(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .resource_dir()
        .map(|p| p.join("resources/desktop-connector"))
        .map_err(|_| "Connector resources unavailable.".into())
}
fn packaged(app: &AppHandle) -> bool {
    cfg!(windows)
        && resources(app)
            .map(|p| p.join("runtime.zip").is_file())
            .unwrap_or(false)
}
fn unpack(app: &AppHandle) -> Result<PathBuf, String> {
    let resources = resources(app)?;
    let manifest: Value = serde_json::from_slice(
        &fs::read(resources.join("manifest.json"))
            .map_err(|_| "This build does not contain the desktop connector package.")?,
    )
    .map_err(|_| "Connector manifest is invalid.")?;
    let expected = manifest["sha256"]
        .as_str()
        .filter(|s| s.len() == 64 && s.bytes().all(|c| c.is_ascii_hexdigit()))
        .ok_or("Connector bundle is not available for this platform.")?;
    let root = app
        .path()
        .app_local_data_dir()
        .map_err(|_| "Connector storage unavailable.")?
        .join("desktop-connector")
        .join(expected);
    if root.join(".installed").is_file() {
        return Ok(root);
    }
    let archive_path = resources.join("runtime.zip");
    let mut input = fs::File::open(&archive_path)
        .map_err(|_| "Connector package missing. Reinstall VibeSpace.")?;
    let mut hasher = Sha256::new();
    let mut buffer = [0; 65536];
    loop {
        let n = input
            .read(&mut buffer)
            .map_err(|_| "Cannot verify connector package.")?;
        if n == 0 {
            break;
        }
        hasher.update(&buffer[..n]);
    }
    if format!("{:x}", hasher.finalize()) != expected {
        return Err("Connector package verification failed. Reinstall VibeSpace.".into());
    }
    let mut archive = zip::ZipArchive::new(
        fs::File::open(archive_path).map_err(|_| "Connector package unavailable.")?,
    )
    .map_err(|_| "Invalid connector archive.")?;
    fs::create_dir_all(&root).map_err(|_| "Cannot prepare connector storage.")?;
    for i in 0..archive.len() {
        let mut entry = archive
            .by_index(i)
            .map_err(|_| "Invalid connector entry.")?;
        let relative = entry
            .enclosed_name()
            .ok_or("Unsafe connector entry.")?
            .to_owned();
        if entry
            .unix_mode()
            .is_some_and(|mode| mode & 0o170000 == 0o120000)
        {
            return Err("Connector symbolic links are not supported.".into());
        }
        let dest = root.join(relative);
        if entry.is_dir() {
            fs::create_dir_all(dest).map_err(|_| "Cannot prepare connector folder.")?;
        } else {
            if let Some(parent) = dest.parent() {
                fs::create_dir_all(parent).map_err(|_| "Cannot prepare connector folder.")?;
            }
            let mut output = fs::File::create(dest).map_err(|_| "Cannot unpack connector.")?;
            std::io::copy(&mut entry, &mut output).map_err(|_| "Cannot unpack connector.")?;
        }
    }
    for required in [
        "runtime/node.exe",
        "runtime/tunnel-client.exe",
        "runtime/cloudflared.exe",
        "gateway.mjs",
        "supervisor.mjs",
        "startup.mjs",
        "startup.ps1",
        "startup.vbs",
        "setup/index.html",
    ] {
        if !root.join(required).is_file() {
            return Err("Connector package is incomplete.".into());
        }
    }
    fs::write(root.join(".installed"), expected)
        .map_err(|_| "Cannot finalize connector installation.")?;
    Ok(root)
}
fn start_connector(app: &AppHandle, open_setup: bool) -> Result<(), String> {
    let state = app.state::<DesktopConnectorState>();
    let _guard = state.0.lock().map_err(|_| "Connector setup is busy.")?;
    if read_status(app).is_err() {
        let root = unpack(app)?;
        let mut command = Command::new(root.join("runtime/node.exe"));
        command
            .arg(root.join("supervisor.mjs"))
            .arg(state_dir(app)?)
            .current_dir(&root)
            .env("VIBESPACE_CONNECTOR_PORT", "0")
            .env("VIBESPACE_CONNECTOR_STATE_DIR", state_dir(app)?)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000);
        }
        let mut child = command
            .spawn()
            .map_err(|_| "Cannot start the packaged connector.")?;
        let mut ready = false;
        let deadline = Instant::now() + Duration::from_secs(60);
        while Instant::now() < deadline {
            if child
                .try_wait()
                .map_err(|_| "Cannot check connector startup.")?
                .is_some_and(|status| !status.success())
            {
                return Err(
                    "Connector could not start. Its saved connection may need attention.".into(),
                );
            }
            if read_status(app).is_ok() {
                ready = true;
                break;
            }
            std::thread::sleep(Duration::from_millis(250));
        }
        if !ready {
            return Err("Connector is still starting. Try Setup again shortly.".into());
        }
    }
    if !open_setup {
        return Ok(());
    }
    let (endpoint, token) = connection(app)?;
    #[allow(deprecated)]
    app.shell()
        .open(format!("{endpoint}/setup#token={token}"), None)
        .map_err(|_| "Could not open the setup page.".to_owned())
}
fn saved_setup(app: &AppHandle) -> Option<Value> {
    let file = state_dir(app).ok()?.join("setup.json");
    if fs::metadata(&file).ok()?.len() > 65536 {
        return None;
    }
    serde_json::from_slice(&fs::read(file).ok()?).ok()
}
fn disconnected_status(is_packaged: bool, saved: Value) -> Value {
    json!({ "packaged": is_packaged, "connectionDetected": false,
        "status": if saved["enabled"] == false { "off" } else { "disconnected" },
        "toolCount": 0, "hasKey": saved["protectedKey"].as_str().is_some_and(|key| !key.is_empty()),
        "setupComplete": saved["setupComplete"] == true,
        "enabled": saved["enabled"] != false, "watchdog": false, "startOnComputer": null })
}
pub fn start_on_app_launch(app: &AppHandle) {
    if !cfg!(windows)
        || crate::runtime_profile::ensure_privileged_effect_allowed(
            crate::runtime_profile::DENIED_EFFECT_SHELL_OPEN,
            "desktop-connector-startup",
        )
        .is_err()
    {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let configured = saved_setup(&app).is_some_and(|data| {
            data["enabled"] != false
                && data["protectedKey"]
                    .as_str()
                    .is_some_and(|key| !key.is_empty())
        });
        if configured {
            let _ = start_connector(&app, false);
        }
    });
}
fn guard(window: &tauri::WebviewWindow) -> Result<(), String> {
    if window.label() != "main" {
        return Err("Connector setup is only available from VibeSpace settings.".into());
    }
    crate::runtime_profile::ensure_privileged_effect_allowed(
        crate::runtime_profile::DENIED_EFFECT_SHELL_OPEN,
        "desktop-connector-setup",
    )
}
#[tauri::command]
pub async fn desktop_connector_status(
    app: AppHandle,
    window: tauri::WebviewWindow,
) -> Result<Value, String> {
    guard(&window)?;
    tauri::async_runtime::spawn_blocking(move || match read_status(&app) {
        Ok(status) => status,
        Err(_) => disconnected_status(packaged(&app), saved_setup(&app).unwrap_or(Value::Null)),
    })
    .await
    .map_err(|_| "Connector status unavailable.".into())
}
#[tauri::command]
pub async fn desktop_connector_setup(
    app: AppHandle,
    window: tauri::WebviewWindow,
    action: Option<String>,
) -> Result<(), String> {
    guard(&window)?;
    if !cfg!(windows) {
        return Err("The bundled desktop connector currently requires Windows.".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let action = action.as_deref().unwrap_or("setup");
        if ![
            "setup",
            "connect",
            "disconnect",
            "startup-on",
            "startup-off",
        ]
        .contains(&action)
        {
            return Err("Unknown connector action.".into());
        }
        start_connector(&app, action == "setup")?;
        if action == "setup" {
            return Ok(());
        }
        let (endpoint, token) = connection(&app)?;
        let client = reqwest::blocking::Client::builder()
            .timeout(Duration::from_secs(20))
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|_| "Connector client unavailable.")?;
        let route = if action.starts_with("startup-") {
            "startup"
        } else {
            action
        };
        let response = client
            .post(format!("{endpoint}/setup/{route}"))
            .bearer_auth(token)
            .json(&json!({"enabled": action == "startup-on"}))
            .send()
            .map_err(|_| "Connector action could not be confirmed.")?;
        if !response.status().is_success() {
            return Err("Connector rejected the change. Check its setup and retry.".into());
        }
        Ok(())
    })
    .await
    .map_err(|_| "Connector setup unavailable.".to_owned())?
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn offline_status_preserves_completed_setup_and_off_without_credentials() {
        let status = disconnected_status(
            true,
            json!({"setupComplete":true,"enabled":false,"protectedKey":"fixture-secret"}),
        );
        assert_eq!(status["status"], "off");
        assert_eq!(status["setupComplete"], true);
        assert_eq!(status["watchdog"], false);
        assert_eq!(status["hasKey"], true);
        assert!(!status.to_string().contains("fixture-secret"));
    }
    #[test]
    fn accepts_only_bounded_loopback_connections() {
        let token = "a".repeat(64);
        assert!(validate_connection(
            &json!({"version":1,"endpoint":"http://127.0.0.1:52643","token":token})
        )
        .is_ok());
        for endpoint in [
            "https://example.com",
            "http://127.0.0.1:52643/path",
            "http://user@127.0.0.1:52643",
            "http://127.0.0.1:52643?token=bad",
        ] {
            assert!(
                validate_connection(&json!({"version":1,"endpoint":endpoint,"token":token}))
                    .is_err()
            );
        }
    }
}
