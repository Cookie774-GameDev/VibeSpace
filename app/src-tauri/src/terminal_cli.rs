use keyring::Entry;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs::{self, OpenOptions};
use std::io::{BufRead, BufReader, IsTerminal, Read, Write};
use std::net::{IpAddr, Ipv4Addr, SocketAddr, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::mpsc::{self, SyncSender};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{Emitter, Manager};

const PROTOCOL_VERSION: u8 = 1;
const KEYRING_SERVICE: &str = "ai.jarvis.desktop";
const KEYRING_ACCOUNT: &str = "terminal-cli-nonce";
const MANAGED_MARKER: &str = "VIBESPACE_CLI_MANAGED_V1";
const SHELL_INTEGRATION_MARKER: &str = "VIBESPACE_SHELL_INTEGRATION_V1";
const SHELL_INTEGRATION_START_PREFIX: &str = "# >>> VIBESPACE_SHELL_INTEGRATION_V1 ";
const SHELL_INTEGRATION_END: &str = "# <<< VIBESPACE_SHELL_INTEGRATION_V1 <<<";
const MAX_SHELL_PROFILE_BYTES: u64 = 1_048_576;
const TERMINAL_SESSION_ENV: &str = "VIBESPACE_TERMINAL_SESSION_ID";
const TERMINAL_PANE_ENV: &str = "VIBESPACE_PANE_ID";
const TERMINAL_PROJECT_ENV: &str = "VIBESPACE_PROJECT_ID";
const TERMINAL_RUN_IDENTITY_ENV: &str = "VIBESPACE_CONTEXT_RUN_IDENTITY";
const TERMINAL_PROCESS_INSTANCE_ENV: &str = "VIBESPACE_TERMINAL_PROCESS_INSTANCE_ID";
const MAX_WIRE_BYTES: u64 = 65_536;
const RESPONSE_TIMEOUT: Duration = Duration::from_secs(15);
const IDENTITY_RESPONSE_TIMEOUT: Duration = Duration::from_secs(1);
const LONG_RUNNING_RESPONSE_TIMEOUT: Duration = Duration::from_secs(120);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(2);
const SAFE_NONCE_LENGTH: usize = 64;
const MAX_PARAM_DEPTH: usize = 4;
const MAX_PARAM_KEYS: usize = 32;
const MAX_PARAM_ARRAY: usize = 32;
const MAX_PARAM_STRING: usize = 4_096;
const MAX_OPENCODE_SESSION_ID: usize = 512;
const MAX_PROVIDER_ID: usize = 128;
const MAX_MODEL_ID: usize = 512;
const MAX_VARIANT_ID: usize = 128;
const MAX_RESPONSE_DEPTH: usize = 6;
const MAX_RESPONSE_KEYS: usize = 128;
const MAX_RESPONSE_ARRAY: usize = 512;
const MAX_RESPONSE_STRING: usize = 16_384;
const MAX_ACTIVE_CONNECTIONS: usize = 8;

const EFFECT_SHELL_FILE_REMOVE: &str = "terminal-cli-1093-file-remove";
const EFFECT_SHELL_DIRECTORY_CREATE: &str = "terminal-cli-1105-directory-create";
const EFFECT_SHELL_FILE_CREATE: &str = "terminal-cli-1115-file-create";
const EFFECT_SHELL_FILE_WRITE: &str = "terminal-cli-1120-file-write";
const EFFECT_SHELL_WRITE_CLEANUP_REMOVE: &str = "terminal-cli-1122-file-remove";
const EFFECT_SHELL_FILE_FLUSH: &str = "terminal-cli-1125-file-flush";
const EFFECT_SHELL_FLUSH_CLEANUP_REMOVE: &str = "terminal-cli-1127-file-remove";
const EFFECT_SHELL_FILE_PERMISSIONS_WRITE: &str = "terminal-cli-1132-file-permissions-write";
const EFFECT_SHELL_PERMISSIONS_CLEANUP_REMOVE: &str = "terminal-cli-1133-file-remove";
const EFFECT_SHELL_REPLACE_CLEANUP_REMOVE: &str = "terminal-cli-1138-file-remove";
const EFFECT_KEYRING_ENTRY: &str = "terminal-cli-1165-keyring-entry";
const EFFECT_ENDPOINT_DIRECTORY_CREATE: &str = "terminal-cli-1186-directory-create";
const EFFECT_ENDPOINT_FILE_CREATE: &str = "terminal-cli-1194-file-create";
const EFFECT_ENDPOINT_FILE_WRITE: &str = "terminal-cli-1199-file-write";
const EFFECT_ENDPOINT_FILE_FLUSH: &str = "terminal-cli-1201-file-flush";
#[cfg(unix)]
const EFFECT_ENDPOINT_FILE_PERMISSIONS_WRITE: &str = "terminal-cli-1206-file-permissions-write";
const EFFECT_ENDPOINT_REPLACE_CLEANUP_REMOVE: &str = "terminal-cli-1210-file-remove";
const EFFECT_KEYRING_SET: &str = "terminal-cli-1405-keyring-set";
const EFFECT_KEYRING_READ: &str = "terminal-cli-1524-keyring-read";
const EFFECT_FILE_REPLACE_WINDOWS: &str = "terminal-cli-1845-file-replace-windows";
#[cfg(not(target_os = "windows"))]
const EFFECT_FILE_RENAME: &str = "terminal-cli-1856-file-rename";
const EFFECT_SHIM_FILE_CREATE: &str = "terminal-cli-1875-file-create";
const EFFECT_SHIM_FILE_WRITE: &str = "terminal-cli-1880-file-write";
const EFFECT_SHIM_FILE_FLUSH: &str = "terminal-cli-1882-file-flush";
#[cfg(unix)]
const EFFECT_SHIM_FILE_PERMISSIONS_WRITE: &str = "terminal-cli-1887-file-permissions-write";
const EFFECT_SHIM_REPLACE_CLEANUP_REMOVE: &str = "terminal-cli-1891-file-remove";
const EFFECT_ALIAS_ROLLBACK_FILE_REMOVE: &str = "terminal-cli-1926-file-remove";
const EFFECT_ALIAS_STAGE_FILE_RENAME: &str = "terminal-cli-1972-file-rename";
const EFFECT_ALIAS_ROLLBACK_FILE_RENAME: &str = "terminal-cli-1975-file-rename";
const EFFECT_ALIAS_CLEANUP_FILE_REMOVE: &str = "terminal-cli-1991-file-remove";
const EFFECT_CLI_BIN_DIRECTORY_CREATE: &str = "terminal-cli-2043-directory-create";

fn denied_effect_category(effect: &'static str) -> &'static str {
    match effect {
        EFFECT_KEYRING_ENTRY | EFFECT_KEYRING_SET | EFFECT_KEYRING_READ => {
            crate::runtime_profile::DENIED_EFFECT_KEYCHAIN
        }
        _ => crate::runtime_profile::DENIED_EFFECT_LAUNCHER,
    }
}

#[cfg(not(test))]
fn privileged_effect<T>(
    effect: &'static str,
    adapter: impl FnOnce() -> Result<T, String>,
) -> Result<T, String> {
    crate::runtime_profile::ensure_privileged_effect_allowed(
        denied_effect_category(effect),
        effect,
    )?;
    run_effect_adapter(adapter)
}

#[cfg(not(test))]
fn run_effect_adapter<T>(adapter: impl FnOnce() -> Result<T, String>) -> Result<T, String> {
    adapter()
}

#[cfg(test)]
type TestEffectGuard = dyn Fn(&'static str) -> Result<(), String>;

#[cfg(test)]
std::thread_local! {
    static TEST_EFFECT_GUARD: std::cell::RefCell<Option<Box<TestEffectGuard>>> =
        const { std::cell::RefCell::new(None) };
    static TEST_EFFECT_EVENTS: std::cell::RefCell<Vec<&'static str>> =
        const { std::cell::RefCell::new(Vec::new()) };
    static TEST_EFFECT_FAILURE: std::cell::RefCell<Option<(&'static str, usize, usize)>> =
        const { std::cell::RefCell::new(None) };
}

#[cfg(test)]
fn privileged_effect<T>(
    effect: &'static str,
    adapter: impl FnOnce() -> Result<T, String>,
) -> Result<T, String> {
    let allowed = TEST_EFFECT_GUARD.with(|slot| match &*slot.borrow() {
        Some(guard) => guard(effect),
        None => crate::runtime_profile::ensure_privileged_effect_allowed(
            denied_effect_category(effect),
            effect,
        ),
    });
    allowed?;
    run_effect_adapter(effect, adapter)
}

#[cfg(test)]
fn run_effect_adapter<T>(
    effect: &'static str,
    adapter: impl FnOnce() -> Result<T, String>,
) -> Result<T, String> {
    TEST_EFFECT_EVENTS.with(|events| events.borrow_mut().push(effect));
    let injected_failure = TEST_EFFECT_FAILURE.with(|slot| {
        let mut failure = slot.borrow_mut();
        let Some((target, occurrence, seen)) = failure.as_mut() else {
            return false;
        };
        if *target != effect {
            return false;
        }
        *seen += 1;
        *seen == *occurrence
    });
    if injected_failure {
        return Err(format!("injected '{effect}' adapter failure"));
    }
    adapter()
}

#[cfg(test)]
fn install_test_effect_guard<F>(guard: F)
where
    F: Fn(&'static str) -> Result<(), String> + 'static,
{
    TEST_EFFECT_GUARD.with(|slot| *slot.borrow_mut() = Some(Box::new(guard)));
}

#[cfg(test)]
fn clear_test_effect_guard() {
    TEST_EFFECT_GUARD.with(|slot| *slot.borrow_mut() = None);
}

#[cfg(test)]
fn clear_test_effect_events() {
    TEST_EFFECT_EVENTS.with(|events| events.borrow_mut().clear());
    TEST_EFFECT_FAILURE.with(|slot| *slot.borrow_mut() = None);
}

#[cfg(test)]
fn fail_test_effect_adapter(effect: &'static str, occurrence: usize) {
    assert!(occurrence > 0);
    TEST_EFFECT_FAILURE.with(|slot| *slot.borrow_mut() = Some((effect, occurrence, 0)));
}

#[cfg(test)]
fn take_test_effect_events() -> Vec<&'static str> {
    TEST_EFFECT_EVENTS.with(|events| std::mem::take(&mut *events.borrow_mut()))
}

pub fn terminal_cli_response_timeout(method: &str) -> Duration {
    match method {
        "context.create" | "context.refresh" | "context.ask" => LONG_RUNNING_RESPONSE_TIMEOUT,
        "cao.identity.publish" => IDENTITY_RESPONSE_TIMEOUT,
        _ => RESPONSE_TIMEOUT,
    }
}

const METHODS: &[&str] = &[
    "context.list",
    "context.current",
    "context.use",
    "context.clear",
    "context.search",
    "context.open",
    "context.attach",
    "context.refresh",
    "context.sources",
    "context.status",
    "context.create",
    "context.ask",
    "skills.list",
    "skills.active",
    "skills.use",
    "skills.add",
    "skills.remove",
    "skills.clear",
    "skills.inspect",
    "agent.list",
    "agent.current",
    "agent.use",
    "agent.clear",
    "agent.status",
    "note.new",
    "note.open",
    "note.link",
    "daily.open",
    "daily.add",
    "project.current",
    "project.switch",
    "cao.identity.publish",
    "status",
    "help",
];

const RESPONSE_CODES: &[&str] = &[
    "ok",
    "app_not_running",
    "authentication_failed",
    "invalid_request",
    "unsupported_version",
    "permission_denied",
    "not_found",
    "conflict",
    "internal_error",
    "context_unavailable",
];

#[derive(Debug, Clone, PartialEq)]
pub struct TerminalCliInvocation {
    pub endpoint: PathBuf,
    pub json: bool,
    pub color: bool,
    pub method: String,
    pub params: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TerminalCliRequest {
    pub protocol_version: u8,
    pub request_id: String,
    pub nonce: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub terminal_session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pane_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub run_identity: Option<String>,
    pub method: String,
    pub params: Value,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct TerminalCliRequestScope {
    pub terminal_session_id: Option<String>,
    pub pane_id: Option<String>,
    pub project_id: Option<String>,
    pub run_identity: Option<String>,
    pub process_instance_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TerminalCliResponse {
    pub request_id: String,
    pub ok: bool,
    pub code: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TerminalCliEndpoint {
    protocol_version: u8,
    address: String,
    keyring_service: String,
    keyring_account: String,
}

struct TerminalCliEndpointError {
    code: &'static str,
    message: &'static str,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TerminalCliFrontendRequest {
    protocol_version: u8,
    request_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    terminal_session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pane_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    project_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    run_identity: Option<String>,
    method: String,
    params: Value,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalCliInstallStatus {
    installed: bool,
    bin_dir: String,
    command_names: [&'static str; 3],
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalShellProfileStatus {
    shell: &'static str,
    path: String,
    installed: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalShellIntegrationStatus {
    available: bool,
    installed: bool,
    profiles: Vec<TerminalShellProfileStatus>,
}

#[cfg_attr(target_os = "windows", allow(dead_code))]
#[derive(Debug, Clone, Copy)]
enum TerminalShellKind {
    PowerShell,
    Bash,
    Zsh,
    Fish,
}

impl TerminalShellKind {
    fn label(self) -> &'static str {
        match self {
            Self::PowerShell => "powershell",
            Self::Bash => "bash",
            Self::Zsh => "zsh",
            Self::Fish => "fish",
        }
    }

    fn integration(self) -> &'static str {
        match self {
            Self::PowerShell => powershell_terminal_prompt_integration(),
            Self::Bash => bash_terminal_prompt_integration(),
            Self::Zsh => zsh_terminal_prompt_integration(),
            Self::Fish => fish_terminal_prompt_integration(),
        }
    }
}

#[derive(Debug, Clone)]
struct TerminalShellProfileTarget {
    shell: TerminalShellKind,
    path: PathBuf,
}

#[derive(Default)]
pub struct TerminalCliState {
    endpoint_path: Mutex<Option<PathBuf>>,
    private_bin_dir: Mutex<Option<PathBuf>>,
    pending: Arc<Mutex<HashMap<String, SyncSender<TerminalCliResponse>>>>,
}

impl TerminalCliState {
    pub fn private_bin_dir(&self) -> Option<PathBuf> {
        self.private_bin_dir.lock().ok()?.clone()
    }
}

#[derive(Clone)]
pub struct TerminalCliConnectionLimiter {
    active: Arc<AtomicUsize>,
    maximum: usize,
}

pub struct TerminalCliConnectionPermit {
    active: Arc<AtomicUsize>,
}

impl TerminalCliConnectionLimiter {
    pub fn new(maximum: usize) -> Self {
        Self {
            active: Arc::new(AtomicUsize::new(0)),
            maximum,
        }
    }

    pub fn try_acquire(&self) -> Option<TerminalCliConnectionPermit> {
        if self.maximum == 0 {
            return None;
        }
        self.active
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |active| {
                (active < self.maximum).then_some(active + 1)
            })
            .ok()
            .map(|_| TerminalCliConnectionPermit {
                active: Arc::clone(&self.active),
            })
    }
}

impl Drop for TerminalCliConnectionPermit {
    fn drop(&mut self) {
        self.active.fetch_sub(1, Ordering::AcqRel);
    }
}

fn safe_atom(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 200
        && value.chars().enumerate().all(|(index, ch)| {
            ch.is_ascii_alphanumeric()
                || (index > 0 && matches!(ch, '.' | '_' | ':' | '/' | '@' | '-'))
        })
}

fn safe_identity_value(value: &str, maximum: usize, allow_slash: bool) -> bool {
    !value.is_empty()
        && value.len() <= maximum
        && value.chars().enumerate().all(|(index, ch)| {
            ch.is_ascii_alphanumeric()
                || (index > 0
                    && (matches!(ch, '.' | '_' | ':' | '@' | '+' | '-')
                        || (allow_slash && ch == '/')))
        })
}

fn safe_text(value: &str, maximum: usize) -> bool {
    !value.is_empty()
        && value.len() <= maximum
        && !value.chars().any(
            |ch| matches!(ch, '\0'..='\u{8}' | '\u{b}' | '\u{c}' | '\u{e}'..='\u{1f}' | '\u{7f}'..='\u{9f}'),
        )
}

fn closed_params<K: Into<String>>(entries: impl IntoIterator<Item = (K, Value)>) -> Value {
    Value::Object(
        entries
            .into_iter()
            .map(|(key, value)| (key.into(), value))
            .collect(),
    )
}

fn empty_params() -> Value {
    Value::Object(Map::new())
}

fn one_value(args: &[String], name: &str) -> Result<Value, String> {
    if args.len() != 1 || !safe_text(&args[0], MAX_PARAM_STRING) {
        return Err(format!("{name} requires one bounded value"));
    }
    Ok(Value::String(args[0].clone()))
}

fn no_values(args: &[String], name: &str) -> Result<Value, String> {
    if !args.is_empty() {
        return Err(format!("{name} does not accept extra arguments"));
    }
    Ok(empty_params())
}

fn parse_context(args: &[String]) -> Result<(String, Value), String> {
    let (subcommand, rest) = args
        .split_first()
        .ok_or_else(|| "context requires a subcommand".to_string())?;
    let method = format!("context.{subcommand}");
    let params = match subcommand.as_str() {
        "list" | "current" | "clear" | "sources" | "status" => no_values(rest, &method)?,
        "use" => closed_params([("map", one_value(rest, &method)?)]),
        "search" => closed_params([("query", one_value(rest, &method)?)]),
        "ask" => closed_params([("question", one_value(rest, &method)?)]),
        "open" => closed_params([("target", one_value(rest, &method)?)]),
        "refresh" => {
            if rest.len() > 1 {
                return Err("context.refresh accepts at most one map".into());
            }
            closed_params([(
                "map",
                rest.first()
                    .map(|value| Value::String(value.clone()))
                    .unwrap_or(Value::Null),
            )])
        }
        "attach" => {
            if rest.is_empty() || rest.len() > 2 || !safe_text(&rest[0], MAX_PARAM_STRING) {
                return Err("context.attach requires an entity and optional --once".into());
            }
            let mode = match rest.get(1).map(String::as_str) {
                None => "persistent",
                Some("--once") => "one_turn",
                Some(_) => return Err("context.attach accepts only --once".into()),
            };
            closed_params([
                ("entity", Value::String(rest[0].clone())),
                ("mode", Value::String(mode.into())),
            ])
        }
        "create" => {
            if rest.len() < 2 {
                return Err("context.create requires --folder, --file, or --github".into());
            }
            match rest[0].as_str() {
                "--folder" if rest.len() == 2 => closed_params([
                    ("sourceKind", Value::String("folder".into())),
                    ("source", Value::String(rest[1].clone())),
                ]),
                "--file" if rest.len() == 2 => closed_params([
                    ("sourceKind", Value::String("file".into())),
                    ("source", Value::String(rest[1].clone())),
                ]),
                "--github" if rest.len() == 4 && rest[2] == "--ref" => closed_params([
                    ("sourceKind", Value::String("github".into())),
                    ("source", Value::String(rest[1].clone())),
                    ("ref", Value::String(rest[3].clone())),
                ]),
                _ => return Err("invalid context.create arguments".into()),
            }
        }
        _ => return Err("unknown context command".into()),
    };
    Ok((method, params))
}

fn parse_cao(args: &[String]) -> Result<(String, Value), String> {
    let expected = [
        "identity",
        "publish",
        "--opencode-session",
        "--provider",
        "--model",
        "--variant",
        "--process-instance",
    ];
    if args.len() != 12
        || args[0] != expected[0]
        || args[1] != expected[1]
        || args[2] != expected[2]
        || args[4] != expected[3]
        || args[6] != expected[4]
        || args[8] != expected[5]
        || args[10] != expected[6]
    {
        return Err(
            "cao identity publish requires exact session, provider, model, variant, and process-instance arguments"
                .into(),
        );
    }
    let session_id = &args[3];
    let provider_id = &args[5];
    let model_id = &args[7];
    let variant = &args[9];
    let process_instance_id = &args[11];
    if !safe_identity_value(session_id, MAX_OPENCODE_SESSION_ID, true)
        || !safe_identity_value(provider_id, MAX_PROVIDER_ID, false)
        || !safe_identity_value(model_id, MAX_MODEL_ID, true)
        || !safe_identity_value(variant, MAX_VARIANT_ID, true)
        || !safe_atom(process_instance_id)
    {
        return Err("cao identity publish contains an invalid identity value".into());
    }
    Ok((
        "cao.identity.publish".into(),
        closed_params([
            ("opencodeSessionId", Value::String(session_id.clone())),
            ("providerId", Value::String(provider_id.clone())),
            ("modelId", Value::String(model_id.clone())),
            ("variant", Value::String(variant.clone())),
            (
                "processInstanceId",
                Value::String(process_instance_id.clone()),
            ),
        ]),
    ))
}

fn parse_named_family(
    family: &str,
    args: &[String],
    no_arg: &[&str],
    one_arg: &[(&str, &str)],
) -> Result<(String, Value), String> {
    let (subcommand, rest) = args
        .split_first()
        .ok_or_else(|| format!("{family} requires a subcommand"))?;
    let method = format!("{family}.{subcommand}");
    if no_arg.contains(&subcommand.as_str()) {
        return Ok((method.clone(), no_values(rest, &method)?));
    }
    if let Some((_, param)) = one_arg
        .iter()
        .find(|(candidate, _)| *candidate == subcommand)
    {
        return Ok((
            method.clone(),
            closed_params([(*param, one_value(rest, &method)?)]),
        ));
    }
    Err(format!("unknown {family} command"))
}

fn parse_note(args: &[String]) -> Result<(String, Value), String> {
    let (subcommand, rest) = args
        .split_first()
        .ok_or_else(|| "note requires a subcommand".to_string())?;
    let method = format!("note.{subcommand}");
    match subcommand.as_str() {
        "new" => Ok((method.clone(), no_values(rest, &method)?)),
        "open" => Ok((
            method.clone(),
            closed_params([("name", one_value(rest, &method)?)]),
        )),
        "link" if rest.len() == 2 => Ok((
            method,
            closed_params([
                ("source", Value::String(rest[0].clone())),
                ("target", Value::String(rest[1].clone())),
            ]),
        )),
        _ => Err("invalid note command".into()),
    }
}

fn parse_daily(args: &[String]) -> Result<(String, Value), String> {
    if args.is_empty() {
        return Ok(("daily.open".into(), empty_params()));
    }
    if args.len() == 2 && args[0] == "add" && safe_text(&args[1], MAX_PARAM_STRING) {
        return Ok((
            "daily.add".into(),
            closed_params([("text", Value::String(args[1].clone()))]),
        ));
    }
    Err("daily accepts no arguments or `add <text>`".into())
}

pub fn parse_terminal_cli_args(args: &[String]) -> Result<TerminalCliInvocation, String> {
    let mut index = 0;
    let mut endpoint = None;
    let mut json_output = false;
    let mut color = std::io::stdout().is_terminal();
    while let Some(arg) = args.get(index) {
        match arg.as_str() {
            "--endpoint" => {
                if endpoint.is_some() {
                    return Err("--endpoint may be provided only once".into());
                }
                let value = args
                    .get(index + 1)
                    .ok_or_else(|| "--endpoint requires a path".to_string())?;
                if value.is_empty() || value.chars().any(char::is_control) {
                    return Err("invalid endpoint path".into());
                }
                endpoint = Some(PathBuf::from(value));
                index += 2;
            }
            "--json" => {
                json_output = true;
                color = false;
                index += 1;
            }
            "--no-color" => {
                color = false;
                index += 1;
            }
            "--color" => {
                color = true;
                index += 1;
            }
            _ if arg.starts_with('-') => return Err(format!("unknown option: {arg}")),
            _ => break,
        }
    }
    let endpoint = endpoint.ok_or_else(|| "missing managed --endpoint path".to_string())?;
    let command = args.get(index).map(String::as_str).unwrap_or("help");
    let rest = &args[(index + usize::from(index < args.len()))..];
    let (method, params) = match command {
        "status" | "help" => (command.to_string(), no_values(rest, command)?),
        "context" => parse_context(rest)?,
        "ask" => (
            "context.ask".into(),
            closed_params([("question", one_value(rest, "context.ask")?)]),
        ),
        "skills" => parse_named_family(
            "skills",
            rest,
            &["list", "active", "clear"],
            &[
                ("use", "skill"),
                ("add", "skill"),
                ("remove", "skill"),
                ("inspect", "skill"),
            ],
        )?,
        "agent" => parse_named_family(
            "agent",
            rest,
            &["list", "current", "clear", "status"],
            &[("use", "slug")],
        )?,
        "note" => parse_note(rest)?,
        "daily" => parse_daily(rest)?,
        "project" => parse_named_family("project", rest, &["current"], &[("switch", "projectId")])?,
        "cao" => parse_cao(rest)?,
        _ => return Err("unknown VibeSpace command".into()),
    };
    if !METHODS.contains(&method.as_str()) {
        return Err("unsupported VibeSpace command".into());
    }
    Ok(TerminalCliInvocation {
        endpoint,
        json: json_output,
        color: color && !json_output,
        method,
        params,
    })
}

fn valid_json(value: &Value, depth: usize) -> bool {
    match value {
        Value::Null | Value::Bool(_) => true,
        Value::Number(number) => number.as_f64().is_some_and(f64::is_finite),
        Value::String(text) => safe_text(text, MAX_PARAM_STRING),
        Value::Array(values) => {
            depth < MAX_PARAM_DEPTH
                && values.len() <= MAX_PARAM_ARRAY
                && values.iter().all(|value| valid_json(value, depth + 1))
        }
        Value::Object(values) => {
            depth < MAX_PARAM_DEPTH
                && values.len() <= MAX_PARAM_KEYS
                && values
                    .iter()
                    .all(|(key, value)| safe_atom(key) && valid_json(value, depth + 1))
        }
    }
}

fn valid_response_json(value: &Value, depth: usize) -> bool {
    match value {
        Value::Null | Value::Bool(_) => true,
        Value::Number(number) => number.as_f64().is_some_and(f64::is_finite),
        Value::String(text) => {
            text.len() <= MAX_RESPONSE_STRING
                && !text.chars().any(
                    |ch| matches!(ch, '\0'..='\u{8}' | '\u{b}' | '\u{c}' | '\u{e}'..='\u{1f}' | '\u{7f}'..='\u{9f}'),
                )
        }
        Value::Array(values) => {
            depth < MAX_RESPONSE_DEPTH
                && values.len() <= MAX_RESPONSE_ARRAY
                && values
                    .iter()
                    .all(|value| valid_response_json(value, depth + 1))
        }
        Value::Object(values) => {
            depth < MAX_RESPONSE_DEPTH
                && values.len() <= MAX_RESPONSE_KEYS
                && values
                    .iter()
                    .all(|(key, value)| safe_atom(key) && valid_response_json(value, depth + 1))
        }
    }
}

fn valid_nonce(value: &str) -> bool {
    value.len() == SAFE_NONCE_LENGTH && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn constant_time_eq(left: &str, right: &str) -> bool {
    let left = left.as_bytes();
    let right = right.as_bytes();
    let mut difference = left.len() ^ right.len();
    for index in 0..left.len().max(right.len()) {
        difference |= usize::from(*left.get(index).unwrap_or(&0) ^ *right.get(index).unwrap_or(&0));
    }
    difference == 0
}

pub fn build_terminal_cli_request(
    invocation: &TerminalCliInvocation,
    nonce: &str,
    request_id: &str,
) -> Result<TerminalCliRequest, String> {
    build_scoped_terminal_cli_request(
        invocation,
        nonce,
        request_id,
        terminal_cli_scope_from_environment()?,
    )
}

fn optional_scope_environment(name: &str) -> Result<Option<String>, String> {
    let Some(value) = std::env::var_os(name) else {
        return Ok(None);
    };
    let value = value
        .into_string()
        .map_err(|_| format!("{name} is not valid UTF-8"))?;
    if !safe_atom(&value) {
        return Err(format!("{name} is invalid"));
    }
    Ok(Some(value))
}

fn terminal_cli_scope_from_environment() -> Result<TerminalCliRequestScope, String> {
    Ok(TerminalCliRequestScope {
        terminal_session_id: optional_scope_environment(TERMINAL_SESSION_ENV)?,
        pane_id: optional_scope_environment(TERMINAL_PANE_ENV)?,
        project_id: optional_scope_environment(TERMINAL_PROJECT_ENV)?,
        run_identity: optional_scope_environment(TERMINAL_RUN_IDENTITY_ENV)?,
        process_instance_id: optional_scope_environment(TERMINAL_PROCESS_INSTANCE_ENV)?,
    })
}

pub fn build_scoped_terminal_cli_request(
    invocation: &TerminalCliInvocation,
    nonce: &str,
    request_id: &str,
    scope: TerminalCliRequestScope,
) -> Result<TerminalCliRequest, String> {
    let process_instance_id = scope.process_instance_id.clone();
    let request = TerminalCliRequest {
        protocol_version: PROTOCOL_VERSION,
        request_id: request_id.into(),
        nonce: nonce.into(),
        terminal_session_id: scope.terminal_session_id,
        pane_id: scope.pane_id,
        project_id: scope.project_id,
        run_identity: scope.run_identity,
        method: invocation.method.clone(),
        params: invocation.params.clone(),
    };
    if invocation.method == "cao.identity.publish"
        && process_instance_id.as_deref()
            != request
                .params
                .get("processInstanceId")
                .and_then(Value::as_str)
    {
        return Err("invalid_request".into());
    }
    validate_terminal_cli_request(&request, nonce)?;
    Ok(request)
}

pub fn validate_terminal_cli_request(
    request: &TerminalCliRequest,
    expected_nonce: &str,
) -> Result<(), String> {
    if let Some(code) = terminal_cli_request_error_code(request, expected_nonce) {
        return Err(code.into());
    }
    Ok(())
}

fn exact_object<'a>(value: &'a Value, keys: &[&str]) -> Option<&'a Map<String, Value>> {
    let Value::Object(values) = value else {
        return None;
    };
    (values.len() == keys.len() && keys.iter().all(|key| values.contains_key(*key)))
        .then_some(values)
}

fn bounded_string(value: Option<&Value>) -> bool {
    value
        .and_then(Value::as_str)
        .is_some_and(|text| safe_text(text, MAX_PARAM_STRING))
}

fn valid_method_params(method: &str, params: &Value) -> bool {
    match method {
        "context.list" | "context.current" | "context.clear" | "context.sources"
        | "context.status" | "skills.list" | "skills.active" | "skills.clear" | "agent.list"
        | "agent.current" | "agent.clear" | "agent.status" | "note.new" | "daily.open"
        | "project.current" | "status" | "help" => exact_object(params, &[]).is_some(),
        "context.use" => {
            exact_object(params, &["map"]).is_some_and(|values| bounded_string(values.get("map")))
        }
        "context.search" => exact_object(params, &["query"])
            .is_some_and(|values| bounded_string(values.get("query"))),
        "context.ask" => exact_object(params, &["question"])
            .is_some_and(|values| bounded_string(values.get("question"))),
        "context.open" => exact_object(params, &["target"])
            .is_some_and(|values| bounded_string(values.get("target"))),
        "context.attach" => exact_object(params, &["entity", "mode"]).is_some_and(|values| {
            bounded_string(values.get("entity"))
                && matches!(
                    values.get("mode").and_then(Value::as_str),
                    Some("persistent" | "one_turn")
                )
        }),
        "context.refresh" => exact_object(params, &["map"]).is_some_and(|values| {
            values.get("map").is_some_and(|value| {
                value.is_null()
                    || value
                        .as_str()
                        .is_some_and(|text| safe_text(text, MAX_PARAM_STRING))
            })
        }),
        "context.create" => {
            let Value::Object(values) = params else {
                return false;
            };
            match values.get("sourceKind").and_then(Value::as_str) {
                Some("folder" | "file") => {
                    exact_object(params, &["sourceKind", "source"]).is_some()
                        && bounded_string(values.get("source"))
                }
                Some("github") => {
                    exact_object(params, &["sourceKind", "source", "ref"]).is_some()
                        && bounded_string(values.get("source"))
                        && bounded_string(values.get("ref"))
                }
                _ => false,
            }
        }
        "skills.use" | "skills.add" | "skills.remove" | "skills.inspect" => {
            exact_object(params, &["skill"])
                .is_some_and(|values| bounded_string(values.get("skill")))
        }
        "agent.use" => {
            exact_object(params, &["slug"]).is_some_and(|values| bounded_string(values.get("slug")))
        }
        "note.open" => {
            exact_object(params, &["name"]).is_some_and(|values| bounded_string(values.get("name")))
        }
        "note.link" => exact_object(params, &["source", "target"]).is_some_and(|values| {
            bounded_string(values.get("source")) && bounded_string(values.get("target"))
        }),
        "daily.add" => {
            exact_object(params, &["text"]).is_some_and(|values| bounded_string(values.get("text")))
        }
        "project.switch" => exact_object(params, &["projectId"])
            .is_some_and(|values| bounded_string(values.get("projectId"))),
        "cao.identity.publish" => exact_object(
            params,
            &[
                "opencodeSessionId",
                "providerId",
                "modelId",
                "variant",
                "processInstanceId",
            ],
        )
        .is_some_and(|values| {
            values
                .get("opencodeSessionId")
                .and_then(Value::as_str)
                .is_some_and(|value| safe_identity_value(value, MAX_OPENCODE_SESSION_ID, true))
                && values
                    .get("providerId")
                    .and_then(Value::as_str)
                    .is_some_and(|value| safe_identity_value(value, MAX_PROVIDER_ID, false))
                && values
                    .get("modelId")
                    .and_then(Value::as_str)
                    .is_some_and(|value| safe_identity_value(value, MAX_MODEL_ID, true))
                && values
                    .get("variant")
                    .and_then(Value::as_str)
                    .is_some_and(|value| safe_identity_value(value, MAX_VARIANT_ID, true))
                && values
                    .get("processInstanceId")
                    .and_then(Value::as_str)
                    .is_some_and(safe_atom)
        }),
        _ => false,
    }
}

pub fn terminal_cli_request_error_code(
    request: &TerminalCliRequest,
    expected_nonce: &str,
) -> Option<&'static str> {
    if !valid_nonce(&request.nonce)
        || !valid_nonce(expected_nonce)
        || !constant_time_eq(&request.nonce, expected_nonce)
    {
        return Some("authentication_failed");
    }
    if request.protocol_version != PROTOCOL_VERSION {
        return Some("unsupported_version");
    }
    if !safe_atom(&request.request_id)
        || request
            .terminal_session_id
            .as_deref()
            .is_some_and(|value| !safe_atom(value))
        || request
            .pane_id
            .as_deref()
            .is_some_and(|value| !safe_atom(value))
        || request
            .project_id
            .as_deref()
            .is_some_and(|value| !safe_atom(value))
        || request
            .run_identity
            .as_deref()
            .is_some_and(|value| !safe_atom(value))
        || (request.method == "context.ask" && request.run_identity.is_none())
        || (request.method == "cao.identity.publish"
            && (request.terminal_session_id.is_none()
                || request.pane_id.is_none()
                || request.project_id.is_none()))
        || !METHODS.contains(&request.method.as_str())
        || !valid_json(&request.params, 0)
        || !valid_method_params(&request.method, &request.params)
    {
        return Some("invalid_request");
    }
    None
}

fn validate_response(response: &TerminalCliResponse) -> Result<(), String> {
    if !safe_atom(&response.request_id)
        || !RESPONSE_CODES.contains(&response.code.as_str())
        || response.ok != (response.code == "ok")
        || !safe_text(&response.message, 2_000)
        || response
            .data
            .as_ref()
            .is_some_and(|value| !valid_response_json(value, 0))
        || serde_json::to_vec(response)
            .map(|bytes| bytes.len() as u64 > MAX_WIRE_BYTES)
            .unwrap_or(true)
    {
        return Err("invalid terminal CLI response".into());
    }
    Ok(())
}

pub fn render_terminal_cli_response(
    response: &TerminalCliResponse,
    json_output: bool,
    color: bool,
) -> Result<String, String> {
    validate_response(response)?;
    if json_output {
        return serde_json::to_string(response).map_err(|error| format!("serialize: {error}"));
    }
    let plain = response
        .data
        .as_ref()
        .and_then(|data| data.get("answer"))
        .and_then(Value::as_str)
        .unwrap_or(&response.message);
    if color {
        let color_code = if response.ok { "32" } else { "31" };
        return Ok(format!("\u{1b}[{color_code}m{plain}\u{1b}[0m"));
    }
    Ok(plain.to_string())
}

fn shell_quote(value: &Path) -> Result<String, String> {
    let value = value
        .to_str()
        .ok_or_else(|| "CLI path is not valid UTF-8".to_string())?;
    if value.chars().any(|ch| matches!(ch, '\0' | '\r' | '\n')) {
        return Err("CLI path contains control characters".into());
    }
    Ok(value.replace('\'', "'\"'\"'"))
}

pub fn windows_terminal_cli_shim(executable: &Path, endpoint: &Path) -> Result<String, String> {
    let executable = executable
        .to_str()
        .ok_or_else(|| "CLI executable path is not valid UTF-8".to_string())?;
    let endpoint = endpoint
        .to_str()
        .ok_or_else(|| "CLI endpoint path is not valid UTF-8".to_string())?;
    if [executable, endpoint].iter().any(|value| {
        value
            .chars()
            .any(|ch| matches!(ch, '\0' | '\r' | '\n' | '"'))
    }) {
        return Err("CLI path cannot be represented safely".into());
    }
    let executable = executable.replace('%', "%%");
    let endpoint = endpoint.replace('%', "%%");
    Ok(format!(
        "@echo off\r\n:: {MANAGED_MARKER}\r\nsetlocal DisableDelayedExpansion\r\n\"{executable}\" --vibespace-cli --endpoint \"{endpoint}\" %*\r\n"
    ))
}

pub fn unix_terminal_cli_shim(executable: &Path, endpoint: &Path) -> Result<String, String> {
    Ok(format!(
        "#!/usr/bin/env sh\n# {MANAGED_MARKER}\nexec '{}' --vibespace-cli --endpoint '{}' \"$@\"\n",
        shell_quote(executable)?,
        shell_quote(endpoint)?
    ))
}

pub fn powershell_terminal_prompt_integration() -> &'static str {
    r#"# VibeSpace emits prompt-boundary evidence only; it never records shell input here.
if (-not (Test-Path variable:global:VibeSpaceOriginalPrompt)) {
  $global:VibeSpaceOriginalPrompt = $function:prompt
}
function global:prompt {
  [string]$vibespacePrompt = if ($global:VibeSpaceOriginalPrompt) {
    (& $global:VibeSpaceOriginalPrompt)
  } else {
    "PS $($executionContext.SessionState.Path.CurrentLocation)> "
  }
  "`e]133;A`a${vibespacePrompt}`e]133;B`a"
}"#
}

pub fn bash_terminal_prompt_integration() -> &'static str {
    r#"# VibeSpace emits prompt-boundary evidence only; it never records shell input here.
if [[ $- == *i* ]] && [[ ${PS1-} != *']133;A'* ]]; then
  PS1='\[\e]133;A\a\]'"${PS1-}"'\[\e]133;B\a\]'
fi"#
}

pub fn zsh_terminal_prompt_integration() -> &'static str {
    r#"# VibeSpace emits prompt-boundary evidence only; it never records shell input here.
if [[ -o interactive ]] && [[ ${PROMPT-} != *']133;A'* ]]; then
  PROMPT=$'%{\e]133;A\a%}'"${PROMPT-}"$'%{\e]133;B\a%}'
fi"#
}

pub fn fish_terminal_prompt_integration() -> &'static str {
    r#"# VibeSpace emits prompt-boundary evidence only; it never records shell input here.
if status is-interactive
  if functions -q fish_prompt; and not functions -q __vibespace_original_fish_prompt
    functions -c fish_prompt __vibespace_original_fish_prompt
    function fish_prompt
      printf '\e]133;A\a'
      __vibespace_original_fish_prompt
      printf '\e]133;B\a'
    end
  end
end"#
}

#[derive(Debug, Clone, Copy)]
struct ManagedShellBlock {
    start: usize,
    end: usize,
    prior_exists: bool,
    prior_eol: bool,
}

fn line_end(content: &str, start: usize) -> usize {
    content[start..]
        .find('\n')
        .map_or(content.len(), |offset| start + offset + 1)
}

fn line_without_ending(content: &str, start: usize, end: usize) -> &str {
    let line = content[start..end]
        .strip_suffix('\n')
        .unwrap_or(&content[start..end]);
    line.strip_suffix('\r').unwrap_or(line)
}

fn parse_managed_shell_block(content: &str) -> Result<Option<ManagedShellBlock>, String> {
    let starts = content
        .match_indices(SHELL_INTEGRATION_START_PREFIX)
        .map(|(index, _)| index)
        .collect::<Vec<_>>();
    let ends = content
        .match_indices(SHELL_INTEGRATION_END)
        .map(|(index, _)| index)
        .collect::<Vec<_>>();
    if starts.is_empty() && ends.is_empty() {
        if content.contains(SHELL_INTEGRATION_MARKER) {
            return Err("The VibeSpace shell integration marker is damaged.".into());
        }
        return Ok(None);
    }
    if starts.len() != 1 || ends.len() != 1 || starts[0] >= ends[0] {
        return Err("The VibeSpace shell integration markers are ambiguous.".into());
    }

    let start = starts[0];
    let end_marker = ends[0];
    if (start > 0 && content.as_bytes()[start - 1] != b'\n')
        || (end_marker > 0 && content.as_bytes()[end_marker - 1] != b'\n')
    {
        return Err("The VibeSpace shell integration markers are not complete lines.".into());
    }
    let start_end = line_end(content, start);
    let end = line_end(content, end_marker);
    let start_line = line_without_ending(content, start, start_end);
    let end_line = line_without_ending(content, end_marker, end);
    if end_line != SHELL_INTEGRATION_END {
        return Err("The VibeSpace shell integration end marker is damaged.".into());
    }

    let metadata = start_line
        .strip_prefix(SHELL_INTEGRATION_START_PREFIX)
        .and_then(|value| value.strip_suffix(" >>>"))
        .ok_or_else(|| "The VibeSpace shell integration metadata is invalid.".to_string())?;
    let mut parts = metadata.split(' ');
    let prior_exists = match parts.next() {
        Some("prior_exists=0") => false,
        Some("prior_exists=1") => true,
        _ => return Err("The VibeSpace shell integration metadata is invalid.".into()),
    };
    let prior_eol = match parts.next() {
        Some("prior_eol=0") => false,
        Some("prior_eol=1") => true,
        _ => return Err("The VibeSpace shell integration metadata is invalid.".into()),
    };
    if parts.next().is_some() {
        return Err("The VibeSpace shell integration metadata is invalid.".into());
    }

    Ok(Some(ManagedShellBlock {
        start,
        end,
        prior_exists,
        prior_eol,
    }))
}

fn preferred_line_ending(content: &str) -> &'static str {
    if content.contains("\r\n") {
        "\r\n"
    } else {
        "\n"
    }
}

fn terminal_shell_block(
    integration: &str,
    prior_exists: bool,
    prior_eol: bool,
    eol: &str,
) -> Result<String, String> {
    if integration.is_empty()
        || integration.len() > 16_384
        || integration.contains(SHELL_INTEGRATION_MARKER)
        || integration
            .chars()
            .any(|character| character == '\0' || character == '\u{feff}')
    {
        return Err("The VibeSpace shell integration body is invalid.".into());
    }
    let body = integration
        .replace("\r\n", "\n")
        .trim_matches('\n')
        .replace('\n', eol);
    Ok(format!(
        "{SHELL_INTEGRATION_START_PREFIX}prior_exists={} prior_eol={} >>>{eol}{body}{eol}{SHELL_INTEGRATION_END}{eol}",
        u8::from(prior_exists),
        u8::from(prior_eol)
    ))
}

pub fn merge_managed_terminal_shell_profile(
    existing: Option<&str>,
    integration: &str,
) -> Result<String, String> {
    let content = existing.unwrap_or_default();
    let current = parse_managed_shell_block(content)?;
    let eol = preferred_line_ending(content);
    let (prior_exists, prior_eol) = current.map_or_else(
        || {
            (
                existing.is_some(),
                content.is_empty() || content.ends_with('\n'),
            )
        },
        |block| (block.prior_exists, block.prior_eol),
    );
    let block = terminal_shell_block(integration, prior_exists, prior_eol, eol)?;

    if let Some(current) = current {
        return Ok(format!(
            "{}{}{}",
            &content[..current.start],
            block,
            &content[current.end..]
        ));
    }

    let separator = if content.is_empty() || prior_eol {
        ""
    } else {
        eol
    };
    Ok(format!("{content}{separator}{block}"))
}

pub fn remove_managed_terminal_shell_profile(existing: &str) -> Result<Option<String>, String> {
    let Some(block) = parse_managed_shell_block(existing)? else {
        return Ok(Some(existing.to_string()));
    };
    let mut prefix = existing[..block.start].to_string();
    if !block.prior_eol {
        if prefix.ends_with("\r\n") {
            prefix.truncate(prefix.len() - 2);
        } else if prefix.ends_with('\n') {
            prefix.truncate(prefix.len() - 1);
        } else {
            return Err("The VibeSpace shell integration separator is damaged.".into());
        }
    }
    prefix.push_str(&existing[block.end..]);
    if !block.prior_exists && prefix.is_empty() {
        Ok(None)
    } else {
        Ok(Some(prefix))
    }
}

fn read_terminal_shell_profile(path: &Path) -> Result<Option<String>, String> {
    match fs::symlink_metadata(path) {
        Ok(metadata) => {
            if metadata.file_type().is_symlink() {
                return Err(format!(
                    "Refusing to modify a symbolic-link shell profile: {}",
                    path.display()
                ));
            }
            if !metadata.is_file() {
                return Err(format!(
                    "The shell profile path is not a regular file: {}",
                    path.display()
                ));
            }
            if metadata.len() > MAX_SHELL_PROFILE_BYTES {
                return Err("The shell profile is too large to modify safely.".into());
            }
            fs::read_to_string(path)
                .map(Some)
                .map_err(|error| format!("Shell profile read failed: {error}"))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("Shell profile metadata failed: {error}")),
    }
}

fn write_terminal_shell_profile(path: &Path, content: Option<&str>) -> Result<(), String> {
    let existing_metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => {
            if metadata.file_type().is_symlink() {
                return Err(format!(
                    "Refusing to modify a symbolic-link shell profile: {}",
                    path.display()
                ));
            }
            if !metadata.is_file() {
                return Err(format!(
                    "The shell profile path is not a regular file: {}",
                    path.display()
                ));
            }
            Some(metadata)
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => return Err(format!("Shell profile metadata failed: {error}")),
    };

    let Some(content) = content else {
        return privileged_effect(EFFECT_SHELL_FILE_REMOVE, || match fs::remove_file(path) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(format!("Shell profile removal failed: {error}")),
        });
    };
    if content.len() as u64 > MAX_SHELL_PROFILE_BYTES || content.contains('\0') {
        return Err("The shell profile content is invalid.".into());
    }
    let parent = path
        .parent()
        .ok_or_else(|| "The shell profile path has no parent.".to_string())?;
    privileged_effect(EFFECT_SHELL_DIRECTORY_CREATE, || {
        fs::create_dir_all(parent).map_err(|error| format!("Shell profile directory: {error}"))
    })?;
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "The shell profile path has no valid file name.".to_string())?;
    let temporary = path.with_file_name(format!(
        ".{file_name}.{}.{}.vibespace.tmp",
        std::process::id(),
        nanoid::nanoid!(12)
    ));
    let mut file = privileged_effect(EFFECT_SHELL_FILE_CREATE, || {
        OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(|error| format!("Shell profile temporary create failed: {error}"))
    })?;
    if let Err(error) = privileged_effect(EFFECT_SHELL_FILE_WRITE, || {
        file.write_all(content.as_bytes())
            .map_err(|error| error.to_string())
    }) {
        drop(file);
        let _ = privileged_effect(EFFECT_SHELL_WRITE_CLEANUP_REMOVE, || {
            fs::remove_file(&temporary).map_err(|error| error.to_string())
        });
        return Err(format!("Shell profile write failed: {error}"));
    }
    if let Err(error) = privileged_effect(EFFECT_SHELL_FILE_FLUSH, || {
        file.sync_all().map_err(|error| error.to_string())
    }) {
        drop(file);
        let _ = privileged_effect(EFFECT_SHELL_FLUSH_CLEANUP_REMOVE, || {
            fs::remove_file(&temporary).map_err(|error| error.to_string())
        });
        return Err(format!("Shell profile flush failed: {error}"));
    }
    drop(file);
    if let Some(metadata) = existing_metadata {
        if let Err(error) = privileged_effect(EFFECT_SHELL_FILE_PERMISSIONS_WRITE, || {
            fs::set_permissions(&temporary, metadata.permissions())
                .map_err(|error| error.to_string())
        }) {
            let _ = privileged_effect(EFFECT_SHELL_PERMISSIONS_CLEANUP_REMOVE, || {
                fs::remove_file(&temporary).map_err(|error| error.to_string())
            });
            return Err(format!("Shell profile permissions failed: {error}"));
        }
    }
    if let Err(error) = atomic_replace_file(&temporary, path) {
        let _ = privileged_effect(EFFECT_SHELL_REPLACE_CLEANUP_REMOVE, || {
            fs::remove_file(&temporary).map_err(|error| error.to_string())
        });
        return Err(format!("Shell profile replace failed: {error}"));
    }
    Ok(())
}

