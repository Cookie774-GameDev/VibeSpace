use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    process::{Child, ChildStdin, Command, Stdio},
    sync::Mutex,
    thread,
    time::{Duration, Instant},
};
use tauri::{AppHandle, Manager};

const LOOPBACK: &str = "127.0.0.1";
const START_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Default)]
pub struct RelayEngineState(Mutex<Option<RelayProcess>>);

struct RelayProcess {
    child: Child,
    stdin: Option<ChildStdin>,
    base_url: String,
}

fn relay_resources(app: &AppHandle) -> Result<PathBuf, String> {
    let packaged = app
        .path()
        .resource_dir()
        .map(|path| path.join("resources/relay-runtime"))
        .map_err(|_| "Relay runtime resources are unavailable.".to_owned())?;
    if packaged.join("runtime.zip").is_file() {
        return Ok(packaged);
    }
    #[cfg(debug_assertions)]
    {
        let source = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/relay-runtime");
        if source.join("runtime.zip").is_file() {
            return Ok(source);
        }
    }
    Err("This build does not contain the Relay engine runtime.".into())
}

fn unpack_runtime(app: &AppHandle) -> Result<PathBuf, String> {
    let resources = relay_resources(app)?;
    let manifest: Value = serde_json::from_slice(
        &fs::read(resources.join("manifest.json"))
            .map_err(|_| "Relay runtime manifest is missing.")?,
    )
    .map_err(|_| "Relay runtime manifest is invalid.")?;
    let expected = manifest["sha256"]
        .as_str()
        .filter(|hash| hash.len() == 64 && hash.bytes().all(|byte| byte.is_ascii_hexdigit()))
        .ok_or("Relay runtime manifest has no valid digest.")?;
    let root = app
        .path()
        .app_local_data_dir()
        .map_err(|_| "Relay profile storage is unavailable.")?
        .join("relaycast-runtime")
        .join(expected);
    if root.join(".installed").is_file() {
        ensure_runtime_files(&root)?;
        return Ok(root);
    }
    let archive_path = resources.join("runtime.zip");
    let mut file =
        fs::File::open(&archive_path).map_err(|_| "Relay runtime archive is missing.")?;
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let count = file
            .read(&mut buffer)
            .map_err(|_| "Cannot verify Relay runtime archive.")?;
        if count == 0 {
            break;
        }
        hasher.update(&buffer[..count]);
    }
    if format!("{:x}", hasher.finalize()) != expected {
        return Err("Relay runtime verification failed. Reinstall VibeSpace.".into());
    }
    let mut archive = zip::ZipArchive::new(
        fs::File::open(archive_path).map_err(|_| "Relay runtime archive is unavailable.")?,
    )
    .map_err(|_| "Relay runtime archive is invalid.")?;
    fs::create_dir_all(&root).map_err(|_| "Cannot prepare Relay runtime storage.")?;
    for index in 0..archive.len() {
        let mut entry = archive
            .by_index(index)
            .map_err(|_| "Relay runtime entry is invalid.")?;
        let relative = entry
            .enclosed_name()
            .ok_or("Unsafe Relay runtime entry.")?
            .to_owned();
        if entry
            .unix_mode()
            .is_some_and(|mode| mode & 0o170000 == 0o120000)
        {
            return Err("Relay runtime symbolic links are not supported.".into());
        }
        let destination = root.join(relative);
        if entry.is_dir() {
            fs::create_dir_all(destination).map_err(|_| "Cannot prepare Relay runtime folder.")?;
        } else {
            if let Some(parent) = destination.parent() {
                fs::create_dir_all(parent).map_err(|_| "Cannot prepare Relay runtime folder.")?;
            }
            let mut output =
                fs::File::create(destination).map_err(|_| "Cannot unpack Relay runtime.")?;
            std::io::copy(&mut entry, &mut output).map_err(|_| "Cannot unpack Relay runtime.")?;
        }
    }
    ensure_runtime_files(&root)?;
    fs::write(root.join(".installed"), expected)
        .map_err(|_| "Cannot finalize Relay runtime install.")?;
    Ok(root)
}

