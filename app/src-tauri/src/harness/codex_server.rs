use crate::activity_diagnostics_store::{
    append_codex_start_stderr_diagnostic_at, CodexStderrCategory,
};
use crate::cli_bridge::CliBridgeState;
use crate::harness::managed_codex_app_server::{
    codex_app_server_handshake, CodexAppServerFrameDecoder, CODEX_APP_SERVER_MAX_FRAME_BYTES,
};
use crate::harness::managed_codex_proxy_runtime::{
    materialize_isolated_profile, seal_reviewed_opencodex_runtime, SealedReviewedOpenCodexRuntime,
};
use crate::harness::managed_codex_route::{revalidate_translation_route, ManagedCodexRouteState};
#[path = "managed_codex_connected_provider.rs"]
pub(super) mod connected_provider;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::VecDeque;
use std::io::{BufReader, Read, Write};
use std::net::{Ipv4Addr, TcpListener};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, Webview};

const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(60);
const READER_CHANNEL_CAPACITY: usize = 256;
const READER_CHUNK_BYTES: usize = 64 * 1024;
// OpenCodex 2.36 permits three sequential 30s Windows ACL checks at startup.
// Native diagnosis reached identity-checked readiness at 90.7s; a 75s outer
// deadline killed that healthy launch. Leave room for CLI loading and sync,
// while retaining the reviewed CLI's readiness contract and a hard deadline.
const OPENCODEX_READY_TIMEOUT: Duration = Duration::from_secs(180);

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum CodexNativeRouteKind {
    OfficialCodex,
    #[serde(rename = "opencodex-translation")]
    OpenCodexTranslation,
    DirectResponses,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CodexAppServerStartRequest {
    executable_id: String,
    owner_id: String,
    model_id: String,
    connection_id: String,
    route_kind: CodexNativeRouteKind,
    account_id: Option<String>,
    route_handle: Option<String>,
    configuration_generation: Option<String>,
}

impl CodexAppServerStartRequest {
    fn route_identity(&self) -> String {
        match self.route_kind {
            CodexNativeRouteKind::OfficialCodex => format!("official:{}", self.connection_id),
            CodexNativeRouteKind::OpenCodexTranslation => format!(
                "translation:{}:{}:{}",
                self.connection_id,
                self.route_handle.as_deref().unwrap_or("missing"),
                self.configuration_generation
                    .as_deref()
                    .unwrap_or("missing")
            ),
            CodexNativeRouteKind::DirectResponses => format!("direct:{}", self.connection_id),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexAppServerStartResponse {
    generation: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum CodexAppServerStreamMessage {
    Frame {
        frame: Value,
        sequence: u64,
        #[serde(rename = "nativeHandoffWallUs")]
        native_handoff_wall_us: u64,
        #[serde(rename = "nativeHandoffMonotonicUs")]
        native_handoff_monotonic_us: u64,
    },
    Done,
    Error {
        message: &'static str,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct CodexLaunchRequest {
    executable: PathBuf,
    arguments: [String; 4],
}

fn valid_identifier(value: &str, maximum_bytes: usize) -> bool {
    let mut bytes = value.bytes();
    matches!(bytes.next(), Some(first) if first.is_ascii_alphanumeric())
        && value.len() <= maximum_bytes
        && bytes.all(|byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'@' | b'/' | b'-')
        })
}

fn caller_allowed(label: &str) -> bool {
    matches!(label, "main" | "workbench-main")
}

fn validate_start_request(
    caller_label: &str,
    request: &CodexAppServerStartRequest,
) -> Result<(), String> {
    if !caller_allowed(caller_label) {
        return Err("Codex app-server caller is not authorized.".to_string());
    }
    if !valid_identifier(&request.executable_id, 256) {
        return Err("Codex executable identity is invalid.".to_string());
    }
    if !valid_identifier(&request.owner_id, 256) {
        return Err("Codex owner identity is invalid.".to_string());
    }
    if !valid_identifier(&request.model_id, 256) {
        return Err("Codex model identity is invalid.".to_string());
    }
    if !valid_identifier(&request.connection_id, 256) {
        return Err("Codex connection identity is invalid.".to_string());
    }
    match request.route_kind {
        CodexNativeRouteKind::OfficialCodex => {
            if request.connection_id != "openai-codex"
                || request.account_id.is_some()
                || request.route_handle.is_some()
                || request.configuration_generation.is_some()
            {
                return Err("Official Codex route metadata is invalid.".to_string());
            }
        }
        CodexNativeRouteKind::OpenCodexTranslation => {
            let valid = request.connection_id != "openai-codex"
                && request
                    .account_id
                    .as_deref()
                    .is_some_and(|value| valid_identifier(value, 256))
                && request
                    .route_handle
                    .as_deref()
                    .is_some_and(|value| valid_identifier(value, 256))
                && request
                    .configuration_generation
                    .as_deref()
                    .is_some_and(|value| valid_identifier(value, 256));
            if !valid {
                return Err("Codex translation route metadata is invalid.".to_string());
            }
        }
        CodexNativeRouteKind::DirectResponses => {
            return Err(
                "Codex direct Responses route is not yet semantically verified.".to_string(),
            );
        }
    }
    Ok(())
}

fn is_codex_executable(executable: &std::path::Path) -> bool {
    let name = executable
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    matches!(
        name.as_str(),
        "codex" | "codex.exe" | "codex-x86_64-pc-windows-msvc.exe"
    )
}

fn resolve_launch_request<F>(executable_id: &str, resolver: F) -> Result<CodexLaunchRequest, String>
where
    F: FnOnce(&str) -> Result<PathBuf, String>,
{
    if !valid_identifier(executable_id, 256) {
        return Err("Codex executable identity is invalid.".to_string());
    }
    let executable = resolver(executable_id)?;
    if !executable.is_absolute() || !is_codex_executable(&executable) {
        return Err("Codex app-server requires a trusted Codex executable.".to_string());
    }
    Ok(CodexLaunchRequest {
        executable,
        arguments: [
            "--enable".to_string(),
            "default_mode_request_user_input".to_string(),
            "app-server".to_string(),
            "--stdio".to_string(),
        ],
    })
}

fn encode_outbound_frame(message: &Value) -> Result<Vec<u8>, String> {
    if !message.is_object() {
        return Err("Codex app-server message must be a JSON object.".to_string());
    }
    let mut bytes = serde_json::to_vec(message)
        .map_err(|_| "Codex app-server message could not be encoded.".to_string())?;
    if bytes.is_empty() || bytes.len() > CODEX_APP_SERVER_MAX_FRAME_BYTES {
        return Err("Codex app-server message exceeded its safe bound.".to_string());
    }
    bytes.push(b'\n');
    Ok(bytes)
}

struct HandshakeOutcome {
    buffered_frames: Vec<Value>,
    decoder: CodexAppServerFrameDecoder,
}

fn perform_start_handshake<R: Read, W: Write>(
    reader: &mut R,
    writer: &mut W,
    client_version: &str,
) -> Result<HandshakeOutcome, String> {
    let handshake = codex_app_server_handshake(1, client_version)
        .map_err(|_| "Codex app-server handshake could not be created.".to_string())?;
    writer
        .write_all(&handshake.initialize)
        .and_then(|_| writer.flush())
        .map_err(|_| "Codex app-server initialize request could not be written.".to_string())?;

    let mut decoder = CodexAppServerFrameDecoder::default();
    let mut buffered_frames = Vec::new();
    let mut chunk = [0_u8; READER_CHUNK_BYTES];
    let initialized = loop {
        let count = reader
            .read(&mut chunk)
            .map_err(|_| "Codex app-server initialize response could not be read.".to_string())?;
        if count == 0 {
            break false;
        }
        let frames = decoder
            .push(&chunk[..count])
            .map_err(|_| "Codex app-server initialize response was invalid.".to_string())?;
        let mut matched = false;
        for frame in frames {
            if frame.get("id").and_then(Value::as_u64) == Some(1) {
                if frame.get("error").is_some()
                    || !frame.get("result").is_some_and(Value::is_object)
                {
                    return Err("Codex app-server rejected initialization.".to_string());
                }
                matched = true;
            } else {
                buffered_frames.push(frame);
            }
        }
        if matched {
            break true;
        }
    };
    if !initialized {
        return Err("Codex app-server ended before initialization.".to_string());
    }
    writer
        .write_all(&handshake.initialized)
        .and_then(|_| writer.flush())
        .map_err(|_| {
            "Codex app-server initialized notification could not be written.".to_string()
        })?;
    Ok(HandshakeOutcome {
        buffered_frames,
        decoder,
    })
}

trait OwnedCodexProcess: Send {
    fn has_exited(&mut self) -> Result<bool, String>;
    fn terminate(&mut self) -> Result<(), String>;
}

struct ProductionProcess {
    child: Arc<Mutex<Child>>,
    terminated: bool,
}

impl OwnedCodexProcess for ProductionProcess {
    fn has_exited(&mut self) -> Result<bool, String> {
        self.child
            .lock()
            .map_err(|_| "Codex app-server process state is unavailable.".to_string())?
            .try_wait()
            .map(|status| status.is_some())
            .map_err(|_| "Codex app-server process status could not be read.".to_string())
    }

    fn terminate(&mut self) -> Result<(), String> {
        if self.terminated {
            return Ok(());
        }
        let mut child = self
            .child
            .lock()
            .map_err(|_| "Codex app-server process state is unavailable.".to_string())?;
        if child
            .try_wait()
            .map_err(|_| "Codex app-server process status could not be read.".to_string())?
            .is_none()
        {
            child
                .kill()
                .map_err(|_| "Codex app-server process could not be terminated.".to_string())?;
        }
        child
            .wait()
            .map_err(|_| "Codex app-server process could not be reaped.".to_string())?;
        self.terminated = true;
        Ok(())
    }
}

struct OwnedProcessGuard {
    process: Box<dyn OwnedCodexProcess>,
    stopped: bool,
    lifetime_guards: Vec<Box<dyn Send>>,
}

impl OwnedProcessGuard {
    fn new(process: Box<dyn OwnedCodexProcess>) -> Self {
        Self {
            process,
            stopped: false,
            lifetime_guards: Vec::new(),
        }
    }

    fn hold_for_lifetime(&mut self, guard: Box<dyn Send>) {
        self.lifetime_guards.push(guard);
    }

    fn has_exited(&mut self) -> Result<bool, String> {
        self.process.has_exited()
    }

    fn stop(&mut self) -> Result<(), String> {
        if self.stopped {
            return Ok(());
        }
        self.process.terminate()?;
        self.stopped = true;
        self.lifetime_guards.clear();
        Ok(())
    }

    fn terminate_fail_closed(&mut self) {
        for _ in 0..SHUTDOWN_STOP_ATTEMPTS {
            if self.stop().is_ok() {
                return;
            }
        }
        // The production proxy always owns a kill-on-close Job guard. If direct termination keeps
        // failing, dropping that guard terminates the complete tree while ownership remains for a
        // later reap attempt.
        self.lifetime_guards.clear();
        // Job close is synchronous for termination, and this final stop observes/reaps that exit.
        let _ = self.stop();
    }
}

impl Drop for OwnedProcessGuard {
    fn drop(&mut self) {
        let _ = self.stop();
    }
}

struct LaunchProxyLifecycle<R> {
    process: Option<OwnedProcessGuard>,
    runtime: Option<R>,
}

impl<R> LaunchProxyLifecycle<R> {
    fn new(process: OwnedProcessGuard, runtime: R) -> Self {
        Self {
            process: Some(process),
            runtime: Some(runtime),
        }
    }

    fn into_parts(mut self) -> (OwnedProcessGuard, R) {
        let process = self.process.take().expect("launch proxy process");
        let runtime = self.runtime.take().expect("launch proxy runtime");
        (process, runtime)
    }
}

impl<R> Drop for LaunchProxyLifecycle<R> {
    fn drop(&mut self) {
        if let Some(mut process) = self.process.take() {
            process.terminate_fail_closed();
            drop(process);
        }
        // Runtime seal/DACL/file handles are deliberately released only after process cleanup.
        self.runtime.take();
    }
}

enum ReaderMessage {
    Frame(Value),
    Done,
    Error,
}

struct ActiveStream {
    stream_id: String,
    caller_label: String,
    cancelled: Arc<AtomicBool>,
    task: Option<thread::JoinHandle<()>>,
}

pub struct RunningCodexServer {
    executable_id: String,
    rlm_executable_sha256: String,
    rlm_profile_generation: String,
    rlm_observation: Arc<Mutex<RlmParentObservation>>,
    model_id: String,
    caller_label: String,
    owner_id: String,
    route_identity: String,
    generation: String,
    stdin: Option<Arc<Mutex<ChildStdin>>>,
    receiver: Option<mpsc::Receiver<ReaderMessage>>,
    buffered_frames: VecDeque<Value>,
    reader_task: Option<thread::JoinHandle<()>>,
    stderr_task: Option<thread::JoinHandle<CodexStderrCategory>>,
    active_stream: Option<ActiveStream>,
    process: OwnedProcessGuard,
    proxy_process: Option<OwnedProcessGuard>,
    proxy_runtime: Option<SealedReviewedOpenCodexRuntime>,
    stopped: bool,
}

impl RunningCodexServer {
    #[cfg(test)]
    fn new_for_test(
        executable_id: &str,
        caller_label: &str,
        owner_id: &str,
        generation: &str,
        process: Box<dyn OwnedCodexProcess>,
    ) -> Self {
        Self {
            executable_id: executable_id.to_string(),
            rlm_executable_sha256: String::new(),
            rlm_profile_generation: rlm_profile_generation(),
            rlm_observation: Arc::new(Mutex::new(RlmParentObservation::default())),
            model_id: "opencode-go/deepseek-v4-flash-vision-exp".to_string(),
            caller_label: caller_label.to_string(),
            owner_id: owner_id.to_string(),
            route_identity: "official:openai-codex".to_string(),
            generation: generation.to_string(),
            stdin: None,
            receiver: None,
            buffered_frames: VecDeque::new(),
            reader_task: None,
            stderr_task: None,
            active_stream: None,
            process: OwnedProcessGuard::new(process),
            proxy_process: None,
            proxy_runtime: None,
            stopped: false,
        }
    }

    fn has_exited_or_lost_integrity(&mut self) -> Result<bool, String> {
        if self
            .proxy_runtime
            .as_ref()
            .is_some_and(|runtime| runtime.revalidate().is_err())
        {
            if let Some(proxy) = self.proxy_process.as_mut() {
                proxy.terminate_fail_closed();
            }
            return Err("OpenCodex managed runtime integrity was lost.".to_string());
        }
        if self.process.has_exited()? {
            return Ok(true);
        }
        self.proxy_process
            .as_mut()
            .map_or(Ok(false), OwnedProcessGuard::has_exited)
    }

    fn stop_owned(&mut self) -> Result<(), String> {
        if self.stopped {
            return Ok(());
        }
        if let Some(active) = self.active_stream.as_mut() {
            active.cancelled.store(true, Ordering::Release);
            active.task.take();
        }
        self.active_stream = None;
        self.receiver.take();
        self.stdin.take();
        let process_result = self.process.stop();
        let proxy_result = self
            .proxy_process
            .as_mut()
            .map(OwnedProcessGuard::stop)
            .unwrap_or(Ok(()));
        if proxy_result.is_ok() {
            self.proxy_process = None;
        }
        self.reader_task.take();
        self.stderr_task.take();
        match (process_result, proxy_result) {
            (Ok(()), Ok(())) => {
                self.stopped = true;
                Ok(())
            }
            (Err(error), Ok(())) | (Ok(()), Err(error)) => Err(error),
            (Err(_), Err(_)) => {
                Err("Codex app-server and proxy processes could not be terminated.".to_string())
            }
        }
    }
}

impl Drop for RunningCodexServer {
    fn drop(&mut self) {
        let _ = self.stop_owned();
    }
}

#[derive(Default)]
struct ControllerInner {
    running: Option<RunningCodexServer>,
}

#[derive(Default)]
pub struct CodexAppServerState {
    inner: Mutex<ControllerInner>,
}

fn stop_running(
    running: &mut Option<RunningCodexServer>,
    caller_label: &str,
    generation: &str,
) -> Result<bool, String> {
    let Some(current) = running.as_ref() else {
        return Ok(false);
    };
    if current.caller_label != caller_label || current.generation != generation {
        return Ok(false);
    }
    stop_owned_running(running)
}

fn stop_owned_running(running: &mut Option<RunningCodexServer>) -> Result<bool, String> {
    let Some(current) = running.as_mut() else {
        return Ok(false);
    };
    current.stop_owned()?;
    running.take();
    Ok(true)
}

fn retire_exited_running(running: &mut Option<RunningCodexServer>) -> Result<bool, String> {
    stop_owned_running(running)
}

fn shutdown_running(running: &mut Option<RunningCodexServer>) -> Result<bool, String> {
    stop_owned_running(running)
}

const SHUTDOWN_STOP_ATTEMPTS: usize = 3;

fn shutdown_owned_state(state: &CodexAppServerState) {
    let Ok(mut inner) = state.inner.lock() else {
        return;
    };
    for _ in 0..SHUTDOWN_STOP_ATTEMPTS {
        match shutdown_running(&mut inner.running) {
            Ok(_) => return,
            Err(_) if inner.running.is_some() => continue,
            Err(_) => return,
        }
    }
}

fn spawn_stdout_reader<R: Read + Send + 'static>(
    mut reader: R,
    mut decoder: CodexAppServerFrameDecoder,
    sender: mpsc::SyncSender<ReaderMessage>,
) -> thread::JoinHandle<()> {
    thread::spawn(move || {
        let mut chunk = [0_u8; READER_CHUNK_BYTES];
        loop {
            let count = match reader.read(&mut chunk) {
                Ok(count) => count,
                Err(_) => {
                    let _ = sender.send(ReaderMessage::Error);
                    return;
                }
            };
            if count == 0 {
                let terminal = if decoder.finish().is_ok() {
                    ReaderMessage::Done
                } else {
                    ReaderMessage::Error
                };
                let _ = sender.send(terminal);
                return;
            }
            let frames = match decoder.push(&chunk[..count]) {
                Ok(frames) => frames,
                Err(_) => {
                    let _ = sender.send(ReaderMessage::Error);
                    return;
                }
            };
            for frame in frames {
                if sender.send(ReaderMessage::Frame(frame)).is_err() {
                    return;
                }
            }
        }
    })
}

#[derive(Debug, Default)]
struct CodexStderrSummary {
    saw_bytes: bool,
    category: Option<CodexStderrCategory>,
}

impl CodexStderrSummary {
    fn observe(&mut self, chunk: &[u8]) {
        if chunk.is_empty() {
            return;
        }
        self.saw_bytes = true;
        let contains_any = |patterns: &[&[u8]]| {
            patterns.iter().any(|pattern| {
                chunk
                    .windows(pattern.len())
                    .any(|window| window.eq_ignore_ascii_case(pattern))
            })
        };
        let detected = if contains_any(&[b"authentication", b"unauthorized", b"login required"]) {
            CodexStderrCategory::Authentication
        } else if contains_any(&[b"rate limit", b"usage limit", b"quota exceeded"]) {
            CodexStderrCategory::RateLimit
        } else if contains_any(&[b"network", b"connection refused", b"dns", b"timed out"]) {
            CodexStderrCategory::Network
        } else if contains_any(&[b"permission denied", b"access denied"]) {
            CodexStderrCategory::Permission
        } else if contains_any(&[b"configuration", b"config.toml", b"config error"]) {
            CodexStderrCategory::Configuration
        } else {
            CodexStderrCategory::Other
        };
        let priority = |category: CodexStderrCategory| match category {
            CodexStderrCategory::Authentication => 6,
            CodexStderrCategory::RateLimit => 5,
            CodexStderrCategory::Network => 4,
            CodexStderrCategory::Permission => 3,
            CodexStderrCategory::Configuration => 2,
            CodexStderrCategory::Other => 1,
            CodexStderrCategory::Unavailable => 0,
            CodexStderrCategory::Empty => 0,
        };
        if self
            .category
            .is_none_or(|current| priority(detected) > priority(current))
        {
            self.category = Some(detected);
        }
    }

    fn category(&self) -> CodexStderrCategory {
        if !self.saw_bytes {
            CodexStderrCategory::Empty
        } else {
            self.category.unwrap_or(CodexStderrCategory::Other)
        }
    }
}

fn spawn_stderr_drain<R: Read + Send + 'static>(
    mut stderr: R,
) -> thread::JoinHandle<CodexStderrCategory> {
    thread::spawn(move || {
        let mut chunk = [0_u8; 8 * 1024];
        let mut summary = CodexStderrSummary::default();
        loop {
            match stderr.read(&mut chunk) {
                Ok(0) => return summary.category(),
                Err(_) => {
                    return if summary.saw_bytes {
                        summary.category()
                    } else {
                        CodexStderrCategory::Unavailable
                    }
                }
                Ok(bytes) => summary.observe(&chunk[..bytes]),
            }
        }
    })
}

fn remember_stderr_failure_category(
    target: &Arc<Mutex<Option<CodexStderrCategory>>>,
    category: CodexStderrCategory,
) {
    if let Ok(mut captured) = target.lock() {
        *captured = Some(category);
    }
}

fn launch_server(
    launch: CodexLaunchRequest,
    executable_id: String,
    model_id: String,
    caller_label: String,
    owner_id: String,
    route_identity: String,
    stderr_failure_category: Arc<Mutex<Option<CodexStderrCategory>>>,
    proxy: Option<(OwnedProcessGuard, PathBuf, SealedReviewedOpenCodexRuntime)>,
) -> Result<RunningCodexServer, String> {
    let (proxy, codex_home) = match proxy {
        Some((process, home, runtime)) => (
            Some(LaunchProxyLifecycle::new(process, runtime)),
            Some(home),
        ),
        None => (None, None),
    };
    let mut command = Command::new(&launch.executable);
    command
        .args(&launch.arguments)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    command.env("NO_COLOR", "1");
    if let Some(home) = codex_home {
        command.env("CODEX_HOME", home);
    }
    // Direct OpenAI models use the existing Codex login and home. No credentials
    // are copied and no OpenCode proxy is started for a Codex subscription.

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = command.spawn().map_err(|_| {
        remember_stderr_failure_category(
            &stderr_failure_category,
            CodexStderrCategory::Unavailable,
        );
        "Codex app-server process could not be started.".to_string()
    })?;
    let mut stdin = match child.stdin.take() {
        Some(stdin) => stdin,
        None => {
            remember_stderr_failure_category(
                &stderr_failure_category,
                CodexStderrCategory::Unavailable,
            );
            let _ = child.kill();
            let _ = child.wait();
            return Err("Codex app-server stdin is unavailable.".to_string());
        }
    };
    let stdout = match child.stdout.take() {
        Some(stdout) => stdout,
        None => {
            remember_stderr_failure_category(
                &stderr_failure_category,
                CodexStderrCategory::Unavailable,
            );
            let _ = child.kill();
            let _ = child.wait();
            return Err("Codex app-server stdout is unavailable.".to_string());
        }
    };
    let stderr = match child.stderr.take() {
        Some(stderr) => stderr,
        None => {
            remember_stderr_failure_category(
                &stderr_failure_category,
                CodexStderrCategory::Unavailable,
            );
            let _ = child.kill();
            let _ = child.wait();
            return Err("Codex app-server stderr is unavailable.".to_string());
        }
    };

    let child = Arc::new(Mutex::new(child));
    let mut process = OwnedProcessGuard::new(Box::new(ProductionProcess {
        child: child.clone(),
        terminated: false,
    }));
    let stderr_task = spawn_stderr_drain(stderr);
    let (watchdog_cancel, watchdog_receiver) = mpsc::sync_channel(1);
    let watchdog_child = child.clone();
    let watchdog = thread::spawn(move || {
        if watchdog_receiver.recv_timeout(HANDSHAKE_TIMEOUT).is_err() {
            if let Ok(mut child) = watchdog_child.lock() {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
    });
    let mut reader = BufReader::new(stdout);
    let handshake = perform_start_handshake(&mut reader, &mut stdin, env!("CARGO_PKG_VERSION"));
    let _ = watchdog_cancel.send(());
    let _ = watchdog.join();
    let handshake = match handshake {
        Ok(handshake) => handshake,
        Err(error) => {
            let _ = process.stop();
            let stderr_category = stderr_task.join().unwrap_or(CodexStderrCategory::Other);
            remember_stderr_failure_category(&stderr_failure_category, stderr_category);
            return Err(error);
        }
    };

    let (sender, receiver) = mpsc::sync_channel(READER_CHANNEL_CAPACITY);
    let reader_task = spawn_stdout_reader(reader, handshake.decoder, sender);
    let (proxy_process, proxy_runtime) = proxy
        .map(|proxy| {
            let (process, runtime) = proxy.into_parts();
            (Some(process), Some(runtime))
        })
        .unwrap_or((None, None));
    use sha2::{Digest, Sha256};
    let rlm_executable_sha256 = format!("{:x}",Sha256::digest(std::fs::read(&launch.executable).map_err(|_|"Codex runtime identity unavailable")?));
    Ok(RunningCodexServer {
        executable_id,
        rlm_executable_sha256,
        rlm_profile_generation: rlm_profile_generation(),
        rlm_observation: Arc::new(Mutex::new(RlmParentObservation::default())),
        model_id,
        caller_label,
        owner_id,
        route_identity,
        generation: format!("codex-generation-{}", nanoid::nanoid!(20)),
        stdin: Some(Arc::new(Mutex::new(stdin))),
        receiver: Some(receiver),
        buffered_frames: handshake.buffered_frames.into(),
        reader_task: Some(reader_task),
        stderr_task: Some(stderr_task),
        active_stream: None,
        process,
        proxy_process,
        proxy_runtime,
        stopped: false,
    })
}

#[cfg(not(windows))]
fn spawn_owned_child(
    mut command: Command,
    label: &'static str,
) -> Result<OwnedProcessGuard, String> {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    let child = command
        .spawn()
        .map_err(|_| format!("{label} process could not be started."))?;
    Ok(OwnedProcessGuard::new(Box::new(ProductionProcess {
        child: Arc::new(Mutex::new(child)),
        terminated: false,
    })))
}

#[cfg(windows)]
fn spawn_owned_child_verified<F>(
    mut command: Command,
    label: &'static str,
    verify_before_resume: F,
) -> Result<OwnedProcessGuard, String>
where
    F: FnOnce() -> Result<(), String>,
{
    use crate::harness::runtime::version_probe_job::{
        configure_suspended, reap_failed_containment, ProbeJob,
    };

    configure_suspended(&mut command);
    let job = ProbeJob::create()?;
    let mut child = command
        .spawn()
        .map_err(|_| format!("{label} process could not be started."))?;
    if let Err(error) = job.assign_suspended(&child) {
        reap_failed_containment(&mut child, job);
        return Err(error);
    }
    if let Err(error) = verify_before_resume() {
        reap_failed_containment(&mut child, job);
        return Err(error);
    }
    if let Err(error) = job.resume_suspended(&child) {
        reap_failed_containment(&mut child, job);
        return Err(error);
    }

    let mut guard = OwnedProcessGuard::new(Box::new(ProductionProcess {
        child: Arc::new(Mutex::new(child)),
        terminated: false,
    }));
    guard.hold_for_lifetime(Box::new(job));
    Ok(guard)
}

#[cfg(not(windows))]
fn spawn_owned_child_verified<F>(
    command: Command,
    label: &'static str,
    verify_before_resume: F,
) -> Result<OwnedProcessGuard, String>
where
    F: FnOnce() -> Result<(), String>,
{
    verify_before_resume()?;
    spawn_owned_child(command, label)
}

fn run_bounded_ready_probe(mut command: Command, timeout: Duration) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    let Ok(mut child) = command.spawn() else {
        return false;
    };
    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return status.success(),
            Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(25)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return false;
            }
        }
    }
}

