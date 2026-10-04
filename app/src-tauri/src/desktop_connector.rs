use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::{Read, Seek},
    path::{Path, PathBuf},
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
        "open-chatgpt" => Some("https://chatgpt.com/plugins"),
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
    unpack_verified_bundle(&resources.join("runtime.zip"), expected, &root)
}

const REQUIRED_CONNECTOR_FILES: &[&str] = &[
    "runtime/node.exe",
    "runtime/tunnel-client.exe",
    "runtime/cloudflared.exe",
    "gateway.mjs",
    "supervisor.mjs",
    "startup.mjs",
    "startup.ps1",
    "startup.vbs",
    "setup/index.html",
];

// Refuse both symbolic links and Windows junction/reparse destinations before repair.
fn connector_path_is_unlinked(path: &Path) -> Result<(), String> {
    connector_path_is_unlinked_preflight(path, &mut std::collections::HashSet::new())
}

fn connector_path_is_unlinked_preflight(
    path: &Path,
    checked_ancestors: &mut std::collections::HashSet<PathBuf>,
) -> Result<(), String> {
    for (depth, ancestor) in path.ancestors().enumerate() {
        // During the read-only preflight, inspect each destination and reuse
        // already checked parents. Every extraction write uses a fresh check.
        if depth > 0 && checked_ancestors.contains(ancestor) {
            continue;
        }
        match fs::symlink_metadata(ancestor) {
            Ok(metadata) => {
                let mut linked = metadata.file_type().is_symlink();
                #[cfg(windows)]
                {
                    use std::os::windows::fs::MetadataExt;
                    linked |= metadata.file_attributes() & 0x400 != 0;
                }
                if linked {
                    return Err("Connector linked storage is not supported.".into());
                }
                checked_ancestors.insert(ancestor.to_owned());
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Err("Cannot inspect connector storage.".into()),
        }
    }
    Ok(())
}

fn connector_required_files_match(
    archive: &mut zip::ZipArchive<fs::File>,
    root: &Path,
) -> Result<bool, String> {
    for required in REQUIRED_CONNECTOR_FILES {
        let path = root.join(required);
        connector_path_is_unlinked(&path)?;
        let index = connector_required_entry_index(archive, required)?;
        let mut entry = archive
            .by_index(index)
            .map_err(|_| "Connector package is incomplete.")?;
        if entry.is_dir() || entry.size() == 0 {
            return Err("Connector package is incomplete.".into());
        }
        let metadata = match fs::symlink_metadata(&path) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
            Err(_) => return Err("Cannot inspect connector storage.".into()),
        };
        if !metadata.is_file() || metadata.len() != entry.size() {
            return Ok(false);
        }
        let mut installed = fs::File::open(path).map_err(|_| "Cannot inspect connector file.")?;
        let mut packaged_bytes = [0; 65536];
        let mut installed_bytes = [0; 65536];
        loop {
            let n = entry
                .read(&mut packaged_bytes)
                .map_err(|_| "Invalid connector entry.")?;
            if n == 0 {
                break;
            }
            installed
                .read_exact(&mut installed_bytes[..n])
                .map_err(|_| "Cannot inspect connector file.")?;
            if packaged_bytes[..n] != installed_bytes[..n] {
                return Ok(false);
            }
        }
    }
    Ok(true)
}

fn connector_required_entry_index(
    archive: &zip::ZipArchive<fs::File>,
    required: &str,
) -> Result<usize, String> {
    // Windows ZipFile.CreateFromDirectory uses backslashes in entry names.
    archive
        .index_for_name(required)
        .or_else(|| archive.index_for_name(&required.replace('/', "\\")))
        .ok_or_else(|| "Connector package is incomplete.".into())
}

