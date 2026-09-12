//! PTY terminal backend (Wave 4 slice 1).
//!
//! Owns a `HashMap<sessionId, PtyHandle>` behind an `Arc<Mutex>`, exposes 5
//! Tauri commands (`spawn` / `write` / `resize` / `kill` / `list`) and emits 2
//! events (`terminal://output`, `terminal://exit`).
//!
//! Each session gets separate blocking reader and child-waiter tasks. The
//! waiter closes the pseudo-console master when the child exits so ConPTY
//! releases output EOF; the reader then drains final bytes and emits one
//! `terminal://exit` on its way out.
//!
//! No PII or terminal contents are ever written to logs; every failure mode
//! is mapped into a `"terminal: ..."`-prefixed `String` error so commands
//! never panic across the IPC boundary.
//!
//! Front-end contract: see `WAVE4_CONTRACTS.md` § Tauri command surface.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::{SystemTime, UNIX_EPOCH};

use portable_pty::{native_pty_system, Child, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use tauri::async_runtime::{spawn_blocking, JoinHandle, Mutex as AsyncMutex};
use tauri::{AppHandle, Emitter, State};

/// Tauri-managed shared state. Keyed by short session id (`tty_<nanoid12>`).
///
/// We hide the inner map behind an async `Mutex` so commands can `.await`
/// while holding it; in practice we only hold it long enough to insert,
/// remove, or clone an `Arc` out of a value.
pub struct TerminalState(
    pub Arc<AsyncMutex<HashMap<String, PtyHandle>>>,
    Arc<StdMutex<HashMap<String, usize>>>,
    Arc<AtomicUsize>,
    Arc<AtomicBool>,
    Arc<String>,
);

impl Default for TerminalState {
    fn default() -> Self {
        Self(
            Arc::new(AsyncMutex::new(HashMap::new())),
            Arc::new(StdMutex::new(HashMap::new())),
            Arc::new(AtomicUsize::new(0)),
            Arc::new(AtomicBool::new(false)),
            Arc::new(format!("native-runtime-{}", nanoid::nanoid!(20))),
        )
    }
}

impl TerminalState {
    /// Conservatively reports whether restarting the native process could
    /// terminate a live PTY. A contended map is treated as active.
    pub fn has_active_sessions(&self) -> bool {
        self.0
            .try_lock()
            .map(|sessions| {
                sessions.values().any(|handle| {
                    handle.active.load(Ordering::SeqCst) && !handle.deleted.load(Ordering::SeqCst)
                })
            })
            .unwrap_or(true)
    }

    fn begin_spawn(&self) -> Result<TerminalSpawnReservation, String> {
        if self.3.load(Ordering::SeqCst) {
            return Err("terminal: native recovery is in progress".to_string());
        }
        self.2.fetch_add(1, Ordering::SeqCst);
        if self.3.load(Ordering::SeqCst) {
            self.2.fetch_sub(1, Ordering::SeqCst);
            return Err("terminal: native recovery is in progress".to_string());
        }
        Ok(TerminalSpawnReservation {
            spawns_in_flight: Arc::clone(&self.2),
        })
    }

    pub fn commit_restart(&self, timeout: std::time::Duration) -> bool {
        if self
            .3
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_err()
        {
            return false;
        }
        let deadline = std::time::Instant::now() + timeout;
        while self.2.load(Ordering::SeqCst) > 0 {
            if std::time::Instant::now() >= deadline {
                self.3.store(false, Ordering::SeqCst);
                return false;
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        true
    }

    pub fn cancel_restart(&self) {
        self.3.store(false, Ordering::SeqCst);
    }

    fn runtime_generation(&self) -> &str {
        self.4.as_str()
    }

    #[cfg(test)]
    fn with_runtime_generation_for_tests(runtime_generation: impl Into<String>) -> Self {
        let mut state = Self::default();
        state.4 = Arc::new(runtime_generation.into());
        state
    }
}

struct TerminalSpawnReservation {
    spawns_in_flight: Arc<AtomicUsize>,
}

impl Drop for TerminalSpawnReservation {
    fn drop(&mut self) {
        self.spawns_in_flight.fetch_sub(1, Ordering::SeqCst);
    }
}

struct PreserveCapacityReservation {
    counts: Arc<StdMutex<HashMap<String, usize>>>,
    key: String,
}

impl Drop for PreserveCapacityReservation {
    fn drop(&mut self) {
        let mut counts = self.counts.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(count) = counts.get_mut(&self.key) {
            *count = count.saturating_sub(1);
            if *count == 0 {
                counts.remove(&self.key);
            }
        }
    }
}

fn project_capacity_key(project_id: &Option<String>) -> String {
    project_id
        .as_ref()
        .map(|id| format!("project:{id}"))
        .unwrap_or_else(|| "project:<none>".to_string())
}

/// Per-session bookkeeping. Writer / master / child-killer each live behind
/// their own async mutex + `Arc` so a long-running `write` can't block a
/// concurrent `resize`, and the reader task can keep streaming output while
/// the main task issues control operations.
pub struct PtyHandle {
    info: TerminalInfo,
    writer: Arc<AsyncMutex<Box<dyn Write + Send>>>,
    master: Arc<AsyncMutex<Option<Box<dyn MasterPty + Send>>>>,
    killer: Arc<AsyncMutex<Box<dyn ChildKiller + Send + Sync>>>,
    lifecycle: Arc<LifecycleArbiter>,
    _reader_task: JoinHandle<()>,
    active: Arc<AtomicBool>,
    deleted: Arc<AtomicBool>,
}

/// Metadata returned by `terminal_list`. The flattened native process
/// binding is captured once at spawn and repeated unchanged on every list.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalInfo {
    pub session_id: String,
    pub command: String,
    pub cwd: String,
    pub rows: u16,
    pub cols: u16,
    pub started_at: u64,
    pub project_id: Option<String>,
    pub project_name: Option<String>,
    pub deleted: bool,
    #[serde(flatten)]
    pub process_binding: NativeProcessBinding,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeProcessBinding {
    /// Opaque per-spawn identity; unlike PID, it is never reused deliberately.
    pub process_instance_id: String,
    /// Native process identifier reported by the live portable-pty child.
    pub pid: u32,
    /// OS-reported process creation time, normalized to Unix milliseconds.
    pub process_started_at: u64,
    /// Opaque identity shared by terminal sessions in this native runtime.
    pub runtime_generation: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpawnResponse {
    pub session_id: String,
    /// Resolved working directory of the spawned process. Returned so the
    /// frontend can place per-directory artefacts (AGENTS.md, coordination
    /// doc) even when the caller did not pass an explicit `cwd`.
    pub cwd: String,
    /// True only when the backend placed the startup command in the child
    /// process arguments. The frontend must not replay it through PTY input.
    pub startup_command_consumed: bool,
    #[serde(flatten)]
    pub process_binding: NativeProcessBinding,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct OutputPayload {
    session_id: String,
    data: String,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct ExitPayload {
    session_id: String,
    #[serde(flatten)]
    process_binding: NativeProcessBinding,
    code: Option<i32>,
    reason: ExitReason,
    #[serde(skip_serializing_if = "Option::is_none")]
    cancellation_token: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum KillResultKind {
    Missing,
    AlreadyExited,
    DeliveryRejected,
    SignalDelivered,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum KillRequestKind {
    CanonicalCancellation,
    ManualTermination,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
enum ExitReason {
    NaturalExit,
    AcceptedCancellation,
    ManualTermination,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalKillResult {
    kind: KillResultKind,
    request_kind: KillRequestKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    cancellation_token: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct KillRequest {
    kind: KillRequestKind,
    cancellation_token: Option<String>,
}

impl KillRequest {
    fn canonical(cancellation_token: impl Into<String>) -> Self {
        Self {
            kind: KillRequestKind::CanonicalCancellation,
            cancellation_token: Some(cancellation_token.into()),
        }
    }

    fn manual() -> Self {
        Self {
            kind: KillRequestKind::ManualTermination,
            cancellation_token: None,
        }
    }

    fn result(&self, kind: KillResultKind) -> TerminalKillResult {
        TerminalKillResult {
            kind,
            request_kind: self.kind,
            cancellation_token: self.cancellation_token.clone(),
        }
    }
}

impl TerminalKillResult {
    fn missing(request: KillRequest) -> Self {
        request.result(KillResultKind::Missing)
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct KillAttempt {
    id: u64,
    request: KillRequest,
}

enum KillStart {
    Complete(TerminalKillResult),
    Deliver(KillAttempt),
}

struct KillCompletion {
    result: TerminalKillResult,
    exit: Option<ExitPayload>,
}

#[derive(Clone, Debug)]
enum LifecyclePhase {
    Running,
    Delivering(KillAttempt),
    SignalDelivered(KillRequest),
    Finalized,
}

#[derive(Clone, Copy, Debug)]
struct ObservedExit {
    code: Option<i32>,
}

#[derive(Debug)]
struct LifecycleState {
    phase: LifecyclePhase,
    pending_exit: Option<ObservedExit>,
    next_attempt_id: u64,
}

/// Serializes the reader's exit observation with native kill delivery.
/// Exactly one transition receives an `ExitPayload`; that owner emits it
/// before removing the session from the shared map.
struct LifecycleArbiter {
    session_id: String,
    process_binding: NativeProcessBinding,
    cancellation_token: Option<String>,
    state: StdMutex<LifecycleState>,
}

impl LifecycleArbiter {
    fn new(
        session_id: impl Into<String>,
        process_binding: NativeProcessBinding,
        cancellation_token: Option<String>,
    ) -> Self {
        Self {
            session_id: session_id.into(),
            process_binding,
            cancellation_token,
            state: StdMutex::new(LifecycleState {
                phase: LifecyclePhase::Running,
                pending_exit: None,
                next_attempt_id: 0,
            }),
        }
    }

    fn begin_kill(&self, request: KillRequest) -> KillStart {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        if matches!(state.phase, LifecyclePhase::Finalized) {
            return KillStart::Complete(request.result(KillResultKind::AlreadyExited));
        }

        if request.kind == KillRequestKind::CanonicalCancellation
            && request.cancellation_token != self.cancellation_token
        {
            return KillStart::Complete(request.result(KillResultKind::DeliveryRejected));
        }

        if !matches!(state.phase, LifecyclePhase::Running) {
            return KillStart::Complete(request.result(KillResultKind::DeliveryRejected));
        }

        state.next_attempt_id = state.next_attempt_id.wrapping_add(1);
        let attempt = KillAttempt {
            id: state.next_attempt_id,
            request,
        };
        state.phase = LifecyclePhase::Delivering(attempt.clone());
        KillStart::Deliver(attempt)
    }

    fn complete_kill(&self, attempt: KillAttempt, delivered: bool) -> KillCompletion {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        let is_current_attempt = matches!(
            &state.phase,
            LifecyclePhase::Delivering(current) if current.id == attempt.id
        );
        if !is_current_attempt {
            return KillCompletion {
                result: attempt.request.result(KillResultKind::DeliveryRejected),
                exit: None,
            };
        }

        let pending_exit = state.pending_exit.take();
        let result_kind = if delivered {
            state.phase = LifecyclePhase::SignalDelivered(attempt.request.clone());
            KillResultKind::SignalDelivered
        } else {
            state.phase = LifecyclePhase::Running;
            KillResultKind::DeliveryRejected
        };

        let exit = pending_exit.map(|observed| {
            let reason = if delivered {
                Self::accepted_exit_reason(&attempt.request)
            } else {
                ExitReason::NaturalExit
            };
            state.phase = LifecyclePhase::Finalized;
            self.exit_payload(observed.code, reason, &attempt.request)
        });

        KillCompletion {
            result: attempt.request.result(result_kind),
            exit,
        }
    }

    fn observe_exit(&self, code: Option<i32>) -> Option<ExitPayload> {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        match state.phase.clone() {
            LifecyclePhase::Finalized => None,
            LifecyclePhase::Delivering(_) => {
                if state.pending_exit.is_none() {
                    state.pending_exit = Some(ObservedExit { code });
                }
                None
            }
            LifecyclePhase::Running => {
                state.phase = LifecyclePhase::Finalized;
                Some(self.exit_payload(code, ExitReason::NaturalExit, &KillRequest::manual()))
            }
            LifecyclePhase::SignalDelivered(request) => {
                state.phase = LifecyclePhase::Finalized;
                Some(self.exit_payload(code, Self::accepted_exit_reason(&request), &request))
            }
        }
    }

    fn accepted_exit_reason(request: &KillRequest) -> ExitReason {
        match request.kind {
            KillRequestKind::CanonicalCancellation => ExitReason::AcceptedCancellation,
            KillRequestKind::ManualTermination => ExitReason::ManualTermination,
        }
    }

    fn exit_payload(
        &self,
        code: Option<i32>,
        reason: ExitReason,
        request: &KillRequest,
    ) -> ExitPayload {
        ExitPayload {
            session_id: self.session_id.clone(),
            process_binding: self.process_binding.clone(),
            code,
            reason,
            cancellation_token: (reason == ExitReason::AcceptedCancellation)
                .then(|| request.cancellation_token.clone())
                .flatten(),
        }
    }
}

fn emit_before_remove(
    payload: &ExitPayload,
    emit: impl FnOnce(&ExitPayload),
    remove: impl FnOnce(&str),
) {
    emit(payload);
    remove(&payload.session_id);
}

fn finalize_terminal_session(
    app: &AppHandle,
    sessions: &Arc<AsyncMutex<HashMap<String, PtyHandle>>>,
    exit: &ExitPayload,
) {
    emit_before_remove(
        exit,
        |payload| {
            let _ = app.emit("terminal://exit", payload);
        },
        |session_id| {
            remove_matching_session(
                &mut sessions.blocking_lock(),
                session_id,
                &exit.process_binding,
            );
        },
    );
}

fn remove_matching_session(
    sessions: &mut HashMap<String, PtyHandle>,
    session_id: &str,
    process_binding: &NativeProcessBinding,
) -> bool {
    let matches = should_remove_session(
        sessions
            .get(session_id)
            .map(|handle| &handle.info.process_binding),
        process_binding,
    );
    if matches {
        sessions.remove(session_id);
    }
    matches
}

fn should_remove_session(
    current: Option<&NativeProcessBinding>,
    exited: &NativeProcessBinding,
) -> bool {
    current == Some(exited)
}

#[derive(Clone)]
struct KillTarget {
    killer: Arc<AsyncMutex<Box<dyn ChildKiller + Send + Sync>>>,
    lifecycle: Arc<LifecycleArbiter>,
    active: Arc<AtomicBool>,
}

impl From<&PtyHandle> for KillTarget {
    fn from(handle: &PtyHandle) -> Self {
        Self {
            killer: handle.killer.clone(),
            lifecycle: handle.lifecycle.clone(),
            active: handle.active.clone(),
        }
    }
}

async fn deliver_kill(
    app: &AppHandle,
    sessions: &Arc<AsyncMutex<HashMap<String, PtyHandle>>>,
    target: KillTarget,
    request: KillRequest,
) -> TerminalKillResult {
    let attempt = match target.lifecycle.begin_kill(request) {
        KillStart::Complete(result) => return result,
        KillStart::Deliver(attempt) => attempt,
    };

    let lifecycle = target.lifecycle.clone();
    let lifecycle_for_delivery = lifecycle.clone();
    let fallback_attempt = attempt.clone();
    let app_for_delivery = app.clone();
    let sessions_for_delivery = sessions.clone();
    let delivery = spawn_blocking(move || {
        let mut killer = target.killer.blocking_lock();
        let delivered = killer.kill().is_ok();
        drop(killer);

        let completion = lifecycle_for_delivery.complete_kill(attempt, delivered);
        if completion.result.kind == KillResultKind::SignalDelivered {
            target.active.store(false, Ordering::SeqCst);
        }
        if let Some(exit) = &completion.exit {
            finalize_terminal_session(&app_for_delivery, &sessions_for_delivery, exit);
        }
        completion.result
    })
    .await;

    match delivery {
        Ok(result) => result,
        Err(_) => {
            let completion = lifecycle.complete_kill(fallback_attempt, false);
            if let Some(exit) = completion.exit {
                let _ = app.emit("terminal://exit", exit.clone());
                let mut sessions = sessions.lock().await;
                remove_matching_session(&mut sessions, &exit.session_id, &exit.process_binding);
            }
            completion.result
        }
    }
}

const MAX_TERMINAL_SESSIONS: usize = 10;
const MAX_CANCELLATION_TOKEN_BYTES: usize = 512;
const MAX_STARTUP_COMMAND_BYTES: usize = 32_768;
const MAX_NATIVE_ID_BYTES: usize = 128;
const WINDOWS_UNIX_EPOCH_100NS: u64 = 116_444_736_000_000_000;
const MAX_SAFE_JS_INTEGER: u64 = 9_007_199_254_740_991;

fn valid_native_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_NATIVE_ID_BYTES
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

fn process_started_at_from_filetime_ticks(ticks: u64) -> Result<u64, String> {
    let unix_millis = ticks
        .checked_sub(WINDOWS_UNIX_EPOCH_100NS)
        .map(|unix_ticks| unix_ticks / 10_000)
        .ok_or_else(|| "terminal: invalid native process creation time".to_string())?;
    valid_process_started_at(unix_millis)
}

fn valid_process_started_at(unix_millis: u64) -> Result<u64, String> {
    (unix_millis > 0 && unix_millis <= MAX_SAFE_JS_INTEGER)
        .then_some(unix_millis)
        .ok_or_else(|| "terminal: invalid native process creation time".to_string())
}

fn build_process_binding(
    runtime_generation: &str,
    pid: Option<u32>,
    process_started_at: Option<u64>,
    process_instance_id: &str,
) -> Result<NativeProcessBinding, String> {
    if !valid_native_id(runtime_generation) || !valid_native_id(process_instance_id) {
        return Err("terminal: invalid native process identity".to_string());
    }
    let pid = pid
        .filter(|pid| *pid != 0)
        .ok_or_else(|| "terminal: native process identifier is unavailable".to_string())?;
    let process_started_at = valid_process_started_at(
        process_started_at
            .ok_or_else(|| "terminal: native process creation time is unavailable".to_string())?,
    )?;
    Ok(NativeProcessBinding {
        process_instance_id: process_instance_id.to_string(),
        pid,
        process_started_at,
        runtime_generation: runtime_generation.to_string(),
    })
}

#[cfg(target_os = "windows")]
fn native_process_started_at(child: &(dyn Child + Send + Sync)) -> Result<u64, String> {
    use windows::Win32::Foundation::{FILETIME, HANDLE};
    use windows::Win32::System::Threading::GetProcessTimes;

    let raw_handle = child
        .as_raw_handle()
        .ok_or_else(|| "terminal: native process handle is unavailable".to_string())?;
    let mut creation = FILETIME::default();
    let mut exit = FILETIME::default();
    let mut kernel = FILETIME::default();
    let mut user = FILETIME::default();
    // SAFETY: portable-pty owns the live process handle for the duration of
    // this call and all four FILETIME outputs are initialized, writable, and
    // remain alive until GetProcessTimes returns.
    unsafe {
        GetProcessTimes(
            HANDLE(raw_handle),
            &mut creation,
            &mut exit,
            &mut kernel,
            &mut user,
        )
    }
    .map_err(|_| "terminal: native process creation time is unavailable".to_string())?;
    process_started_at_from_filetime_ticks(
        ((creation.dwHighDateTime as u64) << 32) | creation.dwLowDateTime as u64,
    )
}

#[cfg(target_os = "linux")]
fn native_process_started_at(child: &(dyn Child + Send + Sync)) -> Result<u64, String> {
    use std::fs;

    let pid = child
        .process_id()
        .filter(|pid| *pid != 0)
        .ok_or_else(|| "terminal: native process identifier is unavailable".to_string())?;
    let stat = fs::read_to_string(format!("/proc/{pid}/stat"))
        .map_err(|_| "terminal: native process creation time is unavailable".to_string())?;
    let fields = stat
        .rsplit_once(") ")
        .map(|(_, fields)| fields)
        .ok_or_else(|| "terminal: invalid native process creation time".to_string())?;
    // After the parenthesized command, token zero is field 3 (`state`);
    // process start ticks are field 22, therefore token index 19.
    let start_ticks = fields
        .split_whitespace()
        .nth(19)
        .and_then(|value| value.parse::<u64>().ok())
        .ok_or_else(|| "terminal: invalid native process creation time".to_string())?;
    let boot_seconds = fs::read_to_string("/proc/stat")
        .ok()
        .and_then(|stat| {
            stat.lines().find_map(|line| {
                line.strip_prefix("btime ")
                    .and_then(|value| value.parse::<u64>().ok())
            })
        })
        .ok_or_else(|| "terminal: native boot time is unavailable".to_string())?;
    extern "C" {
        fn sysconf(name: i32) -> isize;
    }
    // Linux `_SC_CLK_TCK` is ABI value 2.
    let clock_ticks_per_second = unsafe { sysconf(2) };
    if clock_ticks_per_second <= 0 {
        return Err("terminal: native process clock is unavailable".to_string());
    }
    let boot_millis = boot_seconds
        .checked_mul(1_000)
        .ok_or_else(|| "terminal: invalid native process creation time".to_string())?;
    let elapsed_millis = start_ticks
        .checked_mul(1_000)
        .and_then(|ticks| ticks.checked_div(clock_ticks_per_second as u64))
        .ok_or_else(|| "terminal: invalid native process creation time".to_string())?;
    valid_process_started_at(
        boot_millis
            .checked_add(elapsed_millis)
            .ok_or_else(|| "terminal: invalid native process creation time".to_string())?,
    )
}

#[cfg(target_os = "macos")]
fn native_process_started_at(child: &(dyn Child + Send + Sync)) -> Result<u64, String> {
    use std::ffi::c_void;
    use std::mem::{size_of, MaybeUninit};

    #[repr(C)]
    struct ProcBsdInfo {
        pbi_flags: u32,
        pbi_status: u32,
        pbi_xstatus: u32,
        pbi_pid: u32,
        pbi_ppid: u32,
        pbi_uid: u32,
        pbi_gid: u32,
        pbi_ruid: u32,
        pbi_rgid: u32,
        pbi_svuid: u32,
        pbi_svgid: u32,
        rfu_1: u32,
        pbi_comm: [i8; 16],
        pbi_name: [i8; 32],
        pbi_nfiles: u32,
        pbi_pgid: u32,
        pbi_pjobc: u32,
        e_tdev: u32,
        e_tpgid: u32,
        pbi_nice: i32,
        pbi_start_tvsec: u64,
        pbi_start_tvusec: u64,
    }
    extern "C" {
        fn proc_pidinfo(
            pid: i32,
            flavor: i32,
            arg: u64,
            buffer: *mut c_void,
            buffer_size: i32,
        ) -> i32;
    }

    let pid = child
        .process_id()
        .filter(|pid| *pid != 0 && *pid <= i32::MAX as u32)
        .ok_or_else(|| "terminal: native process identifier is unavailable".to_string())?;
    let mut info = MaybeUninit::<ProcBsdInfo>::zeroed();
    let expected = size_of::<ProcBsdInfo>() as i32;
    // SAFETY: `info` is a correctly sized writable PROC_PIDTBSDINFO buffer.
    // It is assumed initialized only when proc_pidinfo reports the full size.
    let written = unsafe {
        proc_pidinfo(
            pid as i32,
            3,
            0,
            info.as_mut_ptr().cast::<c_void>(),
            expected,
        )
    };
    if written != expected {
        return Err("terminal: native process creation time is unavailable".to_string());
    }
    // SAFETY: The successful full-size proc_pidinfo result initialized `info`.
    let info = unsafe { info.assume_init() };
    let millis = info
        .pbi_start_tvsec
        .checked_mul(1_000)
        .and_then(|value| value.checked_add(info.pbi_start_tvusec / 1_000))
        .ok_or_else(|| "terminal: invalid native process creation time".to_string())?;
    valid_process_started_at(millis)
}

#[cfg(not(any(target_os = "windows", target_os = "linux", target_os = "macos")))]
fn native_process_started_at(_child: &(dyn Child + Send + Sync)) -> Result<u64, String> {
    Err("terminal: authoritative process creation time is unavailable".to_string())
}

fn capture_process_binding(
    child: &(dyn Child + Send + Sync),
    runtime_generation: &str,
    process_instance_id: &str,
) -> Result<NativeProcessBinding, String> {
    build_process_binding(
        runtime_generation,
        child.process_id(),
        Some(native_process_started_at(child)?),
        process_instance_id,
    )
}

fn valid_cancellation_token(token: &str) -> bool {
    !token.is_empty()
        && token == token.trim()
        && token.len() <= MAX_CANCELLATION_TOKEN_BYTES
        && !token.contains('\0')
}

fn validated_kill_request(cancellation_token: Option<String>) -> Result<KillRequest, String> {
    match cancellation_token {
        Some(token) if valid_cancellation_token(&token) => Ok(KillRequest::canonical(token)),
        Some(_) => Err("terminal: invalid cancellation token".to_string()),
        None => Ok(KillRequest::manual()),
    }
}

/// Resolve which executable to launch when the caller didn't pick one.
///
/// * Windows -> `powershell.exe` (Windows 10 1809+ ships ConPTY, which is
///   what `portable-pty` uses behind the scenes).
/// * Unix    -> `$SHELL`, falling back to `/bin/zsh` then `/bin/bash`.
fn pick_default_shell(custom: Option<String>) -> String {
    if let Some(cmd) = custom {
        return cmd;
    }
    #[cfg(target_os = "windows")]
    {
        "powershell.exe".to_string()
    }
    #[cfg(not(target_os = "windows"))]
    {
        if let Ok(s) = std::env::var("SHELL") {
            if !s.is_empty() {
                return s;
            }
        }
        if std::path::Path::new("/bin/zsh").exists() {
            "/bin/zsh".to_string()
        } else {
            "/bin/bash".to_string()
        }
    }
}

/// Returns true when `cmd` is a PowerShell variant that accepts
/// `-NoLogo -NoProfile -NoExit`.
///
/// We strip surrounding quotes and extract the base executable name
/// so all of these match: `powershell.exe`, `"powershell.exe"`,
/// `powershell`, `pwsh.exe`, `pwsh`, and any full paths ending in
/// a powershell/pwsh executable.
fn is_powershell(cmd: &str) -> bool {
    let trimmed = cmd.trim();
    // Strip surrounding double-quotes if present.
    let unquoted = trimmed
        .strip_prefix('"')
        .and_then(|s| s.strip_suffix('"'))
        .unwrap_or(trimmed);
    // Take only the executable name from a full path.
    let name = std::path::Path::new(unquoted)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or(unquoted);
    let lower = name.to_ascii_lowercase();
    lower == "powershell.exe" || lower == "powershell" || lower == "pwsh.exe" || lower == "pwsh"
}

#[derive(Debug, PartialEq, Eq)]
struct TerminalLaunchSpec {
    executable: String,
    arguments: Vec<String>,
    startup_command_consumed: bool,
}

fn terminal_launch_spec(
    command: Option<String>,
    startup_command: Option<String>,
) -> Result<TerminalLaunchSpec, String> {
    if let Some(startup) = startup_command.as_ref() {
        if startup.is_empty() || startup.len() > MAX_STARTUP_COMMAND_BYTES || startup.contains('\0')
        {
            return Err("terminal: invalid startup command".to_string());
        }
    }

    let executable = pick_default_shell(command);
    let mut arguments = Vec::new();
    let mut startup_command_consumed = false;

    #[cfg(target_os = "windows")]
    if is_powershell(&executable) {
        arguments.push("-NoLogo".to_string());
        arguments.push("-NoProfile".to_string());
        if let Some(startup) = startup_command {
            arguments.push("-Command".to_string());
            arguments.push(startup);
            startup_command_consumed = true;
        } else {
            arguments.push("-NoExit".to_string());
        }
    }

    Ok(TerminalLaunchSpec {
        executable,
        arguments,
        startup_command_consumed,
    })
}

fn now_unix_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn default_terminal_cwd() -> String {
    std::env::var("USERPROFILE")
        .ok()
        .filter(|p| !p.trim().is_empty())
        .or_else(|| std::env::var("HOME").ok().filter(|p| !p.trim().is_empty()))
        .or_else(|| {
            std::env::current_dir()
                .ok()
                .and_then(|p| p.to_str().map(String::from))
        })
        .unwrap_or_default()
}

fn decode_terminal_bytes(pending_utf8: &mut Vec<u8>, chunk: &[u8]) -> Option<String> {
    if chunk.is_empty() && pending_utf8.is_empty() {
        return None;
    }

    let mut bytes = Vec::with_capacity(pending_utf8.len() + chunk.len());
    if !pending_utf8.is_empty() {
        bytes.extend_from_slice(pending_utf8);
        pending_utf8.clear();
    }
    bytes.extend_from_slice(chunk);

    match std::str::from_utf8(&bytes) {
        Ok(text) => Some(text.to_string()),
        Err(err) if err.error_len().is_none() => {
            let valid_up_to = err.valid_up_to();
            *pending_utf8 = bytes[valid_up_to..].to_vec();
            if valid_up_to == 0 {
                None
            } else {
                Some(String::from_utf8_lossy(&bytes[..valid_up_to]).to_string())
            }
        }
        Err(_) => Some(String::from_utf8_lossy(&bytes).to_string()),
    }
}

/// Spawn a new PTY-backed child process and return its session id. The reader
/// task is started in the background; subsequent output flows over the
/// `terminal://output` event.
#[tauri::command]
pub async fn terminal_spawn(
    state: State<'_, TerminalState>,
    app: AppHandle,
    command: Option<String>,
    startup_command: Option<String>,
    cwd: Option<String>,
    rows: u16,
    cols: u16,
    env: Option<HashMap<String, String>>,
    project_id: Option<String>,
    project_name: Option<String>,
    cancellation_token: Option<String>,
    preserve_existing: Option<bool>,
) -> Result<SpawnResponse, String> {
    let cancellation_token = match cancellation_token {
        Some(token) if valid_cancellation_token(&token) => Some(token),
        Some(_) => return Err("terminal: invalid cancellation token".to_string()),
        None => None,
    };
    let launch = terminal_launch_spec(command, startup_command)?;
    let _spawn_reservation = state.begin_spawn()?;
    let cmd_str = launch.executable.clone();
    let mut evicted_targets = Vec::new();
    let preserve_existing = preserve_existing.unwrap_or(false);
    let mut capacity_reservation: Option<PreserveCapacityReservation> = None;
    {
        let map = state.0.lock().await;
        let mut project_sessions: Vec<(String, u64)> = map
            .values()
            .filter(|h| {
                h.info.project_id == project_id
                    && h.active.load(Ordering::SeqCst)
                    && !h.deleted.load(Ordering::SeqCst)
            })
            .map(|h| (h.info.session_id.clone(), h.info.started_at))
            .collect();
        println!(
            "[terminal] Spawning PTY. Active sessions for project {:?} (name: {:?}): {}/{}",
            project_id,
            project_name,
            project_sessions.len(),
            MAX_TERMINAL_SESSIONS
        );
        if preserve_existing {
            let key = project_capacity_key(&project_id);
            let mut counts = state.1.lock().unwrap_or_else(|e| e.into_inner());
            let reserved = counts.get(&key).copied().unwrap_or(0);
            if project_sessions.len() + reserved >= MAX_TERMINAL_SESSIONS {
                return Err(
                    "terminal: project capacity reached; existing terminals were preserved"
                        .to_string(),
                );
            }
            *counts.entry(key.clone()).or_insert(0) += 1;
            capacity_reservation = Some(PreserveCapacityReservation {
                counts: state.1.clone(),
                key,
            });
        } else if project_sessions.len() >= MAX_TERMINAL_SESSIONS {
            // Sort by started_at ascending (oldest first)
            project_sessions.sort_by_key(|k| k.1);
            let evict_count = project_sessions.len() - MAX_TERMINAL_SESSIONS + 1;
            for i in 0..evict_count {
                if let Some((sid, _)) = project_sessions.get(i) {
                    println!("[terminal] Evicting oldest session: {}", sid);
                    if let Some(handle) = map.get(sid) {
                        evicted_targets.push(KillTarget::from(handle));
                    }
                }
            }
        }
    }
    for target in evicted_targets {
        let _ = deliver_kill(&app, &state.0, target, KillRequest::manual()).await;
    }

    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("terminal: open pty failed: {e}"))?;

    let session_id = format!("tty_{}", nanoid::nanoid!(12));
    let mut builder = CommandBuilder::new(&cmd_str);
    for argument in &launch.arguments {
        builder.arg(argument);
    }
    #[cfg(target_os = "windows")]
    if is_powershell(&cmd_str) {
        builder.env("JARVIS_EMBEDDED_TERMINAL", "1");
    }
    let resolved_cwd = cwd.unwrap_or_else(default_terminal_cwd);
    if !resolved_cwd.is_empty() {
        builder.cwd(&resolved_cwd);
    }
    if let Some(env_map) = env {
        for (k, v) in env_map {
            builder.env(k, v);
        }
    }
    builder.env("VIBESPACE_TERMINAL_SESSION_ID", &session_id);
    if let Some(project_id) = &project_id {
        builder.env("VIBESPACE_PROJECT_ID", project_id);
    }

    let mut child = pair
        .slave
        .spawn_command(builder)
        .map_err(|e| format!("terminal: spawn failed: {e}"))?;
    let process_instance_id = format!("ptyproc_{}", nanoid::nanoid!(20));
    let process_binding = match capture_process_binding(
        child.as_ref(),
        state.runtime_generation(),
        &process_instance_id,
    ) {
        Ok(binding) => binding,
        Err(error) => {
            let _ = child.kill();
            let _ = child.wait();
            return Err(error);
        }
    };
    // Drop the slave handle now: the child process holds its own reference
    // to the slave fd, and dropping ours means the master will see EOF as
    // soon as the child exits (instead of hanging forever).
    drop(pair.slave);

    let reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("terminal: reader clone failed: {e}"))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("terminal: writer take failed: {e}"))?;
    let killer = child.clone_killer();

    let response_cwd = resolved_cwd.clone();
    let info = TerminalInfo {
        session_id: session_id.clone(),
        command: cmd_str,
        cwd: resolved_cwd,
        rows,
        cols,
        started_at: now_unix_ms(),
        project_id: project_id.clone(),
        project_name: project_name.clone(),
        deleted: false,
        process_binding: process_binding.clone(),
    };

    // Reader task. Owns the child + reader so it can wait() once the master
    // closes; emits `terminal://exit` exactly once on its way out. We use
    // `spawn_blocking` because `Read` is synchronous and waiting on PTY I/O
    // would otherwise stall the runtime.
    let app_emit = app.clone();
    let state_for_task = state.0.clone();
    let active_for_task = Arc::new(AtomicBool::new(true));
    let active_flag_for_task = active_for_task.clone();
    let session_for_task = session_id.clone();
    let lifecycle = Arc::new(LifecycleArbiter::new(
        session_id.clone(),
        process_binding.clone(),
        cancellation_token,
    ));
    let lifecycle_for_task = lifecycle.clone();
    let master = Arc::new(AsyncMutex::new(Some(pair.master)));
    let master_for_waiter = master.clone();
    let (exit_tx, exit_rx) = std::sync::mpsc::sync_channel(1);
    let (reader_start_tx, reader_start_rx) = std::sync::mpsc::sync_channel(1);
    let reader_task = spawn_blocking(move || {
        if reader_start_rx.recv().is_err() {
            return;
        }
        let mut reader = reader;
        let mut buf = [0u8; 4096];
        let mut pending_utf8 = Vec::new();
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    if let Some(data) = decode_terminal_bytes(&mut pending_utf8, &buf[..n]) {
                        let _ = app_emit.emit(
                            "terminal://output",
                            OutputPayload {
                                session_id: session_for_task.clone(),
                                data,
                            },
                        );
                    }
                }
                Err(_) => break,
            }
        }
        if let Some(data) = decode_terminal_bytes(&mut pending_utf8, &[]) {
            let _ = app_emit.emit(
                "terminal://output",
                OutputPayload {
                    session_id: session_for_task.clone(),
                    data,
                },
            );
        }
        let code = exit_rx.recv().unwrap_or(None);
        if let Some(exit) = lifecycle_for_task.observe_exit(code) {
            finalize_terminal_session(&app_emit, &state_for_task, &exit);
        }
    });
    let (waiter_start_tx, waiter_start_rx) = std::sync::mpsc::sync_channel(1);
    let _waiter_task = spawn_blocking(move || {
        if waiter_start_rx.recv().is_err() {
            return;
        }
        let mut child = child;
        let code = child.wait().ok().map(|status| status.exit_code() as i32);
        active_flag_for_task.store(false, Ordering::SeqCst);
        let _ = exit_tx.send(code);
        // ConPTY can keep its output pipe open after the child exits while the
        // pseudo-console master remains alive. Close that owner here so the
        // reader drains the final bytes, observes EOF, and emits one exit.
        master_for_waiter.blocking_lock().take();
    });

    let deleted_flag_for_task = Arc::new(AtomicBool::new(false));
    let handle = PtyHandle {
        info,
        writer: Arc::new(AsyncMutex::new(writer)),
        master,
        killer: Arc::new(AsyncMutex::new(killer)),
        lifecycle,
        _reader_task: reader_task,
        active: active_for_task,
        deleted: deleted_flag_for_task,
    };

    state.0.lock().await.insert(session_id.clone(), handle);
    drop(capacity_reservation);
    let _ = reader_start_tx.send(());
    let _ = waiter_start_tx.send(());
    Ok(SpawnResponse {
        session_id,
        cwd: response_cwd,
        startup_command_consumed: launch.startup_command_consumed,
        process_binding,
    })
}

/// Validate an optional tool working directory before any terminal is queued.
#[tauri::command]
pub fn terminal_validate_directory(path: String) -> Result<String, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() || trimmed.contains('\0') {
        return Err("terminal: invalid project directory".to_string());
    }
    let metadata = std::fs::metadata(trimmed)
        .map_err(|_| "terminal: project directory does not exist".to_string())?;
    if !metadata.is_dir() {
        return Err("terminal: project path is not a directory".to_string());
    }
    Ok(trimmed.to_string())
}

/// Forward keystrokes (or any UTF-8 byte stream) into the PTY's stdin.
#[tauri::command]
pub async fn terminal_write(
    state: State<'_, TerminalState>,
    session_id: String,
    data: String,
) -> Result<(), String> {
    // Clone just the writer Arc out of the map so we don't hold the global
    // state lock across the actual I/O.
    let writer_arc = {
        let map = state.0.lock().await;
        let h = map
            .get(&session_id)
            .ok_or_else(|| format!("terminal: unknown session {session_id}"))?;
        h.writer.clone()
    };
    spawn_blocking(move || {
        let mut writer = writer_arc.blocking_lock();
        writer
            .write_all(data.as_bytes())
            .map_err(|e| format!("terminal: write failed: {e}"))?;
        writer
            .flush()
            .map_err(|e| format!("terminal: flush failed: {e}"))?;
        Ok::<(), String>(())
    })
    .await
    .map_err(|e| format!("terminal: spawn_blocking failed: {e}"))?
}

/// Tell the PTY about a new viewport size. The shell (and any TUI children)
/// will receive a `SIGWINCH` (or the ConPTY equivalent) and reflow.
#[tauri::command]
pub async fn terminal_resize(
    state: State<'_, TerminalState>,
    session_id: String,
    rows: u16,
    cols: u16,
) -> Result<(), String> {
    let master_arc = {
        let mut map = state.0.lock().await;
        let h = map
            .get_mut(&session_id)
            .ok_or_else(|| format!("terminal: unknown session {session_id}"))?;
        h.info.rows = rows;
        h.info.cols = cols;
        h.master.clone()
    };
    spawn_blocking(move || {
        let master = master_arc.blocking_lock();
        master
            .as_ref()
            .ok_or_else(|| "terminal: session already exited".to_string())?
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| format!("terminal: resize failed: {e}"))?;
        Ok::<(), String>(())
    })
    .await
    .map_err(|e| format!("terminal: spawn_blocking failed: {e}"))?
}

/// Request native signal delivery without removing the handle or aborting
/// the reader. Canonical cancellation requires the exact token stored at
/// spawn; tokenless callers retain the legacy/manual termination path.
#[tauri::command]
pub async fn terminal_kill(
    state: State<'_, TerminalState>,
    app: AppHandle,
    session_id: String,
    cancellation_token: Option<String>,
) -> Result<TerminalKillResult, String> {
    let request = validated_kill_request(cancellation_token)?;
    let target = {
        let map = state.0.lock().await;
        map.get(&session_id).map(KillTarget::from)
    };

    let Some(target) = target else {
        return Ok(TerminalKillResult::missing(request));
    };

    Ok(deliver_kill(&app, &state.0, target, request).await)
}

/// Reassign an active PTY to a different project without restarting the child.
/// The renderer uses this when a terminal tile is dragged onto another project.
#[tauri::command]
pub async fn terminal_move(
    state: State<'_, TerminalState>,
    session_id: String,
    project_id: Option<String>,
    project_name: Option<String>,
) -> Result<(), String> {
    let mut map = state.0.lock().await;
    let h = map
        .get_mut(&session_id)
        .ok_or_else(|| format!("terminal: unknown session {session_id}"))?;
    h.info.project_id = project_id;
    h.info.project_name = project_name;
    Ok(())
}

/// Snapshot of every active session — useful for restoring panes after a
/// reload or for diagnostics in the UI.
#[tauri::command]
pub async fn terminal_list(state: State<'_, TerminalState>) -> Result<Vec<TerminalInfo>, String> {
    let map = state.0.lock().await;
    Ok(map
        .values()
        .filter(|h| h.active.load(Ordering::SeqCst) && !h.deleted.load(Ordering::SeqCst))
        .map(|h| {
            let mut info = h.info.clone();
            info.deleted = h.deleted.load(Ordering::SeqCst);
            info
        })
        .collect())
}

/// Prune terminal sessions that are not listed in active_session_ids
#[tauri::command]
pub async fn terminal_reconcile(
    state: State<'_, TerminalState>,
    app: AppHandle,
    active_session_ids: Vec<String>,
) -> Result<(), String> {
    if active_session_ids.is_empty() {
        println!("[terminal] Skipping reconcile with empty active session list");
        return Ok(());
    }

    let targets: Vec<(String, KillTarget)> = {
        let map = state.0.lock().await;
        map.iter()
            .filter(|(session_id, _)| !active_session_ids.contains(session_id))
            .map(|(session_id, handle)| (session_id.clone(), KillTarget::from(handle)))
            .collect()
    };

    for (session_id, target) in targets {
        println!("[terminal] Killing orphaned PTY session: {}", session_id);
        let _ = deliver_kill(&app, &state.0, target, KillRequest::manual()).await;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::cell::RefCell;
    use std::collections::HashMap;

    use super::{
        build_process_binding, capture_process_binding, decode_terminal_bytes,
        default_terminal_cwd, emit_before_remove, native_process_started_at,
        process_started_at_from_filetime_ticks, terminal_launch_spec, valid_cancellation_token,
        validated_kill_request, ExitReason, KillRequest, KillRequestKind, KillResultKind,
        KillStart, LifecycleArbiter, NativeProcessBinding, SpawnResponse, TerminalInfo,
        TerminalKillResult, TerminalState, MAX_CANCELLATION_TOKEN_BYTES, WINDOWS_UNIX_EPOCH_100NS,
    };

    fn exit_process_binding() -> NativeProcessBinding {
        NativeProcessBinding {
            process_instance_id: "ptyproc_exit_fixture".to_string(),
            pid: 4242,
            process_started_at: 1_723_456_789_000,
            runtime_generation: "runtime-exit-fixture".to_string(),
        }
    }

    #[test]
    fn restart_gate_waits_for_in_flight_spawns_and_blocks_new_ones() {
        let state = TerminalState::default();
        let spawn = state.begin_spawn().expect("initial spawn should reserve");

        assert!(!state.commit_restart(std::time::Duration::ZERO));
        drop(spawn);
        assert!(state.commit_restart(std::time::Duration::ZERO));
        assert!(state.begin_spawn().is_err());

        state.cancel_restart();
        assert!(state.begin_spawn().is_ok());
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn powershell_startup_commands_launch_as_one_native_process() {
        let spec = terminal_launch_spec(
            Some("powershell.exe".to_string()),
            Some("Write-Output 'fixture'; exit".to_string()),
        )
        .expect("valid startup command");

        assert_eq!(spec.executable, "powershell.exe");
        assert_eq!(
            spec.arguments,
            [
                "-NoLogo",
                "-NoProfile",
                "-Command",
                "Write-Output 'fixture'; exit"
            ]
        );
        assert!(spec.startup_command_consumed);
    }

    #[test]
    fn terminal_startup_commands_reject_nul_before_process_creation() {
        assert!(terminal_launch_spec(None, Some("bad\0command".to_string())).is_err());
    }

    #[test]
    fn process_binding_serializes_complete_secret_free_contract() {
        let binding = build_process_binding(
            "native-runtime-fixture",
            Some(42),
            Some(12_345),
            "ptyproc_fixture",
        )
        .expect("valid process binding");

        let value = serde_json::to_value(binding).expect("serialize process binding");
        assert_eq!(
            value,
            serde_json::json!({
                "processInstanceId": "ptyproc_fixture",
                "pid": 42,
                "processStartedAt": 12_345,
                "runtimeGeneration": "native-runtime-fixture",
            })
        );
        let encoded = value.to_string();
        for forbidden in [
            "command",
            "argument",
            "environment",
            "transcript",
            "credential",
            "token",
        ] {
            assert!(!encoded.contains(forbidden));
        }
    }

    #[test]
    fn process_binding_rejects_missing_or_invalid_native_metadata() {
        let valid_started_at = 1;
        assert!(build_process_binding(
            "native-runtime-fixture",
            None,
            Some(valid_started_at),
            "ptyproc_fixture",
        )
        .is_err());
        assert!(build_process_binding(
            "native-runtime-fixture",
            Some(0),
            Some(valid_started_at),
            "ptyproc_fixture",
        )
        .is_err());
        assert!(
            build_process_binding("native-runtime-fixture", Some(42), None, "ptyproc_fixture",)
                .is_err()
        );
        assert!(process_started_at_from_filetime_ticks(WINDOWS_UNIX_EPOCH_100NS - 1).is_err());
        assert!(
            build_process_binding("", Some(42), Some(valid_started_at), "ptyproc_fixture").is_err()
        );
        assert!(build_process_binding(
            "native-runtime-fixture",
            Some(42),
            Some(valid_started_at),
            "",
        )
        .is_err());
        assert!(build_process_binding(
            "native-runtime-fixture",
            Some(42),
            Some(0),
            "ptyproc_fixture",
        )
        .is_err());
    }

    #[test]
    fn process_instances_are_distinct_within_one_runtime_generation() {
        let first =
            build_process_binding("native-runtime-fixture", Some(42), Some(2), "ptyproc_first")
                .expect("first binding");
        let second = build_process_binding(
            "native-runtime-fixture",
            Some(43),
            Some(2),
            "ptyproc_second",
        )
        .expect("second binding");

        assert_eq!(first.runtime_generation, second.runtime_generation);
        assert_ne!(first.process_instance_id, second.process_instance_id);
    }

    #[test]
    fn terminal_state_owns_one_deterministic_runtime_generation() {
        let state = TerminalState::with_runtime_generation_for_tests("native-runtime-fixture");
        let next = TerminalState::with_runtime_generation_for_tests("native-runtime-next");

        assert_eq!(state.runtime_generation(), "native-runtime-fixture");
        assert_eq!(state.runtime_generation(), state.runtime_generation());
        assert_ne!(state.runtime_generation(), next.runtime_generation());
    }

    #[test]
    fn spawn_and_list_wire_shapes_repeat_the_exact_process_binding() {
        let binding = build_process_binding(
            "native-runtime-fixture",
            Some(42),
            Some(3),
            "ptyproc_fixture",
        )
        .expect("valid binding");
        let response = SpawnResponse {
            session_id: "tty_fixture".to_string(),
            cwd: "C:\\fixture".to_string(),
            startup_command_consumed: true,
            process_binding: binding.clone(),
        };
        let info = TerminalInfo {
            session_id: "tty_fixture".to_string(),
            command: "powershell.exe".to_string(),
            cwd: "C:\\fixture".to_string(),
            rows: 30,
            cols: 100,
            started_at: 40,
            project_id: None,
            project_name: None,
            deleted: false,
            process_binding: binding,
        };

        let response = serde_json::to_value(response).expect("serialize spawn");
        let info = serde_json::to_value(info).expect("serialize list");
        for key in [
            "processInstanceId",
            "pid",
            "processStartedAt",
            "runtimeGeneration",
        ] {
            assert_eq!(
                response.get(key),
                info.get(key),
                "{key} must remain immutable"
            );
        }
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn windows_real_pty_binding_matches_the_live_child() {
        use portable_pty::{native_pty_system, CommandBuilder, PtySize};

        let pair = native_pty_system()
            .openpty(PtySize {
                rows: 10,
                cols: 40,
                pixel_width: 0,
                pixel_height: 0,
            })
            .expect("open disposable pty");
        let mut command = CommandBuilder::new("powershell.exe");
        command.args([
            "-NoLogo",
            "-NoProfile",
            "-Command",
            "Start-Sleep -Seconds 5",
        ]);
        let mut child = pair
            .slave
            .spawn_command(command)
            .expect("spawn disposable pty child");
        let expected_pid = child.process_id().expect("live child pid");
        let expected_started_at =
            native_process_started_at(child.as_ref()).expect("live child process creation time");

        let binding =
            capture_process_binding(child.as_ref(), "native-runtime-fixture", "ptyproc_fixture")
                .expect("capture live child binding");

        assert_eq!(binding.pid, expected_pid);
        assert_eq!(binding.process_started_at, expected_started_at);
        assert_eq!(binding.runtime_generation, "native-runtime-fixture");
        assert_eq!(binding.process_instance_id, "ptyproc_fixture");

        child.kill().expect("terminate disposable pty child");
        child.wait().expect("reap disposable pty child");
    }

    #[test]
    fn missing_kill_result_preserves_canonical_request_truth() {
        let result = TerminalKillResult::missing(KillRequest::canonical("cancel_missing"));

        assert_eq!(result.kind, KillResultKind::Missing);
        assert_eq!(result.request_kind, KillRequestKind::CanonicalCancellation);
        assert_eq!(result.cancellation_token.as_deref(), Some("cancel_missing"));
    }

    #[test]
    fn kill_after_reader_exit_is_already_exited() {
        let arbiter = LifecycleArbiter::new(
            "tty_exited",
            exit_process_binding(),
            Some("cancel_exited".to_string()),
        );
        let exit = arbiter
            .observe_exit(Some(0))
            .expect("reader should finalize a natural exit");

        let serialized = serde_json::to_value(&exit).expect("exit payload should serialize");
        assert_eq!(serialized["processInstanceId"], "ptyproc_exit_fixture");
        assert_eq!(serialized["pid"], 4242);
        assert_eq!(serialized["processStartedAt"], 1_723_456_789_000_u64);
        assert_eq!(serialized["runtimeGeneration"], "runtime-exit-fixture");

        assert_eq!(exit.reason, ExitReason::NaturalExit);
        match arbiter.begin_kill(KillRequest::canonical("cancel_exited")) {
            KillStart::Complete(result) => {
                assert_eq!(result.kind, KillResultKind::AlreadyExited);
                assert_eq!(result.cancellation_token.as_deref(), Some("cancel_exited"));
            }
            KillStart::Deliver(_) => panic!("an exited session must not deliver another signal"),
        }
    }

    #[test]
    fn wrong_or_stale_canonical_token_is_delivery_rejected() {
        let arbiter = LifecycleArbiter::new(
            "tty_token",
            exit_process_binding(),
            Some("cancel_current".to_string()),
        );

        match arbiter.begin_kill(KillRequest::canonical("cancel_stale")) {
            KillStart::Complete(result) => {
                assert_eq!(result.kind, KillResultKind::DeliveryRejected);
                assert_eq!(result.request_kind, KillRequestKind::CanonicalCancellation);
                assert_eq!(result.cancellation_token.as_deref(), Some("cancel_stale"));
            }
            KillStart::Deliver(_) => panic!("a stale token must not reach native delivery"),
        }
    }

    #[test]
    fn native_kill_error_is_delivery_rejected() {
        let arbiter = LifecycleArbiter::new(
            "tty_rejected",
            exit_process_binding(),
            Some("cancel_rejected".to_string()),
        );
        let attempt = match arbiter.begin_kill(KillRequest::canonical("cancel_rejected")) {
            KillStart::Deliver(attempt) => attempt,
            KillStart::Complete(_) => panic!("matching token should reserve native delivery"),
        };

        let completion = arbiter.complete_kill(attempt, false);

        assert_eq!(completion.result.kind, KillResultKind::DeliveryRejected);
        assert!(completion.exit.is_none());
    }

    #[test]
    fn successful_native_kill_is_signal_delivered() {
        let arbiter = LifecycleArbiter::new(
            "tty_delivered",
            exit_process_binding(),
            Some("cancel_delivered".to_string()),
        );
        let attempt = match arbiter.begin_kill(KillRequest::canonical("cancel_delivered")) {
            KillStart::Deliver(attempt) => attempt,
            KillStart::Complete(_) => panic!("matching token should reserve native delivery"),
        };

        let completion = arbiter.complete_kill(attempt, true);

        assert_eq!(completion.result.kind, KillResultKind::SignalDelivered);
        assert_eq!(
            completion.result.request_kind,
            KillRequestKind::CanonicalCancellation
        );
        assert_eq!(
            completion.result.cancellation_token.as_deref(),
            Some("cancel_delivered")
        );
        assert!(completion.exit.is_none());
    }

    #[test]
    fn exit_during_delivery_waits_for_accepted_cancellation_truth() {
        let arbiter = LifecycleArbiter::new(
            "tty_race",
            exit_process_binding(),
            Some("cancel_race".to_string()),
        );
        let attempt = match arbiter.begin_kill(KillRequest::canonical("cancel_race")) {
            KillStart::Deliver(attempt) => attempt,
            KillStart::Complete(_) => panic!("matching token should reserve native delivery"),
        };

        assert!(arbiter.observe_exit(Some(143)).is_none());
        let completion = arbiter.complete_kill(attempt, true);
        let exit = completion
            .exit
            .expect("delivery completion should release the held exit");

        assert_eq!(completion.result.kind, KillResultKind::SignalDelivered);
        assert_eq!(exit.reason, ExitReason::AcceptedCancellation);
        assert_eq!(exit.cancellation_token.as_deref(), Some("cancel_race"));
        assert_eq!(exit.code, Some(143));
    }

    #[test]
    fn exit_during_rejected_delivery_remains_natural() {
        let arbiter = LifecycleArbiter::new(
            "tty_race_rejected",
            exit_process_binding(),
            Some("cancel_race".to_string()),
        );
        let attempt = match arbiter.begin_kill(KillRequest::canonical("cancel_race")) {
            KillStart::Deliver(attempt) => attempt,
            KillStart::Complete(_) => panic!("matching token should reserve native delivery"),
        };

        assert!(arbiter.observe_exit(Some(0)).is_none());
        let completion = arbiter.complete_kill(attempt, false);
        let exit = completion
            .exit
            .expect("rejected delivery should release the held natural exit");

        assert_eq!(completion.result.kind, KillResultKind::DeliveryRejected);
        assert_eq!(exit.reason, ExitReason::NaturalExit);
        assert!(exit.cancellation_token.is_none());
    }

    #[test]
    fn tokenless_kill_is_manual_and_never_echoes_canonical_token() {
        let arbiter = LifecycleArbiter::new(
            "tty_manual",
            exit_process_binding(),
            Some("cancel_canonical".to_string()),
        );
        let attempt = match arbiter.begin_kill(KillRequest::manual()) {
            KillStart::Deliver(attempt) => attempt,
            KillStart::Complete(_) => panic!("manual termination should reserve native delivery"),
        };

        let completion = arbiter.complete_kill(attempt, true);
        assert_eq!(completion.result.kind, KillResultKind::SignalDelivered);
        assert_eq!(
            completion.result.request_kind,
            KillRequestKind::ManualTermination
        );
        assert!(completion.result.cancellation_token.is_none());

        let exit = arbiter
            .observe_exit(None)
            .expect("reader exit should finalize accepted manual termination");
        assert_eq!(exit.reason, ExitReason::ManualTermination);
        assert!(exit.cancellation_token.is_none());
    }

    #[test]
    fn arbiter_emits_exactly_one_exit_payload() {
        let arbiter = LifecycleArbiter::new("tty_once", exit_process_binding(), None);

        let first = arbiter.observe_exit(Some(0));
        let second = arbiter.observe_exit(Some(1));

        assert!(first.is_some());
        assert!(second.is_none());
    }

    #[test]
    fn reader_finalization_emits_before_session_map_removal() {
        let arbiter = LifecycleArbiter::new("tty_finalize", exit_process_binding(), None);
        let payload = arbiter
            .observe_exit(Some(0))
            .expect("reader should own natural finalization");
        let sessions = RefCell::new(HashMap::from([("tty_finalize".to_string(), ())]));
        let events = RefCell::new(Vec::new());

        emit_before_remove(
            &payload,
            |exit| {
                assert!(sessions.borrow().contains_key(&exit.session_id));
                events
                    .borrow_mut()
                    .push(format!("emit:{}", exit.session_id));
            },
            |session_id| {
                sessions.borrow_mut().remove(session_id);
                events.borrow_mut().push(format!("remove:{session_id}"));
            },
        );

        assert!(sessions.borrow().is_empty());
        assert_eq!(
            events.into_inner(),
            ["emit:tty_finalize", "remove:tty_finalize"].map(String::from)
        );
    }

    #[test]
    fn stale_exit_cannot_remove_a_same_session_replacement_process() {
        let exited = exit_process_binding();
        let mut replacement = exited.clone();
        replacement.process_instance_id = "ptyproc_replacement".to_string();

        assert!(super::should_remove_session(Some(&exited), &exited));
        assert!(!super::should_remove_session(Some(&replacement), &exited));
        assert!(!super::should_remove_session(None, &exited));
    }

    #[test]
    fn decode_terminal_bytes_holds_split_utf8_until_complete() {
        let mut pending = Vec::new();
        let icon = "⚡".as_bytes();

        assert_eq!(decode_terminal_bytes(&mut pending, &icon[..1]), None);
        assert_eq!(
            decode_terminal_bytes(&mut pending, &icon[1..]),
            Some("⚡".to_string()),
        );
        assert!(pending.is_empty());
    }

    #[test]
    fn default_terminal_cwd_prefers_user_profile() {
        let old_userprofile = std::env::var("USERPROFILE").ok();
        let old_home = std::env::var("HOME").ok();
        std::env::set_var("USERPROFILE", "C:\\Users\\JarvisTest");
        std::env::set_var("HOME", "/home/other");

        assert_eq!(default_terminal_cwd(), "C:\\Users\\JarvisTest");

        match old_userprofile {
            Some(value) => std::env::set_var("USERPROFILE", value),
            None => std::env::remove_var("USERPROFILE"),
        }
        match old_home {
            Some(value) => std::env::set_var("HOME", value),
            None => std::env::remove_var("HOME"),
        }
    }

    #[test]
    fn canonical_cancellation_tokens_are_bounded_and_stable() {
        assert!(valid_cancellation_token("jcancel_native_1"));
        assert!(!valid_cancellation_token(""));
        assert!(!valid_cancellation_token(" leading"));
        assert!(!valid_cancellation_token("trailing "));
        assert!(!valid_cancellation_token(
            &"x".repeat(MAX_CANCELLATION_TOKEN_BYTES + 1)
        ));
        assert!(!valid_cancellation_token("contains\0nul"));
    }

    #[test]
    fn kill_requests_reject_malformed_tokens_before_native_delivery() {
        assert!(validated_kill_request(Some("".to_string())).is_err());
        assert!(validated_kill_request(Some(" stale".to_string())).is_err());
        assert!(
            validated_kill_request(Some("x".repeat(MAX_CANCELLATION_TOKEN_BYTES + 1))).is_err()
        );
        assert_eq!(
            validated_kill_request(None).expect("manual request").kind,
            KillRequestKind::ManualTermination
        );
        assert_eq!(
            validated_kill_request(Some("jcancel_native_1".to_string()))
                .expect("canonical request")
                .kind,
            KillRequestKind::CanonicalCancellation
        );
    }

    #[test]
    fn decode_terminal_bytes_emits_valid_prefix_before_pending_tail() {
        let mut pending = Vec::new();
        let icon = "⚡".as_bytes();

        assert_eq!(
            decode_terminal_bytes(&mut pending, &[b'O', b'K', icon[0]]),
            Some("OK".to_string()),
        );
        assert_eq!(
            decode_terminal_bytes(&mut pending, &icon[1..]),
            Some("⚡".to_string()),
        );
    }
}