fn isolated_codex_instance_root(storage_root: &Path, process_id: u32, owner_id: &str) -> PathBuf {
    use sha2::{Digest, Sha256};
    // A changing loopback port must not discard this chat's native caches and
    // sessions. Keep separate homes for every app process and chat owner.
    let owner_key = format!("{:x}", Sha256::digest(owner_id.as_bytes()));
    storage_root
        .join("instances")
        .join(format!("{process_id}-{owner_key}"))
}

fn start_owned_opencodex(
    app: &AppHandle,
    provider: &connected_provider::ConnectedProvider,
    owner_id: &str,
    codex_executable: &Path,
) -> Result<(OwnedProcessGuard, PathBuf, SealedReviewedOpenCodexRuntime), String> {
    let reservation = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
        .map_err(|_| "Could not reserve a private OpenCodex endpoint.")?;
    let port = reservation
        .local_addr()
        .map_err(|_| "Could not read the OpenCodex endpoint.")?
        .port();
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|_| "VibeSpace app data is unavailable.".to_string())?;
    let profile = provider.profile(port, owner_id)?;
    let environment = provider.environment.clone();
    let storage_root = crate::harness::managed_codex_storage::storage_root(&app_data)?;
    let instance_root = isolated_codex_instance_root(&storage_root, std::process::id(), owner_id);
    let paths = materialize_isolated_profile(&instance_root, &profile)
        .map_err(|_| "The isolated Codex proxy profile could not be prepared.".to_string())?;
    let managed_base = storage_root.join("managed-runtime");
    let roaming = std::env::var_os("APPDATA").map(PathBuf::from);
    let sealed_runtime = seal_reviewed_opencodex_runtime(&managed_base, roaming.as_deref())
        .map_err(|_| {
            "Reviewed OpenCodex 2.36.0 is unavailable; run VibeSpace Doctor.".to_string()
        })?;
    let runtime = &sealed_runtime.runtime;

    let configure = |command: &mut Command| {
        crate::harness::managed_codex_child_environment::bind_codex_executable(
            command,
            codex_executable,
        );
        command
            .env("OPENCODEX_HOME", &paths.opencodex_home)
            .env("CODEX_HOME", &paths.codex_home)
            .envs(environment.iter().map(|(name, value)| (name, value)))
            .env("NO_COLOR", "1")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
    };
    let mut start = Command::new(&runtime.bun_executable);
    start
        .arg(&runtime.source_entrypoint)
        .arg("start")
        .arg("--port")
        .arg(port.to_string());
    configure(&mut start);
    drop(reservation);
    let mut proxy = spawn_owned_child_verified(start, "OpenCodex", || {
        sealed_runtime
            .revalidate()
            .map_err(|_| "OpenCodex managed runtime changed before launch.".to_string())
    })?;

    // Run the pinned upstream readiness module directly. Loading the complete
    // interactive CLI adds unrelated startup work before its bounded wait.
    // The same upstream identity checks and readiness deadline still apply.
    let mut ready = Command::new(&runtime.bun_executable);
    let ready_module =
        url::Url::from_file_path(runtime.source_entrypoint.with_file_name("ready.ts"))
            .map_err(|_| "The reviewed OpenCodex readiness module is unavailable.".to_string())?;
    let liveness_module = ready_module
        .join("../server/proxy-liveness.ts")
        .map_err(|_| "The reviewed OpenCodex discovery module is unavailable.".to_string())?;
    // Discovery needs only the port already assigned to this owned proxy. Avoid
    // another process loading/hardening its complete configuration on cold start.
    // The pinned finder still checks real /healthz identity and runtime metadata;
    // runReady retains its strict /readyz probe and single bounded deadline.
    ready
        .arg("--eval")
        .arg(format!(
            "import {{ runReady }} from {}; import {{ findLiveProxy, DEFAULT_PROBE_TIMEOUT_MS }} from {}; \
             process.exit(await runReady({{json:true,wait:true,timeoutSeconds:{}}},{{ \
             findLive: async (remainingMs) => {{ \
             const live = await findLiveProxy({{ \
             configFn: () => ({{port:{},hostname:'127.0.0.1'}}), \
             verifyPidFn: () => null, timeoutMs: DEFAULT_PROBE_TIMEOUT_MS, \
             ...(remainingMs === undefined ? {{}} : {{deadlineAt:Date.now()+remainingMs}}) \
             }}); return live ? {{pid:live.pid,port:live.port,hostname:live.hostname}} : null; \
             }} }}));",
            serde_json::to_string(ready_module.as_str()).map_err(|_| "The readiness module URL is invalid.".to_string())?,
            serde_json::to_string(liveness_module.as_str()).map_err(|_| "The discovery module URL is invalid.".to_string())?,
            OPENCODEX_READY_TIMEOUT.as_secs(),
            port,
        ));
    configure(&mut ready);
    if !run_bounded_ready_probe(ready, OPENCODEX_READY_TIMEOUT + Duration::from_secs(15)) {
        let _ = proxy.stop();
        return Err(
            "OpenCodex did not prove readiness within the bounded startup wait.".to_string(),
        );
    }
    if sealed_runtime.revalidate().is_err() {
        let _ = proxy.stop();
        return Err("OpenCodex managed runtime changed during launch.".to_string());
    }
    if proxy.has_exited()? {
        return Err("OpenCodex ended before becoming ready.".to_string());
    }
    Ok((proxy, paths.codex_home, sealed_runtime))
}

