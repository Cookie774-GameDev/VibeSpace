//! Pixel Pet windows: pet-overlay + pet-mini-panel lifecycle and geometry.
//! Least-privilege: only window show/hide/focus/position/size for pet labels.
//! Does not expose shell, unrestricted filesystem, or remote navigation.

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{
    atomic::{AtomicBool, AtomicIsize, AtomicU64, Ordering},
    Mutex,
};
use tauri::{
    AppHandle, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder,
};

pub const PET_OVERLAY_LABEL: &str = "pet-overlay";
pub const PET_MINI_PANEL_LABEL: &str = "pet-mini-panel";

const OVERLAY_SIZE: u32 = 192;
const PANEL_DEFAULT_W: f64 = 430.0;
const PANEL_DEFAULT_H: f64 = 560.0;
const PANEL_MIN_W: f64 = 360.0;
const PANEL_MIN_H: f64 = 360.0;

fn restored_panel_size(width: Option<f64>, height: Option<f64>) -> (f64, f64) {
    (
        width.filter(|value| value.is_finite() && (PANEL_MIN_W..=4000.0).contains(value)).unwrap_or(PANEL_DEFAULT_W),
        height.filter(|value| value.is_finite() && (PANEL_MIN_H..=4000.0).contains(value)).unwrap_or(PANEL_DEFAULT_H),
    )
}
const MAIN_NAV_EXCLUSION_LOGICAL_W: f64 = 240.0;
const PET_AUTOSTART_VALUE_NAME: &str = "VibeSpace";
const TOPMOST_WATCHDOG_INTERVAL_MS: u64 = 1000;
const PET_CREATED_SURFACE_READY_ATTEMPTS: usize = 50;
const PET_CREATED_SURFACE_READY_POLL_MS: u64 = 20;
const PET_MAIN_THREAD_CONFIG_TIMEOUT_MS: u64 = 250;
const PET_DETACHED_BUILD_DELAY_MS: u64 = 80;
const PET_SETUP_OFFSCREEN_POSITION: (f64, f64) = (-32_000.0, -32_000.0);
const PET_SETUP_MATERIALIZATION_DELAY_MS: u64 = 1_000;
const PET_NATIVE_FRAME_STYLE_BITS: isize = 0x00CF_0000;
const PET_NATIVE_FRAME_EX_STYLE_BITS: isize = 0x0002_0301;
#[cfg(target_os = "windows")]
const PET_TOPMOST_POS_FLAGS: windows::Win32::UI::WindowsAndMessaging::SET_WINDOW_POS_FLAGS =
    windows::Win32::UI::WindowsAndMessaging::SET_WINDOW_POS_FLAGS(
        windows::Win32::UI::WindowsAndMessaging::SWP_NOMOVE.0
            | windows::Win32::UI::WindowsAndMessaging::SWP_NOSIZE.0
            | windows::Win32::UI::WindowsAndMessaging::SWP_NOACTIVATE.0,
    );

fn windows_startup_command(executable: &Path) -> String {
    let safe_path = executable.to_string_lossy().replace('"', "");
    format!(r#""{safe_path}""#)
}

/// Stable named-profile identifiers for each privileged Pixel Pet HKCU effect.
/// These match the frozen MC0B side-effect inventory row ids.
pub(crate) const EFFECT_REGISTRY_READ: &str = "pets-36-registry-read";
pub(crate) const EFFECT_REGISTRY_CREATE: &str = "pets-60-registry-create";
pub(crate) const EFFECT_REGISTRY_SET: &str = "pets-65-registry-set";
pub(crate) const EFFECT_REGISTRY_DELETE: &str = "pets-72-registry-delete";

// ---------------------------------------------------------------------------
// Named-profile privileged-effect guard (defense-in-depth).
//
// Production consumes task 114's crate-visible
// crate::runtime_profile::ensure_privileged_effect_allowed; the guard runs
// before any HKCU access. Tests inject an equivalent guard (see credentials.rs
// for the full rationale). Unknown profiles fail closed.
// ---------------------------------------------------------------------------

#[cfg(not(test))]
fn ensure_effect_allowed(effect: &'static str) -> Result<(), String> {
    crate::runtime_profile::ensure_privileged_effect_allowed(
        crate::runtime_profile::DENIED_EFFECT_REGISTRY,
        effect,
    )
}

#[cfg(test)]
type TestGuard = dyn Fn(&'static str) -> Result<(), String>;

#[cfg(test)]
std::thread_local! {
    static TEST_GUARD: std::cell::RefCell<Option<Box<TestGuard>>> =
        const { std::cell::RefCell::new(None) };
}

#[cfg(test)]
fn ensure_effect_allowed(effect: &'static str) -> Result<(), String> {
    TEST_GUARD.with(|slot| match &*slot.borrow() {
        Some(guard) => guard(effect),
        None => Err(format!(
            "privileged effect '{effect}' denied by named-profile guard (fail closed)"
        )),
    })
}

#[cfg(test)]
pub(crate) fn install_test_guard<F>(guard: F)
where
    F: Fn(&'static str) -> Result<(), String> + 'static,
{
    TEST_GUARD.with(|slot| *slot.borrow_mut() = Some(Box::new(guard)));
}

#[cfg(test)]
pub(crate) fn clear_test_guard() {
    TEST_GUARD.with(|slot| *slot.borrow_mut() = None);
}

// ---------------------------------------------------------------------------
// Injectable HKCU autostart effect seam (Windows).
//
// Production performs the real registry access, preserving current behavior
// exactly (including the release-only debug guard and current_exe resolution).
// Tests inject a counting fake so no real HKCU mutation occurs during
// verification, while ordinary-mode tests prove the seam is invoked.
// ---------------------------------------------------------------------------

#[cfg(target_os = "windows")]
trait PetAutostartSink {
    fn read_enabled(&self) -> Result<bool, String>;
    fn enable(&self) -> Result<(), String>;
    fn disable(&self) -> Result<(), String>;
}

#[cfg(all(target_os = "windows", not(test)))]
struct RealPetAutostart;

#[cfg(all(target_os = "windows", not(test)))]
impl PetAutostartSink for RealPetAutostart {
    fn read_enabled(&self) -> Result<bool, String> {
        use winreg::enums::{HKEY_CURRENT_USER, KEY_READ};
        use winreg::RegKey;
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        let run = match hkcu
            .open_subkey_with_flags(r"Software\Microsoft\Windows\CurrentVersion\Run", KEY_READ)
        {
            Ok(run) => run,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
            Err(error) => return Err(format!("failed to read Windows startup settings: {error}")),
        };
        Ok(run.get_value::<String, _>(PET_AUTOSTART_VALUE_NAME).is_ok())
    }

    fn enable(&self) -> Result<(), String> {
        use winreg::enums::HKEY_CURRENT_USER;
        use winreg::RegKey;
        if cfg!(debug_assertions) {
            return Err(
                "Start with Windows can only be changed by an installed release build".into(),
            );
        }
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        let (run, _) = hkcu
            .create_subkey(r"Software\Microsoft\Windows\CurrentVersion\Run")
            .map_err(|error| format!("failed to open Windows startup settings: {error}"))?;
        let executable = std::env::current_exe()
            .map_err(|error| format!("failed to resolve the installed executable: {error}"))?;
        run.set_value(
            PET_AUTOSTART_VALUE_NAME,
            &windows_startup_command(&executable),
        )
        .map_err(|error| format!("failed to enable Windows startup: {error}"))
    }

    fn disable(&self) -> Result<(), String> {
        use winreg::enums::HKEY_CURRENT_USER;
        use winreg::RegKey;
        if cfg!(debug_assertions) {
            return Err(
                "Start with Windows can only be changed by an installed release build".into(),
            );
        }
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        let (run, _) = hkcu
            .create_subkey(r"Software\Microsoft\Windows\CurrentVersion\Run")
            .map_err(|error| format!("failed to open Windows startup settings: {error}"))?;
        match run.delete_value(PET_AUTOSTART_VALUE_NAME) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(format!("failed to disable Windows startup: {error}")),
        }
    }
}

#[cfg(all(target_os = "windows", not(test)))]
fn sink() -> &'static dyn PetAutostartSink {
    &RealPetAutostart
}

#[cfg(all(target_os = "windows", test))]
#[derive(Default)]
struct CountingPetAutostart {
    enabled: std::cell::RefCell<bool>,
    counters: std::cell::RefCell<std::collections::HashMap<&'static str, usize>>,
}

#[cfg(all(target_os = "windows", test))]
impl CountingPetAutostart {
    fn bump(&self, effect: &'static str) {
        *self.counters.borrow_mut().entry(effect).or_insert(0) += 1;
    }
    fn count(&self, effect: &'static str) -> usize {
        self.counters.borrow().get(effect).copied().unwrap_or(0)
    }
    fn total(&self) -> usize {
        self.counters.borrow().values().sum()
    }
}

#[cfg(all(target_os = "windows", test))]
impl PetAutostartSink for CountingPetAutostart {
    fn read_enabled(&self) -> Result<bool, String> {
        self.bump(EFFECT_REGISTRY_READ);
        Ok(*self.enabled.borrow())
    }
    fn enable(&self) -> Result<(), String> {
        self.bump(EFFECT_REGISTRY_CREATE);
        self.bump(EFFECT_REGISTRY_SET);
        *self.enabled.borrow_mut() = true;
        Ok(())
    }
    fn disable(&self) -> Result<(), String> {
        self.bump(EFFECT_REGISTRY_CREATE);
        self.bump(EFFECT_REGISTRY_DELETE);
        *self.enabled.borrow_mut() = false;
        Ok(())
    }
}

#[cfg(all(target_os = "windows", test))]
std::thread_local! {
    static TEST_SINK: std::cell::RefCell<Option<std::rc::Rc<CountingPetAutostart>>> =
        const { std::cell::RefCell::new(None) };
}

#[cfg(all(target_os = "windows", test))]
fn sink() -> std::rc::Rc<CountingPetAutostart> {
    TEST_SINK
        .with(|slot| slot.borrow().clone())
        .expect("test pet autostart sink not installed")
}

#[cfg(all(target_os = "windows", test))]
fn install_counting_sink() -> std::rc::Rc<CountingPetAutostart> {
    let sink = std::rc::Rc::new(CountingPetAutostart::default());
    TEST_SINK.with(|slot| *slot.borrow_mut() = Some(sink.clone()));
    sink
}

#[cfg(target_os = "windows")]
fn get_windows_startup_enabled() -> Result<bool, String> {
    ensure_effect_allowed(EFFECT_REGISTRY_READ)?;
    sink().read_enabled()
}

#[cfg(not(target_os = "windows"))]
fn get_windows_startup_enabled() -> Result<bool, String> {
    Ok(false)
}

#[cfg(target_os = "windows")]
fn set_windows_startup_enabled(enabled: bool) -> Result<bool, String> {
    ensure_effect_allowed(EFFECT_REGISTRY_CREATE)?;
    if enabled {
        ensure_effect_allowed(EFFECT_REGISTRY_SET)?;
        sink().enable()?;
        return Ok(true);
    }
    ensure_effect_allowed(EFFECT_REGISTRY_DELETE)?;
    sink().disable()?;
    Ok(false)
}

#[cfg(not(target_os = "windows"))]
fn set_windows_startup_enabled(_enabled: bool) -> Result<bool, String> {
    Err("Start with Windows is only available on Windows".into())
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, Default, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum PetPanelMode {
    FollowPet,
    AlwaysOnTop,
    #[default]
    Normal,
}

fn panel_stays_on_top(_mode: PetPanelMode) -> bool {
    // Position modes (follow vs parked) do not drop OS z-order. A visible
    // panel stays above other apps the same way the pet sprite does.
    true
}

#[cfg(any(not(target_os = "windows"), test))]
fn should_pin_pet_window(visible: bool, minimized: bool) -> bool {
    visible && !minimized
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct PetGeometryState {
    pub overlay_x: Option<f64>,
    pub overlay_y: Option<f64>,
    pub overlay_monitor_name: Option<String>,
    pub panel_x: Option<f64>,
    pub panel_y: Option<f64>,
    pub panel_w: Option<f64>,
    pub panel_h: Option<f64>,
    pub panel_monitor_name: Option<String>,
}

#[derive(Default)]
pub struct PetWindowState {
    pub geometry: Mutex<PetGeometryState>,
    pub panel_open: Mutex<bool>,
    pub overlay_lifecycle: Mutex<()>,
    pub panel_lifecycle: Mutex<()>,
    pub reconstrain_generation: AtomicU64,
    pub overlay_visibility_generation: AtomicU64,
    pub panel_visibility_generation: AtomicU64,
    pub topmost_watchdog_started: AtomicBool,
    pub overlay_native_hwnd: AtomicIsize,
    pub panel_native_hwnd: AtomicIsize,
}

fn pet_native_hwnd_slot<'a>(state: &'a PetWindowState, label: &str) -> Option<&'a AtomicIsize> {
    match label {
        PET_OVERLAY_LABEL => Some(&state.overlay_native_hwnd),
        PET_MINI_PANEL_LABEL => Some(&state.panel_native_hwnd),
        _ => None,
    }
}

/// The acknowledged outcome of asking the native runtime to show the detached
/// Pet overlay. This is deliberately distinct from a renderer-ready signal:
/// native code can prove window creation/visibility, but cannot prove that the
/// WebView has painted the Pixi scene.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PetOverlayShowResult {
    /// `native-overlay` is the only successful Tauri mode. The UI must not
    /// silently reinterpret a failure as an inline overlay.
    pub mode: &'static str,
    /// Whether this request created the native window (rather than reusing it).
    pub created: bool,
    /// Read back after `show`; false means callers must treat the request as a
    /// failed acknowledgement rather than a usable desktop overlay.
    pub visible: bool,
    /// The Tauri topmost request completed. Absolute z-order is still subject
    /// to Windows platform limitations and has a separate native acceptance row.
    pub topmost_applied: bool,
    /// Native window code cannot truthfully observe renderer readiness.
    pub renderer_ready: Option<bool>,
    /// Stable, safe failure category. Never contains WebView, OS, or GPU text.
    pub reason: Option<&'static str>,
}

impl PetOverlayShowResult {
    fn visible(created: bool) -> Self {
        Self {
            mode: "native-overlay",
            created,
            visible: true,
            topmost_applied: true,
            renderer_ready: None,
            reason: None,
        }
    }

    fn failed(reason: &'static str) -> Self {
        Self::failed_after_create(false, reason)
    }

    fn failed_after_create(created: bool, reason: &'static str) -> Self {
        Self {
            mode: "native-overlay",
            created,
            visible: false,
            topmost_applied: false,
            renderer_ready: None,
            reason: Some(reason),
        }
    }
}

/// The acknowledged outcome of opening the one native Pet Panel. As with the
/// overlay contract, the native runtime proves only window lifecycle state,
/// not that a renderer has painted the Chat, Terminal, or Activity surface.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PetPanelOpenResult {
    pub mode: &'static str,
    pub created: bool,
    pub visible: bool,
    pub focused: bool,
    pub topmost_applied: bool,
    pub renderer_ready: Option<bool>,
    pub reason: Option<&'static str>,
}

impl PetPanelOpenResult {
    fn visible_and_focused(created: bool) -> Self {
        Self {
            mode: "native-panel",
            created,
            visible: true,
            focused: true,
            topmost_applied: true,
            renderer_ready: None,
            reason: None,
        }
    }

    fn failed(created: bool, reason: &'static str) -> Self {
        Self {
            mode: "native-panel",
            created,
            visible: false,
            focused: false,
            topmost_applied: false,
            renderer_ready: None,
            reason: Some(reason),
        }
    }
}

fn geometry_path(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .app_data_dir()
        .ok()
        .map(|d| d.join("pets").join("window-geometry.json"))
}

pub fn load_geometry(app: &AppHandle) -> PetGeometryState {
    if let Some(path) = geometry_path(app) {
        if let Some(geometry) = read_geometry(&path) {
            return geometry;
        }
        if let Some(previous) = previous_geometry_path(app) {
            if let Some(geometry) = read_geometry(&previous) {
                return geometry;
            }
        }
    }
    PetGeometryState::default()
}

pub fn save_geometry(app: &AppHandle, geo: &PetGeometryState) {
    if !geometry_is_valid(geo) {
        return;
    }
    if let Some(path) = geometry_path(app) {
        if let Some(parent) = path.parent() {
            let _ = fs::create_dir_all(parent);
        }
        if let Ok(bytes) = serde_json::to_vec_pretty(geo) {
            let temp = path.with_extension("json.tmp");
            if let Ok(mut file) = fs::File::create(&temp) {
                use std::io::Write;
                if file.write_all(&bytes).is_ok() && file.sync_all().is_ok() {
                    if path.exists() {
                        if let Some(previous) = previous_geometry_path(app) {
                            let _ = fs::copy(&path, previous);
                        }
                    }
                    if fs::rename(&temp, &path).is_err() {
                        let _ = fs::remove_file(&path);
                        let _ = fs::rename(&temp, &path);
                    }
                }
            }
            let _ = fs::remove_file(temp);
        }
    }
}

/// Clamp physical position into an operating-system monitor work area.
fn clamp_to_monitors(
    app: &AppHandle,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
    preferred_monitor_name: Option<&str>,
) -> (f64, f64) {
    let monitors = app.available_monitors().unwrap_or_default();
    if monitors.is_empty() {
        return if x.is_finite() && y.is_finite() {
            (x.max(0.0), y.max(0.0))
        } else {
            (24.0, 120.0)
        };
    }
    let x = if x.is_finite() { x } else { 24.0 };
    let y = if y.is_finite() { y } else { 120.0 };
    let w = if w.is_finite() && w > 0.0 {
        w
    } else {
        OVERLAY_SIZE as f64
    };
    let h = if h.is_finite() && h > 0.0 {
        h
    } else {
        OVERLAY_SIZE as f64
    };
    let containing = monitors.iter().find(|monitor| {
        let area = monitor.work_area();
        let pos = area.position;
        let size = area.size;
        let mx = pos.x as f64;
        let my = pos.y as f64;
        let mw = size.width as f64;
        let mh = size.height as f64;
        x >= mx && y >= my && x < mx + mw && y < my + mh
    });
    let preferred = preferred_monitor_name.and_then(|name| {
        monitors.iter().find(|monitor| {
            monitor
                .name()
                .is_some_and(|monitor_name| monitor_name == name)
        })
    });
    let primary = app.primary_monitor().ok().flatten();
    let m = match containing
        .cloned()
        .or_else(|| preferred.cloned())
        .or(primary)
        .or_else(|| monitors.first().cloned())
    {
        Some(m) => m,
        None => return (x.max(0.0), y.max(0.0)),
    };
    let area = m.work_area();
    let pos = area.position;
    let size = area.size;
    let mx = pos.x as f64;
    let my = pos.y as f64;
    let mw = size.width as f64;
    let mh = size.height as f64;
    let cx = x.clamp(mx, (mx + mw - w).max(mx));
    let cy = y.clamp(my, (my + mh - h).max(my));
    (cx, cy)
}

