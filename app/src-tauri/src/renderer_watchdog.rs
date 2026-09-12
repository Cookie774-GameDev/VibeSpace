use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{Listener, Manager, Runtime, WebviewWindowBuilder, WindowBuilder};
#[cfg(windows)]
use webview2_com::Microsoft::Web::WebView2::Win32::*;
#[cfg(windows)]
use webview2_com::ProcessFailedEventHandler;
#[cfg(windows)]
use windows::core::{Interface, BOOL};
#[cfg(windows)]
use windows::Win32::Foundation::{HWND, LPARAM};
#[cfg(windows)]
use windows::Win32::UI::WindowsAndMessaging::{EnumWindows, GetWindowThreadProcessId, IsWindow};

const RENDERER_HEARTBEAT_EVENT: &str = "jarvis:renderer-heartbeat";
const WATCHDOG_INTERVAL: Duration = Duration::from_secs(5);
const RENDERER_STALE_AFTER: Duration = Duration::from_secs(30);
const RECOVERY_RETRY_AFTER: Duration = Duration::from_secs(20);
const MAX_WEBVIEW_RELOADS: u8 = 2;
const MAX_WEBVIEW_RECREATIONS_WHILE_RESTART_BLOCKED: u8 = 3;
const PROCESS_UNRESPONSIVE_DEBOUNCE: Duration = Duration::from_secs(30);
const PROCESS_FAILURE_REGISTRATION_RETRY_AFTER: Duration = Duration::from_secs(20);
const MAX_PROCESS_FAILURE_REGISTRATION_ATTEMPTS: u8 = 3;
const PROCESS_FAILURE_GENERATION_MASK: u64 = (1_u64 << 56) - 1;
const RESTART_CIRCUIT_HEALTHY_AFTER: Duration = Duration::from_secs(60);
const TERMINAL_RESTART_GATE_TIMEOUT: Duration = Duration::from_secs(5);
const WEBVIEW_RECREATE_TIMEOUT: Duration = Duration::from_secs(15);
const MAIN_LABEL_RELEASE_TIMEOUT: Duration = Duration::from_secs(5);
const MAIN_LABEL_RELEASE_POLL: Duration = Duration::from_millis(25);
const NATIVE_WINDOW_ACK_TIMEOUT: Duration = Duration::from_secs(5);
const PRESENTATION_VERIFY_TIMEOUT: Duration = Duration::from_secs(5);
const RECOVERY_LIFECYCLE_GUARD_LABEL: &str = "renderer-recovery-guard";
const RECOVERY_MARKER_FILE: &str = "renderer-recovery.marker";
const RECOVERY_CIRCUIT_FILE: &str = "renderer-recovery-circuit.marker";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum RecoveryAction {
    None,
    ReloadWebview,
    RecreateWebview,
    RestartApplication,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum RecoveryReason {
    HeartbeatStale,
    MainWebviewMissing,
    WebviewReloadFailed,
    BrowserProcessExited,
    RendererProcessFailed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum RecoveryResult {
    Scheduled,
    Failed,
}

impl RecoveryResult {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Scheduled => "scheduled",
            Self::Failed => "failed",
        }
    }
}