fn retry_uninitialized_start<T>(mut start: impl FnMut() -> Result<T, String>) -> Result<T, String> {
    match start() {
        // No thread or prompt has been sent at this point, so one cold-start
        // retry cannot duplicate a model turn or tool execution.
        Err(error) if error == "Codex app-server ended before initialization." => start(),
        result => result,
    }
}

fn start_internal(
    app: &AppHandle,
    caller_label: &str,
    request: CodexAppServerStartRequest,
) -> Result<CodexAppServerStartResponse, String> {
    validate_start_request(caller_label, &request)?;
    let route_identity = request.route_identity();
    // Revalidate provider authority before taking the runtime lock. This may
    // query the owned OpenCode catalog; it must not hold the Codex controller.
    let translation_provider = match request.route_kind {
        CodexNativeRouteKind::OfficialCodex => None,
        CodexNativeRouteKind::OpenCodexTranslation => {
            let account_id = request
                .account_id
                .as_deref()
                .ok_or("Codex translation route account is unavailable.")?;
            let route_handle = request
                .route_handle
                .as_deref()
                .ok_or("Codex translation route handle is unavailable.")?;
            let configuration_generation = request
                .configuration_generation
                .as_deref()
                .ok_or("Codex translation route generation is unavailable.")?;
            Some(revalidate_translation_route(
                app,
                &app.state::<ManagedCodexRouteState>(),
                account_id,
                &request.connection_id,
                &request.model_id,
                route_handle,
                configuration_generation,
            )?)
        }
        CodexNativeRouteKind::DirectResponses => {
            return Err(
                "Codex direct Responses route is not yet semantically verified.".to_string(),
            );
        }
    };

    let state = app.state::<CodexAppServerState>();
    let mut inner = state
        .inner
        .lock()
        .map_err(|_| "Codex app-server state is unavailable.".to_string())?;
    if let Some(running) = inner.running.as_mut() {
        if !running.has_exited_or_lost_integrity()? {
            if running.executable_id == request.executable_id
                && running.model_id == request.model_id
                && running.caller_label == caller_label
                && running.owner_id == request.owner_id
                && running.route_identity == route_identity
            {
                return Ok(CodexAppServerStartResponse {
                    generation: running.generation.clone(),
                });
            }
            return Err(
                "Codex app-server is already active for another owner or route.".to_string(),
            );
        }
        retire_exited_running(&mut inner.running)?;
    }

    let cli_state = app.state::<CliBridgeState>();
    let stderr_failure_category = Arc::new(Mutex::new(None));
    let running = retry_uninitialized_start(|| {
        if let Ok(mut category) = stderr_failure_category.lock() {
            *category = None;
        }
        let launch = resolve_launch_request(&request.executable_id, |executable_id| {
            cli_state.resolve_trusted_executable(executable_id)
        })?;
        let proxy = match request.route_kind {
            CodexNativeRouteKind::OfficialCodex => None,
            CodexNativeRouteKind::OpenCodexTranslation => {
                let provider = translation_provider
                    .as_ref()
                    .ok_or("Codex translation route was not revalidated.")?;
                Some(start_owned_opencodex(
                    app,
                    provider,
                    &request.owner_id,
                    &launch.executable,
                )?)
            }
            CodexNativeRouteKind::DirectResponses => {
                return Err(
                    "Codex direct Responses route is not yet semantically verified.".to_string(),
                );
            }
        };
        launch_server(
            launch,
            request.executable_id.clone(),
            request.model_id.clone(),
            caller_label.to_string(),
            request.owner_id.clone(),
            route_identity.clone(),
            stderr_failure_category.clone(),
            proxy,
        )
    });
    let running = match running {
        Ok(running) => running,
        Err(error) => {
            let category = stderr_failure_category
                .lock()
                .ok()
                .and_then(|mut category| category.take());
            if let Some(category) = category {
                if let Ok(log_directory) = app.path().app_log_dir() {
                    let _ = append_codex_start_stderr_diagnostic_at(
                        &log_directory.join("diagnostics"),
                        &request.model_id,
                        category,
                    );
                }
            }
            return Err(error);
        }
    };
    let generation = running.generation.clone();
    inner.running = Some(running);
    Ok(CodexAppServerStartResponse { generation })
}