fn main_nav_exclusion_active(main_visible: bool, main_minimized: bool) -> bool {
    main_visible && !main_minimized
}

#[derive(Clone, Debug, PartialEq)]
struct MonitorWorkArea {
    name: Option<String>,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

#[derive(Clone, Debug, PartialEq)]
struct OverlayPlacement {
    x: f64,
    y: f64,
    monitor_name: Option<String>,
}

fn monitor_work_areas(app: &AppHandle) -> Vec<MonitorWorkArea> {
    app.available_monitors()
        .unwrap_or_default()
        .into_iter()
        .map(|monitor| {
            let area = monitor.work_area();
            MonitorWorkArea {
                name: monitor.name().cloned(),
                x: area.position.x as f64,
                y: area.position.y as f64,
                width: area.size.width as f64,
                height: area.size.height as f64,
            }
        })
        .collect()
}

fn clamp_to_work_area(x: f64, y: f64, w: f64, h: f64, area: &MonitorWorkArea) -> (f64, f64) {
    (
        x.clamp(area.x, (area.x + area.width - w).max(area.x)),
        y.clamp(area.y, (area.y + area.height - h).max(area.y)),
    )
}

fn final_monitor_name_for_position(
    areas: &[MonitorWorkArea],
    x: f64,
    y: f64,
    observed_monitor_name: Option<String>,
) -> Option<String> {
    areas
        .iter()
        .find(|area| {
            x >= area.x && y >= area.y && x < area.x + area.width && y < area.y + area.height
        })
        .and_then(|area| area.name.clone())
        .or(observed_monitor_name)
}

fn main_nav_exit_candidates(
    x: f64,
    y: f64,
    w: f64,
    h: f64,
    main_x: f64,
    main_y: f64,
    main_w: f64,
    main_h: f64,
    main_scale_factor: f64,
) -> Option<[(f64, f64); 4]> {
    let scale = if main_scale_factor.is_finite() && main_scale_factor > 0.0 {
        main_scale_factor
    } else {
        1.0
    };
    let main_right = main_x + main_w.max(0.0);
    let main_bottom = main_y + main_h.max(0.0);
    let nav_right = (main_x + MAIN_NAV_EXCLUSION_LOGICAL_W * scale).min(main_right);
    let overlaps_main_vertically = y < main_bottom && y + h > main_y;
    let overlaps_navigation_horizontally = x < nav_right && x + w > main_x;

    if overlaps_main_vertically && overlaps_navigation_horizontally {
        Some([
            (main_x - w, y),
            (nav_right, y),
            (x, main_y - h),
            (x, main_bottom),
        ])
    } else {
        None
    }
}

fn position_distance_squared(origin: (f64, f64), candidate: (f64, f64)) -> f64 {
    (candidate.0 - origin.0).powi(2) + (candidate.1 - origin.1).powi(2)
}

#[allow(clippy::too_many_arguments)]
fn select_candidate_in_areas(
    raw_candidates: &[(f64, f64); 4],
    origin: (f64, f64),
    w: f64,
    h: f64,
    main_x: f64,
    main_y: f64,
    main_w: f64,
    main_h: f64,
    main_scale_factor: f64,
    areas: &[&MonitorWorkArea],
) -> Option<OverlayPlacement> {
    raw_candidates
        .iter()
        .flat_map(|(candidate_x, candidate_y)| {
            areas.iter().filter_map(move |area| {
                if area.width < w || area.height < h {
                    return None;
                }
                let (x, y) = clamp_to_work_area(*candidate_x, *candidate_y, w, h, area);
                main_nav_exit_candidates(
                    x,
                    y,
                    w,
                    h,
                    main_x,
                    main_y,
                    main_w,
                    main_h,
                    main_scale_factor,
                )
                .is_none()
                .then(|| OverlayPlacement {
                    x,
                    y,
                    monitor_name: area.name.clone(),
                })
            })
        })
        .min_by(|left, right| {
            position_distance_squared(origin, (left.x, left.y))
                .total_cmp(&position_distance_squared(origin, (right.x, right.y)))
        })
}

#[allow(clippy::too_many_arguments)]
fn select_main_nav_exit_candidate(
    x: f64,
    y: f64,
    w: f64,
    h: f64,
    main_x: f64,
    main_y: f64,
    main_w: f64,
    main_h: f64,
    main_scale_factor: f64,
    areas: &[MonitorWorkArea],
    preferred_monitor_name: Option<&str>,
) -> Option<OverlayPlacement> {
    let raw_candidates = main_nav_exit_candidates(
        x,
        y,
        w,
        h,
        main_x,
        main_y,
        main_w,
        main_h,
        main_scale_factor,
    )?;
    let preferred_areas: Vec<_> = preferred_monitor_name
        .map(|preferred| {
            areas
                .iter()
                .filter(|area| area.name.as_deref() == Some(preferred))
                .collect()
        })
        .unwrap_or_default();

    if let Some(selected) = select_candidate_in_areas(
        &raw_candidates,
        (x, y),
        w,
        h,
        main_x,
        main_y,
        main_w,
        main_h,
        main_scale_factor,
        &preferred_areas,
    ) {
        return Some(selected);
    }

    let fallback_areas: Vec<_> = areas
        .iter()
        .filter(|area| {
            preferred_monitor_name.is_none() || area.name.as_deref() != preferred_monitor_name
        })
        .collect();
    select_candidate_in_areas(
        &raw_candidates,
        (x, y),
        w,
        h,
        main_x,
        main_y,
        main_w,
        main_h,
        main_scale_factor,
        &fallback_areas,
    )
}

fn exclude_main_nav_overlap(
    x: f64,
    y: f64,
    w: f64,
    h: f64,
    main_x: f64,
    main_y: f64,
    main_w: f64,
    main_h: f64,
    main_scale_factor: f64,
) -> (f64, f64) {
    main_nav_exit_candidates(
        x,
        y,
        w,
        h,
        main_x,
        main_y,
        main_w,
        main_h,
        main_scale_factor,
    )
    .and_then(|candidates| {
        candidates.into_iter().min_by(|left, right| {
            position_distance_squared((x, y), *left)
                .total_cmp(&position_distance_squared((x, y), *right))
        })
    })
    .unwrap_or((x, y))
}

fn constrain_overlay_position(
    app: &AppHandle,
    x: f64,
    y: f64,
    preferred_monitor_name: Option<&str>,
) -> (f64, f64) {
    let (clamped_x, clamped_y) = clamp_to_monitors(
        app,
        x,
        y,
        OVERLAY_SIZE as f64,
        OVERLAY_SIZE as f64,
        preferred_monitor_name,
    );
    let Some(main) = app.get_webview_window("main") else {
        return (clamped_x, clamped_y);
    };
    let main_visible = main.is_visible().unwrap_or(false);
    let main_minimized = main.is_minimized().unwrap_or(false);
    if !main_nav_exclusion_active(main_visible, main_minimized) {
        return (clamped_x, clamped_y);
    }
    let Ok(main_position) = main.outer_position() else {
        return (clamped_x, clamped_y);
    };
    let Ok(main_size) = main.outer_size() else {
        return (clamped_x, clamped_y);
    };
    let scale_factor = main.scale_factor().unwrap_or(1.0);
    let Some(selected) = select_main_nav_exit_candidate(
        clamped_x,
        clamped_y,
        OVERLAY_SIZE as f64,
        OVERLAY_SIZE as f64,
        main_position.x as f64,
        main_position.y as f64,
        main_size.width as f64,
        main_size.height as f64,
        scale_factor,
        &monitor_work_areas(app),
        preferred_monitor_name,
    ) else {
        return (clamped_x, clamped_y);
    };
    (selected.x, selected.y)
}

/// When saved monitor is gone, fall back to primary top-right-ish.
fn recover_position(
    app: &AppHandle,
    saved_x: Option<f64>,
    saved_y: Option<f64>,
    w: f64,
    h: f64,
    preferred_monitor_name: Option<&str>,
) -> (f64, f64) {
    if let (Some(x), Some(y)) = (saved_x, saved_y) {
        return clamp_to_monitors(app, x, y, w, h, preferred_monitor_name);
    }
    if let Ok(Some(primary)) = app.primary_monitor() {
        let pos = primary.position();
        let size = primary.size();
        let x = pos.x as f64 + size.width as f64 - w - 24.0;
        let y = pos.y as f64 + size.height as f64 - h - 80.0;
        return clamp_to_monitors(app, x, y, w, h, preferred_monitor_name);
    }
    (24.0, 120.0)
}

fn is_pet_label(label: &str) -> bool {
    label == PET_OVERLAY_LABEL || label == PET_MINI_PANEL_LABEL
}

fn pet_native_title_for_label(label: &str) -> Option<&'static str> {
    match label {
        PET_OVERLAY_LABEL => Some("VibeSpace Pet"),
        PET_MINI_PANEL_LABEL => Some("VibeSpace Pet Panel"),
        _ => None,
    }
}

fn is_pet_native_title(title: &str) -> bool {
    title == "VibeSpace Pet" || title == "VibeSpace Pet Panel"
}

fn strip_pet_native_frame_style(style: isize) -> isize {
    (style & !PET_NATIVE_FRAME_STYLE_BITS) | 0x8000_0000 // WS_POPUP: no native caption surface.
}

fn strip_pet_native_frame_ex_style(ex_style: isize) -> isize {
    ex_style & !PET_NATIVE_FRAME_EX_STYLE_BITS
}

#[cfg(target_os = "windows")]
fn install_pet_client_only_frame(hwnd: windows::Win32::Foundation::HWND) {
    use windows::Win32::{
        Foundation::{HWND, LPARAM, LRESULT, WPARAM},
        UI::{Shell::{DefSubclassProc, RemoveWindowSubclass, SetWindowSubclass},
            WindowsAndMessaging::{WM_NCACTIVATE, WM_NCCALCSIZE, WM_NCDESTROY, WM_NCPAINT}},
    };
    unsafe extern "system" fn frame_proc(hwnd: HWND, message: u32, wparam: WPARAM, lparam: LPARAM, id: usize, _: usize) -> LRESULT {
        match message {
            WM_NCCALCSIZE | WM_NCPAINT => LRESULT(0),
            WM_NCACTIVATE => LRESULT(1),
            _ => {
                if message == WM_NCDESTROY {
                    let _ = unsafe { RemoveWindowSubclass(hwnd, Some(frame_proc), id) };
                }
                unsafe { DefSubclassProc(hwnd, message, wparam, lparam) }
            }
        }
    }
    // Install on the owning event-loop thread. Leave WM_NCHITTEST to Tao so
    // frameless resize edges keep working; only suppress native frame pixels.
    let _ = unsafe { SetWindowSubclass(hwnd, Some(frame_proc), 0x5653_5045, 0) };
}

#[cfg(target_os = "windows")]
fn native_restore_pet_window_chrome(hwnd: windows::Win32::Foundation::HWND) {
    use windows::core::w;
    use windows::Win32::UI::WindowsAndMessaging::{
        GetPropW, GetWindowLongPtrW, SetWindowLongPtrW, SetWindowPos, GWL_EXSTYLE, GWL_STYLE, WS_THICKFRAME,
        IsIconic, ShowWindow, SW_RESTORE,
        SET_WINDOW_POS_FLAGS, SWP_FRAMECHANGED, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SWP_NOCOPYBITS,
    };

    unsafe {
        // Showing an iconic tool window with SetWindowPos alone leaves its
        // WebView at the minimized caption size instead of restoring the UI.
        if IsIconic(hwnd).as_bool() {
            let _ = ShowWindow(hwnd, SW_RESTORE);
        }
        let style = GetWindowLongPtrW(hwnd, GWL_STYLE);
        // Keep Windows' sizing behavior on the panel. The client-only subclass
        // removes its painted frame without disabling native edge resizing.
        let panel = GetPropW(hwnd, w!("VibeSpace.PetPanel")).0 == hwnd.0;
        let repaired_style = strip_pet_native_frame_style(style)
            | if panel { WS_THICKFRAME.0 as isize } else { 0 };
        let ex_style = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
        let repaired_ex_style = strip_pet_native_frame_ex_style(ex_style);
        if repaired_style == style && repaired_ex_style == ex_style {
            return;
        }
        if repaired_style != style {
            let _ = SetWindowLongPtrW(hwnd, GWL_STYLE, repaired_style);
        }
        if repaired_ex_style != ex_style {
            let _ = SetWindowLongPtrW(hwnd, GWL_EXSTYLE, repaired_ex_style);
        }
        let flags = SET_WINDOW_POS_FLAGS(
            SWP_FRAMECHANGED.0 | SWP_NOMOVE.0 | SWP_NOSIZE.0 | SWP_NOACTIVATE.0 | SWP_NOCOPYBITS.0,
        );
        let _ = SetWindowPos(hwnd, None, 0, 0, 0, 0, flags);
    }
}

/// Ensure the pet-overlay WebView paints a fully transparent chrome (Windows).
///
/// On Windows 8+, WebView2 treats any non-zero alpha as opaque 255 for the
/// webview layer — only alpha `0` yields a transparent clear. Pair this with
/// `transparent: true` + `--default-background-color=00000000` in conf.
fn ensure_pet_overlay_transparent(win: &tauri::WebviewWindow) {
    let _ = win.set_shadow(false);
    let _ = win.set_decorations(false);
    // Fully transparent clear (R,G,B,A) — A must be 0 on Windows WebView2.
    let _ = win.set_background_color(Some(tauri::window::Color(0, 0, 0, 0)));
    // Keep the pet clickable/draggable (do not ignore cursor events).
    let _ = win.set_ignore_cursor_events(false);
}

#[cfg(target_os = "windows")]
fn native_pin_hwnd_topmost_noactivate(win: &WebviewWindow) {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::{
        GetWindowLongPtrW, SetWindowLongPtrW, SetWindowPos, GWL_EXSTYLE, HWND_TOPMOST,
        WS_EX_TOPMOST,
    };

    let Ok(raw) = win.hwnd() else {
        return;
    };
    let hwnd = HWND(raw.0 as *mut _);
    unsafe {
        let ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
        let topmost_bit = WS_EX_TOPMOST.0 as isize;
        if ex & topmost_bit == 0 {
            let _ = SetWindowLongPtrW(hwnd, GWL_EXSTYLE, ex | topmost_bit);
        }
        let _ = SetWindowPos(hwnd, Some(HWND_TOPMOST), 0, 0, 0, 0, PET_TOPMOST_POS_FLAGS);
    }
}

// Keep the overlay caption empty; identify it with a process-owned HWND property
// instead of displaying an internal window title above the character.
#[cfg(target_os = "windows")]
fn set_pet_native_caption(hwnd: windows::Win32::Foundation::HWND, overlay: bool, title: &str) -> bool {
    use windows::core::{w, PCWSTR};
    use windows::Win32::{Foundation::HANDLE, UI::WindowsAndMessaging::{SetPropW, SetWindowTextW}};
    let property = if overlay { w!("VibeSpace.PetOverlay") } else { w!("VibeSpace.PetPanel") };
    if unsafe { SetPropW(hwnd, property, Some(HANDLE(hwnd.0))) }.is_err() {
        return false;
    }
    let caption: Vec<u16> = (if overlay { "" } else { title }).encode_utf16().chain(Some(0)).collect();
    unsafe { SetWindowTextW(hwnd, PCWSTR(caption.as_ptr())) }.is_ok()
}

#[cfg(target_os = "windows")]
fn native_show_pet_window(win: &WebviewWindow, title: &str, focus: bool) -> bool {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::{
        IsWindowVisible, SetForegroundWindow, ShowWindow, SW_SHOW,
        SW_SHOWNOACTIVATE,
    };
    let Ok(raw) = win.hwnd() else { return false };
    let hwnd = HWND(raw.0 as *mut _);
    unsafe {
        if !set_pet_native_caption(hwnd, win.label() == PET_OVERLAY_LABEL, title) {
            return false;
        }
        let _ = ShowWindow(hwnd, if focus { SW_SHOW } else { SW_SHOWNOACTIVATE });
        if focus {
            let _ = SetForegroundWindow(hwnd);
        }
        IsWindowVisible(hwnd).as_bool()
    }
}

#[cfg(target_os = "windows")]
#[allow(clippy::too_many_arguments)]
fn configure_pet_surface_on_main_thread(
    app: &AppHandle,
    win: &WebviewWindow,
    title: &'static str,
    x: i32,
    y: i32,
    width: i32,
    height: i32,
    focus: bool,
) -> bool {
    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
    let app_for_main = app.clone();
    let label = win.label().to_owned();
    let win = win.clone();
    if app
        .run_on_main_thread(move || {
            #[cfg(debug_assertions)]
            eprintln!("[pets] configure {} starting", win.label());
            let ready = native_configure_pet_window(&win, title, x, y, width, height, focus)
                .map(|raw| {
                    if let Some(slot) =
                        pet_native_hwnd_slot(&app_for_main.state::<PetWindowState>(), &label)
                    {
                        slot.store(raw, Ordering::SeqCst);
                    }
                    true
                })
                .unwrap_or(false);
            #[cfg(debug_assertions)]
            eprintln!("[pets] configure {} complete: {ready}", win.label());
            let _ = sender.send(ready);
        })
        .is_err()
    {
        return false;
    }
    receiver
        .recv_timeout(std::time::Duration::from_millis(
            PET_MAIN_THREAD_CONFIG_TIMEOUT_MS,
        ))
        .unwrap_or(false)
}

fn configure_pet_surface_until_ready<F>(
    _created: bool,
    retry_attempts: usize,
    retry_delay: std::time::Duration,
    mut configure: F,
) -> bool
where
    F: FnMut() -> bool,
{
    let attempts = retry_attempts.max(1);
    for attempt in 0..attempts {
        if configure() {
            return true;
        }
        if attempt + 1 < attempts && !retry_delay.is_zero() {
            std::thread::sleep(retry_delay);
        }
    }
    false
}

#[cfg(target_os = "windows")]
fn native_configure_pet_window(
    win: &WebviewWindow,
    title: &str,
    x: i32,
    y: i32,
    width: i32,
    height: i32,
    focus: bool,
) -> Option<isize> {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::{
        IsWindowVisible, SetForegroundWindow, SetWindowPos, HWND_TOPMOST,
        SWP_NOACTIVATE, SWP_SHOWWINDOW,
    };
    let Ok(raw) = win.hwnd() else { return None };
    let hwnd = HWND(raw.0 as *mut _);
    let flags = if focus {
        SWP_SHOWWINDOW
    } else {
        SWP_SHOWWINDOW | SWP_NOACTIVATE
    };
    unsafe {
        install_pet_client_only_frame(hwnd);
        if !set_pet_native_caption(hwnd, win.label() == PET_OVERLAY_LABEL, title) {
            return None;
        }
        native_restore_pet_window_chrome(hwnd);
        let positioned = SetWindowPos(hwnd, Some(HWND_TOPMOST), x, y, width, height, flags);
        if focus {
            let _ = SetForegroundWindow(hwnd);
        }
        if positioned.is_ok() && IsWindowVisible(hwnd).as_bool() {
            Some(raw.0 as isize)
        } else {
            None
        }
    }
}