fn ensure_runtime_files(root: &Path) -> Result<(), String> {
    for relative in [
        "run.mjs",
        "relay-runtime.mjs",
        "package.json",
        "node_modules/@relaycast/engine/package.json",
        "node_modules/@agent-relay/sdk/package.json",
    ] {
        if !root.join(relative).is_file() {
            return Err("Relay runtime package is incomplete. Reinstall VibeSpace.".into());
        }
    }
    Ok(())
}

fn validate_base_url(value: &str) -> Result<(u16, String), String> {
    let url = reqwest::Url::parse(value).map_err(|_| "Relay runtime status is invalid.")?;
    let port = url.port().ok_or("Relay runtime status is invalid.")?;
    if url.scheme() != "http"
        || url.host_str() != Some(LOOPBACK)
        || url.path() != "/"
        || url.query().is_some()
        || url.fragment().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err("Relay runtime must bind exclusively to IPv4 loopback.".into());
    }
    Ok((port, value.trim_end_matches('/').to_owned()))
}

fn read_ready_status(path: &Path) -> Result<String, String> {
    let data: Value =
        serde_json::from_slice(&fs::read(path).map_err(|_| "Relay engine is still starting.")?)
            .map_err(|_| "Relay engine startup status is invalid.")?;
    if data["version"] != 1 || data["state"] != "running" || data["host"] != LOOPBACK {
        return Err("Relay engine did not confirm loopback-only startup.".into());
    }
    let base_url = data["baseUrl"]
        .as_str()
        .ok_or("Relay engine status is incomplete.")?;
    let (port, normalized) = validate_base_url(base_url)?;
    if data["port"].as_u64() != Some(u64::from(port)) {
        return Err("Relay engine status port does not match its endpoint.".into());
    }
    Ok(normalized)
}

fn health_check(base_url: &str) -> bool {
    reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(2))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .and_then(|client| client.get(format!("{base_url}/health")).send())
        .is_ok_and(|response| response.status().is_success())
}

fn start_inner(app: &AppHandle) -> Result<Value, String> {
    if !cfg!(windows) {
        return Err("The bundled Relay engine currently requires Windows.".into());
    }
    let state = app.state::<RelayEngineState>();
    let mut process = state.0.lock().map_err(|_| "Relay engine state is busy.")?;
    if let Some(running) = process.as_mut() {
        if running
            .child
            .try_wait()
            .map_err(|_| "Cannot check Relay engine process.")?
            .is_none()
        {
            return Ok(status_value(running));
        }
    }
    *process = None;

    let profile = app
        .path()
        .app_local_data_dir()
        .map_err(|_| "Relay profile storage is unavailable.")?
        .join("relaycast");
    fs::create_dir_all(&profile).map_err(|_| "Cannot prepare Relay profile storage.")?;
    let runtime_root = unpack_runtime(app)?;
    let node = crate::desktop_connector::packaged_node_executable(app)?;
    let status_path = profile.join("engine-status.json");
    if status_path.exists() {
        fs::remove_file(&status_path).map_err(|_| "Cannot clear stale Relay engine status.")?;
    }
    let mut command = Command::new(node);
    command
        .arg(runtime_root.join("run.mjs"))
        .arg("--data-dir")
        .arg(&profile)
        .current_dir(&runtime_root)
        .env_remove("NODE_OPTIONS")
        .env_remove("NODE_PATH")
        .env("NODE_ENV", "production")
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let mut child = command
        .spawn()
        .map_err(|_| "Cannot start the packaged Relay engine.")?;
    let stdin = child.stdin.take();
    let deadline = Instant::now() + START_TIMEOUT;
    let base_url = loop {
        if child
            .try_wait()
            .map_err(|_| "Cannot check Relay engine startup.")?
            .is_some()
        {
            return Err("Relay engine stopped during startup.".into());
        }
        if let Ok(base_url) = read_ready_status(&status_path) {
            if health_check(&base_url) {
                break base_url;
            }
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            return Err("Relay engine startup timed out.".into());
        }
        thread::sleep(Duration::from_millis(150));
    };
    let running = RelayProcess {
        child,
        stdin,
        base_url,
    };
    let result = status_value(&running);
    *process = Some(running);
    Ok(result)
}