#[tauri::command]
pub async fn codex_app_server_start(
    app: AppHandle,
    webview: Webview,
    request: CodexAppServerStartRequest,
) -> Result<CodexAppServerStartResponse, String> {
    validate_start_request(webview.label(), &request)?;
    let caller_label = webview.label().to_string();
    tauri::async_runtime::spawn_blocking(move || start_internal(&app, &caller_label, request))
        .await
        .map_err(|_| "Codex app-server start worker failed.".to_string())?
}

#[tauri::command]
pub async fn codex_app_server_stream(
    app: AppHandle,
    webview: Webview,
    generation: String,
    stream_id: String,
    on_event: Channel<CodexAppServerStreamMessage>,
) -> Result<(), String> {
    let caller = webview.label().to_string();
    tauri::async_runtime::spawn_blocking(move || {
        stream_internal(
            &app.state::<CodexAppServerState>(),
            &caller,
            generation,
            stream_id,
            on_event,
        )
    })
    .await
    .map_err(|_| "Codex app-server stream worker failed.".to_string())?
}

fn stream_internal(
    state: &CodexAppServerState,
    caller: &str,
    generation: String,
    stream_id: String,
    on_event: Channel<CodexAppServerStreamMessage>,
) -> Result<(), String> {
    if !caller_allowed(caller) {
        return Err("Codex app-server caller is not authorized.".to_string());
    }
    if !valid_identifier(&generation, 256) || !valid_identifier(&stream_id, 128) {
        return Err("Codex app-server stream identity is invalid.".to_string());
    }
    let mut inner = state
        .inner
        .lock()
        .map_err(|_| "Codex app-server state is unavailable.".to_string())?;
    let running = inner
        .running
        .as_mut()
        .ok_or_else(|| "Codex app-server is unavailable.".to_string())?;
    if running.generation != generation
        || running.caller_label != caller
        || running.has_exited_or_lost_integrity()?
    {
        return Err("Codex app-server generation is unavailable.".to_string());
    }
    if running.active_stream.is_some() {
        return Err("Codex app-server stream is already active.".to_string());
    }
    let receiver = running
        .receiver
        .take()
        .ok_or_else(|| "Codex app-server stream is unavailable.".to_string())?;
    let buffered_frames = std::mem::take(&mut running.buffered_frames);
    let cancelled = Arc::new(AtomicBool::new(false));
    let task_cancelled = cancelled.clone();
    let rlm_observation = running.rlm_observation.clone();
    let task = thread::spawn(move || {
        let mut sequence = 0_u64;
        let mut timed_frame = |frame| {
            if let Ok(mut observation)=rlm_observation.lock(){observation.inbound(&frame);}
            sequence += 1;
            CodexAppServerStreamMessage::Frame {
                frame,
                sequence,
                native_handoff_wall_us: crate::activity_diagnostics_store::native_wall_us()
                    .unwrap_or_default(),
                native_handoff_monotonic_us: crate::activity_diagnostics_store::native_monotonic_us(
                ),
            }
        };
        for frame in buffered_frames {
            if task_cancelled.load(Ordering::Acquire) || on_event.send(timed_frame(frame)).is_err()
            {
                return;
            }
        }
        loop {
            if task_cancelled.load(Ordering::Acquire) {
                let _ = on_event.send(CodexAppServerStreamMessage::Done);
                return;
            }
            match receiver.recv_timeout(Duration::from_millis(50)) {
                Ok(ReaderMessage::Frame(frame)) => {
                    if on_event.send(timed_frame(frame)).is_err() {
                        return;
                    }
                }
                Ok(ReaderMessage::Done) => {
                    let _ = on_event.send(CodexAppServerStreamMessage::Done);
                    return;
                }
                Ok(ReaderMessage::Error) => {
                    let _ = on_event.send(CodexAppServerStreamMessage::Error {
                        message: "Codex app-server stream failed.",
                    });
                    return;
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {}
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    let _ = on_event.send(CodexAppServerStreamMessage::Done);
                    return;
                }
            }
        }
    });
    running.active_stream = Some(ActiveStream {
        stream_id,
        caller_label: caller.to_string(),
        cancelled,
        task: Some(task),
    });
    Ok(())
}