pub fn install_managed_terminal_shell_profile(
    path: &Path,
    integration: &str,
) -> Result<(), String> {
    let existing = read_terminal_shell_profile(path)?;
    let next = merge_managed_terminal_shell_profile(existing.as_deref(), integration)?;
    write_terminal_shell_profile(path, Some(&next))
}

pub fn uninstall_managed_terminal_shell_profile(path: &Path) -> Result<(), String> {
    let Some(existing) = read_terminal_shell_profile(path)? else {
        return Ok(());
    };
    let next = remove_managed_terminal_shell_profile(&existing)?;
    if next.as_deref() == Some(existing.as_str()) {
        return Ok(());
    }
    write_terminal_shell_profile(path, next.as_deref())
}

fn keyring_entry() -> Result<Entry, String> {
    privileged_effect(EFFECT_KEYRING_ENTRY, || {
        Entry::new(KEYRING_SERVICE, KEYRING_ACCOUNT)
            .map_err(|error| format!("terminal CLI credential store unavailable: {error}"))
    })
}

fn keyring_set(nonce: &str) -> Result<(), String> {
    let entry = keyring_entry()?;
    privileged_effect(EFFECT_KEYRING_SET, || {
        entry
            .set_password(nonce)
            .map_err(|error| format!("terminal CLI credential save failed: {error}"))
    })
}

