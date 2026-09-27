//! VibeSpace branding assets baked into the binary at compile time.
//!
//! Window icons on Windows can revert to the generic WebView2 placeholder when
//! the HWND is recreated (hang, minimize, tray restore, DPI change). We
//! re-apply the embedded PNG mark immediately, on a short deferred schedule,
//! on focus/resize, from the frontend on visibility, and via a light watchdog.

#[cfg(windows)]
#[path = "branding_windows.rs"]
mod branding_windows;

use std::sync::atomic::{AtomicU64, Ordering};

use tauri::{AppHandle, Manager, Window};

static DEFERRED_REFRESH_GENERATION: AtomicU64 = AtomicU64::new(0);

/// Tray id used in `lib.rs` — must stay in sync.
pub const TRAY_ICON_ID: &str = "vibespace-tray";

/// Windows shell identity. Keep it separate from the historical Tauri identifier
/// because an older Jarvis installation also owns `ai.jarvis.desktop` shortcuts.
pub const WINDOWS_APP_USER_MODEL_ID: &str = "ai.vibespace.desktop";

fn load_window_icon() -> tauri::image::Image<'static> {
    // PNG decodes reliably at runtime. `icon.ico` via `from_bytes` only keeps the
    // first ICO frame and can look wrong on the taskbar; the `.exe` still embeds
    // the full multi-size ICO for Start menu / shortcuts at build time.
    tauri::image::Image::from_bytes(include_bytes!("../icons/32x32.png"))
        .or_else(|_| tauri::image::Image::from_bytes(include_bytes!("../icons/64x64.png")))
        .or_else(|_| tauri::image::Image::from_bytes(include_bytes!("../icons/128x128.png")))
        .or_else(|_| tauri::image::Image::from_bytes(include_bytes!("../icons/128x128@2x.png")))
        .expect("VibeSpace window icon bytes missing — run `npm run icons:generate`")
}

fn load_tray_icon() -> tauri::image::Image<'static> {
    load_window_icon()
}

fn should_apply_tauri_window_icon() -> bool {
    !cfg!(windows)
}

/// Platform hooks before `tauri::Builder` runs (Windows AppUserModelID).
pub fn init_platform_branding() {
    #[cfg(windows)]
    branding_windows::init_process_branding();
}

fn apply_window_icon_sync(window: &Window) {
    if should_apply_tauri_window_icon() {
        if let Err(err) = window.set_icon(load_window_icon()) {
            eprintln!("[branding] failed to set window icon: {err}");
        }
    }
    // Windows already receives the embedded executable icon. Do not call the
    // synchronous Tauri HWND getter from this event-loop callback: Wry routes
    // that getter back through the same event loop and can deadlock all IPC.
}

fn refresh_tray_icon(app: &AppHandle) {
    if let Some(tray) = app.tray_by_id(TRAY_ICON_ID) {
        if let Err(err) = tray.set_icon(Some(load_tray_icon())) {
            eprintln!("[branding] failed to refresh tray icon: {err}");
        }
    }
}

#[cfg(not(windows))]
fn apply_app_branding_sync(app: &AppHandle) {
    if let Some(window) = app.get_window("main") {
        apply_window_icon_sync(&window);
    }
    refresh_tray_icon(app);
}

#[cfg(windows)]
fn apply_app_branding_sync(_app: &AppHandle) {
    // Fail-safe: both Window and TrayIcon mutations are Tauri event-loop
    // operations. Re-entering them from this event-loop callback can block the
    // callback forever. Windows keeps its embedded executable and initial tray
    // icons, so periodic runtime refresh is safely redundant.
}

fn run_branding_on_main_thread(app: &AppHandle) {
    let app = app.clone();
    let app_for_main = app.clone();
    if let Err(err) = app.run_on_main_thread(move || apply_app_branding_sync(&app_for_main)) {
        eprintln!("[branding] failed to schedule branding refresh: {err}");
    }
}

/// Apply the embedded icon to a single window (no-op on failure).
pub fn apply_window_icon(window: &Window) {
    let app = window.app_handle();
    run_branding_on_main_thread(&app);
    schedule_deferred_icon_refresh(&app);
}

/// Re-apply on a staggered schedule so we win races against WebView2 HWND swaps.
fn schedule_deferred_icon_refresh(app: &AppHandle) {
    let app = app.clone();
    let generation = DEFERRED_REFRESH_GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
    std::thread::spawn(move || {
        for delay_ms in [40u64, 120, 400, 1_200, 3_000] {
            std::thread::sleep(std::time::Duration::from_millis(delay_ms));
            if DEFERRED_REFRESH_GENERATION.load(Ordering::SeqCst) != generation {
                return;
            }
            run_branding_on_main_thread(&app);
        }
    });
}

/// Refresh the main window taskbar icon from embedded bytes.
pub fn apply_app_branding(app: &AppHandle) {
    run_branding_on_main_thread(app);
}

pub fn build_tray_icon() -> tauri::image::Image<'static> {
    load_tray_icon()
}

/// Windows: periodic refresh while running (cheap insurance after explorer restarts).
#[cfg(windows)]
pub fn start_windows_icon_watchdog(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || loop {
        std::thread::sleep(std::time::Duration::from_secs(3));
        run_branding_on_main_thread(&app);
    });
}

#[cfg(not(windows))]
pub fn start_windows_icon_watchdog(_app: &AppHandle) {}

#[cfg(test)]
mod tests {
    use super::{should_apply_tauri_window_icon, WINDOWS_APP_USER_MODEL_ID};

    #[test]
    fn windows_shell_identity_does_not_collide_with_legacy_jarvis() {
        assert_eq!(WINDOWS_APP_USER_MODEL_ID, "ai.vibespace.desktop");
    }

    #[test]
    fn windows_refreshes_do_not_allocate_new_tauri_icons() {
        assert_eq!(should_apply_tauri_window_icon(), !cfg!(windows));
    }

    #[test]
    fn windows_runtime_branding_does_not_reenter_the_tauri_hwnd_getter() {
        let source = include_str!("branding.rs");
        let helper_start = source
            .find("fn apply_window_icon_sync")
            .expect("window icon helper exists");
        let helper_end = source[helper_start..]
            .find("fn refresh_tray_icon")
            .map(|offset| helper_start + offset)
            .expect("window icon helper is bounded");
        let helper = &source[helper_start..helper_end];
        assert!(!helper.contains("branding_windows::apply_hwnd_icons"));
        assert!(!helper.contains("window.hwnd()"));

        let windows_refresh_start = source
            .find("#[cfg(windows)]\nfn apply_app_branding_sync")
            .expect("Windows runtime branding fail-safe exists");
        let windows_refresh_end = source[windows_refresh_start..]
            .find("fn run_branding_on_main_thread")
            .map(|offset| windows_refresh_start + offset)
            .expect("Windows runtime branding fail-safe is bounded");
        let windows_refresh = &source[windows_refresh_start..windows_refresh_end];
        assert!(!windows_refresh.contains("refresh_tray_icon("));
        assert!(!windows_refresh.contains("apply_window_icon_sync("));
    }
}