#[tauri::command]
pub async fn codex_app_server_write(
    app: AppHandle,
    webview: Webview,
    generation: String,
    message: Value,
) -> Result<(), String> {
    let caller = webview.label().to_string();
    tauri::async_runtime::spawn_blocking(move || {
        write_internal(
            &app.state::<CodexAppServerState>(),
            &caller,
            generation,
            message,
        )
    })
    .await
    .map_err(|_| "Codex app-server write worker failed.".to_string())?
}

fn write_internal(
    state: &CodexAppServerState,
    caller: &str,
    generation: String,
    message: Value,
) -> Result<(), String> {
    if !caller_allowed(caller) {
        return Err("Codex app-server caller is not authorized.".to_string());
    }
    if !valid_identifier(&generation, 256) {
        return Err("Codex app-server generation is invalid.".to_string());
    }
    let frame = encode_outbound_frame(&message)?;
    let mut inner = state
        .inner
        .lock()
        .map_err(|_| "Codex app-server state is unavailable.".to_string())?;
    let running = inner
        .running
        .as_mut()
        .ok_or_else(|| "Codex app-server is unavailable.".to_string())?;
    if running.generation != generation
        || running.caller_label != caller
        || running.has_exited_or_lost_integrity()?
    {
        return Err("Codex app-server generation is unavailable.".to_string());
    }
    let active = running
        .active_stream
        .as_ref()
        .ok_or_else(|| "Codex app-server stream must be subscribed before writes.".to_string())?;
    if active.caller_label != caller || active.stream_id.is_empty() {
        return Err("Codex app-server stream owner is unavailable.".to_string());
    }
    running.rlm_observation.lock().map_err(|_|"Codex parent observation unavailable")?.outbound(&message);
    let stdin = running
        .stdin
        .as_ref()
        .ok_or_else(|| "Codex app-server stdin is unavailable.".to_string())?;
    let mut writer = stdin
        .lock()
        .map_err(|_| "Codex app-server stdin is unavailable.".to_string())?;
    writer
        .write_all(&frame)
        .and_then(|_| writer.flush())
        .map_err(|_| "Codex app-server message could not be written.".to_string())
}

#[tauri::command]
pub async fn codex_app_server_stop(
    app: AppHandle,
    webview: Webview,
    generation: String,
) -> Result<bool, String> {
    let caller = webview.label().to_string();
    tauri::async_runtime::spawn_blocking(move || {
        stop_internal(&app.state::<CodexAppServerState>(), &caller, &generation)
    })
    .await
    .map_err(|_| "Codex app-server stop worker failed.".to_string())?
}

fn stop_internal(
    state: &CodexAppServerState,
    caller: &str,
    generation: &str,
) -> Result<bool, String> {
    if !caller_allowed(caller) {
        return Err("Codex app-server caller is not authorized.".to_string());
    }
    if !valid_identifier(&generation, 256) {
        return Err("Codex app-server generation is invalid.".to_string());
    }
    let mut inner = state
        .inner
        .lock()
        .map_err(|_| "Codex app-server state is unavailable.".to_string())?;
    stop_running(&mut inner.running, caller, generation)
}

pub fn shutdown_owned_server(app: &AppHandle) {
    let state = app.state::<CodexAppServerState>();
    shutdown_owned_state(&state);
}

#[cfg(test)]
mod tests {
    #[test]
    fn stream_envelope_preserves_payload_and_handoff_metadata() {
        let envelope = super::CodexAppServerStreamMessage::Frame {
            frame: serde_json::json!({"method":"turn/started"}),
            sequence: 7,
            native_handoff_wall_us: 1_789_300_000_123_456,
            native_handoff_monotonic_us: 123_456,
        };
        let value = serde_json::to_value(envelope).unwrap();
        assert_eq!(value["sequence"], 7);
        assert_eq!(value["nativeHandoffWallUs"], 1_789_300_000_123_456_u64);
        assert_eq!(value["nativeHandoffMonotonicUs"], 123_456_u64);
        assert_eq!(value["frame"]["method"], "turn/started");
        assert_eq!(value["kind"], "frame");
    }

    #[test]
    fn isolated_codex_homes_reuse_only_the_exact_process_and_chat() {
        let root = std::path::Path::new("D:/managed");
        let first = super::isolated_codex_instance_root(root, 101, "chat-one");
        assert_eq!(
            first,
            super::isolated_codex_instance_root(root, 101, "chat-one")
        );
        assert_ne!(
            first,
            super::isolated_codex_instance_root(root, 102, "chat-one")
        );
        assert_ne!(
            first,
            super::isolated_codex_instance_root(root, 101, "chat-two")
        );
        let untrusted = super::isolated_codex_instance_root(root, 101, "../../other\\chat");
        assert_eq!(untrusted.parent(), Some(root.join("instances").as_path()));
        assert_eq!(
            untrusted.file_name().unwrap().to_str().unwrap().len(),
            4 + 64
        );
    }

    #[test]
    fn background_control_helpers_preserve_caller_and_generation_validation() {
        let state = super::CodexAppServerState::default();
        for caller in ["pet-overlay", ""] {
            assert!(super::write_internal(
                &state,
                caller,
                "valid-generation".into(),
                serde_json::json!({})
            )
            .unwrap_err()
            .contains("caller"));
            assert!(super::stop_internal(&state, caller, "valid-generation")
                .unwrap_err()
                .contains("caller"));
        }
        for generation in ["", "../foreign"] {
            assert!(super::write_internal(
                &state,
                "main",
                generation.into(),
                serde_json::json!({})
            )
            .unwrap_err()
            .contains("generation"));
            assert!(super::stop_internal(&state, "main", generation)
                .unwrap_err()
                .contains("generation"));
        }
    }

    #[test]
    fn startup_retries_only_an_uninitialized_exit_once() {
        let mut attempts = 0;
        let result = super::retry_uninitialized_start(|| {
            attempts += 1;
            if attempts == 1 {
                Err("Codex app-server ended before initialization.".to_string())
            } else {
                Ok(42)
            }
        });
        assert_eq!(result, Ok(42));
        assert_eq!(attempts, 2);
        for error in [
            "Codex app-server ended before initialization.",
            "Codex app-server rejected initialization.",
        ] {
            let mut attempts = 0;
            let result: Result<(), String> = super::retry_uninitialized_start(|| {
                attempts += 1;
                Err(error.to_string())
            });
            assert_eq!(result, Err(error.to_string()));
            assert_eq!(attempts, if error.contains("ended before") { 2 } else { 1 });
        }
    }