#[cfg(not(target_os = "windows"))]
fn native_show_pet_window(win: &WebviewWindow, _title: &str, _focus: bool) -> bool {
    win.is_visible().unwrap_or(false)
}

#[cfg(target_os = "windows")]
fn native_pet_hwnds(label: &str) -> Vec<windows::Win32::Foundation::HWND> {
    use windows::core::{w, BOOL, PCWSTR};
    use windows::Win32::Foundation::{HWND, LPARAM};
    use windows::Win32::UI::WindowsAndMessaging::{EnumWindows, GetPropW, GetWindowThreadProcessId};

    struct Lookup { property: PCWSTR, windows: Vec<HWND> }
    unsafe extern "system" fn visit(hwnd: HWND, data: LPARAM) -> BOOL {
        let lookup = unsafe { &mut *(data.0 as *mut Lookup) };
        let mut process_id = 0;
        unsafe {
            GetWindowThreadProcessId(hwnd, Some(&mut process_id));
        }
        if process_id == std::process::id()
            && unsafe { GetPropW(hwnd, lookup.property) }.0 == hwnd.0 {
            lookup.windows.push(hwnd);
        }
        true.into()
    }
    let property = match label {
        PET_OVERLAY_LABEL => w!("VibeSpace.PetOverlay"),
        PET_MINI_PANEL_LABEL => w!("VibeSpace.PetPanel"),
        _ => return Vec::new(),
    };
    let mut lookup = Lookup { property, windows: Vec::new() };
    // Never ask window procedures for captions from a focus callback. Native
    // properties identify our surfaces without a synchronous window message.
    let _ = unsafe { EnumWindows(Some(visit), LPARAM((&mut lookup as *mut Lookup) as isize)) };
    lookup.windows
}

#[cfg(target_os = "windows")]
fn native_pet_window_visible(win: &WebviewWindow) -> bool {
    use windows::Win32::UI::WindowsAndMessaging::{IsIconic, IsWindowVisible};
    native_pet_hwnds(win.label())
        .into_iter()
        .any(|hwnd| unsafe { IsWindowVisible(hwnd).as_bool() && !IsIconic(hwnd).as_bool() })
}

#[cfg(target_os = "windows")]
fn hide_pet_windows_by_label(label: &str) -> Result<(), &'static str> {
    use windows::Win32::UI::WindowsAndMessaging::{IsWindowVisible, ShowWindow, SW_HIDE};

    // This helper can run while the WebView is awaiting its invoke response.
    // WebviewWindow::hwnd is itself a synchronous Wry window_getter, so resolve
    // only this process's exact Pet titles and operate on their HWNDs directly.
    let hwnds = native_pet_hwnds(label);
    for hwnd in hwnds.iter().copied() {
        unsafe {
            let _ = ShowWindow(hwnd, SW_HIDE);
        }
    }
    if hwnds
        .iter()
        .copied()
        .any(|hwnd| unsafe { IsWindowVisible(hwnd).as_bool() })
    {
        Err("hide_failed")
    } else {
        Ok(())
    }
}

#[cfg(target_os = "windows")]
fn hide_pet_window_by_state(app: &AppHandle, label: &str) -> Result<(), &'static str> {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::{
        GetWindowThreadProcessId, IsWindow, IsWindowVisible, ShowWindow, SW_HIDE,
    };

    let state = app.state::<PetWindowState>();
    let Some(slot) = pet_native_hwnd_slot(&state, label) else {
        return Ok(());
    };
    let raw = slot.load(Ordering::SeqCst);
    if raw == 0 {
        return hide_pet_windows_by_label(label);
    }
    let hwnd = HWND(raw as *mut _);
    let mut process_id = 0;
    unsafe {
        GetWindowThreadProcessId(hwnd, Some(&mut process_id));
    }
    if !unsafe { IsWindow(Some(hwnd)).as_bool() } || process_id != std::process::id() {
        slot.store(0, Ordering::SeqCst);
        return hide_pet_windows_by_label(label);
    }
    unsafe {
        let _ = ShowWindow(hwnd, SW_HIDE);
    }
    if unsafe { IsWindowVisible(hwnd).as_bool() } {
        Err("hide_failed")
    } else {
        Ok(())
    }
}

#[cfg(target_os = "windows")]
fn hide_pet_window(win: &WebviewWindow) -> Result<(), &'static str> {
    hide_pet_windows_by_label(win.label())
}

#[cfg(not(target_os = "windows"))]
fn hide_pet_window(win: &WebviewWindow) -> Result<(), &'static str> {
    win.hide().map_err(|_| "hide_failed")?;
    if native_pet_window_visible(win) {
        Err("hide_failed")
    } else {
        Ok(())
    }
}

#[cfg(not(target_os = "windows"))]
fn native_pet_window_visible(win: &WebviewWindow) -> bool {
    win.is_visible().unwrap_or(false) && !win.is_minimized().unwrap_or(false)
}

#[cfg(not(target_os = "windows"))]
fn native_pin_hwnd_topmost_noactivate(_win: &WebviewWindow) {}

fn pin_pet_window_topmost(win: &WebviewWindow, restore_overlay_chrome: bool) {
    let _ = win.set_always_on_top(true);
    if restore_overlay_chrome {
        ensure_pet_overlay_transparent(win);
    }
    native_pin_hwnd_topmost_noactivate(win);
}

#[cfg(not(target_os = "windows"))]
fn pet_window_should_stay_topmost(win: &WebviewWindow) -> bool {
    should_pin_pet_window(
        win.is_visible().unwrap_or(false),
        win.is_minimized().unwrap_or(false),
    )
}

#[cfg(target_os = "windows")]
fn native_pin_visible_pet_hwnds() {
    static PINNING: AtomicBool = AtomicBool::new(false);
    if PINNING.compare_exchange(false, true, Ordering::Acquire, Ordering::Relaxed).is_err() {
        return;
    }
    struct PinGuard;
    impl Drop for PinGuard {
        fn drop(&mut self) { PINNING.store(false, Ordering::Release); }
    }
    // Focus notifications can re-enter while the watchdog changes native
    // window position. Coalesce them instead of recursively repairing frames.
    let _pin_guard = PinGuard;
    use windows::Win32::UI::WindowsAndMessaging::{
        GetWindowLongPtrW, IsIconic, IsWindowVisible, SetWindowLongPtrW, SetWindowPos, GWL_EXSTYLE,
        HWND_TOPMOST, WS_EX_TOPMOST,
    };

    let hwnds = native_pet_hwnds(PET_OVERLAY_LABEL)
        .into_iter()
        .chain(native_pet_hwnds(PET_MINI_PANEL_LABEL));
    for hwnd in hwnds {
        if !unsafe { IsWindowVisible(hwnd).as_bool() } || unsafe { IsIconic(hwnd).as_bool() } {
            continue;
        }

        let ex_style = unsafe { GetWindowLongPtrW(hwnd, GWL_EXSTYLE) };
        let topmost_bit = WS_EX_TOPMOST.0 as isize;
        if ex_style & topmost_bit == 0 {
            unsafe {
                let _ = SetWindowLongPtrW(hwnd, GWL_EXSTYLE, ex_style | topmost_bit);
            }
        }
        native_restore_pet_window_chrome(hwnd);
        unsafe {
            let _ = SetWindowPos(hwnd, Some(HWND_TOPMOST), 0, 0, 0, 0, PET_TOPMOST_POS_FLAGS);
        }
    }
}

#[cfg(not(target_os = "windows"))]
fn native_pin_visible_pet_hwnds() {}

pub(crate) fn pin_visible_pet_windows(app: &AppHandle) {
    #[cfg(target_os = "windows")]
    {
        let _ = app;
        native_pin_visible_pet_hwnds();
        return;
    }

    #[cfg(not(target_os = "windows"))]
    {
        if let Some(win) = app.get_webview_window(PET_OVERLAY_LABEL) {
            if pet_window_should_stay_topmost(&win) {
                pin_pet_window_topmost(&win, true);
            }
        }
        if let Some(win) = app.get_webview_window(PET_MINI_PANEL_LABEL) {
            if pet_window_should_stay_topmost(&win) {
                pin_pet_window_topmost(&win, false);
            }
        }
    }
}

pub(crate) fn ensure_pet_topmost_watchdog(app: &AppHandle) {
    let started = &app.state::<PetWindowState>().topmost_watchdog_started;
    if started.swap(true, Ordering::SeqCst) {
        return;
    }
    #[cfg(not(target_os = "windows"))]
    let watchdog_app = app.clone();
    let _ = std::thread::Builder::new()
        .name("pet-topmost-watchdog".into())
        .spawn(move || loop {
            std::thread::sleep(std::time::Duration::from_millis(
                TOPMOST_WATCHDOG_INTERVAL_MS,
            ));
            #[cfg(target_os = "windows")]
            native_pin_visible_pet_hwnds();
            #[cfg(not(target_os = "windows"))]
            pin_visible_pet_windows(&watchdog_app);
        });
}

fn pet_webview_url(_app: &AppHandle, view: &str) -> Result<WebviewUrl, String> {
    // Keep this as an application URL and let Tauri select the active asset
    // origin. A debug binary can still be built with `tauri/custom-protocol`;
    // forcing the configured dev URL here would strand detached Pet windows on
    // an absent Vite server while the main window correctly uses embedded
    // assets.
    Ok(WebviewUrl::App(format!("index.html?view={view}").into()))
}

#[cfg(debug_assertions)]
fn log_pet_window_metrics(label: &str, win: &WebviewWindow) {
    let visible = win.is_visible().unwrap_or(false);
    let title = win.title().unwrap_or_else(|_| "<unknown>".to_string());
    let pos = win
        .outer_position()
        .map(|p| format!("{},{}", p.x, p.y))
        .unwrap_or_else(|e| format!("err:{e}"));
    let size = win
        .outer_size()
        .map(|s| format!("{}x{}", s.width, s.height))
        .unwrap_or_else(|e| format!("err:{e}"));
    eprintln!("[pets] {label}: title={title:?} visible={visible} pos={pos} size={size}");
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PetRegistrationAction {
    Reuse,
    Retire,
    Create,
}

fn classify_pet_registration(
    webview_registered: bool,
    native_host_exists: bool,
    window_registered: bool,
) -> PetRegistrationAction {
    if webview_registered && native_host_exists {
        PetRegistrationAction::Reuse
    } else if webview_registered || window_registered {
        // Tauri can retain a manager registration after WebView2 creation
        // fails. Reusing that poisoned dispatcher can never materialize an
        // HWND, so retire it before the bounded main-thread rebuild.
        PetRegistrationAction::Retire
    } else {
        PetRegistrationAction::Create
    }
}

#[cfg(target_os = "windows")]
fn native_pet_window_exists(win: &WebviewWindow) -> bool {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::IsWindow;
    let Ok(raw) = win.hwnd() else { return false };
    unsafe { IsWindow(Some(HWND(raw.0 as *mut _))).as_bool() }
}

#[cfg(not(target_os = "windows"))]
fn native_pet_window_exists(win: &WebviewWindow) -> bool {
    win.is_visible().is_ok()
}

fn pet_acquire_failure_reason(label: &str, error: &str) -> &'static str {
    if error.contains(label) && error.contains("retir") {
        "stale_window_retire_failed"
    } else if error.contains("already exists") || error.contains("label") {
        "window_label_conflict"
    } else {
        "window_create_failed"
    }
}

fn overlay_acquire_failure_reason(error: &str) -> &'static str {
    pet_acquire_failure_reason(PET_OVERLAY_LABEL, error)
}

enum PetOverlayAcquire {
    Ready { created: bool },
    StaleRetired,
}

fn wait_for_pet_label_release(app: &AppHandle, label: &str) -> bool {
    let deadline = std::time::Instant::now() + std::time::Duration::from_millis(750);
    loop {
        if app.get_webview_window(label).is_none() && app.get_window(label).is_none() {
            return true;
        }
        if std::time::Instant::now() >= deadline {
            return false;
        }
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
}

fn retire_pet_registration(app: &AppHandle, label: &str) -> Result<(), String> {
    if let Some(webview_window) = app.get_webview_window(label) {
        webview_window
            .destroy()
            .map_err(|error| format!("failed to retire stale {label} window: {error}"))?;
    } else if let Some(window) = app.get_window(label) {
        window
            .destroy()
            .map_err(|error| format!("failed to retire partial {label} window: {error}"))?;
    }

    if let Some(slot) = pet_native_hwnd_slot(&app.state::<PetWindowState>(), label) {
        slot.store(0, Ordering::SeqCst);
    }

    if wait_for_pet_label_release(app, label) {
        Ok(())
    } else {
        Err(format!("timed out retiring stale {label} registration"))
    }
}

fn acquire_pet_overlay(app: &AppHandle) -> Result<PetOverlayAcquire, String> {
    let webview_window = app.get_webview_window(PET_OVERLAY_LABEL);
    let native_host_exists = webview_window
        .as_ref()
        .map(native_pet_window_exists)
        .unwrap_or(false);
    match classify_pet_registration(
        webview_window.is_some(),
        native_host_exists,
        app.get_window(PET_OVERLAY_LABEL).is_some(),
    ) {
        PetRegistrationAction::Reuse => return Ok(PetOverlayAcquire::Ready { created: false }),
        PetRegistrationAction::Retire => {
            retire_pet_registration(app, PET_OVERLAY_LABEL)?;
            return Ok(PetOverlayAcquire::StaleRetired);
        }
        PetRegistrationAction::Create => {}
    }

    #[cfg(debug_assertions)]
    eprintln!("[pets] creating pet-overlay window");

    schedule_pet_overlay_build(app)?;
    Ok(PetOverlayAcquire::Ready { created: true })
}

fn visibility_generation<'a>(state: &'a PetWindowState, label: &str) -> &'a AtomicU64 {
    if label == PET_OVERLAY_LABEL {
        &state.overlay_visibility_generation
    } else {
        &state.panel_visibility_generation
    }
}

fn record_pet_visibility_intent(app: &AppHandle, label: &str) -> u64 {
    visibility_generation(&app.state::<PetWindowState>(), label)
        .fetch_add(1, Ordering::SeqCst)
        .wrapping_add(1)
}

fn pet_visibility_intent_is_current(
    state: &PetWindowState,
    label: &str,
    intent_generation: u64,
) -> bool {
    visibility_generation(state, label).load(Ordering::SeqCst) == intent_generation
}

fn schedule_setup_pet_hide(
    app: AppHandle,
    window: WebviewWindow,
    label: &'static str,
    setup_generation: u64,
) -> Result<(), String> {
    std::thread::Builder::new()
        .name(format!("{label}-setup-hide"))
        .spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(
                PET_SETUP_MATERIALIZATION_DELAY_MS,
            ));
            let state = app.state::<PetWindowState>();
            let lifecycle = if label == PET_OVERLAY_LABEL {
                state.overlay_lifecycle.lock()
            } else {
                state.panel_lifecycle.lock()
            };
            let Ok(_lifecycle) = lifecycle else {
                return;
            };
            if visibility_generation(&state, label).load(Ordering::SeqCst) != setup_generation {
                return;
            }
            let still_offscreen = window
                .outer_position()
                .map(|position| position.x <= -31_000 && position.y <= -31_000)
                .unwrap_or(false);
            if still_offscreen {
                if let Err(error) = hide_pet_window(&window) {
                    #[cfg(debug_assertions)]
                    eprintln!("[pets] setup {label} hide failed: {error}");
                }
            }
        })
        .map(|_| ())
        .map_err(|error| format!("failed to schedule setup {label} hide: {error}"))
}

pub fn materialize_detached_pet_hosts(_app: &tauri::App) {
    // Fail-safe startup: detached Pet WebViews are created only by their
    // explicit show/open commands. Eager creation can retain the native event
    // loop before the main renderer's first IPC handshake, even when Pet is
    // disabled. Keeping startup lazy makes the main app authoritative while
    // preserving the existing on-demand Pet creation paths.
}

fn schedule_pet_overlay_build(app: &AppHandle) -> Result<(), String> {
    let app_for_schedule = app.clone();
    std::thread::Builder::new()
        .name("pet-overlay-create".into())
        .spawn(move || {
            // Let the originating invoke finish before WebView2/controller
            // construction runs on the event loop. Scheduling directly from
            // the still-awaited worker can register the label while the IPC
            // dispatch is active, leaving Windows without a materialized HWND.
            std::thread::sleep(std::time::Duration::from_millis(
                PET_DETACHED_BUILD_DELAY_MS,
            ));
            let app_for_build = app_for_schedule.clone();
            if let Err(error) = app_for_schedule.run_on_main_thread(move || {
                if app_for_build
                    .get_webview_window(PET_OVERLAY_LABEL)
                    .is_some()
                    || app_for_build.get_window(PET_OVERLAY_LABEL).is_some()
                {
                    return;
                }
                if let Err(error) = build_pet_overlay(&app_for_build, &app_for_build, true, None) {
                    #[cfg(debug_assertions)]
                    eprintln!("[pets] pet-overlay main-thread build failed: {error}");
                }
            }) {
                #[cfg(debug_assertions)]
                eprintln!("[pets] failed to dispatch pet-overlay build: {error}");
            }
        })
        .map(|_| ())
        .map_err(|error| format!("failed to schedule pet-overlay window: {error}"))
}

fn configured_main_webview_browser_args(app: &AppHandle) -> Result<String, String> {
    app.config()
        .app
        .windows
        .iter()
        .find(|window| window.label == "main")
        .and_then(|window| window.additional_browser_args.as_deref())
        .map(str::trim)
        .filter(|args| !args.is_empty())
        .map(str::to_owned)
        .ok_or_else(|| "main WebView2 browser arguments are unavailable".to_owned())
}

fn build_pet_overlay<M: Manager<tauri::Wry>>(
    manager: &M,
    app: &AppHandle,
    visible: bool,
    initial_position: Option<(f64, f64)>,
) -> Result<WebviewWindow, String> {
    let browser_args = configured_main_webview_browser_args(app)?;
    let builder = WebviewWindowBuilder::new(
        manager,
        PET_OVERLAY_LABEL,
        pet_webview_url(app, "pet-overlay")?,
    )
    .title("")
    .inner_size(OVERLAY_SIZE as f64, OVERLAY_SIZE as f64)
    .min_inner_size(OVERLAY_SIZE as f64, OVERLAY_SIZE as f64)
    .max_inner_size(OVERLAY_SIZE as f64, OVERLAY_SIZE as f64)
    .resizable(false)
    .decorations(false)
    .transparent(true)
    .always_on_top(true)
    .skip_taskbar(true)
    // A hidden WebViewWindow can be registered before WebView2 creates its
    // native host. Materialize the detached host during the main-thread
    // build; the bounded configure path immediately applies final geometry
    // and visibility, and later hide/show calls reuse the same surface.
    .visible(visible)
    .focused(false)
    .shadow(false)
    .additional_browser_args(&browser_args)
    .background_color(tauri::window::Color(0, 0, 0, 0));
    let builder = match initial_position {
        Some((x, y)) => builder.position(x, y),
        None => builder,
    };
    builder
        .build()
        .map_err(|e| format!("failed to create pet-overlay window: {e}"))
}