fn status_value(process: &RelayProcess) -> Value {
    json!({ "running": true, "host": LOOPBACK, "baseUrl": process.base_url, "pid": process.child.id() })
}

fn status_inner(app: &AppHandle) -> Result<Value, String> {
    let state = app.state::<RelayEngineState>();
    let mut process = state.0.lock().map_err(|_| "Relay engine state is busy.")?;
    if let Some(running) = process.as_mut() {
        if running
            .child
            .try_wait()
            .map_err(|_| "Cannot check Relay engine process.")?
            .is_none()
        {
            return Ok(status_value(running));
        }
    }
    *process = None;
    Ok(json!({ "running": false }))
}

fn stop_inner(app: &AppHandle) -> Result<Value, String> {
    let state = app.state::<RelayEngineState>();
    let mut process = state.0.lock().map_err(|_| "Relay engine state is busy.")?;
    let Some(mut running) = process.take() else {
        return Ok(json!({ "running": false }));
    };
    if running
        .child
        .try_wait()
        .map_err(|_| "Cannot check Relay engine process.")?
        .is_none()
    {
        if let Some(mut stdin) = running.stdin.take() {
            let _ = stdin.write_all(b"stop\n");
            let _ = stdin.flush();
        }
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            if running
                .child
                .try_wait()
                .map_err(|_| "Cannot check Relay engine process.")?
                .is_some()
            {
                break;
            }
            if Instant::now() >= deadline {
                let _ = running.child.kill();
                let _ = running.child.wait();
                break;
            }
            thread::sleep(Duration::from_millis(100));
        }
    }
    Ok(json!({ "running": false }))
}

fn command_guard(window: &tauri::WebviewWindow) -> Result<(), String> {
    if window.label() == "main" {
        Ok(())
    } else {
        Err("Relay engine is available only from the main VibeSpace window.".into())
    }
}

#[tauri::command]
pub async fn relay_engine_start(
    app: AppHandle,
    window: tauri::WebviewWindow,
) -> Result<Value, String> {
    command_guard(&window)?;
    tauri::async_runtime::spawn_blocking(move || start_inner(&app))
        .await
        .map_err(|_| "Relay engine startup failed.".to_owned())?
}

#[tauri::command]
pub async fn relay_engine_stop(
    app: AppHandle,
    window: tauri::WebviewWindow,
) -> Result<Value, String> {
    command_guard(&window)?;
    tauri::async_runtime::spawn_blocking(move || stop_inner(&app))
        .await
        .map_err(|_| "Relay engine stop failed.".to_owned())?
}

#[tauri::command]
pub async fn relay_engine_status(
    app: AppHandle,
    window: tauri::WebviewWindow,
) -> Result<Value, String> {
    command_guard(&window)?;
    tauri::async_runtime::spawn_blocking(move || status_inner(&app))
        .await
        .map_err(|_| "Relay engine status failed.".to_owned())?
}

pub fn shutdown_on_app_exit(app: &AppHandle) {
    let _ = stop_inner(app);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn endpoint_accepts_only_ipv4_loopback_root_urls() {
        assert_eq!(validate_base_url("http://127.0.0.1:8787").unwrap().0, 8787);
        for value in [
            "http://0.0.0.0:8787",
            "http://localhost:8787",
            "https://127.0.0.1:8787",
            "http://127.0.0.1:8787/path",
            "http://user@127.0.0.1:8787",
            "http://127.0.0.1:8787?token=x",
        ] {
            assert!(validate_base_url(value).is_err(), "accepted {value}");
        }
    }

    #[test]
    fn startup_status_must_confirm_loopback_and_port_identity() {
        let path = std::env::temp_dir().join(format!("relay-status-{}.json", std::process::id()));
        fs::write(&path, r#"{"version":1,"state":"running","host":"127.0.0.1","port":8787,"baseUrl":"http://127.0.0.1:8787"}"#).unwrap();
        assert_eq!(read_ready_status(&path).unwrap(), "http://127.0.0.1:8787");
        fs::write(&path, r#"{"version":1,"state":"running","host":"0.0.0.0","port":8787,"baseUrl":"http://0.0.0.0:8787"}"#).unwrap();
        assert!(read_ready_status(&path).is_err());
        fs::remove_file(path).unwrap();
    }
}


