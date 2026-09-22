use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{
    AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, State, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder,
};

const AMBIENT_EVENT: &str = "jarvis://ambient-snapshot";
const AMBIENT_PREFIX: &str = "jarvis-ambient-";

fn is_false(value: &bool) -> bool {
    !*value
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum JarvisAmbientState {
    Idle,
    Listening,
    Speaking,
    Working,
    Needs,
    Done,
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JarvisAmbientSnapshot {
    pub revision: u64,
    pub state: JarvisAmbientState,
    pub source: String,
    pub observed_at: i64,
    pub energy: f64,
    pub transient_until: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub active: Option<bool>,
    #[serde(default, skip_serializing_if = "is_false")]
    pub prewarm: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
}

struct AmbientInner {
    snapshot: JarvisAmbientSnapshot,
    ready: HashSet<String>,
}

pub struct JarvisAmbientOverlayState(Mutex<AmbientInner>, Mutex<()>, AtomicBool);

impl Default for JarvisAmbientOverlayState {
    fn default() -> Self {
        Self(
            Mutex::new(AmbientInner {
                snapshot: JarvisAmbientSnapshot {
                    revision: 0,
                    state: JarvisAmbientState::Idle,
                    source: "voice".to_owned(),
                    observed_at: 0,
                    energy: 0.0,
                    transient_until: None,
                    active: Some(false),
                    prewarm: false,
                    session_id: None,
                },
                ready: HashSet::new(),
            }),
            Mutex::new(()),
            AtomicBool::new(false),
        )
    }
}

fn parse_coordinate(value: &str) -> bool {
    value
        .strip_prefix('n')
        .unwrap_or(value)
        .parse::<i32>()
        .is_ok()
}

fn trusted_caller(label: &str, renderer: bool) -> bool {
    if !renderer {
        return label == "main";
    }
    let Some(suffix) = label.strip_prefix(AMBIENT_PREFIX) else {
        return false;
    };
    let parts: Vec<_> = suffix.split('-').collect();
    parts.len() == 3
        && parts[0].parse::<usize>().is_ok()
        && parse_coordinate(parts[1])
        && parse_coordinate(parts[2])
}

fn validate_snapshot(
    snapshot: &JarvisAmbientSnapshot,
    current_revision: u64,
) -> Result<(), String> {
    if snapshot.revision <= current_revision {
        return Err("jarvis_ambient_revision_stale".to_owned());
    }
    if snapshot.session_id.as_ref().is_some_and(|value| {
        value.is_empty() || value.len() > 160 || value.chars().any(char::is_control)
    }) {
        return Err("jarvis_ambient_session_invalid".to_owned());
    }
    if snapshot.observed_at < 0
        || snapshot.transient_until.is_some_and(|value| value < 0)
        || !snapshot.energy.is_finite()
        || !(0.0..=1.0).contains(&snapshot.energy)
    {
        return Err("jarvis_ambient_snapshot_invalid".to_owned());
    }
    if snapshot.prewarm
        && (snapshot.state != JarvisAmbientState::Idle || snapshot_active(snapshot))
    {
        return Err("jarvis_ambient_prewarm_invalid".to_owned());
    }
    if !matches!(
        snapshot.source.as_str(),
        "voice" | "approval" | "question" | "plan" | "task" | "agent" | "command"
    ) {
        return Err("jarvis_ambient_source_invalid".to_owned());
    }
    Ok(())
}

fn coordinate_label(value: i32) -> String {
    if value < 0 {
        format!("n{}", value.unsigned_abs())
    } else {
        value.to_string()
    }
}

fn stable_monitor_label(index: usize, x: i32, y: i32) -> String {
    format!(
        "{AMBIENT_PREFIX}{index}-{}-{}",
        coordinate_label(x),
        coordinate_label(y)
    )
}

fn classify_visibility(state: JarvisAmbientState, renderer_ready: bool) -> bool {
    renderer_ready && state != JarvisAmbientState::Idle
}

fn snapshot_active(snapshot: &JarvisAmbientSnapshot) -> bool {
    snapshot
        .active
        .unwrap_or(snapshot.state != JarvisAmbientState::Idle)
}

fn should_reconcile_windows(state: JarvisAmbientState, has_existing_window: bool) -> bool {
    state != JarvisAmbientState::Idle || has_existing_window
}

#[cfg(target_os = "windows")]
fn apply_native_overlay_styles(window: &WebviewWindow) {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::{
        GetWindowLongPtrW, SetWindowLongPtrW, SetWindowPos, GWL_EXSTYLE, HWND_TOPMOST,
        SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW, WS_EX_TOPMOST,
        WS_EX_TRANSPARENT,
    };

    let Ok(raw) = window.hwnd() else { return };
    let hwnd = HWND(raw.0 as *mut _);
    unsafe {
        let current = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
        let required =
            (WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW | WS_EX_TOPMOST | WS_EX_TRANSPARENT).0 as isize;
        let _ = SetWindowLongPtrW(hwnd, GWL_EXSTYLE, current | required);
        let _ = SetWindowPos(
            hwnd,
            Some(HWND_TOPMOST),
            0,
            0,
            0,
            0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
        );
    }
}

#[cfg(not(target_os = "windows"))]
fn apply_native_overlay_styles(_window: &WebviewWindow) {}

fn configure_window(
    window: &WebviewWindow,
    position: PhysicalPosition<i32>,
    size: PhysicalSize<u32>,
) {
    let _ = window.set_decorations(false);
    let _ = window.set_shadow(false);
    let _ = window.set_background_color(Some(tauri::window::Color(0, 0, 0, 0)));
    let _ = window.set_ignore_cursor_events(true);
    let _ = window.set_always_on_top(true);
    let _ = window.set_position(position);
    let _ = window.set_size(size);
    apply_native_overlay_styles(window);
}

fn ensure_windows(
    app: &AppHandle,
    snapshot: &JarvisAmbientSnapshot,
    ready: &HashSet<String>,
) -> Result<(), String> {
    let has_existing_window = app
        .webview_windows()
        .keys()
        .any(|label| label.starts_with(AMBIENT_PREFIX));
    let prewarming = snapshot_prewarming(snapshot);
    if !snapshot_active(snapshot) && !prewarming {
        for (label, window) in app.webview_windows() {
            if label.starts_with(AMBIENT_PREFIX) {
                window
                    .destroy()
                    .map_err(|_| "jarvis_ambient_window_close_failed".to_owned())?;
            }
        }
        app.state::<JarvisAmbientOverlayState>()
            .0
            .lock()
            .map_err(|_| "jarvis_ambient_state_poisoned".to_owned())?
            .ready
            .clear();
        return Ok(());
    }
    if !should_reconcile_windows(snapshot.state, has_existing_window)
        && snapshot.active != Some(true)
        && !prewarming
    {
        return Ok(());
    }
    let monitors = app
        .available_monitors()
        .map_err(|error| format!("jarvis_ambient_monitors_unavailable:{error}"))?;
    let mut expected = HashSet::new();
    for (index, monitor) in monitors.iter().enumerate() {
        let position = *monitor.position();
        let size = *monitor.size();
        let label = stable_monitor_label(index, position.x, position.y);
        expected.insert(label.clone());
        let window = if let Some(existing) = app.get_webview_window(&label) {
            existing
        } else {
            let scale = monitor.scale_factor();
            let built = WebviewWindowBuilder::new(
                app,
                &label,
                WebviewUrl::App("index.html?view=jarvis-ambient-overlay".into()),
            )
            .title("VibeSpace Jarvis Aura")
            .inner_size(size.width as f64 / scale, size.height as f64 / scale)
            // Materialize WebView2 without exposing unfinished content or stealing focus.
            .position(-32_000.0, -32_000.0)
            .resizable(false)
            .decorations(false)
            .transparent(true)
            .always_on_top(true)
            .visible_on_all_workspaces(true)
            .focusable(false)
            .skip_taskbar(true)
            .visible(true)
            .focused(false)
            .shadow(false)
            .additional_browser_args(
                app.config()
                    .app
                    .windows
                    .iter()
                    .find(|window| window.label == "main")
                    .and_then(|window| window.additional_browser_args.as_deref())
                    .unwrap_or(""),
            )
            .background_color(tauri::window::Color(0, 0, 0, 0))
            .build()
            .map_err(|error| format!("jarvis_ambient_window_create_failed:{error}"))?;
            #[cfg(debug_assertions)]
            eprintln!("[jarvis-aura] materialized {label} offscreen");
            built
        };
        let still_current = {
            let state = app.state::<JarvisAmbientOverlayState>();
            let inner = state
                .0
                .lock()
                .map_err(|_| "jarvis_ambient_state_poisoned".to_owned())?;
            inner.snapshot.revision == snapshot.revision
                && (snapshot_active(&inner.snapshot) || snapshot_prewarming(&inner.snapshot))
        };
        if !still_current {
            return Ok(());
        }
        let _ = app.emit_to(&label, AMBIENT_EVENT, snapshot);
        if ready.contains(&label) {
            if snapshot.active == Some(true) || classify_visibility(snapshot.state, true) {
                configure_window(&window, position, size);
                let _ = window.show();
            } else if prewarming {
                let _ = window.hide();
            }
        }
        // Until renderer readiness, keep the transparent host offscreen and
        // materialized; hiding it here can suspend WebView2 initialization.
    }

    for (label, window) in app.webview_windows() {
        if label.starts_with(AMBIENT_PREFIX) && !expected.contains(&label) {
            let _ = window.destroy();
        }
    }
    Ok(())
}

// Serialize window mutations off the IPC thread, always using the latest accepted intent.
fn reconcile_latest(app: &AppHandle) -> Result<(), String> {
    let state = app.state::<JarvisAmbientOverlayState>();
    let _guard = state
        .1
        .lock()
        .map_err(|_| "jarvis_ambient_reconcile_poisoned".to_owned())?;
    let (snapshot, ready) = {
        let inner = state
            .0
            .lock()
            .map_err(|_| "jarvis_ambient_state_poisoned".to_owned())?;
        (inner.snapshot.clone(), inner.ready.clone())
    };
    ensure_windows(app, &snapshot, &ready)
}

// WebView2 construction must run outside an event-loop callback on Windows.
// Tauri's builder dispatches the native operations itself. Coalesce updates
// while it builds, then reconcile the latest accepted intent.
fn schedule_reconcile(app: &AppHandle) -> Result<(), String> {
    if app.state::<JarvisAmbientOverlayState>().2.swap(true, Ordering::AcqRel) {
        return Ok(());
    }
    let worker_app = app.clone();
    std::thread::Builder::new()
        .name("jarvis-aura-reconcile".into())
        .spawn(move || {
            let intent = || {
                worker_app.state::<JarvisAmbientOverlayState>().0.lock().ok()
                    .map(|inner| (inner.snapshot.revision, inner.ready.clone()))
            };
            let intent_before = intent();
            if let Err(error) = reconcile_latest(&worker_app) {
                eprintln!("[jarvis-aura] reconciliation failed: {error}");
            }
            worker_app.state::<JarvisAmbientOverlayState>().2.store(false, Ordering::Release);
            if intent_before != intent() {
                let _ = schedule_reconcile(&worker_app);
            }
        })
        .map(|_| ())
        .map_err(|_| {
            app.state::<JarvisAmbientOverlayState>().2.store(false, Ordering::Release);
            "jarvis_ambient_reconcile_worker_failed".to_owned()
        })
}

fn snapshot_prewarming(snapshot: &JarvisAmbientSnapshot) -> bool {
    snapshot.prewarm && snapshot.state == JarvisAmbientState::Idle && !snapshot_active(snapshot)
}

#[tauri::command]
pub async fn set_jarvis_ambient_snapshot(
    window: WebviewWindow,
    app: AppHandle,
    state: State<'_, JarvisAmbientOverlayState>,
    snapshot: JarvisAmbientSnapshot,
) -> Result<(), String> {
    if !trusted_caller(window.label(), false) {
        return Err("jarvis_ambient_caller_denied".to_owned());
    }
    {
        let mut inner = state
            .0
            .lock()
            .map_err(|_| "jarvis_ambient_state_poisoned".to_owned())?;
        validate_snapshot(&snapshot, inner.snapshot.revision)?;
        inner.snapshot = snapshot;
    };
    schedule_reconcile(&app)
}

#[tauri::command]
pub async fn jarvis_ambient_renderer_ready(
    window: WebviewWindow,
    app: AppHandle,
    state: State<'_, JarvisAmbientOverlayState>,
) -> Result<JarvisAmbientSnapshot, String> {
    if !trusted_caller(window.label(), true) {
        return Err("jarvis_ambient_renderer_denied".to_owned());
    }
    let snapshot = {
        let mut inner = state
            .0
            .lock()
            .map_err(|_| "jarvis_ambient_state_poisoned".to_owned())?;
        inner.ready.insert(window.label().to_owned());
        inner.snapshot.clone()
    };
    schedule_reconcile(&app)?;
    Ok(snapshot)
}

#[cfg(test)]
mod tests {
    use super::{
        classify_visibility, should_reconcile_windows, stable_monitor_label, trusted_caller,
        validate_snapshot, JarvisAmbientSnapshot, JarvisAmbientState,
    };

    fn snapshot(revision: u64, state: JarvisAmbientState) -> JarvisAmbientSnapshot {
        JarvisAmbientSnapshot {
            revision,
            state,
            source: "voice".to_owned(),
            observed_at: 100,
            energy: 0.5,
            transient_until: None,
            active: None,
            prewarm: false,
            session_id: None,
        }
    }

    #[test]
    fn ambient_ipc_preserves_explicit_close_and_session_identity() {
        let value = serde_json::json!({
            "revision": 2, "state": "speaking", "source": "voice",
            "observedAt": 100, "energy": 0.5, "active": false,
            "sessionId": "voice-disposable-test",
        });
        let decoded: JarvisAmbientSnapshot = serde_json::from_value(value).unwrap();
        let encoded = serde_json::to_value(decoded).unwrap();
        assert_eq!(encoded.get("active"), Some(&serde_json::Value::Bool(false)));
        assert_eq!(
            encoded.get("sessionId").and_then(|value| value.as_str()),
            Some("voice-disposable-test")
        );
    }

    #[test]
    fn ambient_ipc_rejects_non_boolean_visibility_intent() {
        let value = serde_json::json!({
            "revision": 2, "state": "listening", "source": "voice",
            "observedAt": 100, "energy": 0.5, "active": "yes",
        });
        assert!(serde_json::from_value::<JarvisAmbientSnapshot>(value).is_err());
    }

    #[test]
    fn ambient_ipc_round_trips_native_prewarm_intent() {
        let value = serde_json::json!({
            "revision": 2, "state": "idle", "source": "voice",
            "observedAt": 100, "energy": 0.0, "active": false, "prewarm": true,
        });
        let decoded: JarvisAmbientSnapshot = serde_json::from_value(value).unwrap();
        assert!(validate_snapshot(&decoded, 1).is_ok());
        let encoded = serde_json::to_value(decoded).unwrap();
        assert_eq!(encoded.get("prewarm"), Some(&serde_json::Value::Bool(true)));
    }

    #[test]
    fn validates_bounded_monotonic_snapshots() {
        assert!(validate_snapshot(&snapshot(2, JarvisAmbientState::Listening), 1).is_ok());
        assert!(validate_snapshot(&snapshot(1, JarvisAmbientState::Listening), 1).is_err());
        let mut invalid = snapshot(2, JarvisAmbientState::Speaking);
        invalid.energy = 1.01;
        assert!(validate_snapshot(&invalid, 1).is_err());
        invalid.energy = 0.5;
        invalid.observed_at = -1;
        assert!(validate_snapshot(&invalid, 1).is_err());
    }

    #[test]
    fn prewarm_is_valid_only_for_an_inactive_idle_snapshot() {
        let mut idle = snapshot(2, JarvisAmbientState::Idle);
        idle.prewarm = true;
        assert!(validate_snapshot(&idle, 1).is_ok());
        assert!(super::snapshot_prewarming(&idle));

        idle.state = JarvisAmbientState::Listening;
        idle.active = Some(true);
        assert!(validate_snapshot(&idle, 1).is_err());
        assert!(!super::snapshot_prewarming(&idle));
    }

    #[test]
    fn trusts_only_main_and_matching_ambient_renderers() {
        assert!(trusted_caller("main", false));
        assert!(trusted_caller("jarvis-ambient-0-0-0", true));
        assert!(!trusted_caller("pet-overlay", false));
        assert!(!trusted_caller("jarvis-ambient-spoof", true));
    }

    #[test]
    fn labels_monitors_stably_and_hides_idle() {
        assert_eq!(
            stable_monitor_label(1, -1920, 0),
            "jarvis-ambient-1-n1920-0"
        );
        assert!(!classify_visibility(JarvisAmbientState::Idle, true));
        assert!(!classify_visibility(JarvisAmbientState::Working, false));
        assert!(classify_visibility(JarvisAmbientState::Working, true));
        assert!(!should_reconcile_windows(JarvisAmbientState::Idle, false));
        assert!(should_reconcile_windows(JarvisAmbientState::Idle, true));
        assert!(should_reconcile_windows(JarvisAmbientState::Working, false));
    }

    #[test]
    fn ambient_window_reconciliation_yields_the_ipc_handler() {
        let source = include_str!("jarvis_ambient_overlay.rs");
        let snapshot_start = source
            .find("pub async fn set_jarvis_ambient_snapshot")
            .or_else(|| source.find("pub fn set_jarvis_ambient_snapshot"))
            .expect("snapshot command exists");
        let ready_start = source
            .find("pub async fn jarvis_ambient_renderer_ready")
            .or_else(|| source.find("pub fn jarvis_ambient_renderer_ready"))
            .expect("renderer-ready command exists");
        let tests_start = source.rfind("#[cfg(test)]").expect("tests are bounded");

        let scheduler = source.split("fn schedule_reconcile(app:").nth(1).unwrap()
            .split("#[tauri::command]").next().unwrap();
        assert!(scheduler.contains(".spawn(move ||"));
        assert!(scheduler.contains("reconcile_latest(&worker_app)"));
        assert!(!scheduler.contains("run_on_main_thread"));
        let snapshot_command = &source[snapshot_start..ready_start];
        let ready_command = &source[ready_start..tests_start];
        assert!(snapshot_command.contains("pub async fn set_jarvis_ambient_snapshot"));
        assert!(ready_command.contains("pub async fn jarvis_ambient_renderer_ready"));
        assert!(snapshot_command.contains("schedule_reconcile(&app)"));
        assert!(!snapshot_command.contains(".await"));
        assert!(ready_command.contains("schedule_reconcile(&app)"));
        assert!(!ready_command.contains(".await"));
        assert!(!snapshot_command
            .ends_with("ensure_windows(&app, &accepted, &ready)\n}\n\n#[tauri::command]\n"));
    }
}