fn keyring_read() -> Result<String, String> {
    let entry = keyring_entry()?;
    privileged_effect(EFFECT_KEYRING_READ, || {
        entry
            .get_password()
            .map_err(|error| format!("terminal CLI credential read failed: {error}"))
    })
}

fn generate_nonce() -> Result<String, String> {
    let random = nanoid::nanoid!(96);
    let time = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| format!("clock: {error}"))?
        .as_nanos();
    let mut digest = Sha256::new();
    digest.update(random.as_bytes());
    digest.update(time.to_le_bytes());
    digest.update(std::process::id().to_le_bytes());
    Ok(format!("{:x}", digest.finalize()))
}

fn write_endpoint(path: &Path, endpoint: &TerminalCliEndpoint) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "terminal CLI endpoint has no parent".to_string())?;
    privileged_effect(EFFECT_ENDPOINT_DIRECTORY_CREATE, || {
        fs::create_dir_all(parent).map_err(|error| format!("endpoint directory: {error}"))
    })?;
    let temporary = path.with_file_name(format!(
        ".endpoint.{}.{}.json.tmp",
        std::process::id(),
        nanoid::nanoid!(12)
    ));
    let bytes =
        serde_json::to_vec(endpoint).map_err(|error| format!("endpoint serialize: {error}"))?;
    let mut file = privileged_effect(EFFECT_ENDPOINT_FILE_CREATE, || {
        OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(|error| format!("endpoint create: {error}"))
    })?;
    privileged_effect(EFFECT_ENDPOINT_FILE_WRITE, || {
        file.write_all(&bytes)
            .map_err(|error| format!("endpoint write: {error}"))
    })?;
    privileged_effect(EFFECT_ENDPOINT_FILE_FLUSH, || {
        file.sync_all()
            .map_err(|error| format!("endpoint flush: {error}"))
    })?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        privileged_effect(EFFECT_ENDPOINT_FILE_PERMISSIONS_WRITE, || {
            fs::set_permissions(&temporary, fs::Permissions::from_mode(0o600))
                .map_err(|error| format!("endpoint permissions: {error}"))
        })?;
    }
    if let Err(error) = atomic_replace_file(&temporary, path) {
        let _ = privileged_effect(EFFECT_ENDPOINT_REPLACE_CLEANUP_REMOVE, || {
            fs::remove_file(&temporary).map_err(|error| error.to_string())
        });
        return Err(format!("endpoint replace: {error}"));
    }
    Ok(())
}