fn get_or_create_pet_panel(app: &AppHandle) -> Result<(Option<WebviewWindow>, bool), String> {
    let webview_window = app.get_webview_window(PET_MINI_PANEL_LABEL);
    let native_host_exists = webview_window
        .as_ref()
        .map(native_pet_window_exists)
        .unwrap_or(false);
    match classify_pet_registration(
        webview_window.is_some(),
        native_host_exists,
        app.get_window(PET_MINI_PANEL_LABEL).is_some(),
    ) {
        PetRegistrationAction::Reuse => {
            return Ok((
                Some(webview_window.expect("reusable pet panel registration exists")),
                false,
            ))
        }
        PetRegistrationAction::Retire => {
            retire_pet_registration(app, PET_MINI_PANEL_LABEL)?;
        }
        PetRegistrationAction::Create => {}
    }

    #[cfg(debug_assertions)]
    eprintln!("[pets] creating pet-mini-panel window");

    schedule_pet_panel_build(app, true)?;
    Ok((None, true))
}

fn schedule_pet_panel_build(app: &AppHandle, visible: bool) -> Result<(), String> {
    let app_for_schedule = app.clone();
    std::thread::Builder::new()
        .name("pet-mini-panel-create".into())
        .spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(
                PET_DETACHED_BUILD_DELAY_MS,
            ));
            let app_for_build = app_for_schedule.clone();
            if let Err(error) = app_for_schedule.run_on_main_thread(move || {
                if app_for_build
                    .get_webview_window(PET_MINI_PANEL_LABEL)
                    .is_some()
                    || app_for_build.get_window(PET_MINI_PANEL_LABEL).is_some()
                {
                    return;
                }
                if let Err(error) = build_pet_panel(&app_for_build, &app_for_build, visible, None) {
                    #[cfg(debug_assertions)]
                    eprintln!("[pets] pet-mini-panel main-thread build failed: {error}");
                }
            }) {
                #[cfg(debug_assertions)]
                eprintln!("[pets] failed to dispatch pet-mini-panel build: {error}");
            }
        })
        .map(|_| ())
        .map_err(|error| format!("failed to schedule pet-mini-panel window: {error}"))
}

fn build_pet_panel<M: Manager<tauri::Wry>>(
    manager: &M,
    app: &AppHandle,
    visible: bool,
    initial_position: Option<(f64, f64)>,
) -> Result<WebviewWindow, String> {
    let browser_args = configured_main_webview_browser_args(app)?;
    let builder = WebviewWindowBuilder::new(
        manager,
        PET_MINI_PANEL_LABEL,
        pet_webview_url(app, "pet-mini-panel")?,
    )
    .title("VibeSpace Pet Panel")
    .shadow(false)
    .inner_size(PANEL_DEFAULT_W, PANEL_DEFAULT_H)
    .min_inner_size(PANEL_MIN_W, PANEL_MIN_H)
    .resizable(true)
    .decorations(false)
    .transparent(true)
    .background_color(tauri::window::Color(0, 0, 0, 0))
    .always_on_top(true)
    .skip_taskbar(true)
    .visible(visible)
    .additional_browser_args(&browser_args)
    .focused(false);
    let builder = match initial_position {
        Some((x, y)) => builder.position(x, y),
        None => builder,
    };
    builder
        .build()
        .map_err(|e| format!("failed to create pet-mini-panel window: {e}"))
}

fn should_preserve_pending_pet_overlay(reason: &str) -> bool {
    reason == "not_visible"
}

fn retire_failed_pet_overlay(app: &AppHandle, created: bool, reason: &str) {
    if should_preserve_pending_pet_overlay(reason) {
        return;
    }
    let Some(win) = app.get_webview_window(PET_OVERLAY_LABEL) else {
        return;
    };
    if created {
        let _ = win.destroy();
    } else {
        let _ = win.hide();
    }
}

/// Show the pet overlay (create visibility). Single instance by label.
#[tauri::command]
pub async fn pet_show_overlay(app: AppHandle) -> Result<PetOverlayShowResult, String> {
    #[cfg(debug_assertions)]
    eprintln!("[pets] pet_show_overlay invoked");

    let intent_generation = record_pet_visibility_intent(&app, PET_OVERLAY_LABEL);
    tauri::async_runtime::spawn_blocking(move || show_pet_overlay_blocking(app, intent_generation))
        .await
        .map_err(|_| "pet overlay worker failed".to_string())?
}

fn show_pet_overlay_blocking(
    app: AppHandle,
    intent_generation: u64,
) -> Result<PetOverlayShowResult, String> {
    let state = app.state::<PetWindowState>();
    let _lifecycle = match state.overlay_lifecycle.lock() {
        Ok(lifecycle) => lifecycle,
        Err(_) => {
            return Ok(PetOverlayShowResult::failed(
                "overlay_lifecycle_unavailable",
            ))
        }
    };
    if !pet_visibility_intent_is_current(&state, PET_OVERLAY_LABEL, intent_generation) {
        return Ok(PetOverlayShowResult::failed("superseded"));
    }
    show_pet_overlay_with_lifecycle_held(app.clone(), &state)
}

fn show_pet_overlay_with_lifecycle_held(
    app: AppHandle,
    state: &PetWindowState,
) -> Result<PetOverlayShowResult, String> {
    // Window/monitor queries dispatch to the UI thread, whose callbacks also
    // persist geometry. Never wait for that thread with geometry locked.
    let geo_snapshot = match state.geometry.lock() {
        Ok(geo) => geo.clone(),
        Err(_) => return Ok(PetOverlayShowResult::failed("geometry_unavailable")),
    };
    let (recovered_x, recovered_y) = recover_position(
        &app,
        geo_snapshot.overlay_x,
        geo_snapshot.overlay_y,
        OVERLAY_SIZE as f64,
        OVERLAY_SIZE as f64,
        geo_snapshot.overlay_monitor_name.as_deref(),
    );
    let (x, y) = constrain_overlay_position(
        &app,
        recovered_x,
        recovered_y,
        geo_snapshot.overlay_monitor_name.as_deref(),
    );
    let (x, y) = {
        let mut geo = match state.geometry.lock() {
            Ok(geo) => geo,
            Err(_) => return Ok(PetOverlayShowResult::failed("geometry_unavailable")),
        };
        geo.overlay_x = Some(x);
        geo.overlay_y = Some(y);
        save_geometry(&app, &geo);
        (x, y)
    };

    let created = match acquire_pet_overlay(&app) {
        Ok(PetOverlayAcquire::Ready { created }) => created,
        Ok(PetOverlayAcquire::StaleRetired) => {
            // `destroy` retires the stale registration before it returns.
            // Reacquire once; the renderer already owns
            // bounded retries if Windows has not released the label yet.
            match acquire_pet_overlay(&app) {
                Ok(PetOverlayAcquire::Ready { created }) => created,
                Ok(PetOverlayAcquire::StaleRetired) => {
                    return Ok(PetOverlayShowResult::failed("window_label_conflict"))
                }
                Err(error) => {
                    #[cfg(debug_assertions)]
                    eprintln!("[pets] pet-overlay creation retry failed: {error}");
                    return Ok(PetOverlayShowResult::failed(
                        overlay_acquire_failure_reason(&error),
                    ));
                }
            }
        }
        Err(error) => {
            #[cfg(debug_assertions)]
            eprintln!("[pets] pet-overlay creation failed: {error}");
            return Ok(PetOverlayShowResult::failed(
                overlay_acquire_failure_reason(&error),
            ));
        }
    };

    if created {
        // RuntimeHandle::create_window queues the native/WebView2 work on the
        // event loop and immediately returns a detached registration. Yield
        // this command before sending dispatcher setters or HWND getters; the
        // renderer's bounded retry configures the materialized host.
        return Ok(PetOverlayShowResult::failed_after_create(
            true,
            "not_visible",
        ));
    }

    match show_existing_pet_overlay(app.clone(), x, y, created) {
        Ok(result) => Ok(result),
        Err(reason) => {
            retire_failed_pet_overlay(&app, created, reason);
            Ok(PetOverlayShowResult::failed_after_create(created, reason))
        }
    }
}

fn schedule_pet_overlay_restore(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let _ = pet_show_overlay(app).await;
    });
}

fn show_existing_pet_overlay(
    app: AppHandle,
    x: f64,
    y: f64,
    created: bool,
) -> Result<PetOverlayShowResult, &'static str> {
    let win = app
        .get_webview_window(PET_OVERLAY_LABEL)
        .ok_or("window_missing")?;
    #[cfg(target_os = "windows")]
    {
        let overlay_size = PhysicalSize::new(OVERLAY_SIZE, OVERLAY_SIZE);
        // Tauri can register a hidden WebView window before WebView2 exposes a
        // usable HWND. Stage the final geometry through the dispatcher and ask
        // Tauri to show the host first; native verification below then observes
        // the real surface instead of destroying an in-flight registration.
        win.set_position(PhysicalPosition::new(x as i32, y as i32))
            .map_err(|_| "position_failed")?;
        win.set_min_size(Some(overlay_size))
            .map_err(|_| "size_failed")?;
        win.set_max_size(Some(overlay_size))
            .map_err(|_| "size_failed")?;
        win.set_size(overlay_size).map_err(|_| "size_failed")?;
        win.set_always_on_top(true).map_err(|_| "topmost_failed")?;
        ensure_pet_overlay_transparent(&win);
        win.show().map_err(|_| "show_failed")?;
        if !configure_pet_surface_until_ready(
            created,
            PET_CREATED_SURFACE_READY_ATTEMPTS,
            std::time::Duration::from_millis(PET_CREATED_SURFACE_READY_POLL_MS),
            || {
                configure_pet_surface_on_main_thread(
                    &app,
                    &win,
                    "VibeSpace Pet",
                    x as i32,
                    y as i32,
                    OVERLAY_SIZE as i32,
                    OVERLAY_SIZE as i32,
                    false,
                )
            },
        ) {
            return Err("not_visible");
        }
        ensure_pet_topmost_watchdog(&app);
        return Ok(PetOverlayShowResult::visible(created));
    }
    #[cfg(not(target_os = "windows"))]
    {
        let overlay_size = PhysicalSize::new(OVERLAY_SIZE, OVERLAY_SIZE);
        win.set_position(PhysicalPosition::new(x as i32, y as i32))
            .map_err(|_| "position_failed")?;
        win.set_min_size(Some(overlay_size))
            .map_err(|_| "size_failed")?;
        win.set_max_size(Some(overlay_size))
            .map_err(|_| "size_failed")?;
        win.set_size(overlay_size).map_err(|_| "size_failed")?;
        win.set_always_on_top(true).map_err(|_| "topmost_failed")?;
        pin_pet_window_topmost(&win, true);
        win.show().map_err(|_| "show_failed")?;
        if !native_show_pet_window(&win, "VibeSpace Pet", false) {
            return Err("not_visible");
        }
        // Windows/WebView2 can report a tiny transparent host HWND on first show.
        // Re-assert the exact pet surface size after visibility is applied.
        win.set_size(overlay_size).map_err(|_| "size_failed")?;
        // Second topmost pass — some hosts drop Z-order during the first show.
        pin_pet_window_topmost(&win, true);
        ensure_pet_topmost_watchdog(&app);
        // `show()` is the authoritative completion boundary here. Querying
        // `is_visible()` synchronously from the same Windows command callback can
        // deadlock WebView2 after the native HWND is already visible.
        Ok(PetOverlayShowResult::visible(created))
    }
}

#[cfg(not(target_os = "windows"))]
fn hide_pet_overlay_window(app: &AppHandle) -> Result<(), &'static str> {
    if let Some(win) = app.get_webview_window(PET_OVERLAY_LABEL) {
        hide_pet_window(&win)?;
    }
    Ok(())
}

/// Hide the pet overlay without destroying the webview (no duplicate on re-show).
#[tauri::command]
pub async fn pet_hide_overlay(app: AppHandle) -> Result<(), String> {
    let intent_generation = record_pet_visibility_intent(&app, PET_OVERLAY_LABEL);
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<PetWindowState>();
        let _lifecycle = state
            .overlay_lifecycle
            .lock()
            .map_err(|_| "overlay_lifecycle_unavailable".to_string())?;
        if !pet_visibility_intent_is_current(&state, PET_OVERLAY_LABEL, intent_generation) {
            return Ok(());
        }
        #[cfg(target_os = "windows")]
        hide_pet_window_by_state(&app, PET_OVERLAY_LABEL).map_err(str::to_string)?;
        #[cfg(not(target_os = "windows"))]
        hide_pet_overlay_window(&app).map_err(str::to_string)?;
        Ok(())
    })
    .await
    .map_err(|_| "pet overlay hide worker failed".to_string())?
}

/// Whether the pet overlay is currently visible.
#[tauri::command]
pub async fn pet_is_overlay_visible(app: AppHandle) -> Result<bool, String> {
    Ok(app
        .get_webview_window(PET_OVERLAY_LABEL)
        .map(|win| native_pet_window_visible(&win))
        .unwrap_or(false))
}

#[tauri::command]
pub fn pet_get_start_with_windows() -> Result<bool, String> {
    get_windows_startup_enabled()
}

#[tauri::command]
pub fn pet_set_start_with_windows(enabled: bool) -> Result<bool, String> {
    set_windows_startup_enabled(enabled)
}

fn previous_geometry_path(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .app_data_dir()
        .ok()
        .map(|d| d.join("pets").join("window-geometry.previous.json"))
}

fn geometry_is_valid(geo: &PetGeometryState) -> bool {
    [
        geo.overlay_x,
        geo.overlay_y,
        geo.panel_x,
        geo.panel_y,
        geo.panel_w,
        geo.panel_h,
    ]
    .into_iter()
    .flatten()
    .all(f64::is_finite)
        && geo
            .panel_w
            .map_or(true, |w| (PANEL_MIN_W..=4000.0).contains(&w))
        && geo
            .panel_h
            .map_or(true, |h| (PANEL_MIN_H..=4000.0).contains(&h))
}

fn read_geometry(path: &std::path::Path) -> Option<PetGeometryState> {
    let bytes = fs::read(path).ok()?;
    if bytes.len() > 64 * 1024 {
        return None;
    }
    let geometry = serde_json::from_slice::<PetGeometryState>(&bytes).ok()?;
    geometry_is_valid(&geometry).then_some(geometry)
}

/// Reassert topmost only for pet windows that are already visible.
/// Never shows, focuses, or activates a hidden Pet window.
#[tauri::command]
pub async fn pet_reassert_overlay_topmost(app: AppHandle) -> Result<(), String> {
    pin_visible_pet_windows(&app);
    ensure_pet_topmost_watchdog(&app);
    Ok(())
}

fn reconstrain_visible_overlay(app: &AppHandle) -> Result<(), String> {
    let Some(win) = app.get_webview_window(PET_OVERLAY_LABEL) else {
        return Ok(());
    };
    if !win.is_visible().unwrap_or(false) {
        return Ok(());
    }
    let position = win
        .outer_position()
        .map_err(|error| format!("failed to read pet-overlay position: {error}"))?;
    let monitor_name = win
        .current_monitor()
        .ok()
        .flatten()
        .and_then(|monitor| monitor.name().cloned());
    let (x, y) = constrain_overlay_position(
        app,
        position.x as f64,
        position.y as f64,
        monitor_name.as_deref(),
    );
    if position.x == x as i32 && position.y == y as i32 {
        return Ok(());
    }
    win.set_position(PhysicalPosition::new(x as i32, y as i32))
        .map_err(|error| format!("failed to reconstrain pet-overlay: {error}"))?;
    let observed_monitor_name = win
        .current_monitor()
        .ok()
        .flatten()
        .and_then(|monitor| monitor.name().cloned());
    let final_monitor_name =
        final_monitor_name_for_position(&monitor_work_areas(app), x, y, observed_monitor_name);
    if let Ok(mut geo) = app.state::<PetWindowState>().geometry.lock() {
        geo.overlay_x = Some(x);
        geo.overlay_y = Some(y);
        geo.overlay_monitor_name = final_monitor_name;
        save_geometry(app, &geo);
    }
    Ok(())
}

pub fn schedule_visible_overlay_reconstrain(app: AppHandle) {
    let generation = app
        .state::<PetWindowState>()
        .reconstrain_generation
        .fetch_add(1, Ordering::Relaxed)
        + 1;
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(80));
        if app
            .state::<PetWindowState>()
            .reconstrain_generation
            .load(Ordering::Relaxed)
            != generation
        {
            return;
        }
        let app_for_callback = app.clone();
        let _ = app.run_on_main_thread(move || {
            if app_for_callback
                .state::<PetWindowState>()
                .reconstrain_generation
                .load(Ordering::Relaxed)
                != generation
            {
                return;
            }
            if let Err(error) = reconstrain_visible_overlay(&app_for_callback) {
                eprintln!("[pets] failed to reconstrain visible overlay: {error}");
            }
        });
    });
}

/// Move pet overlay to physical position (DPI-aware path via physical coords).
/// Always clamped so the sprite cannot be dragged fully off-screen.
#[tauri::command]
pub async fn pet_set_overlay_position(app: AppHandle, x: f64, y: f64) -> Result<(), String> {
    let Some(win) = app.get_webview_window(PET_OVERLAY_LABEL) else {
        return Ok(());
    };
    // Keep at least ~24px of the pet window on-screen (cannot disappear off edge).
    let (cx, cy) = constrain_overlay_position(&app, x, y, None);
    let _ = win.set_position(PhysicalPosition::new(cx as i32, cy as i32));
    pin_pet_window_topmost(&win, false);
    let monitor_name = win
        .current_monitor()
        .ok()
        .flatten()
        .and_then(|monitor| monitor.name().cloned());
    if let Ok(mut geo) = app.state::<PetWindowState>().geometry.lock() {
        geo.overlay_x = Some(cx);
        geo.overlay_y = Some(cy);
        geo.overlay_monitor_name = monitor_name;
        save_geometry(&app, &geo);
    }
    Ok(())
}

