use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{Listener, Manager, Runtime, WebviewWindowBuilder};

const RENDERER_HEARTBEAT_EVENT: &str = "jarvis:renderer-heartbeat";
const WATCHDOG_INTERVAL: Duration = Duration::from_secs(5);
const RENDERER_STALE_AFTER: Duration = Duration::from_secs(30);
const RECOVERY_RETRY_AFTER: Duration = Duration::from_secs(20);
const MAX_WEBVIEW_RELOADS: u8 = 2;
const MAX_WEBVIEW_RECREATIONS_WHILE_RESTART_BLOCKED: u8 = 3;
const RESTART_CIRCUIT_HEALTHY_AFTER: Duration = Duration::from_secs(60);
const TERMINAL_RESTART_GATE_TIMEOUT: Duration = Duration::from_secs(5);
const WEBVIEW_RECREATE_TIMEOUT: Duration = Duration::from_secs(15);
const RECOVERY_MARKER_FILE: &str = "renderer-recovery.marker";
const RECOVERY_CIRCUIT_FILE: &str = "renderer-recovery-circuit.marker";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum RecoveryAction {
    None,
    ReloadWebview,
    RecreateWebview,
    RestartApplication,
}

#[derive(Debug)]
struct RecoveryProgress {
    reload_attempts: u8,
    recreate_attempts: u8,
    last_action_at: Option<Instant>,
}

struct RendererWatchdog {
    last_heartbeat: Mutex<Instant>,
    recovery: Mutex<RecoveryProgress>,
    process_restart_allowed: AtomicBool,
    healthy_since: Mutex<Option<Instant>>,
}

impl RendererWatchdog {
    fn new(process_restart_allowed: bool) -> Self {
        Self {
            last_heartbeat: Mutex::new(Instant::now()),
            recovery: Mutex::new(RecoveryProgress {
                reload_attempts: 0,
                recreate_attempts: 0,
                last_action_at: None,
            }),
            process_restart_allowed: AtomicBool::new(process_restart_allowed),
            healthy_since: Mutex::new(None),
        }
    }