    #[test]
    fn stderr_drain_keeps_only_a_fixed_redacted_category() {
        let sample = b"Authentication failed for api_key=private_fixture_value";
        let category = super::spawn_stderr_drain(std::io::Cursor::new(sample.to_vec()))
            .join()
            .expect("stderr drain joins");
        assert_eq!(category, CodexStderrCategory::Authentication);
        assert!(!format!("{category:?}").contains("private_fixture_value"));

        let empty = super::spawn_stderr_drain(std::io::Cursor::new(Vec::<u8>::new()))
            .join()
            .expect("empty stderr drain joins");
        assert_eq!(empty, CodexStderrCategory::Empty);
    }

    use super::*;

    #[cfg(windows)]
    #[test]
    fn readiness_probe_allows_cold_start_and_reaps_timeout() {
        let make_probe = |script: &str| {
            let mut command = Command::new("powershell.exe");
            command.args(["-NoProfile", "-NonInteractive", "-Command", script]);
            command
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null());
            command
        };
        assert!(run_bounded_ready_probe(
            make_probe("[System.Threading.Thread]::Sleep(3500); exit 0"),
            Duration::from_secs(15),
        ));
        assert!(!run_bounded_ready_probe(
            make_probe("exit 7"),
            Duration::from_secs(15)
        ));
        let started = Instant::now();
        assert!(!run_bounded_ready_probe(
            make_probe("[System.Threading.Thread]::Sleep(30000)"),
            Duration::from_millis(100),
        ));
        assert!(started.elapsed() < Duration::from_secs(10));
    }

    use crate::harness::managed_codex_app_server::{
        CodexAppServerFrameDecoder, CODEX_APP_SERVER_MAX_FRAME_BYTES,
    };
    use serde_json::json;
    use std::fs;
    use std::io::{BufReader, Cursor};
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::sync::Arc;
    use std::time::{Duration, Instant};

    #[derive(Debug)]
    struct RecordingProcess {
        terminated: Arc<AtomicBool>,
    }

    impl OwnedCodexProcess for RecordingProcess {
        fn has_exited(&mut self) -> Result<bool, String> {
            Ok(false)
        }

        fn terminate(&mut self) -> Result<(), String> {
            self.terminated.store(true, Ordering::Release);
            Ok(())
        }
    }

    #[derive(Debug)]
    struct RetryableStopProcess {
        attempts: Arc<AtomicUsize>,
        failures_remaining: usize,
    }

    struct DropSignal(Arc<AtomicBool>);

    impl Drop for DropSignal {
        fn drop(&mut self) {
            self.0.store(true, Ordering::Release);
        }
    }

    struct RuntimeSealDropProbe {
        termination_observed: Arc<AtomicBool>,
        seal_active: Arc<AtomicBool>,
        entry_path: PathBuf,
    }

    impl Drop for RuntimeSealDropProbe {
        fn drop(&mut self) {
            assert!(self.termination_observed.load(Ordering::Acquire));
            self.seal_active.store(false, Ordering::Release);
            fs::write(&self.entry_path, b"created after proxy reap")
                .expect("entry creation after seal release");
        }
    }

    fn try_create_runtime_entry(seal_active: &AtomicBool, path: &Path) -> std::io::Result<()> {
        if seal_active.load(Ordering::Acquire) {
            return Err(std::io::Error::new(
                std::io::ErrorKind::PermissionDenied,
                "runtime seal denies new entries",
            ));
        }
        fs::write(path, b"created").map(|_| ())
    }

    impl OwnedCodexProcess for RetryableStopProcess {
        fn has_exited(&mut self) -> Result<bool, String> {
            Ok(false)
        }

        fn terminate(&mut self) -> Result<(), String> {
            self.attempts.fetch_add(1, Ordering::AcqRel);
            if self.failures_remaining > 0 {
                self.failures_remaining -= 1;
                return Err("injected termination failure".to_string());
            }
            Ok(())
        }
    }

    #[test]
    fn start_request_requires_explicit_native_route_authority() {
        let official: CodexAppServerStartRequest = serde_json::from_value(json!({
            "executableId": "cli-executable-0000000000000001",
            "ownerId": "chat_session-01",
            "modelId": "gpt-5.4-mini",
            "connectionId": "openai-codex",
            "routeKind": "official-codex",
        }))
        .expect("valid official start request");
        assert_eq!(official.executable_id, "cli-executable-0000000000000001");
        assert_eq!(official.owner_id, "chat_session-01");
        assert_eq!(official.route_kind, CodexNativeRouteKind::OfficialCodex);
        assert!(validate_start_request("main", &official).is_ok());

        let translated = CodexAppServerStartRequest {
            executable_id: official.executable_id.clone(),
            owner_id: official.owner_id.clone(),
            model_id: "custom/vendor-model".to_string(),
            connection_id: "opencode-cli".to_string(),
            route_kind: CodexNativeRouteKind::OpenCodexTranslation,
            account_id: Some("account-01".to_string()),
            route_handle: Some("codex-route-01".to_string()),
            configuration_generation: Some("generation-01".to_string()),
        };
        assert!(validate_start_request("main", &translated).is_ok());
        let translated_wire: CodexAppServerStartRequest = serde_json::from_value(json!({
            "executableId": "cli-executable-0000000000000001",
            "ownerId": "chat_session-01",
            "modelId": "custom/vendor-model",
            "connectionId": "opencode-cli",
            "routeKind": "opencodex-translation",
            "accountId": "account-01",
            "routeHandle": "codex-route-01",
            "configurationGeneration": "generation-01"
        }))
        .expect("valid translated wire request");
        assert_eq!(
            translated_wire.route_kind,
            CodexNativeRouteKind::OpenCodexTranslation
        );

        let slash_without_route = CodexAppServerStartRequest {
            model_id: "custom/vendor-model".to_string(),
            ..official.clone()
        };
        assert!(validate_start_request("main", &slash_without_route).is_ok());
        assert_eq!(
            slash_without_route.route_identity(),
            "official:openai-codex"
        );

        let direct = CodexAppServerStartRequest {
            connection_id: "custom-responses".to_string(),
            route_kind: CodexNativeRouteKind::DirectResponses,
            account_id: Some("account-01".to_string()),
            route_handle: Some("codex-route-02".to_string()),
            configuration_generation: Some("generation-02".to_string()),
            ..official.clone()
        };
        assert!(validate_start_request("main", &direct).is_err());

        assert!(serde_json::from_value::<CodexAppServerStartRequest>(json!({
            "executableId": "cli-executable-0000000000000001",
            "ownerId": "chat_session-01",
            "modelId": "gpt-5.4-mini",
            "connectionId": "openai-codex",
            "routeKind": "official-codex",
            "executablePath": "C:\\untrusted\\codex.exe",
        }))
        .is_err());

        for (caller, executable_id, owner_id) in [
            (
                "pet-overlay",
                "cli-executable-0000000000000001",
                "chat_session-01",
            ),
            ("main", "../codex.exe", "chat_session-01"),
            ("main", "cli-executable-0000000000000001", "bad owner"),
            ("main", "cli-executable-0000000000000001", ""),
        ] {
            assert!(validate_start_request(
                caller,
                &CodexAppServerStartRequest {
                    executable_id: executable_id.to_string(),
                    owner_id: owner_id.to_string(),
                    model_id: "gpt-5.4-mini".to_string(),
                    connection_id: "openai-codex".to_string(),
                    route_kind: CodexNativeRouteKind::OfficialCodex,
                    account_id: None,
                    route_handle: None,
                    configuration_generation: None,
                },
            )
            .is_err());
        }
    }

    #[test]
    fn trusted_resolver_output_is_the_only_executable_used_for_launch() {
        let trusted = PathBuf::from(r"C:\Program Files\Codex\codex.exe");
        let launch = resolve_launch_request("cli-executable-0000000000000001", |executable_id| {
            assert_eq!(executable_id, "cli-executable-0000000000000001");
            Ok(trusted.clone())
        })
        .expect("trusted launch");

        assert_eq!(launch.executable, trusted);
        assert_eq!(
            launch.arguments,
            [
                "--enable",
                "default_mode_request_user_input",
                "app-server",
                "--stdio"
            ]
        );
        assert!(resolve_launch_request("cli-executable-missing", |_| {
            Err("executableId is not registered".to_string())
        })
        .is_err());
    }

    #[test]
    fn initialize_response_is_required_before_initialized_and_stream_frames() {
        let stdout = Cursor::new(
            br#"{"method":"server/progress","params":{"message":"queued"}}
{"id":1,"result":{"userAgent":"codex-cli"}}
"#,
        );
        let mut reader = BufReader::new(stdout);
        let mut stdin = Vec::new();

        let handshake =
            perform_start_handshake(&mut reader, &mut stdin, "1.5.0").expect("valid handshake");
        let writes = String::from_utf8(stdin).expect("utf8 JSONL");
        let lines = writes.lines().collect::<Vec<_>>();
        assert_eq!(lines.len(), 2);
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(lines[0]).unwrap()["method"],
            "initialize"
        );
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(lines[1]).unwrap()["method"],
            "initialized"
        );
        assert_eq!(handshake.buffered_frames.len(), 1);
        assert_eq!(handshake.buffered_frames[0]["method"], "server/progress");

        let mut rejected_reader = BufReader::new(Cursor::new(
            br#"{"id":1,"error":{"message":"denied"}}
"#,
        ));
        let mut rejected_stdin = Vec::new();
        assert!(
            perform_start_handshake(&mut rejected_reader, &mut rejected_stdin, "1.5.0").is_err()
        );
        assert_eq!(
            String::from_utf8(rejected_stdin).unwrap().lines().count(),
            1
        );
    }

    #[test]
    fn outbound_json_frames_are_objects_newline_delimited_and_bounded() {
        assert_eq!(
            encode_outbound_frame(&json!({"method":"model/list","id":2})).unwrap(),
            b"{\"id\":2,\"method\":\"model/list\"}\n"
        );
        assert!(encode_outbound_frame(&json!(["not", "an", "object"])).is_err());
        assert!(encode_outbound_frame(&json!({
            "method": "oversized",
            "params": {"value": "x".repeat(CODEX_APP_SERVER_MAX_FRAME_BYTES)},
        }))
        .is_err());
    }

    #[test]
    fn stop_requires_the_exact_owner_and_generation_and_is_idempotent() {
        let terminated = Arc::new(AtomicBool::new(false));
        let mut running = Some(running_fixture(terminated.clone()));

        assert!(!stop_running(&mut running, "main", "codex-generation-wrong").unwrap());
        assert!(!terminated.load(Ordering::Acquire));
        assert!(running.is_some());
        assert!(!stop_running(&mut running, "workbench-main", "codex-generation-01").unwrap());
        assert!(!terminated.load(Ordering::Acquire));

        assert!(stop_running(&mut running, "main", "codex-generation-01").unwrap());
        assert!(terminated.load(Ordering::Acquire));
        assert!(running.is_none());
        assert!(!stop_running(&mut running, "main", "codex-generation-01").unwrap());
    }

    #[test]
    fn failed_codex_stop_retains_ownership_and_retries_before_removal() {
        let attempts = Arc::new(AtomicUsize::new(0));
        let mut running = Some(RunningCodexServer::new_for_test(
            "cli-executable-0000000000000001",
            "main",
            "chat_session-01",
            "codex-generation-01",
            Box::new(RetryableStopProcess {
                attempts: attempts.clone(),
                failures_remaining: 1,
            }),
        ));

        assert!(stop_running(&mut running, "main", "codex-generation-01").is_err());
        assert!(running.is_some());
        assert_eq!(attempts.load(Ordering::Acquire), 1);
        assert!(stop_running(&mut running, "main", "codex-generation-01").unwrap());
        assert!(running.is_none());
        assert_eq!(attempts.load(Ordering::Acquire), 2);
    }

    #[test]
    fn failed_proxy_stop_retains_ownership_and_retries_before_removal() {
        let codex_terminated = Arc::new(AtomicBool::new(false));
        let proxy_attempts = Arc::new(AtomicUsize::new(0));
        let mut server = running_fixture(codex_terminated.clone());
        server.proxy_process = Some(OwnedProcessGuard::new(Box::new(RetryableStopProcess {
            attempts: proxy_attempts.clone(),
            failures_remaining: 1,
        })));
        let mut running = Some(server);

        assert!(stop_running(&mut running, "main", "codex-generation-01").is_err());
        assert!(running.is_some());
        assert!(codex_terminated.load(Ordering::Acquire));
        assert_eq!(proxy_attempts.load(Ordering::Acquire), 1);
        assert!(stop_running(&mut running, "main", "codex-generation-01").unwrap());
        assert!(running.is_none());
        assert_eq!(proxy_attempts.load(Ordering::Acquire), 2);
    }

    #[test]
    fn exited_server_replacement_retains_repeatedly_failed_proxy_stop() {
        let proxy_attempts = Arc::new(AtomicUsize::new(0));
        let mut server = running_fixture(Arc::new(AtomicBool::new(false)));
        server.proxy_process = Some(OwnedProcessGuard::new(Box::new(RetryableStopProcess {
            attempts: proxy_attempts.clone(),
            failures_remaining: 2,
        })));
        let mut running = Some(server);

        assert!(retire_exited_running(&mut running).is_err());
        assert!(running.is_some());
        assert!(retire_exited_running(&mut running).is_err());
        assert!(running.is_some());
        assert!(retire_exited_running(&mut running).unwrap());
        assert!(running.is_none());
        assert_eq!(proxy_attempts.load(Ordering::Acquire), 3);
    }

    #[test]
    fn shutdown_retains_repeatedly_failed_proxy_stop_for_retry() {
        let proxy_attempts = Arc::new(AtomicUsize::new(0));
        let mut server = running_fixture(Arc::new(AtomicBool::new(false)));
        server.proxy_process = Some(OwnedProcessGuard::new(Box::new(RetryableStopProcess {
            attempts: proxy_attempts.clone(),
            failures_remaining: 2,
        })));
        let mut running = Some(server);

        assert!(shutdown_running(&mut running).is_err());
        assert!(running.is_some());
        assert!(shutdown_running(&mut running).is_err());
        assert!(running.is_some());
        assert!(shutdown_running(&mut running).unwrap());
        assert!(running.is_none());
        assert_eq!(proxy_attempts.load(Ordering::Acquire), 3);
    }

    #[test]
    fn production_shutdown_retries_boundedly_and_reaps_owned_state() {
        let attempts = Arc::new(AtomicUsize::new(0));
        let mut server = running_fixture(Arc::new(AtomicBool::new(false)));
        server.proxy_process = Some(OwnedProcessGuard::new(Box::new(RetryableStopProcess {
            attempts: attempts.clone(),
            failures_remaining: SHUTDOWN_STOP_ATTEMPTS - 1,
        })));
        let state = CodexAppServerState::default();
        state.inner.lock().unwrap().running = Some(server);

        shutdown_owned_state(&state);

        assert!(state.inner.lock().unwrap().running.is_none());
        assert_eq!(attempts.load(Ordering::Acquire), SHUTDOWN_STOP_ATTEMPTS);
    }

    #[test]
    fn production_shutdown_preserves_ownership_after_retry_cap() {
        let attempts = Arc::new(AtomicUsize::new(0));
        let mut server = running_fixture(Arc::new(AtomicBool::new(false)));
        server.proxy_process = Some(OwnedProcessGuard::new(Box::new(RetryableStopProcess {
            attempts: attempts.clone(),
            failures_remaining: SHUTDOWN_STOP_ATTEMPTS,
        })));
        let state = CodexAppServerState::default();
        state.inner.lock().unwrap().running = Some(server);

        shutdown_owned_state(&state);

        assert!(state.inner.lock().unwrap().running.is_some());
        assert_eq!(attempts.load(Ordering::Acquire), SHUTDOWN_STOP_ATTEMPTS);
        shutdown_owned_state(&state);
        assert!(state.inner.lock().unwrap().running.is_none());
        assert_eq!(attempts.load(Ordering::Acquire), SHUTDOWN_STOP_ATTEMPTS + 1);
    }

    #[test]
    fn fail_closed_termination_drops_the_job_guard_after_bounded_stop_failures() {
        let attempts = Arc::new(AtomicUsize::new(0));
        let dropped = Arc::new(AtomicBool::new(false));
        let mut guard = OwnedProcessGuard::new(Box::new(RetryableStopProcess {
            attempts: attempts.clone(),
            failures_remaining: SHUTDOWN_STOP_ATTEMPTS + 1,
        }));
        guard.hold_for_lifetime(Box::new(DropSignal(dropped.clone())));

        guard.terminate_fail_closed();

        assert_eq!(attempts.load(Ordering::Acquire), SHUTDOWN_STOP_ATTEMPTS + 1);
        assert!(dropped.load(Ordering::Acquire));
        assert!(!guard.stopped);
    }

    #[test]
    fn handshake_failure_reaps_proxy_before_releasing_runtime_seal() {
        let root = std::env::temp_dir().join(format!(
            "vibespace-codex-launch-seal-order-{}",
            nanoid::nanoid!(12)
        ));
        fs::create_dir_all(&root).expect("temporary launch root");
        let entry_path = root.join("new-entry.js");
        let termination_observed = Arc::new(AtomicBool::new(false));
        let seal_active = Arc::new(AtomicBool::new(true));
        let mut process = OwnedProcessGuard::new(Box::new(RetryableStopProcess {
            attempts: Arc::new(AtomicUsize::new(0)),
            failures_remaining: SHUTDOWN_STOP_ATTEMPTS,
        }));
        process.hold_for_lifetime(Box::new(DropSignal(termination_observed.clone())));
        let lifecycle = LaunchProxyLifecycle::new(
            process,
            RuntimeSealDropProbe {
                termination_observed: termination_observed.clone(),
                seal_active: seal_active.clone(),
                entry_path: entry_path.clone(),
            },
        );

        let result: Result<(), String> = (|| {
            let _proxy_must_outlive_handshake = lifecycle;
            assert!(seal_active.load(Ordering::Acquire));
            assert_eq!(
                try_create_runtime_entry(&seal_active, &entry_path)
                    .unwrap_err()
                    .kind(),
                std::io::ErrorKind::PermissionDenied
            );
            assert!(!entry_path.exists());
            Err("injected handshake failure".to_string())
        })();

        assert_eq!(result.err().as_deref(), Some("injected handshake failure"));
        assert!(termination_observed.load(Ordering::Acquire));
        assert!(!seal_active.load(Ordering::Acquire));
        assert_eq!(fs::read(&entry_path).unwrap(), b"created after proxy reap");
        fs::remove_dir_all(root).expect("remove temporary launch root");
    }

    #[cfg(windows)]
    #[test]
    fn failed_final_runtime_verification_never_executes_the_suspended_child() {
        let root = std::env::temp_dir().join(format!(
            "vibespace-codex-suspended-verify-{}",
            nanoid::nanoid!(12)
        ));
        fs::create_dir_all(&root).expect("temporary verification root");
        let marker = root.join("executed.txt");
        let mut command = Command::new("powershell.exe");
        command.args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            &format!(
                "[IO.File]::WriteAllText('{}', 'executed')",
                marker.display().to_string().replace('\'', "''")
            ),
        ]);

        let result = spawn_owned_child_verified(command, "verification fixture", || {
            Err("injected closure mismatch".to_string())
        });

        assert_eq!(result.err().as_deref(), Some("injected closure mismatch"));
        assert!(!marker.exists());
        fs::remove_dir_all(root).expect("remove temporary verification root");
    }

    #[test]
    fn owned_process_is_terminated_when_controller_state_is_dropped() {
        let terminated = Arc::new(AtomicBool::new(false));
        {
            let _running = running_fixture(terminated.clone());
        }
        assert!(terminated.load(Ordering::Acquire));
    }

    #[test]
    fn stop_never_waits_for_an_unresponsive_stream_worker() {
        let terminated = Arc::new(AtomicBool::new(false));
        let mut running = running_fixture(terminated.clone());
        running.active_stream = Some(ActiveStream {
            stream_id: "codex-stream-01".to_string(),
            caller_label: "main".to_string(),
            cancelled: Arc::new(AtomicBool::new(false)),
            task: Some(thread::spawn(|| thread::sleep(Duration::from_millis(250)))),
        });

        let started = Instant::now();
        running.stop_owned().expect("bounded stop");

        assert!(started.elapsed() < Duration::from_millis(100));
        assert!(terminated.load(Ordering::Acquire));
    }

    #[test]
    fn stream_decoder_never_forwards_private_reasoning() {
        let mut decoder = CodexAppServerFrameDecoder::default();
        let frames = decoder
            .push(
                br#"{"method":"item/reasoning/textDelta","params":{"delta":"private"}}
{"method":"item/reasoning/summaryTextDelta","params":{"delta":"public"}}
"#,
            )
            .expect("safe frames");
        assert_eq!(
            frames,
            [json!({
                "method": "item/reasoning/summaryTextDelta",
                "params": {"delta": "public"},
            })]
        );
        assert!(!serde_json::to_string(&frames).unwrap().contains("private"));
    }

    fn running_fixture(terminated: Arc<AtomicBool>) -> RunningCodexServer {
        RunningCodexServer::new_for_test(
            "cli-executable-0000000000000001",
            "main",
            "chat_session-01",
            "codex-generation-01",
            Box::new(RecordingProcess { terminated }),
        )
    }
}