fn unpack_verified_bundle(
    archive_path: &Path,
    expected: &str,
    root: &Path,
) -> Result<PathBuf, String> {
    let mut input = fs::File::open(archive_path)
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
    input
        .rewind()
        .map_err(|_| "Connector package unavailable.")?;
    let mut archive = zip::ZipArchive::new(input).map_err(|_| "Invalid connector archive.")?;
    let marker = root.join(".installed");
    connector_path_is_unlinked(&marker)?;
    // Validate every archive destination before changing any installed bytes.
    let mut checked_ancestors = std::collections::HashSet::new();
    for i in 0..archive.len() {
        let entry = archive
            .by_index(i)
            .map_err(|_| "Invalid connector entry.")?;
        let relative = entry.enclosed_name().ok_or("Unsafe connector entry.")?;
        if relative == Path::new(".installed")
            || entry
                .unix_mode()
                .is_some_and(|mode| mode & 0o170000 == 0o120000)
        {
            return Err("Unsafe connector entry.".into());
        }
        connector_path_is_unlinked_preflight(&root.join(relative), &mut checked_ancestors)?;
    }
    // Validate the required archive closure even when installation is missing.
    for required in REQUIRED_CONNECTOR_FILES {
        let index = connector_required_entry_index(&archive, required)?;
        let entry = archive
            .by_index(index)
            .map_err(|_| "Connector package is incomplete.")?;
        if entry.is_dir() || entry.size() == 0 {
            return Err("Connector package is incomplete.".into());
        }
    }
    let stamped = match fs::symlink_metadata(&marker) {
        Ok(metadata) if metadata.is_file() && metadata.len() == expected.len() as u64 => {
            fs::read(&marker).map_err(|_| "Cannot inspect connector installation.")?
                == expected.as_bytes()
        }
        Ok(metadata) if !metadata.is_file() => {
            return Err("Invalid connector installation marker.".into())
        }
        Ok(_) => false,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
        Err(_) => return Err("Cannot inspect connector installation.".into()),
    };
    if stamped && connector_required_files_match(&mut archive, root)? {
        return Ok(root.to_owned());
    }
    fs::create_dir_all(root).map_err(|_| "Cannot prepare connector storage.")?;
    if marker.exists() {
        fs::remove_file(&marker).map_err(|_| "Cannot invalidate connector installation.")?;
    }
    for i in 0..archive.len() {
        let mut entry = archive
            .by_index(i)
            .map_err(|_| "Invalid connector entry.")?;
        let relative = entry.enclosed_name().ok_or("Unsafe connector entry.")?;
        let dest = root.join(relative);
        connector_path_is_unlinked(&dest)?;
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
    if !connector_required_files_match(&mut archive, root)? {
        return Err("Connector package is incomplete.".into());
    }
    fs::write(marker, expected).map_err(|_| "Cannot finalize connector installation.")?;
    Ok(root.to_owned())
}

fn connector_runtime_lock(lock: &Mutex<()>) -> Result<std::sync::MutexGuard<'_, ()>, String> {
    // Relay runtime extraction and setup share this in-process lock. Queue
    // preparation behind that work; a busy thread is not an external owner.
    lock.lock()
        .map_err(|_| "Connector runtime is unavailable.".into())
}