fn response(
    request_id: &str,
    ok: bool,
    code: &str,
    message: &str,
    data: Option<Value>,
) -> TerminalCliResponse {
    TerminalCliResponse {
        request_id: request_id.into(),
        ok,
        code: code.into(),
        message: message.into(),
        data,
    }
}

fn write_wire_response(
    stream: &mut TcpStream,
    response: &TerminalCliResponse,
) -> Result<(), String> {
    validate_response(response)?;
    let mut bytes =
        serde_json::to_vec(response).map_err(|error| format!("response serialize: {error}"))?;
    bytes.push(b'\n');
    stream
        .write_all(&bytes)
        .map_err(|error| format!("response write: {error}"))
}

pub fn read_terminal_cli_wire_line<R: BufRead>(
    reader: &mut R,
    maximum: usize,
) -> Result<String, String> {
    let limit = maximum
        .checked_add(2)
        .ok_or_else(|| "terminal CLI wire size limit is invalid".to_string())?;
    let mut bytes = Vec::with_capacity(maximum.min(8_192));
    reader
        .take(limit as u64)
        .read_until(b'\n', &mut bytes)
        .map_err(|error| format!("terminal CLI wire read failed: {error}"))?;
    if bytes.last() != Some(&b'\n') {
        return Err(if bytes.len() > maximum {
            "terminal CLI wire message exceeds size limit".into()
        } else {
            "terminal CLI wire message is incomplete".into()
        });
    }
    bytes.pop();
    if bytes.last() == Some(&b'\r') {
        bytes.pop();
    }
    if bytes.len() > maximum {
        return Err("terminal CLI wire message exceeds size limit".into());
    }
    String::from_utf8(bytes).map_err(|_| "terminal CLI wire message is not valid UTF-8".into())
}