// STAGING: inserted into harness/codex_server.rs, not a second protocol reader.
#[derive(Default)]
struct RlmParentObservation {
    account_requests: std::collections::HashSet<String>,
    policy_requests: std::collections::HashMap<String,(String,String,bool)>,
    account_hash: Option<String>,
    thread_policy: Option<(String,String,bool)>,
}
impl RlmParentObservation {
    fn outbound(&mut self, frame:&Value) {
        let Some(id)=frame.get("id").and_then(Value::as_str) else {return;};
        if frame.get("method").and_then(Value::as_str)==Some("account/read") {
            self.account_hash=None;
            if frame.pointer("/params/refreshToken").and_then(Value::as_bool)==Some(false)&&self.account_requests.len()<16 {
                self.account_requests.insert(id.to_string());
            }
        }
        if matches!(frame.get("method").and_then(Value::as_str),Some("thread/start"|"thread/resume")) {
            self.thread_policy=None;
            let denied=frame.pointer("/params/config/features/apps").and_then(Value::as_bool)==Some(false)
                &&frame.pointer("/params/config/features/remote_plugin").and_then(Value::as_bool)==Some(false);
            if !denied||self.policy_requests.len()>=16 {return;}
            let Some(model)=frame.pointer("/params/model").and_then(Value::as_str) else{return;};
            let Some(effort)=frame.pointer("/params/config/model_reasoning_effort").and_then(Value::as_str) else{return;};
            let tier=frame.pointer("/params/serviceTier").and_then(Value::as_str);
            if tier.is_some()&&tier!=Some("priority") {return;}
            self.policy_requests.insert(id.to_string(),(model.to_string(),effort.to_string(),tier==Some("priority")));
        }
    }
    fn inbound(&mut self, frame:&Value) {
        if matches!(frame.get("method").and_then(Value::as_str),Some("account/updated"|"account/login/completed")) {self.account_hash=None;}
        let Some(id)=frame.get("id").and_then(Value::as_str) else{return;};
        if self.account_requests.remove(id) {
            self.account_hash=frame.get("result").and_then(|r|crate::cli_bridge::codex_rlm_account_hash(r).ok());
        }
        if let Some((model,effort,fast))=self.policy_requests.remove(id) {
            let result=frame.get("result");
            let result_model=result.and_then(|r|r.get("model")).and_then(Value::as_str);
            let result_effort=result.and_then(|r|r.get("reasoningEffort")).and_then(Value::as_str);
            let tier=result.and_then(|r|r.get("serviceTier")).and_then(Value::as_str);
            if result_model==Some(model.as_str())&&result_effort==Some(effort.as_str())
                &&(if fast {tier==Some("priority")} else {tier.is_none()||tier==Some("default")||tier==Some("standard")}) {
                self.thread_policy=Some((model,effort,fast));
            }
        }
    }
}
fn rlm_profile_generation()->String {
    use sha2::{Digest,Sha256};
    let mut hash=Sha256::new();hash.update(b"S61-native-inherited-profile-v1\0");
    for name in ["CODEX_HOME","USERPROFILE","HOME","APPDATA","LOCALAPPDATA"] {
        hash.update(name.as_bytes());hash.update([0]);
        if let Some(value)=std::env::var_os(name) {hash.update(value.to_string_lossy().as_bytes());}
        hash.update([0]);
    }
    format!("{:x}",hash.finalize())
}
pub(crate) fn rlm_parent_binding(app:&AppHandle,caller:&str,owner:&str,generation:&str)->Result<crate::cli_bridge::CodexRlmParentBinding,String> {
    if !caller_allowed(caller)||!valid_identifier(owner,256)||!valid_identifier(generation,256) {return Err("Codex child caller invalid".into());}
    let state=app.state::<CodexAppServerState>();
    let mut inner=state.inner.lock().map_err(|_|"Codex parent state unavailable")?;
    let parent=inner.running.as_mut().ok_or("Codex parent unavailable")?;
    if parent.caller_label!=caller||parent.owner_id!=owner||parent.generation!=generation
        ||parent.route_identity!="official:openai-codex"||parent.has_exited_or_lost_integrity()?
        ||parent.rlm_profile_generation!=rlm_profile_generation() {return Err("Codex parent binding invalid".into());}
    let observed=parent.rlm_observation.lock().map_err(|_|"Codex parent observation unavailable")?;
    let account_hash=observed.account_hash.clone().ok_or("Codex unique parent account unverified")?;
    let (model,effort,fast)=observed.thread_policy.clone().ok_or("Codex parent policy unverified")?;
    if model!=parent.model_id {return Err("Codex parent model changed".into());}
    Ok(crate::cli_bridge::CodexRlmParentBinding {caller:caller.into(),owner:owner.into(),generation:generation.into(),executable_id:parent.executable_id.clone(),executable_sha256:parent.rlm_executable_sha256.clone(),model,effort,fast,profile_generation:parent.rlm_profile_generation.clone(),account_hash})
}