impl RecoveryReason {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::HeartbeatStale => "heartbeat_stale",
            Self::MainWebviewMissing => "main_webview_missing",
            Self::WebviewReloadFailed => "webview_reload_failed",
            Self::BrowserProcessExited => "browser_process_exited",
            Self::RendererProcessFailed => "renderer_process_failed",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ProcessFailureClass {
    BrowserProcessExited,
    RendererProcessExited,
    RendererUnresponsive,
    GpuProcessExited,
    UtilityProcessExited,
    FrameRenderProcessExited,
    Other,
}

impl ProcessFailureClass {
    fn as_str(self) -> &'static str {
        match self {
            Self::BrowserProcessExited => "browser_process_exited",
            Self::RendererProcessExited => "renderer_process_exited",
            Self::RendererUnresponsive => "renderer_unresponsive",
            Self::GpuProcessExited => "gpu_process_exited",
            Self::UtilityProcessExited => "utility_process_exited",
            Self::FrameRenderProcessExited => "frame_render_process_exited",
            Self::Other => "other",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ProcessFailureReason {
    Crashed,
    LaunchFailed,
    OutOfMemory,
    ProfileDeleted,
    Terminated,
    Unexpected,
    Unresponsive,
    Other,
}

impl ProcessFailureReason {
    fn as_str(self) -> &'static str {
        match self {
            Self::Crashed => "crashed",
            Self::LaunchFailed => "launch_failed",
            Self::OutOfMemory => "out_of_memory",
            Self::ProfileDeleted => "profile_deleted",
            Self::Terminated => "terminated",
            Self::Unexpected => "unexpected",
            Self::Unresponsive => "unresponsive",
            Self::Other => "other",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct ProcessFailureSignal {
    class: ProcessFailureClass,
    reason: ProcessFailureReason,
}

#[derive(Default)]
pub(crate) struct ProcessFailureRegistrationState {
    generation: u64,
    registration: Option<(u64, i64)>,
    pending_handler_removals: Vec<i64>,
    teardown_generation_invalidated: bool,
    registration_attempts: u8,
    last_registration_attempt: Option<Instant>,
    pending_recovery: Option<ProcessFailureSignal>,
    pending_diagnostic: Option<ProcessFailureSignal>,
    last_unresponsive_at: Option<Instant>,
}

impl ProcessFailureRegistrationState {
    fn advance_generation(&mut self) -> u64 {
        self.generation = self.generation.wrapping_add(1) & PROCESS_FAILURE_GENERATION_MASK;
        self.generation = self.generation.max(1);
        self.generation
    }

    pub(crate) fn begin_registration(&mut self) -> u64 {
        let generation = self.advance_generation();
        generation
    }

    pub(crate) fn commit_registration(&mut self, generation: u64, token: i64) -> bool {
        if self.generation != generation
            || self.registration.is_some()
            || !self.pending_handler_removals.is_empty()
        {
            return false;
        }
        self.registration = Some((generation, token));
        self.registration_attempts = 0;
        self.last_registration_attempt = None;
        true
    }

    pub(crate) fn begin_teardown(&mut self) -> Option<i64> {
        if !self.teardown_generation_invalidated {
            self.advance_generation();
            self.pending_recovery = None;
            self.pending_diagnostic = None;
            self.last_unresponsive_at = None;
            self.teardown_generation_invalidated = true;
            if let Some((_, token)) = self.registration.take() {
                self.retain_superseded_handler(token);
            }
        }
        self.pending_handler_removals.first().copied()
    }

    pub(crate) fn retain_superseded_handler(&mut self, token: i64) {
        if !self.pending_handler_removals.contains(&token) {
            self.pending_handler_removals.push(token);
        }
    }

    pub(crate) fn pending_handler_removals(&self) -> Vec<i64> {
        self.pending_handler_removals.clone()
    }

    pub(crate) fn commit_handler_removal(&mut self, token: i64) -> bool {
        let Some(index) = self
            .pending_handler_removals
            .iter()
            .position(|pending| *pending == token)
        else {
            return false;
        };
        self.pending_handler_removals.remove(index);
        if self.pending_handler_removals.is_empty() {
            self.teardown_generation_invalidated = false;
        }
        true
    }

    pub(crate) fn handler_removal_blocks_destroy(&self) -> bool {
        !self.pending_handler_removals.is_empty()
    }

    pub(crate) fn record_registration_attempt(&mut self, attempted_at: Instant) {
        self.registration_attempts = self.registration_attempts.saturating_add(1);
        self.last_registration_attempt = Some(attempted_at);
    }

    pub(crate) fn registration_retry_due(&self, has_webview: bool, now: Instant) -> bool {
        has_webview
            && (self.registration.is_none() || !self.pending_handler_removals.is_empty())
            && self.registration_attempts < MAX_PROCESS_FAILURE_REGISTRATION_ATTEMPTS
            && self
                .last_registration_attempt
                .map(|last| {
                    now.saturating_duration_since(last) >= PROCESS_FAILURE_REGISTRATION_RETRY_AFTER
                })
                .unwrap_or(true)
    }

    pub(crate) fn has_pending_handler_removals(&self) -> bool {
        !self.pending_handler_removals.is_empty()
    }

    pub(crate) fn has_registration(&self) -> bool {
        self.registration.is_some()
    }

    pub(crate) fn pending_recovery(&self) -> Option<ProcessFailureSignal> {
        self.pending_recovery
    }

    pub(crate) fn consume_recovery(&mut self, expected: ProcessFailureSignal) {
        if self.pending_recovery == Some(expected) {
            self.pending_recovery = None;
        }
    }

    fn take_diagnostic(&mut self) -> Option<ProcessFailureSignal> {
        self.pending_diagnostic.take()
    }
}

fn process_failure_signal_code(signal: ProcessFailureSignal) -> u8 {
    let class = match signal.class {
        ProcessFailureClass::BrowserProcessExited => 0xE,
        ProcessFailureClass::RendererProcessExited => 0xD,
        ProcessFailureClass::RendererUnresponsive => 0xC,
        ProcessFailureClass::GpuProcessExited => 0x4,
        ProcessFailureClass::UtilityProcessExited => 0x3,
        ProcessFailureClass::FrameRenderProcessExited => 0x2,
        ProcessFailureClass::Other => 0x1,
    };
    let reason = match signal.reason {
        ProcessFailureReason::Crashed => 0,
        ProcessFailureReason::LaunchFailed => 1,
        ProcessFailureReason::OutOfMemory => 2,
        ProcessFailureReason::ProfileDeleted => 3,
        ProcessFailureReason::Terminated => 4,
        ProcessFailureReason::Unexpected => 5,
        ProcessFailureReason::Unresponsive => 6,
        ProcessFailureReason::Other => 7,
    };
    (class << 4) | reason
}

fn process_failure_signal_from_code(code: u8) -> Option<ProcessFailureSignal> {
    let class = match code >> 4 {
        0xE => ProcessFailureClass::BrowserProcessExited,
        0xD => ProcessFailureClass::RendererProcessExited,
        0xC => ProcessFailureClass::RendererUnresponsive,
        0x4 => ProcessFailureClass::GpuProcessExited,
        0x3 => ProcessFailureClass::UtilityProcessExited,
        0x2 => ProcessFailureClass::FrameRenderProcessExited,
        0x1 => ProcessFailureClass::Other,
        _ => return None,
    };
    let reason = match code & 0xF {
        0 => ProcessFailureReason::Crashed,
        1 => ProcessFailureReason::LaunchFailed,
        2 => ProcessFailureReason::OutOfMemory,
        3 => ProcessFailureReason::ProfileDeleted,
        4 => ProcessFailureReason::Terminated,
        5 => ProcessFailureReason::Unexpected,
        6 => ProcessFailureReason::Unresponsive,
        _ => ProcessFailureReason::Other,
    };
    Some(ProcessFailureSignal { class, reason })
}

fn encode_process_failure(generation: u64, signal: ProcessFailureSignal) -> u64 {
    ((generation & PROCESS_FAILURE_GENERATION_MASK) << 8)
        | u64::from(process_failure_signal_code(signal))
}

fn decode_process_failure(encoded: u64) -> Option<(u64, ProcessFailureSignal)> {
    if encoded == 0 {
        return None;
    }
    let generation = (encoded >> 8) & PROCESS_FAILURE_GENERATION_MASK;
    process_failure_signal_from_code(encoded as u8).map(|signal| (generation, signal))
}

pub(crate) fn process_failure_recovery_reason(
    signal: ProcessFailureSignal,
) -> Option<RecoveryReason> {
    match signal.class {
        ProcessFailureClass::BrowserProcessExited => Some(RecoveryReason::BrowserProcessExited),
        ProcessFailureClass::RendererProcessExited | ProcessFailureClass::RendererUnresponsive => {
            Some(RecoveryReason::RendererProcessFailed)
        }
        ProcessFailureClass::GpuProcessExited
        | ProcessFailureClass::UtilityProcessExited
        | ProcessFailureClass::FrameRenderProcessExited
        | ProcessFailureClass::Other => None,
    }
}

pub(crate) fn record_process_failure(
    state: &mut ProcessFailureRegistrationState,
    generation: u64,
    signal: ProcessFailureSignal,
    observed_at: Instant,
) -> bool {
    if generation != state.generation
        || state
            .registration
            .map(|(registered_generation, _)| registered_generation)
            != Some(generation)
    {
        return false;
    }
    if signal.class == ProcessFailureClass::RendererUnresponsive {
        if state
            .last_unresponsive_at
            .map(|previous| {
                observed_at.saturating_duration_since(previous) < PROCESS_UNRESPONSIVE_DEBOUNCE
            })
            .unwrap_or(false)
        {
            return false;
        }
        state.last_unresponsive_at = Some(observed_at);
    }
    if process_failure_recovery_reason(signal).is_some() {
        let replace_pending = match state.pending_recovery {
            Some(existing) => {
                existing.class != ProcessFailureClass::BrowserProcessExited
                    || signal.class == ProcessFailureClass::BrowserProcessExited
            }
            None => true,
        };
        if replace_pending {
            state.pending_recovery = Some(signal);
        }
    } else {
        state.pending_diagnostic = Some(signal);
    }
    true
}

#[cfg(windows)]
fn process_failure_class(kind: COREWEBVIEW2_PROCESS_FAILED_KIND) -> ProcessFailureClass {
    match kind {
        COREWEBVIEW2_PROCESS_FAILED_KIND_BROWSER_PROCESS_EXITED => {
            ProcessFailureClass::BrowserProcessExited
        }
        COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_EXITED => {
            ProcessFailureClass::RendererProcessExited
        }
        COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_UNRESPONSIVE => {
            ProcessFailureClass::RendererUnresponsive
        }
        COREWEBVIEW2_PROCESS_FAILED_KIND_GPU_PROCESS_EXITED => {
            ProcessFailureClass::GpuProcessExited
        }
        COREWEBVIEW2_PROCESS_FAILED_KIND_UTILITY_PROCESS_EXITED => {
            ProcessFailureClass::UtilityProcessExited
        }
        COREWEBVIEW2_PROCESS_FAILED_KIND_FRAME_RENDER_PROCESS_EXITED => {
            ProcessFailureClass::FrameRenderProcessExited
        }
        _ => ProcessFailureClass::Other,
    }
}

#[cfg(windows)]
fn process_failure_reason(reason: COREWEBVIEW2_PROCESS_FAILED_REASON) -> ProcessFailureReason {
    match reason {
        COREWEBVIEW2_PROCESS_FAILED_REASON_CRASHED => ProcessFailureReason::Crashed,
        COREWEBVIEW2_PROCESS_FAILED_REASON_LAUNCH_FAILED => ProcessFailureReason::LaunchFailed,
        COREWEBVIEW2_PROCESS_FAILED_REASON_OUT_OF_MEMORY => ProcessFailureReason::OutOfMemory,
        COREWEBVIEW2_PROCESS_FAILED_REASON_PROFILE_DELETED => ProcessFailureReason::ProfileDeleted,
        COREWEBVIEW2_PROCESS_FAILED_REASON_TERMINATED => ProcessFailureReason::Terminated,
        COREWEBVIEW2_PROCESS_FAILED_REASON_UNEXPECTED => ProcessFailureReason::Unexpected,
        COREWEBVIEW2_PROCESS_FAILED_REASON_UNRESPONSIVE => ProcessFailureReason::Unresponsive,
        _ => ProcessFailureReason::Other,
    }
}

#[cfg(windows)]
fn process_failure_signal(
    args: Option<ICoreWebView2ProcessFailedEventArgs>,
) -> Option<ProcessFailureSignal> {
    let args = args?;
    let mut kind = COREWEBVIEW2_PROCESS_FAILED_KIND::default();
    unsafe { args.ProcessFailedKind(&mut kind) }.ok()?;
    let reason = args
        .cast::<ICoreWebView2ProcessFailedEventArgs2>()
        .ok()
        .and_then(|args2| {
            let mut reason = COREWEBVIEW2_PROCESS_FAILED_REASON::default();
            unsafe { args2.Reason(&mut reason) }.ok().map(|_| reason)
        })
        .map(process_failure_reason)
        .unwrap_or(ProcessFailureReason::Other);
    Some(ProcessFailureSignal {
        class: process_failure_class(kind),
        reason,
    })
}

#[cfg(windows)]
fn register_process_failed_handler<R: Runtime>(
    webview: &tauri::Webview<R>,
    state: Arc<RendererWatchdog>,
) -> Result<(), String> {
    remove_pending_process_failed_handlers(Some(webview), Arc::clone(&state))?;
    let generation = {
        let mut failure = state
            .process_failure
            .lock()
            .map_err(|_| "process-failure registration state unavailable".to_string())?;
        failure.record_registration_attempt(Instant::now());
        failure.begin_registration()
    };
    state
        .process_failure_generation
        .store(generation, Ordering::Release);
    state.pending_process_failure.store(0, Ordering::Release);
    let callback_state = Arc::clone(&state);
    let (result_tx, result_rx) = std::sync::mpsc::sync_channel(1);
    webview
        .with_webview(move |platform_webview| {
            let result = (|| -> Result<(), String> {
                let core = unsafe { platform_webview.controller().CoreWebView2() }
                    .map_err(|_| "core-webview unavailable".to_string())?;
                let handler = ProcessFailedEventHandler::create(Box::new(move |_, args| {
                    if let Some(signal) = process_failure_signal(args) {
                        if callback_state
                            .process_failure_generation
                            .load(Ordering::Acquire)
                            == generation
                        {
                            callback_state.pending_process_failure.fetch_max(
                                encode_process_failure(generation, signal),
                                Ordering::AcqRel,
                            );
                        }
                    }
                    Ok(())
                }));
                let mut token = 0;
                unsafe { core.add_ProcessFailed(&handler, &mut token) }
                    .map_err(|_| "process-failure handler registration failed".to_string())?;
                let committed = state
                    .process_failure
                    .lock()
                    .map(|mut failure| failure.commit_registration(generation, token))
                    .unwrap_or(false);
                if !committed {
                    state
                        .process_failure
                        .lock()
                        .map_err(|_| "process-failure registration state unavailable".to_string())?
                        .retain_superseded_handler(token);
                    unsafe { core.remove_ProcessFailed(token) }.map_err(|_| {
                        "superseded process-failure handler removal failed".to_string()
                    })?;
                    let removed = state
                        .process_failure
                        .lock()
                        .map(|mut failure| failure.commit_handler_removal(token))
                        .unwrap_or(false);
                    if !removed {
                        return Err(
                            "superseded process-failure removal state unavailable".to_string()
                        );
                    }
                    return Err("process-failure registration superseded".to_string());
                }
                Ok(())
            })();
            let _ = result_tx.send(result);
        })
        .map_err(|_| "process-failure registration scheduling failed".to_string())?;
    result_rx
        .recv_timeout(WEBVIEW_RECREATE_TIMEOUT)
        .map_err(|_| "process-failure registration timed out".to_string())?
}

#[cfg(windows)]
fn remove_pending_process_failed_handlers<R: Runtime>(
    webview: Option<&tauri::Webview<R>>,
    state: Arc<RendererWatchdog>,
) -> Result<(), String> {
    let tokens = state
        .process_failure
        .lock()
        .map_err(|_| "process-failure registration state unavailable".to_string())?
        .pending_handler_removals();
    if tokens.is_empty() {
        return Ok(());
    }
    let Some(webview) = webview else {
        return Err("process-failure handler removal requires the registered WebView".to_string());
    };
    for token in tokens {
        let callback_state = Arc::clone(&state);
        let (result_tx, result_rx) = std::sync::mpsc::sync_channel(1);
        webview
            .with_webview(move |platform_webview| {
                let result = (|| -> Result<(), String> {
                    let core = unsafe { platform_webview.controller().CoreWebView2() }
                        .map_err(|_| "core-webview unavailable".to_string())?;
                    unsafe { core.remove_ProcessFailed(token) }
                        .map_err(|_| "process-failure handler removal failed".to_string())?;
                    let committed = callback_state
                        .process_failure
                        .lock()
                        .map(|mut failure| failure.commit_handler_removal(token))
                        .unwrap_or(false);
                    if !committed {
                        return Err("process-failure removal state unavailable".to_string());
                    }
                    Ok(())
                })();
                let _ = result_tx.send(result);
            })
            .map_err(|_| "process-failure removal scheduling failed".to_string())?;
        result_rx
            .recv_timeout(WEBVIEW_RECREATE_TIMEOUT)
            .map_err(|_| "process-failure removal timed out".to_string())??;
    }
    Ok(())
}

#[cfg(windows)]
fn remove_process_failed_handler<R: Runtime>(
    webview: Option<&tauri::Webview<R>>,
    state: Arc<RendererWatchdog>,
) -> Result<(), String> {
    let generation = {
        let mut failure = state
            .process_failure
            .lock()
            .map_err(|_| "process-failure registration state unavailable".to_string())?;
        failure.begin_teardown();
        failure.generation
    };
    state
        .process_failure_generation
        .store(generation, Ordering::Release);
    state.pending_process_failure.store(0, Ordering::Release);
    remove_pending_process_failed_handlers(webview, state)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum MainWebviewRecoveryPlan {
    ReloadExisting,
    ReplaceOrphanedHost,
    RebuildMissing,
}

pub(crate) fn main_webview_recovery_plan(
    has_host_window: bool,
    has_webview: bool,
    replace_existing_webview: bool,
) -> MainWebviewRecoveryPlan {
    if has_webview && !replace_existing_webview {
        MainWebviewRecoveryPlan::ReloadExisting
    } else if has_host_window {
        MainWebviewRecoveryPlan::ReplaceOrphanedHost
    } else {
        MainWebviewRecoveryPlan::RebuildMissing
    }
}

#[cfg(test)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum OrphanReplacementStep {
    CreateLifecycleGuard,
    RemoveHandlerAndRequestDestroy,
    AwaitMainLabelRelease,
    BuildMain,
    DestroyLifecycleGuard,
}

#[cfg(test)]
pub(crate) fn next_orphan_replacement_step(
    has_lifecycle_guard: bool,
    has_main: bool,
    main_destroy_requested: bool,
    main_rebuilt: bool,
) -> OrphanReplacementStep {
    if !has_lifecycle_guard {
        OrphanReplacementStep::CreateLifecycleGuard
    } else if main_rebuilt {
        OrphanReplacementStep::DestroyLifecycleGuard
    } else if has_main && !main_destroy_requested {
        OrphanReplacementStep::RemoveHandlerAndRequestDestroy
    } else if has_main {
        OrphanReplacementStep::AwaitMainLabelRelease
    } else {
        OrphanReplacementStep::BuildMain
    }
}

#[derive(Debug)]
struct RecoveryProgress {
    reload_attempts: u8,
    recreate_attempts: u8,
    last_action_at: Option<Instant>,
}

fn record_recovery_result(
    recovery: &mut RecoveryProgress,
    action: RecoveryAction,
    _result: RecoveryResult,
    completed_at: Instant,
) {
    match action {
        RecoveryAction::ReloadWebview => {
            recovery.reload_attempts = recovery.reload_attempts.saturating_add(1);
        }
        RecoveryAction::RecreateWebview => {
            recovery.recreate_attempts = recovery.recreate_attempts.saturating_add(1);
        }
        RecoveryAction::RestartApplication | RecoveryAction::None => {}
    }
    if action != RecoveryAction::None {
        recovery.last_action_at = Some(completed_at);
    }
}

struct RendererWatchdog {
    last_heartbeat: Mutex<Instant>,
    heartbeat_received: AtomicBool,
    recovery: Mutex<RecoveryProgress>,
    process_restart_allowed: AtomicBool,
    webview_reload_failed: AtomicBool,
    process_failure: Mutex<ProcessFailureRegistrationState>,
    process_failure_generation: AtomicU64,
    pending_process_failure: AtomicU64,
    healthy_since: Mutex<Option<Instant>>,
    native_recovery_generation: AtomicU64,
    native_recovery: Mutex<Option<NativeRecoveryLifecycle>>,
}

impl RendererWatchdog {
    fn new(process_restart_allowed: bool) -> Self {
        Self {
            last_heartbeat: Mutex::new(Instant::now()),
            heartbeat_received: AtomicBool::new(false),
            recovery: Mutex::new(RecoveryProgress {
                reload_attempts: 0,
                recreate_attempts: 0,
                last_action_at: None,
            }),
            process_restart_allowed: AtomicBool::new(process_restart_allowed),
            webview_reload_failed: AtomicBool::new(false),
            process_failure: Mutex::new(ProcessFailureRegistrationState::default()),
            process_failure_generation: AtomicU64::new(0),
            pending_process_failure: AtomicU64::new(0),
            healthy_since: Mutex::new(None),
            native_recovery_generation: AtomicU64::new(0),
            native_recovery: Mutex::new(None),
        }
    }

    fn record_heartbeat(&self) -> bool {
        self.heartbeat_received.store(true, Ordering::SeqCst);
        self.webview_reload_failed.store(false, Ordering::SeqCst);
        if let Ok(mut heartbeat) = self.last_heartbeat.lock() {
            *heartbeat = Instant::now();
        }
        if let Ok(mut recovery) = self.recovery.lock() {
            recovery.reload_attempts = 0;
            recovery.recreate_attempts = 0;
            recovery.last_action_at = None;
        }
        if self.process_restart_allowed.load(Ordering::SeqCst) {
            return false;
        }
        let Ok(mut healthy_since) = self.healthy_since.lock() else {
            return false;
        };
        let elapsed = healthy_since.map(|started| started.elapsed());
        if should_rearm_process_restart(elapsed) {
            *healthy_since = None;
            self.process_restart_allowed.store(true, Ordering::SeqCst);
            true
        } else {
            healthy_since.get_or_insert_with(Instant::now);
            false
        }
    }

    fn heartbeat_age(&self) -> Option<Duration> {
        if !self.heartbeat_received.load(Ordering::SeqCst) {
            return None;
        }
        self.last_heartbeat
            .lock()
            .ok()
            .map(|heartbeat| heartbeat.elapsed())
    }
}

pub(crate) fn should_rearm_process_restart(healthy_for: Option<Duration>) -> bool {
    healthy_for
        .map(|elapsed| elapsed >= RESTART_CIRCUIT_HEALTHY_AFTER)
        .unwrap_or(false)
}

pub(crate) fn should_restart_renderer(
    heartbeat_age: Duration,
    visible: bool,
    focused: bool,
) -> bool {
    heartbeat_age > RENDERER_STALE_AFTER && visible && focused
}

pub(crate) fn should_check_stale_renderer(previously_focused: bool, focused: bool) -> bool {
    previously_focused && focused
}

pub(crate) fn renderer_recovery_reason(
    heartbeat_age: Duration,
    visible: bool,
    focused: bool,
    has_webview: bool,
    webview_reload_failed: bool,
) -> Option<RecoveryReason> {
    if visible && !has_webview {
        Some(RecoveryReason::MainWebviewMissing)
    } else if visible && webview_reload_failed {
        Some(RecoveryReason::WebviewReloadFailed)
    } else if should_restart_renderer(heartbeat_age, visible, focused) {
        Some(RecoveryReason::HeartbeatStale)
    } else {
        None
    }
}

pub(crate) fn next_recovery_action_for_reason(
    reason: Option<RecoveryReason>,
    reload_attempts: u8,
    recreate_attempts: u8,
    time_since_last_action: Option<Duration>,
    allow_process_restart: bool,
) -> RecoveryAction {
    let Some(reason) = reason else {
        return RecoveryAction::None;
    };
    if time_since_last_action
        .map(|elapsed| elapsed < RECOVERY_RETRY_AFTER)
        .unwrap_or(false)
    {
        return RecoveryAction::None;
    }
    if matches!(
        reason,
        RecoveryReason::MainWebviewMissing
            | RecoveryReason::WebviewReloadFailed
            | RecoveryReason::BrowserProcessExited
    ) {
        if recreate_attempts < MAX_WEBVIEW_RECREATIONS_WHILE_RESTART_BLOCKED {
            return RecoveryAction::RecreateWebview;
        }
        return if allow_process_restart {
            RecoveryAction::RestartApplication
        } else {
            RecoveryAction::None
        };
    }
    if reload_attempts < MAX_WEBVIEW_RELOADS {
        RecoveryAction::ReloadWebview
    } else if recreate_attempts == 0 {
        RecoveryAction::RecreateWebview
    } else if allow_process_restart {
        RecoveryAction::RestartApplication
    } else if recreate_attempts < MAX_WEBVIEW_RECREATIONS_WHILE_RESTART_BLOCKED {
        RecoveryAction::RecreateWebview
    } else {
        RecoveryAction::None
    }
}

pub(crate) fn next_recovery_action(
    heartbeat_age: Duration,
    visible: bool,
    focused: bool,
    reload_attempts: u8,
    recreate_attempts: u8,
    time_since_last_action: Option<Duration>,
    allow_process_restart: bool,
) -> RecoveryAction {
    let reason = should_restart_renderer(heartbeat_age, visible, focused)
        .then_some(RecoveryReason::HeartbeatStale);
    next_recovery_action_for_reason(
        reason,
        reload_attempts,
        recreate_attempts,
        time_since_last_action,
        allow_process_restart,
    )
}

fn native_recovery_resume_action(
    has_incomplete_recovery: bool,
    time_since_last_action: Option<Duration>,
) -> Option<RecoveryAction> {
    if !has_incomplete_recovery {
        return None;
    }
    if time_since_last_action
        .map(|elapsed| elapsed < RECOVERY_RETRY_AFTER)
        .unwrap_or(false)
    {
        Some(RecoveryAction::None)
    } else {
        Some(RecoveryAction::RecreateWebview)
    }
}

fn should_evaluate_recovery(
    has_heartbeat: bool,
    has_process_signal: bool,
    has_incomplete_recovery: bool,
    has_webview: bool,
) -> bool {
    has_heartbeat || has_process_signal || has_incomplete_recovery || !has_webview
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct MainWindowPresentation {
    position: Option<tauri::PhysicalPosition<i32>>,
    size: Option<tauri::PhysicalSize<u32>>,
    maximized: bool,
    fullscreen: bool,
    minimized: bool,
    visible: bool,
    focused: bool,
}

impl MainWindowPresentation {
    #[cfg(test)]
    fn test_value(minimized: bool, visible: bool, focused: bool) -> Self {
        Self {
            position: Some(tauri::PhysicalPosition::new(40, 50)),
            size: Some(tauri::PhysicalSize::new(900, 700)),
            maximized: false,
            fullscreen: false,
            minimized,
            visible,
            focused,
        }
    }
}

fn capture_main_window_presentation<R: Runtime>(
    window: &tauri::Window<R>,
) -> Result<MainWindowPresentation, &'static str> {
    Ok(MainWindowPresentation {
        position: Some(
            window
                .outer_position()
                .map_err(|_| "position_capture_failed")?,
        ),
        size: Some(window.inner_size().map_err(|_| "size_capture_failed")?),
        maximized: window
            .is_maximized()
            .map_err(|_| "maximized_capture_failed")?,
        fullscreen: window
            .is_fullscreen()
            .map_err(|_| "fullscreen_capture_failed")?,
        minimized: window
            .is_minimized()
            .map_err(|_| "minimized_capture_failed")?,
        visible: window
            .is_visible()
            .map_err(|_| "visibility_capture_failed")?,
        focused: window.is_focused().map_err(|_| "focus_capture_failed")?,
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum NativeRecoveryPhase {
    AwaitGuardNative,
    DestroyMain,
    AwaitMainAbsent,
    BuildMain,
    RegisterHandler,
    RestorePresentation,
    DestroyGuard,
    VerifyGuardAbsent,
    Complete,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum NativeRecoveryStage {
    GuardCreated,
    DestroyDispatched,
    MainUnregistered,
    MainBuilt,
    HandlerRegistered,
    PresentationRestored,
    GuardDestroyed,
}

impl NativeRecoveryStage {
    fn as_str(self) -> &'static str {
        match self {
            Self::GuardCreated => "guard_created",
            Self::DestroyDispatched => "destroy_dispatched",
            Self::MainUnregistered => "main_unregistered",
            Self::MainBuilt => "main_built",
            Self::HandlerRegistered => "handler_registered",
            Self::PresentationRestored => "presentation_restored",
            Self::GuardDestroyed => "guard_destroyed",
        }
    }
}

fn native_recovery_stage_vector(stages: &[NativeRecoveryStage]) -> String {
    stages
        .iter()
        .map(|stage| stage.as_str())
        .collect::<Vec<_>>()
        .join(",")
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum NativeRecoveryObservation {
    GuardLogicalOnly,
    GuardNativeReady { hwnd: isize, native_windows: usize },
    MainDestroyDispatched,
    MainAbsent { native_windows: usize },
    MainBuildFailed,
    MainBuilt { native_windows: usize },
    HandlerFailed,
    HandlerRegistered { native_windows: usize },
    PresentationFailed,
    PresentationVerified { native_windows: usize },
    GuardDestroyFailed,
    GuardDestroyDispatched,
    GuardStillPresent,
    GuardAbsent { native_windows: usize },
}

#[derive(Debug)]
struct NativeRecoveryLifecycle {
    generation: u64,
    presentation: Option<MainWindowPresentation>,
    original_main_hwnd: Option<isize>,
    phase: NativeRecoveryPhase,
    guard_hwnd: Option<isize>,
    completed_stages: Vec<NativeRecoveryStage>,
    minimum_native_windows: usize,
}

impl NativeRecoveryLifecycle {
    fn new(
        generation: u64,
        presentation: Option<MainWindowPresentation>,
        original_main_hwnd: Option<isize>,
    ) -> Self {
        Self {
            generation,
            presentation,
            original_main_hwnd,
            phase: NativeRecoveryPhase::AwaitGuardNative,
            guard_hwnd: None,
            completed_stages: Vec::new(),
            minimum_native_windows: usize::MAX,
        }
    }

    fn generation(&self) -> u64 {
        self.generation
    }

    fn presentation(&self) -> Option<MainWindowPresentation> {
        self.presentation
    }

    fn original_main_hwnd(&self) -> Option<isize> {
        self.original_main_hwnd
    }

    fn phase(&self) -> NativeRecoveryPhase {
        self.phase
    }

    fn guard_hwnd(&self) -> Option<isize> {
        self.guard_hwnd
    }

    fn main_destroy_may_be_dispatched(&self) -> bool {
        self.phase == NativeRecoveryPhase::DestroyMain && self.guard_hwnd.is_some()
    }

    fn is_complete(&self) -> bool {
        self.phase == NativeRecoveryPhase::Complete
    }

    fn completed_stages(&self) -> &[NativeRecoveryStage] {
        &self.completed_stages
    }

    fn minimum_native_windows(&self) -> usize {
        self.minimum_native_windows
    }

    fn record_stage(&mut self, stage: NativeRecoveryStage, native_windows: Option<usize>) {
        self.completed_stages.push(stage);
        if let Some(count) = native_windows {
            self.minimum_native_windows = self.minimum_native_windows.min(count);
        }
    }

    fn advance(&mut self, observation: NativeRecoveryObservation) -> NativeRecoveryPhase {
        match (self.phase, observation) {
            (
                NativeRecoveryPhase::AwaitGuardNative,
                NativeRecoveryObservation::GuardLogicalOnly,
            ) => {}
            (
                NativeRecoveryPhase::AwaitGuardNative,
                NativeRecoveryObservation::GuardNativeReady {
                    hwnd,
                    native_windows,
                },
            ) if native_windows > 0 => {
                self.guard_hwnd = Some(hwnd);
                self.record_stage(NativeRecoveryStage::GuardCreated, Some(native_windows));
                self.phase = NativeRecoveryPhase::DestroyMain;
            }
            (
                NativeRecoveryPhase::DestroyMain,
                NativeRecoveryObservation::MainDestroyDispatched,
            ) if self.guard_hwnd.is_some() => {
                self.record_stage(NativeRecoveryStage::DestroyDispatched, None);
                self.phase = NativeRecoveryPhase::AwaitMainAbsent;
            }
            (
                NativeRecoveryPhase::AwaitMainAbsent,
                NativeRecoveryObservation::MainAbsent { native_windows },
            ) if native_windows > 0 => {
                self.record_stage(NativeRecoveryStage::MainUnregistered, Some(native_windows));
                self.phase = NativeRecoveryPhase::BuildMain;
            }
            (NativeRecoveryPhase::BuildMain, NativeRecoveryObservation::MainBuildFailed) => {}
            (
                NativeRecoveryPhase::BuildMain,
                NativeRecoveryObservation::MainBuilt { native_windows },
            ) if native_windows > 0 => {
                self.record_stage(NativeRecoveryStage::MainBuilt, Some(native_windows));
                self.phase = NativeRecoveryPhase::RegisterHandler;
            }
            (NativeRecoveryPhase::RegisterHandler, NativeRecoveryObservation::HandlerFailed) => {}
            (
                NativeRecoveryPhase::RegisterHandler,
                NativeRecoveryObservation::HandlerRegistered { native_windows },
            ) if native_windows > 0 => {
                self.record_stage(NativeRecoveryStage::HandlerRegistered, Some(native_windows));
                self.phase = NativeRecoveryPhase::RestorePresentation;
            }
            (
                NativeRecoveryPhase::RestorePresentation,
                NativeRecoveryObservation::PresentationFailed,
            ) => {}
            (
                NativeRecoveryPhase::RestorePresentation,
                NativeRecoveryObservation::PresentationVerified { native_windows },
            ) if native_windows > 0 => {
                self.record_stage(
                    NativeRecoveryStage::PresentationRestored,
                    Some(native_windows),
                );
                self.phase = NativeRecoveryPhase::DestroyGuard;
            }
            (NativeRecoveryPhase::DestroyGuard, NativeRecoveryObservation::GuardDestroyFailed) => {}
            (
                NativeRecoveryPhase::DestroyGuard,
                NativeRecoveryObservation::GuardDestroyDispatched,
            ) => {
                self.phase = NativeRecoveryPhase::VerifyGuardAbsent;
            }
            (
                NativeRecoveryPhase::VerifyGuardAbsent,
                NativeRecoveryObservation::GuardStillPresent,
            ) => {
                self.phase = NativeRecoveryPhase::DestroyGuard;
            }
            (
                NativeRecoveryPhase::VerifyGuardAbsent,
                NativeRecoveryObservation::GuardAbsent { native_windows },
            ) if native_windows > 0 => {
                self.guard_hwnd = None;
                self.record_stage(NativeRecoveryStage::GuardDestroyed, Some(native_windows));
                self.phase = NativeRecoveryPhase::Complete;
            }
            _ => {}
        }
        self.phase
    }
}

fn restore_main_window_presentation<R: Runtime>(
    window: &tauri::Window<R>,
    presentation: MainWindowPresentation,
) -> Result<(), &'static str> {
    window
        .set_fullscreen(false)
        .map_err(|_| "fullscreen_schedule_failed")?;
    window
        .unmaximize()
        .map_err(|_| "maximize_schedule_failed")?;
    window
        .unminimize()
        .map_err(|_| "minimize_schedule_failed")?;
    if let Some(size) = presentation.size {
        window.set_size(size).map_err(|_| "size_schedule_failed")?;
    }
    if let Some(position) = presentation.position {
        window
            .set_position(position)
            .map_err(|_| "position_schedule_failed")?;
    }
    if presentation.maximized {
        window.maximize().map_err(|_| "maximize_schedule_failed")?;
    }
    if presentation.fullscreen {
        window
            .set_fullscreen(true)
            .map_err(|_| "fullscreen_schedule_failed")?;
    }
    if presentation.minimized {
        window.minimize().map_err(|_| "minimize_schedule_failed")?;
    }
    if presentation.visible {
        window.show().map_err(|_| "visibility_schedule_failed")?;
    } else {
        window.hide().map_err(|_| "visibility_schedule_failed")?;
    }
    if presentation.focused {
        window.set_focus().map_err(|_| "focus_schedule_failed")?;
    }
    Ok(())
}

fn presentation_matches<R: Runtime>(
    window: &tauri::Window<R>,
    expected: MainWindowPresentation,
) -> bool {
    let geometry_matches =
        optional_presentation_value_matches(window.outer_position().ok(), expected.position)
            && optional_presentation_value_matches(window.inner_size().ok(), expected.size);
    geometry_matches
        && window.is_maximized().ok() == Some(expected.maximized)
        && window.is_fullscreen().ok() == Some(expected.fullscreen)
        && window.is_minimized().ok() == Some(expected.minimized)
        && window.is_visible().ok() == Some(expected.visible)
        && window.is_focused().ok() == Some(expected.focused)
}

fn optional_presentation_value_matches<T: PartialEq>(
    actual: Option<T>,
    expected: Option<T>,
) -> bool {
    expected
        .map(|expected| actual == Some(expected))
        .unwrap_or(true)
}

fn restore_and_verify_main_window_presentation<R: Runtime>(
    window: &tauri::Window<R>,
    presentation: MainWindowPresentation,
) -> Result<(), &'static str> {
    restore_main_window_presentation(window, presentation)?;
    let started = Instant::now();
    while started.elapsed() < PRESENTATION_VERIFY_TIMEOUT {
        if presentation_matches(window, presentation) {
            return Ok(());
        }
        std::thread::sleep(MAIN_LABEL_RELEASE_POLL);
    }
    Err("presentation_verification_failed")
}

#[cfg(windows)]
fn native_window_handle<R: Runtime>(window: &tauri::Window<R>) -> Option<isize> {
    window.hwnd().ok().map(|hwnd| hwnd.0 as isize)
}

#[cfg(not(windows))]
fn native_window_handle<R: Runtime>(_window: &tauri::Window<R>) -> Option<isize> {
    Some(1)
}

#[cfg(windows)]
fn native_window_exists(raw: isize) -> bool {
    unsafe { IsWindow(Some(HWND(raw as *mut _))).as_bool() }
}

#[cfg(not(windows))]
fn native_window_exists(raw: isize) -> bool {
    raw != 0
}

#[cfg(windows)]
fn top_level_native_window_count() -> usize {
    struct Enumeration {
        process_id: u32,
        count: usize,
    }

    unsafe extern "system" fn count_window(hwnd: HWND, state: LPARAM) -> BOOL {
        let state = unsafe { &mut *(state.0 as *mut Enumeration) };
        let mut process_id = 0;
        unsafe {
            GetWindowThreadProcessId(hwnd, Some(&mut process_id));
        }
        if process_id == state.process_id {
            state.count += 1;
        }
        true.into()
    }

    let mut state = Enumeration {
        process_id: std::process::id(),
        count: 0,
    };
    let _ = unsafe {
        EnumWindows(
            Some(count_window),
            LPARAM((&mut state as *mut Enumeration) as isize),
        )
    };
    state.count
}

#[cfg(not(windows))]
fn top_level_native_window_count() -> usize {
    1
}

fn await_native_window<R: Runtime>(window: &tauri::Window<R>, timeout: Duration) -> Option<isize> {
    let started = Instant::now();
    while started.elapsed() < timeout {
        if let Some(hwnd) = native_window_handle(window) {
            if native_window_exists(hwnd) {
                return Some(hwnd);
            }
        }
        std::thread::sleep(MAIN_LABEL_RELEASE_POLL);
    }
    None
}

fn verified_main_absent(
    has_logical_window: bool,
    has_logical_webview: bool,
    original_native_window_exists: bool,
) -> bool {
    !has_logical_window && !has_logical_webview && !original_native_window_exists
}

fn log_native_recovery_stage(generation: u64, stage: NativeRecoveryStage, result: &str) {
    eprintln!(
        "[renderer-watchdog] action=replace_orphaned_host recovery_generation={} stage={} result={} native_windows={}",
        generation,
        stage.as_str(),
        result,
        top_level_native_window_count(),
    );
}

fn log_native_recovery_failure(generation: u64, stage: &str, error_class: &str, retained: bool) {
    eprintln!(
        "[renderer-watchdog] action=replace_orphaned_host recovery_generation={} stage={} result=failed error_class={} retained={} retry=true native_windows={}",
        generation,
        stage,
        error_class,
        retained,
        top_level_native_window_count(),
    );
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum NativeRecoveryExecution {
    Complete,
    Incomplete,
}

fn recreate_main_webview<R: Runtime>(
    app: &tauri::AppHandle<R>,
    state: Arc<RendererWatchdog>,
    replace_existing_webview: bool,
) -> Result<NativeRecoveryExecution, String> {
    let existing_host = app.get_window("main");
    let existing_webview = app.get_webview("main");
    match main_webview_recovery_plan(
        existing_host.is_some(),
        existing_webview.is_some(),
        replace_existing_webview,
    ) {
        MainWebviewRecoveryPlan::ReloadExisting => {
            return existing_webview
                .as_ref()
                .expect("recovery plan requires an existing main WebView")
                .reload()
                .map(|_| NativeRecoveryExecution::Complete)
                .map_err(|_| "existing_main_reload_failed".to_string());
        }
        MainWebviewRecoveryPlan::ReplaceOrphanedHost => {}
        MainWebviewRecoveryPlan::RebuildMissing => {}
    }

    let mut config = app
        .config()
        .app
        .windows
        .iter()
        .find(|window| window.label == "main")
        .cloned()
        .ok_or_else(|| "main window configuration is missing".to_string())?;
    let configured_presentation = MainWindowPresentation {
        position: None,
        size: None,
        maximized: config.maximized,
        fullscreen: config.fullscreen,
        minimized: false,
        visible: config.visible,
        focused: config.focus,
    };
    config.visible = false;
    config.focus = false;
    {
        let mut recovery = state
            .native_recovery
            .lock()
            .map_err(|_| "native_recovery_state_unavailable".to_string())?;
        if recovery.is_none() {
            let original_main_hwnd = existing_host
                .as_ref()
                .map(|window| {
                    native_window_handle(window)
                        .filter(|hwnd| native_window_exists(*hwnd))
                        .ok_or_else(|| "main_native_handle_unavailable".to_string())
                })
                .transpose()?;
            let presentation = match existing_host.as_ref() {
                Some(window) => capture_main_window_presentation(window)
                    .map_err(|error_class| error_class.to_string())?,
                None => configured_presentation,
            };
            let generation = state
                .native_recovery_generation
                .fetch_add(1, Ordering::AcqRel)
                .saturating_add(1);
            *recovery = Some(NativeRecoveryLifecycle::new(
                generation,
                Some(presentation),
                original_main_hwnd,
            ));
        }
    }

    loop {
        let (phase, generation, presentation, guard_hwnd, original_main_hwnd) = {
            let recovery = state
                .native_recovery
                .lock()
                .map_err(|_| "native_recovery_state_unavailable".to_string())?;
            let recovery = recovery
                .as_ref()
                .ok_or_else(|| "native_recovery_state_missing".to_string())?;
            (
                recovery.phase(),
                recovery.generation(),
                recovery.presentation(),
                recovery.guard_hwnd(),
                recovery.original_main_hwnd(),
            )
        };

        match phase {
            NativeRecoveryPhase::AwaitGuardNative => {
                let (guard, disposition) =
                    if let Some(guard) = app.get_window(RECOVERY_LIFECYCLE_GUARD_LABEL) {
                        (guard, "reused")
                    } else {
                        let guard = match WindowBuilder::new(app, RECOVERY_LIFECYCLE_GUARD_LABEL)
                            .title("VibeSpace recovery")
                            .visible(false)
                            .skip_taskbar(true)
                            .decorations(false)
                            .build()
                        {
                            Ok(guard) => guard,
                            Err(_) => {
                                log_native_recovery_failure(
                                    generation,
                                    NativeRecoveryStage::GuardCreated.as_str(),
                                    "guard_build_failed",
                                    true,
                                );
                                return Ok(NativeRecoveryExecution::Incomplete);
                            }
                        };
                        (guard, "created")
                    };
                let Some(hwnd) = await_native_window(&guard, NATIVE_WINDOW_ACK_TIMEOUT) else {
                    if let Ok(mut recovery) = state.native_recovery.lock() {
                        if let Some(recovery) = recovery.as_mut() {
                            recovery.advance(NativeRecoveryObservation::GuardLogicalOnly);
                        }
                    }
                    log_native_recovery_failure(
                        generation,
                        NativeRecoveryStage::GuardCreated.as_str(),
                        "guard_native_ack_timeout",
                        true,
                    );
                    return Ok(NativeRecoveryExecution::Incomplete);
                };
                let native_windows = top_level_native_window_count();
                if native_windows == 0 {
                    log_native_recovery_failure(
                        generation,
                        NativeRecoveryStage::GuardCreated.as_str(),
                        "native_window_count_zero",
                        true,
                    );
                    return Ok(NativeRecoveryExecution::Incomplete);
                }
                if let Ok(mut recovery) = state.native_recovery.lock() {
                    if let Some(recovery) = recovery.as_mut() {
                        recovery.advance(NativeRecoveryObservation::GuardNativeReady {
                            hwnd,
                            native_windows,
                        });
                    }
                }
                log_native_recovery_stage(
                    generation,
                    NativeRecoveryStage::GuardCreated,
                    disposition,
                );
            }
            NativeRecoveryPhase::DestroyMain => {
                if !guard_hwnd.map(native_window_exists).unwrap_or(false) {
                    log_native_recovery_failure(
                        generation,
                        NativeRecoveryStage::DestroyDispatched.as_str(),
                        "guard_native_ack_lost",
                        true,
                    );
                    return Ok(NativeRecoveryExecution::Incomplete);
                }
                #[cfg(windows)]
                if remove_process_failed_handler(
                    app.get_webview("main").as_ref(),
                    Arc::clone(&state),
                )
                .is_err()
                {
                    log_native_recovery_failure(
                        generation,
                        NativeRecoveryStage::DestroyDispatched.as_str(),
                        "handler_removal_failed",
                        true,
                    );
                    return Ok(NativeRecoveryExecution::Incomplete);
                }
                if let Some(window) = app.get_window("main") {
                    if window.destroy().is_err() {
                        log_native_recovery_failure(
                            generation,
                            NativeRecoveryStage::DestroyDispatched.as_str(),
                            "main_destroy_dispatch_failed",
                            true,
                        );
                        return Ok(NativeRecoveryExecution::Incomplete);
                    }
                }
                if let Ok(mut recovery) = state.native_recovery.lock() {
                    if let Some(recovery) = recovery.as_mut() {
                        recovery.advance(NativeRecoveryObservation::MainDestroyDispatched);
                    }
                }
                log_native_recovery_stage(
                    generation,
                    NativeRecoveryStage::DestroyDispatched,
                    "dispatched",
                );
            }
            NativeRecoveryPhase::AwaitMainAbsent => {
                let started = Instant::now();
                while !verified_main_absent(
                    app.get_window("main").is_some(),
                    app.get_webview("main").is_some(),
                    original_main_hwnd
                        .map(native_window_exists)
                        .unwrap_or(false),
                ) && started.elapsed() < MAIN_LABEL_RELEASE_TIMEOUT
                {
                    std::thread::sleep(MAIN_LABEL_RELEASE_POLL);
                }
                if !verified_main_absent(
                    app.get_window("main").is_some(),
                    app.get_webview("main").is_some(),
                    original_main_hwnd
                        .map(native_window_exists)
                        .unwrap_or(false),
                ) {
                    log_native_recovery_failure(
                        generation,
                        NativeRecoveryStage::MainUnregistered.as_str(),
                        "main_unregister_timeout",
                        true,
                    );
                    return Ok(NativeRecoveryExecution::Incomplete);
                }
                let native_windows = top_level_native_window_count();
                if native_windows == 0 {
                    log_native_recovery_failure(
                        generation,
                        NativeRecoveryStage::MainUnregistered.as_str(),
                        "native_window_count_zero",
                        true,
                    );
                    return Ok(NativeRecoveryExecution::Incomplete);
                }
                if let Ok(mut recovery) = state.native_recovery.lock() {
                    if let Some(recovery) = recovery.as_mut() {
                        recovery.advance(NativeRecoveryObservation::MainAbsent { native_windows });
                    }
                }
                log_native_recovery_stage(
                    generation,
                    NativeRecoveryStage::MainUnregistered,
                    "verified",
                );
            }
            NativeRecoveryPhase::BuildMain => {
                let rebuilt_host = if let Some(window) = app.get_window("main") {
                    window
                } else {
                    let rebuilt = match WebviewWindowBuilder::from_config(app, &config)
                        .and_then(|builder| builder.build())
                    {
                        Ok(rebuilt) => rebuilt,
                        Err(_) => {
                            if let Ok(mut recovery) = state.native_recovery.lock() {
                                if let Some(recovery) = recovery.as_mut() {
                                    recovery.advance(NativeRecoveryObservation::MainBuildFailed);
                                }
                            }
                            log_native_recovery_failure(
                                generation,
                                NativeRecoveryStage::MainBuilt.as_str(),
                                "main_build_failed",
                                true,
                            );
                            return Ok(NativeRecoveryExecution::Incomplete);
                        }
                    };
                    let Some(window) = app.get_window(rebuilt.label()) else {
                        log_native_recovery_failure(
                            generation,
                            NativeRecoveryStage::MainBuilt.as_str(),
                            "main_logical_window_unavailable",
                            true,
                        );
                        return Ok(NativeRecoveryExecution::Incomplete);
                    };
                    window
                };
                if await_native_window(&rebuilt_host, NATIVE_WINDOW_ACK_TIMEOUT).is_none() {
                    log_native_recovery_failure(
                        generation,
                        NativeRecoveryStage::MainBuilt.as_str(),
                        "main_native_ack_timeout",
                        true,
                    );
                    return Ok(NativeRecoveryExecution::Incomplete);
                }
                let native_windows = top_level_native_window_count();
                if native_windows == 0 {
                    log_native_recovery_failure(
                        generation,
                        NativeRecoveryStage::MainBuilt.as_str(),
                        "native_window_count_zero",
                        true,
                    );
                    return Ok(NativeRecoveryExecution::Incomplete);
                }
                if let Ok(mut recovery) = state.native_recovery.lock() {
                    if let Some(recovery) = recovery.as_mut() {
                        recovery.advance(NativeRecoveryObservation::MainBuilt { native_windows });
                    }
                }
                log_native_recovery_stage(generation, NativeRecoveryStage::MainBuilt, "verified");
            }
            NativeRecoveryPhase::RegisterHandler => {
                let main_webview = app.get_webview("main");
                let Some(main_webview) = main_webview else {
                    log_native_recovery_failure(
                        generation,
                        NativeRecoveryStage::HandlerRegistered.as_str(),
                        "main_webview_unavailable",
                        true,
                    );
                    return Ok(NativeRecoveryExecution::Incomplete);
                };
                #[cfg(windows)]
                let registration_result = {
                    let already_registered = state
                        .process_failure
                        .lock()
                        .map(|failure| failure.has_registration())
                        .unwrap_or(false);
                    if already_registered {
                        Ok(())
                    } else {
                        register_process_failed_handler(&main_webview, Arc::clone(&state))
                    }
                };
                #[cfg(not(windows))]
                let registration_result: Result<(), String> = Ok(());
                if registration_result.is_err() {
                    if let Ok(mut recovery) = state.native_recovery.lock() {
                        if let Some(recovery) = recovery.as_mut() {
                            recovery.advance(NativeRecoveryObservation::HandlerFailed);
                        }
                    }
                    log_native_recovery_failure(
                        generation,
                        NativeRecoveryStage::HandlerRegistered.as_str(),
                        "handler_registration_failed",
                        true,
                    );
                    return Ok(NativeRecoveryExecution::Incomplete);
                }
                let native_windows = top_level_native_window_count();
                if native_windows == 0 {
                    log_native_recovery_failure(
                        generation,
                        NativeRecoveryStage::HandlerRegistered.as_str(),
                        "native_window_count_zero",
                        true,
                    );
                    return Ok(NativeRecoveryExecution::Incomplete);
                }
                if let Ok(mut recovery) = state.native_recovery.lock() {
                    if let Some(recovery) = recovery.as_mut() {
                        recovery.advance(NativeRecoveryObservation::HandlerRegistered {
                            native_windows,
                        });
                    }
                }
                log_native_recovery_stage(
                    generation,
                    NativeRecoveryStage::HandlerRegistered,
                    "verified",
                );
            }
            NativeRecoveryPhase::RestorePresentation => {
                let Some(window) = app.get_window("main") else {
                    log_native_recovery_failure(
                        generation,
                        NativeRecoveryStage::PresentationRestored.as_str(),
                        "main_window_unavailable",
                        true,
                    );
                    return Ok(NativeRecoveryExecution::Incomplete);
                };
                let presentation = presentation
                    .ok_or_else(|| "native_recovery_presentation_missing".to_string())?;
                if restore_and_verify_main_window_presentation(&window, presentation).is_err() {
                    if let Ok(mut recovery) = state.native_recovery.lock() {
                        if let Some(recovery) = recovery.as_mut() {
                            recovery.advance(NativeRecoveryObservation::PresentationFailed);
                        }
                    }
                    log_native_recovery_failure(
                        generation,
                        NativeRecoveryStage::PresentationRestored.as_str(),
                        "presentation_verification_failed",
                        true,
                    );
                    return Ok(NativeRecoveryExecution::Incomplete);
                }
                let native_windows = top_level_native_window_count();
                if native_windows == 0 {
                    log_native_recovery_failure(
                        generation,
                        NativeRecoveryStage::PresentationRestored.as_str(),
                        "native_window_count_zero",
                        true,
                    );
                    return Ok(NativeRecoveryExecution::Incomplete);
                }
                if let Ok(mut recovery) = state.native_recovery.lock() {
                    if let Some(recovery) = recovery.as_mut() {
                        recovery.advance(NativeRecoveryObservation::PresentationVerified {
                            native_windows,
                        });
                    }
                }
                log_native_recovery_stage(
                    generation,
                    NativeRecoveryStage::PresentationRestored,
                    "verified",
                );
            }
            NativeRecoveryPhase::DestroyGuard => {
                if let Some(guard) = app.get_window(RECOVERY_LIFECYCLE_GUARD_LABEL) {
                    if guard.destroy().is_err() {
                        if let Ok(mut recovery) = state.native_recovery.lock() {
                            if let Some(recovery) = recovery.as_mut() {
                                recovery.advance(NativeRecoveryObservation::GuardDestroyFailed);
                            }
                        }
                        log_native_recovery_failure(
                            generation,
                            NativeRecoveryStage::GuardDestroyed.as_str(),
                            "guard_destroy_dispatch_failed",
                            true,
                        );
                        return Ok(NativeRecoveryExecution::Incomplete);
                    }
                }
                if let Ok(mut recovery) = state.native_recovery.lock() {
                    if let Some(recovery) = recovery.as_mut() {
                        recovery.advance(NativeRecoveryObservation::GuardDestroyDispatched);
                    }
                }
            }
            NativeRecoveryPhase::VerifyGuardAbsent => {
                let started = Instant::now();
                while (app.get_window(RECOVERY_LIFECYCLE_GUARD_LABEL).is_some()
                    || guard_hwnd.map(native_window_exists).unwrap_or(false))
                    && started.elapsed() < MAIN_LABEL_RELEASE_TIMEOUT
                {
                    std::thread::sleep(MAIN_LABEL_RELEASE_POLL);
                }
                if app.get_window(RECOVERY_LIFECYCLE_GUARD_LABEL).is_some()
                    || guard_hwnd.map(native_window_exists).unwrap_or(false)
                {
                    if let Ok(mut recovery) = state.native_recovery.lock() {
                        if let Some(recovery) = recovery.as_mut() {
                            recovery.advance(NativeRecoveryObservation::GuardStillPresent);
                        }
                    }
                    log_native_recovery_failure(
                        generation,
                        NativeRecoveryStage::GuardDestroyed.as_str(),
                        "guard_absence_timeout",
                        true,
                    );
                    return Ok(NativeRecoveryExecution::Incomplete);
                }
                let native_windows = top_level_native_window_count();
                if native_windows == 0 {
                    log_native_recovery_failure(
                        generation,
                        NativeRecoveryStage::GuardDestroyed.as_str(),
                        "native_window_count_zero",
                        true,
                    );
                    return Ok(NativeRecoveryExecution::Incomplete);
                }
                if let Ok(mut recovery) = state.native_recovery.lock() {
                    if let Some(recovery) = recovery.as_mut() {
                        recovery.advance(NativeRecoveryObservation::GuardAbsent { native_windows });
                    }
                }
                log_native_recovery_stage(
                    generation,
                    NativeRecoveryStage::GuardDestroyed,
                    "verified",
                );
            }
            NativeRecoveryPhase::Complete => {
                let mut recovery = state
                    .native_recovery
                    .lock()
                    .map_err(|_| "native_recovery_state_unavailable".to_string())?;
                let completed = recovery
                    .as_ref()
                    .map(|recovery| recovery.generation() == generation && recovery.is_complete())
                    .unwrap_or(false);
                if completed {
                    let stages = recovery
                        .as_ref()
                        .map(|recovery| native_recovery_stage_vector(recovery.completed_stages()))
                        .unwrap_or_default();
                    eprintln!(
                        "[renderer-watchdog] action=replace_orphaned_host recovery_generation={} result=scheduled stages={} native_windows={}",
                        generation,
                        stages,
                        top_level_native_window_count(),
                    );
                    *recovery = None;
                }
                return Ok(NativeRecoveryExecution::Complete);
            }
        }
    }
}

pub(crate) fn can_restart_application(
    marker_written: bool,
    circuit_written: bool,
    has_active_sessions: bool,
) -> bool {
    marker_written && circuit_written && !has_active_sessions
}

pub(crate) fn write_recovery_marker(path: &Path) -> io::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(path, b"renderer-recovery-v1\n")
}

pub(crate) fn consume_recovery_marker(path: &Path) -> bool {
    if !path.exists() {
        return false;
    }
    let consumed_path = path.with_extension(format!("consumed-{}", std::process::id()));
    if fs::rename(path, &consumed_path).is_err() {
        return false;
    }
    let _ = fs::remove_file(consumed_path);
    true
}

fn recovery_marker_path<R: Runtime>(app: &tauri::AppHandle<R>) -> Option<PathBuf> {
    app.path()
        .app_cache_dir()
        .ok()
        .map(|directory| directory.join(RECOVERY_MARKER_FILE))
}

fn recovery_circuit_path<R: Runtime>(app: &tauri::AppHandle<R>) -> Option<PathBuf> {
    app.path()
        .app_cache_dir()
        .ok()
        .map(|directory| directory.join(RECOVERY_CIRCUIT_FILE))
}

pub(crate) fn consume_recovery_restart<R: Runtime>(app: &tauri::AppHandle<R>) -> bool {
    recovery_marker_path(app)
        .map(|path| consume_recovery_marker(&path))
        .unwrap_or(false)
}

pub(crate) fn install<R: Runtime>(app: &mut tauri::App<R>) {
    let marker_path = recovery_marker_path(app.handle());
    let circuit_path = recovery_circuit_path(app.handle());
    let process_restart_allowed = circuit_path
        .as_ref()
        .map(|path| !path.exists())
        .unwrap_or(false);
    let state = Arc::new(RendererWatchdog::new(process_restart_allowed));
    let heartbeat_state = Arc::clone(&state);
    let heartbeat_circuit_path = circuit_path.clone();

    #[cfg(windows)]
    if let Some(main_webview) = app.get_webview("main") {
        if register_process_failed_handler(&main_webview, Arc::clone(&state)).is_err() {
            eprintln!(
                "[renderer-watchdog] signal=process_failed action=register result=failed error_class=registration_failed"
            );
        }
    }

    app.listen(RENDERER_HEARTBEAT_EVENT, move |_| {
        if heartbeat_state.record_heartbeat() {
            if let Some(path) = &heartbeat_circuit_path {
                let _ = fs::remove_file(path);
            }
        }
    });

    let app_handle = app.handle().clone();
    let mut main_was_focused = false;
    std::thread::Builder::new()
        .name("renderer-watchdog".into())
        .spawn(move || loop {
            std::thread::sleep(WATCHDOG_INTERVAL);

            let main_window = app_handle.get_window("main");
            let visible = main_window
                .as_ref()
                .and_then(|window| window.is_visible().ok())
                .unwrap_or(true);
            let focused = main_window
                .as_ref()
                .and_then(|window| window.is_focused().ok())
                .unwrap_or(true);
            let should_check_stale = should_check_stale_renderer(main_was_focused, focused);
            main_was_focused = focused;
            if let Some((generation, signal)) = decode_process_failure(
                state.pending_process_failure.swap(0, Ordering::AcqRel),
            ) {
                if let Ok(mut failure) = state.process_failure.lock() {
                    record_process_failure(
                        &mut failure,
                        generation,
                        signal,
                        Instant::now(),
                    );
                }
            }
            let (process_signal, diagnostic) = match state.process_failure.lock() {
                Ok(mut failure) => (failure.pending_recovery(), failure.take_diagnostic()),
                Err(_) => (None, None),
            };
            if let Some(diagnostic) = diagnostic {
                eprintln!(
                    "[renderer-watchdog] signal=process_failed class={} failure_reason={} action=none result=diagnostic",
                    diagnostic.class.as_str(),
                    diagnostic.reason.as_str(),
                );
            }
            let heartbeat_age = state.heartbeat_age();
            #[cfg(windows)]
            if heartbeat_age
                .map(|age| age <= RENDERER_STALE_AFTER)
                .unwrap_or(false)
                && state
                    .native_recovery
                    .lock()
                    .map(|recovery| recovery.is_none())
                    .unwrap_or(false)
            {
                if let Some(main_webview) = app_handle.get_webview("main") {
                    let (retry_due, has_pending_removals) = state
                        .process_failure
                        .lock()
                        .map(|failure| {
                            (
                                failure.registration_retry_due(true, Instant::now()),
                                failure.has_pending_handler_removals(),
                            )
                        })
                        .unwrap_or((false, false));
                    if retry_due {
                        let result = if has_pending_removals {
                            if let Ok(mut failure) = state.process_failure.lock() {
                                failure.record_registration_attempt(Instant::now());
                            }
                            remove_pending_process_failed_handlers(
                                Some(&main_webview),
                                Arc::clone(&state),
                            )
                            .and_then(|_| {
                                let has_registration = state
                                    .process_failure
                                    .lock()
                                    .map(|failure| failure.has_registration())
                                    .unwrap_or(true);
                                if has_registration {
                                    Ok(())
                                } else {
                                    register_process_failed_handler(
                                        &main_webview,
                                        Arc::clone(&state),
                                    )
                                }
                            })
                        } else {
                            register_process_failed_handler(
                                &main_webview,
                                Arc::clone(&state),
                            )
                        };
                        eprintln!(
                            "[renderer-watchdog] signal=process_failed action=register_retry result={}",
                            if result.is_ok() { "succeeded" } else { "failed" },
                        );
                    }
                }
            }
            let has_incomplete_recovery = state
                .native_recovery
                .lock()
                .map(|recovery| recovery.is_some())
                .unwrap_or(false);
            let has_webview = app_handle.get_webview("main").is_some();
            if !should_evaluate_recovery(
                heartbeat_age.is_some(),
                process_signal.is_some(),
                has_incomplete_recovery,
                has_webview,
            ) {
                continue;
            }
            let age = heartbeat_age.unwrap_or_default();
            let reason = process_signal
                .and_then(process_failure_recovery_reason)
                .or_else(|| {
                    renderer_recovery_reason(
                        age,
                        visible,
                        should_check_stale,
                        has_webview,
                        state.webview_reload_failed.load(Ordering::SeqCst),
                    )
                });
            let has_active_sessions = app_handle
                .state::<crate::terminal::TerminalState>()
                .has_active_sessions();
            let allow_process_restart =
                state.process_restart_allowed.load(Ordering::SeqCst) && !has_active_sessions;

            let action = {
                let Ok(recovery) = state.recovery.lock() else {
                    continue;
                };
                let time_since_last_action =
                    recovery.last_action_at.map(|started| started.elapsed());
                let action = native_recovery_resume_action(
                    has_incomplete_recovery,
                    time_since_last_action,
                )
                .unwrap_or_else(|| {
                    next_recovery_action_for_reason(
                        reason,
                        recovery.reload_attempts,
                        recovery.recreate_attempts,
                        time_since_last_action,
                        allow_process_restart,
                    )
                });
                if action != RecoveryAction::None {
                    if let Ok(mut healthy_since) = state.healthy_since.lock() {
                        *healthy_since = None;
                    }
                }
                action
            };

            if action != RecoveryAction::None {
                if let Some(signal) = process_signal {
                    let action_name = match action {
                        RecoveryAction::ReloadWebview => "reload_webview",
                        RecoveryAction::RecreateWebview => "replace_orphaned_host",
                        RecoveryAction::RestartApplication => "restart_application",
                        RecoveryAction::None => "none",
                    };
                    eprintln!(
                        "[renderer-watchdog] signal=process_failed class={} failure_reason={} action={} result=selected",
                        signal.class.as_str(),
                        signal.reason.as_str(),
                        action_name,
                    );
                }
            }

            match action {
                RecoveryAction::None => {}
                RecoveryAction::ReloadWebview => {
                    eprintln!(
                        "[renderer-watchdog] reason={} action=reload_webview age_seconds={}",
                        reason
                            .unwrap_or(RecoveryReason::HeartbeatStale)
                            .as_str(),
                        age.as_secs(),
                    );
                    let (executed_action, result);
                    if let Some(main_webview) = app_handle.get_webview("main") {
                        if main_webview.reload().is_err() {
                            state
                                .webview_reload_failed
                                .store(true, Ordering::SeqCst);
                            eprintln!(
                                "[renderer-watchdog] reason={} action=reload_webview result=failed error_class=reload_failed",
                                reason
                                    .unwrap_or(RecoveryReason::HeartbeatStale)
                                    .as_str(),
                            );
                            executed_action = RecoveryAction::ReloadWebview;
                            result = RecoveryResult::Failed;
                        } else {
                            eprintln!(
                                "[renderer-watchdog] reason={} action=reload_webview result=scheduled",
                                reason
                                    .unwrap_or(RecoveryReason::HeartbeatStale)
                                    .as_str(),
                            );
                            executed_action = RecoveryAction::ReloadWebview;
                            result = RecoveryResult::Scheduled;
                        }
                    } else if !matches!(
                        recreate_main_webview(&app_handle, Arc::clone(&state), false),
                        Ok(NativeRecoveryExecution::Complete)
                    ) {
                        eprintln!(
                            "[renderer-watchdog] reason=main_webview_missing action=replace_orphaned_host result=failed error_class=rebuild_failed"
                        );
                        executed_action = RecoveryAction::RecreateWebview;
                        result = RecoveryResult::Failed;
                    } else {
                        eprintln!(
                            "[renderer-watchdog] reason=main_webview_missing action=replace_orphaned_host result=scheduled"
                        );
                        executed_action = RecoveryAction::RecreateWebview;
                        result = RecoveryResult::Scheduled;
                    }
                    if let Ok(mut recovery) = state.recovery.lock() {
                        record_recovery_result(
                            &mut recovery,
                            executed_action,
                            result,
                            Instant::now(),
                        );
                    }
                    if result == RecoveryResult::Scheduled {
                        if let Some(signal) = process_signal {
                            if let Ok(mut failure) = state.process_failure.lock() {
                                failure.consume_recovery(signal);
                            }
                        }
                    }
                }
                RecoveryAction::RecreateWebview => {
                    eprintln!(
                        "[renderer-watchdog] reason={} action=replace_orphaned_host age_seconds={}",
                        reason
                            .unwrap_or(RecoveryReason::HeartbeatStale)
                            .as_str(),
                        age.as_secs(),
                    );
                    let result = if !matches!(
                        recreate_main_webview(&app_handle, Arc::clone(&state), true),
                        Ok(NativeRecoveryExecution::Complete)
                    ) {
                        eprintln!(
                            "[renderer-watchdog] reason={} action=replace_orphaned_host result=failed error_class=rebuild_failed",
                            reason
                                .unwrap_or(RecoveryReason::HeartbeatStale)
                                .as_str(),
                        );
                        RecoveryResult::Failed
                    } else {
                        state
                            .webview_reload_failed
                            .store(false, Ordering::SeqCst);
                        eprintln!(
                            "[renderer-watchdog] reason={} action=replace_orphaned_host result=scheduled",
                            reason
                                .unwrap_or(RecoveryReason::HeartbeatStale)
                                .as_str(),
                        );
                        RecoveryResult::Scheduled
                    };
                    if let Ok(mut recovery) = state.recovery.lock() {
                        record_recovery_result(
                            &mut recovery,
                            RecoveryAction::RecreateWebview,
                            result,
                            Instant::now(),
                        );
                    }
                    if result == RecoveryResult::Scheduled {
                        if let Some(signal) = process_signal {
                            if let Ok(mut failure) = state.process_failure.lock() {
                                failure.consume_recovery(signal);
                            }
                        }
                    }
                }
                RecoveryAction::RestartApplication => {
                    let terminal_state = app_handle.state::<crate::terminal::TerminalState>();
                    let restart_committed =
                        terminal_state.commit_restart(TERMINAL_RESTART_GATE_TIMEOUT);
                    let marker_written = marker_path
                        .as_ref()
                        .map(|path| write_recovery_marker(path).is_ok())
                        .unwrap_or(false);
                    let circuit_written = circuit_path
                        .as_ref()
                        .map(|path| write_recovery_marker(path).is_ok())
                        .unwrap_or(false);
                    let has_active_sessions = terminal_state.has_active_sessions();

                    if can_restart_application(
                        marker_written,
                        circuit_written,
                        has_active_sessions || !restart_committed,
                    ) {
                        if let Ok(mut recovery) = state.recovery.lock() {
                            record_recovery_result(
                                &mut recovery,
                                RecoveryAction::RestartApplication,
                                RecoveryResult::Scheduled,
                                Instant::now(),
                            );
                        }
                        state
                            .process_restart_allowed
                            .store(false, Ordering::SeqCst);
                        eprintln!(
                            "[renderer-watchdog] WebView recovery exhausted after {}s; restarting VibeSpace",
                            age.as_secs()
                        );
                        app_handle.restart();
                    } else {
                        if let Ok(mut recovery) = state.recovery.lock() {
                            record_recovery_result(
                                &mut recovery,
                                RecoveryAction::RestartApplication,
                                RecoveryResult::Failed,
                                Instant::now(),
                            );
                        }
                        if marker_written {
                            if let Some(path) = &marker_path {
                                let _ = fs::remove_file(path);
                            }
                        }
                        if circuit_written {
                            if let Some(path) = &circuit_path {
                                let _ = fs::remove_file(path);
                            }
                        }
                        if restart_committed {
                            terminal_state.cancel_restart();
                        }
                        eprintln!(
                            "[renderer-watchdog] native restart suppressed; continuing WebView-only recovery"
                        );
                    }
                }
            }
        })
        .expect("failed to start renderer watchdog");
}

#[cfg(test)]
mod tests {
    use super::{
        can_restart_application, consume_recovery_marker, decode_process_failure,
        encode_process_failure, main_webview_recovery_plan, native_recovery_resume_action,
        native_recovery_stage_vector, next_orphan_replacement_step, next_recovery_action,
        next_recovery_action_for_reason, optional_presentation_value_matches,
        process_failure_recovery_reason, record_process_failure, record_recovery_result,
        renderer_recovery_reason, should_check_stale_renderer, should_evaluate_recovery,
        should_rearm_process_restart, should_restart_renderer, verified_main_absent,
        write_recovery_marker, MainWebviewRecoveryPlan, MainWindowPresentation,
        NativeRecoveryLifecycle, NativeRecoveryObservation, NativeRecoveryPhase,
        NativeRecoveryStage, OrphanReplacementStep, ProcessFailureClass, ProcessFailureReason,
        ProcessFailureRegistrationState, ProcessFailureSignal, RecoveryAction, RecoveryProgress,
        RecoveryReason, RecoveryResult,
    };
    use std::fs;
    use std::time::{Duration, Instant};

    #[test]
    fn recovers_visible_startup_and_runtime_heartbeat_failures_after_the_grace_period() {
        let stale = Duration::from_secs(31);
        let fresh = Duration::from_secs(5);
        let grace_boundary = Duration::from_secs(30);

        // This policy also covers startup failures before the first JavaScript heartbeat.
        assert!(should_restart_renderer(stale, true, true));
        assert!(!should_restart_renderer(fresh, true, true));
        assert!(!should_restart_renderer(grace_boundary, true, true));
        assert!(!should_restart_renderer(stale, false, true));
        assert!(!should_restart_renderer(stale, true, false));
    }

    #[test]
    fn defers_recovery_for_the_first_tick_after_focus_returns() {
        assert!(!should_check_stale_renderer(false, false));
        assert!(!should_check_stale_renderer(true, false));
        assert!(!should_check_stale_renderer(false, true));
        assert!(should_check_stale_renderer(true, true));
    }

    #[test]
    fn definitive_missing_webview_bypasses_focus_without_weakening_stale_heartbeat_safety() {
        let stale = Duration::from_secs(31);

        assert_eq!(
            renderer_recovery_reason(stale, true, false, true, false),
            None
        );
        assert_eq!(
            renderer_recovery_reason(stale, true, false, false, false),
            Some(RecoveryReason::MainWebviewMissing)
        );
        assert_eq!(
            renderer_recovery_reason(stale, true, false, true, true),
            Some(RecoveryReason::WebviewReloadFailed)
        );
        assert_eq!(
            next_recovery_action_for_reason(
                Some(RecoveryReason::MainWebviewMissing),
                0,
                0,
                None,
                false,
            ),
            RecoveryAction::RecreateWebview
        );
        assert_eq!(
            next_recovery_action_for_reason(
                Some(RecoveryReason::MainWebviewMissing),
                0,
                1,
                Some(Duration::from_secs(10)),
                false,
            ),
            RecoveryAction::None
        );
        assert_eq!(
            next_recovery_action_for_reason(
                Some(RecoveryReason::MainWebviewMissing),
                0,
                1,
                Some(Duration::from_secs(21)),
                false,
            ),
            RecoveryAction::RecreateWebview
        );
        assert_eq!(
            next_recovery_action_for_reason(
                Some(RecoveryReason::MainWebviewMissing),
                0,
                3,
                Some(Duration::from_secs(21)),
                false,
            ),
            RecoveryAction::None
        );
        assert_eq!(
            RecoveryReason::MainWebviewMissing.as_str(),
            "main_webview_missing"
        );
        assert_eq!(
            RecoveryReason::WebviewReloadFailed.as_str(),
            "webview_reload_failed"
        );
    }

    #[test]
    fn maps_only_browser_and_renderer_failures_to_bounded_recovery() {
        let browser = ProcessFailureSignal {
            class: ProcessFailureClass::BrowserProcessExited,
            reason: ProcessFailureReason::Crashed,
        };
        let renderer = ProcessFailureSignal {
            class: ProcessFailureClass::RendererProcessExited,
            reason: ProcessFailureReason::Unexpected,
        };
        let unresponsive = ProcessFailureSignal {
            class: ProcessFailureClass::RendererUnresponsive,
            reason: ProcessFailureReason::Unresponsive,
        };

        assert_eq!(
            process_failure_recovery_reason(browser),
            Some(RecoveryReason::BrowserProcessExited)
        );
        assert_eq!(
            process_failure_recovery_reason(renderer),
            Some(RecoveryReason::RendererProcessFailed)
        );
        assert_eq!(
            process_failure_recovery_reason(unresponsive),
            Some(RecoveryReason::RendererProcessFailed)
        );
        for class in [
            ProcessFailureClass::GpuProcessExited,
            ProcessFailureClass::UtilityProcessExited,
            ProcessFailureClass::FrameRenderProcessExited,
            ProcessFailureClass::Other,
        ] {
            assert_eq!(
                process_failure_recovery_reason(ProcessFailureSignal {
                    class,
                    reason: ProcessFailureReason::Other,
                }),
                None
            );
        }
        assert_eq!(
            next_recovery_action_for_reason(
                Some(RecoveryReason::BrowserProcessExited),
                0,
                0,
                None,
                false,
            ),
            RecoveryAction::RecreateWebview
        );
        assert_eq!(
            next_recovery_action_for_reason(
                Some(RecoveryReason::BrowserProcessExited),
                0,
                1,
                Some(Duration::from_secs(10)),
                false,
            ),
            RecoveryAction::None
        );
        assert_eq!(
            next_recovery_action_for_reason(
                Some(RecoveryReason::BrowserProcessExited),
                0,
                3,
                Some(Duration::from_secs(21)),
                false,
            ),
            RecoveryAction::None
        );
        assert_eq!(
            next_recovery_action_for_reason(
                Some(RecoveryReason::RendererProcessFailed),
                0,
                0,
                None,
                false,
            ),
            RecoveryAction::ReloadWebview
        );
        assert_eq!(
            next_recovery_action_for_reason(
                Some(RecoveryReason::RendererProcessFailed),
                2,
                0,
                Some(Duration::from_secs(21)),
                false,
            ),
            RecoveryAction::RecreateWebview
        );
        assert_eq!(
            next_recovery_action_for_reason(
                Some(RecoveryReason::RendererProcessFailed),
                1,
                0,
                Some(Duration::from_secs(10)),
                false,
            ),
            RecoveryAction::None
        );
    }

    #[test]
    fn atomically_encoded_process_failures_preserve_generation_and_recovery_priority() {
        let generation = 19;
        let diagnostic = ProcessFailureSignal {
            class: ProcessFailureClass::GpuProcessExited,
            reason: ProcessFailureReason::Unexpected,
        };
        let renderer = ProcessFailureSignal {
            class: ProcessFailureClass::RendererProcessExited,
            reason: ProcessFailureReason::OutOfMemory,
        };
        let browser = ProcessFailureSignal {
            class: ProcessFailureClass::BrowserProcessExited,
            reason: ProcessFailureReason::Crashed,
        };

        assert_eq!(
            decode_process_failure(encode_process_failure(generation, renderer)),
            Some((generation, renderer))
        );
        assert!(
            encode_process_failure(generation, browser)
                > encode_process_failure(generation, renderer)
        );
        assert!(
            encode_process_failure(generation, renderer)
                > encode_process_failure(generation, diagnostic)
        );
        assert_eq!(decode_process_failure(0), None);
    }

    #[test]
    fn process_failure_registration_is_generation_fenced_and_removed_before_teardown() {
        let mut state = ProcessFailureRegistrationState::default();
        let first_generation = state.begin_registration();

        assert!(state.commit_registration(first_generation, 41));
        assert!(record_process_failure(
            &mut state,
            first_generation,
            ProcessFailureSignal {
                class: ProcessFailureClass::BrowserProcessExited,
                reason: ProcessFailureReason::Crashed,
            },
            Instant::now(),
        ));
        assert_eq!(
            state.pending_recovery().unwrap().class,
            ProcessFailureClass::BrowserProcessExited
        );

        assert_eq!(state.begin_teardown(), Some(41));
        assert!(state.commit_handler_removal(41));
        assert_eq!(state.pending_recovery(), None);
        assert!(!record_process_failure(
            &mut state,
            first_generation,
            ProcessFailureSignal {
                class: ProcessFailureClass::RendererProcessExited,
                reason: ProcessFailureReason::Unexpected,
            },
            Instant::now(),
        ));

        let second_generation = state.begin_registration();
        assert_ne!(first_generation, second_generation);
        assert!(!state.commit_registration(first_generation, 42));
        assert!(state.commit_registration(second_generation, 43));
    }

    #[test]
    fn failed_process_failure_handler_removal_retains_the_same_token_until_retry_succeeds() {
        let mut state = ProcessFailureRegistrationState::default();
        let generation = state.begin_registration();
        assert!(state.commit_registration(generation, 41));

        assert_eq!(state.begin_teardown(), Some(41));
        assert!(state.handler_removal_blocks_destroy());

        // A failed COM removal does not commit any state transition.
        assert_eq!(state.begin_teardown(), Some(41));
        assert!(state.handler_removal_blocks_destroy());

        assert!(state.commit_handler_removal(41));
        assert!(!state.handler_removal_blocks_destroy());
        assert_eq!(state.begin_teardown(), None);
    }

    #[test]
    fn superseded_registration_cleanup_is_retryable_and_blocks_replacement() {
        let mut state = ProcessFailureRegistrationState::default();
        let first_generation = state.begin_registration();
        let second_generation = state.begin_registration();

        assert!(state.commit_registration(second_generation, 52));
        assert!(!state.commit_registration(first_generation, 51));
        state.retain_superseded_handler(51);
        assert!(state.handler_removal_blocks_destroy());
        assert_eq!(state.pending_handler_removals(), vec![51]);

        // A first failed removal retains the token for the next cooldown attempt.
        assert_eq!(state.pending_handler_removals(), vec![51]);
        assert!(state.commit_handler_removal(51));
        assert!(!state.handler_removal_blocks_destroy());
        assert!(state.has_registration());
    }

    #[test]
    fn transient_registration_failure_retries_only_after_cooldown_and_stays_bounded() {
        let mut state = ProcessFailureRegistrationState::default();
        let started = Instant::now();

        assert!(state.registration_retry_due(true, started));
        state.record_registration_attempt(started);
        assert!(!state.registration_retry_due(true, started + Duration::from_secs(5)));
        assert!(state.registration_retry_due(true, started + Duration::from_secs(21)));

        state.record_registration_attempt(started + Duration::from_secs(21));
        assert!(state.registration_retry_due(true, started + Duration::from_secs(42)));
        state.record_registration_attempt(started + Duration::from_secs(42));
        assert!(!state.registration_retry_due(true, started + Duration::from_secs(63)));
        assert!(!state.registration_retry_due(false, started + Duration::from_secs(63)));

        let generation = state.begin_registration();
        assert!(state.commit_registration(generation, 61));
        assert!(!state.registration_retry_due(true, started + Duration::from_secs(84)));
    }

    #[test]
    fn repeated_renderer_unresponsive_events_are_debounced() {
        let mut state = ProcessFailureRegistrationState::default();
        let generation = state.begin_registration();
        assert!(state.commit_registration(generation, 7));
        let started = Instant::now();
        let signal = ProcessFailureSignal {
            class: ProcessFailureClass::RendererUnresponsive,
            reason: ProcessFailureReason::Unresponsive,
        };

        assert!(record_process_failure(
            &mut state, generation, signal, started,
        ));
        state.consume_recovery(signal);
        assert!(!record_process_failure(
            &mut state,
            generation,
            signal,
            started + Duration::from_secs(5),
        ));
        assert!(record_process_failure(
            &mut state,
            generation,
            signal,
            started + Duration::from_secs(31),
        ));
    }

    #[test]
    fn reloads_the_webview_twice_before_escalating_to_an_application_restart() {
        let stale = Duration::from_secs(31);
        let retry_ready = Duration::from_secs(21);

        assert_eq!(
            next_recovery_action(stale, true, true, 0, 0, None, true),
            RecoveryAction::ReloadWebview
        );
        assert_eq!(
            next_recovery_action(stale, true, true, 1, 0, Some(retry_ready), true),
            RecoveryAction::ReloadWebview
        );
        assert_eq!(
            next_recovery_action(stale, true, true, 2, 0, Some(retry_ready), true),
            RecoveryAction::RecreateWebview
        );
        assert_eq!(
            next_recovery_action(stale, true, true, 1, 0, Some(Duration::from_secs(10)), true,),
            RecoveryAction::None
        );
        assert_eq!(
            next_recovery_action(stale, false, true, 2, 0, Some(retry_ready), true),
            RecoveryAction::None
        );
        assert_eq!(
            next_recovery_action(stale, true, false, 2, 1, Some(retry_ready), false),
            RecoveryAction::None
        );
        assert_eq!(
            next_recovery_action(stale, true, true, 2, 1, Some(retry_ready), false),
            RecoveryAction::RecreateWebview
        );
        assert_eq!(
            next_recovery_action(stale, true, true, 2, 3, Some(retry_ready), false),
            RecoveryAction::None
        );
    }

    #[test]
    fn recreates_the_failed_webview_before_any_process_restart_and_preserves_live_ptys() {
        let stale = Duration::from_secs(31);
        let retry_ready = Duration::from_secs(21);

        assert_eq!(
            next_recovery_action(stale, true, true, 2, 0, Some(retry_ready), true),
            RecoveryAction::RecreateWebview
        );
        assert_eq!(
            next_recovery_action(stale, true, true, 2, 0, Some(retry_ready), false),
            RecoveryAction::RecreateWebview
        );
        assert_eq!(
            next_recovery_action(stale, true, true, 2, 1, Some(retry_ready), true),
            RecoveryAction::RestartApplication
        );
        assert_eq!(
            next_recovery_action(stale, true, true, 2, 1, Some(retry_ready), false),
            RecoveryAction::RecreateWebview
        );
    }

    #[test]
    fn replaces_an_orphaned_main_host_without_restarting_native_services() {
        assert_eq!(
            main_webview_recovery_plan(true, true, false),
            MainWebviewRecoveryPlan::ReloadExisting
        );
        assert_eq!(
            main_webview_recovery_plan(true, false, false),
            MainWebviewRecoveryPlan::ReplaceOrphanedHost
        );
        assert_eq!(
            main_webview_recovery_plan(true, true, true),
            MainWebviewRecoveryPlan::ReplaceOrphanedHost
        );
        assert_eq!(
            main_webview_recovery_plan(false, false, false),
            MainWebviewRecoveryPlan::RebuildMissing
        );
    }

    #[test]
    fn orphan_replacement_keeps_a_guard_until_the_main_label_is_released_and_rebuilt() {
        assert_eq!(
            next_orphan_replacement_step(false, true, false, false),
            OrphanReplacementStep::CreateLifecycleGuard
        );
        assert_eq!(
            next_orphan_replacement_step(true, true, false, false),
            OrphanReplacementStep::RemoveHandlerAndRequestDestroy
        );
        assert_eq!(
            next_orphan_replacement_step(true, true, true, false),
            OrphanReplacementStep::AwaitMainLabelRelease
        );
        assert_eq!(
            next_orphan_replacement_step(true, false, true, false),
            OrphanReplacementStep::BuildMain
        );
        assert_eq!(
            next_orphan_replacement_step(true, false, true, true),
            OrphanReplacementStep::DestroyLifecycleGuard
        );
    }

    #[test]
    fn failed_main_rebuild_keeps_the_lifecycle_guard_for_a_bounded_retry() {
        assert_eq!(
            next_orphan_replacement_step(true, false, true, false),
            OrphanReplacementStep::BuildMain
        );
        assert_ne!(
            next_orphan_replacement_step(true, false, true, false),
            OrphanReplacementStep::DestroyLifecycleGuard
        );
    }

    #[test]
    fn native_guard_must_be_acknowledged_before_main_destroy() {
        let mut lifecycle = NativeRecoveryLifecycle::new(7, None, None);

        assert_eq!(
            lifecycle.advance(NativeRecoveryObservation::GuardLogicalOnly),
            NativeRecoveryPhase::AwaitGuardNative
        );
        assert!(!lifecycle.main_destroy_may_be_dispatched());
        assert_eq!(
            lifecycle.advance(NativeRecoveryObservation::GuardNativeReady {
                hwnd: 41,
                native_windows: 2,
            }),
            NativeRecoveryPhase::DestroyMain
        );
        assert!(lifecycle.main_destroy_may_be_dispatched());
    }

    #[test]
    fn configured_rebuild_geometry_is_unconstrained_when_no_snapshot_exists() {
        assert!(optional_presentation_value_matches(Some(40_i32), None));
        assert!(optional_presentation_value_matches(Some(40_i32), Some(40)));
        assert!(!optional_presentation_value_matches(Some(40_i32), Some(41)));
    }

    #[test]
    fn missing_or_incomplete_recovery_is_evaluated_without_a_heartbeat() {
        assert!(should_evaluate_recovery(false, false, false, false));
        assert!(should_evaluate_recovery(false, false, true, true));
        assert!(!should_evaluate_recovery(false, false, false, true));
    }

    #[test]
    fn main_is_not_absent_until_registry_and_original_native_window_are_gone() {
        assert!(!verified_main_absent(false, false, true));
        assert!(!verified_main_absent(true, false, false));
        assert!(!verified_main_absent(false, true, false));
        assert!(verified_main_absent(false, false, false));
    }

    #[test]
    fn persisted_snapshot_and_generation_survive_rebuild_failure() {
        let presentation = MainWindowPresentation::test_value(true, false, true);
        let mut lifecycle = NativeRecoveryLifecycle::new(11, Some(presentation), Some(99));
        lifecycle.advance(NativeRecoveryObservation::GuardNativeReady {
            hwnd: 42,
            native_windows: 2,
        });
        lifecycle.advance(NativeRecoveryObservation::MainDestroyDispatched);
        lifecycle.advance(NativeRecoveryObservation::MainAbsent { native_windows: 1 });

        assert_eq!(
            lifecycle.advance(NativeRecoveryObservation::MainBuildFailed),
            NativeRecoveryPhase::BuildMain
        );
        assert_eq!(lifecycle.generation(), 11);
        assert_eq!(lifecycle.presentation(), Some(presentation));
        assert_eq!(
            lifecycle.advance(NativeRecoveryObservation::MainBuilt { native_windows: 2 }),
            NativeRecoveryPhase::RegisterHandler
        );
    }

    #[test]
    fn incomplete_rebuilt_main_resumes_only_the_missing_phase() {
        let mut lifecycle = NativeRecoveryLifecycle::new(
            13,
            Some(MainWindowPresentation::test_value(false, false, false)),
            Some(100),
        );
        lifecycle.advance(NativeRecoveryObservation::GuardNativeReady {
            hwnd: 43,
            native_windows: 2,
        });
        lifecycle.advance(NativeRecoveryObservation::MainDestroyDispatched);
        lifecycle.advance(NativeRecoveryObservation::MainAbsent { native_windows: 1 });
        lifecycle.advance(NativeRecoveryObservation::MainBuilt { native_windows: 2 });

        assert_eq!(
            lifecycle.advance(NativeRecoveryObservation::HandlerFailed),
            NativeRecoveryPhase::RegisterHandler
        );
        assert!(!lifecycle.main_destroy_may_be_dispatched());
        lifecycle.advance(NativeRecoveryObservation::HandlerRegistered { native_windows: 2 });
        assert_eq!(
            lifecycle.advance(NativeRecoveryObservation::PresentationFailed),
            NativeRecoveryPhase::RestorePresentation
        );
        assert!(!lifecycle.main_destroy_may_be_dispatched());
        lifecycle.advance(NativeRecoveryObservation::PresentationVerified { native_windows: 2 });
        assert_eq!(
            lifecycle.advance(NativeRecoveryObservation::GuardDestroyFailed),
            NativeRecoveryPhase::DestroyGuard
        );
        assert_eq!(
            lifecycle.advance(NativeRecoveryObservation::GuardDestroyDispatched),
            NativeRecoveryPhase::VerifyGuardAbsent
        );
        assert_eq!(
            lifecycle.advance(NativeRecoveryObservation::GuardStillPresent),
            NativeRecoveryPhase::DestroyGuard
        );
        assert!(!lifecycle.is_complete());
        assert_eq!(
            lifecycle.advance(NativeRecoveryObservation::GuardDestroyDispatched),
            NativeRecoveryPhase::VerifyGuardAbsent
        );
        assert_eq!(
            lifecycle.advance(NativeRecoveryObservation::GuardAbsent { native_windows: 1 }),
            NativeRecoveryPhase::Complete
        );
        assert!(lifecycle.is_complete());
    }

    #[test]
    fn successful_lifecycle_emits_exact_verified_stage_vector() {
        let mut lifecycle = NativeRecoveryLifecycle::new(
            17,
            Some(MainWindowPresentation::test_value(false, true, false)),
            Some(101),
        );
        let observations = [
            NativeRecoveryObservation::GuardNativeReady {
                hwnd: 44,
                native_windows: 2,
            },
            NativeRecoveryObservation::MainDestroyDispatched,
            NativeRecoveryObservation::MainAbsent { native_windows: 1 },
            NativeRecoveryObservation::MainBuilt { native_windows: 2 },
            NativeRecoveryObservation::HandlerRegistered { native_windows: 2 },
            NativeRecoveryObservation::PresentationVerified { native_windows: 2 },
            NativeRecoveryObservation::GuardDestroyDispatched,
            NativeRecoveryObservation::GuardAbsent { native_windows: 1 },
        ];
        for observation in observations {
            lifecycle.advance(observation);
        }

        assert_eq!(
            lifecycle.completed_stages(),
            &[
                NativeRecoveryStage::GuardCreated,
                NativeRecoveryStage::DestroyDispatched,
                NativeRecoveryStage::MainUnregistered,
                NativeRecoveryStage::MainBuilt,
                NativeRecoveryStage::HandlerRegistered,
                NativeRecoveryStage::PresentationRestored,
                NativeRecoveryStage::GuardDestroyed,
            ]
        );
        assert!(lifecycle.minimum_native_windows() > 0);
        assert_eq!(
            native_recovery_stage_vector(lifecycle.completed_stages()),
            "guard_created,destroy_dispatched,main_unregistered,main_built,handler_registered,presentation_restored,guard_destroyed"
        );
    }

    #[test]
    fn presentation_tracks_minimized_background_and_focus_semantics() {
        let presentation = MainWindowPresentation::test_value(true, false, true);
        assert!(presentation.minimized);
        assert!(!presentation.visible);
        assert!(presentation.focused);
    }

    #[test]
    fn incomplete_native_recovery_retries_its_phase_without_escalating() {
        assert_eq!(
            native_recovery_resume_action(true, Some(Duration::from_secs(1))),
            Some(RecoveryAction::None)
        );
        assert_eq!(
            native_recovery_resume_action(true, Some(Duration::from_secs(21))),
            Some(RecoveryAction::RecreateWebview)
        );
        assert_eq!(native_recovery_resume_action(false, None), None);
    }

    #[test]
    fn asynchronous_destroy_fake_reproduces_same_turn_collision_and_guarded_phases() {
        #[derive(Default)]
        struct FakeRuntime {
            main_registered: bool,
            guard_registered: bool,
            destroy_queued: bool,
            exited: bool,
        }

        impl FakeRuntime {
            fn request_main_destroy(&mut self) {
                self.destroy_queued = true;
            }

            fn build_main(&mut self) -> Result<(), &'static str> {
                if self.main_registered {
                    return Err("label_exists");
                }
                self.main_registered = true;
                Ok(())
            }

            fn deliver_destroyed(&mut self) {
                if self.destroy_queued {
                    self.main_registered = false;
                    self.destroy_queued = false;
                    self.exited = !self.guard_registered;
                }
            }
        }

        let mut old_order = FakeRuntime {
            main_registered: true,
            ..Default::default()
        };
        old_order.request_main_destroy();
        assert_eq!(old_order.build_main(), Err("label_exists"));
        old_order.deliver_destroyed();
        assert!(old_order.exited);

        let mut phased = FakeRuntime {
            main_registered: true,
            guard_registered: true,
            ..Default::default()
        };
        phased.request_main_destroy();
        phased.deliver_destroyed();
        assert!(!phased.exited);
        assert!(phased.build_main().is_ok());
        phased.guard_registered = false;
        assert!(phased.main_registered);
        assert!(!phased.exited);
    }

    #[test]
    fn records_recovery_attempts_only_after_the_executor_reports_a_result() {
        let mut progress = RecoveryProgress {
            reload_attempts: 0,
            recreate_attempts: 0,
            last_action_at: None,
        };
        let action = next_recovery_action_for_reason(
            Some(RecoveryReason::MainWebviewMissing),
            progress.reload_attempts,
            progress.recreate_attempts,
            None,
            false,
        );

        assert_eq!(action, RecoveryAction::RecreateWebview);
        assert_eq!(progress.recreate_attempts, 0);
        assert_eq!(progress.last_action_at, None);

        record_recovery_result(
            &mut progress,
            action,
            RecoveryResult::Failed,
            Instant::now(),
        );
        assert_eq!(progress.reload_attempts, 0);
        assert_eq!(progress.recreate_attempts, 1);
        assert!(progress.last_action_at.is_some());
        assert_eq!(RecoveryResult::Failed.as_str(), "failed");
        assert_eq!(RecoveryResult::Scheduled.as_str(), "scheduled");
    }

    #[test]
    fn restart_circuit_requires_sustained_renderer_health_before_rearming() {
        assert!(!should_rearm_process_restart(None));
        assert!(!should_rearm_process_restart(Some(Duration::from_secs(1))));
        assert!(!should_rearm_process_restart(Some(Duration::from_secs(59))));
        assert!(should_rearm_process_restart(Some(Duration::from_secs(60))));
    }

    #[test]
    fn application_restart_requires_durable_intent_and_no_live_pty() {
        assert!(can_restart_application(true, true, false));
        assert!(!can_restart_application(false, true, false));
        assert!(!can_restart_application(true, false, false));
        assert!(!can_restart_application(true, true, true));
    }

    #[test]
    fn recovery_restart_marker_is_consumed_exactly_once() {
        let path = std::env::temp_dir().join(format!(
            "vibespace-renderer-recovery-{}-{}.marker",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));

        write_recovery_marker(&path).expect("marker should be written");
        assert!(consume_recovery_marker(&path));
        assert!(!consume_recovery_marker(&path));
        assert!(!path.exists());

        let _ = fs::remove_file(path);
    }

    #[test]
    fn watchdog_remains_unarmed_until_the_main_renderer_heartbeats() {
        let watchdog = super::RendererWatchdog::new(true);

        assert_eq!(watchdog.heartbeat_age(), None);

        let generation = {
            let mut failure = watchdog.process_failure.lock().unwrap();
            let generation = failure.begin_registration();
            assert!(failure.commit_registration(generation, 17));
            assert!(record_process_failure(
                &mut failure,
                generation,
                ProcessFailureSignal {
                    class: ProcessFailureClass::BrowserProcessExited,
                    reason: ProcessFailureReason::Crashed,
                },
                Instant::now(),
            ));
            generation
        };
        assert!(generation > 0);
        watchdog.record_heartbeat();
        assert!(watchdog.heartbeat_age().is_some());
        assert_eq!(
            watchdog.process_failure.lock().unwrap().pending_recovery(),
            Some(ProcessFailureSignal {
                class: ProcessFailureClass::BrowserProcessExited,
                reason: ProcessFailureReason::Crashed,
            })
        );
    }
}