fn handle_connection(
    mut stream: TcpStream,
    expected_nonce: &str,
    app: &tauri::AppHandle,
    pending: &Arc<Mutex<HashMap<String, SyncSender<TerminalCliResponse>>>>,
) -> Result<(), String> {
    stream
        .set_read_timeout(Some(RESPONSE_TIMEOUT))
        .map_err(|error| format!("read timeout: {error}"))?;
    stream
        .set_write_timeout(Some(RESPONSE_TIMEOUT))
        .map_err(|error| format!("write timeout: {error}"))?;
    let mut reader = BufReader::new(
        stream
            .try_clone()
            .map_err(|error| format!("stream clone: {error}"))?,
    );
    let line = read_terminal_cli_wire_line(&mut reader, MAX_WIRE_BYTES as usize)?;
    let request: TerminalCliRequest =
        serde_json::from_str(&line).map_err(|_| "invalid terminal CLI request JSON".to_string())?;
    if let Some(code) = terminal_cli_request_error_code(&request, expected_nonce) {
        let message = match code {
            "unsupported_version" => "This VibeSpace CLI protocol version is not supported.",
            "invalid_request" => "The terminal CLI request is invalid.",
            _ => "Terminal CLI authentication failed.",
        };
        let failure = response(&request.request_id, false, code, message, None);
        let _ = write_wire_response(&mut stream, &failure);
        return Err(code.into());
    }
    if request.method == "status" {
        return write_wire_response(
            &mut stream,
            &response(
                &request.request_id,
                true,
                "ok",
                "VibeSpace is running.",
                Some(json!({
                    "version": env!("CARGO_PKG_VERSION"),
                    "protocolVersion": PROTOCOL_VERSION
                })),
            ),
        );
    }
    if request.method == "help" {
        return write_wire_response(
            &mut stream,
            &response(
                &request.request_id,
                true,
                "ok",
                "Commands: vibespace-context ask, context, skills, agent, note, daily, project, cao identity publish, status, help.",
                Some(json!({ "methods": METHODS })),
            ),
        );
    }

    let (sender, receiver) = mpsc::sync_channel(1);
    {
        let mut map = pending
            .lock()
            .map_err(|_| "terminal CLI pending registry unavailable".to_string())?;
        if map.contains_key(&request.request_id) {
            return write_wire_response(
                &mut stream,
                &response(
                    &request.request_id,
                    false,
                    "conflict",
                    "Duplicate terminal CLI request.",
                    None,
                ),
            );
        }
        map.insert(request.request_id.clone(), sender);
    }
    let response_timeout = terminal_cli_response_timeout(&request.method);
    let event = TerminalCliFrontendRequest {
        protocol_version: request.protocol_version,
        request_id: request.request_id.clone(),
        terminal_session_id: request.terminal_session_id,
        pane_id: request.pane_id,
        project_id: request.project_id,
        run_identity: request.run_identity,
        method: request.method,
        params: request.params,
    };
    if let Err(error) = app.emit("jarvis:terminal-cli-request", event) {
        eprintln!("[terminal-cli] frontend route failed: {error}");
        pending
            .lock()
            .ok()
            .and_then(|mut map| map.remove(&request.request_id));
        return write_wire_response(
            &mut stream,
            &response(
                &request.request_id,
                false,
                "internal_error",
                "Could not route the terminal CLI request.",
                None,
            ),
        );
    }
    let result = receiver.recv_timeout(response_timeout).unwrap_or_else(|_| {
        response(
            &request.request_id,
            false,
            "internal_error",
            "VibeSpace did not complete the terminal CLI request in time.",
            None,
        )
    });
    pending
        .lock()
        .ok()
        .and_then(|mut map| map.remove(&request.request_id));
    write_wire_response(&mut stream, &result)
}

pub fn start_terminal_cli_server(
    app: &tauri::AppHandle,
    state: &TerminalCliState,
) -> Result<PathBuf, String> {
    let listener = TcpListener::bind(SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0))
        .map_err(|error| format!("terminal CLI bind: {error}"))?;
    let address = listener
        .local_addr()
        .map_err(|error| format!("terminal CLI address: {error}"))?;
    let nonce = generate_nonce()?;
    keyring_set(&nonce)?;
    let endpoint_path = app
        .path()
        .app_local_data_dir()
        .map_err(|error| format!("terminal CLI app data: {error}"))?
        .join("terminal-cli")
        .join("endpoint.json");
    write_endpoint(
        &endpoint_path,
        &TerminalCliEndpoint {
            protocol_version: PROTOCOL_VERSION,
            address: address.to_string(),
            keyring_service: KEYRING_SERVICE.into(),
            keyring_account: KEYRING_ACCOUNT.into(),
        },
    )?;
    let private_bin_dir = endpoint_path
        .parent()
        .ok_or_else(|| "terminal CLI endpoint directory unavailable".to_string())?
        .join("bin");
    let executable =
        std::env::current_exe().map_err(|error| format!("current executable: {error}"))?;
    let content = expected_shim(&executable, &endpoint_path)?;
    create_terminal_cli_bin_directory(&private_bin_dir)?;
    let private_paths = terminal_cli_names().map(|name| private_bin_dir.join(name));
    replace_managed_terminal_cli_aliases(&private_paths, &content)?;
    *state
        .private_bin_dir
        .lock()
        .map_err(|_| "terminal CLI private bin state unavailable".to_string())? =
        Some(private_bin_dir);
    *state
        .endpoint_path
        .lock()
        .map_err(|_| "terminal CLI endpoint state unavailable".to_string())? =
        Some(endpoint_path.clone());

    let app = app.clone();
    let pending = Arc::clone(&state.pending);
    let limiter = TerminalCliConnectionLimiter::new(MAX_ACTIVE_CONNECTIONS);
    std::thread::spawn(move || {
        for connection in listener.incoming() {
            let Ok(stream) = connection else {
                continue;
            };
            let Some(permit) = limiter.try_acquire() else {
                drop(stream);
                continue;
            };
            let app = app.clone();
            let pending = Arc::clone(&pending);
            let nonce = nonce.clone();
            std::thread::spawn(move || {
                let _permit = permit;
                if let Err(error) = handle_connection(stream, &nonce, &app, &pending) {
                    eprintln!("[terminal-cli] {error}");
                }
            });
        }
    });
    Ok(endpoint_path)
}

fn read_endpoint(path: &Path) -> Result<TerminalCliEndpoint, TerminalCliEndpointError> {
    let bytes = fs::read(path).map_err(|error| TerminalCliEndpointError {
        code: if error.kind() == std::io::ErrorKind::PermissionDenied {
            "permission_denied"
        } else {
            "app_not_running"
        },
        message: if error.kind() == std::io::ErrorKind::PermissionDenied {
            "The VibeSpace terminal CLI endpoint is not readable."
        } else {
            "VibeSpace is not running."
        },
    })?;
    if bytes.len() as u64 > MAX_WIRE_BYTES {
        return Err(TerminalCliEndpointError {
            code: "invalid_request",
            message: "The VibeSpace terminal CLI endpoint is invalid.",
        });
    }
    let endpoint: TerminalCliEndpoint =
        serde_json::from_slice(&bytes).map_err(|_| TerminalCliEndpointError {
            code: "invalid_request",
            message: "The VibeSpace terminal CLI endpoint is invalid.",
        })?;
    if endpoint.protocol_version != PROTOCOL_VERSION {
        return Err(TerminalCliEndpointError {
            code: "unsupported_version",
            message: "This VibeSpace CLI protocol version is not supported.",
        });
    }
    if endpoint.keyring_service != KEYRING_SERVICE || endpoint.keyring_account != KEYRING_ACCOUNT {
        return Err(TerminalCliEndpointError {
            code: "authentication_failed",
            message: "The VibeSpace terminal CLI endpoint identity is invalid.",
        });
    }
    let address: SocketAddr = endpoint
        .address
        .parse()
        .map_err(|_| TerminalCliEndpointError {
            code: "invalid_request",
            message: "The VibeSpace terminal CLI endpoint address is invalid.",
        })?;
    if address.ip() != IpAddr::V4(Ipv4Addr::LOCALHOST) {
        return Err(TerminalCliEndpointError {
            code: "invalid_request",
            message: "The VibeSpace terminal CLI endpoint is not loopback-only.",
        });
    }
    Ok(endpoint)
}

fn request_id() -> Result<String, String> {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| format!("clock: {error}"))?
        .as_nanos();
    Ok(format!("cli-{}-{nanos}", std::process::id()))
}