fn start_connector(app: &AppHandle, open_setup: bool) -> Result<(), String> {
    let state = app.state::<DesktopConnectorState>();
    let _guard = connector_runtime_lock(&state.0)?;
    if read_status(app).is_err() {
        if interrupted_gateway_lock(&state_dir(app)?)? {
            return Err("CONNECTOR_LOCK_INVALID".into());
        }
        let root = unpack(app).map_err(|cause| {
            if cause.contains("package") || cause.contains("manifest") || cause.contains("archive")
            {
                "CONNECTOR_PACKAGE_INVALID".to_owned()
            } else {
                "CONNECTOR_STORAGE_UNAVAILABLE".to_owned()
            }
        })?;
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
            return Err("CONNECTOR_START_TIMEOUT".into());
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

fn bounded_json(path: &Path) -> Result<Value, String> {
    if fs::metadata(path)
        .map_err(|_| "CONNECTOR_LOCK_IN_USE")?
        .len()
        > 16_384
    {
        return Err("CONNECTOR_LOCK_IN_USE".into());
    }
    serde_json::from_slice(&fs::read(path).map_err(|_| "CONNECTOR_LOCK_IN_USE")?)
        .map_err(|_| "CONNECTOR_LOCK_IN_USE".into())
}
fn owner_pid(value: &Value) -> Option<u32> {
    value["pid"]
        .as_u64()
        .and_then(|pid| u32::try_from(pid).ok())
        .filter(|pid| *pid > 0)
}
fn interrupted_gateway_lock(state: &Path) -> Result<bool, String> {
    let file = state.join("gateway.lock");
    match fs::symlink_metadata(&file) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(_) => Err("CONNECTOR_LOCK_IN_USE".into()),
        Ok(meta) if meta.is_file() && !meta.file_type().is_symlink() && meta.len() <= 16_384 => {
            Ok(bounded_json(&file)
                .ok()
                .and_then(|value| owner_pid(&value))
                .is_none())
        }
        Ok(_) => Err("CONNECTOR_LOCK_IN_USE".into()),
    }
}
#[cfg(windows)]
fn process_alive(pid: u32) -> bool {
    use windows::Win32::{
        Foundation::{CloseHandle, ERROR_INVALID_PARAMETER, WAIT_OBJECT_0},
        System::Threading::{OpenProcess, WaitForSingleObject, PROCESS_SYNCHRONIZE},
    };
    match unsafe { OpenProcess(PROCESS_SYNCHRONIZE, false, pid) } {
        Ok(handle) => {
            let exited = unsafe { WaitForSingleObject(handle, 0) } == WAIT_OBJECT_0;
            let _ = unsafe { CloseHandle(handle) };
            !exited
        }
        Err(error) => error.code() != windows::core::HRESULT::from_win32(ERROR_INVALID_PARAMETER.0),
    }
}
#[cfg(not(windows))]
fn process_alive(_pid: u32) -> bool {
    true
}

// Explicit repair preserves evidence and never takes over a live or unknown owner.
fn repair_interrupted_gateway_lock(
    state: &Path,
    alive: impl Fn(u32) -> bool,
) -> Result<(), String> {
    if !interrupted_gateway_lock(state)? {
        return Ok(());
    }
    let file = state.join("gateway.lock");
    let old = fs::read(&file).map_err(|_| "CONNECTOR_LOCK_IN_USE")?;
    let connection_file = state.join("connection.json");
    let pid = owner_pid(&bounded_json(&connection_file)?).ok_or("CONNECTOR_LOCK_IN_USE")?;
    if alive(pid) {
        return Err("CONNECTOR_LOCK_IN_USE".into());
    }
    let supervisor = state.join("supervisor.lock");
    if supervisor.exists() {
        let pid = owner_pid(&bounded_json(&supervisor)?).ok_or("CONNECTOR_LOCK_IN_USE")?;
        if alive(pid) {
            return Err("CONNECTOR_LOCK_IN_USE".into());
        }
    }
    let modified = fs::metadata(&file)
        .and_then(|meta| meta.modified())
        .map_err(|_| "CONNECTOR_LOCK_IN_USE")?;
    let connected = fs::metadata(&connection_file)
        .and_then(|meta| meta.modified())
        .map_err(|_| "CONNECTOR_LOCK_IN_USE")?;
    if modified > connected
        || modified.elapsed().unwrap_or_default() < Duration::from_secs(60)
        || fs::read(&file).map_err(|_| "CONNECTOR_LOCK_IN_USE")? != old
    {
        return Err("CONNECTOR_LOCK_IN_USE".into());
    }
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|_| "CONNECTOR_LOCK_IN_USE")?
        .as_nanos();
    fs::rename(
        file,
        state.join(format!("gateway.interrupted-{stamp}.lock")),
    )
    .map_err(|_| "CONNECTOR_LOCK_IN_USE".into())
}

