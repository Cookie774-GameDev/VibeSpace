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
        json!({ "packaged": true, "connectionDetected": true, "connectionFile": state_dir(app)?.join("connection.json").to_string_lossy(), "status": data["status"], "step": data["step"], "displayName": data["displayName"], "guideTab": data["guideTab"], "errorCode": public_setup_code(data["errorCode"].as_str()).unwrap_or(""), "toolCount": data["toolCount"], "hasKey": data["hasKey"], "tunnelId": data["tunnelId"], "setupComplete": data["setupComplete"], "enabled": data["enabled"], "watchdog": data["watchdog"], "startOnComputer": data["startOnComputer"] }),
    )
}
// Never forward arbitrary renderer payloads or echo credentials in error messages.
fn setup_draft_body(draft: Option<Value>) -> Result<Value, String> {
    let draft = draft.ok_or("Setup draft is missing.")?;
    let object = draft.as_object().ok_or("Invalid setup draft.")?;
    if object.keys().any(|key| {
        !["displayName", "tunnelId", "apiKey", "step", "guideTab"].contains(&key.as_str())
    }) {
        return Err("Unexpected setup field.".into());
    }
    for name in ["displayName", "tunnelId", "apiKey", "guideTab"] {
        if object.get(name).is_some_and(|value| !value.is_string()) {
            return Err("Invalid setup field type.".into());
        }
    }
    if let Some(name) = object.get("displayName").and_then(Value::as_str) {
        if name.trim().is_empty()
            || name.len() > 256
            || name.chars().count() > 64
            || name.chars().any(char::is_control)
        {
            return Err("Use an app name between 1 and 64 characters.".into());
        }
    }
    if let Some(id) = object.get("tunnelId").and_then(Value::as_str) {
        let id = id.trim();
        if !id.is_empty()
            && (!id.starts_with("tunnel_")
                || id.len() < 15
                || id.len() > 135
                || !id
                    .bytes()
                    .all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-'))
        {
            return Err("Enter a valid tunnel ID.".into());
        }
    }
    if let Some(key) = object.get("apiKey").and_then(Value::as_str) {
        let key = key.trim();
        if !key.is_empty()
            && (key.len() < 20
                || key.len() > 4096
                || key.chars().any(char::is_whitespace)
                || key.starts_with("sk-admin-"))
        {
            return Err("Use a restricted runtime API key, not an admin key.".into());
        }
    }
    if object
        .get("step")
        .is_some_and(|v| !matches!(v.as_u64(), Some(1..=3)))
    {
        return Err("Invalid setup step.".into());
    }
    if object
        .get("guideTab")
        .is_some_and(|v| !matches!(v.as_str(), Some("tunnel" | "api")))
    {
        return Err("Choose a valid tutorial tab.".into());
    }
    Ok(draft)
}
fn public_setup_code(code: Option<&str>) -> Option<&str> {
    code.filter(|value| {
        [
            "CREDENTIAL_STORAGE_UNAVAILABLE",
            "INVALID_PLUGIN_NAME",
            "INVALID_TUNNEL_ID",
            "INVALID_RUNTIME_KEY",
            "TUNNEL_CONFIGURATION_REQUIRED",
            "TUNNEL_CREDENTIALS_IN_USE",
            "TUNNEL_START_FAILED",
            "TUNNEL_AUTHENTICATION_FAILED",
            "TUNNEL_PERMISSION_DENIED",
            "TUNNEL_CONNECTION_FAILED",
            "SETUP_REQUEST_FAILED",
        ]
        .contains(value)
    })
}
fn setup_link(action: &str) -> Option<&'static str> {
    match action {
        "open-tunnels" => Some("https://platform.openai.com/settings/organization/tunnels"),
        "open-api-keys" => Some("https://platform.openai.com/settings/organization/api-keys"),
        "open-chatgpt" => Some("https://chatgpt.com/#settings/Connectors"),
        _ => None,
    }
}