fn send_terminal_cli_request(invocation: &TerminalCliInvocation) -> TerminalCliResponse {
    let id = request_id().unwrap_or_else(|_| format!("cli-{}", std::process::id()));
    let endpoint = match read_endpoint(&invocation.endpoint) {
        Ok(endpoint) => endpoint,
        Err(error) => {
            return response(&id, false, error.code, error.message, None);
        }
    };
    let nonce = match keyring_read() {
        Ok(nonce) => nonce,
        Err(message) => {
            return response(&id, false, "authentication_failed", &message, None);
        }
    };
    let request = match build_terminal_cli_request(invocation, &nonce, &id) {
        Ok(request) => request,
        Err(message) => return response(&id, false, "invalid_request", &message, None),
    };
    let address: SocketAddr = match endpoint.address.parse() {
        Ok(address) => address,
        Err(_) => {
            return response(
                &id,
                false,
                "app_not_running",
                "VibeSpace is not running.",
                None,
            )
        }
    };
    let mut stream = match TcpStream::connect_timeout(&address, CONNECT_TIMEOUT) {
        Ok(stream) => stream,
        Err(_) => {
            return response(
                &id,
                false,
                "app_not_running",
                "VibeSpace is not running.",
                None,
            )
        }
    };
    let _ = stream.set_read_timeout(Some(terminal_cli_response_timeout(&request.method)));
    let _ = stream.set_write_timeout(Some(RESPONSE_TIMEOUT));
    let mut bytes = match serde_json::to_vec(&request) {
        Ok(bytes) => bytes,
        Err(error) => {
            return response(
                &id,
                false,
                "invalid_request",
                &format!("Could not encode request: {error}"),
                None,
            )
        }
    };
    bytes.push(b'\n');
    if stream.write_all(&bytes).is_err() {
        return response(
            &id,
            false,
            "app_not_running",
            "VibeSpace is not running.",
            None,
        );
    }
    let output =
        match read_terminal_cli_wire_line(&mut BufReader::new(stream), MAX_WIRE_BYTES as usize) {
            Ok(output) => output,
            Err(_) => {
                return response(
                    &id,
                    false,
                    "internal_error",
                    "VibeSpace returned an invalid terminal CLI response.",
                    None,
                )
            }
        };
    match serde_json::from_str::<TerminalCliResponse>(&output) {
        Ok(response) if validate_response(&response).is_ok() && response.request_id == id => {
            response
        }
        _ => response(
            &id,
            false,
            "internal_error",
            "VibeSpace returned an invalid terminal CLI response.",
            None,
        ),
    }
}

pub fn run_terminal_cli(args: &[String]) -> i32 {
    let invocation = match parse_terminal_cli_args(args) {
        Ok(invocation) => invocation,
        Err(message) => {
            eprintln!("{message}");
            return 2;
        }
    };
    let response = send_terminal_cli_request(&invocation);
    let rendered = render_terminal_cli_response(&response, invocation.json, invocation.color)
        .unwrap_or_else(|_| "VibeSpace returned an invalid terminal CLI response.".into());
    if response.ok {
        println!("{rendered}");
        0
    } else {
        eprintln!("{rendered}");
        match response.code.as_str() {
            "app_not_running" => 3,
            "authentication_failed" => 4,
            "invalid_request" | "unsupported_version" => 2,
            _ => 1,
        }
    }
}

fn terminal_cli_names() -> [&'static str; 3] {
    #[cfg(target_os = "windows")]
    {
        ["vibespace.cmd", "vs.cmd", "vibespace-context.cmd"]
    }
    #[cfg(not(target_os = "windows"))]
    {
        ["vibespace", "vs", "vibespace-context"]
    }
}

fn terminal_cli_paths() -> Result<(PathBuf, [&'static str; 3]), String> {
    #[cfg(target_os = "windows")]
    {
        let home = std::env::var_os("USERPROFILE")
            .map(PathBuf::from)
            .ok_or_else(|| "USERPROFILE is unavailable".to_string())?;
        return Ok((home.join(".jarvis").join("bin"), terminal_cli_names()));
    }
    #[cfg(not(target_os = "windows"))]
    {
        let home = std::env::var_os("HOME")
            .map(PathBuf::from)
            .ok_or_else(|| "HOME is unavailable".to_string())?;
        Ok((home.join(".jarvis").join("bin"), terminal_cli_names()))
    }
}

fn terminal_shell_profile_targets() -> Result<Vec<TerminalShellProfileTarget>, String> {
    #[cfg(target_os = "windows")]
    {
        let home = std::env::var_os("USERPROFILE")
            .map(PathBuf::from)
            .ok_or_else(|| "USERPROFILE is unavailable".to_string())?;
        let default_documents = home.join("Documents");
        let documents = std::env::var_os("OneDrive")
            .map(PathBuf::from)
            .map(|path| path.join("Documents"))
            .filter(|path| path.is_dir())
            .unwrap_or(default_documents);
        return Ok(vec![
            TerminalShellProfileTarget {
                shell: TerminalShellKind::PowerShell,
                path: documents
                    .join("PowerShell")
                    .join("Microsoft.PowerShell_profile.ps1"),
            },
            TerminalShellProfileTarget {
                shell: TerminalShellKind::PowerShell,
                path: documents
                    .join("WindowsPowerShell")
                    .join("Microsoft.PowerShell_profile.ps1"),
            },
        ]);
    }
    #[cfg(not(target_os = "windows"))]
    {
        let home = std::env::var_os("HOME")
            .map(PathBuf::from)
            .ok_or_else(|| "HOME is unavailable".to_string())?;
        let candidates = [
            (TerminalShellKind::Bash, home.join(".bashrc")),
            (TerminalShellKind::Zsh, home.join(".zshrc")),
            (
                TerminalShellKind::Fish,
                home.join(".config").join("fish").join("config.fish"),
            ),
        ];
        let mut targets = candidates
            .iter()
            .filter(|(_, path)| path.is_file())
            .map(|(shell, path)| TerminalShellProfileTarget {
                shell: *shell,
                path: path.clone(),
            })
            .collect::<Vec<_>>();
        if targets.is_empty() {
            let shell = std::env::var_os("SHELL")
                .and_then(|path| PathBuf::from(path).file_name().map(|name| name.to_owned()))
                .and_then(|name| name.to_str().map(str::to_owned));
            let target = match shell.as_deref() {
                Some("bash") => Some((TerminalShellKind::Bash, home.join(".bashrc"))),
                Some("zsh") => Some((TerminalShellKind::Zsh, home.join(".zshrc"))),
                Some("fish") => Some((
                    TerminalShellKind::Fish,
                    home.join(".config").join("fish").join("config.fish"),
                )),
                _ => None,
            };
            if let Some((shell, path)) = target {
                targets.push(TerminalShellProfileTarget { shell, path });
            }
        }
        Ok(targets)
    }
}

fn restore_terminal_shell_profiles(
    originals: &[(TerminalShellProfileTarget, Option<String>)],
) -> Result<(), String> {
    let mut errors = Vec::new();
    for (target, original) in originals.iter().rev() {
        if let Err(error) = write_terminal_shell_profile(&target.path, original.as_deref()) {
            errors.push(format!("{}: {error}", target.path.display()));
        }
    }
    if errors.is_empty() {
        Ok(())
    } else {
        Err(format!(
            "Shell profile rollback failed for {}",
            errors.join(", ")
        ))
    }
}

fn mutate_terminal_shell_profiles(
    targets: &[TerminalShellProfileTarget],
    install: bool,
) -> Result<(), String> {
    if targets.is_empty() {
        return Err("No supported shell profile is available.".into());
    }
    let originals = targets
        .iter()
        .map(|target| {
            read_terminal_shell_profile(&target.path).map(|content| (target.clone(), content))
        })
        .collect::<Result<Vec<_>, _>>()?;

    let mut applied = 0;
    for target in targets {
        let result = if install {
            install_managed_terminal_shell_profile(&target.path, target.shell.integration())
        } else {
            uninstall_managed_terminal_shell_profile(&target.path)
        };
        if let Err(error) = result {
            return match restore_terminal_shell_profiles(&originals[..applied]) {
                Ok(()) => Err(error),
                Err(rollback) => Err(format!("{error}; {rollback}")),
            };
        }
        applied += 1;
    }
    Ok(())
}

fn terminal_shell_integration_status_impl() -> TerminalShellIntegrationStatus {
    let targets = terminal_shell_profile_targets().unwrap_or_default();
    let profiles = targets
        .iter()
        .map(|target| {
            let installed = read_terminal_shell_profile(&target.path)
                .ok()
                .flatten()
                .is_some_and(|content| {
                    merge_managed_terminal_shell_profile(Some(&content), target.shell.integration())
                        .is_ok_and(|expected| expected == content)
                });
            TerminalShellProfileStatus {
                shell: target.shell.label(),
                path: target.path.to_string_lossy().into_owned(),
                installed,
            }
        })
        .collect::<Vec<_>>();
    TerminalShellIntegrationStatus {
        available: !profiles.is_empty(),
        installed: !profiles.is_empty() && profiles.iter().all(|profile| profile.installed),
        profiles,
    }
}

fn expected_shim(executable: &Path, endpoint: &Path) -> Result<String, String> {
    #[cfg(target_os = "windows")]
    {
        windows_terminal_cli_shim(executable, endpoint)
    }
    #[cfg(not(target_os = "windows"))]
    {
        unix_terminal_cli_shim(executable, endpoint)
    }
}

fn managed_file(path: &Path) -> Result<bool, String> {
    match fs::read_to_string(path) {
        Ok(content) => Ok(content.lines().take(2).any(|line| {
            matches!(
                line,
                "# VIBESPACE_CLI_MANAGED_V1" | ":: VIBESPACE_CLI_MANAGED_V1"
            )
        })),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(format!("CLI shim read failed: {error}")),
    }
}

#[cfg(target_os = "windows")]
fn atomic_replace_file(temporary: &Path, destination: &Path) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows::core::PCWSTR;
    use windows::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };

    let temporary_wide = temporary
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let destination_wide = destination
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    privileged_effect(EFFECT_FILE_REPLACE_WINDOWS, || {
        unsafe {
            MoveFileExW(
                PCWSTR(temporary_wide.as_ptr()),
                PCWSTR(destination_wide.as_ptr()),
                MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
            )
        }
        .map_err(|error| error.to_string())
    })
}

#[cfg(not(target_os = "windows"))]
fn atomic_replace_file(temporary: &Path, destination: &Path) -> Result<(), String> {
    privileged_effect(EFFECT_FILE_RENAME, || {
        fs::rename(temporary, destination).map_err(|error| error.to_string())
    })
}

pub fn replace_managed_terminal_cli_shim(path: &Path, content: &str) -> Result<(), String> {
    if path.exists() && !managed_file(path)? {
        return Err(format!(
            "Refusing to replace user-owned CLI file: {}",
            path.display()
        ));
    }
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "CLI shim path has no valid file name".to_string())?;
    let temporary = path.with_file_name(format!(
        ".{file_name}.{}.{}.tmp",
        std::process::id(),
        nanoid::nanoid!(12)
    ));
    let mut file = privileged_effect(EFFECT_SHIM_FILE_CREATE, || {
        OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(|error| format!("CLI shim create: {error}"))
    })?;
    privileged_effect(EFFECT_SHIM_FILE_WRITE, || {
        file.write_all(content.as_bytes())
            .map_err(|error| format!("CLI shim write: {error}"))
    })?;
    privileged_effect(EFFECT_SHIM_FILE_FLUSH, || {
        file.sync_all()
            .map_err(|error| format!("CLI shim flush: {error}"))
    })?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        privileged_effect(EFFECT_SHIM_FILE_PERMISSIONS_WRITE, || {
            fs::set_permissions(&temporary, fs::Permissions::from_mode(0o755))
                .map_err(|error| format!("CLI shim permissions: {error}"))
        })?;
    }
    if let Err(error) = atomic_replace_file(&temporary, path) {
        let _ = privileged_effect(EFFECT_SHIM_REPLACE_CLEANUP_REMOVE, || {
            fs::remove_file(&temporary).map_err(|error| error.to_string())
        });
        return Err(format!("CLI shim replace: {error}"));
    }
    Ok(())
}

