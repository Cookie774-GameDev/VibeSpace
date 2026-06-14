//! VibeSpace branding assets baked into the binary at compile time.
//!
//! Window icons on Windows can briefly revert to the OS placeholder when the
//! WebView2 surface hangs or the HWND is recreated. Re-applying the embedded
//! icon on show/focus keeps the taskbar mark consistent.
//!
//! On Windows the taskbar/pinned shortcut reads from the same `icon.ico` that
//! ships inside the `.exe`. Tray and window icons are kept in sync with that
//! bundle so users never see the old purple mark in one place and orange in another.

use tauri::{AppHandle, Manager, WebviewWindow};

fn load_window_icon() -> tauri::image::Image<'static> {
    // Match the embedded EXE icon on Windows (taskbar, Alt+Tab, Start menu).
    #[cfg(windows)]
    {
        if let Ok(icon) = tauri::image::Image::from_bytes(include_bytes!("../icons/icon.ico")) {
            return icon;
        }
    }

    tauri::image::Image::from_bytes(include_bytes!("../icons/128x128@2x.png"))
        .or_else(|_| tauri::image::Image::from_bytes(include_bytes!("../icons/128x128.png")))
        .or_else(|_| tauri::image::Image::from_bytes(include_bytes!("../icons/64x64.png")))
        .or_else(|_| tauri::image::Image::from_bytes(include_bytes!("../icons/32x32.png")))
        .expect("VibeSpace window icon bytes missing — run `npm run icons:generate`")
}

fn load_tray_icon() -> tauri::image::Image<'static> {
    // Keep tray identical to the EXE / Start-menu icon on Windows.
    #[cfg(windows)]
    {
        if let Ok(icon) = tauri::image::Image::from_bytes(include_bytes!("../icons/icon.ico")) {
            return icon;
        }
    }

    tauri::image::Image::from_bytes(include_bytes!("../icons/32x32.png"))
        .unwrap_or_else(|_| load_window_icon())
}

/// Apply the embedded icon to a single window (no-op on failure).
pub fn apply_window_icon(window: &WebviewWindow) {
    if let Err(err) = window.set_icon(load_window_icon()) {
        eprintln!("[branding] failed to set window icon: {err}");
    }
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
