use crate::relay_active_context::{
    RelayActiveContext, RelayActiveContextSnapshot, RelayActiveContextState,
    RelayCollaborationScope, RelayPolicy, RelayPolicySnapshot, RelayPolicyState,
};
use keyring::{Entry, Error as KeyringError};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    fs,
    io::{BufRead, BufReader, Read, Write},
    path::{Path, PathBuf},
    process::{Child, ChildStdin, Command, Stdio},
    sync::{mpsc, Mutex},
    thread,
    time::{Duration, Instant},
};
use tauri::{AppHandle, Manager};

const LOOPBACK: &str = "127.0.0.1";
const START_TIMEOUT: Duration = Duration::from_secs(30);
const HOST_RPC_TIMEOUT: Duration = Duration::from_secs(30);
const RELAY_KEYRING_SERVICE: &str = "ai.jarvis.desktop.relay";
const RELAY_CHANNEL: &str = "vibespace";
const ALLOWED_RELAY_TOOLS: &[&str] = &[
    "agent.list",
    "channel.list",
    "channel.join",
    "message.inbox.check",
    "message.inbox.mark_read",
    "message.list",
    "message.get_thread",
    "message.post",
    "message.reply",
    "message.dm.send",
];

#[derive(Default)]
pub struct RelayEngineState(Mutex<Option<RelayProcess>>);

struct RelayProcess {
    child: Child,
    stdin: Option<ChildStdin>,
    replies: mpsc::Receiver<String>,
    next_request_id: u64,
    base_url: String,
    bindings: HashMap<String, RelayBinding>,
}