#[cfg(test)]
mod rlm_parent_tests {
    use super::*;
    #[test] fn uncorrelated_account_cannot_issue_binding() {
        let mut o=RlmParentObservation::default();
        o.inbound(&serde_json::json!({"id":"unrelated","result":{"requiresOpenaiAuth":true,"account":{"type":"chatgpt","email":"fixture@example.invalid"}}}));
        assert!(o.account_hash.is_none());
    }
    #[test] fn refresh_token_request_cannot_certify_readonly_account() {
        let mut o=RlmParentObservation::default();o.outbound(&serde_json::json!({"id":"account","method":"account/read","params":{"refreshToken":true}}));
        assert!(o.account_requests.is_empty());
    }
    #[test] fn native_app_policy_is_required_before_identity_capture() {
        let mut o=RlmParentObservation::default();o.outbound(&serde_json::json!({"id":"start","method":"thread/start","params":{"model":"gpt-6-luna","config":{"model_reasoning_effort":"low"}}}));
        assert!(o.policy_requests.is_empty());
    }
    #[test] fn exact_policy_response_binds_low_and_priority() {
        let mut o=RlmParentObservation::default();o.outbound(&serde_json::json!({"id":"start","method":"thread/start","params":{"model":"gpt-6-luna","serviceTier":"priority","config":{"model_reasoning_effort":"low","features":{"apps":false,"remote_plugin":false}}}}));
        o.inbound(&serde_json::json!({"id":"start","result":{"model":"gpt-6-luna","reasoningEffort":"low","serviceTier":"priority"}}));
        assert_eq!(o.thread_policy,Some(("gpt-6-luna".into(),"low".into(),true)));
    }
    #[test] fn wrong_effort_response_cannot_bind() {
        let mut o=RlmParentObservation::default();o.outbound(&serde_json::json!({"id":"start","method":"thread/start","params":{"model":"gpt-6-luna","config":{"model_reasoning_effort":"low","features":{"apps":false,"remote_plugin":false}}}}));
        o.inbound(&serde_json::json!({"id":"start","result":{"model":"gpt-6-luna","reasoningEffort":"high"}}));assert!(o.thread_policy.is_none());
    }
}