fn nearest_edge_position(
    x: f64,
    y: f64,
    w: f64,
    h: f64,
    monitor_x: f64,
    monitor_y: f64,
    monitor_w: f64,
    monitor_h: f64,
    margin: f64,
) -> (f64, f64) {
    let left = monitor_x + margin;
    let right = (monitor_x + monitor_w - w - margin).max(left);
    let top = monitor_y + margin;
    let bottom = (monitor_y + monitor_h - h - margin).max(top);
    let candidates = [
        (left, y.clamp(top, bottom), (x - left).abs()),
        (right, y.clamp(top, bottom), (x - right).abs()),
        (x.clamp(left, right), top, (y - top).abs()),
        (x.clamp(left, right), bottom, (y - bottom).abs()),
    ];
    candidates
        .into_iter()
        .min_by(|a, b| a.2.total_cmp(&b.2))
        .map(|(cx, cy, _)| (cx, cy))
        .unwrap_or((left, top))
}

/// Snap the visible overlay to the nearest edge of its current monitor.
#[tauri::command]
pub async fn pet_snap_overlay_to_edge(app: AppHandle) -> Result<(), String> {
    let Some(win) = app.get_webview_window(PET_OVERLAY_LABEL) else {
        return Ok(());
    };
    let position = win
        .outer_position()
        .map_err(|e| format!("failed to read pet-overlay position: {e}"))?;
    let monitor = win
        .current_monitor()
        .ok()
        .flatten()
        .or_else(|| app.primary_monitor().ok().flatten());
    let Some(monitor) = monitor else {
        return Ok(());
    };
    let work_area = monitor.work_area();
    let monitor_position = work_area.position;
    let monitor_size = work_area.size;
    let (snapped_x, snapped_y) = nearest_edge_position(
        position.x as f64,
        position.y as f64,
        OVERLAY_SIZE as f64,
        OVERLAY_SIZE as f64,
        monitor_position.x as f64,
        monitor_position.y as f64,
        monitor_size.width as f64,
        monitor_size.height as f64,
        8.0,
    );
    let (x, y) = constrain_overlay_position(
        &app,
        snapped_x,
        snapped_y,
        monitor.name().map(String::as_str),
    );
    win.set_position(PhysicalPosition::new(x as i32, y as i32))
        .map_err(|e| format!("failed to snap pet-overlay: {e}"))?;
    pin_pet_window_topmost(&win, true);
    if let Ok(mut geo) = app.state::<PetWindowState>().geometry.lock() {
        geo.overlay_x = Some(x);
        geo.overlay_y = Some(y);
        geo.overlay_monitor_name = monitor.name().cloned();
        save_geometry(&app, &geo);
    }
    Ok(())
}

/// Open or focus the single pet-mini-panel instance near the pet.
///
/// Does **not** hide the pet-overlay. The frontend must call
/// `pet_hide_overlay` only after confirming the panel is visible
/// (`pet_is_panel_visible`), so a failed panel open cannot leave the
/// user with neither sprite nor panel.
#[tauri::command]
pub async fn pet_open_or_focus_panel(
    app: AppHandle,
    near_x: Option<f64>,
    near_y: Option<f64>,
    panel_mode: Option<PetPanelMode>,
) -> Result<PetPanelOpenResult, String> {
    let intent_generation = record_pet_visibility_intent(&app, PET_MINI_PANEL_LABEL);
    tauri::async_runtime::spawn_blocking(move || {
        open_or_focus_pet_panel_blocking(app, near_x, near_y, panel_mode, intent_generation)
    })
    .await
    .map_err(|_| "pet panel worker failed".to_string())?
}

fn open_or_focus_pet_panel_blocking(
    app: AppHandle,
    near_x: Option<f64>,
    near_y: Option<f64>,
    panel_mode: Option<PetPanelMode>,
    intent_generation: u64,
) -> Result<PetPanelOpenResult, String> {
    let state = app.state::<PetWindowState>();
    let _lifecycle = match state.panel_lifecycle.lock() {
        Ok(lifecycle) => lifecycle,
        Err(_) => {
            return Ok(PetPanelOpenResult::failed(
                false,
                "panel_lifecycle_unavailable",
            ))
        }
    };
    if !pet_visibility_intent_is_current(&state, PET_MINI_PANEL_LABEL, intent_generation) {
        return Ok(PetPanelOpenResult::failed(false, "superseded"));
    }
    let (win, created) = match get_or_create_pet_panel(&app) {
        Ok(acquired) => acquired,
        Err(error) => {
            #[cfg(debug_assertions)]
            eprintln!("[pets] pet-mini-panel creation failed: {error}");
            return Ok(PetPanelOpenResult::failed(
                false,
                pet_acquire_failure_reason(PET_MINI_PANEL_LABEL, &error),
            ));
        }
    };
    if created {
        return Ok(PetPanelOpenResult::failed(true, "not_visible"));
    }
    let Some(win) = win else {
        return Ok(PetPanelOpenResult::failed(false, "window_missing"));
    };
    let panel_mode = panel_mode.unwrap_or_default();

    let geo = match state.geometry.lock() {
        Ok(geo) => geo.clone(),
        Err(_) => return Ok(PetPanelOpenResult::failed(created, "geometry_unavailable")),
    };

    let (w, h) = restored_panel_size(geo.panel_w, geo.panel_h);
    let follow_anchor = if panel_mode == PetPanelMode::FollowPet {
        // Drag/show/display recovery already records physical coordinates.
        // Do not wait on the window event loop while holding geometry state.
        near_x.zip(near_y).or_else(|| geo.overlay_x.zip(geo.overlay_y))
    } else {
        None
    };
    let (x, y) = if let Some((nx, ny)) = follow_anchor {
        recover_position(
            &app,
            Some(nx + OVERLAY_SIZE as f64 + 8.0),
            Some(ny),
            w,
            h,
            None,
        )
    } else if let (Some(px), Some(py)) = (geo.panel_x, geo.panel_y) {
        recover_position(
            &app,
            Some(px),
            Some(py),
            w,
            h,
            geo.panel_monitor_name.as_deref(),
        )
    } else if let (Some(nx), Some(ny)) = (near_x, near_y) {
        recover_position(
            &app,
            Some(nx + OVERLAY_SIZE as f64 + 8.0),
            Some(ny),
            w,
            h,
            None,
        )
    } else {
        recover_position(&app, None, None, w, h, geo.panel_monitor_name.as_deref())
    };

    #[cfg(target_os = "windows")]
    {
        if !configure_pet_surface_until_ready(
            created,
            PET_CREATED_SURFACE_READY_ATTEMPTS,
            std::time::Duration::from_millis(PET_CREATED_SURFACE_READY_POLL_MS),
            || {
                configure_pet_surface_on_main_thread(
                    &app,
                    &win,
                    "VibeSpace Pet Panel",
                    x as i32,
                    y as i32,
                    w as i32,
                    h as i32,
                    true,
                )
            },
        ) {
            return Ok(PetPanelOpenResult::failed(created, "not_visible"));
        }
        ensure_pet_topmost_watchdog(&app);
        let mut geo = state.geometry.lock().map_err(|_| "geometry_unavailable")?;
        geo.panel_x = Some(x);
        geo.panel_y = Some(y);
        geo.panel_w = Some(w);
        geo.panel_h = Some(h);
        save_geometry(&app, &geo);
        drop(geo);
        *state.panel_open.lock().map_err(|_| "panel_state_unavailable")? = true;
        return Ok(PetPanelOpenResult::visible_and_focused(created));
    }

    #[cfg(not(target_os = "windows"))]
    {
        if win.set_size(PhysicalSize::new(w as u32, h as u32)).is_err() {
            return Ok(PetPanelOpenResult::failed(created, "size_failed"));
        }
        if win
            .set_min_size(Some(tauri::LogicalSize::new(PANEL_MIN_W, PANEL_MIN_H)))
            .is_err()
        {
            return Ok(PetPanelOpenResult::failed(created, "size_failed"));
        }
        if win
            .set_position(PhysicalPosition::new(x as i32, y as i32))
            .is_err()
        {
            return Ok(PetPanelOpenResult::failed(created, "position_failed"));
        }
        if win
            .set_always_on_top(panel_stays_on_top(panel_mode))
            .is_err()
        {
            return Ok(PetPanelOpenResult::failed(created, "topmost_failed"));
        }
        if win.unminimize().is_err() {
            return Ok(PetPanelOpenResult::failed(created, "restore_failed"));
        }
        if win.show().is_err() {
            return Ok(PetPanelOpenResult::failed(created, "show_failed"));
        }
        if !native_show_pet_window(&win, "VibeSpace Pet Panel", true) {
            return Ok(PetPanelOpenResult::failed(created, "not_visible"));
        }
        pin_pet_window_topmost(&win, false);
        ensure_pet_topmost_watchdog(&app);
        if win.set_focus().is_err() {
            return Ok(PetPanelOpenResult::failed(created, "focus_failed"));
        }

        if !native_pet_window_visible(&win) {
            return Ok(PetPanelOpenResult::failed(created, "not_visible"));
        }

        let monitor_name = win
            .current_monitor()
            .ok()
            .flatten()
            .and_then(|monitor| monitor.name().cloned());
        let mut geo = state.geometry.lock().map_err(|_| "geometry_unavailable")?;
        geo.panel_x = Some(x);
        geo.panel_y = Some(y);
        geo.panel_w = Some(w);
        geo.panel_h = Some(h);
        geo.panel_monitor_name = monitor_name;
        save_geometry(&app, &geo);
        drop(geo);
        *state.panel_open.lock().map_err(|_| "panel_state_unavailable")? = true;

        // Intentionally do not hide pet-overlay here — JS confirm-then-hide.
        Ok(PetPanelOpenResult::visible_and_focused(created))
    }
}

async fn restore_pet_overlay_for_panel_intent(
    app: AppHandle,
    panel_intent_generation: u64,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        restore_pet_overlay_for_panel_intent_blocking(app, panel_intent_generation)
    })
    .await
    .map_err(|_| "pet overlay restore worker failed".to_string())?
}

fn restore_pet_overlay_for_panel_intent_blocking(
    app: AppHandle,
    panel_intent_generation: u64,
) -> Result<(), String> {
    let state = app.state::<PetWindowState>();
    let _panel_lifecycle = state
        .panel_lifecycle
        .lock()
        .map_err(|_| "panel_lifecycle_unavailable".to_string())?;
    if !pet_visibility_intent_is_current(&state, PET_MINI_PANEL_LABEL, panel_intent_generation) {
        return Ok(());
    }

    // Keep the panel intent serialized through the overlay side effect. A
    // newer panel open records its generation before waiting on this lock, so
    // the post-show validation below can undo a restore superseded mid-show.
    let _overlay_lifecycle = state
        .overlay_lifecycle
        .lock()
        .map_err(|_| "overlay_lifecycle_unavailable".to_string())?;
    if !pet_visibility_intent_is_current(&state, PET_MINI_PANEL_LABEL, panel_intent_generation) {
        return Ok(());
    }

    let overlay_intent_generation = record_pet_visibility_intent(&app, PET_OVERLAY_LABEL);
    let show_result = show_pet_overlay_with_lifecycle_held(app.clone(), &state);
    if !pet_visibility_intent_is_current(&state, PET_MINI_PANEL_LABEL, panel_intent_generation)
        && pet_visibility_intent_is_current(&state, PET_OVERLAY_LABEL, overlay_intent_generation)
    {
        if let Some(win) = app.get_webview_window(PET_OVERLAY_LABEL) {
            hide_pet_window(&win).map_err(str::to_string)?;
        }
    }
    show_result.map(|_| ())
}

/// Minimize panel only — sessions keep running. Restores the pet sprite.
#[tauri::command]
pub async fn pet_minimize_panel(app: AppHandle) -> Result<(), String> {
    let intent_generation = record_pet_visibility_intent(&app, PET_MINI_PANEL_LABEL);
    {
        let state = app.state::<PetWindowState>();
        let _lifecycle = state
            .panel_lifecycle
            .lock()
            .map_err(|_| "panel_lifecycle_unavailable".to_string())?;
        if !pet_visibility_intent_is_current(&state, PET_MINI_PANEL_LABEL, intent_generation) {
            return Ok(());
        }
        if let Some(win) = app.get_webview_window(PET_MINI_PANEL_LABEL) {
            let _ = win.minimize();
        }
        if let Ok(mut open) = state.panel_open.lock() {
            *open = false;
        };
    }
    let _ = restore_pet_overlay_for_panel_intent(app.clone(), intent_generation).await;
    Ok(())
}

/// Hide panel without killing sessions (close after user confirms in UI). Restores pet.
#[tauri::command]
pub async fn pet_hide_panel(app: AppHandle) -> Result<(), String> {
    let intent_generation = record_pet_visibility_intent(&app, PET_MINI_PANEL_LABEL);
    {
        let state = app.state::<PetWindowState>();
        let _lifecycle = state
            .panel_lifecycle
            .lock()
            .map_err(|_| "panel_lifecycle_unavailable".to_string())?;
        if !pet_visibility_intent_is_current(&state, PET_MINI_PANEL_LABEL, intent_generation) {
            return Ok(());
        }
        if let Some(win) = app.get_webview_window(PET_MINI_PANEL_LABEL) {
            // A minimized window reports its tiny caption rectangle. Never
            // persist that rectangle as the next full panel's geometry.
            let geometry = if !win.is_minimized().unwrap_or(true) {
                win.outer_position().ok().zip(win.outer_size().ok())
                    .filter(|(_, size)| size.width as f64 >= PANEL_MIN_W && size.height as f64 >= PANEL_MIN_H)
            } else {
                None
            };
            if let Ok(mut geo) = state.geometry.lock() {
                if let Some((pos, size)) = geometry {
                    geo.panel_x = Some(pos.x as f64);
                    geo.panel_y = Some(pos.y as f64);
                    geo.panel_w = Some(size.width as f64);
                    geo.panel_h = Some(size.height as f64);
                }
                save_geometry(&app, &geo);
            }
            hide_pet_window(&win).map_err(str::to_string)?;
        }
        if let Ok(mut open) = state.panel_open.lock() {
            *open = false;
        };
    }
    let _ = restore_pet_overlay_for_panel_intent(app.clone(), intent_generation).await;
    Ok(())
}

#[tauri::command]
pub async fn pet_is_panel_visible(app: AppHandle) -> Result<bool, String> {
    let Some(win) = app.get_webview_window(PET_MINI_PANEL_LABEL) else {
        return Ok(false);
    };
    Ok(native_pet_window_visible(&win))
}

#[tauri::command]
pub async fn pet_save_panel_geometry(
    app: AppHandle,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
) -> Result<(), String> {
    let (cx, cy) = clamp_to_monitors(&app, x, y, w, h, None);
    if let Ok(mut geo) = app.state::<PetWindowState>().geometry.lock() {
        geo.panel_x = Some(cx);
        geo.panel_y = Some(cy);
        geo.panel_w = Some(w.max(PANEL_MIN_W));
        geo.panel_h = Some(h.max(PANEL_MIN_H));
        geo.panel_monitor_name = app
            .get_webview_window(PET_MINI_PANEL_LABEL)
            .and_then(|window| window.current_monitor().ok().flatten())
            .and_then(|monitor| monitor.name().cloned());
        save_geometry(&app, &geo);
    }
    Ok(())
}

/// Validate a protocol action name is in the allowed set (defense in depth).
#[tauri::command]
pub fn pet_validate_action(action: String) -> Result<bool, String> {
    const ALLOWED: &[&str] = &[
        "pet:ready",
        "pet:anim_changed",
        "pet:click",
        "pet:drag_start",
        "pet:drag_end",
        "pet:position",
        "panel:open",
        "panel:focus",
        "panel:minimize",
        "panel:restore",
        "panel:close_request",
        "panel:close_confirmed",
        "panel:closed",
        "panel:lifecycle",
        "presentation:claim_chat",
        "presentation:release_chat",
        "presentation:claim_terminal",
        "presentation:release_terminal",
        "presentation:sync",
        "activity:push",
        "session:heartbeat",
    ];
    Ok(ALLOWED.contains(&action.as_str()))
}

/// Unit-testable helpers (pure).
#[cfg(test)]
mod tests {
    #[test]
    fn panel_restore_rejects_minimized_or_invalid_dimensions() {
        assert_eq!(super::restored_panel_size(Some(159.0), Some(27.0)), (430.0, 560.0));
        assert_eq!(super::restored_panel_size(Some(f64::NAN), Some(f64::INFINITY)), (430.0, 560.0));
        assert_eq!(super::restored_panel_size(Some(800.0), Some(650.0)), (800.0, 650.0));
        assert_eq!(super::restored_panel_size(None, None), (430.0, 560.0));
    }
    use super::*;

    #[test]
    fn pet_labels_are_distinct() {
        assert_ne!(PET_OVERLAY_LABEL, PET_MINI_PANEL_LABEL);
        assert!(is_pet_label(PET_OVERLAY_LABEL));
        assert!(is_pet_label(PET_MINI_PANEL_LABEL));
        assert!(!is_pet_label("main"));
    }

    #[test]
    fn pet_hide_uses_native_visibility_as_its_completion_boundary() {
        let source = include_str!("pets.rs");
        let hwnd_lookup_start = source
            .find("fn native_pet_hwnds")
            .expect("native Pet HWND lookup exists");
        let hwnd_lookup_end = source[hwnd_lookup_start..]
            .find("fn native_pet_window_visible")
            .map(|offset| hwnd_lookup_start + offset)
            .expect("native Pet HWND lookup is bounded");
        let hwnd_lookup = &source[hwnd_lookup_start..hwnd_lookup_end];
        assert!(hwnd_lookup.contains("EnumWindows("));
        assert!(hwnd_lookup.contains("GetPropW("));
        assert!(hwnd_lookup.contains("GetWindowThreadProcessId("));
        assert!(!hwnd_lookup.contains("FindWindowExW("));
        assert!(!hwnd_lookup.contains("SendMessageTimeoutW("));
        assert!(!hwnd_lookup.contains("WM_GETTEXT"));

        let command_start = source
            .find("pub async fn pet_hide_overlay")
            .expect("overlay hide command exists");
        let command_end = source[command_start..]
            .find("pub async fn pet_is_overlay_visible")
            .map(|offset| command_start + offset)
            .expect("overlay hide command is bounded");
        let command = &source[command_start..command_end];

        assert!(command.contains("hide_pet_window_by_state(&app, PET_OVERLAY_LABEL)"));
        assert!(command.contains("hide_pet_overlay_window(&app)"));
        assert!(!command.contains("app.get_webview_window"));
        assert!(!command.contains("let _ = win.hide()"));
        assert!(command.contains("spawn_blocking"));

        let windows_helper_start = source
            .find("#[cfg(target_os = \"windows\")]\nfn hide_pet_windows_by_label")
            .expect("Windows overlay hide helper exists");
        let windows_helper_end = source[windows_helper_start..]
            .find("#[cfg(not(target_os = \"windows\"))]\nfn hide_pet_window")
            .map(|offset| windows_helper_start + offset)
            .expect("Windows overlay hide helper is bounded");
        let windows_helper = &source[windows_helper_start..windows_helper_end];
        assert!(windows_helper.contains("native_pet_hwnds(label)"));
        assert!(windows_helper.contains("ShowWindow(hwnd, SW_HIDE)"));
        assert!(!windows_helper.contains("win.hwnd()"));
        assert!(!windows_helper.contains("win.hide()"));

        let state_hide_start = source
            .find("fn hide_pet_window_by_state")
            .expect("state-backed Windows hide helper exists");
        let state_hide_end = source[state_hide_start..]
            .find("#[cfg(target_os = \"windows\")]\nfn hide_pet_window")
            .map(|offset| state_hide_start + offset)
            .expect("state-backed hide helper is bounded");
        let state_hide = &source[state_hide_start..state_hide_end];
        assert!(state_hide.contains("pet_native_hwnd_slot"));
        assert!(state_hide.contains("ShowWindow(hwnd, SW_HIDE)"));
        assert!(!state_hide.contains("native_pet_hwnds("));
        assert!(!state_hide.contains("get_webview_window"));

        let setup_hide_start = source
            .find("fn schedule_setup_pet_hide")
            .expect("setup hide scheduler exists");
        let setup_hide_end = source[setup_hide_start..]
            .find("pub fn materialize_detached_pet_hosts")
            .map(|offset| setup_hide_start + offset)
            .expect("setup hide scheduler is bounded");
        assert!(source[setup_hide_start..setup_hide_end].contains("hide_pet_window(&window)"));
    }