fn select_resources(packaged: PathBuf, debug_source: Option<PathBuf>) -> PathBuf {
    if packaged.join("runtime.zip").is_file() {
        return packaged;
    }
    if let Some(source) = debug_source {
        if source.join("runtime.zip").is_file() {
            return source;
        }
    }
    packaged
}
fn resources(app: &AppHandle) -> Result<PathBuf, String> {
    let packaged = app
        .path()
        .resource_dir()
        .map(|p| p.join("resources/desktop-connector"))
        .map_err(|_| "Connector resources unavailable.".to_owned())?;
    #[cfg(debug_assertions)]
    let debug_source =
        Some(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/desktop-connector"));
    #[cfg(not(debug_assertions))]
    let debug_source = None;
    Ok(select_resources(packaged, debug_source))
}
fn packaged(app: &AppHandle) -> bool {
    cfg!(windows)
        && resources(app)
            .map(|p| p.join("runtime.zip").is_file())
            .unwrap_or(false)
}
pub(crate) fn packaged_node_executable(app: &AppHandle) -> Result<PathBuf, String> {
    if !cfg!(windows) {
        return Err("The packaged Relay engine currently requires Windows.".into());
    }
    let state = app.state::<DesktopConnectorState>();
    let _guard = state.0.lock().map_err(|_| "Connector runtime is busy.")?;
    let executable = unpack(app)?.join("runtime/node.exe");
    if !executable.is_file() {
        return Err("The packaged Node runtime is incomplete.".into());
    }
    Ok(executable)
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
        "displayName": saved["displayName"], "tunnelId": saved["tunnelId"], "guideTab": saved["guideTab"], "step": saved["step"],
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
    draft: Option<Value>,
) -> Result<(), String> {
    guard(&window)?;
    if !cfg!(windows) {
        return Err("The bundled desktop connector currently requires Windows.".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let action = action.as_deref().unwrap_or("setup");
        if let Some(url) = setup_link(action) {
            #[allow(deprecated)]
            return app
                .shell()
                .open(url, None)
                .map_err(|_| "Could not open the setup link.".to_owned());
        }
        if ![
            "setup",
            "prepare",
            "save",
            "connect",
            "disconnect",
            "startup-on",
            "startup-off",
        ]
        .contains(&action)
        {
            return Err("Unknown connector action.".into());
        }
        let body = if action == "save" {
            setup_draft_body(draft)?
        } else {
            json!({"enabled": action == "startup-on"})
        };
        start_connector(&app, action == "setup")?;
        if action == "setup" || action == "prepare" {
            return Ok(());
        }
        let (endpoint, token) = connection(&app)?;
        let client = reqwest::blocking::Client::builder()
            // Allow bounded secure-storage startup (30s) plus MCP status readback.
            .timeout(Duration::from_secs(60))
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|_| "Connector client unavailable.")?;
        let route = if action == "save" {
            "draft"
        } else if action.starts_with("startup-") {
            "startup"
        } else {
            action
        };
        let response = client
            .post(format!("{endpoint}/setup/{route}"))
            .bearer_auth(token)
            .json(&body)
            .send()
            .map_err(|_| "Connector action could not be confirmed.")?;
        if !response.status().is_success() {
            let failure: Value = response.json().unwrap_or(Value::Null);
            return Err(public_setup_code(failure["code"].as_str())
                .unwrap_or("SETUP_REQUEST_FAILED")
                .to_owned());
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
    fn setup_error_codes_are_allowlisted_without_arbitrary_messages() {
        assert_eq!(
            public_setup_code(Some("CREDENTIAL_STORAGE_UNAVAILABLE")),
            Some("CREDENTIAL_STORAGE_UNAVAILABLE")
        );
        assert_eq!(
            public_setup_code(Some("TUNNEL_PERMISSION_DENIED")),
            Some("TUNNEL_PERMISSION_DENIED")
        );
        assert_eq!(public_setup_code(Some("private-key-marker")), None);
        assert_eq!(public_setup_code(None), None);
    }
    #[test]
    fn in_app_draft_accepts_only_bounded_setup_fields() {
        let valid = json!({"displayName":"My WebMCP","tunnelId":"tunnel_test_12345678","guideTab":"api","step":1});
        assert_eq!(setup_draft_body(Some(valid.clone())).unwrap(), valid);
        for invalid in [
            json!({"displayName":42}),
            json!({"displayName":" "}),
            json!({"tunnelId":"https://untrusted.invalid"}),
            json!({"guideTab":"other"}),
            json!({"step":99}),
            json!({"protectedKey":"untrusted"}),
            json!({"apiKey":"sk-admin-synthetic-key-not-accepted"}),
            json!({"apiKey":"key with whitespace not accepted"}),
            json!([]),
        ] {
            assert!(setup_draft_body(Some(invalid)).is_err());
        }
        assert!(setup_draft_body(None).is_err());
    }
    #[test]
    fn in_app_links_are_fixed_and_offline_status_never_echoes_key_material() {
        assert_eq!(
            setup_link("open-tunnels"),
            Some("https://platform.openai.com/settings/organization/tunnels")
        );
        assert_eq!(
            setup_link("open-api-keys"),
            Some("https://platform.openai.com/settings/organization/api-keys")
        );
        assert_eq!(setup_link("https://untrusted.invalid"), None);
        let status = disconnected_status(
            true,
            json!({"displayName":"Mine","tunnelId":"tunnel_test_12345678","guideTab":"api","step":1,"protectedKey":"private-protected-fixture","apiKey":"private-plain-fixture"}),
        );
        assert_eq!(status["displayName"], "Mine");
        assert_eq!(status["guideTab"], "api");
        assert_eq!(status["hasKey"], true);
        assert!(!status.to_string().contains("private-"));
    }
    #[test]
    fn resource_selection_prefers_packaged_then_debug_source() {
        let root = std::env::temp_dir().join(format!(
            "vibespace-desktop-connector-resources-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let packaged = root.join("packaged");
        let debug_source = root.join("debug");
        fs::create_dir_all(&packaged).unwrap();
        fs::create_dir_all(&debug_source).unwrap();
        fs::write(debug_source.join("runtime.zip"), b"debug").unwrap();
        assert_eq!(
            select_resources(packaged.clone(), Some(debug_source.clone())),
            debug_source
        );
        fs::write(packaged.join("runtime.zip"), b"packaged").unwrap();
        assert_eq!(
            select_resources(packaged.clone(), Some(root.join("unused"))),
            packaged
        );
        fs::remove_dir_all(root).unwrap();
    }
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
