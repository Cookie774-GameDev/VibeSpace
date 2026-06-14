//! VibeSpace branding assets baked into the binary at compile time.
//!
//! Window icons on Windows can revert to the generic WebView2 placeholder when
//! the HWND is recreated (hang, minimize, tray restore, DPI change). We
//! re-apply the embedded PNG mark immediately, on a short deferred schedule,
//! on focus/resize, from the frontend on visibility, and via a light watchdog.

use std::sync::atomic::{AtomicU64, Ordering};

use tauri::{AppHandle, Manager, WebviewWindow};

static DEFERRED_REFRESH_GENERATION: AtomicU64 = AtomicU64::new(0);

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

fn apply_window_icon_once(window: &WebviewWindow) {
    if let Err(err) = window.set_icon(load_window_icon()) {
        eprintln!("[branding] failed to set window icon: {err}");
    }
}

/// Re-apply on a staggered schedule so we win races against WebView2 HWND swaps.
fn schedule_deferred_icon_refresh(window: &WebviewWindow) {
    let window = window.clone();
    let generation = DEFERRED_REFRESH_GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
    std::thread::spawn(move || {
        for delay_ms in [40u64, 120, 400, 1_200] {
            std::thread::sleep(std::time::Duration::from_millis(delay_ms));
            if DEFERRED_REFRESH_GENERATION.load(Ordering::SeqCst) != generation {
                return;
            }
            apply_window_icon_once(&window);
        }
    });
}

/// Apply the embedded icon to a single window (no-op on failure).
pub fn apply_window_icon(window: &WebviewWindow) {
    apply_window_icon_once(window);
    schedule_deferred_icon_refresh(window);
}

/// Refresh the main window taskbar icon from embedded bytes.
pub fn apply_app_branding(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        apply_window_icon(&window);
    }
}

pub fn build_tray_icon() -> tauri::image::Image<'static> {
    load_tray_icon()
}

/// Windows: periodic refresh while the main window is visible (cheap insurance).
#[cfg(windows)]
pub fn start_windows_icon_watchdog(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || {
        loop {
            std::thread::sleep(std::time::Duration::from_secs(3));
            let Some(window) = app.get_webview_window("main") else {
                continue;
            };
            let visible = window.is_visible().unwrap_or(false);
            let focused = window.is_focused().unwrap_or(false);
            if visible || focused {
                apply_window_icon_once(&window);
            }
        }
    });
}

#[cfg(not(windows))]
pub fn start_windows_icon_watchdog(_app: &AppHandle) {}