    #[test]
    fn delayed_setup_hide_is_generation_fenced_from_explicit_visibility_intent() {
        let source = include_str!("pets.rs");
        let tests_start = source.find("mod tests {").expect("test module exists");
        let production = &source[..tests_start];
        let state_start = production
            .find("pub struct PetWindowState")
            .expect("pet window state exists");
        let state_end = production[state_start..]
            .find("pub struct PetOverlayShowResult")
            .map(|offset| state_start + offset)
            .expect("pet window state is bounded");
        let state = &production[state_start..state_end];
        assert!(state.contains("overlay_visibility_generation: AtomicU64"));
        assert!(state.contains("panel_visibility_generation: AtomicU64"));

        let hide_start = production
            .find("fn schedule_setup_pet_hide")
            .expect("setup hide scheduler exists");
        let hide_end = production[hide_start..]
            .find("pub fn materialize_detached_pet_hosts")
            .map(|offset| hide_start + offset)
            .expect("setup hide scheduler is bounded");
        let hide = &production[hide_start..hide_end];
        assert!(hide.contains("setup_generation"));
        assert!(hide.contains("visibility_generation"));
        assert!(hide.find("lifecycle.lock()").unwrap() < hide.rfind("setup_generation").unwrap());

        let show_start = production
            .find("pub async fn pet_show_overlay")
            .expect("overlay show command exists");
        let show_end = production[show_start..]
            .find("fn show_pet_overlay_blocking")
            .map(|offset| show_start + offset)
            .expect("overlay show command is bounded");
        let show = &production[show_start..show_end];
        assert!(show.contains("record_pet_visibility_intent(&app, PET_OVERLAY_LABEL)"));
        assert!(
            show.find("record_pet_visibility_intent").unwrap()
                < show.find("spawn_blocking").unwrap()
        );
    }

    #[test]
    fn detached_pet_windows_build_renderer_attached_native_webview_windows() {
        let source = include_str!("pets.rs");
        let overlay_start = source
            .find("fn build_pet_overlay")
            .expect("overlay builder exists");
        let overlay_end = source[overlay_start..]
            .find("fn get_or_create_pet_panel")
            .map(|offset| overlay_start + offset)
            .expect("overlay builder has a bounded source slice");
        let panel_start = source
            .find("fn build_pet_panel")
            .expect("panel builder exists");
        let panel_end = source[panel_start..]
            .find("/// Show the pet overlay")
            .map(|offset| panel_start + offset)
            .expect("panel builder has a bounded source slice");

        for builder in [
            &source[overlay_start..overlay_end],
            &source[panel_start..panel_end],
        ] {
            assert!(builder.contains("WebviewWindowBuilder::new("));
            assert!(!builder.contains("let host = WindowBuilder::new"));
            assert!(!builder.contains("host.add_child("));
        }
        let overlay_builder = &source[overlay_start..overlay_end];
        assert!(overlay_builder.contains(".visible(visible)"));
        assert!(overlay_builder.contains("Some((x, y)) => builder.position(x, y)"));
        assert!(source
            .contains("build_pet_overlay(app, handle, true, Some(PET_SETUP_OFFSCREEN_POSITION))"));
        assert!(source.contains("build_pet_overlay(&app_for_build, &app_for_build, true, None)"));
        let panel_builder = &source[panel_start..panel_end];
        assert!(panel_builder.contains(".visible(visible)"));
        assert!(panel_builder.contains("Some((x, y)) => builder.position(x, y)"));
        assert!(source.contains("schedule_pet_panel_build(app, true)?"));
    }

    #[test]
    fn detached_pet_windows_share_the_exact_main_webview2_environment_options() {
        let source = include_str!("pets.rs");
        let tests_start = source.find("mod tests {").expect("test module exists");
        let production = &source[..tests_start];
        let helper_start = production
            .find("fn configured_main_webview_browser_args")
            .expect("main WebView2 option resolver exists");
        let helper_end = production[helper_start..]
            .find("fn build_pet_overlay")
            .map(|offset| helper_start + offset)
            .expect("main WebView2 option resolver is bounded");
        let helper = &production[helper_start..helper_end];
        assert!(helper.contains("app.config()"));
        assert!(helper.contains(".app"));
        assert!(helper.contains(".windows"));
        assert!(helper.contains("window.label == \"main\""));
        assert!(helper.contains("additional_browser_args"));

        for function in ["fn build_pet_overlay", "fn build_pet_panel"] {
            let start = production.find(function).expect("Pet builder exists");
            let end = production[start + function.len()..]
                .find("\nfn ")
                .map(|offset| start + function.len() + offset)
                .unwrap_or(production.len());
            let builder = &production[start..end];
            assert!(builder.contains("configured_main_webview_browser_args(app)?"));
            assert!(builder.contains(".additional_browser_args(&browser_args)"));
        }
    }

    #[test]
    fn detached_pet_url_uses_tauri_runtime_asset_resolution() {
        let source = include_str!("pets.rs");
        let url_start = source
            .find("fn pet_webview_url")
            .expect("pet URL resolver exists");
        let url_end = source[url_start..]
            .find("fn log_pet_window_metrics")
            .map(|offset| url_start + offset)
            .expect("pet URL resolver has a bounded source slice");
        let url_resolver = &source[url_start..url_end];

        assert!(url_resolver.contains("WebviewUrl::App("));
        assert!(!url_resolver.contains("dev_url"));
        assert!(!url_resolver.contains("WebviewUrl::External"));
    }

    #[test]
    fn detached_pet_hosts_schedule_main_loop_creation_without_nested_waits() {
        let source = include_str!("pets.rs");
        let tests_start = source.find("mod tests {").expect("test module exists");
        let production = &source[..tests_start];
        assert!(!production.contains("fn build_pet_overlay_on_main_thread"));
        assert!(!production.contains("fn build_pet_panel_on_main_thread"));

        let acquire_start = production
            .find("fn acquire_pet_overlay")
            .expect("overlay acquire helper exists");
        let acquire_end = production[acquire_start..]
            .find("fn build_pet_overlay")
            .map(|offset| acquire_start + offset)
            .expect("overlay acquire has a bounded source slice");
        assert!(production[acquire_start..acquire_end].contains("schedule_pet_overlay_build(app)?"));

        let panel_start = production
            .find("fn get_or_create_pet_panel")
            .expect("panel acquire helper exists");
        let panel_end = production[panel_start..]
            .find("fn build_pet_panel")
            .map(|offset| panel_start + offset)
            .expect("panel acquire has a bounded source slice");
        assert!(production[panel_start..panel_end].contains("schedule_pet_panel_build(app, true)?"));
    }

    #[test]
    fn detached_pet_creation_yields_before_native_host_configuration() {
        let source = include_str!("pets.rs");
        let tests_start = source.find("mod tests {").expect("test module exists");
        let production = &source[..tests_start];

        let overlay_start = production
            .find("pub async fn pet_show_overlay")
            .expect("asynchronous overlay command exists");
        let overlay_end = production[overlay_start..]
            .find("fn schedule_pet_overlay_restore")
            .map(|offset| overlay_start + offset)
            .expect("overlay command has a bounded source slice");
        let overlay_command = &production[overlay_start..overlay_end];
        assert!(overlay_command.contains("tauri::async_runtime::spawn_blocking"));
        let overlay_created = overlay_command
            .find("if created {")
            .expect("new overlay yields pending truth");
        let overlay_configure = overlay_command
            .find("show_existing_pet_overlay")
            .expect("existing overlay configures natively");
        assert!(overlay_created < overlay_configure);

        let panel_start = production
            .find("pub async fn pet_open_or_focus_panel")
            .expect("asynchronous panel command exists");
        let panel_end = production[panel_start..]
            .find("fn open_or_focus_pet_panel_blocking")
            .map(|offset| panel_start + offset)
            .expect("panel command has a bounded source slice");
        let panel_command = &production[panel_start..panel_end];
        assert!(panel_command.contains("tauri::async_runtime::spawn_blocking"));

        let panel_helper_start = production
            .find("fn open_or_focus_pet_panel_blocking")
            .expect("panel helper exists");
        let panel_helper_end = production[panel_helper_start..]
            .find("/// Minimize panel only")
            .map(|offset| panel_helper_start + offset)
            .expect("panel helper has a bounded source slice");
        let panel_helper = &production[panel_helper_start..panel_helper_end];
        let panel_created = panel_helper
            .find("if created {")
            .expect("new panel yields pending truth");
        let panel_configure = panel_helper
            .find("configure_pet_surface_until_ready")
            .expect("existing panel configures natively");
        assert!(panel_created < panel_configure);

        let restore_start = production
            .find("fn schedule_pet_overlay_restore")
            .expect("synchronous native-close restore exists");
        let restore_end = production[restore_start..]
            .find("fn show_existing_pet_overlay")
            .map(|offset| restore_start + offset)
            .expect("native-close restore has a bounded source slice");
        assert!(production[restore_start..restore_end].contains("async_runtime"));

        assert!(production.contains("pub async fn pet_minimize_panel"));
        assert!(production.contains("pub async fn pet_hide_panel"));
    }

    #[test]
    fn detached_pet_build_is_queued_on_main_thread_without_waiting() {
        let source = include_str!("pets.rs");
        let tests_start = source.find("mod tests {").expect("test module exists");
        let production = &source[..tests_start];

        let schedule_start = production
            .find("fn schedule_pet_overlay_build")
            .expect("overlay build scheduler exists");
        let schedule_end = production[schedule_start..]
            .find("fn get_or_create_pet_panel")
            .map(|offset| schedule_start + offset)
            .expect("overlay scheduler has a bounded source slice");
        let overlay_schedule = &production[schedule_start..schedule_end];
        assert!(overlay_schedule.contains("run_on_main_thread"));
        assert!(overlay_schedule.contains("build_pet_overlay"));
        assert!(!overlay_schedule.contains("channel"));
        assert!(!overlay_schedule.contains("recv"));

        let panel_schedule_start = production
            .find("fn schedule_pet_panel_build")
            .expect("panel build scheduler exists");
        let panel_schedule_end = production[panel_schedule_start..]
            .find("fn build_pet_panel")
            .map(|offset| panel_schedule_start + offset)
            .expect("panel scheduler has a bounded source slice");
        let panel_schedule = &production[panel_schedule_start..panel_schedule_end];
        assert!(panel_schedule.contains("run_on_main_thread"));
        assert!(panel_schedule.contains("build_pet_panel"));
        assert!(!panel_schedule.contains("channel"));
        assert!(!panel_schedule.contains("recv"));
    }

    #[test]
    fn detached_pet_build_is_deferred_past_the_originating_ipc_response() {
        let source = include_str!("pets.rs");
        let tests_start = source.find("mod tests {").expect("test module exists");
        let production = &source[..tests_start];

        let overlay_start = production
            .find("fn schedule_pet_overlay_build")
            .expect("overlay build scheduler exists");
        let overlay_end = production[overlay_start..]
            .find("fn build_pet_overlay")
            .map(|offset| overlay_start + offset)
            .expect("overlay scheduler has a bounded source slice");
        let overlay = &production[overlay_start..overlay_end];
        assert!(overlay.contains("pet-overlay-create"));
        assert!(overlay.contains("PET_DETACHED_BUILD_DELAY_MS"));
        assert!(overlay.find("sleep").unwrap() < overlay.find("run_on_main_thread").unwrap());

        let panel_start = production
            .find("fn schedule_pet_panel_build")
            .expect("panel build scheduler exists");
        let panel_end = production[panel_start..]
            .find("fn build_pet_panel")
            .map(|offset| panel_start + offset)
            .expect("panel scheduler has a bounded source slice");
        let panel = &production[panel_start..panel_end];
        assert!(panel.contains("pet-mini-panel-create"));
        assert!(panel.contains("PET_DETACHED_BUILD_DELAY_MS"));
        assert!(panel.find("sleep").unwrap() < panel.find("run_on_main_thread").unwrap());
    }

    #[test]
    fn detached_pet_hosts_are_lazy_during_tauri_setup() {
        let source = include_str!("pets.rs");
        let tests_start = source.find("mod tests {").expect("test module exists");
        let production = &source[..tests_start];

        let load_start = production
            .find("pub fn load_geometry")
            .expect("setup geometry seam exists");
        let load_end = production[load_start..]
            .find("pub fn save_geometry")
            .map(|offset| load_start + offset)
            .expect("setup geometry seam is bounded");
        assert!(!production[load_start..load_end].contains("materialize_detached_pet_hosts"));

        let materialize_start = production
            .find("pub fn materialize_detached_pet_hosts")
            .expect("setup materializer exists");
        let materialize_end = production[materialize_start..]
            .find("fn schedule_pet_overlay_build")
            .map(|offset| materialize_start + offset)
            .expect("setup materializer is bounded");
        let materialize = &production[materialize_start..materialize_end];
        assert!(!materialize.contains("build_pet_overlay("));
        assert!(!materialize.contains("build_pet_panel("));
        assert!(!materialize.contains("schedule_setup_pet_hide("));
        assert!(!materialize.contains("outer_position()"));

        let hide_start = production
            .find("fn schedule_setup_pet_hide")
            .expect("setup hide scheduler exists");
        let hide_end = production[hide_start..]
            .find("pub fn materialize_detached_pet_hosts")
            .map(|offset| hide_start + offset)
            .expect("setup hide scheduler is bounded");
        let hide = &production[hide_start..hide_end];
        assert!(hide.contains("PET_SETUP_MATERIALIZATION_DELAY_MS"));
        assert!(hide.contains("std::thread::sleep"));
        assert!(hide.contains(".outer_position()"));
        assert!(hide.contains("if still_offscreen"));
        assert!(hide.contains("hide_pet_window(&window)"));

        let lib_source = include_str!("lib.rs");
        let setup_start = lib_source.find(".setup(|app|").expect("setup hook exists");
        let setup = &lib_source[setup_start..];
        let materialize_call = setup
            .find("pets::materialize_detached_pet_hosts(app)")
            .expect("setup must use the direct App manager");
        let geometry_call = setup
            .find("pets::load_geometry(&app.handle())")
            .expect("setup geometry restore exists");
        assert!(materialize_call < geometry_call);
    }

    #[test]
    fn overlay_and_panel_workers_delegate_lifecycle_through_bounded_helpers() {
        let source = include_str!("pets.rs");
        let overlay_start = source
            .find("fn show_pet_overlay_blocking")
            .expect("overlay show helper exists");
        let overlay_end = source[overlay_start..]
            .find("fn schedule_pet_overlay_restore")
            .map(|offset| overlay_start + offset)
            .expect("overlay show helper has a bounded source slice");
        let overlay_show = &source[overlay_start..overlay_end];
        assert!(overlay_show.contains("acquire_pet_overlay(&app)"));
        assert!(!overlay_show.contains("acquire_pet_overlay_on_main_thread"));

        let panel_start = source
            .find("fn open_or_focus_pet_panel_blocking")
            .expect("panel open helper exists");
        let panel_end = source[panel_start..]
            .find("/// Minimize panel only")
            .map(|offset| panel_start + offset)
            .expect("panel open helper has a bounded source slice");
        let panel_open = &source[panel_start..panel_end];
        assert!(panel_open.contains("get_or_create_pet_panel(&app)"));
        assert!(!panel_open.contains("get_or_create_pet_panel_on_main_thread"));

        let production_source = source
            .split("#[cfg(test)]")
            .next()
            .expect("production source precedes the test module");
        assert!(!production_source.contains("run_scheduled_native_window_creation"));
    }

    #[test]
    fn overlay_visibility_requires_native_configuration_without_retiring_a_pending_host() {
        let source = include_str!("pets.rs");
        let configure_start = source
            .find("fn native_configure_pet_window")
            .expect("native configure helper exists");
        let configure_end = source[configure_start..]
            .find("#[cfg(not(target_os = \"windows\"))]")
            .map(|offset| configure_start + offset)
            .expect("native configure helper has a bounded source slice");
        let configure = &source[configure_start..configure_end];
        assert!(configure.contains("let positioned = SetWindowPos("));
        assert!(configure.contains("positioned.is_ok() && IsWindowVisible(hwnd).as_bool()"));

        let show_start = source
            .find("fn show_pet_overlay_blocking")
            .expect("overlay show helper exists");
        let show_end = source[show_start..]
            .find("fn schedule_pet_overlay_restore")
            .map(|offset| show_start + offset)
            .expect("overlay show helper has a bounded source slice");
        let show = &source[show_start..show_end];
        assert!(show.contains("retire_failed_pet_overlay(&app, created, reason);"));
        assert!(should_preserve_pending_pet_overlay("not_visible"));
        assert!(!should_preserve_pending_pet_overlay("position_failed"));
    }

    #[test]
    fn stale_panel_rebuild_is_reported_as_new_native_window() {
        let source = include_str!("pets.rs");
        let retire_start = source
            .find("fn retire_pet_registration")
            .expect("Pet retirement helper exists");
        let retire_end = source[retire_start..]
            .find("fn acquire_pet_overlay")
            .map(|offset| retire_start + offset)
            .expect("Pet retirement helper is bounded");
        let retire = &source[retire_start..retire_end];
        assert!(retire.contains("pet_native_hwnd_slot"));
        assert!(retire.contains("slot.store(0, Ordering::SeqCst)"));

        let acquire_start = source
            .find("fn get_or_create_pet_panel")
            .expect("panel acquisition helper exists");
        let acquire_end = source[acquire_start..]
            .find("fn build_pet_panel")
            .map(|offset| acquire_start + offset)
            .expect("panel acquisition helper has a bounded source slice");
        let acquire = &source[acquire_start..acquire_end];

        assert!(acquire.contains("PetRegistrationAction::Reuse"));
        assert!(acquire.contains("false,"));
        assert!(acquire.contains("retire_pet_registration(app, PET_MINI_PANEL_LABEL)?;"));
        assert!(acquire.contains("schedule_pet_panel_build(app, true)?"));
        assert!(acquire.contains("Ok((None, true))"));
        assert!(source.contains("let (win, created) = match get_or_create_pet_panel(&app)"));
    }