pub fn replace_managed_terminal_cli_aliases(
    paths: &[PathBuf],
    content: &str,
) -> Result<(), String> {
    let mut originals = Vec::with_capacity(paths.len());
    for path in paths {
        if path.exists() && !managed_file(path)? {
            return Err(format!(
                "Refusing to replace user-owned CLI file: {}",
                path.display()
            ));
        }
        originals.push(if path.exists() {
            Some(
                fs::read_to_string(path)
                    .map_err(|error| format!("CLI shim backup read failed: {error}"))?,
            )
        } else {
            None
        });
    }

    for (index, path) in paths.iter().enumerate() {
        if let Err(install_error) = replace_managed_terminal_cli_shim(path, content) {
            let mut rollback_errors = Vec::new();
            for rollback_index in (0..index).rev() {
                let rollback_path = &paths[rollback_index];
                let rollback = match &originals[rollback_index] {
                    Some(previous) => replace_managed_terminal_cli_shim(rollback_path, previous),
                    None => privileged_effect(EFFECT_ALIAS_ROLLBACK_FILE_REMOVE, || {
                        match fs::remove_file(rollback_path) {
                            Ok(()) => Ok(()),
                            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
                            Err(error) => Err(format!("CLI shim rollback removal failed: {error}")),
                        }
                    }),
                };
                if let Err(error) = rollback {
                    rollback_errors.push(format!("{}: {error}", rollback_path.display()));
                }
            }
            if rollback_errors.is_empty() {
                return Err(install_error);
            }
            return Err(format!(
                "{install_error}; rollback also failed for {}",
                rollback_errors.join(", ")
            ));
        }
    }
    Ok(())
}

pub fn remove_managed_terminal_cli_aliases(paths: &[PathBuf]) -> Result<(), String> {
    for path in paths {
        if path.exists() && !managed_file(path)? {
            return Err(format!(
                "Refusing to remove user-owned CLI file: {}",
                path.display()
            ));
        }
    }

    let mut moved: Vec<(PathBuf, PathBuf)> = Vec::with_capacity(paths.len());
    for path in paths {
        if !path.exists() {
            continue;
        }
        let file_name = path
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or_else(|| "CLI shim path has no valid file name".to_string())?;
        let temporary = path.with_file_name(format!(
            ".{file_name}.{}.{}.removing",
            std::process::id(),
            nanoid::nanoid!(12)
        ));
        if let Err(remove_error) = privileged_effect(EFFECT_ALIAS_STAGE_FILE_RENAME, || {
            fs::rename(path, &temporary).map_err(|error| error.to_string())
        }) {
            let mut rollback_errors = Vec::new();
            for (original, moved_path) in moved.iter().rev() {
                if let Err(error) = privileged_effect(EFFECT_ALIAS_ROLLBACK_FILE_RENAME, || {
                    fs::rename(moved_path, original).map_err(|error| error.to_string())
                }) {
                    rollback_errors.push(format!("{}: {error}", original.display()));
                }
            }
            if rollback_errors.is_empty() {
                return Err(format!("CLI shim removal failed: {remove_error}"));
            }
            return Err(format!(
                "CLI shim removal failed: {remove_error}; rollback also failed for {}",
                rollback_errors.join(", ")
            ));
        }
        moved.push((path.clone(), temporary));
    }

    for (_, temporary) in moved {
        if let Err(error) = privileged_effect(EFFECT_ALIAS_CLEANUP_FILE_REMOVE, || {
            fs::remove_file(&temporary).map_err(|error| error.to_string())
        }) {
            eprintln!(
                "[terminal-cli] removed alias but could not clean up {}: {error}",
                temporary.display()
            );
        }
    }
    Ok(())
}

fn cli_install_status(state: &TerminalCliState) -> Result<TerminalCliInstallStatus, String> {
    let endpoint = state
        .endpoint_path
        .lock()
        .map_err(|_| "terminal CLI endpoint state unavailable".to_string())?
        .clone()
        .ok_or_else(|| "terminal CLI endpoint is not ready".to_string())?;
    let executable =
        std::env::current_exe().map_err(|error| format!("current executable: {error}"))?;
    let expected = expected_shim(&executable, &endpoint)?;
    let (bin_dir, names) = terminal_cli_paths()?;
    let installed = names.iter().all(|name| {
        fs::read_to_string(bin_dir.join(name)).is_ok_and(|content| content == expected)
    });
    Ok(TerminalCliInstallStatus {
        installed,
        bin_dir: bin_dir.to_string_lossy().into_owned(),
        command_names: ["vibespace", "vs", "vibespace-context"],
    })
}

#[tauri::command]
pub fn terminal_cli_install_status(
    state: tauri::State<'_, TerminalCliState>,
) -> Result<TerminalCliInstallStatus, String> {
    cli_install_status(&state)
}

#[tauri::command]
pub fn terminal_cli_install(
    state: tauri::State<'_, TerminalCliState>,
) -> Result<TerminalCliInstallStatus, String> {
    let endpoint = state
        .endpoint_path
        .lock()
        .map_err(|_| "terminal CLI endpoint state unavailable".to_string())?
        .clone()
        .ok_or_else(|| "terminal CLI endpoint is not ready".to_string())?;
    let executable =
        std::env::current_exe().map_err(|error| format!("current executable: {error}"))?;
    let content = expected_shim(&executable, &endpoint)?;
    let (bin_dir, names) = terminal_cli_paths()?;
    create_terminal_cli_bin_directory(&bin_dir)?;
    let paths = names.map(|name| bin_dir.join(name));
    replace_managed_terminal_cli_aliases(&paths, &content)?;
    cli_install_status(&state)
}

fn create_terminal_cli_bin_directory(bin_dir: &Path) -> Result<(), String> {
    privileged_effect(EFFECT_CLI_BIN_DIRECTORY_CREATE, || {
        fs::create_dir_all(bin_dir).map_err(|error| format!("CLI bin directory: {error}"))
    })
}

#[tauri::command]
pub fn terminal_cli_uninstall(
    state: tauri::State<'_, TerminalCliState>,
) -> Result<TerminalCliInstallStatus, String> {
    let (bin_dir, names) = terminal_cli_paths()?;
    let paths = names.map(|name| bin_dir.join(name));
    remove_managed_terminal_cli_aliases(&paths)?;
    cli_install_status(&state)
}

#[tauri::command]
pub fn terminal_shell_integration_status() -> TerminalShellIntegrationStatus {
    terminal_shell_integration_status_impl()
}

#[tauri::command]
pub fn terminal_shell_integration_install() -> Result<TerminalShellIntegrationStatus, String> {
    let targets = terminal_shell_profile_targets()?;
    mutate_terminal_shell_profiles(&targets, true)?;
    Ok(terminal_shell_integration_status_impl())
}

#[tauri::command]
pub fn terminal_shell_integration_uninstall() -> Result<TerminalShellIntegrationStatus, String> {
    let targets = terminal_shell_profile_targets()?;
    mutate_terminal_shell_profiles(&targets, false)?;
    Ok(terminal_shell_integration_status_impl())
}

#[tauri::command]
pub fn terminal_cli_respond(
    state: tauri::State<'_, TerminalCliState>,
    response: TerminalCliResponse,
) -> Result<(), String> {
    validate_response(&response)?;
    let sender = state
        .pending
        .lock()
        .map_err(|_| "terminal CLI pending registry unavailable".to_string())?
        .remove(&response.request_id)
        .ok_or_else(|| "terminal CLI request is no longer pending".to_string())?;
    sender
        .send(response)
        .map_err(|_| "terminal CLI request receiver is unavailable".to_string())
}

#[cfg(test)]
mod identity_cli_tests {
    use serde_json::json;

    use super::*;

    fn identity_args() -> Vec<String> {
        [
            "--endpoint",
            "C:\\vibespace\\terminal-cli\\endpoint.json",
            "--json",
            "cao",
            "identity",
            "publish",
            "--opencode-session",
            "ses_identity_1",
            "--provider",
            "openrouter",
            "--model",
            "deepseek/deepseek-v4-flash",
            "--variant",
            "high",
            "--process-instance",
            "ptyproc_identity_1",
        ]
        .into_iter()
        .map(String::from)
        .collect()
    }

    fn scope(process_instance_id: Option<&str>) -> TerminalCliRequestScope {
        TerminalCliRequestScope {
            terminal_session_id: Some("tty_identity_1".into()),
            pane_id: Some("pane_identity_1".into()),
            project_id: Some("project_identity_1".into()),
            run_identity: None,
            process_instance_id: process_instance_id.map(String::from),
        }
    }

    fn invocation(process_instance_id: &str) -> TerminalCliInvocation {
        TerminalCliInvocation {
            endpoint: PathBuf::from("C:\\vibespace\\terminal-cli\\endpoint.json"),
            json: true,
            color: false,
            method: "cao.identity.publish".into(),
            params: json!({
                "opencodeSessionId": "ses_identity_1",
                "providerId": "openrouter",
                "modelId": "deepseek/deepseek-v4-flash",
                "variant": "high",
                "processInstanceId": process_instance_id,
            }),
        }
    }

    #[test]
    fn parses_authentic_opencode_identity_payload_with_namespaced_model() {
        let parsed = parse_terminal_cli_args(&identity_args()).expect("identity command parses");
        assert_eq!(parsed.method, "cao.identity.publish");
        assert_eq!(parsed.params["providerId"], "openrouter");
        assert_eq!(parsed.params["modelId"], "deepseek/deepseek-v4-flash");
        assert_eq!(parsed.params["variant"], "high");
        assert!(valid_method_params(&parsed.method, &parsed.params));
    }

    #[test]
    fn rejects_reordered_or_unbounded_identity_cli_arguments() {
        let mut reordered = identity_args();
        reordered.swap(8, 10);
        assert!(parse_terminal_cli_args(&reordered).is_err());

        let mut unbounded = identity_args();
        unbounded[9] = "high?forged".into();
        assert!(parse_terminal_cli_args(&unbounded).is_err());
    }

    #[test]
    fn authenticated_identity_request_requires_exact_process_and_terminal_scope() {
        let nonce = "a".repeat(SAFE_NONCE_LENGTH);
        let request = build_scoped_terminal_cli_request(
            &invocation("ptyproc_identity_1"),
            &nonce,
            "request_identity_1",
            scope(Some("ptyproc_identity_1")),
        )
        .expect("matching process scope");
        assert!(terminal_cli_request_error_code(&request, &nonce).is_none());

        assert_eq!(
            build_scoped_terminal_cli_request(
                &invocation("ptyproc_forged"),
                &nonce,
                "request_identity_2",
                scope(Some("ptyproc_identity_1")),
            )
            .expect_err("forged process must be rejected"),
            "invalid_request"
        );

        let mut missing_scope = request.clone();
        missing_scope.project_id = None;
        assert_eq!(
            terminal_cli_request_error_code(&missing_scope, &nonce),
            Some("invalid_request")
        );
    }

    #[test]
    fn identity_request_rejects_unknown_fields_and_missing_auth_nonce() {
        let nonce = "a".repeat(SAFE_NONCE_LENGTH);
        let mut request = build_scoped_terminal_cli_request(
            &invocation("ptyproc_identity_1"),
            &nonce,
            "request_identity_3",
            scope(Some("ptyproc_identity_1")),
        )
        .unwrap();
        request.params["extra"] = json!(true);
        assert_eq!(
            terminal_cli_request_error_code(&request, &nonce),
            Some("invalid_request")
        );

        let mut unauthenticated = request;
        unauthenticated.params = invocation("ptyproc_identity_1").params;
        unauthenticated.nonce = "wrong".into();
        assert_eq!(
            terminal_cli_request_error_code(&unauthenticated, &nonce),
            Some("authentication_failed")
        );
    }
    #[test]
    fn identity_publish_uses_a_bounded_response_timeout() {
        assert_eq!(
            terminal_cli_response_timeout("cao.identity.publish"),
            Duration::from_secs(1)
        );
        assert_eq!(terminal_cli_response_timeout("status"), RESPONSE_TIMEOUT);
    }
}

#[cfg(test)]
mod privileged_effect_tests {
    use super::*;

