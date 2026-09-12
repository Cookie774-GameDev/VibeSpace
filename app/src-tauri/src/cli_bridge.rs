use crate::harness::tool_gateway::{create_codex_context_lease, ToolGatewayState};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::Emitter;

const MIN_TIMEOUT_MS: u64 = 100;
const MAX_TIMEOUT_MS: u64 = 86_400_000; // App-lifetime persistent OpenCode server (24h); still cancellable.
const MIN_OUTPUT_LIMIT_BYTES: usize = 1_024;
const MAX_OUTPUT_LIMIT_BYTES: usize = 1_048_576;
const PROVIDER_EXECUTABLE_NAMES: [&str; 11] = [
    "codex",
    "claude",
    "gemini",
    "copilot",
    "qwen",
    "opencode",
    "cursor-agent",
    "cline",
    "aider",
    "goose",
    "openai",
];
const KERNEL_SMOKE_EXECUTABLE_NAME: &str = "vibespace_kernel_smoke_cli";
const CODEX_CONTEXT_TOKEN_ENV: &str = "VIBESPACE_CODEX_CONTEXT_TOKEN";
static NEXT_EXECUTABLE_ID: AtomicU64 = AtomicU64::new(1);

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CliStartRequest {
    pub request_id: String,
    pub executable_id: String,
    pub args: Vec<String>,
    pub cwd: Option<String>,
    pub stdin: Option<String>,
    pub timeout_ms: u64,
    pub output_limit_bytes: usize,
    pub tool_scope: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CliScanRequest {
    pub executable_names: Vec<String>,
    pub custom_path: Option<String>,
    pub custom_path_confirmed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CliProbeRequest {
    pub executable_id: String,
    pub args: Vec<String>,
    pub timeout_ms: u64,
    pub output_limit_bytes: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexAccountSnapshotRequest {
    pub executable_id: String,
    pub timeout_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexAccountSnapshot {
    pub rate_limits: serde_json::Value,
    pub token_usage: serde_json::Value,
    pub updated_at: u64,
    pub source: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectedExecutable {
    pub executable_id: String,
    pub requested_name: Option<String>,
    pub executable_path: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CliDetectionResult {
    pub executables: Vec<DetectedExecutable>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CliProbeResult {
    pub exit_code: Option<i32>,
    pub stdout: SanitizedOutput,
    pub stderr: SanitizedOutput,
    pub timed_out: bool,
}

type CancellationFlag = Arc<AtomicBool>;
type ActiveRequests = Arc<Mutex<HashMap<String, CancellationFlag>>>;

#[derive(Debug, Clone, PartialEq, Eq)]
struct ExecutableFingerprint {
    length: u64,
    modified_nanos: Option<u128>,
    created_nanos: Option<u128>,
}

#[derive(Debug, Clone)]
struct TrustedExecutable {
    canonical_path: PathBuf,
    fingerprint: ExecutableFingerprint,
    requested_name: Option<String>,
}

pub struct CliBridgeState {
    active_requests: ActiveRequests,
    trusted_executables: Mutex<HashMap<String, TrustedExecutable>>,
}

impl Default for CliBridgeState {
    fn default() -> Self {
        Self {
            active_requests: Arc::new(Mutex::new(HashMap::new())),
            trusted_executables: Mutex::new(HashMap::new()),
        }
    }
}

impl Drop for CliBridgeState {
    fn drop(&mut self) {
        if let Ok(active) = self.active_requests.lock() {
            for cancellation in active.values() {
                cancellation.store(true, Ordering::Release);
            }
        }
    }
}

struct ActiveRequestGuard {
    request_id: String,
    active_requests: ActiveRequests,
}

impl Drop for ActiveRequestGuard {
    fn drop(&mut self) {
        if let Ok(mut active) = self.active_requests.lock() {
            active.remove(&self.request_id);
        }
    }
}

impl CliBridgeState {
    fn register_trusted_executable(
        &self,
        canonical_path: PathBuf,
        requested_name: Option<String>,
    ) -> Result<DetectedExecutable, String> {
        let canonical_path = canonical_executable_path(
            canonical_path
                .to_str()
                .ok_or_else(|| "executable path is not valid UTF-8".to_string())?,
        )?;
        let fingerprint = executable_fingerprint(&canonical_path)?;
        let mut trusted = self
            .trusted_executables
            .lock()
            .map_err(|_| "trusted executable registry lock was poisoned".to_string())?;

        if let Some((executable_id, _)) = trusted.iter().find(|(_, entry)| {
            entry.canonical_path == canonical_path && entry.fingerprint == fingerprint
        }) {
            return Ok(DetectedExecutable {
                executable_id: executable_id.clone(),
                requested_name,
                executable_path: canonical_path.to_string_lossy().into_owned(),
            });
        }

        let executable_id = format!(
            "cli-executable-{:016x}",
            NEXT_EXECUTABLE_ID.fetch_add(1, Ordering::Relaxed)
        );
        trusted.insert(
            executable_id.clone(),
            TrustedExecutable {
                canonical_path: canonical_path.clone(),
                fingerprint,
                requested_name: requested_name.clone(),
            },
        );
        Ok(DetectedExecutable {
            executable_id,
            requested_name,
            executable_path: canonical_path.to_string_lossy().into_owned(),
        })
    }

    fn resolve_trusted_executable(&self, executable_id: &str) -> Result<PathBuf, String> {
        Ok(self
            .resolve_trusted_executable_entry(executable_id)?
            .canonical_path)
    }

    fn resolve_trusted_executable_entry(
        &self,
        executable_id: &str,
    ) -> Result<TrustedExecutable, String> {
        let trusted = self
            .trusted_executables
            .lock()
            .map_err(|_| "trusted executable registry lock was poisoned".to_string())?
            .get(executable_id)
            .cloned()
            .ok_or_else(|| "executableId is not registered".to_string())?;
        let canonical = canonical_executable_path(
            trusted
                .canonical_path
                .to_str()
                .ok_or_else(|| "trusted executable path is not valid UTF-8".to_string())?,
        )?;
        if canonical != trusted.canonical_path
            || executable_fingerprint(&canonical)? != trusted.fingerprint
        {
            return Err("trusted executable was replaced after discovery".to_string());
        }
        Ok(TrustedExecutable {
            canonical_path: canonical,
            fingerprint: trusted.fingerprint,
            requested_name: trusted.requested_name,
        })
    }

    fn register(&self, request_id: &str) -> Result<(CancellationFlag, ActiveRequestGuard), String> {
        let mut active = self
            .active_requests
            .lock()
            .map_err(|_| "CLI bridge state lock was poisoned".to_string())?;
        if active.contains_key(request_id) {
            return Err("requestId is already active".to_string());
        }

        let cancellation = Arc::new(AtomicBool::new(false));
        active.insert(request_id.to_string(), Arc::clone(&cancellation));
        Ok((
            cancellation,
            ActiveRequestGuard {
                request_id: request_id.to_string(),
                active_requests: Arc::clone(&self.active_requests),
            },
        ))
    }

    fn request_cancel(&self, request_id: &str) -> Result<bool, String> {
        let active = self
            .active_requests
            .lock()
            .map_err(|_| "CLI bridge state lock was poisoned".to_string())?;
        let Some(cancellation) = active.get(request_id) else {
            return Ok(false);
        };
        cancellation.store(true, Ordering::Release);
        Ok(true)
    }

    #[cfg(test)]
    fn contains(&self, request_id: &str) -> bool {
        self.active_requests
            .lock()
            .map(|active| active.contains_key(request_id))
            .unwrap_or(false)
    }
}

fn system_time_nanos(value: std::io::Result<SystemTime>) -> Option<u128> {
    value
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_nanos())
}

fn executable_fingerprint(path: &Path) -> Result<ExecutableFingerprint, String> {
    let metadata = fs::metadata(path)
        .map_err(|error| format!("executable metadata could not be read: {error}"))?;
    if !metadata.is_file() {
        return Err("executable path must reference a regular file".to_string());
    }
    Ok(ExecutableFingerprint {
        length: metadata.len(),
        modified_nanos: system_time_nanos(metadata.modified()),
        created_nanos: system_time_nanos(metadata.created()),
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CliEventStream {
    Stdout,
    Stderr,
    Status,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CliEventStatus {
    Started,
    Data,
    Completed,
    Failed,
    Cancelled,
    TimedOut,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CliBridgeEvent {
    pub request_id: String,
    pub stream: CliEventStream,
    pub data: String,
    pub exit_code: Option<i32>,
    pub status: CliEventStatus,
    pub truncated: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SanitizedOutput {
    pub data: String,
    pub truncated: bool,
}

#[derive(Debug, PartialEq, Eq)]
struct PreparedStartRequest {
    executable_path: PathBuf,
    args: Vec<String>,
    cwd: Option<PathBuf>,
    stdin: Option<Vec<u8>>,
    timeout_ms: u64,
    output_limit_bytes: usize,
    tool_scope: bool,
    secret_environment: Option<SecretEnvironment>,
}

#[derive(PartialEq, Eq)]
struct SecretEnvironment {
    name: &'static str,
    value: String,
}

impl std::fmt::Debug for SecretEnvironment {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("SecretEnvironment")
            .field("name", &self.name)
            .field("value", &"[redacted]")
            .finish()
    }
}

#[derive(Debug, PartialEq, Eq)]
struct PreparedProbeRequest {
    executable_path: PathBuf,
    args: Vec<String>,
    timeout_ms: u64,
    output_limit_bytes: usize,
}

fn expected_kernel_smoke_executable() -> PathBuf {
    let executable = if cfg!(windows) {
        format!("{KERNEL_SMOKE_EXECUTABLE_NAME}.exe")
    } else {
        KERNEL_SMOKE_EXECUTABLE_NAME.to_string()
    };
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("target")
        .join("debug")
        .join("examples")
        .join(executable)
}

fn kernel_smoke_cli_enabled() -> bool {
    cfg!(debug_assertions)
        && std::env::var("VIBESPACE_SIK_SMOKE")
            .map(|value| value == "1")
            .unwrap_or(false)
}

fn kernel_smoke_cli_gate(
    debug_build: bool,
    explicit_flag: Option<&str>,
    canonical: &Path,
    expected: &Path,
) -> bool {
    debug_build && explicit_flag == Some("1") && canonical == expected
}

fn validate_kernel_smoke_executable(canonical: &Path) -> Result<(), String> {
    if !kernel_smoke_cli_enabled() {
        return Err("kernel smoke CLI is disabled".to_string());
    }
    let expected = fs::canonicalize(expected_kernel_smoke_executable())
        .map_err(|_| "kernel smoke CLI fixture is not built".to_string())?;
    if !kernel_smoke_cli_gate(
        cfg!(debug_assertions),
        std::env::var("VIBESPACE_SIK_SMOKE").ok().as_deref(),
        canonical,
        &expected,
    ) {
        return Err("kernel smoke CLI path does not match the canonical fixture".to_string());
    }
    Ok(())
}

fn validate_executable_name(name: &str) -> Result<(), String> {
    if name.is_empty()
        || !name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
    {
        return Err("executable name contains unsafe characters".to_string());
    }
    if name == KERNEL_SMOKE_EXECUTABLE_NAME {
        if !kernel_smoke_cli_enabled() {
            return Err("kernel smoke CLI is disabled".to_string());
        }
    } else if !PROVIDER_EXECUTABLE_NAMES.contains(&name) {
        return Err("executable name is not an allowlisted provider CLI".to_string());
    }
    Ok(())
}

fn validate_executable_path(path: &str, confirmed: bool) -> Result<PathBuf, String> {
    if !confirmed {
        return Err("custom executable path was not user-confirmed".to_string());
    }

    canonical_executable_path(path)
}

fn canonical_executable_path(path: &str) -> Result<PathBuf, String> {
    let requested = Path::new(path);
    if !requested.is_absolute() {
        return Err("executable path must be absolute".to_string());
    }

    let canonical = fs::canonicalize(requested)
        .map_err(|error| format!("executable path could not be canonicalized: {error}"))?;
    let metadata = fs::metadata(&canonical)
        .map_err(|error| format!("executable metadata could not be read: {error}"))?;
    if !metadata.is_file() {
        return Err("executable path must reference a regular file".to_string());
    }

    let extension = canonical
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default();
    if ["cmd", "bat", "ps1"]
        .iter()
        .any(|blocked| extension.eq_ignore_ascii_case(blocked))
    {
        return Err("Windows script shims require a separately verified launcher".to_string());
    }

    Ok(canonical)
}

fn validate_runtime_limits(timeout_ms: u64, output_limit_bytes: usize) -> Result<(), String> {
    if !(MIN_TIMEOUT_MS..=MAX_TIMEOUT_MS).contains(&timeout_ms) {
        return Err(format!(
            "timeoutMs must be between {MIN_TIMEOUT_MS} and {MAX_TIMEOUT_MS}"
        ));
    }
    if !(MIN_OUTPUT_LIMIT_BYTES..=MAX_OUTPUT_LIMIT_BYTES).contains(&output_limit_bytes) {
        return Err(format!(
            "outputLimitBytes must be between {MIN_OUTPUT_LIMIT_BYTES} and {MAX_OUTPUT_LIMIT_BYTES}"
        ));
    }
    Ok(())
}

fn validate_timeout(timeout_ms: u64) -> Result<(), String> {
    if !(MIN_TIMEOUT_MS..=MAX_TIMEOUT_MS).contains(&timeout_ms) {
        return Err(format!(
            "timeout must be between {MIN_TIMEOUT_MS} and {MAX_TIMEOUT_MS} milliseconds"
        ));
    }
    Ok(())
}

fn validate_request_id(request_id: &str) -> Result<(), String> {
    if request_id.is_empty()
        || request_id.len() > 128
        || !request_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err(
            "requestId must be 1-128 ASCII alphanumeric, '-' or '_' characters".to_string(),
        );
    }
    Ok(())
}

fn canonical_directory(path: &str) -> Result<PathBuf, String> {
    let requested = Path::new(path);
    if !requested.is_absolute() {
        return Err("cwd must be absolute".to_string());
    }
    let canonical = fs::canonicalize(requested)
        .map_err(|error| format!("cwd could not be canonicalized: {error}"))?;
    if !canonical.is_dir() {
        return Err("cwd must reference an existing directory".to_string());
    }
    Ok(canonical)
}

fn prepare_start_request(
    state: &CliBridgeState,
    request: CliStartRequest,
) -> Result<PreparedStartRequest, String> {
    validate_request_id(&request.request_id)?;
    validate_runtime_limits(request.timeout_ms, request.output_limit_bytes)?;
    let trusted = state.resolve_trusted_executable_entry(&request.executable_id)?;
    let tool_scope = match request.tool_scope.as_deref() {
        None => false,
        Some("vibespace_context") if trusted.requested_name.as_deref() == Some("codex") => true,
        Some("vibespace_context") => {
            return Err("Context Map tools require the discovered Codex executable".into())
        }
        Some(_) => return Err("CLI tool scope is unsupported".into()),
    };
    let cwd = request
        .cwd
        .as_deref()
        .map(canonical_directory)
        .transpose()?;

    Ok(PreparedStartRequest {
        executable_path: trusted.canonical_path,
        args: request.args,
        cwd,
        stdin: request.stdin.map(String::into_bytes),
        timeout_ms: request.timeout_ms,
        output_limit_bytes: request.output_limit_bytes,
        tool_scope,
        secret_environment: None,
    })
}

fn configure_codex_context_invocation(
    prepared: &mut PreparedStartRequest,
    endpoint_url: &str,
    token: &str,
) -> Result<(), String> {
    if !prepared.tool_scope {
        return Err("Codex Context Map scope was not requested".into());
    }
    if prepared.stdin.is_none() || !valid_codex_context_base_args(&prepared.args) {
        return Err("Codex Context Map invocation is not safely isolatable".into());
    }
    if !endpoint_url.starts_with("http://127.0.0.1:")
        || endpoint_url.contains('"')
        || token.len() < 32
    {
        return Err("Codex Context Map lease is invalid".into());
    }
    prepared.args.splice(
        1..1,
        [
            "--ignore-user-config".to_string(),
            "--ephemeral".to_string(),
        ],
    );
    prepared.args.extend([
        "--sandbox".into(),
        "read-only".into(),
        "-c".into(),
        "approval_policy=\"never\"".into(),
        "-c".into(),
        format!("mcp_servers.vibespace_context.url=\"{endpoint_url}\""),
        "-c".into(),
        format!("mcp_servers.vibespace_context.bearer_token_env_var=\"{CODEX_CONTEXT_TOKEN_ENV}\""),
        "-c".into(),
        "mcp_servers.vibespace_context.enabled_tools=[\"vibespace_context\"]".into(),
        "-c".into(),
        "mcp_servers.vibespace_context.required=true".into(),
        "-".into(),
    ]);
    prepared.secret_environment = Some(SecretEnvironment {
        name: CODEX_CONTEXT_TOKEN_ENV,
        value: token.to_string(),
    });
    Ok(())
}

fn valid_codex_context_base_args(args: &[String]) -> bool {
    if args.get(0).map(String::as_str) != Some("exec")
        || args.get(1).map(String::as_str) != Some("--json")
    {
        return false;
    }
    let mut index = 2;
    if args.get(index).map(String::as_str) == Some("--cd") {
        let Some(directory) = args.get(index + 1) else {
            return false;
        };
        if directory.is_empty() {
            return false;
        }
        index += 2;
    }
    if args.get(index).map(String::as_str) != Some("--model")
        || !matches!(
            args.get(index + 1).map(String::as_str),
            Some("gpt-5.6-sol" | "gpt-5.6-terra" | "gpt-5.6-luna")
        )
    {
        return false;
    }
    index += 2;
    if args.get(index).map(String::as_str) == Some("-c") {
        if !matches!(
            args.get(index + 1).map(String::as_str),
            Some(
                "model_reasoning_effort=\"low\""
                    | "model_reasoning_effort=\"medium\""
                    | "model_reasoning_effort=\"high\""
                    | "model_reasoning_effort=\"xhigh\""
            )
        ) {
            return false;
        }
        index += 2;
    }
    index == args.len()
}

fn prepare_probe_request(
    state: &CliBridgeState,
    request: CliProbeRequest,
) -> Result<PreparedProbeRequest, String> {
    validate_runtime_limits(request.timeout_ms, request.output_limit_bytes)?;
    Ok(PreparedProbeRequest {
        executable_path: state.resolve_trusted_executable(&request.executable_id)?,
        args: request.args,
        timeout_ms: request.timeout_ms,
        output_limit_bytes: request.output_limit_bytes,
    })
}

fn strip_ansi(input: &[u8]) -> Vec<u8> {
    let mut output = Vec::with_capacity(input.len());
    let mut index = 0;
    while index < input.len() {
        let byte = input[index];
        if byte == 0x1b && index + 1 < input.len() {
            match input[index + 1] {
                b'[' => {
                    index += 2;
                    while index < input.len() {
                        let current = input[index];
                        index += 1;
                        if (0x40..=0x7e).contains(&current) {
                            break;
                        }
                    }
                    continue;
                }
                b']' => {
                    index += 2;
                    while index < input.len() {
                        if input[index] == 0x07 {
                            index += 1;
                            break;
                        }
                        if input[index] == 0x1b
                            && index + 1 < input.len()
                            && input[index + 1] == b'\\'
                        {
                            index += 2;
                            break;
                        }
                        index += 1;
                    }
                    continue;
                }
                _ => {
                    index += 2;
                    continue;
                }
            }
        }
        if byte == 0x9b {
            index += 1;
            while index < input.len() {
                let current = input[index];
                index += 1;
                if (0x40..=0x7e).contains(&current) {
                    break;
                }
            }
            continue;
        }
        if byte == 0x9d {
            index += 1;
            while index < input.len() && input[index] != 0x07 {
                index += 1;
            }
            index = (index + 1).min(input.len());
            continue;
        }
        output.push(byte);
        index += 1;
    }
    output
}

fn is_key_boundary(byte: Option<u8>) -> bool {
    byte.map(|value| !value.is_ascii_alphanumeric() && value != b'_')
        .unwrap_or(true)
}

fn matching_secret_key(lower: &str, index: usize) -> Option<(&'static str, usize)> {
    const KEYS: [&str; 7] = [
        "authorization",
        "password",
        "api_key",
        "apikey",
        "bearer",
        "secret",
        "token",
    ];
    let bytes = lower.as_bytes();
    if matches!(bytes.get(index), Some(b'\'') | Some(b'"')) {
        let quote = bytes[index];
        let key_start = index + 1;
        for key in KEYS {
            let key_end = key_start + key.len();
            if lower[key_start..].starts_with(key) && bytes.get(key_end) == Some(&quote) {
                return Some((key, key_end + 1));
            }
        }
        return None;
    }

    if !is_key_boundary(index.checked_sub(1).map(|at| bytes[at])) {
        return None;
    }
    for key in KEYS {
        let key_end = index + key.len();
        if lower[index..].starts_with(key) && is_key_boundary(bytes.get(key_end).copied()) {
            return Some((key, key_end));
        }
    }
    None
}

fn skip_ascii_whitespace(bytes: &[u8], mut index: usize) -> usize {
    while bytes.get(index).is_some_and(u8::is_ascii_whitespace) {
        index += 1;
    }
    index
}

fn is_secret_value_delimiter(byte: u8) -> bool {
    byte.is_ascii_whitespace() || matches!(byte, b',' | b';' | b'}' | b']')
}

fn quoted_value_end(bytes: &[u8], start: usize, quote: u8) -> usize {
    let mut index = start;
    let mut escaped = false;
    while index < bytes.len() {
        let byte = bytes[index];
        if byte == quote && !escaped {
            break;
        }
        escaped = byte == b'\\' && !escaped;
        if byte != b'\\' {
            escaped = false;
        }
        index += 1;
    }
    index
}

fn unquoted_value_end(lower: &str, start: usize, key: &str) -> usize {
    let bytes = lower.as_bytes();
    let mut index = start;
    while index < bytes.len() && !is_secret_value_delimiter(bytes[index]) {
        index += 1;
    }

    if key == "authorization" {
        let scheme = &lower[start..index];
        if scheme.eq_ignore_ascii_case("bearer") || scheme.eq_ignore_ascii_case("basic") {
            let token_start = skip_ascii_whitespace(bytes, index);
            let mut token_end = token_start;
            while token_end < bytes.len() && !is_secret_value_delimiter(bytes[token_end]) {
                token_end += 1;
            }
            return token_end;
        }
    }
    index
}

fn redact_keyed_values(input: &str) -> String {
    let lower = input.to_ascii_lowercase();
    let bytes = lower.as_bytes();
    let mut output = String::with_capacity(input.len());
    let mut copied_through = 0;
    let mut index = 0;

    while index < input.len() {
        let Some((key, key_end)) = matching_secret_key(&lower, index) else {
            let character = input[index..]
                .chars()
                .next()
                .expect("index always points to a character boundary");
            index += character.len_utf8();
            continue;
        };
        let separator = skip_ascii_whitespace(bytes, key_end);
        if !matches!(bytes.get(separator), Some(b'=') | Some(b':')) {
            index = key_end;
            continue;
        }
        let value_start = skip_ascii_whitespace(bytes, separator + 1);
        if value_start >= input.len() {
            break;
        }

        let (content_start, content_end) = match bytes[value_start] {
            quote @ (b'\'' | b'"') => {
                let content_start = value_start + 1;
                (content_start, quoted_value_end(bytes, content_start, quote))
            }
            _ => (value_start, unquoted_value_end(&lower, value_start, key)),
        };
        if content_start == content_end {
            index = content_end.max(key_end);
            continue;
        }

        output.push_str(&input[copied_through..content_start]);
        output.push_str("[REDACTED]");
        copied_through = content_end;
        index = content_end;
    }
    output.push_str(&input[copied_through..]);
    output
}

fn redact_standalone_bearer(input: &str) -> String {
    let lower = input.to_ascii_lowercase();
    let bytes = lower.as_bytes();
    let mut output = String::with_capacity(input.len());
    let mut copied_through = 0;
    let mut index = 0;

    while index < input.len() {
        let end = index + "bearer".len();
        if lower[index..].starts_with("bearer")
            && is_key_boundary(index.checked_sub(1).map(|at| bytes[at]))
            && bytes.get(end).is_some_and(u8::is_ascii_whitespace)
        {
            let value_start = skip_ascii_whitespace(bytes, end);
            let value_end = if matches!(bytes.get(value_start), Some(b'\'') | Some(b'"')) {
                let quote = bytes[value_start];
                quoted_value_end(bytes, value_start + 1, quote)
            } else {
                unquoted_value_end(&lower, value_start, "bearer")
            };
            let content_start = if matches!(bytes.get(value_start), Some(b'\'') | Some(b'"')) {
                value_start + 1
            } else {
                value_start
            };
            if content_start < value_end {
                output.push_str(&input[copied_through..content_start]);
                output.push_str("[REDACTED]");
                copied_through = value_end;
                index = value_end;
                continue;
            }
        }
        let character = input[index..]
            .chars()
            .next()
            .expect("index always points to a character boundary");
        index += character.len_utf8();
    }
    output.push_str(&input[copied_through..]);
    output
}

fn redact_prefixed_tokens(line: &str) -> String {
    let lower = line.to_ascii_lowercase();
    let mut output = String::with_capacity(line.len());
    let mut index = 0;
    while index < line.len() {
        let matching_prefix = ["github_pat_", "ghp_", "sk-"]
            .iter()
            .find(|prefix| lower[index..].starts_with(**prefix));
        if matching_prefix.is_some() {
            output.push_str("[REDACTED]");
            index += matching_prefix.unwrap().len();
            while index < line.len() {
                let byte = line.as_bytes()[index];
                if byte.is_ascii_whitespace() || matches!(byte, b'\'' | b'"' | b',' | b';') {
                    break;
                }
                index += 1;
            }
            continue;
        }

        let character = line[index..]
            .chars()
            .next()
            .expect("index always points to a character boundary");
        output.push(character);
        index += character.len_utf8();
    }
    output
}

fn redact_secrets(input: &str) -> String {
    let keyed = redact_keyed_values(input);
    let bearer = redact_standalone_bearer(&keyed);
    redact_prefixed_tokens(&bearer)
}

fn sanitize_output(input: &[u8], max_bytes: usize) -> SanitizedOutput {
    let stripped = strip_ansi(input);
    let decoded = String::from_utf8_lossy(&stripped);
    let mut data = redact_secrets(&decoded);
    let truncated = data.len() > max_bytes;
    if truncated {
        let mut boundary = max_bytes.min(data.len());
        while boundary > 0 && !data.is_char_boundary(boundary) {
            boundary -= 1;
        }
        data.truncate(boundary);
    }
    SanitizedOutput { data, truncated }
}

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
enum AnsiSequenceState {
    #[default]
    Ground,
    Escape,
    Csi,
    Osc,
    OscEscape,
}

#[derive(Default)]
struct StreamingSanitizer {
    ansi_state: AnsiSequenceState,
    pending: Vec<u8>,
}

impl StreamingSanitizer {
    fn filter_ansi(&mut self, input: &[u8]) -> Vec<u8> {
        let mut output = Vec::with_capacity(input.len());
        for &byte in input {
            self.ansi_state = match self.ansi_state {
                AnsiSequenceState::Ground => match byte {
                    0x1b => AnsiSequenceState::Escape,
                    0x9b => AnsiSequenceState::Csi,
                    0x9d => AnsiSequenceState::Osc,
                    _ => {
                        output.push(byte);
                        AnsiSequenceState::Ground
                    }
                },
                AnsiSequenceState::Escape => match byte {
                    b'[' => AnsiSequenceState::Csi,
                    b']' => AnsiSequenceState::Osc,
                    _ => AnsiSequenceState::Ground,
                },
                AnsiSequenceState::Csi => {
                    if (0x40..=0x7e).contains(&byte) {
                        AnsiSequenceState::Ground
                    } else {
                        AnsiSequenceState::Csi
                    }
                }
                AnsiSequenceState::Osc => match byte {
                    0x07 | 0x9c => AnsiSequenceState::Ground,
                    0x1b => AnsiSequenceState::OscEscape,
                    _ => AnsiSequenceState::Osc,
                },
                AnsiSequenceState::OscEscape => match byte {
                    b'\\' | 0x07 | 0x9c => AnsiSequenceState::Ground,
                    0x1b => AnsiSequenceState::OscEscape,
                    _ => AnsiSequenceState::Osc,
                },
            };
        }
        output
    }

    fn push(&mut self, input: &[u8], pending_limit: usize, max_bytes: usize) -> SanitizedOutput {
        let filtered = self.filter_ansi(input);
        let keep = filtered
            .len()
            .min(pending_limit.saturating_sub(self.pending.len()));
        self.pending.extend_from_slice(&filtered[..keep]);
        let truncated = keep < filtered.len();
        if has_incomplete_secret_assignment(&String::from_utf8_lossy(&self.pending)) {
            return SanitizedOutput {
                data: String::new(),
                truncated,
            };
        }

        let mut output = self.finish(max_bytes);
        output.truncated |= truncated;
        output
    }

    fn finish(&mut self, max_bytes: usize) -> SanitizedOutput {
        sanitize_output(&std::mem::take(&mut self.pending), max_bytes)
    }
}

fn has_incomplete_secret_assignment(input: &str) -> bool {
    let lower = input.to_ascii_lowercase();
    let bytes = lower.as_bytes();
    let mut index = 0;

    while index < input.len() {
        if let Some((key, key_end)) = matching_secret_key(&lower, index) {
            let separator = skip_ascii_whitespace(bytes, key_end);
            if matches!(bytes.get(separator), Some(b'=') | Some(b':')) {
                let value_start = skip_ascii_whitespace(bytes, separator + 1);
                if value_start >= bytes.len() {
                    return true;
                }
                match bytes[value_start] {
                    quote @ (b'\'' | b'"') => {
                        if quoted_value_end(bytes, value_start + 1, quote) >= bytes.len() {
                            return true;
                        }
                    }
                    _ => {
                        if unquoted_value_end(&lower, value_start, key) >= bytes.len() {
                            return true;
                        }
                    }
                }
            }
            index = key_end;
            continue;
        }

        let bearer_end = index + "bearer".len();
        if lower[index..].starts_with("bearer")
            && is_key_boundary(index.checked_sub(1).map(|at| bytes[at]))
            && bytes.get(bearer_end).is_some_and(u8::is_ascii_whitespace)
        {
            let value_start = skip_ascii_whitespace(bytes, bearer_end);
            if value_start >= bytes.len() {
                return true;
            }
            let value_end = match bytes[value_start] {
                quote @ (b'\'' | b'"') => quoted_value_end(bytes, value_start + 1, quote),
                _ => unquoted_value_end(&lower, value_start, "bearer"),
            };
            if value_end >= bytes.len() {
                return true;
            }
        }

        let character = input[index..]
            .chars()
            .next()
            .expect("index always points to a character boundary");
        index += character.len_utf8();
    }

    false
}

#[cfg(test)]
fn build_windows_taskkill_args(pid: u32) -> Vec<String> {
    vec![
        "/PID".to_string(),
        pid.to_string(),
        "/T".to_string(),
        "/F".to_string(),
    ]
}

fn scan_search_paths(
    state: &CliBridgeState,
    executable_names: &[String],
    search_paths: &[PathBuf],
    extensions: &[String],
) -> Result<Vec<DetectedExecutable>, String> {
    let mut detections = Vec::new();
    let mut seen = HashSet::new();

    for name in executable_names {
        validate_executable_name(name)?;
        for directory in search_paths {
            if !directory.is_absolute() {
                continue;
            }
            for extension in extensions {
                let candidate = directory.join(format!("{name}{extension}"));
                let Some(candidate_string) = candidate.to_str() else {
                    continue;
                };
                let Ok(canonical) = canonical_executable_path(candidate_string) else {
                    continue;
                };
                if name == KERNEL_SMOKE_EXECUTABLE_NAME
                    && validate_kernel_smoke_executable(&canonical).is_err()
                {
                    continue;
                }
                if seen.insert(canonical.clone()) {
                    detections
                        .push(state.register_trusted_executable(canonical, Some(name.clone()))?);
                }
            }
        }
    }
    Ok(detections)
}

#[cfg(windows)]
fn managed_executable_candidates_for_roots(
    executable_names: &[String],
    app_data: Option<&Path>,
    local_app_data: Option<&Path>,
    user_profile: Option<&Path>,
) -> Vec<(String, PathBuf)> {
    let mut candidates = Vec::new();
    if executable_names.iter().any(|name| name == "codex") {
        if let Some(root) = app_data {
            candidates.push((
                "codex".to_string(),
                root.join("npm")
                    .join("node_modules")
                    .join("@openai")
                    .join("codex")
                    .join("node_modules")
                    .join("@openai")
                    .join("codex-win32-x64")
                    .join("vendor")
                    .join("x86_64-pc-windows-msvc")
                    .join("bin")
                    .join("codex.exe"),
            ));
        }
        if let Some(root) = local_app_data {
            candidates.push((
                "codex".to_string(),
                root.join("Programs")
                    .join("OpenAI")
                    .join("Codex")
                    .join("bin")
                    .join("codex.exe"),
            ));
        }
        if let Some(root) = user_profile {
            candidates.push((
                "codex".to_string(),
                root.join(".codex")
                    .join("packages")
                    .join("standalone")
                    .join("current")
                    .join("bin")
                    .join("codex.exe"),
            ));
            candidates.push((
                "codex".to_string(),
                root.join(".bun")
                    .join("install")
                    .join("global")
                    .join("node_modules")
                    .join("@openai")
                    .join("codex")
                    .join("node_modules")
                    .join("@openai")
                    .join("codex-win32-x64")
                    .join("vendor")
                    .join("x86_64-pc-windows-msvc")
                    .join("bin")
                    .join("codex.exe"),
            ));
        }
    }
    candidates
}

#[cfg(windows)]
fn scan_managed_executable_candidates(
    state: &CliBridgeState,
    executable_names: &[String],
) -> Result<Vec<DetectedExecutable>, String> {
    let app_data = std::env::var_os("APPDATA").map(PathBuf::from);
    let local_app_data = std::env::var_os("LOCALAPPDATA").map(PathBuf::from);
    let user_profile = std::env::var_os("USERPROFILE").map(PathBuf::from);
    let mut detections = Vec::new();
    let mut seen = HashSet::new();

    for (name, candidate) in managed_executable_candidates_for_roots(
        executable_names,
        app_data.as_deref(),
        local_app_data.as_deref(),
        user_profile.as_deref(),
    ) {
        let Some(candidate_string) = candidate.to_str() else {
            continue;
        };
        let Ok(canonical) = canonical_executable_path(candidate_string) else {
            continue;
        };
        if seen.insert(canonical.clone()) {
            detections.push(state.register_trusted_executable(canonical, Some(name))?);
        }
    }
    Ok(detections)
}

fn path_extensions() -> Vec<String> {
    #[cfg(windows)]
    {
        let mut extensions = vec![String::new()];
        if let Some(value) = std::env::var_os("PATHEXT") {
            for extension in value.to_string_lossy().split(';') {
                if extension.starts_with('.')
                    && extension.len() <= 16
                    && extension
                        .bytes()
                        .skip(1)
                        .all(|byte| byte.is_ascii_alphanumeric())
                    && !extensions
                        .iter()
                        .any(|known| known.eq_ignore_ascii_case(extension))
                {
                    extensions.push(extension.to_string());
                }
            }
        }
        extensions
    }
    #[cfg(not(windows))]
    {
        vec![String::new()]
    }
}

fn scan_with_state(
    state: &CliBridgeState,
    request: CliScanRequest,
) -> Result<CliDetectionResult, String> {
    for name in &request.executable_names {
        validate_executable_name(name)?;
    }

    let search_paths: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|value| std::env::split_paths(&value).collect())
        .unwrap_or_default();
    let mut executables = scan_search_paths(
        state,
        &request.executable_names,
        &search_paths,
        &path_extensions(),
    )?;
    #[cfg(windows)]
    {
        for detection in scan_managed_executable_candidates(state, &request.executable_names)? {
            if !executables
                .iter()
                .any(|item| item.executable_path == detection.executable_path)
            {
                executables.push(detection);
            }
        }
    }

    if let Some(custom_path) = request.custom_path {
        let canonical = validate_executable_path(&custom_path, request.custom_path_confirmed)?;
        if !executables
            .iter()
            .any(|item| Path::new(&item.executable_path) == canonical)
        {
            executables.push(state.register_trusted_executable(canonical, None)?);
        }
    }

    Ok(CliDetectionResult { executables })
}

#[tauri::command]
pub fn cli_bridge_scan(
    state: tauri::State<'_, CliBridgeState>,
    request: CliScanRequest,
) -> Result<CliDetectionResult, String> {
    scan_with_state(&state, request)
}

#[tauri::command]
pub fn cli_bridge_codex_account_snapshot(
    state: tauri::State<'_, CliBridgeState>,
    request: CodexAccountSnapshotRequest,
) -> Result<CodexAccountSnapshot, String> {
    validate_timeout(request.timeout_ms)?;
    let executable = state.resolve_trusted_executable(&request.executable_id)?;
    let file_name = executable
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    if file_name != "codex" && file_name != "codex.exe" {
        return Err("account snapshot requires a trusted Codex executable".to_string());
    }

    let mut child = Command::new(&executable)
        .arg("app-server")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|_| "Codex app-server could not start".to_string())?;
    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| "Codex app-server stdin is unavailable".to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Codex app-server stdout is unavailable".to_string())?;
    let (sender, receiver) = mpsc::channel();
    thread::spawn(move || {
        for line in BufReader::new(stdout).lines() {
            match line {
                Ok(line) => {
                    if sender.send(line).is_err() {
                        return;
                    }
                }
                Err(_) => return,
            }
        }
    });
    let interaction = (|| -> Result<(serde_json::Value, serde_json::Value), String> {
        let write_request = |writer: &mut std::process::ChildStdin,
                             value: serde_json::Value|
         -> Result<(), String> {
            serde_json::to_writer(&mut *writer, &value)
                .map_err(|_| "Codex app-server request encoding failed".to_string())?;
            writer
                .write_all(b"\n")
                .and_then(|_| writer.flush())
                .map_err(|_| "Codex app-server request write failed".to_string())
        };
        write_request(
            &mut stdin,
            serde_json::json!({
                "id": 1,
                "method": "initialize",
                "params": {
                    "clientInfo": {
                        "name": "vibespace",
                        "title": "VibeSpace",
                        "version": env!("CARGO_PKG_VERSION")
                    },
                    "capabilities": { "experimentalApi": true }
                }
            }),
        )?;

        let deadline = Instant::now() + Duration::from_millis(request.timeout_ms);
        let receive_until = |wanted_id: u64| -> Result<serde_json::Value, String> {
            loop {
                let remaining = deadline.saturating_duration_since(Instant::now());
                if remaining.is_zero() {
                    return Err("Codex app-server request timed out".to_string());
                }
                let line = receiver
                    .recv_timeout(remaining)
                    .map_err(|_| "Codex app-server request timed out".to_string())?;
                let Ok(value) = serde_json::from_str::<serde_json::Value>(&line) else {
                    continue;
                };
                if value.get("id").and_then(serde_json::Value::as_u64) != Some(wanted_id) {
                    continue;
                }
                if value.get("error").is_some() {
                    return Err("Codex app-server returned a protocol error".to_string());
                }
                return value
                    .get("result")
                    .cloned()
                    .ok_or_else(|| "Codex app-server result is missing".to_string());
            }
        };
        receive_until(1)?;
        write_request(
            &mut stdin,
            serde_json::json!({"method": "initialized", "params": {}}),
        )?;
        write_request(
            &mut stdin,
            serde_json::json!({"id": 2, "method": "account/rateLimits/read", "params": {}}),
        )?;
        let rate_limits = receive_until(2)?;
        write_request(
            &mut stdin,
            serde_json::json!({"id": 3, "method": "account/usage/read", "params": {}}),
        )?;
        let token_usage = receive_until(3)?;
        Ok((rate_limits, token_usage))
    })();
    let _ = child.kill();
    let _ = child.wait();
    let (rate_limits, token_usage) = interaction?;

    Ok(CodexAccountSnapshot {
        rate_limits,
        token_usage,
        updated_at: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis()
            .min(u64::MAX as u128) as u64,
        source: "codex-app-server".to_string(),
    })
}

#[derive(Debug)]
struct CapturedOutput {
    bytes: Vec<u8>,
    truncated: bool,
}

enum StreamReaderMessage {
    Data {
        stream: CliEventStream,
        bytes: Vec<u8>,
    },
    Done {
        stream: CliEventStream,
        truncated: bool,
    },
    Error {
        stream: CliEventStream,
        error: String,
    },
}

fn read_bounded(mut reader: impl Read, limit: usize) -> std::io::Result<CapturedOutput> {
    let mut bytes = Vec::with_capacity(limit.min(64 * 1024));
    let mut buffer = [0_u8; 8 * 1024];
    let mut truncated = false;
    loop {
        let count = reader.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        let remaining = limit.saturating_sub(bytes.len());
        let keep = count.min(remaining);
        bytes.extend_from_slice(&buffer[..keep]);
        truncated |= keep < count;
    }
    Ok(CapturedOutput { bytes, truncated })
}

fn read_bounded_lines(
    mut reader: impl Read,
    stream: CliEventStream,
    limit: usize,
    sender: mpsc::Sender<StreamReaderMessage>,
) {
    let mut line = Vec::with_capacity(limit.min(8 * 1024));
    let mut buffer = [0_u8; 8 * 1024];
    let mut kept_total = 0_usize;
    let mut truncated = false;

    loop {
        let count = match reader.read(&mut buffer) {
            Ok(0) => break,
            Ok(count) => count,
            Err(error) => {
                let _ = sender.send(StreamReaderMessage::Error {
                    stream,
                    error: error.to_string(),
                });
                return;
            }
        };
        let keep = count.min(limit.saturating_sub(kept_total));
        truncated |= keep < count;
        kept_total += keep;

        let kept = &buffer[..keep];
        let mut start = 0;
        for (index, byte) in kept.iter().enumerate() {
            if *byte == b'\n' {
                line.extend_from_slice(&kept[start..=index]);
                if sender
                    .send(StreamReaderMessage::Data {
                        stream,
                        bytes: std::mem::take(&mut line),
                    })
                    .is_err()
                {
                    return;
                }
                start = index + 1;
            }
        }
        line.extend_from_slice(&kept[start..]);
    }

    if !line.is_empty()
        && sender
            .send(StreamReaderMessage::Data {
                stream,
                bytes: line,
            })
            .is_err()
    {
        return;
    }
    let _ = sender.send(StreamReaderMessage::Done { stream, truncated });
}

fn sanitized_capture(captured: CapturedOutput, limit: usize) -> SanitizedOutput {
    let mut output = sanitize_output(&captured.bytes, limit);
    output.truncated |= captured.truncated;
    output
}

#[cfg(windows)]
fn configure_process(command: &mut Command) {
    use std::os::windows::process::CommandExt;
    const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    command.creation_flags(CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP);
}

#[cfg(not(windows))]
fn configure_process(_command: &mut Command) {}

#[cfg(windows)]
mod windows_process_tree {
    use super::*;
    use std::ffi::c_void;
    use std::mem::size_of;
    use std::os::windows::io::AsRawHandle;
    use std::os::windows::process::CommandExt;
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::{CloseHandle, HANDLE};
    use windows::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Thread32First, Thread32Next, TH32CS_SNAPTHREAD, THREADENTRY32,
    };
    use windows::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, TerminateJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    use windows::Win32::System::Threading::{OpenThread, ResumeThread, THREAD_SUSPEND_RESUME};

    const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    const CREATE_SUSPENDED: u32 = 0x0000_0004;

    struct OwnedKernelHandle(HANDLE);

    impl Drop for OwnedKernelHandle {
        fn drop(&mut self) {
            // SAFETY: Every OwnedKernelHandle is constructed from one successful Win32 handle
            // creation call and is never copied out, so this is its single matching close.
            let _ = unsafe { CloseHandle(self.0) };
        }
    }

    pub(super) struct KillOnCloseJob(OwnedKernelHandle);

    impl KillOnCloseJob {
        pub(super) fn create() -> Result<Self, String> {
            // SAFETY: Null security attributes and an unnamed job require no borrowed buffers.
            let handle = unsafe { CreateJobObjectW(None, PCWSTR::null()) }
                .map_err(|error| format!("failed to create CLI process job: {error}"))?;
            let job = Self(OwnedKernelHandle(handle));
            let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            // SAFETY: `limits` is initialized for the exact information class and remains alive
            // for the duration of the call; the byte count is its precise concrete size.
            unsafe {
                SetInformationJobObject(
                    job.0 .0,
                    JobObjectExtendedLimitInformation,
                    (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast::<c_void>(),
                    size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                )
            }
            .map_err(|error| format!("failed to configure CLI process job: {error}"))?;
            Ok(job)
        }

        pub(super) fn assign_and_resume(&self, child: &Child) -> Result<(), String> {
            let process_handle = HANDLE(child.as_raw_handle());
            // SAFETY: std::process::Child owns a live process handle for this call, and the job
            // handle is owned by `self`. The child was created suspended and cannot spawn yet.
            unsafe { AssignProcessToJobObject(self.0 .0, process_handle) }
                .map_err(|error| format!("failed to contain CLI process: {error}"))?;

            let thread_id = suspended_primary_thread_id(child.id())?;
            // SAFETY: `thread_id` was enumerated for this still-suspended child. The returned
            // handle is immediately put under single-close RAII ownership.
            let thread = OwnedKernelHandle(
                unsafe { OpenThread(THREAD_SUSPEND_RESUME, false, thread_id) }
                    .map_err(|error| format!("failed to open suspended CLI thread: {error}"))?,
            );
            // SAFETY: The handle grants THREAD_SUSPEND_RESUME and belongs to the only thread of
            // the contained CREATE_SUSPENDED process. Its prior suspend count must be exactly one.
            let previous_count = unsafe { ResumeThread(thread.0) };
            validate_resume_count(previous_count)
        }

        pub(super) fn terminate(&self) -> Result<(), String> {
            // SAFETY: The owned job handle stays valid for the full call.
            unsafe { TerminateJobObject(self.0 .0, 1) }
                .map_err(|error| format!("failed to terminate CLI process job: {error}"))
        }
    }

    pub(super) fn validate_resume_count(previous_count: u32) -> Result<(), String> {
        if previous_count == 1 {
            Ok(())
        } else {
            Err(format!(
                "failed to resume contained CLI process: unexpected suspend count {previous_count}"
            ))
        }
    }

    fn suspended_primary_thread_id(process_id: u32) -> Result<u32, String> {
        // SAFETY: The snapshot has no borrowed inputs and is placed under single-close RAII.
        let snapshot = OwnedKernelHandle(
            unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0) }
                .map_err(|error| format!("failed to enumerate suspended CLI threads: {error}"))?,
        );
        let mut entry = THREADENTRY32 {
            dwSize: size_of::<THREADENTRY32>() as u32,
            ..Default::default()
        };
        let mut matching_thread = None;
        // SAFETY: `entry` has the required `dwSize`, and both it and the snapshot remain valid
        // during enumeration. A CREATE_SUSPENDED process must expose exactly its primary thread.
        if unsafe { Thread32First(snapshot.0, &mut entry) }.is_ok() {
            loop {
                if entry.th32OwnerProcessID == process_id {
                    if matching_thread.replace(entry.th32ThreadID).is_some() {
                        return Err("suspended CLI process exposed multiple threads".to_string());
                    }
                }
                // ERROR_NO_MORE_FILES is the normal end of a ToolHelp enumeration. Any earlier
                // entries already found remain valid because the target process is suspended.
                if unsafe { Thread32Next(snapshot.0, &mut entry) }.is_err() {
                    break;
                }
            }
        }
        matching_thread.ok_or_else(|| "suspended CLI primary thread was not found".to_string())
    }

    pub(super) fn configure_suspended(command: &mut Command) {
        command.creation_flags(CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP | CREATE_SUSPENDED);
    }
}

struct ChildCleanupGuard {
    child: Option<Child>,
    #[cfg(windows)]
    job: Option<windows_process_tree::KillOnCloseJob>,
}

impl ChildCleanupGuard {
    #[cfg(windows)]
    fn new(child: Child, job: windows_process_tree::KillOnCloseJob) -> Self {
        Self {
            child: Some(child),
            job: Some(job),
        }
    }

    #[cfg(not(windows))]
    fn new(child: Child) -> Self {
        Self { child: Some(child) }
    }

    fn child_mut(&mut self) -> Result<&mut Child, String> {
        self.child
            .as_mut()
            .ok_or_else(|| "CLI process was already reaped".to_string())
    }

    fn disarm(&mut self) {
        #[cfg(windows)]
        self.job.take();
        self.child.take();
    }

    fn terminate_and_wait(&mut self) -> Result<ExitStatus, String> {
        #[cfg(windows)]
        let tree_terminated = self.job.take().is_some_and(|job| job.terminate().is_ok());
        #[cfg(not(windows))]
        let tree_terminated = false;

        let child = self
            .child
            .as_mut()
            .ok_or_else(|| "CLI process was already reaped".to_string())?;
        if !tree_terminated {
            let _ = child.kill();
        }
        child
            .wait()
            .map_err(|error| format!("failed to wait for terminated CLI process: {error}"))
    }
}

impl Drop for ChildCleanupGuard {
    fn drop(&mut self) {
        if self.child.is_some() {
            let _ = self.terminate_and_wait();
        }
    }
}

#[cfg(windows)]
fn spawn_contained_process(command: &mut Command) -> Result<ChildCleanupGuard, String> {
    let job = windows_process_tree::KillOnCloseJob::create()?;
    windows_process_tree::configure_suspended(command);
    let mut child = command
        .spawn()
        .map_err(|error| format!("failed to start CLI process: {error}"))?;
    if let Err(error) = job.assign_and_resume(&child) {
        let _ = job.terminate();
        drop(job);
        let _ = child.kill();
        let _ = child.wait();
        return Err(error);
    }
    Ok(ChildCleanupGuard::new(child, job))
}

#[cfg(not(windows))]
fn spawn_contained_process(command: &mut Command) -> Result<ChildCleanupGuard, String> {
    configure_process(command);
    command
        .spawn()
        .map(ChildCleanupGuard::new)
        .map_err(|error| format!("failed to start CLI process: {error}"))
}

fn wait_for_child(
    child: &mut ChildCleanupGuard,
    timeout: Duration,
) -> Result<(ExitStatus, bool), String> {
    let started = Instant::now();
    loop {
        if let Some(status) = child
            .child_mut()?
            .try_wait()
            .map_err(|error| format!("failed to poll CLI process: {error}"))?
        {
            return Ok((status, false));
        }
        if started.elapsed() >= timeout {
            let status = child.terminate_and_wait()?;
            return Ok((status, true));
        }
        thread::sleep(Duration::from_millis(10));
    }
}

fn probe_with_state(
    state: &CliBridgeState,
    request: CliProbeRequest,
) -> Result<CliProbeResult, String> {
    let prepared = prepare_probe_request(state, request)?;
    let mut command = Command::new(prepared.executable_path);
    command
        .args(&prepared.args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = spawn_contained_process(&mut command)
        .map_err(|error| format!("failed to start CLI probe: {error}"))?;

    let stdout = child
        .child_mut()?
        .stdout
        .take()
        .ok_or_else(|| "CLI probe stdout pipe was unavailable".to_string())?;
    let stderr = child
        .child_mut()?
        .stderr
        .take()
        .ok_or_else(|| "CLI probe stderr pipe was unavailable".to_string())?;
    let output_limit = prepared.output_limit_bytes;
    let stdout_reader = thread::spawn(move || read_bounded(stdout, output_limit));
    let stderr_reader = thread::spawn(move || read_bounded(stderr, output_limit));

    let (status, timed_out) =
        wait_for_child(&mut child, Duration::from_millis(prepared.timeout_ms))?;
    child.disarm();
    let stdout = stdout_reader
        .join()
        .map_err(|_| "CLI probe stdout reader panicked".to_string())?
        .map_err(|error| format!("failed to read CLI probe stdout: {error}"))?;
    let stderr = stderr_reader
        .join()
        .map_err(|_| "CLI probe stderr reader panicked".to_string())?
        .map_err(|error| format!("failed to read CLI probe stderr: {error}"))?;

    Ok(CliProbeResult {
        exit_code: status.code(),
        stdout: sanitized_capture(stdout, output_limit),
        stderr: sanitized_capture(stderr, output_limit),
        timed_out,
    })
}

#[tauri::command]
pub fn cli_bridge_probe(
    state: tauri::State<'_, CliBridgeState>,
    request: CliProbeRequest,
) -> Result<CliProbeResult, String> {
    probe_with_state(&state, request)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ProcessTerminal {
    Completed,
    Cancelled,
    TimedOut,
}

struct SupervisedProcessResult {
    exit_code: Option<i32>,
    terminal: ProcessTerminal,
}

#[derive(Default)]
struct StreamProgress {
    stdout_emitted: usize,
    stderr_emitted: usize,
    stdout_truncated: bool,
    stderr_truncated: bool,
    stdout_done: bool,
    stderr_done: bool,
    stdout_sanitizer: StreamingSanitizer,
    stderr_sanitizer: StreamingSanitizer,
}

fn handle_stream_message(
    message: StreamReaderMessage,
    output_limit: usize,
    progress: &mut StreamProgress,
    on_output: &mut impl FnMut(CliEventStream, SanitizedOutput),
) -> Result<(), String> {
    match message {
        StreamReaderMessage::Data { stream, bytes } => {
            let (emitted, truncated, sanitizer) = match stream {
                CliEventStream::Stdout => (
                    &mut progress.stdout_emitted,
                    &mut progress.stdout_truncated,
                    &mut progress.stdout_sanitizer,
                ),
                CliEventStream::Stderr => (
                    &mut progress.stderr_emitted,
                    &mut progress.stderr_truncated,
                    &mut progress.stderr_sanitizer,
                ),
                CliEventStream::Status => return Err("invalid status reader stream".to_string()),
            };
            let output =
                sanitizer.push(&bytes, output_limit, output_limit.saturating_sub(*emitted));
            *emitted += output.data.len();
            *truncated |= output.truncated;
            if !output.data.is_empty() || output.truncated {
                on_output(stream, output);
            }
        }
        StreamReaderMessage::Done { stream, truncated } => {
            let (emitted, already_truncated, done, sanitizer) = match stream {
                CliEventStream::Stdout => (
                    &mut progress.stdout_emitted,
                    &mut progress.stdout_truncated,
                    &mut progress.stdout_done,
                    &mut progress.stdout_sanitizer,
                ),
                CliEventStream::Stderr => (
                    &mut progress.stderr_emitted,
                    &mut progress.stderr_truncated,
                    &mut progress.stderr_done,
                    &mut progress.stderr_sanitizer,
                ),
                CliEventStream::Status => return Err("invalid status reader stream".to_string()),
            };
            let mut output = sanitizer.finish(output_limit.saturating_sub(*emitted));
            *emitted += output.data.len();
            output.truncated |= truncated;
            let output_truncated = output.truncated;
            if !output.data.is_empty() || (output.truncated && !*already_truncated) {
                on_output(stream, output);
            }
            *already_truncated |= output_truncated;
            *done = true;
        }
        StreamReaderMessage::Error { stream, error } => {
            return Err(format!("failed to read CLI {stream:?}: {error}"));
        }
    }
    Ok(())
}

fn poll_supervised_child(
    child: &mut ChildCleanupGuard,
    started: Instant,
    timeout: Duration,
    cancellation: &AtomicBool,
) -> Result<Option<(ExitStatus, ProcessTerminal)>, String> {
    if let Some(status) = child
        .child_mut()?
        .try_wait()
        .map_err(|error| format!("failed to poll CLI process: {error}"))?
    {
        return Ok(Some((status, ProcessTerminal::Completed)));
    }
    let terminal = if cancellation.load(Ordering::Acquire) {
        Some(ProcessTerminal::Cancelled)
    } else if started.elapsed() >= timeout {
        Some(ProcessTerminal::TimedOut)
    } else {
        None
    };
    if let Some(terminal) = terminal {
        let status = child.terminate_and_wait()?;
        return Ok(Some((status, terminal)));
    }
    Ok(None)
}

fn run_supervised_process(
    prepared: PreparedStartRequest,
    cancellation: CancellationFlag,
    mut on_started: impl FnMut(),
    mut on_output: impl FnMut(CliEventStream, SanitizedOutput),
) -> Result<SupervisedProcessResult, String> {
    let mut command = Command::new(&prepared.executable_path);
    command
        .args(&prepared.args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(cwd) = &prepared.cwd {
        command.current_dir(cwd);
    }
    if let Some(secret) = &prepared.secret_environment {
        command.env_remove("OPENAI_API_KEY");
        command.env_remove("OPENAI_KEY");
        command.env(secret.name, &secret.value);
    }
    let mut child = spawn_contained_process(&mut command)?;
    on_started();

    let Some(mut stdin) = child.child_mut()?.stdin.take() else {
        return Err("CLI process stdin pipe was unavailable".to_string());
    };
    let Some(stdout) = child.child_mut()?.stdout.take() else {
        return Err("CLI process stdout pipe was unavailable".to_string());
    };
    let Some(stderr) = child.child_mut()?.stderr.take() else {
        return Err("CLI process stderr pipe was unavailable".to_string());
    };

    let output_limit = prepared.output_limit_bytes;
    let (sender, receiver) = mpsc::channel();
    let stdout_sender = sender.clone();
    let stdout_reader = thread::spawn(move || {
        read_bounded_lines(stdout, CliEventStream::Stdout, output_limit, stdout_sender)
    });
    let stderr_reader = thread::spawn(move || {
        read_bounded_lines(stderr, CliEventStream::Stderr, output_limit, sender)
    });
    let input = prepared.stdin;
    let stdin_writer = thread::spawn(move || -> std::io::Result<()> {
        if let Some(input) = input {
            stdin.write_all(&input)?;
        }
        Ok(())
    });

    let mut stream_progress = StreamProgress::default();
    let process_started = Instant::now();
    let (status, terminal) = loop {
        while let Ok(message) = receiver.try_recv() {
            handle_stream_message(message, output_limit, &mut stream_progress, &mut on_output)?;
        }
        if let Some(outcome) = poll_supervised_child(
            &mut child,
            process_started,
            Duration::from_millis(prepared.timeout_ms),
            &cancellation,
        )? {
            break outcome;
        }
        thread::sleep(Duration::from_millis(10));
    };
    child.disarm();
    let stdin_result = stdin_writer
        .join()
        .map_err(|_| "CLI process stdin writer panicked".to_string())?;
    if terminal == ProcessTerminal::Completed {
        stdin_result.map_err(|error| format!("failed to write CLI process stdin: {error}"))?;
    }
    stdout_reader
        .join()
        .map_err(|_| "CLI process stdout reader panicked".to_string())?;
    stderr_reader
        .join()
        .map_err(|_| "CLI process stderr reader panicked".to_string())?;
    for message in receiver.try_iter() {
        handle_stream_message(message, output_limit, &mut stream_progress, &mut on_output)?;
    }
    if !stream_progress.stdout_done || !stream_progress.stderr_done {
        return Err("CLI output readers ended without a terminal message".to_string());
    }

    Ok(SupervisedProcessResult {
        exit_code: status.code(),
        terminal,
    })
}

const CLI_BRIDGE_EVENT: &str = "cli-bridge://event";

fn emit_cli_event(app: &tauri::AppHandle, event: CliBridgeEvent) {
    let _ = app.emit(CLI_BRIDGE_EVENT, event);
}

fn status_event(
    request_id: &str,
    status: CliEventStatus,
    data: String,
    exit_code: Option<i32>,
) -> CliBridgeEvent {
    CliBridgeEvent {
        request_id: request_id.to_string(),
        stream: CliEventStream::Status,
        data,
        exit_code,
        status,
        truncated: None,
    }
}

#[tauri::command]
pub fn cli_bridge_start(
    app: tauri::AppHandle,
    state: tauri::State<'_, CliBridgeState>,
    tool_gateway: tauri::State<'_, ToolGatewayState>,
    request: CliStartRequest,
) -> Result<(), String> {
    let request_id = request.request_id.clone();
    let output_limit = request.output_limit_bytes;
    let mut prepared = prepare_start_request(&state, request)?;
    let context_lease = if prepared.tool_scope {
        let directory = prepared
            .cwd
            .as_ref()
            .and_then(|path| path.to_str())
            .map(str::to_string);
        let lease =
            create_codex_context_lease(&app, &tool_gateway, &request_id, directory.as_deref())?;
        configure_codex_context_invocation(&mut prepared, lease.url(), lease.token())?;
        Some(lease)
    } else {
        None
    };
    let (cancellation, active_guard) = state.register(&request_id)?;
    let thread_request_id = request_id.clone();
    thread::Builder::new()
        .name(format!("cli-bridge-{request_id}"))
        .spawn(move || {
            let _active_guard = active_guard;
            let _context_lease = context_lease;
            let result = run_supervised_process(
                prepared,
                cancellation,
                || {
                    emit_cli_event(
                        &app,
                        status_event(
                            &thread_request_id,
                            CliEventStatus::Started,
                            String::new(),
                            None,
                        ),
                    );
                },
                |stream, output| {
                    emit_cli_event(
                        &app,
                        CliBridgeEvent {
                            request_id: thread_request_id.clone(),
                            stream,
                            data: output.data,
                            exit_code: None,
                            status: CliEventStatus::Data,
                            truncated: Some(output.truncated),
                        },
                    );
                },
            );

            match result {
                Ok(result) => {
                    let terminal_status = match result.terminal {
                        ProcessTerminal::Completed => CliEventStatus::Completed,
                        ProcessTerminal::Cancelled => CliEventStatus::Cancelled,
                        ProcessTerminal::TimedOut => CliEventStatus::TimedOut,
                    };
                    emit_cli_event(
                        &app,
                        status_event(
                            &thread_request_id,
                            terminal_status,
                            String::new(),
                            result.exit_code,
                        ),
                    );
                }
                Err(error) => {
                    let error = sanitize_output(error.as_bytes(), output_limit);
                    emit_cli_event(
                        &app,
                        status_event(&thread_request_id, CliEventStatus::Failed, error.data, None),
                    );
                }
            }
        })
        .map_err(|error| format!("failed to create CLI supervisor thread: {error}"))?;

    Ok(())
}

#[tauri::command]
pub fn cli_bridge_cancel(
    state: tauri::State<'_, CliBridgeState>,
    request_id: String,
) -> Result<bool, String> {
    validate_request_id(&request_id)?;
    state.request_cancel(&request_id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn kernel_smoke_cli_gate_requires_debug_exact_flag_and_exact_canonical_path() {
        let expected =
            PathBuf::from("C:\\worktree\\target\\debug\\examples\\vibespace_kernel_smoke_cli.exe");
        assert!(kernel_smoke_cli_gate(true, Some("1"), &expected, &expected));
        assert!(!kernel_smoke_cli_gate(
            false,
            Some("1"),
            &expected,
            &expected
        ));
        assert!(!kernel_smoke_cli_gate(true, None, &expected, &expected));
        assert!(!kernel_smoke_cli_gate(
            true,
            Some("true"),
            &expected,
            &expected
        ));
        assert!(!kernel_smoke_cli_gate(
            true,
            Some("1"),
            &PathBuf::from("C:\\other\\vibespace_kernel_smoke_cli.exe"),
            &expected,
        ));
    }

    fn fixture_path(name: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock should be after the Unix epoch")
            .as_nanos();
        std::env::temp_dir().join(format!(
            "vibespace-cli-bridge-{}-{nonce}-{name}",
            std::process::id()
        ))
    }

    fn register_test_executable(state: &CliBridgeState, path: &Path) -> String {
        state
            .register_trusted_executable(fs::canonicalize(path).unwrap(), None)
            .unwrap()
            .executable_id
    }

    #[test]
    fn codex_context_scope_requires_codex_identity_and_injects_only_isolated_http_mcp() {
        let executable = fixture_path("codex.exe");
        fs::write(&executable, b"codex fixture").unwrap();
        let canonical = fs::canonicalize(&executable).unwrap();
        let state = CliBridgeState::default();
        let codex_id = state
            .register_trusted_executable(canonical.clone(), Some("codex".into()))
            .unwrap()
            .executable_id;
        let mut prepared = prepare_start_request(
            &state,
            CliStartRequest {
                request_id: "codex-context-1".into(),
                executable_id: codex_id,
                args: vec![
                    "exec".into(),
                    "--json".into(),
                    "--model".into(),
                    "gpt-5.6-luna".into(),
                    "-c".into(),
                    "model_reasoning_effort=\"xhigh\"".into(),
                ],
                cwd: None,
                stdin: Some("exact prompt".into()),
                timeout_ms: 1_000,
                output_limit_bytes: 1_024,
                tool_scope: Some("vibespace_context".into()),
            },
        )
        .unwrap();
        let secret = "s".repeat(64);
        configure_codex_context_invocation(
            &mut prepared,
            "http://127.0.0.1:43123/v1/codex-context/lease",
            &secret,
        )
        .unwrap();

        assert_eq!(
            prepared.args,
            vec![
                "exec",
                "--ignore-user-config",
                "--ephemeral",
                "--json",
                "--model",
                "gpt-5.6-luna",
                "-c",
                "model_reasoning_effort=\"xhigh\"",
                "--sandbox",
                "read-only",
                "-c",
                "approval_policy=\"never\"",
                "-c",
                "mcp_servers.vibespace_context.url=\"http://127.0.0.1:43123/v1/codex-context/lease\"",
                "-c",
                "mcp_servers.vibespace_context.bearer_token_env_var=\"VIBESPACE_CODEX_CONTEXT_TOKEN\"",
                "-c",
                "mcp_servers.vibespace_context.enabled_tools=[\"vibespace_context\"]",
                "-c",
                "mcp_servers.vibespace_context.required=true",
                "-"
            ]
        );
        assert!(!prepared.args.iter().any(|arg| arg.contains(&secret)));
        assert_eq!(prepared.stdin, Some(b"exact prompt".to_vec()));
        assert_eq!(
            format!("{:?}", prepared.secret_environment),
            "Some(SecretEnvironment { name: \"VIBESPACE_CODEX_CONTEXT_TOKEN\", value: \"[redacted]\" })"
        );

        let custom_state = CliBridgeState::default();
        let custom_id = custom_state
            .register_trusted_executable(canonical, None)
            .unwrap()
            .executable_id;
        assert!(prepare_start_request(
            &custom_state,
            CliStartRequest {
                request_id: "codex-context-2".into(),
                executable_id: custom_id,
                args: vec!["exec".into()],
                cwd: None,
                stdin: Some("prompt".into()),
                timeout_ms: 1_000,
                output_limit_bytes: 1_024,
                tool_scope: Some("vibespace_context".into()),
            }
        )
        .is_err());
        prepared.args = vec![
            "exec".into(),
            "--json".into(),
            "--model".into(),
            "gpt-5.6-luna".into(),
            "--dangerously-bypass-approvals-and-sandbox".into(),
        ];
        prepared.secret_environment = None;
        assert!(configure_codex_context_invocation(
            &mut prepared,
            "http://127.0.0.1:43123/v1/codex-context/lease",
            &secret,
        )
        .is_err());
        let _ = fs::remove_file(executable);
    }

    #[test]
    fn cli_bridge_accepts_safe_executable_names_and_rejects_unsafe_names() {
        for name in [
            "codex",
            "claude",
            "gemini",
            "copilot",
            "qwen",
            "opencode",
            "cursor-agent",
            "cline",
            "aider",
            "goose",
            "openai",
        ] {
            assert!(validate_executable_name(name).is_ok(), "rejected {name:?}");
        }

        for name in [
            "",
            "node",
            "node.exe",
            "claude-code",
            "gemini_cli",
            "safe-tool",
            "../codex",
            "folder/codex",
            "folder\\codex.exe",
            "codex & whoami",
            "codex;whoami",
            "$(calc)",
            "codex cli",
            "cÃ¸dex",
        ] {
            assert!(validate_executable_name(name).is_err(), "accepted {name:?}");
        }
    }

    #[cfg(windows)]
    #[test]
    fn cli_bridge_requires_the_expected_primary_thread_suspend_count() {
        assert!(windows_process_tree::validate_resume_count(1).is_ok());
        for unexpected in [0, 2, u32::MAX] {
            assert!(
                windows_process_tree::validate_resume_count(unexpected).is_err(),
                "accepted unexpected suspend count {unexpected}"
            );
        }
    }

    #[test]
    fn cli_bridge_rejects_unconfirmed_relative_missing_directory_and_script_paths() {
        let executable = std::env::current_exe().expect("current test executable");
        assert!(validate_executable_path(executable.to_str().unwrap(), false).is_err());
        assert!(validate_executable_path("relative-program.exe", true).is_err());

        let missing = fixture_path("missing.exe");
        assert!(validate_executable_path(missing.to_str().unwrap(), true).is_err());

        let directory = fixture_path("directory");
        fs::create_dir_all(&directory).unwrap();
        assert!(validate_executable_path(directory.to_str().unwrap(), true).is_err());
        fs::remove_dir_all(directory).unwrap();

        for extension in ["cmd", "BAT", "Ps1"] {
            let shim = fixture_path(&format!("shim.{extension}"));
            fs::write(&shim, b"echo unsafe").unwrap();
            assert!(validate_executable_path(shim.to_str().unwrap(), true).is_err());
            fs::remove_file(shim).unwrap();
        }
    }

    #[test]
    fn cli_bridge_preserves_arguments_and_keeps_prompt_only_in_stdin() {
        let executable = std::env::current_exe().expect("current test executable");
        let state = CliBridgeState::default();
        let executable_id = register_test_executable(&state, &executable);
        let args = vec![
            "--project".to_string(),
            r"C:\project with spaces\x & y $(calc)".to_string(),
            "semi;colon".to_string(),
        ];
        let prompt = "hello & whoami $(calc)".to_string();
        let prepared = prepare_start_request(
            &state,
            CliStartRequest {
                request_id: "request-1".to_string(),
                executable_id,
                args: args.clone(),
                cwd: None,
                stdin: Some(prompt.clone()),
                timeout_ms: 1_000,
                output_limit_bytes: 1_024,
                tool_scope: None,
            },
        )
        .expect("valid request");

        assert_eq!(prepared.args, args);
        assert_eq!(prepared.stdin, Some(prompt.into_bytes()));
        assert!(!prepared.args.iter().any(|arg| arg.contains("whoami")));
    }

    #[test]
    fn cli_bridge_validates_timeout_output_and_request_id_bounds() {
        assert!(validate_runtime_limits(100, 1_024).is_ok());
        assert!(validate_runtime_limits(86_400_000, 1_048_576).is_ok());
        assert!(validate_runtime_limits(86_400_001, 1_048_576).is_err());
        assert!(validate_runtime_limits(99, 1_024).is_err());
        assert!(validate_runtime_limits(300_001, 1_024).is_ok());
        assert!(validate_runtime_limits(100, 1_023).is_err());
        assert!(validate_runtime_limits(100, 1_048_577).is_err());

        assert!(validate_request_id("request_ABC-123").is_ok());
        assert!(validate_request_id("").is_err());
        assert!(validate_request_id(&"a".repeat(129)).is_err());
        assert!(validate_request_id("request with spaces").is_err());
        assert!(validate_request_id("request/child").is_err());
        assert!(validate_request_id("rÃ©quest").is_err());
    }

    #[test]
    fn cli_bridge_strips_ansi_and_redacts_secret_shaped_output() {
        let input = concat!(
            "\x1b[31mtoken=tok_live_123\x1b[0m\n",
            "api_key: api-secret-456\n",
            "Authorization: Bearer sk-super-secret\n",
            "password=hunter2\n",
            "github github_pat_ABC123 and ghp_DEF456\n",
            "\x1b]0;private title\x07safe\n",
        );

        let output = sanitize_output(input.as_bytes(), 4_096);

        assert!(!output.truncated);
        assert!(!output.data.contains('\x1b'));
        for secret in [
            "tok_live_123",
            "api-secret-456",
            "sk-super-secret",
            "hunter2",
            "github_pat_ABC123",
            "ghp_DEF456",
            "private title",
        ] {
            assert!(!output.data.contains(secret), "secret survived: {secret}");
        }
        assert!(output.data.matches("[REDACTED]").count() >= 6);
        assert!(output.data.contains("safe"));
    }

    #[test]
    fn cli_bridge_redacts_composed_json_bearer_and_prefix_secrets() {
        let input = concat!(
            "{\"safe\":\"json-kept\",\"token\":\"tok_live_123\",\"tail\":\"tail-kept\"}\n",
            "bearer=bearer-equals-secret safe=equals-kept\n",
            "bearer:bearer-colon-secret safe=colon-kept\n",
            "{\"authorization\":\"Bearer quoted-auth-secret\",\"safe\":\"auth-kept\"}\n",
            "ghp_PREFIXSECRET token=mixed-token-secret safe=mixed-kept\n",
        );

        let output = sanitize_output(input.as_bytes(), 8_192);

        for secret in [
            "tok_live_123",
            "bearer-equals-secret",
            "bearer-colon-secret",
            "quoted-auth-secret",
            "ghp_PREFIXSECRET",
            "mixed-token-secret",
        ] {
            assert!(!output.data.contains(secret), "secret survived: {secret}");
        }
        for safe in [
            "json-kept",
            "tail-kept",
            "equals-kept",
            "colon-kept",
            "auth-kept",
            "mixed-kept",
        ] {
            assert!(output.data.contains(safe), "safe field was lost: {safe}");
        }
    }

    #[test]
    fn cli_bridge_lossily_decodes_and_explicitly_truncates_output() {
        let output = sanitize_output(&[0xff, b'a', b'b', b'c', b'd', b'e'], 4);

        assert!(output.truncated);
        assert!(output.data.as_bytes().len() <= 4);
        assert!(output.data.contains('\u{fffd}'));
    }

    #[test]
    fn cli_bridge_builds_fixed_windows_taskkill_arguments() {
        assert_eq!(
            build_windows_taskkill_args(42),
            vec!["/PID", "42", "/T", "/F"]
        );
    }

    #[test]
    fn cli_bridge_discovers_regular_files_without_executing_script_shims() {
        let directory = fixture_path("scan");
        fs::create_dir_all(&directory).unwrap();
        let executable = directory.join("codex");
        let shim = directory.join("codex.cmd");
        fs::write(&executable, b"not executed").unwrap();
        fs::write(&shim, b"echo must not execute").unwrap();

        let state = CliBridgeState::default();
        let paths = vec![directory.clone()];
        let detections =
            scan_search_paths(&state, &["codex".to_string()], &paths, &[String::new()]).unwrap();
        assert_eq!(detections.len(), 1);
        assert!(!detections[0].executable_id.is_empty());
        assert_eq!(
            state
                .resolve_trusted_executable(&detections[0].executable_id)
                .unwrap(),
            fs::canonicalize(&executable).unwrap()
        );
        assert_eq!(
            detections[0].executable_path,
            fs::canonicalize(&executable)
                .unwrap()
                .to_string_lossy()
                .into_owned()
        );

        let shim_only = scan_search_paths(
            &state,
            &["codex".to_string()],
            &paths,
            &[".cmd".to_string()],
        )
        .unwrap();
        assert!(shim_only.is_empty());
        fs::remove_dir_all(directory).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn cli_bridge_resolves_the_official_codex_native_binary_beneath_an_npm_shim() {
        let app_data = fixture_path("managed-codex-appdata");
        let npm_root = app_data.join("npm");
        let native_binary = npm_root
            .join("node_modules")
            .join("@openai")
            .join("codex")
            .join("node_modules")
            .join("@openai")
            .join("codex-win32-x64")
            .join("vendor")
            .join("x86_64-pc-windows-msvc")
            .join("bin")
            .join("codex.exe");
        fs::create_dir_all(native_binary.parent().unwrap()).unwrap();
        fs::write(npm_root.join("codex.cmd"), b"@echo off\nnode codex.js %*").unwrap();
        fs::write(&native_binary, b"native fixture; never executed").unwrap();

        let candidates = managed_executable_candidates_for_roots(
            &["codex".to_string()],
            Some(&app_data),
            None,
            None,
        );

        assert_eq!(candidates, vec![("codex".to_string(), native_binary)]);
        assert!(!candidates[0].1.to_string_lossy().ends_with(".cmd"));
        fs::remove_dir_all(app_data).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn cli_bridge_includes_current_official_windows_standalone_codex_locations() {
        let local_app_data = PathBuf::from(r"C:\Users\Test\AppData\Local");
        let user_profile = PathBuf::from(r"C:\Users\Test");
        let candidates = managed_executable_candidates_for_roots(
            &["codex".to_string()],
            None,
            Some(&local_app_data),
            Some(&user_profile),
        );

        assert!(candidates.iter().any(|(_, path)| {
            path == &local_app_data
                .join("Programs")
                .join("OpenAI")
                .join("Codex")
                .join("bin")
                .join("codex.exe")
        }));
        assert!(candidates.iter().any(|(_, path)| {
            path == &user_profile
                .join(".codex")
                .join("packages")
                .join("standalone")
                .join("current")
                .join("bin")
                .join("codex.exe")
        }));
    }

    #[test]
    fn cli_bridge_scan_accepts_a_confirmed_canonical_custom_executable() {
        let executable = std::env::current_exe().expect("current test executable");
        let state = CliBridgeState::default();
        let result = scan_with_state(
            &state,
            CliScanRequest {
                executable_names: Vec::new(),
                custom_path: Some(executable.to_string_lossy().into_owned()),
                custom_path_confirmed: true,
            },
        )
        .expect("confirmed executable should scan");

        assert_eq!(result.executables.len(), 1);
        assert_eq!(
            PathBuf::from(&result.executables[0].executable_path),
            fs::canonicalize(executable).unwrap()
        );
        assert!(state
            .resolve_trusted_executable(&result.executables[0].executable_id)
            .is_ok());
    }

    #[test]
    fn cli_bridge_registry_issues_opaque_identity_and_rejects_replacement() {
        let executable = fixture_path("trusted-provider.exe");
        fs::write(&executable, b"original executable").unwrap();
        let canonical = fs::canonicalize(&executable).unwrap();
        let state = CliBridgeState::default();

        let detection = state
            .register_trusted_executable(canonical.clone(), Some("codex".to_string()))
            .expect("confirmed executable should be registered");

        assert!(!detection.executable_id.is_empty());
        assert_ne!(detection.executable_id, detection.executable_path);
        assert_eq!(
            state
                .resolve_trusted_executable(&detection.executable_id)
                .unwrap(),
            canonical
        );

        fs::write(
            &executable,
            b"replacement executable with different metadata",
        )
        .unwrap();
        assert!(state
            .resolve_trusted_executable(&detection.executable_id)
            .is_err());
        fs::remove_file(executable).unwrap();
    }

    #[test]
    fn cli_bridge_commands_require_identity_registered_by_confirmed_scan() {
        let executable = fixture_path("command-boundary.exe");
        fs::write(&executable, b"trusted executable").unwrap();
        let raw_path = executable.to_string_lossy().into_owned();
        let state = CliBridgeState::default();
        let detection = scan_with_state(
            &state,
            CliScanRequest {
                executable_names: Vec::new(),
                custom_path: Some(raw_path.clone()),
                custom_path_confirmed: true,
            },
        )
        .unwrap()
        .executables
        .remove(0);

        let probe = |executable_id: String| CliProbeRequest {
            executable_id,
            args: vec!["--list".to_string()],
            timeout_ms: 10_000,
            output_limit_bytes: 1_024,
        };
        let start = |executable_id: String| CliStartRequest {
            request_id: "trusted-boundary".to_string(),
            executable_id,
            args: Vec::new(),
            cwd: None,
            stdin: None,
            timeout_ms: 1_000,
            output_limit_bytes: 1_024,
            tool_scope: None,
        };

        assert!(prepare_probe_request(&state, probe(raw_path.clone())).is_err());
        assert!(prepare_start_request(&state, start(raw_path)).is_err());
        assert!(prepare_probe_request(&state, probe(detection.executable_id.clone())).is_ok());
        assert!(prepare_start_request(&state, start(detection.executable_id.clone())).is_ok());

        fs::write(
            &executable,
            b"replacement executable with different metadata",
        )
        .unwrap();
        assert!(prepare_probe_request(&state, probe(detection.executable_id.clone())).is_err());
        assert!(prepare_start_request(&state, start(detection.executable_id)).is_err());
        fs::remove_file(executable).unwrap();
    }

    #[test]
    fn cli_bridge_probe_runs_a_read_only_argument_and_preserves_exit_code() {
        let executable = std::env::current_exe().expect("current test executable");
        let state = CliBridgeState::default();
        let executable_id = register_test_executable(&state, &executable);
        let result = probe_with_state(
            &state,
            CliProbeRequest {
                executable_id,
                args: vec!["--list".to_string()],
                timeout_ms: 10_000,
                output_limit_bytes: 1_048_576,
            },
        )
        .expect("test executable probe");

        assert_eq!(result.exit_code, Some(0));
        assert!(!result.timed_out);
        assert!(result.stdout.data.contains("cli_bridge"));
    }

    #[test]
    fn cli_bridge_probe_enforces_timeout() {
        let executable = std::env::current_exe().expect("current test executable");
        let state = CliBridgeState::default();
        let executable_id = register_test_executable(&state, &executable);
        let result = probe_with_state(
            &state,
            CliProbeRequest {
                executable_id,
                args: vec![
                    "--ignored".to_string(),
                    "--exact".to_string(),
                    "cli_bridge::tests::cli_bridge_probe_timeout_helper".to_string(),
                ],
                timeout_ms: 100,
                output_limit_bytes: 1_024,
            },
        )
        .expect("timeout should be a structured probe result");

        assert!(result.timed_out);
    }

    #[test]
    fn cli_bridge_probe_bounds_stdout_and_stderr_independently() {
        let executable = std::env::current_exe().expect("current test executable");
        let state = CliBridgeState::default();
        let executable_id = register_test_executable(&state, &executable);
        let result = probe_with_state(
            &state,
            CliProbeRequest {
                executable_id,
                args: vec![
                    "--ignored".to_string(),
                    "--exact".to_string(),
                    "cli_bridge::tests::cli_bridge_probe_large_output_helper".to_string(),
                    "--nocapture".to_string(),
                ],
                timeout_ms: 10_000,
                output_limit_bytes: 1_024,
            },
        )
        .expect("large output probe");

        assert!(result.stdout.truncated);
        assert!(result.stderr.truncated);
        assert!(result.stdout.data.len() <= 1_024);
        assert!(result.stderr.data.len() <= 1_024);
    }

    #[test]
    fn cli_bridge_state_rejects_duplicates_and_cleans_every_terminal_path() {
        let state = CliBridgeState::default();
        let (cancel, completion_guard) = state.register("complete").unwrap();
        assert!(!cancel.load(Ordering::Acquire));
        assert!(state.register("complete").is_err());
        assert!(state.contains("complete"));
        drop(completion_guard);
        assert!(!state.contains("complete"));

        let (cancel, cancellation_guard) = state.register("cancel").unwrap();
        assert!(state.request_cancel("cancel").unwrap());
        assert!(cancel.load(Ordering::Acquire));
        assert!(state.contains("cancel"));
        drop(cancellation_guard);
        assert!(!state.contains("cancel"));

        let simulated_error = (|| -> Result<(), String> {
            let (_cancel, _error_guard) = state.register("error")?;
            Err("simulated spawn error".to_string())
        })();
        assert!(simulated_error.is_err());
        assert!(!state.contains("error"));
    }

    #[test]
    fn cli_bridge_state_drop_cancels_all_active_requests() {
        let state = CliBridgeState::default();
        let (first, _first_guard) = state.register("first").unwrap();
        let (second, _second_guard) = state.register("second").unwrap();

        drop(state);

        assert!(first.load(Ordering::Acquire));
        assert!(second.load(Ordering::Acquire));
    }

    #[test]
    fn cli_bridge_child_cleanup_guard_kills_and_waits_on_drop() {
        let marker = fixture_path("cleanup-marker");
        let executable = std::env::current_exe().expect("current test executable");
        let mut command = Command::new(executable);
        command
            .args([
                "--ignored",
                "--exact",
                "cli_bridge::tests::cli_bridge_cleanup_marker_helper",
                "--nocapture",
            ])
            .env("VIBESPACE_CLI_BRIDGE_CLEANUP_MARKER", &marker)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        drop(spawn_contained_process(&mut command).unwrap());
        std::thread::sleep(Duration::from_millis(900));

        assert!(!marker.exists(), "child survived cleanup guard drop");
    }

    #[cfg(windows)]
    #[test]
    fn cli_bridge_cleanup_guard_kills_descendants_before_reaping_parent() {
        let ready = fixture_path("cleanup-tree-ready");
        let marker = fixture_path("cleanup-tree-marker");
        let executable = std::env::current_exe().expect("current test executable");
        let mut command = Command::new(executable);
        command
            .args([
                "--ignored",
                "--exact",
                "cli_bridge::tests::cli_bridge_cleanup_tree_parent_helper",
                "--nocapture",
            ])
            .env("VIBESPACE_CLI_BRIDGE_TREE_READY", &ready)
            .env("VIBESPACE_CLI_BRIDGE_TREE_MARKER", &marker)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        configure_process(&mut command);
        let guard = spawn_contained_process(&mut command).unwrap();

        let ready_deadline = Instant::now() + Duration::from_secs(5);
        while !ready.exists() && Instant::now() < ready_deadline {
            std::thread::sleep(Duration::from_millis(10));
        }
        assert!(
            ready.exists(),
            "provider parent did not spawn its grandchild"
        );

        let cleanup_started = Instant::now();
        drop(guard);
        assert!(
            cleanup_started.elapsed() < Duration::from_secs(3),
            "cleanup guard did not reap the provider parent promptly"
        );
        std::thread::sleep(Duration::from_millis(1_200));

        assert!(
            !marker.exists(),
            "provider grandchild survived cleanup guard drop"
        );
        let _ = fs::remove_file(ready);
    }

    #[test]
    fn cli_bridge_supervisor_observes_cancellation_and_kills_child() {
        let executable = std::env::current_exe().expect("current test executable");
        let state = CliBridgeState::default();
        let executable_id = register_test_executable(&state, &executable);
        let prepared = prepare_start_request(
            &state,
            CliStartRequest {
                request_id: "cancel-process".to_string(),
                executable_id,
                args: vec![
                    "--ignored".to_string(),
                    "--exact".to_string(),
                    "cli_bridge::tests::cli_bridge_probe_timeout_helper".to_string(),
                ],
                cwd: None,
                stdin: None,
                timeout_ms: 10_000,
                output_limit_bytes: 1_024,
                tool_scope: None,
            },
        )
        .unwrap();
        let cancel = Arc::new(AtomicBool::new(true));

        let result = run_supervised_process(prepared, cancel, || {}, |_, _| {}).unwrap();

        assert_eq!(result.terminal, ProcessTerminal::Cancelled);
    }

    #[test]
    fn cli_bridge_supervisor_streams_redacted_jsonl_before_completion() {
        let executable = std::env::current_exe().expect("current test executable");
        let state = CliBridgeState::default();
        let executable_id = register_test_executable(&state, &executable);
        let prepared = prepare_start_request(
            &state,
            CliStartRequest {
                request_id: "stream-process".to_string(),
                executable_id,
                args: vec![
                    "--ignored".to_string(),
                    "--exact".to_string(),
                    "cli_bridge::tests::cli_bridge_streaming_output_helper".to_string(),
                    "--nocapture".to_string(),
                ],
                cwd: None,
                stdin: None,
                timeout_ms: 10_000,
                output_limit_bytes: 4_096,
                tool_scope: None,
            },
        )
        .unwrap();
        let started = Instant::now();
        let mut first_data_at = None;
        let mut chunks = Vec::new();

        let result = run_supervised_process(
            prepared,
            Arc::new(AtomicBool::new(false)),
            || {},
            |stream, output| {
                if stream == CliEventStream::Stdout && !output.data.is_empty() {
                    first_data_at.get_or_insert_with(|| started.elapsed());
                    chunks.push(output.data);
                }
            },
        )
        .unwrap();
        let completed_at = started.elapsed();

        assert_eq!(result.terminal, ProcessTerminal::Completed);
        let first_data_at = first_data_at.expect("first JSONL line should be streamed");
        assert!(
            completed_at.saturating_sub(first_data_at) >= Duration::from_millis(400),
            "first data arrived only at completion: first={first_data_at:?} completed={completed_at:?}"
        );
        let output = chunks.concat();
        assert!(output.contains("first"));
        assert!(output.contains("terminal"));
        assert!(!output.contains("stream-secret"));
    }

    #[test]
    fn cli_bridge_streaming_sanitizer_carries_secret_and_osc_state_across_lines() {
        let executable = std::env::current_exe().expect("current test executable");
        let state = CliBridgeState::default();
        let executable_id = register_test_executable(&state, &executable);
        let prepared = prepare_start_request(
            &state,
            CliStartRequest {
                request_id: "stateful-stream".to_string(),
                executable_id,
                args: vec![
                    "--ignored".to_string(),
                    "--exact".to_string(),
                    "cli_bridge::tests::cli_bridge_cross_line_sanitizer_helper".to_string(),
                    "--nocapture".to_string(),
                ],
                cwd: None,
                stdin: None,
                timeout_ms: 10_000,
                output_limit_bytes: 8_192,
                tool_scope: None,
            },
        )
        .unwrap();
        let started = Instant::now();
        let mut safe_data_at = None;
        let mut chunks = Vec::new();

        let result = run_supervised_process(
            prepared,
            Arc::new(AtomicBool::new(false)),
            || {},
            |stream, output| {
                if stream == CliEventStream::Stdout && !output.data.is_empty() {
                    if output.data.contains("safe-jsonl") {
                        safe_data_at.get_or_insert_with(|| started.elapsed());
                    }
                    chunks.push(output.data);
                }
            },
        )
        .unwrap();
        let completed_at = started.elapsed();
        let output = chunks.concat();

        assert_eq!(result.terminal, ProcessTerminal::Completed);
        let safe_data_at = safe_data_at.expect("later safe JSONL should still stream");
        assert!(
            completed_at.saturating_sub(safe_data_at) >= Duration::from_millis(400),
            "safe data arrived only at completion: safe={safe_data_at:?} completed={completed_at:?}"
        );
        for forbidden in ["plain-secret", "private", "payload", "\x1b", "\x07"] {
            assert!(
                !output.contains(forbidden),
                "cross-line sanitizer leaked {forbidden:?}: {output:?}"
            );
        }
        assert!(output.contains("safe-jsonl"));
        assert!(output.contains("terminal"));
    }

    #[test]
    fn cli_bridge_started_callback_runs_only_after_successful_spawn() {
        let prepared = PreparedStartRequest {
            executable_path: fixture_path("missing-started.exe"),
            args: Vec::new(),
            cwd: None,
            stdin: None,
            timeout_ms: 1_000,
            output_limit_bytes: 1_024,
            tool_scope: false,
            secret_environment: None,
        };
        let mut started_count = 0;

        let result = run_supervised_process(
            prepared,
            Arc::new(AtomicBool::new(false)),
            || started_count += 1,
            |_, _| {},
        );

        assert!(result.is_err());
        assert_eq!(started_count, 0);
    }

    #[test]
    fn cli_bridge_event_serializes_camel_case_status_and_fields() {
        let event = CliBridgeEvent {
            request_id: "request-1".to_string(),
            stream: CliEventStream::Status,
            data: String::new(),
            exit_code: None,
            status: CliEventStatus::TimedOut,
            truncated: Some(false),
        };

        let value = serde_json::to_value(event).unwrap();
        assert_eq!(value["requestId"], "request-1");
        assert_eq!(value["stream"], "status");
        assert_eq!(value["status"], "timedOut");
        assert_eq!(value["truncated"], false);
    }

    #[test]
    fn cli_bridge_all_commands_and_state_are_registered() {
        let source = include_str!("lib.rs");
        assert!(source.contains(".manage(cli_bridge::CliBridgeState::default())"));
        for command in [
            "cli_bridge::cli_bridge_scan",
            "cli_bridge::cli_bridge_probe",
            "cli_bridge::cli_bridge_start",
            "cli_bridge::cli_bridge_cancel",
        ] {
            assert!(
                source.contains(command),
                "missing registration for {command}"
            );
        }
    }

    #[test]
    #[ignore = "spawned only by cli_bridge_probe_enforces_timeout"]
    fn cli_bridge_probe_timeout_helper() {
        std::thread::sleep(std::time::Duration::from_secs(2));
    }

    #[test]
    #[ignore = "spawned only by cli_bridge_probe_bounds_stdout_and_stderr_independently"]
    fn cli_bridge_probe_large_output_helper() {
        println!("{}", "x".repeat(2_048));
        eprintln!("{}", "y".repeat(2_048));
    }

    #[test]
    #[ignore = "spawned only by cli_bridge_supervisor_streams_redacted_jsonl_before_completion"]
    fn cli_bridge_streaming_output_helper() {
        use std::io::Write as _;

        println!(r#"{{"phase":"first","token":"stream-secret"}}"#);
        std::io::stdout().flush().unwrap();
        std::thread::sleep(Duration::from_millis(700));
        println!(r#"{{"phase":"terminal"}}"#);
        std::io::stdout().flush().unwrap();
    }

    #[test]
    #[ignore = "spawned only by cli_bridge_streaming_sanitizer_carries_secret_and_osc_state_across_lines"]
    fn cli_bridge_cross_line_sanitizer_helper() {
        use std::io::Write as _;

        let stdout = std::io::stdout();
        let mut stdout = stdout.lock();
        stdout.write_all(b"{\"token\":\n").unwrap();
        stdout.write_all(b"\"plain-secret\"\n").unwrap();
        stdout.write_all(b"\x1b]0;private\n").unwrap();
        stdout.write_all(b"payload\x07\n").unwrap();
        stdout.write_all(b"{\"phase\":\"safe-jsonl\"}\n").unwrap();
        stdout.flush().unwrap();
        std::thread::sleep(Duration::from_millis(700));
        stdout.write_all(b"{\"phase\":\"terminal\"}\n").unwrap();
        stdout.flush().unwrap();
    }

    #[test]
    #[ignore = "spawned only by cli_bridge_child_cleanup_guard_kills_and_waits_on_drop"]
    fn cli_bridge_cleanup_marker_helper() {
        std::thread::sleep(Duration::from_millis(700));
        let marker = std::env::var_os("VIBESPACE_CLI_BRIDGE_CLEANUP_MARKER").unwrap();
        fs::write(marker, b"child survived").unwrap();
    }

    #[cfg(windows)]
    #[test]
    #[ignore = "spawned only by cli_bridge_cleanup_guard_kills_descendants_before_reaping_parent"]
    fn cli_bridge_cleanup_tree_parent_helper() {
        let executable = std::env::current_exe().expect("current test executable");
        let marker = std::env::var_os("VIBESPACE_CLI_BRIDGE_TREE_MARKER").unwrap();
        let ready = std::env::var_os("VIBESPACE_CLI_BRIDGE_TREE_READY").unwrap();
        let mut command = Command::new(executable);
        command
            .args([
                "--ignored",
                "--exact",
                "cli_bridge::tests::cli_bridge_cleanup_tree_grandchild_helper",
                "--nocapture",
            ])
            .env("VIBESPACE_CLI_BRIDGE_TREE_MARKER", marker)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        configure_process(&mut command);
        let mut grandchild = command.spawn().unwrap();
        fs::write(ready, b"grandchild spawned").unwrap();
        let _ = grandchild.wait();
    }

    #[cfg(windows)]
    #[test]
    #[ignore = "spawned only by cli_bridge_cleanup_tree_parent_helper"]
    fn cli_bridge_cleanup_tree_grandchild_helper() {
        std::thread::sleep(Duration::from_millis(700));
        let marker = std::env::var_os("VIBESPACE_CLI_BRIDGE_TREE_MARKER").unwrap();
        fs::write(marker, b"grandchild survived").unwrap();
    }
}