    #[test]
    fn validate_action_list_includes_panel_open() {
        assert!(allowed_actions_contains("panel:open"));
    }

    #[test]
    fn panel_mode_defaults_to_normal_but_visible_panel_stays_topmost() {
        assert_eq!(PetPanelMode::default(), PetPanelMode::Normal);
        assert!(panel_stays_on_top(PetPanelMode::FollowPet));
        assert!(panel_stays_on_top(PetPanelMode::AlwaysOnTop));
        assert!(panel_stays_on_top(PetPanelMode::Normal));
    }

    #[test]
    fn topmost_pin_targets_visible_unminimized_pet_windows_only() {
        assert!(should_pin_pet_window(true, false));
        assert!(!should_pin_pet_window(true, true));
        assert!(!should_pin_pet_window(false, false));
        assert!(!should_pin_pet_window(false, true));
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn overlay_caption_is_empty_and_lookup_requires_our_window_property() {
        use windows::{core::w, Win32::UI::WindowsAndMessaging::{CreateWindowExW, DestroyWindow, GetWindowTextW, IsIconic, WS_POPUP, WS_MINIMIZE}};
        let tagged = unsafe { CreateWindowExW(Default::default(), w!("STATIC"), w!("old pet title"), WS_POPUP | WS_MINIMIZE, -32000, -32000, 144, 144, None, None, None, None) }.unwrap();
        let unrelated = unsafe { CreateWindowExW(Default::default(), w!("STATIC"), w!(""), WS_POPUP, 0, 0, 144, 144, None, None, None, None) }.unwrap();
        assert!(set_pet_native_caption(tagged, true, "VibeSpace Pet"));
        install_pet_client_only_frame(tagged);
        native_restore_pet_window_chrome(tagged);
        assert!(!unsafe { IsIconic(tagged).as_bool() });
        use windows::Win32::UI::WindowsAndMessaging::{GetWindowLongPtrW, GWL_STYLE};
        let style = unsafe { GetWindowLongPtrW(tagged, GWL_STYLE) };
        assert_eq!(style & PET_NATIVE_FRAME_STYLE_BITS, 0);
        assert_ne!(style & 0x8000_0000, 0);
        let mut caption = [0u16; 64];
        assert_eq!(unsafe { GetWindowTextW(tagged, &mut caption) }, 0);
        let matches = native_pet_hwnds(PET_OVERLAY_LABEL);
        let tagged_found = matches.contains(&tagged);
        let unrelated_found = matches.contains(&unrelated);
        unsafe { let _ = DestroyWindow(tagged); let _ = DestroyWindow(unrelated); }
        assert!(tagged_found);
        assert!(!unrelated_found);
    }

    #[test]
    fn native_topmost_watchdog_targets_only_pet_window_titles() {
        assert!(is_pet_native_title("VibeSpace Pet"));
        assert!(is_pet_native_title("VibeSpace Pet Panel"));
        assert!(!is_pet_native_title("VibeSpace"));
        assert!(!is_pet_native_title("Pet"));
        assert!(!is_pet_native_title(""));

        let source = include_str!("pets.rs");
        let pin_start = source
            .find("fn native_pin_visible_pet_hwnds")
            .expect("native topmost helper exists");
        let pin_end = source[pin_start..]
            .find("fn pin_visible_pet_windows")
            .map(|offset| pin_start + offset)
            .expect("native topmost helper is bounded");
        let pin = &source[pin_start..pin_end];
        assert!(pin.contains("native_pet_hwnds(PET_OVERLAY_LABEL)"));
        assert!(pin.contains("native_pet_hwnds(PET_MINI_PANEL_LABEL)"));
        assert!(!pin.contains("GetWindowTextLengthW("));
        assert!(!pin.contains("GetWindowTextW("));
    }

    #[test]
    fn native_pet_chrome_repair_removes_caption_and_edge_styles() {
        assert_eq!(strip_pet_native_frame_style(0x14CB0000), 0x94000000);
        assert_eq!(strip_pet_native_frame_ex_style(0x40118), 0x40018);

        let source = include_str!("pets.rs");
        let configure_start = source
            .find("fn native_configure_pet_window")
            .expect("native configure helper exists");
        let configure_end = source[configure_start..]
            .find("#[cfg(not(target_os = \"windows\"))]")
            .map(|offset| configure_start + offset)
            .expect("native configure helper has a bounded source slice");
        assert!(source[configure_start..configure_end]
            .contains("native_restore_pet_window_chrome(hwnd)"));
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn panel_keeps_native_resize_style_without_a_painted_frame() {
        use windows::{core::w, Win32::UI::WindowsAndMessaging::{
            CreateWindowExW, DestroyWindow, GetClientRect, GetWindowLongPtrW,
            GetWindowRect, GWL_STYLE, WS_POPUP, WS_THICKFRAME,
        }};
        let panel = unsafe {
            CreateWindowExW(Default::default(), w!("STATIC"), w!("panel"), WS_POPUP,
                -32000, -32000, 240, 180, None, None, None, None)
        }.unwrap();
        assert!(set_pet_native_caption(panel, false, "VibeSpace Pet Panel"));
        install_pet_client_only_frame(panel);
        native_restore_pet_window_chrome(panel);
        let style = unsafe { GetWindowLongPtrW(panel, GWL_STYLE) };
        assert_ne!(style & WS_THICKFRAME.0 as isize, 0);
        assert_eq!(style & 0x00c0_0000, 0); // No caption.
        let mut outer = windows::Win32::Foundation::RECT::default();
        let mut client = windows::Win32::Foundation::RECT::default();
        unsafe {
            GetWindowRect(panel, &mut outer).unwrap();
            GetClientRect(panel, &mut client).unwrap();
            let _ = DestroyWindow(panel);
        }
        assert_eq!(outer.right - outer.left, client.right - client.left);
        assert_eq!(outer.bottom - outer.top, client.bottom - client.top);
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn minimized_panel_restores_its_normal_window_state() {
        use windows::{core::w, Win32::UI::WindowsAndMessaging::{
            CreateWindowExW, DestroyWindow, IsIconic, ShowWindow, SW_MINIMIZE, WS_POPUP,
        }};
        let panel = unsafe {
            CreateWindowExW(Default::default(), w!("STATIC"), w!("panel"), WS_POPUP,
                -32000, -32000, 430, 560, None, None, None, None)
        }.unwrap();
        assert!(set_pet_native_caption(panel, false, "VibeSpace Pet Panel"));
        install_pet_client_only_frame(panel);
        unsafe { let _ = ShowWindow(panel, SW_MINIMIZE); }
        assert!(unsafe { IsIconic(panel).as_bool() });
        native_restore_pet_window_chrome(panel);
        let still_minimized = unsafe { IsIconic(panel).as_bool() };
        unsafe { let _ = DestroyWindow(panel); }
        assert!(!still_minimized);
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn panel_dismiss_hides_native_shown_window_and_verifies_visibility() {
        use windows::{core::w, Win32::UI::WindowsAndMessaging::{
            CreateWindowExW, DestroyWindow, IsWindowVisible, ShowWindow, SW_SHOWNOACTIVATE, WS_POPUP,
        }};
        let panel = unsafe {
            CreateWindowExW(Default::default(), w!("STATIC"), w!("panel"), WS_POPUP,
                -32000, -32000, 430, 560, None, None, None, None)
        }.unwrap();
        assert!(set_pet_native_caption(panel, false, "VibeSpace Pet Panel"));
        unsafe { let _ = ShowWindow(panel, SW_SHOWNOACTIVATE); }
        assert!(unsafe { IsWindowVisible(panel).as_bool() });
        let hidden = hide_pet_windows_by_label(PET_MINI_PANEL_LABEL);
        let still_visible = unsafe { IsWindowVisible(panel).as_bool() };
        unsafe { let _ = DestroyWindow(panel); }
        assert!(hidden.is_ok());
        assert!(!still_visible);
        let source = include_str!("pets.rs");
        let start = source.find("pub async fn pet_hide_panel").unwrap();
        let end = source.find("pub async fn pet_is_panel_visible").unwrap();
        assert!(source[start..end].contains("hide_pet_window(&win).map_err(str::to_string)?"));
        assert!(!source[start..end].contains("let _ = win.hide()"));
    }

    #[test]
    fn follow_pet_anchor_does_not_wait_on_a_window_with_geometry_locked() {
        let source = include_str!("pets.rs");
        let start = source.find("let follow_anchor = if panel_mode").unwrap();
        let end = start + source[start..].find("let (x, y) =").unwrap();
        let anchor = &source[start..end];
        assert!(anchor.contains("geo.overlay_x.zip(geo.overlay_y)"));
        assert!(!anchor.contains("outer_position()"));
        assert!(!anchor.contains("get_webview_window("));
    }

    #[test]
    fn overlay_show_result_is_typed_and_does_not_claim_renderer_readiness() {
        let success = PetOverlayShowResult::visible(true);
        assert_eq!(success.mode, "native-overlay");
        assert!(success.created);
        assert!(success.visible);
        assert!(success.topmost_applied);
        assert_eq!(success.renderer_ready, None);
        assert_eq!(success.reason, None);

        let failure = PetOverlayShowResult::failed("window_create_failed");
        let serialized = serde_json::to_value(failure).expect("serializes safe result");
        assert_eq!(serialized["topmostApplied"], false);
        assert_eq!(serialized["rendererReady"], serde_json::Value::Null);
        assert_eq!(serialized["reason"], "window_create_failed");
    }

    #[test]
    fn pet_registration_retires_a_webview_registration_without_a_native_host() {
        assert_eq!(
            classify_pet_registration(true, true, true),
            PetRegistrationAction::Reuse
        );
        assert_eq!(
            classify_pet_registration(true, false, true),
            PetRegistrationAction::Retire
        );
        assert_eq!(
            classify_pet_registration(true, false, false),
            PetRegistrationAction::Retire
        );
        assert_eq!(
            classify_pet_registration(false, false, true),
            PetRegistrationAction::Retire
        );
        assert_eq!(
            classify_pet_registration(false, false, false),
            PetRegistrationAction::Create
        );
    }

    #[test]
    fn newly_created_pet_surface_waits_for_native_host_readiness() {
        let mut attempts = 0;
        let ready = configure_pet_surface_until_ready(true, 3, std::time::Duration::ZERO, || {
            attempts += 1;
            attempts == 3
        });

        assert!(ready);
        assert_eq!(attempts, 3);
    }

    #[test]
    fn windows_overlay_stages_and_shows_tauri_surface_before_native_verification() {
        let source = include_str!("pets.rs");
        let windows_branch = source
            .split("fn show_existing_pet_overlay")
            .nth(1)
            .and_then(|tail| tail.split("#[cfg(not(target_os = \"windows\"))]").next())
            .expect("Windows overlay show branch has a bounded source slice");

        let stage = windows_branch
            .find("win.set_position")
            .expect("geometry is staged through Tauri before show");
        let show = windows_branch
            .find("win.show()")
            .expect("Tauri creates and shows the host surface");
        let verify = windows_branch
            .find("configure_pet_surface_until_ready")
            .expect("native HWND verification remains bounded");

        assert!(stage < show);
        assert!(show < verify);
    }

    #[test]
    fn windows_pet_native_configuration_runs_on_the_event_loop_thread() {
        let source = include_str!("pets.rs");
        let helper_start = source
            .find("fn configure_pet_surface_on_main_thread")
            .expect("main-thread native configure helper exists");
        let helper_end = source[helper_start..]
            .find("fn configure_pet_surface_until_ready")
            .map(|offset| helper_start + offset)
            .expect("main-thread native configure helper is bounded");
        let helper = &source[helper_start..helper_end];
        assert!(helper.contains("run_on_main_thread"));
        assert!(helper.contains("sync_channel"));
        assert!(helper.contains("recv_timeout"));
        assert!(helper.contains("native_configure_pet_window"));

        let tests_start = source.find("mod tests {").expect("test module exists");
        let production = &source[..tests_start];
        assert_eq!(
            production
                .matches("configure_pet_surface_on_main_thread(")
                .count(),
            3
        );
    }

    #[test]
    fn reused_pet_surface_waits_for_async_show_dispatch() {
        let mut attempts = 0;
        let ready = configure_pet_surface_until_ready(false, 3, std::time::Duration::ZERO, || {
            attempts += 1;
            attempts == 3
        });

        assert!(ready);
        assert_eq!(attempts, 3);
    }

    #[test]
    fn native_pet_lifecycle_serializes_each_label_and_restores_overlay_on_a_worker() {
        let source = include_str!("pets.rs");
        let overlay_show = source
            .split("fn show_pet_overlay_blocking")
            .nth(1)
            .and_then(|tail| tail.split("fn schedule_pet_overlay_restore").next())
            .expect("overlay show helper has a bounded source slice");
        assert!(overlay_show.contains("overlay_lifecycle.lock()"));

        let panel_open = source
            .split("fn open_or_focus_pet_panel_blocking")
            .nth(1)
            .and_then(|tail| tail.split("/// Minimize panel only").next())
            .expect("panel open helper has a bounded source slice");
        assert!(panel_open.contains("panel_lifecycle.lock()"));

        let minimize_and_hide = source
            .split("pub async fn pet_minimize_panel")
            .nth(1)
            .and_then(|tail| tail.split("pub async fn pet_is_panel_visible").next())
            .expect("panel restore commands have a bounded source slice");
        assert!(minimize_and_hide.contains("restore_pet_overlay_for_panel_intent("));
        assert!(!minimize_and_hide.contains("pet_show_overlay(app.clone()).await"));
        assert!(!minimize_and_hide.contains("show_pet_overlay_blocking(app.clone())"));
    }

    #[test]
    fn panel_visibility_tokens_reject_stale_operations_after_lock_acquisition() {
        let source = include_str!("pets.rs");
        let open_start = source
            .find("pub async fn pet_open_or_focus_panel")
            .expect("panel open command exists");
        let minimize_start = source
            .find("pub async fn pet_minimize_panel")
            .expect("panel minimize command exists");
        let hide_start = source
            .find("pub async fn pet_hide_panel")
            .expect("panel hide command exists");
        let visible_start = source
            .find("pub async fn pet_is_panel_visible")
            .expect("panel visibility command exists");
        let open_and_worker = &source[open_start..minimize_start];
        let minimize = &source[minimize_start..hide_start];
        let hide = &source[hide_start..visible_start];
        for command in [open_and_worker, minimize, hide] {
            assert!(command.contains(
                "let intent_generation = record_pet_visibility_intent(&app, PET_MINI_PANEL_LABEL)"
            ));
            assert!(command.contains("pet_visibility_intent_is_current("));
        }
        for command in [minimize, hide] {
            assert_eq!(
                command.matches("pet_visibility_intent_is_current(").count(),
                1
            );
            assert!(command.contains("restore_pet_overlay_for_panel_intent("));
        }

        fn apply_if_current(
            state: &PetWindowState,
            visible: &AtomicBool,
            intent_generation: u64,
            requested_visibility: bool,
        ) {
            let _lifecycle = state.panel_lifecycle.lock().unwrap();
            if state.panel_visibility_generation.load(Ordering::SeqCst) == intent_generation {
                visible.store(requested_visibility, Ordering::SeqCst);
            }
        }

        use std::sync::{mpsc, Arc};
        let state = Arc::new(PetWindowState::default());
        let visible = Arc::new(AtomicBool::new(false));
        let stale_open = state
            .panel_visibility_generation
            .fetch_add(1, Ordering::SeqCst)
            .wrapping_add(1);
        let (release_open_tx, release_open_rx) = mpsc::channel();
        let open_state = state.clone();
        let open_visible = visible.clone();
        let open = std::thread::spawn(move || {
            release_open_rx.recv().unwrap();
            apply_if_current(&open_state, &open_visible, stale_open, true);
        });
        let current_hide = state
            .panel_visibility_generation
            .fetch_add(1, Ordering::SeqCst)
            .wrapping_add(1);
        apply_if_current(&state, &visible, current_hide, false);
        release_open_tx.send(()).unwrap();
        open.join().unwrap();
        assert!(!visible.load(Ordering::SeqCst));

        let stale_hide = state
            .panel_visibility_generation
            .fetch_add(1, Ordering::SeqCst)
            .wrapping_add(1);
        let (release_hide_tx, release_hide_rx) = mpsc::channel();
        let hide_state = state.clone();
        let hide_visible = visible.clone();
        let hide = std::thread::spawn(move || {
            release_hide_rx.recv().unwrap();
            apply_if_current(&hide_state, &hide_visible, stale_hide, false);
        });
        let current_open = state
            .panel_visibility_generation
            .fetch_add(1, Ordering::SeqCst)
            .wrapping_add(1);
        apply_if_current(&state, &visible, current_open, true);
        release_hide_tx.send(()).unwrap();
        hide.join().unwrap();
        assert!(visible.load(Ordering::SeqCst));

        use std::sync::atomic::AtomicUsize;
        let overlay_show_calls = AtomicUsize::new(0);
        if state.panel_visibility_generation.load(Ordering::SeqCst) == stale_hide {
            overlay_show_calls.fetch_add(1, Ordering::SeqCst);
        }
        assert_eq!(overlay_show_calls.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn overlay_visibility_and_panel_restore_reject_stale_intents() {
        let source = include_str!("pets.rs");
        let show_start = source
            .find("pub async fn pet_show_overlay")
            .expect("overlay show command exists");
        let hide_start = source
            .find("pub async fn pet_hide_overlay")
            .expect("overlay hide command exists");
        let visible_start = source
            .find("pub async fn pet_is_overlay_visible")
            .expect("overlay visibility command exists");
        let show = &source[show_start..hide_start];
        let hide = &source[hide_start..visible_start];
        assert!(show.contains(
            "let intent_generation = record_pet_visibility_intent(&app, PET_OVERLAY_LABEL)"
        ));
        assert!(show.contains("pet_visibility_intent_is_current("));
        assert!(hide.contains(
            "let intent_generation = record_pet_visibility_intent(&app, PET_OVERLAY_LABEL)"
        ));
        assert!(hide.contains("pet_visibility_intent_is_current("));

        let minimize_start = source
            .find("pub async fn pet_minimize_panel")
            .expect("panel minimize command exists");
        let panel_visible_start = source
            .find("pub async fn pet_is_panel_visible")
            .expect("panel visibility command exists");
        let panel_restore = &source[minimize_start..panel_visible_start];
        assert_eq!(
            panel_restore
                .matches("restore_pet_overlay_for_panel_intent(")
                .count(),
            2
        );
        assert!(!panel_restore.contains("pet_show_overlay(app.clone()).await"));
        let restore_start = source
            .find("fn restore_pet_overlay_for_panel_intent_blocking")
            .expect("conditional panel restore helper exists");
        let restore_end = source[restore_start..]
            .find("/// Minimize panel only")
            .map(|offset| restore_start + offset)
            .expect("conditional panel restore helper is bounded");
        let restore_helper = &source[restore_start..restore_end];
        let panel_lock = restore_helper
            .find("panel_lifecycle")
            .expect("panel lifecycle is held across restore");
        let overlay_lock = restore_helper
            .find("overlay_lifecycle")
            .expect("overlay lifecycle serializes the native side effect");
        let show_overlay = restore_helper
            .find("show_pet_overlay_with_lifecycle_held")
            .expect("restore uses the lock-held overlay helper");
        let cleanup_overlay = restore_helper
            .find("hide_pet_window")
            .expect("a restore superseded during show is undone");
        assert!(panel_lock < overlay_lock);
        assert!(overlay_lock < show_overlay);
        assert!(show_overlay < cleanup_overlay);

        use std::sync::{mpsc, Arc};
        let state = Arc::new(PetWindowState::default());
        let visible = Arc::new(AtomicBool::new(false));
        let stale_show = state
            .overlay_visibility_generation
            .fetch_add(1, Ordering::SeqCst)
            .wrapping_add(1);
        let (release_show_tx, release_show_rx) = mpsc::channel();
        let show_state = state.clone();
        let show_visible = visible.clone();
        let show = std::thread::spawn(move || {
            release_show_rx.recv().unwrap();
            let _lifecycle = show_state.overlay_lifecycle.lock().unwrap();
            if show_state
                .overlay_visibility_generation
                .load(Ordering::SeqCst)
                == stale_show
            {
                show_visible.store(true, Ordering::SeqCst);
            }
        });
        let current_hide = state
            .overlay_visibility_generation
            .fetch_add(1, Ordering::SeqCst)
            .wrapping_add(1);
        {
            let _lifecycle = state.overlay_lifecycle.lock().unwrap();
            if state.overlay_visibility_generation.load(Ordering::SeqCst) == current_hide {
                visible.store(false, Ordering::SeqCst);
            }
        }
        release_show_tx.send(()).unwrap();
        show.join().unwrap();
        assert!(!visible.load(Ordering::SeqCst));

        let stale_hide = state
            .overlay_visibility_generation
            .fetch_add(1, Ordering::SeqCst)
            .wrapping_add(1);
        let (release_hide_tx, release_hide_rx) = mpsc::channel();
        let hide_state = state.clone();
        let hide_visible = visible.clone();
        let hide = std::thread::spawn(move || {
            release_hide_rx.recv().unwrap();
            let _lifecycle = hide_state.overlay_lifecycle.lock().unwrap();
            if hide_state
                .overlay_visibility_generation
                .load(Ordering::SeqCst)
                == stale_hide
            {
                hide_visible.store(false, Ordering::SeqCst);
            }
        });
        let current_show = state
            .overlay_visibility_generation
            .fetch_add(1, Ordering::SeqCst)
            .wrapping_add(1);
        {
            let _lifecycle = state.overlay_lifecycle.lock().unwrap();
            if state.overlay_visibility_generation.load(Ordering::SeqCst) == current_show {
                visible.store(true, Ordering::SeqCst);
            }
        }
        release_hide_tx.send(()).unwrap();
        hide.join().unwrap();
        assert!(visible.load(Ordering::SeqCst));

        let stale_restore_before_show = state
            .panel_visibility_generation
            .fetch_add(1, Ordering::SeqCst)
            .wrapping_add(1);
        state
            .panel_visibility_generation
            .fetch_add(1, Ordering::SeqCst);
        let mut show_started = false;
        {
            let _panel = state.panel_lifecycle.lock().unwrap();
            if state.panel_visibility_generation.load(Ordering::SeqCst) == stale_restore_before_show
            {
                let _overlay = state.overlay_lifecycle.lock().unwrap();
                show_started = true;
            }
        }
        assert!(!show_started);

        let panel_restore_generation = state
            .panel_visibility_generation
            .fetch_add(1, Ordering::SeqCst)
            .wrapping_add(1);
        let (restore_started_tx, restore_started_rx) = mpsc::channel();
        let (finish_restore_tx, finish_restore_rx) = mpsc::channel();
        let restore_state = state.clone();
        let restore_visible = visible.clone();
        let restore = std::thread::spawn(move || {
            let _panel = restore_state.panel_lifecycle.lock().unwrap();
            let _overlay = restore_state.overlay_lifecycle.lock().unwrap();
            if restore_state
                .panel_visibility_generation
                .load(Ordering::SeqCst)
                == panel_restore_generation
            {
                restore_visible.store(true, Ordering::SeqCst);
            }
            restore_started_tx.send(()).unwrap();
            finish_restore_rx.recv().unwrap();
            if restore_state
                .panel_visibility_generation
                .load(Ordering::SeqCst)
                != panel_restore_generation
            {
                restore_visible.store(false, Ordering::SeqCst);
            }
        });
        restore_started_rx.recv().unwrap();
        state
            .panel_visibility_generation
            .fetch_add(1, Ordering::SeqCst);
        finish_restore_tx.send(()).unwrap();
        restore.join().unwrap();
        assert!(!visible.load(Ordering::SeqCst));
    }

    #[test]
    fn overlay_acquire_failure_distinguishes_stale_retirement_from_creation() {
        assert_eq!(
            overlay_acquire_failure_reason("failed to retire stale pet-overlay window"),
            "stale_window_retire_failed"
        );
        assert_eq!(
            overlay_acquire_failure_reason("timed out retiring stale pet-overlay registration"),
            "stale_window_retire_failed"
        );
        assert_eq!(
            overlay_acquire_failure_reason("failed to create pet-overlay window"),
            "window_create_failed"
        );
        assert_eq!(
            overlay_acquire_failure_reason("a webview with label pet-overlay already exists"),
            "window_label_conflict"
        );
    }

    #[test]
    fn panel_open_result_requires_visible_focused_native_window() {
        let success = PetPanelOpenResult::visible_and_focused(false);
        assert_eq!(success.mode, "native-panel");
        assert!(!success.created);
        assert!(success.visible);
        assert!(success.focused);
        assert!(success.topmost_applied);
        assert_eq!(success.renderer_ready, None);

        let failure = PetPanelOpenResult::failed(true, "focus_failed");
        let serialized = serde_json::to_value(failure).expect("serializes safe result");
        assert_eq!(serialized["created"], true);
        assert_eq!(serialized["visible"], false);
        assert_eq!(serialized["focused"], false);
        assert_eq!(serialized["reason"], "focus_failed");
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn topmost_pin_flags_do_not_activate_or_move() {
        use windows::Win32::UI::WindowsAndMessaging::{
            SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SWP_SHOWWINDOW,
        };
        assert_eq!(
            PET_TOPMOST_POS_FLAGS.0,
            SWP_NOMOVE.0 | SWP_NOSIZE.0 | SWP_NOACTIVATE.0
        );
        assert_eq!(PET_TOPMOST_POS_FLAGS.0 & SWP_SHOWWINDOW.0, 0);
    }

    #[test]
    fn overlay_is_shifted_past_the_scaled_main_navigation_when_rectangles_overlap() {
        assert_eq!(
            exclude_main_nav_overlap(110.0, 180.0, 144.0, 144.0, 100.0, 100.0, 1600.0, 900.0, 1.5,),
            (-44.0, 180.0),
        );
    }

    #[test]
    fn main_navigation_exclusion_requires_a_visible_non_minimized_main_window() {
        assert!(main_nav_exclusion_active(true, false));
        assert!(!main_nav_exclusion_active(false, false));
        assert!(!main_nav_exclusion_active(true, true));
    }

    #[test]
    fn overlay_outside_the_main_navigation_keeps_its_position() {
        assert_eq!(
            exclude_main_nav_overlap(
                -200.0, 180.0, 144.0, 144.0, 100.0, 100.0, 1600.0, 900.0, 1.0,
            ),
            (-200.0, 180.0),
        );
        assert_eq!(
            exclude_main_nav_overlap(
                110.0, 1100.0, 144.0, 144.0, 100.0, 100.0, 1600.0, 900.0, 1.0,
            ),
            (110.0, 1100.0),
        );
        assert_eq!(
            exclude_main_nav_overlap(500.0, 180.0, 144.0, 144.0, 100.0, 100.0, 1600.0, 900.0, 1.0,),
            (500.0, 180.0),
        );
    }

    #[test]
    fn invalid_scale_factor_uses_one_for_a_safe_navigation_boundary() {
        assert_eq!(
            exclude_main_nav_overlap(
                -1810.0,
                80.0,
                144.0,
                144.0,
                -1920.0,
                0.0,
                1600.0,
                900.0,
                f64::NAN,
            ),
            (-1680.0, 80.0),
        );
    }

    #[test]
    fn preferred_monitor_candidate_does_not_teleport_across_a_seam() {
        let areas = [
            MonitorWorkArea {
                name: Some("left".to_string()),
                x: -1920.0,
                y: 0.0,
                width: 1920.0,
                height: 1080.0,
            },
            MonitorWorkArea {
                name: Some("right".to_string()),
                x: 0.0,
                y: 0.0,
                width: 1920.0,
                height: 1080.0,
            },
        ];

        let selected = select_main_nav_exit_candidate(
            10.0,
            100.0,
            144.0,
            144.0,
            0.0,
            0.0,
            1920.0,
            1080.0,
            1.0,
            &areas,
            Some("right"),
        )
        .expect("right monitor has a valid navigation exit");

        assert_eq!(selected.x, 240.0);
        assert_eq!(selected.y, 100.0);
        assert_eq!(selected.monitor_name.as_deref(), Some("right"));
        assert_ne!(selected.x, -144.0);
    }

    #[test]
    fn candidate_selection_uses_other_monitors_only_as_a_fallback() {
        let areas = [
            MonitorWorkArea {
                name: Some("narrow".to_string()),
                x: 0.0,
                y: 0.0,
                width: 200.0,
                height: 200.0,
            },
            MonitorWorkArea {
                name: Some("left".to_string()),
                x: -1920.0,
                y: 0.0,
                width: 1920.0,
                height: 1080.0,
            },
        ];

        let selected = select_main_nav_exit_candidate(
            10.0,
            10.0,
            144.0,
            144.0,
            0.0,
            0.0,
            200.0,
            200.0,
            1.0,
            &areas,
            Some("narrow"),
        )
        .expect("the adjacent monitor is a valid explicit fallback");

        assert_eq!(selected.x, -144.0);
        assert_eq!(selected.monitor_name.as_deref(), Some("left"));
    }

    #[test]
    fn destination_monitor_identity_overrides_a_stale_observed_monitor() {
        let areas = [
            MonitorWorkArea {
                name: Some("left".to_string()),
                x: -1920.0,
                y: 0.0,
                width: 1920.0,
                height: 1080.0,
            },
            MonitorWorkArea {
                name: Some("right".to_string()),
                x: 0.0,
                y: 0.0,
                width: 1920.0,
                height: 1080.0,
            },
        ];

        assert_eq!(
            final_monitor_name_for_position(&areas, -144.0, 100.0, Some("right".to_string()))
                .as_deref(),
            Some("left"),
        );
        assert_eq!(
            final_monitor_name_for_position(&areas, 240.0, 100.0, Some("left".to_string()))
                .as_deref(),
            Some("right"),
        );
        assert_eq!(
            final_monitor_name_for_position(&areas, 5000.0, 100.0, Some("right".to_string()))
                .as_deref(),
            Some("right"),
        );
    }

    #[test]
    fn nearest_edge_snap_respects_negative_monitor_coordinates() {
        let (x, y) = nearest_edge_position(
            -300.0, 300.0, 144.0, 144.0, -1920.0, 0.0, 1920.0, 1040.0, 8.0,
        );
        assert_eq!(x, -152.0);
        assert_eq!(y, 300.0);
    }

    #[test]
    fn geometry_validation_rejects_non_finite_and_unusable_panel_sizes() {
        let valid = PetGeometryState {
            overlay_x: Some(-1200.0),
            overlay_y: Some(80.0),
            panel_w: Some(PANEL_MIN_W),
            panel_h: Some(PANEL_MIN_H),
            ..PetGeometryState::default()
        };
        assert!(geometry_is_valid(&valid));

        let mut invalid = valid.clone();
        invalid.overlay_x = Some(f64::NAN);
        assert!(!geometry_is_valid(&invalid));

        invalid = valid;
        invalid.panel_w = Some(PANEL_MIN_W - 1.0);
        assert!(!geometry_is_valid(&invalid));
    }

    #[test]
    fn windows_startup_command_is_quoted_and_uses_one_stable_value_name() {
        assert_eq!(PET_AUTOSTART_VALUE_NAME, "VibeSpace");
        assert_eq!(
            windows_startup_command(std::path::Path::new(
                r"C:\\Program Files\\VibeSpace\\VibeSpace.exe"
            )),
            r#""C:\\Program Files\\VibeSpace\\VibeSpace.exe""#
        );
    }

    fn allowed_actions_contains(a: &str) -> bool {
        pet_validate_action(a.to_string()).unwrap_or(false)
    }

    // ----- Named-profile guard + injectable HKCU seam tests (Windows) -----

    #[cfg(target_os = "windows")]
    fn ordinary_guard() -> impl Fn(&'static str) -> Result<(), String> {
        |_effect| Ok(())
    }

    #[cfg(target_os = "windows")]
    fn visual_test_guard() -> impl Fn(&'static str) -> Result<(), String> {
        |effect| {
            Err(format!(
                "privileged effect '{effect}' is disabled by the monochrome-visual-test runtime profile"
            ))
        }
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn ordinary_mode_autostart_read_invokes_seam() {
        install_test_guard(ordinary_guard());
        let sink = install_counting_sink();
        assert_eq!(get_windows_startup_enabled(), Ok(false));
        assert_eq!(sink.count(EFFECT_REGISTRY_READ), 1);
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn ordinary_mode_autostart_enable_invokes_create_and_set_seams() {
        install_test_guard(ordinary_guard());
        let sink = install_counting_sink();
        assert_eq!(set_windows_startup_enabled(true), Ok(true));
        assert_eq!(sink.count(EFFECT_REGISTRY_CREATE), 1);
        assert_eq!(sink.count(EFFECT_REGISTRY_SET), 1);
        assert_eq!(sink.count(EFFECT_REGISTRY_DELETE), 0);
        assert_eq!(get_windows_startup_enabled(), Ok(true));
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn ordinary_mode_autostart_disable_invokes_create_and_delete_seams() {
        install_test_guard(ordinary_guard());
        let sink = install_counting_sink();
        assert_eq!(set_windows_startup_enabled(false), Ok(false));
        assert_eq!(sink.count(EFFECT_REGISTRY_CREATE), 1);
        assert_eq!(sink.count(EFFECT_REGISTRY_DELETE), 1);
        assert_eq!(sink.count(EFFECT_REGISTRY_SET), 0);
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn visual_test_mode_denies_autostart_read_before_hkcu() {
        install_test_guard(visual_test_guard());
        let sink = install_counting_sink();
        let message =
            get_windows_startup_enabled().expect_err("visual-test must deny registry read");
        assert!(message.contains("monochrome-visual-test"));
        assert_eq!(sink.total(), 0);
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn visual_test_mode_denies_autostart_write_before_hkcu() {
        install_test_guard(visual_test_guard());
        let sink = install_counting_sink();
        assert!(set_windows_startup_enabled(true).is_err());
        assert!(set_windows_startup_enabled(false).is_err());
        assert_eq!(sink.total(), 0, "denial must precede every HKCU effect");
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn unknown_profile_fails_closed_before_hkcu() {
        clear_test_guard();
        let sink = install_counting_sink();
        assert!(get_windows_startup_enabled().is_err());
        assert!(set_windows_startup_enabled(true).is_err());
        assert_eq!(sink.total(), 0);
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn real_guard_ordinary_autostart_end_to_end() {
        install_test_guard(|effect| {
            crate::runtime_profile::ensure_privileged_effect_allowed(
                crate::runtime_profile::DENIED_EFFECT_REGISTRY,
                effect,
            )
        });
        let sink = install_counting_sink();
        let _environment = crate::runtime_profile::test_runtime_environment(None, None);
        assert_eq!(set_windows_startup_enabled(true), Ok(true));
        assert_eq!(sink.count(EFFECT_REGISTRY_SET), 1);
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn real_guard_visual_test_autostart_denied_end_to_end() {
        install_test_guard(|effect| {
            crate::runtime_profile::ensure_privileged_effect_allowed(
                crate::runtime_profile::DENIED_EFFECT_REGISTRY,
                effect,
            )
        });
        let sink = install_counting_sink();
        let _environment = crate::runtime_profile::test_runtime_environment(
            Some(std::ffi::OsString::from(
                crate::runtime_profile::MONOCHROME_VISUAL_TEST,
            )),
            None,
        );
        let message = set_windows_startup_enabled(true).expect_err("visual-test must deny");
        assert!(message.contains("monochrome-visual-test"));
        assert_eq!(sink.total(), 0);
    }
}

/// Initialize managed state and restore geometry from disk.
pub fn init_pet_state(app: &AppHandle) -> PetWindowState {
    let geo = load_geometry(app);
    PetWindowState {
        geometry: Mutex::new(geo),
        panel_open: Mutex::new(false),
        overlay_lifecycle: Mutex::new(()),
        panel_lifecycle: Mutex::new(()),
        reconstrain_generation: AtomicU64::new(0),
        overlay_visibility_generation: AtomicU64::new(0),
        panel_visibility_generation: AtomicU64::new(0),
        topmost_watchdog_started: AtomicBool::new(false),
        overlay_native_hwnd: AtomicIsize::new(0),
        panel_native_hwnd: AtomicIsize::new(0),
    }
}

/// Apply close policy for pet windows: hide, never kill sessions.
/// Returns true if this was a pet window and the close was intercepted.
pub fn handle_pet_window_close(window: &tauri::Window) -> bool {
    let label = window.label().to_string();
    if !is_pet_label(&label) {
        return false;
    }
    let _ = window.hide();
    if label == PET_MINI_PANEL_LABEL {
        let app = window.app_handle().clone();
        if let Some(state) = app.try_state::<PetWindowState>() {
            if let Ok(mut open) = state.inner().panel_open.lock() {
                *open = false;
            }
        }
        schedule_pet_overlay_restore(app);
    }
    true
}