    fn record_heartbeat(&self) -> bool {
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
    _focused: bool,
) -> bool {
    heartbeat_age > RENDERER_STALE_AFTER && visible
}

pub(crate) fn next_recovery_action(
    heartbeat_age: Duration,
    visible: bool,
    reload_attempts: u8,
    recreate_attempts: u8,
    time_since_last_action: Option<Duration>,
    allow_process_restart: bool,
) -> RecoveryAction {
    if !should_restart_renderer(heartbeat_age, visible, false) {
        return RecoveryAction::None;
    }
    if reload_attempts > 0
        && time_since_last_action
            .map(|elapsed| elapsed < RECOVERY_RETRY_AFTER)
            .unwrap_or(true)
    {
        return RecoveryAction::None;
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

#[derive(Debug, Clone, Copy)]
struct MainWindowPresentation {
    position: Option<tauri::PhysicalPosition<i32>>,
    size: Option<tauri::PhysicalSize<u32>>,
    maximized: bool,
    fullscreen: bool,
    visible: bool,
    focused: bool,
}

fn capture_main_window_presentation<R: Runtime>(
    window: &tauri::Window<R>,
) -> MainWindowPresentation {
    MainWindowPresentation {
        position: window.outer_position().ok(),
        size: window.inner_size().ok(),
        maximized: window.is_maximized().unwrap_or(false),
        fullscreen: window.is_fullscreen().unwrap_or(false),
        visible: window.is_visible().unwrap_or(true),
        focused: window.is_focused().unwrap_or(false),
    }
}

fn restore_main_window_presentation<R: Runtime>(
    window: &tauri::Window<R>,
    presentation: MainWindowPresentation,
) {
    if let Some(size) = presentation.size {
        let _ = window.set_size(size);
    }
    if let Some(position) = presentation.position {
        let _ = window.set_position(position);
    }
    if presentation.maximized {
        let _ = window.maximize();
    }
    if presentation.fullscreen {
        let _ = window.set_fullscreen(true);
    }
    if presentation.visible {
        let _ = window.show();
    } else {
        let _ = window.hide();
    }
    if presentation.focused {
        let _ = window.set_focus();
    }
}

fn recreate_main_webview<R: Runtime>(app: &tauri::AppHandle<R>) -> Result<(), String> {
    let config = app
        .config()
        .app
        .windows
        .iter()
        .find(|window| window.label == "main")
        .cloned()
        .ok_or_else(|| "main window configuration is missing".to_string())?;
    let existing = app.get_window("main");
    let presentation = existing.as_ref().map(capture_main_window_presentation);
    let app_for_rebuild = app.clone();
    let (result_tx, result_rx) = std::sync::mpsc::sync_channel(1);

    app.run_on_main_thread(move || {
        let result = (|| -> Result<(), String> {
            if let Some(window) = existing {
                window
                    .destroy()
                    .map_err(|error| format!("failed to destroy failed main WebView: {error}"))?;
            }
            let rebuilt = WebviewWindowBuilder::from_config(&app_for_rebuild, &config)
                .map_err(|error| format!("failed to prepare main WebView recreation: {error}"))?
                .build()
                .map_err(|error| format!("failed to recreate main WebView: {error}"))?;
            if let Some(presentation) = presentation {
                let rebuilt_host = app_for_rebuild
                    .get_window(rebuilt.label())
                    .ok_or_else(|| "rebuilt main host window is unavailable".to_string())?;
                restore_main_window_presentation(&rebuilt_host, presentation);
            }
            Ok(())
        })();
        let _ = result_tx.send(result);
    })
    .map_err(|error| format!("failed to schedule main WebView recreation: {error}"))?;

    result_rx
        .recv_timeout(WEBVIEW_RECREATE_TIMEOUT)
        .map_err(|_| "main WebView recreation timed out".to_string())?
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

    app.listen(RENDERER_HEARTBEAT_EVENT, move |_| {
        if heartbeat_state.record_heartbeat() {
            if let Some(path) = &heartbeat_circuit_path {
                let _ = fs::remove_file(path);
            }
        }
    });

    let app_handle = app.handle().clone();
    std::thread::Builder::new()
        .name("renderer-watchdog".into())
        .spawn(move || loop {
            std::thread::sleep(WATCHDOG_INTERVAL);

            let main_window = app_handle.get_window("main");
            let visible = main_window
                .as_ref()
                .and_then(|window| window.is_visible().ok())
                .unwrap_or(true);
            let Some(age) = state.heartbeat_age() else {
                continue;
            };
            let has_active_sessions = app_handle
                .state::<crate::terminal::TerminalState>()
                .has_active_sessions();
            let allow_process_restart =
                state.process_restart_allowed.load(Ordering::SeqCst) && !has_active_sessions;

            let action = {
                let Ok(mut recovery) = state.recovery.lock() else {
                    continue;
                };
                let time_since_last_action =
                    recovery.last_action_at.map(|started| started.elapsed());
                let action = next_recovery_action(
                    age,
                    visible,
                    recovery.reload_attempts,
                    recovery.recreate_attempts,
                    time_since_last_action,
                    allow_process_restart,
                );
                if action == RecoveryAction::ReloadWebview {
                    recovery.reload_attempts = recovery.reload_attempts.saturating_add(1);
                    recovery.last_action_at = Some(Instant::now());
                } else if action == RecoveryAction::RecreateWebview {
                    recovery.recreate_attempts = recovery.recreate_attempts.saturating_add(1);
                    recovery.last_action_at = Some(Instant::now());
                } else if action == RecoveryAction::RestartApplication {
                    recovery.last_action_at = Some(Instant::now());
                }
                if action != RecoveryAction::None {
                    if let Ok(mut healthy_since) = state.healthy_since.lock() {
                        *healthy_since = None;
                    }
                }
                action
            };

            match action {
                RecoveryAction::None => {}
                RecoveryAction::ReloadWebview => {
                    eprintln!(
                        "[renderer-watchdog] main renderer unresponsive for {}s; reloading WebView",
                        age.as_secs()
                    );
                    if let Some(main_webview) = app_handle.get_webview("main") {
                        if let Err(err) = main_webview.reload() {
                            eprintln!("[renderer-watchdog] WebView reload failed: {err}");
                        }
                    } else if let Err(err) = recreate_main_webview(&app_handle) {
                        eprintln!(
                            "[renderer-watchdog] missing main WebView recreation failed: {err}"
                        );
                    }
                }
                RecoveryAction::RecreateWebview => {
                    eprintln!(
                        "[renderer-watchdog] main renderer still unavailable after {}s; recreating WebView without restarting native services",
                        age.as_secs()
                    );
                    if let Err(err) = recreate_main_webview(&app_handle) {
                        eprintln!("[renderer-watchdog] main WebView recreation failed: {err}");
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
                        state
                            .process_restart_allowed
                            .store(false, Ordering::SeqCst);
                        eprintln!(
                            "[renderer-watchdog] WebView recovery exhausted after {}s; restarting VibeSpace",
                            age.as_secs()
                        );
                        app_handle.restart();
                    } else {
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
        can_restart_application, consume_recovery_marker, next_recovery_action,
        should_rearm_process_restart, should_restart_renderer, write_recovery_marker,
        RecoveryAction,
    };
    use std::fs;
    use std::time::Duration;

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
        assert!(should_restart_renderer(stale, true, false));
    }

    #[test]
    fn reloads_the_webview_twice_before_escalating_to_an_application_restart() {
        let stale = Duration::from_secs(31);
        let retry_ready = Duration::from_secs(21);

        assert_eq!(
            next_recovery_action(stale, true, 0, 0, None, true),
            RecoveryAction::ReloadWebview
        );
        assert_eq!(
            next_recovery_action(stale, true, 1, 0, Some(retry_ready), true),
            RecoveryAction::ReloadWebview
        );
        assert_eq!(
            next_recovery_action(stale, true, 2, 0, Some(retry_ready), true),
            RecoveryAction::RecreateWebview
        );
        assert_eq!(
            next_recovery_action(stale, true, 1, 0, Some(Duration::from_secs(10)), true),
            RecoveryAction::None
        );
        assert_eq!(
            next_recovery_action(stale, false, 2, 0, Some(retry_ready), true),
            RecoveryAction::None
        );
        assert_eq!(
            next_recovery_action(stale, true, 2, 1, Some(retry_ready), false),
            RecoveryAction::RecreateWebview
        );
        assert_eq!(
            next_recovery_action(stale, true, 2, 3, Some(retry_ready), false),
            RecoveryAction::None
        );
    }

    #[test]
    fn recreates_the_failed_webview_before_any_process_restart_and_preserves_live_ptys() {
        let stale = Duration::from_secs(31);
        let retry_ready = Duration::from_secs(21);

        assert_eq!(
            next_recovery_action(stale, true, 2, 0, Some(retry_ready), true),
            RecoveryAction::RecreateWebview
        );
        assert_eq!(
            next_recovery_action(stale, true, 2, 0, Some(retry_ready), false),
            RecoveryAction::RecreateWebview
        );
        assert_eq!(
            next_recovery_action(stale, true, 2, 1, Some(retry_ready), true),
            RecoveryAction::RestartApplication
        );
        assert_eq!(
            next_recovery_action(stale, true, 2, 1, Some(retry_ready), false),
            RecoveryAction::RecreateWebview
        );
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
}