    fn unique_test_path(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "vibespace-terminal-cli-{label}-{}-{}",
            std::process::id(),
            nanoid::nanoid!(8)
        ))
    }

    #[test]
    fn named_profile_denies_shell_profile_write_before_effect_adapter() {
        install_test_effect_guard(|effect| {
            Err(format!(
                "privileged effect '{effect}' is disabled by the monochrome-visual-test runtime profile"
            ))
        });
        clear_test_effect_events();
        let path = unique_test_path("denied").join("profile.ps1");

        let message = write_terminal_shell_profile(&path, Some("prompt"))
            .expect_err("named test profile must deny before filesystem effects");

        assert!(message.contains("monochrome-visual-test"));
        assert!(!path.exists());
        assert!(
            take_test_effect_events().is_empty(),
            "denial must precede the effect adapter counter"
        );
    }

    #[test]
    fn ordinary_mode_shell_profile_write_reaches_exact_effect_adapters() {
        install_test_effect_guard(|_effect| Ok(()));
        clear_test_effect_events();
        let root = unique_test_path("ordinary");
        let path = root.join("profile.ps1");

        write_terminal_shell_profile(&path, Some("prompt"))
            .expect("ordinary mode must preserve shell profile writes");

        let mut expected = vec![
            EFFECT_SHELL_DIRECTORY_CREATE,
            EFFECT_SHELL_FILE_CREATE,
            EFFECT_SHELL_FILE_WRITE,
            EFFECT_SHELL_FILE_FLUSH,
        ];
        #[cfg(unix)]
        expected.push(EFFECT_SHELL_FILE_PERMISSIONS_WRITE);
        #[cfg(target_os = "windows")]
        expected.push(EFFECT_FILE_REPLACE_WINDOWS);
        #[cfg(not(target_os = "windows"))]
        expected.push(EFFECT_FILE_RENAME);
        assert_eq!(take_test_effect_events(), expected);
        assert_eq!(fs::read_to_string(&path).unwrap(), "prompt");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn ordinary_mode_endpoint_write_reaches_exact_effect_adapters() {
        install_test_effect_guard(|_effect| Ok(()));
        clear_test_effect_events();
        let root = unique_test_path("endpoint");
        let path = root.join("endpoint.json");
        let endpoint = TerminalCliEndpoint {
            protocol_version: PROTOCOL_VERSION,
            address: "127.0.0.1:45678".into(),
            keyring_service: KEYRING_SERVICE.into(),
            keyring_account: KEYRING_ACCOUNT.into(),
        };

        write_endpoint(&path, &endpoint).expect("ordinary mode must preserve endpoint writes");

        let mut expected = vec![
            EFFECT_ENDPOINT_DIRECTORY_CREATE,
            EFFECT_ENDPOINT_FILE_CREATE,
            EFFECT_ENDPOINT_FILE_WRITE,
            EFFECT_ENDPOINT_FILE_FLUSH,
        ];
        #[cfg(unix)]
        expected.push(EFFECT_ENDPOINT_FILE_PERMISSIONS_WRITE);
        #[cfg(target_os = "windows")]
        expected.push(EFFECT_FILE_REPLACE_WINDOWS);
        #[cfg(not(target_os = "windows"))]
        expected.push(EFFECT_FILE_RENAME);
        assert_eq!(take_test_effect_events(), expected);
        assert!(path.is_file());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn ordinary_mode_shim_install_and_remove_reach_exact_effect_adapters() {
        install_test_effect_guard(|_effect| Ok(()));
        clear_test_effect_events();
        let root = unique_test_path("shim");
        fs::create_dir_all(&root).unwrap();
        let path = root.join(if cfg!(target_os = "windows") {
            "vibespace.cmd"
        } else {
            "vibespace"
        });
        let content = format!("# {MANAGED_MARKER}\nmanaged shim\n");

        replace_managed_terminal_cli_shim(&path, &content)
            .expect("ordinary mode must preserve shim install");

        let mut expected = vec![
            EFFECT_SHIM_FILE_CREATE,
            EFFECT_SHIM_FILE_WRITE,
            EFFECT_SHIM_FILE_FLUSH,
        ];
        #[cfg(unix)]
        expected.push(EFFECT_SHIM_FILE_PERMISSIONS_WRITE);
        #[cfg(target_os = "windows")]
        expected.push(EFFECT_FILE_REPLACE_WINDOWS);
        #[cfg(not(target_os = "windows"))]
        expected.push(EFFECT_FILE_RENAME);
        assert_eq!(take_test_effect_events(), expected);

        clear_test_effect_events();
        remove_managed_terminal_cli_aliases(std::slice::from_ref(&path))
            .expect("ordinary mode must preserve managed shim removal");
        assert_eq!(
            take_test_effect_events(),
            vec![
                EFFECT_ALIAS_STAGE_FILE_RENAME,
                EFFECT_ALIAS_CLEANUP_FILE_REMOVE,
            ]
        );
        assert!(!path.exists());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn shell_profile_remove_reaches_1093_adapter() {
        install_test_effect_guard(|_| Ok(()));
        clear_test_effect_events();
        let root = unique_test_path("shell-remove");
        fs::create_dir_all(&root).unwrap();
        let path = root.join("profile.ps1");
        fs::write(&path, "existing").unwrap();

        write_terminal_shell_profile(&path, None).unwrap();

        assert_eq!(take_test_effect_events(), vec![EFFECT_SHELL_FILE_REMOVE]);
        assert!(!path.exists());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn shell_write_failure_reaches_1122_cleanup_adapter() {
        install_test_effect_guard(|_| Ok(()));
        clear_test_effect_events();
        fail_test_effect_adapter(EFFECT_SHELL_FILE_WRITE, 1);
        let root = unique_test_path("shell-write-cleanup");
        let path = root.join("profile.ps1");

        assert!(write_terminal_shell_profile(&path, Some("content")).is_err());

        let events = take_test_effect_events();
        assert!(events.contains(&EFFECT_SHELL_WRITE_CLEANUP_REMOVE));
        assert!(!path.exists());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn shell_flush_failure_reaches_1127_cleanup_adapter() {
        install_test_effect_guard(|_| Ok(()));
        clear_test_effect_events();
        fail_test_effect_adapter(EFFECT_SHELL_FILE_FLUSH, 1);
        let root = unique_test_path("shell-flush-cleanup");
        let path = root.join("profile.ps1");

        assert!(write_terminal_shell_profile(&path, Some("content")).is_err());

        let events = take_test_effect_events();
        assert!(events.contains(&EFFECT_SHELL_FLUSH_CLEANUP_REMOVE));
        assert!(!path.exists());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn shell_permissions_failure_reaches_1133_cleanup_adapter() {
        install_test_effect_guard(|_| Ok(()));
        clear_test_effect_events();
        fail_test_effect_adapter(EFFECT_SHELL_FILE_PERMISSIONS_WRITE, 1);
        let root = unique_test_path("shell-permissions-cleanup");
        fs::create_dir_all(&root).unwrap();
        let path = root.join("profile");
        fs::write(&path, "old").unwrap();

        assert!(write_terminal_shell_profile(&path, Some("new")).is_err());

        assert!(take_test_effect_events().contains(&EFFECT_SHELL_PERMISSIONS_CLEANUP_REMOVE));
        assert_eq!(fs::read_to_string(&path).unwrap(), "old");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn shell_replace_failure_reaches_1138_cleanup_adapter() {
        install_test_effect_guard(|_| Ok(()));
        clear_test_effect_events();
        #[cfg(target_os = "windows")]
        fail_test_effect_adapter(EFFECT_FILE_REPLACE_WINDOWS, 1);
        #[cfg(not(target_os = "windows"))]
        fail_test_effect_adapter(EFFECT_FILE_RENAME, 1);
        let root = unique_test_path("shell-replace-cleanup");
        let path = root.join("profile");

        assert!(write_terminal_shell_profile(&path, Some("content")).is_err());

        assert!(take_test_effect_events().contains(&EFFECT_SHELL_REPLACE_CLEANUP_REMOVE));
        assert!(!path.exists());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn keyring_entry_reaches_1165_adapter_without_os_access() {
        install_test_effect_guard(|_| Ok(()));
        clear_test_effect_events();
        fail_test_effect_adapter(EFFECT_KEYRING_ENTRY, 1);

        assert!(keyring_entry().is_err());
        assert_eq!(take_test_effect_events(), vec![EFFECT_KEYRING_ENTRY]);
    }

    #[test]
    fn endpoint_replace_failure_reaches_1210_cleanup_adapter() {
        install_test_effect_guard(|_| Ok(()));
        clear_test_effect_events();
        #[cfg(target_os = "windows")]
        fail_test_effect_adapter(EFFECT_FILE_REPLACE_WINDOWS, 1);
        #[cfg(not(target_os = "windows"))]
        fail_test_effect_adapter(EFFECT_FILE_RENAME, 1);
        let root = unique_test_path("endpoint-replace-cleanup");
        let path = root.join("endpoint.json");
        let endpoint = TerminalCliEndpoint {
            protocol_version: PROTOCOL_VERSION,
            address: "127.0.0.1:45678".into(),
            keyring_service: KEYRING_SERVICE.into(),
            keyring_account: KEYRING_ACCOUNT.into(),
        };

        assert!(write_endpoint(&path, &endpoint).is_err());

        assert!(take_test_effect_events().contains(&EFFECT_ENDPOINT_REPLACE_CLEANUP_REMOVE));
        assert!(!path.exists());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn keyring_set_reaches_1405_adapter_without_writing_credentials() {
        install_test_effect_guard(|_| Ok(()));
        clear_test_effect_events();
        fail_test_effect_adapter(EFFECT_KEYRING_SET, 1);

        assert!(keyring_set("test-nonce").is_err());
        assert_eq!(
            take_test_effect_events(),
            vec![EFFECT_KEYRING_ENTRY, EFFECT_KEYRING_SET]
        );
    }

    #[test]
    fn keyring_read_reaches_1524_adapter_without_reading_credentials() {
        install_test_effect_guard(|_| Ok(()));
        clear_test_effect_events();
        fail_test_effect_adapter(EFFECT_KEYRING_READ, 1);

        assert!(keyring_read().is_err());
        assert_eq!(
            take_test_effect_events(),
            vec![EFFECT_KEYRING_ENTRY, EFFECT_KEYRING_READ]
        );
    }

    #[test]
    fn shim_replace_failure_reaches_1891_cleanup_adapter() {
        install_test_effect_guard(|_| Ok(()));
        clear_test_effect_events();
        #[cfg(target_os = "windows")]
        fail_test_effect_adapter(EFFECT_FILE_REPLACE_WINDOWS, 1);
        #[cfg(not(target_os = "windows"))]
        fail_test_effect_adapter(EFFECT_FILE_RENAME, 1);
        let root = unique_test_path("shim-replace-cleanup");
        fs::create_dir_all(&root).unwrap();
        let path = root.join("vibespace");

        assert!(replace_managed_terminal_cli_shim(&path, MANAGED_MARKER).is_err());

        assert!(take_test_effect_events().contains(&EFFECT_SHIM_REPLACE_CLEANUP_REMOVE));
        assert!(!path.exists());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn alias_install_failure_reaches_1926_rollback_remove_adapter() {
        install_test_effect_guard(|_| Ok(()));
        clear_test_effect_events();
        fail_test_effect_adapter(EFFECT_SHIM_FILE_CREATE, 2);
        let root = unique_test_path("alias-rollback-remove");
        fs::create_dir_all(&root).unwrap();
        let paths = [root.join("vibespace"), root.join("vs")];

        assert!(replace_managed_terminal_cli_aliases(&paths, MANAGED_MARKER).is_err());

        assert!(take_test_effect_events().contains(&EFFECT_ALIAS_ROLLBACK_FILE_REMOVE));
        assert!(paths.iter().all(|path| !path.exists()));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn alias_stage_failure_reaches_1975_rollback_rename_adapter() {
        install_test_effect_guard(|_| Ok(()));
        clear_test_effect_events();
        fail_test_effect_adapter(EFFECT_ALIAS_STAGE_FILE_RENAME, 2);
        let root = unique_test_path("alias-rollback-rename");
        fs::create_dir_all(&root).unwrap();
        let paths = [root.join("vibespace"), root.join("vs")];
        for path in &paths {
            fs::write(path, format!("# {MANAGED_MARKER}\n")).unwrap();
        }

        assert!(remove_managed_terminal_cli_aliases(&paths).is_err());

        assert!(take_test_effect_events().contains(&EFFECT_ALIAS_ROLLBACK_FILE_RENAME));
        assert!(paths.iter().all(|path| path.exists()));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn cli_bin_creation_reaches_2043_directory_adapter() {
        install_test_effect_guard(|_| Ok(()));
        clear_test_effect_events();
        let root = unique_test_path("cli-bin-create");
        let bin = root.join("bin");

        create_terminal_cli_bin_directory(&bin).unwrap();

        assert_eq!(
            take_test_effect_events(),
            vec![EFFECT_CLI_BIN_DIRECTORY_CREATE]
        );
        assert!(bin.is_dir());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn real_visual_and_unknown_profiles_deny_before_terminal_adapter() {
        clear_test_effect_guard();
        clear_test_effect_events();
        for profile in [
            crate::runtime_profile::MONOCHROME_VISUAL_TEST,
            "unknown-profile",
        ] {
            let _environment = crate::runtime_profile::test_runtime_environment(
                Some(std::ffi::OsString::from(profile)),
                None,
            );
            let path = unique_test_path("real-profile-denial").join("profile");
            assert!(write_terminal_shell_profile(&path, Some("content")).is_err());
            assert!(take_test_effect_events().is_empty());
            assert!(!path.exists());
        }
    }

    #[test]
    fn real_ordinary_profile_reaches_terminal_adapter() {
        clear_test_effect_guard();
        clear_test_effect_events();
        let _environment = crate::runtime_profile::test_runtime_environment(None, None);
        let root = unique_test_path("real-ordinary");
        let bin = root.join("bin");

        create_terminal_cli_bin_directory(&bin).unwrap();

        assert_eq!(
            take_test_effect_events(),
            vec![EFFECT_CLI_BIN_DIRECTORY_CREATE]
        );
        assert!(bin.is_dir());
        let _ = fs::remove_dir_all(root);
    }
}