fn startup_registration(root: &Path, state: &Path) -> Result<(String, String), String> {
    if root.parent() != state.parent()
        || [root, state].iter().any(|path| {
            path.to_string_lossy()
                .chars()
                .any(|c| c == '"' || c.is_control())
        })
    {
        return Err("WINDOWS_STARTUP_UNAVAILABLE".into());
    }
    let hash = format!(
        "{:x}",
        Sha256::digest(state.to_string_lossy().to_lowercase().as_bytes())
    );
    let name = format!("VibeSpaceDesktopLink-{}", &hash[..16]);
    let launch = format!(
        "wscript.exe //B //Nologo \"{}\" \"runtime\\node.exe\" \"supervisor.mjs\" \"..\\state\"",
        root.join("startup.vbs").display()
    );
    if launch.len() > 260 {
        return Err("WINDOWS_STARTUP_UNAVAILABLE".into());
    }
    Ok((name, launch))
}
fn startup_paths(app: &AppHandle) -> Result<(PathBuf, PathBuf), String> {
    let manifest = bounded_json(&resources(app)?.join("manifest.json"))?;
    let hash = manifest["sha256"]
        .as_str()
        .filter(|hash| hash.len() == 64 && hash.bytes().all(|c| c.is_ascii_hexdigit()))
        .ok_or("WINDOWS_STARTUP_UNAVAILABLE")?;
    let state = state_dir(app)?;
    let root = state
        .parent()
        .ok_or("WINDOWS_STARTUP_UNAVAILABLE")?
        .join(hash);
    Ok((root, state))
}
#[cfg(windows)]
fn read_computer_startup(root: &Path, state: &Path) -> Result<bool, String> {
    use winreg::{
        enums::{HKEY_CURRENT_USER, KEY_READ},
        RegKey,
    };
    let (name, launch) = startup_registration(root, state)?;
    let key = match RegKey::predef(HKEY_CURRENT_USER)
        .open_subkey_with_flags(r"Software\Microsoft\Windows\CurrentVersion\Run", KEY_READ)
    {
        Ok(key) => key,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(_) => return Err("WINDOWS_STARTUP_UNAVAILABLE".into()),
    };
    match key.get_value::<String, _>(&name) {
        Ok(value) if value == launch => Ok(true),
        Ok(_) => Err("WINDOWS_STARTUP_UNAVAILABLE".into()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(_) => Err("WINDOWS_STARTUP_UNAVAILABLE".into()),
    }
}
#[cfg(not(windows))]
fn read_computer_startup(_root: &Path, _state: &Path) -> Result<bool, String> {
    Err("WINDOWS_STARTUP_UNAVAILABLE".into())
}
#[cfg(windows)]
fn change_computer_startup(app: &AppHandle, enabled: bool) -> Result<(), String> {
    use winreg::{enums::HKEY_CURRENT_USER, RegKey};
    let (root, state) = startup_paths(app)?;
    let (name, launch) = startup_registration(&root, &state)?;
    if enabled {
        let connector = app.state::<DesktopConnectorState>();
        let _guard = connector
            .0
            .try_lock()
            .map_err(|_| "CONNECTOR_LOCK_IN_USE")?;
        unpack(app).map_err(|_| "WINDOWS_STARTUP_UNAVAILABLE")?;
    }
    let (key, _) = RegKey::predef(HKEY_CURRENT_USER)
        .create_subkey(r"Software\Microsoft\Windows\CurrentVersion\Run")
        .map_err(|_| "WINDOWS_STARTUP_UNAVAILABLE")?;
    if enabled {
        key.set_value(&name, &launch)
            .map_err(|_| "WINDOWS_STARTUP_UNAVAILABLE")?;
    } else if let Err(error) = key.delete_value(&name) {
        if error.kind() != std::io::ErrorKind::NotFound {
            return Err("WINDOWS_STARTUP_UNAVAILABLE".into());
        }
    }
    if read_computer_startup(&root, &state)? != enabled {
        return Err("WINDOWS_STARTUP_UNAVAILABLE".into());
    }
    Ok(())
}
#[cfg(not(windows))]
fn change_computer_startup(_app: &AppHandle, _enabled: bool) -> Result<(), String> {
    Err("WINDOWS_STARTUP_UNAVAILABLE".into())
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
    tauri::async_runtime::spawn_blocking(move || {
        let mut status = match read_status(&app) {
            Ok(status) => status,
            Err(_) => disconnected_status(packaged(&app), saved_setup(&app).unwrap_or(Value::Null)),
        };
        // Windows startup registration is independent of gateway/tunnel readiness.
        status["startOnComputer"] = startup_paths(&app)
            .and_then(|(root, state)| read_computer_startup(&root, &state))
            .ok()
            .map(Value::Bool)
            .unwrap_or(Value::Null);
        if status["connectionDetected"] != true
            && state_dir(&app)
                .ok()
                .is_some_and(|state| interrupted_gateway_lock(&state).unwrap_or(false))
        {
            status["errorCode"] = Value::String("CONNECTOR_LOCK_INVALID".into());
        }
        status
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
            "repair",
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
        if action.starts_with("startup-") {
            return change_computer_startup(&app, action == "startup-on");
        }
        if action == "repair" {
            let state = app.state::<DesktopConnectorState>();
            let _guard = state.0.try_lock().map_err(|_| "CONNECTOR_LOCK_IN_USE")?;
            repair_interrupted_gateway_lock(&state_dir(&app)?, process_alive)?;
        }
        let body = if action == "save" {
            setup_draft_body(draft)?
        } else {
            json!({"enabled": action == "startup-on"})
        };
        start_connector(&app, action == "setup")?;
        if action == "setup" || action == "prepare" || action == "repair" {
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
    #[test]
    fn preparation_waits_for_work_in_this_app_without_claiming_an_external_owner() {
        use std::sync::{mpsc, Arc};
        let runtime = Arc::new(Mutex::new(()));
        let first_request = runtime.lock().unwrap();
        let queued = Arc::clone(&runtime);
        let (entered, started) = mpsc::channel();
        let (completed, result) = mpsc::channel();
        let second_request = std::thread::spawn(move || {
            entered.send(()).unwrap();
            let outcome = connector_runtime_lock(&queued).map(|_| ());
            completed.send(outcome).unwrap();
        });
        started.recv_timeout(Duration::from_secs(5)).unwrap();
        assert!(matches!(result.try_recv(), Err(mpsc::TryRecvError::Empty)));
        drop(first_request);
        assert_eq!(result.recv_timeout(Duration::from_secs(5)).unwrap(), Ok(()));
        second_request.join().unwrap();
    }
    use super::*;
    fn interrupted_fixture() -> PathBuf {
        let state = std::env::temp_dir().join(format!(
            "vs-connector-repair-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&state).unwrap();
        fs::write(state.join("gateway.lock"), b"").unwrap();
        fs::File::options()
            .write(true)
            .open(state.join("gateway.lock"))
            .unwrap()
            .set_times(
                fs::FileTimes::new()
                    .set_modified(std::time::SystemTime::now() - Duration::from_secs(120)),
            )
            .unwrap();
        fs::write(
            state.join("connection.json"),
            br#"{"pid":12345,"token":"synthetic-private-marker"}"#,
        )
        .unwrap();
        state
    }
    #[test]
    fn explicit_repair_preserves_the_interrupted_marker_and_saved_credentials() {
        let state = interrupted_fixture();
        let original = fs::read(state.join("connection.json")).unwrap();
        assert!(interrupted_gateway_lock(&state).unwrap());
        repair_interrupted_gateway_lock(&state, |_| false).unwrap();
        assert!(!state.join("gateway.lock").exists());
        let archived: Vec<_> = fs::read_dir(&state)
            .unwrap()
            .filter_map(Result::ok)
            .filter(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with("gateway.interrupted-")
            })
            .collect();
        assert_eq!(archived.len(), 1);
        assert_eq!(fs::read(archived[0].path()).unwrap(), b"");
        assert_eq!(fs::read(state.join("connection.json")).unwrap(), original);
        fs::remove_dir_all(state).unwrap();
    }
    #[test]
    fn repair_refuses_live_unknown_and_recent_owners_without_changing_the_marker() {
        let state = interrupted_fixture();
        assert!(repair_interrupted_gateway_lock(&state, |_| true).is_err());
        fs::write(state.join("supervisor.lock"), br#"{"pid":23456}"#).unwrap();
        assert!(repair_interrupted_gateway_lock(&state, |pid| pid == 23456).is_err());
        fs::write(state.join("supervisor.lock"), b"").unwrap();
        assert!(repair_interrupted_gateway_lock(&state, |_| false).is_err());
        fs::remove_file(state.join("supervisor.lock")).unwrap();
        fs::write(state.join("gateway.lock"), b"").unwrap();
        fs::File::options()
            .write(true)
            .open(state.join("gateway.lock"))
            .unwrap()
            .set_times(fs::FileTimes::new().set_modified(std::time::SystemTime::now()))
            .unwrap();
        assert!(repair_interrupted_gateway_lock(&state, |_| false).is_err());
        assert_eq!(fs::read(state.join("gateway.lock")).unwrap(), b"");
        fs::remove_dir_all(state).unwrap();
    }
    #[test]
    fn valid_gateway_lock_is_never_archived_by_repair() {
        let state = interrupted_fixture();
        let original = br#"{"pid":12345}"#;
        fs::write(state.join("gateway.lock"), original).unwrap();
        assert!(!interrupted_gateway_lock(&state).unwrap());
        repair_interrupted_gateway_lock(&state, |_| false).unwrap();
        assert_eq!(fs::read(state.join("gateway.lock")).unwrap(), original);
        fs::remove_dir_all(state).unwrap();
    }
    #[cfg(windows)]
    #[test]
    fn startup_registration_matches_the_packaged_launcher_without_a_gateway() {
        let parent =
            PathBuf::from(r"C:\Users\example\AppData\Local\ai.jarvis.desktop\desktop-connector");
        let root = parent.join("a".repeat(64));
        let state = parent.join("state");
        let (name, launch) = startup_registration(&root, &state).unwrap();
        assert!(name.starts_with("VibeSpaceDesktopLink-"));
        assert!(launch.len() <= 260);
        assert!(launch.ends_with(r#""runtime\node.exe" "supervisor.mjs" "..\state""#));
        assert!(startup_registration(&root, Path::new(r"C:\other\state")).is_err());
        assert!(startup_registration(&parent.join("x".repeat(300)), &state).is_err());
    }
    #[cfg(windows)]
    #[test]
    fn process_liveness_preserves_a_live_owner() {
        assert!(process_alive(std::process::id()));
    }
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
        assert_eq!(
            setup_link("open-chatgpt"),
            Some("https://chatgpt.com/plugins")
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
    struct BundleFixture {
        temp: PathBuf,
        archive: PathBuf,
        root: PathBuf,
        expected: String,
    }
    impl BundleFixture {
        fn new(omit: Option<&str>) -> Self {
            Self::new_with_separator(omit, false)
        }
        fn new_with_separator(omit: Option<&str>, windows_names: bool) -> Self {
            use std::io::Write;
            let temp = std::env::temp_dir().join(format!(
                "vibespace-connector-repair-{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            fs::create_dir_all(&temp).unwrap();
            let archive = temp.join("runtime.zip");
            let mut zip = zip::ZipWriter::new(fs::File::create(&archive).unwrap());
            for required in REQUIRED_CONNECTOR_FILES {
                if omit == Some(*required) {
                    continue;
                }
                zip.start_file(
                    if windows_names {
                        required.replace('/', "\\")
                    } else {
                        required.to_string()
                    },
                    zip::write::SimpleFileOptions::default()
                        .compression_method(zip::CompressionMethod::Stored),
                )
                .unwrap();
                zip.write_all(format!("synthetic-bundle:{required}").as_bytes())
                    .unwrap();
            }
            zip.finish().unwrap();
            let expected = format!("{:x}", Sha256::digest(fs::read(&archive).unwrap()));
            let root = temp.join("desktop-connector").join(&expected);
            Self {
                temp,
                archive,
                root,
                expected,
            }
        }
        fn install(&self) -> Result<PathBuf, String> {
            unpack_verified_bundle(&self.archive, &self.expected, &self.root)
        }
    }
    impl Drop for BundleFixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.temp);
        }
    }

    #[test]
    fn connector_retry_repairs_missing_node_without_changing_saved_state() {
        let fixture = BundleFixture::new(None);
        fixture.install().unwrap();
        let state = fixture.root.parent().unwrap().join("state");
        fs::create_dir_all(&state).unwrap();
        fs::write(state.join("setup.json"), b"synthetic-saved-setup").unwrap();
        fs::remove_file(fixture.root.join("runtime/node.exe")).unwrap();
        assert_eq!(fixture.install().unwrap(), fixture.root);
        assert_eq!(
            fs::read(fixture.root.join("runtime/node.exe")).unwrap(),
            b"synthetic-bundle:runtime/node.exe"
        );
        assert_eq!(
            fs::read(state.join("setup.json")).unwrap(),
            b"synthetic-saved-setup"
        );
    }

    #[cfg(windows)]
    #[test]
    fn connector_accepts_windows_created_archive_paths() {
        let fixture = BundleFixture::new_with_separator(None, true);
        fixture.install().unwrap();
        assert_eq!(
            fs::read(fixture.root.join("runtime/node.exe")).unwrap(),
            b"synthetic-bundle:runtime/node.exe"
        );
        fixture.install().unwrap();
        assert!(fixture.root.join(".installed").is_file());
    }

    #[test]
    fn connector_repairs_nonempty_required_file_tamper_and_invalid_stamp() {
        let fixture = BundleFixture::new(None);
        fixture.install().unwrap();
        // Same length defeats a size-only installation check.
        let node = fixture.root.join("runtime/node.exe");
        fs::write(
            &node,
            vec![b'x'; fs::metadata(&node).unwrap().len() as usize],
        )
        .unwrap();
        fixture.install().unwrap();
        assert_eq!(
            fs::read(&node).unwrap(),
            b"synthetic-bundle:runtime/node.exe"
        );
        fs::write(fixture.root.join(".installed"), "f".repeat(64)).unwrap();
        fixture.install().unwrap();
        assert_eq!(
            fs::read(fixture.root.join(".installed")).unwrap(),
            fixture.expected.as_bytes()
        );
    }

    #[test]
    fn connector_verified_warm_retry_does_not_rewrite_or_remove_unknown_files() {
        let fixture = BundleFixture::new(None);
        fixture.install().unwrap();
        let node = fixture.root.join("runtime/node.exe");
        let before = fs::metadata(&node).unwrap().modified().unwrap();
        fs::write(fixture.root.join("user-note.txt"), b"preserve").unwrap();
        fixture.install().unwrap();
        assert_eq!(fs::metadata(node).unwrap().modified().unwrap(), before);
        assert_eq!(
            fs::read(fixture.root.join("user-note.txt")).unwrap(),
            b"preserve"
        );
    }

    #[test]
    fn connector_rejects_tampered_archive_before_any_installed_write() {
        let fixture = BundleFixture::new(None);
        fixture.install().unwrap();
        let marker = fs::read(fixture.root.join(".installed")).unwrap();
        fs::write(&fixture.archive, b"not-the-pinned-archive").unwrap();
        assert!(fixture
            .install()
            .unwrap_err()
            .contains("verification failed"));
        assert_eq!(fs::read(fixture.root.join(".installed")).unwrap(), marker);
        assert_eq!(
            fs::read(fixture.root.join("runtime/node.exe")).unwrap(),
            b"synthetic-bundle:runtime/node.exe"
        );
    }

    #[test]
    fn connector_incomplete_bundle_never_stamps_success_even_with_existing_sentinel() {
        let fixture = BundleFixture::new(Some("runtime/node.exe"));
        fs::create_dir_all(&fixture.root).unwrap();
        fs::write(fixture.root.join(".installed"), &fixture.expected).unwrap();
        assert!(fixture.install().unwrap_err().contains("incomplete"));
        assert!(!fixture.root.join("gateway.mjs").exists());
        // A verified corrected package has a different content-addressed root.
        let corrected = BundleFixture::new(None);
        corrected.install().unwrap();
        corrected.install().unwrap();
        assert!(corrected.root.join("runtime/node.exe").is_file());
    }

    #[cfg(unix)]
    #[test]
    fn connector_refuses_linked_runtime_before_overwriting_external_target() {
        let fixture = BundleFixture::new(None);
        fs::create_dir_all(&fixture.root).unwrap();
        let outside = fixture.temp.join("outside");
        fs::create_dir_all(&outside).unwrap();
        fs::write(outside.join("node.exe"), b"outside-owned-file").unwrap();
        std::os::unix::fs::symlink(&outside, fixture.root.join("runtime")).unwrap();
        assert!(fixture.install().unwrap_err().contains("linked storage"));
        assert_eq!(
            fs::read(outside.join("node.exe")).unwrap(),
            b"outside-owned-file"
        );
        assert!(!fixture.root.join(".installed").exists());
    }
}