#[derive(Clone)]
struct RelayBinding {
    scope: RelayActiveContext,
    session_id: String,
    generation: u64,
    policy_scope: RelayCollaborationScope,
    workspace_credential_account: String,
    participant_credential_account: String,
    workspace_id: String,
    participant_id: String,
    agent_name: String,
    role: String,
    channel_name: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct StoredParticipantCredential {
    workspace_id: String,
    participant_id: String,
    agent_name: String,
    role: String,
    agent_token: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct StoredWorkspaceCredential {
    workspace_id: String,
    workspace_key: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ParticipantBindRequest {
    scope: RelayActiveContext,
    session_id: String,
    generation: u64,
    agent_name: String,
    role: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ParticipantBindingResponse {
    binding_id: String,
    relay_workspace_id: String,
    relay_agent_id: String,
    relay_agent_name: String,
    channel_name: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RelayPolicyResponse {
    policy: RelayPolicy,
    detached_bindings: usize,
    rotated_credentials: usize,
}

fn digest(value: &str) -> String {
    format!("{:x}", Sha256::digest(value.as_bytes()))
}

fn valid_host_text(value: &str, max: usize) -> bool {
    !value.is_empty()
        && value.len() <= max
        && value == value.trim()
        && value.bytes().all(|byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'.' | b':' | b'@' | b' ')
        })
}

fn workspace_credential_account(
    profile_id: &str,
    policy: &RelayPolicy,
    scope: &RelayActiveContext,
) -> String {
    let workspace_id = scope.workspace_id.as_deref().unwrap_or("default");
    let key = match policy.scope {
        RelayCollaborationScope::Project => format!(
            "project\0{}\0{}\0{}",
            scope.account_id, workspace_id, scope.project_id
        ),
        RelayCollaborationScope::EntireApp => {
            format!("app\0{}\0{}", scope.account_id, workspace_id)
        }
        RelayCollaborationScope::Off => String::new(),
    };
    format!("workspace:{}", digest(&format!("{profile_id}\0{key}")))
}

fn participant_credential_account(workspace_account: &str, session_id: &str, role: &str) -> String {
    format!(
        "participant:{}",
        digest(&format!("{workspace_account}\0{session_id}\0{role}"))
    )
}

fn relay_profile_id(app: &AppHandle) -> Result<String, String> {
    app.path()
        .app_local_data_dir()
        .map(|path| digest(&path.to_string_lossy()))
        .map_err(|_| "Relay profile storage is unavailable.".into())
}

fn stable_agent_name(requested: &str, session_id: &str) -> Result<String, String> {
    if !valid_host_text(requested, 100) {
        return Err("Relay participant name is invalid.".into());
    }
    let slug: String = requested
        .chars()
        .filter_map(|character| {
            if character.is_ascii_alphanumeric() || character == '-' || character == '_' {
                Some(character.to_ascii_lowercase())
            } else if character.is_ascii_whitespace() {
                Some('-')
            } else {
                None
            }
        })
        .take(64)
        .collect();
    let slug = slug.trim_matches('-');
    let slug = if slug.is_empty() {
        "vibespace-agent"
    } else {
        slug
    };
    Ok(format!("{}-{}", slug, &digest(session_id)[..8]))
}

fn keyring_entry(account: &str, effect: &'static str) -> Result<Entry, String> {
    crate::runtime_profile::ensure_privileged_effect_allowed(
        crate::runtime_profile::DENIED_EFFECT_KEYCHAIN,
        effect,
    )?;
    Entry::new(RELAY_KEYRING_SERVICE, account)
        .map_err(|_| "Relay credential storage is unavailable.".into())
}

fn keyring_get(account: &str) -> Result<Option<String>, String> {
    match keyring_entry(account, "relay-credential-read")?.get_password() {
        Ok(value) if !value.trim().is_empty() => Ok(Some(value)),
        Ok(_) | Err(KeyringError::NoEntry) => Ok(None),
        Err(_) => Err("Relay credential storage could not be read.".into()),
    }
}

fn keyring_set(account: &str, value: &str) -> Result<(), String> {
    keyring_entry(account, "relay-credential-write")?
        .set_password(value)
        .map_err(|_| "Relay credential storage could not be updated.".into())
}

fn keyring_delete(account: &str) -> Result<(), String> {
    match keyring_entry(account, "relay-credential-delete")?.delete_credential() {
        Ok(()) | Err(KeyringError::NoEntry) => Ok(()),
        Err(_) => Err("Relay credential storage could not be cleared.".into()),
    }
}

fn read_credential<T: for<'de> Deserialize<'de>>(account: &str) -> Result<Option<T>, String> {
    keyring_get(account)?
        .map(|value| {
            serde_json::from_str(&value).map_err(|_| "Stored Relay credential is invalid.".into())
        })
        .transpose()
}

fn write_credential<T: Serialize>(account: &str, value: &T) -> Result<(), String> {
    let value =
        serde_json::to_string(value).map_err(|_| "Relay credential could not be encoded.")?;
    keyring_set(account, &value)
}

fn binding_is_live(
    binding: &RelayBinding,
    generation: u64,
    snapshot: &RelayActiveContextSnapshot,
    policy: &RelayPolicy,
) -> bool {
    binding.generation == generation
        && snapshot.generation == generation
        && snapshot.context.as_ref() == Some(&binding.scope)
        && binding.policy_scope == policy.scope
        && policy.allows(&binding.scope, &binding.session_id)
}

fn validate_tool_call(operation: &str, args: &Value) -> Result<(), String> {
    if !ALLOWED_RELAY_TOOLS.contains(&operation) {
        return Err("Relay tool is not allowed.".into());
    }
    let args = args
        .as_object()
        .ok_or("Relay tool arguments must be an object.")?;
    if ["as", "workspace_id", "workspace_alias"]
        .iter()
        .any(|key| args.contains_key(*key))
    {
        return Err("Relay identity and workspace routing overrides are disabled.".into());
    }
    if matches!(operation, "channel.join" | "message.list" | "message.post") {
        let channel = args
            .get("channel")
            .and_then(Value::as_str)
            .ok_or("Relay tool requires a channel.")?;
        if channel != RELAY_CHANNEL {
            return Err("Relay participants are limited to the VibeSpace channel.".into());
        }
    }
    Ok(())
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
            if health_check(&running.base_url) {
                return Ok(status_value(running));
            }
            stop_process(running);
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
        .stdout(Stdio::piped())
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
    let stdout = child
        .stdout
        .take()
        .ok_or("Cannot connect to the Relay host interface.")?;
    let (reply_sender, replies) = mpsc::channel();
    thread::spawn(move || {
        for line in BufReader::new(stdout).lines() {
            match line {
                Ok(line) => {
                    if reply_sender.send(line).is_err() {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
    });
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
        replies,
        next_request_id: 0,
        base_url,
        bindings: HashMap::new(),
    };
    let result = status_value(&running);
    *process = Some(running);
    Ok(result)
}

fn status_value(process: &RelayProcess) -> Value {
    json!({ "running": true, "healthy": health_check(&process.base_url), "host": LOOPBACK, "baseUrl": process.base_url, "pid": process.child.id() })
}

fn relay_host_rpc(
    process: &mut RelayProcess,
    method: &str,
    params: Value,
) -> Result<Value, String> {
    let id = format!("vibespace-relay-{}", process.next_request_id);
    process.next_request_id = process.next_request_id.wrapping_add(1);
    let request = json!({ "id": id, "method": method, "params": params });
    let payload =
        serde_json::to_vec(&request).map_err(|_| "Relay request could not be encoded.")?;
    let stdin = process
        .stdin
        .as_mut()
        .ok_or("Relay host interface is unavailable.")?;
    stdin
        .write_all(&payload)
        .and_then(|_| stdin.write_all(b"\n"))
        .and_then(|_| stdin.flush())
        .map_err(|_| "Relay host interface is unavailable.")?;

    let deadline = Instant::now() + HOST_RPC_TIMEOUT;
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err("Relay operation timed out.".into());
        }
        let line = process
            .replies
            .recv_timeout(remaining)
            .map_err(|_| "Relay host interface is unavailable.")?;
        let response: Value = match serde_json::from_str(&line) {
            Ok(response) => response,
            Err(_) => continue,
        };
        if response["id"].as_str() != Some(id.as_str()) {
            continue;
        }
        if response.get("error").is_some() {
            return Err("Relay operation was rejected.".into());
        }
        return response
            .get("result")
            .cloned()
            .ok_or_else(|| "Relay host returned an invalid response.".into());
    }
}

fn stop_process(running: &mut RelayProcess) {
    if running.child.try_wait().ok().flatten().is_some() {
        return;
    }
    if let Some(mut stdin) = running.stdin.take() {
        let _ = stdin.write_all(b"stop\n");
        let _ = stdin.flush();
    }
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        if running.child.try_wait().ok().flatten().is_some() {
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
    Ok(json!({ "running": false, "healthy": false }))
}

fn stop_inner(app: &AppHandle) -> Result<Value, String> {
    let state = app.state::<RelayEngineState>();
    let mut process = state.0.lock().map_err(|_| "Relay engine state is busy.")?;
    let Some(mut running) = process.take() else {
        return Ok(json!({ "running": false, "healthy": false }));
    };
    stop_process(&mut running);
    Ok(json!({ "running": false, "healthy": false }))
}

fn command_guard(window: &tauri::WebviewWindow) -> Result<(), String> {
    if window.label() == "main" {
        Ok(())
    } else {
        Err("Relay engine is available only from the main VibeSpace window.".into())
    }
}

fn validate_bind_request(
    request: &ParticipantBindRequest,
    snapshot: &RelayActiveContextSnapshot,
    policy: &RelayPolicy,
) -> Result<(), String> {
    if request.generation == 0
        || snapshot.generation != request.generation
        || snapshot.context.as_ref() != Some(&request.scope)
    {
        return Err("Relay active session changed.".into());
    }
    if !valid_host_text(&request.session_id, 256)
        || !valid_host_text(&request.agent_name, 100)
        || !matches!(request.role.as_str(), "agent" | "human")
    {
        return Err("Relay participant details are invalid.".into());
    }
    if policy.scope == RelayCollaborationScope::Off
        || !policy.allows(&request.scope, &request.session_id)
    {
        return Err("Relay collaboration policy does not allow this session.".into());
    }
    Ok(())
}

fn get_live_binding<'a>(
    process: &'a mut RelayProcess,
    binding_id: &str,
    generation: u64,
    snapshot: &RelayActiveContextSnapshot,
    policy: &RelayPolicy,
) -> Result<&'a mut RelayBinding, String> {
    let is_live = process
        .bindings
        .get(binding_id)
        .is_some_and(|binding| binding_is_live(binding, generation, snapshot, policy));
    if !is_live {
        process.bindings.remove(binding_id);
        return Err("Relay participant binding has expired.".into());
    }
    process
        .bindings
        .get_mut(binding_id)
        .ok_or_else(|| "Relay participant binding has expired.".into())
}

fn safe_tool_catalog(mut result: Value) -> Value {
    if let Some(tools) = result.get_mut("tools").and_then(Value::as_array_mut) {
        tools.retain(|tool| {
            tool.get("name")
                .and_then(Value::as_str)
                .is_some_and(|name| ALLOWED_RELAY_TOOLS.contains(&name))
        });
        for tool in tools {
            let schema = &mut tool["inputSchema"];
            if let Some(properties) = schema.get_mut("properties").and_then(Value::as_object_mut) {
                for key in ["as", "workspace_id", "workspace_alias"] {
                    properties.remove(key);
                }
            }
            if let Some(required) = schema.get_mut("required").and_then(Value::as_array_mut) {
                required.retain(|key| {
                    !matches!(
                        key.as_str(),
                        Some("as" | "workspace_id" | "workspace_alias")
                    )
                });
            }
        }
    }
    result
}

fn require_human_role(role: &str) -> Result<(), String> {
    if role == "human" {
        Ok(())
    } else {
        Err("Relay room command requires a human binding.".into())
    }
}

fn require_agent_role(role: &str) -> Result<(), String> {
    if role == "agent" {
        Ok(())
    } else {
        Err("Generic Relay tools require an agent binding.".into())
    }
}

fn display_text(value: &Value, max_chars: usize) -> String {
    value
        .as_str()
        .unwrap_or_default()
        .chars()
        .take(max_chars)
        .collect()
}

fn sanitize_human_room_snapshot(value: Value, limit: u32) -> Result<Value, String> {
    if value.get("channel").and_then(Value::as_str) != Some(RELAY_CHANNEL) {
        return Err("Relay room response has an invalid channel.".into());
    }
    let message_limit = limit.clamp(1, 50) as usize;
    let messages = value
        .get("messages")
        .and_then(Value::as_array)
        .ok_or("Relay room messages are unavailable.")?
        .iter()
        .take(message_limit)
        .map(|message| {
            let id = message
                .get("id")
                .and_then(Value::as_str)
                .filter(|id| !id.trim().is_empty())
                .ok_or("Relay room message is invalid.")?;
            let parent_id = message
                .get("parentId")
                .and_then(Value::as_str)
                .filter(|id| !id.trim().is_empty());
            let reply_count = message
                .get("replyCount")
                .and_then(Value::as_u64)
                .unwrap_or(0)
                .min(1_000_000);
            Ok(json!({
                "id": display_text(&Value::String(id.to_owned()), 256),
                "text": display_text(&message["text"], 8192),
                "authorId": display_text(&message["authorId"], 256),
                "authorName": display_text(&message["authorName"], 100),
                "createdAt": display_text(&message["createdAt"], 80),
                "parentId": parent_id,
                "replyCount": reply_count,
            }))
        })
        .collect::<Result<Vec<_>, String>>()?;
    let participants = value
        .get("participants")
        .and_then(Value::as_array)
        .ok_or("Relay room participants are unavailable.")?
        .iter()
        .take(100)
        .map(|participant| {
            let id = participant
                .get("id")
                .and_then(Value::as_str)
                .filter(|id| !id.trim().is_empty())
                .ok_or("Relay room participant is invalid.")?;
            let name = participant
                .get("name")
                .and_then(Value::as_str)
                .filter(|name| !name.trim().is_empty())
                .ok_or("Relay room participant is invalid.")?;
            let role = match participant.get("role").and_then(Value::as_str) {
                Some("human") => "human",
                Some("agent") => "agent",
                Some("system") => "system",
                _ => return Err("Relay room participant role is invalid.".into()),
            };
            let status = match participant.get("status").and_then(Value::as_str) {
                Some("online") => "online",
                Some("offline") => "offline",
                Some("away") => "away",
                Some("unknown") => "unknown",
                _ => "unknown",
            };
            Ok(json!({
                "id": display_text(&Value::String(id.to_owned()), 256),
                "name": display_text(&Value::String(name.to_owned()), 100),
                "role": role,
                "status": status,
                "persona": display_text(&participant["persona"], 500),
            }))
        })
        .collect::<Result<Vec<_>, String>>()?;
    Ok(json!({
        "channel": RELAY_CHANNEL,
        "participants": participants,
        "messages": messages,
    }))
}

fn sanitize_human_message_response(value: Value) -> Result<Value, String> {
    let message_id = value
        .get("messageId")
        .and_then(Value::as_str)
        .filter(|id| !id.trim().is_empty())
        .ok_or("Relay message response is invalid.")?;
    let thread_id = value
        .get("threadId")
        .and_then(Value::as_str)
        .filter(|id| !id.trim().is_empty());
    Ok(json!({
        "messageId": display_text(&Value::String(message_id.to_owned()), 256),
        "threadId": thread_id.map(|id| id.chars().take(256).collect::<String>()),
    }))
}

fn participant_bind_inner(
    app: &AppHandle,
    request: ParticipantBindRequest,
) -> Result<Value, String> {
    let active = app.state::<RelayActiveContextState>();
    let policies = app.state::<RelayPolicyState>();
    let snapshot = active.current()?;
    let policy = policies.current()?;
    validate_bind_request(&request, &snapshot, &policy)?;
    let engine_status = start_inner(app)?;
    if engine_status["healthy"] != true {
        return Err("Relay engine health check failed.".into());
    }

    let snapshot = active.current()?;
    let policy = policies.current()?;
    validate_bind_request(&request, &snapshot, &policy)?;
    let engine = app.state::<RelayEngineState>();
    let mut process = engine.0.lock().map_err(|_| "Relay engine state is busy.")?;
    let process = process.as_mut().ok_or("Relay engine is not running.")?;

    let profile_id = relay_profile_id(app)?;
    let workspace_account = workspace_credential_account(&profile_id, &policy, &request.scope);
    let participant_account =
        participant_credential_account(&workspace_account, &request.session_id, &request.role);
    let workspace_credential =
        match read_credential::<StoredWorkspaceCredential>(&workspace_account)? {
            Some(credential) => credential,
            None => {
                let scope_hash = &digest(&format!(
                    "{}\0{}",
                    workspace_account, request.scope.project_id
                ))[..10];
                let kind = match policy.scope {
                    RelayCollaborationScope::Project => "project",
                    RelayCollaborationScope::EntireApp => "app",
                    RelayCollaborationScope::Off => {
                        return Err("Relay collaboration is off.".into())
                    }
                };
                let created = relay_host_rpc(
                    process,
                    "workspace.create",
                    json!({ "name": format!("VibeSpace-{kind}-{scope_hash}") }),
                )?;
                let credential = StoredWorkspaceCredential {
                    workspace_id: created["workspaceId"]
                        .as_str()
                        .filter(|value| valid_host_text(value, 256))
                        .ok_or("Relay workspace creation failed.")?
                        .to_owned(),
                    workspace_key: created["workspaceKey"]
                        .as_str()
                        .filter(|value| !value.is_empty() && value.len() <= 512)
                        .ok_or("Relay workspace creation failed.")?
                        .to_owned(),
                };
                write_credential(&workspace_account, &credential)?;
                credential
            }
        };

    let stored_participant = read_credential::<StoredParticipantCredential>(&participant_account)?;
    let agent_name = stored_participant
        .as_ref()
        .map(|credential| credential.agent_name.clone())
        .unwrap_or(stable_agent_name(&request.agent_name, &request.session_id)?);
    let role = stored_participant
        .as_ref()
        .map(|credential| credential.role.clone())
        .unwrap_or_else(|| request.role.clone());
    if role != request.role
        || stored_participant
            .as_ref()
            .is_some_and(|credential| credential.workspace_id != workspace_credential.workspace_id)
    {
        return Err("Stored Relay participant identity does not match this session.".into());
    }
    let binding_id = nanoid::nanoid!(32);
    let bind_params = if let Some(credential) = stored_participant.as_ref() {
        json!({
            "bindingId": binding_id,
            "workspaceKey": workspace_credential.workspace_key,
            "agentToken": credential.agent_token,
            "agentName": agent_name,
            "role": role,
        })
    } else {
        json!({
            "bindingId": binding_id,
            "workspaceKey": workspace_credential.workspace_key,
            "agentName": agent_name,
            "role": role,
        })
    };
    let result = relay_host_rpc(process, "participant.bind", bind_params)?;
    let workspace_id = result["workspaceId"]
        .as_str()
        .filter(|value| *value == workspace_credential.workspace_id)
        .ok_or("Relay participant workspace identity changed.")?
        .to_owned();
    let participant_id = result["participantId"]
        .as_str()
        .filter(|value| valid_host_text(value, 256))
        .ok_or("Relay participant registration failed.")?
        .to_owned();
    let agent_token = result["agentToken"]
        .as_str()
        .filter(|value| !value.is_empty() && value.len() <= 512)
        .ok_or("Relay participant registration failed.")?
        .to_owned();
    let canonical_agent_name = result["agentName"]
        .as_str()
        .filter(|value| *value == agent_name)
        .ok_or("Relay participant registration failed.")?
        .to_owned();
    if let Err(error) = write_credential(
        &participant_account,
        &StoredParticipantCredential {
            workspace_id: workspace_id.clone(),
            participant_id: participant_id.clone(),
            agent_name: canonical_agent_name.clone(),
            role: role.clone(),
            agent_token,
        },
    ) {
        let _ = relay_host_rpc(
            process,
            "participant.unbind",
            json!({ "bindingId": binding_id }),
        );
        return Err(error);
    }
    let channel_name = result["channelName"]
        .as_str()
        .filter(|value| *value == RELAY_CHANNEL)
        .ok_or("Relay participant channel setup failed.")?
        .to_owned();

    let binding = RelayBinding {
        scope: request.scope,
        session_id: request.session_id,
        generation: request.generation,
        policy_scope: policy.scope,
        workspace_credential_account: workspace_account,
        participant_credential_account: participant_account,
        workspace_id: workspace_id.clone(),
        participant_id: participant_id.clone(),
        agent_name: canonical_agent_name.clone(),
        role,
        channel_name: channel_name.clone(),
    };
    let current_snapshot = active.current()?;
    let current_policy = policies.current()?;
    if !binding_is_live(
        &binding,
        binding.generation,
        &current_snapshot,
        &current_policy,
    ) {
        let _ = relay_host_rpc(
            process,
            "participant.unbind",
            json!({ "bindingId": binding_id }),
        );
        return Err("Relay scope changed while binding.".into());
    }
    process.bindings.insert(binding_id.clone(), binding);
    serde_json::to_value(ParticipantBindingResponse {
        binding_id,
        relay_workspace_id: workspace_id,
        relay_agent_id: participant_id,
        relay_agent_name: canonical_agent_name,
        channel_name,
    })
    .map_err(|_| "Relay participant response could not be encoded.".into())
}

fn participant_list_inner(
    app: &AppHandle,
    binding_id: &str,
    generation: u64,
) -> Result<Value, String> {
    let active = app.state::<RelayActiveContextState>();
    let policies = app.state::<RelayPolicyState>();
    let snapshot = active.current()?;
    let policy = policies.current()?;
    let engine = app.state::<RelayEngineState>();
    let mut process = engine.0.lock().map_err(|_| "Relay engine state is busy.")?;
    let process = process.as_mut().ok_or("Relay engine is not running.")?;
    let binding = get_live_binding(process, binding_id, generation, &snapshot, &policy)?;
    require_agent_role(&binding.role)?;
    if !health_check(&process.base_url) {
        return Err("Relay engine health check failed.".into());
    }
    let result = safe_tool_catalog(relay_host_rpc(
        process,
        "tools.list",
        json!({ "bindingId": binding_id }),
    )?);
    let current_snapshot = active.current()?;
    let current_policy = policies.current()?;
    let binding = process
        .bindings
        .get(binding_id)
        .ok_or("Relay participant binding has expired.")?;
    require_agent_role(&binding.role)?;
    if !binding_is_live(binding, generation, &current_snapshot, &current_policy) {
        return Err("Relay participant binding has expired.".into());
    }
    Ok(result)
}

fn participant_call_inner(
    app: &AppHandle,
    binding_id: &str,
    generation: u64,
    operation: &str,
    args: Value,
) -> Result<Value, String> {
    validate_tool_call(operation, &args)?;
    let active = app.state::<RelayActiveContextState>();
    let policies = app.state::<RelayPolicyState>();
    let snapshot = active.current()?;
    let policy = policies.current()?;
    let engine = app.state::<RelayEngineState>();
    let mut process = engine.0.lock().map_err(|_| "Relay engine state is busy.")?;
    let process = process.as_mut().ok_or("Relay engine is not running.")?;
    let binding = get_live_binding(process, binding_id, generation, &snapshot, &policy)?;
    require_agent_role(&binding.role)?;
    if !health_check(&process.base_url) {
        return Err("Relay engine health check failed.".into());
    }
    let result = relay_host_rpc(
        process,
        "tools.call",
        json!({ "bindingId": binding_id, "name": operation, "arguments": args }),
    )?;
    let current_snapshot = active.current()?;
    let current_policy = policies.current()?;
    let binding = process
        .bindings
        .get(binding_id)
        .ok_or("Relay participant binding has expired.")?;
    require_agent_role(&binding.role)?;
    if !binding_is_live(binding, generation, &current_snapshot, &current_policy) {
        return Err("Relay participant binding has expired.".into());
    }
    Ok(result)
}

fn human_room_snapshot_inner(
    app: &AppHandle,
    binding_id: &str,
    generation: u64,
    limit: u32,
) -> Result<Value, String> {
    let active = app.state::<RelayActiveContextState>();
    let policies = app.state::<RelayPolicyState>();
    let snapshot = active.current()?;
    let policy = policies.current()?;
    let engine = app.state::<RelayEngineState>();
    let mut process = engine.0.lock().map_err(|_| "Relay engine state is busy.")?;
    let process = process.as_mut().ok_or("Relay engine is not running.")?;
    let binding = get_live_binding(process, binding_id, generation, &snapshot, &policy)?;
    require_human_role(&binding.role)?;
    if !health_check(&process.base_url) {
        return Err("Relay engine health check failed.".into());
    }
    let result = relay_host_rpc(
        process,
        "human.room_snapshot",
        json!({ "bindingId": binding_id, "limit": limit.clamp(1, 50) }),
    )?;
    let current_snapshot = active.current()?;
    let current_policy = policies.current()?;
    let binding = process
        .bindings
        .get(binding_id)
        .ok_or("Relay participant binding has expired.")?;
    require_human_role(&binding.role)?;
    if !binding_is_live(binding, generation, &current_snapshot, &current_policy) {
        return Err("Relay participant binding has expired.".into());
    }
    sanitize_human_room_snapshot(result, limit)
}

fn human_message_inner(
    app: &AppHandle,
    binding_id: &str,
    generation: u64,
    text: &str,
    parent_message_id: Option<&str>,
) -> Result<Value, String> {
    if text.trim().is_empty() || text.len() > 8192 || text.contains('\0') {
        return Err("Relay message text is invalid.".into());
    }
    if parent_message_id.is_some_and(|id| !valid_host_text(id, 256)) {
        return Err("Relay parent message ID is invalid.".into());
    }
    let active = app.state::<RelayActiveContextState>();
    let policies = app.state::<RelayPolicyState>();
    let snapshot = active.current()?;
    let policy = policies.current()?;
    let engine = app.state::<RelayEngineState>();
    let mut process = engine.0.lock().map_err(|_| "Relay engine state is busy.")?;
    let process = process.as_mut().ok_or("Relay engine is not running.")?;
    let binding = get_live_binding(process, binding_id, generation, &snapshot, &policy)?;
    require_human_role(&binding.role)?;
    if !health_check(&process.base_url) {
        return Err("Relay engine health check failed.".into());
    }
    let result = relay_host_rpc(
        process,
        "human.message",
        json!({
            "bindingId": binding_id,
            "text": text,
            "parentMessageId": parent_message_id,
        }),
    )?;
    let current_snapshot = active.current()?;
    let current_policy = policies.current()?;
    let binding = process
        .bindings
        .get(binding_id)
        .ok_or("Relay participant binding has expired.")?;
    require_human_role(&binding.role)?;
    if !binding_is_live(binding, generation, &current_snapshot, &current_policy) {
        return Err("Relay participant binding has expired.".into());
    }
    sanitize_human_message_response(result)
}

fn participant_unbind_inner(
    app: &AppHandle,
    binding_id: &str,
    generation: u64,
) -> Result<Value, String> {
    let engine = app.state::<RelayEngineState>();
    let mut process = engine.0.lock().map_err(|_| "Relay engine state is busy.")?;
    let Some(process) = process.as_mut() else {
        return Ok(json!({ "unbound": true }));
    };
    let Some(binding) = process.bindings.get(binding_id) else {
        return Ok(json!({ "unbound": true }));
    };
    if binding.generation != generation {
        return Err("Relay participant binding has expired.".into());
    }
    process.bindings.remove(binding_id);
    relay_host_rpc(
        process,
        "participant.unbind",
        json!({ "bindingId": binding_id }),
    )?;
    Ok(json!({ "unbound": true }))
}

fn policy_set_inner(app: &AppHandle, policy: RelayPolicy) -> Result<RelayPolicyResponse, String> {
    let policy_state = app.state::<RelayPolicyState>();
    let (_, current) = policy_state.set(policy)?;
    let engine = app.state::<RelayEngineState>();
    let mut process = engine.0.lock().map_err(|_| "Relay engine state is busy.")?;
    let Some(process) = process.as_mut() else {
        return Ok(RelayPolicyResponse {
            policy: current,
            detached_bindings: 0,
            rotated_credentials: 0,
        });
    };
    let expired: Vec<(String, RelayBinding)> = process
        .bindings
        .iter()
        .filter(|(_, binding)| {
            binding.policy_scope != current.scope
                || !current.allows(&binding.scope, &binding.session_id)
        })
        .map(|(id, binding)| (id.clone(), binding.clone()))
        .collect();
    let mut rotated_credentials = 0;
    for (binding_id, binding) in &expired {
        let workspace =
            read_credential::<StoredWorkspaceCredential>(&binding.workspace_credential_account)?;
        let rotated = if let Some(workspace) = workspace {
            relay_host_rpc(
                process,
                "participant.rotate",
                json!({
                    "workspaceKey": workspace.workspace_key,
                    "agentName": binding.agent_name,
                    "role": binding.role,
                }),
            )
            .ok()
        } else {
            None
        };
        if let Some(rotated) = rotated {
            let participant_id = rotated["participantId"].as_str();
            let agent_token = rotated["agentToken"].as_str();
            if let (Some(participant_id), Some(agent_token)) = (participant_id, agent_token) {
                if let Some(mut credential) = read_credential::<StoredParticipantCredential>(
                    &binding.participant_credential_account,
                )? {
                    if participant_id == credential.participant_id
                        && !agent_token.is_empty()
                        && agent_token.len() <= 512
                    {
                        credential.agent_token = agent_token.to_owned();
                        if write_credential(&binding.participant_credential_account, &credential)
                            .is_ok()
                        {
                            rotated_credentials += 1;
                        }
                    }
                }
            }
        } else {
            let _ = keyring_delete(&binding.participant_credential_account);
        }
        let _ = relay_host_rpc(
            process,
            "participant.unbind",
            json!({ "bindingId": binding_id }),
        );
        process.bindings.remove(binding_id);
    }
    Ok(RelayPolicyResponse {
        policy: current,
        detached_bindings: expired.len(),
        rotated_credentials,
    })
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

#[tauri::command]
pub async fn relay_policy_set(
    app: AppHandle,
    window: tauri::WebviewWindow,
    policy: RelayPolicy,
) -> Result<RelayPolicyResponse, String> {
    command_guard(&window)?;
    tauri::async_runtime::spawn_blocking(move || policy_set_inner(&app, policy))
        .await
        .map_err(|_| "Relay policy update failed.".to_owned())?
}

#[tauri::command]
pub fn relay_policy_snapshot(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, RelayPolicyState>,
) -> Result<RelayPolicySnapshot, String> {
    command_guard(&window)?;
    state.snapshot()
}

#[tauri::command]
pub async fn relay_participant_bind(
    app: AppHandle,
    window: tauri::WebviewWindow,
    scope: RelayActiveContext,
    session_id: String,
    generation: u64,
    agent_name: String,
    role: String,
) -> Result<Value, String> {
    command_guard(&window)?;
    tauri::async_runtime::spawn_blocking(move || {
        participant_bind_inner(
            &app,
            ParticipantBindRequest {
                scope,
                session_id,
                generation,
                agent_name,
                role,
            },
        )
    })
    .await
    .map_err(|_| "Relay participant bind failed.".to_owned())?
}

#[tauri::command]
pub async fn relay_tools_list(
    app: AppHandle,
    window: tauri::WebviewWindow,
    binding_id: String,
    generation: u64,
) -> Result<Value, String> {
    command_guard(&window)?;
    tauri::async_runtime::spawn_blocking(move || {
        participant_list_inner(&app, &binding_id, generation)
    })
    .await
    .map_err(|_| "Relay tool discovery failed.".to_owned())?
}

#[tauri::command]
pub async fn relay_participant_call(
    app: AppHandle,
    window: tauri::WebviewWindow,
    binding_id: String,
    generation: u64,
    operation: String,
    args: Value,
) -> Result<Value, String> {
    command_guard(&window)?;
    tauri::async_runtime::spawn_blocking(move || {
        participant_call_inner(&app, &binding_id, generation, &operation, args)
    })
    .await
    .map_err(|_| "Relay tool call failed.".to_owned())?
}

#[tauri::command]
pub async fn relay_human_room_snapshot(
    app: AppHandle,
    window: tauri::WebviewWindow,
    binding_id: String,
    generation: u64,
    limit: u32,
) -> Result<Value, String> {
    command_guard(&window)?;
    tauri::async_runtime::spawn_blocking(move || {
        human_room_snapshot_inner(&app, &binding_id, generation, limit)
    })
    .await
    .map_err(|_| "Relay room snapshot failed.".to_owned())?
}

#[tauri::command]
pub async fn relay_human_message(
    app: AppHandle,
    window: tauri::WebviewWindow,
    binding_id: String,
    generation: u64,
    text: String,
    parent_message_id: Option<String>,
) -> Result<Value, String> {
    command_guard(&window)?;
    tauri::async_runtime::spawn_blocking(move || {
        human_message_inner(
            &app,
            &binding_id,
            generation,
            &text,
            parent_message_id.as_deref(),
        )
    })
    .await
    .map_err(|_| "Relay human message failed.".to_owned())?
}

#[tauri::command]
pub async fn relay_participant_unbind(
    app: AppHandle,
    window: tauri::WebviewWindow,
    binding_id: String,
    generation: u64,
) -> Result<Value, String> {
    command_guard(&window)?;
    tauri::async_runtime::spawn_blocking(move || {
        participant_unbind_inner(&app, &binding_id, generation)
    })
    .await
    .map_err(|_| "Relay participant unbind failed.".to_owned())?
}

pub fn shutdown_on_app_exit(app: &AppHandle) {
    let _ = stop_inner(app);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scope(project_id: &str, chat_id: &str) -> RelayActiveContext {
        RelayActiveContext {
            account_id: "account-a".into(),
            workspace_id: Some("profile-a".into()),
            project_id: project_id.into(),
            chat_id: chat_id.into(),
        }
    }

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

    #[test]
    fn native_binding_rechecks_generation_scope_and_policy() {
        let active_scope = scope("project-a", "chat-a");
        let request = ParticipantBindRequest {
            scope: active_scope.clone(),
            session_id: "session-a".into(),
            generation: 7,
            agent_name: "VibeSpace chat".into(),
            role: "agent".into(),
        };
        let snapshot = RelayActiveContextSnapshot {
            generation: 7,
            context: Some(active_scope),
        };
        let mut policy = RelayPolicy {
            revision: 1,
            scope: RelayCollaborationScope::Project,
            excluded_project_ids: Vec::new(),
            excluded_session_ids: Vec::new(),
        };
        assert!(validate_bind_request(&request, &snapshot, &policy).is_ok());

        let mut stale = snapshot.clone();
        stale.generation = 8;
        assert!(validate_bind_request(&request, &stale, &policy).is_err());
        stale = snapshot.clone();
        stale.context = Some(scope("project-b", "chat-a"));
        assert!(validate_bind_request(&request, &stale, &policy).is_err());

        policy.excluded_project_ids.push("project-a".into());
        assert!(validate_bind_request(&request, &snapshot, &policy).is_err());
        policy.excluded_project_ids.clear();
        policy.scope = RelayCollaborationScope::Off;
        assert!(validate_bind_request(&request, &snapshot, &policy).is_err());
    }

    #[test]
    fn project_workspaces_are_isolated_and_app_scope_has_one_workspace() {
        let mut project_policy = RelayPolicy {
            revision: 1,
            scope: RelayCollaborationScope::Project,
            excluded_project_ids: Vec::new(),
            excluded_session_ids: Vec::new(),
        };
        let project_a = scope("project-a", "chat-a");
        let project_b = scope("project-b", "chat-b");
        assert_ne!(
            workspace_credential_account("profile-a", &project_policy, &project_a),
            workspace_credential_account("profile-a", &project_policy, &project_b)
        );
        project_policy.scope = RelayCollaborationScope::EntireApp;
        assert_eq!(
            workspace_credential_account("profile-a", &project_policy, &project_a),
            workspace_credential_account("profile-a", &project_policy, &project_b)
        );
    }

    #[test]
    fn native_tool_gate_rejects_impersonation_and_other_channels() {
        assert!(validate_tool_call(
            "message.post",
            &json!({
                "channel": RELAY_CHANNEL,
                "text": "safe",
            })
        )
        .is_ok());
        assert!(validate_tool_call("workspace.switch", &json!({})).is_err());
        assert!(validate_tool_call(
            "message.post",
            &json!({
                "channel": RELAY_CHANNEL,
                "text": "impersonated",
                "as": "another-agent",
            })
        )
        .is_err());
        assert!(validate_tool_call(
            "message.post",
            &json!({
                "channel": "other-project-channel",
                "text": "cross-room",
            })
        )
        .is_err());
    }

    #[test]
    fn human_room_snapshot_is_bounded_and_contains_only_display_fields() {
        let upstream = json!({
            "channel": "vibespace",
            "messages": [
                {
                    "id": "message-1", "text": "hello", "authorId": "agent-1",
                    "authorName": "Luna", "createdAt": "2026-09-26T12:00:00Z",
                    "parentId": null, "replyCount": 2, "metadata": { "secret": "hidden" },
                    "attachments": [{ "fileId": "hidden" }]
                },
                { "id": "message-2", "text": "outside requested page" }
            ],
            "participants": [
                {
                    "id": "agent-1", "name": "Luna", "role": "agent", "status": "online",
                    "persona": "assistant", "agentToken": "hidden", "metadata": { "private": true }
                }
            ],
            "workspaceKey": "hidden"
        });
        let room = sanitize_human_room_snapshot(upstream, 1).unwrap();
        assert_eq!(room["channel"], RELAY_CHANNEL);
        assert_eq!(room["messages"].as_array().unwrap().len(), 1);
        assert_eq!(room["messages"][0]["id"], "message-1");
        assert_eq!(room["messages"][0]["replyCount"], 2);
        assert!(room["messages"][0].get("metadata").is_none());
        assert!(room["messages"][0].get("attachments").is_none());
        assert_eq!(room["participants"].as_array().unwrap().len(), 1);
        assert_eq!(room["participants"][0]["persona"], "assistant");
        assert!(room["participants"][0].get("agentToken").is_none());
        assert!(room.get("workspaceKey").is_none());
        assert!(sanitize_human_room_snapshot(json!({ "channel": "other" }), 5).is_err());
    }

    #[test]
    fn human_room_commands_require_human_role() {
        assert!(require_human_role("human").is_ok());
        assert!(require_human_role("agent").is_err());
        assert!(require_human_role("system").is_err());
        assert!(require_agent_role("agent").is_ok());
        assert!(require_agent_role("human").is_err());
    }

    #[test]
    fn safe_tool_catalog_preserves_upstream_schema_and_removes_identity_overrides() {
        let catalog = safe_tool_catalog(json!({ "tools": [
            {
                "name": "message.post",
                "title": "Post Message",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "channel": { "type": "string" },
                        "text": { "type": "string" },
                        "as": { "type": "string" },
                        "workspace_id": { "type": "string" }
                    },
                    "required": ["channel", "text", "as"]
                },
                "annotations": { "readOnlyHint": false }
            },
            { "name": "workspace.switch", "inputSchema": {} }
        ] }));
        let tools = catalog["tools"].as_array().unwrap();
        assert_eq!(tools.len(), 1);
        assert_eq!(tools[0]["title"], "Post Message");
        assert_eq!(tools[0]["annotations"]["readOnlyHint"], false);
        assert!(tools[0]["inputSchema"]["properties"]["as"].is_null());
        assert!(tools[0]["inputSchema"]["properties"]["workspace_id"].is_null());
        assert_eq!(
            tools[0]["inputSchema"]["required"],
            json!(["channel", "text"])
        );
    }
}
