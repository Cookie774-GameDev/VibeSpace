//! Windows HWND / taskbar icon pinning and process AppUserModelID.
//!
//! Tauri's `window.set_icon` maps to Tao's `set_window_icon` (ICON_SMALL only).
//! The taskbar on Windows 10/11 uses ICON_BIG — without it, WebView2 HWND swaps
//! and "Not Responding" states show the generic document icon.

use super::TAURI_APP_IDENTIFIER;
use tauri::WebviewWindow;
use windows::Win32::{
    Foundation::{HWND, LPARAM, WPARAM},
    System::LibraryLoader::GetModuleHandleW,
    UI::Shell::SetCurrentProcessExplicitAppUserModelID,
    UI::WindowsAndMessaging::{
        LoadImageW, SendMessageW, ICON_BIG, ICON_SMALL, IMAGE_ICON, LR_DEFAULTSIZE, WM_SETICON,
    },
};
use windows::core::PCWSTR;
use windows::Win32::Foundation::HANDLE;


/// `icons/icon.ico` embedded by tauri-build / winres (`set_icon_with_id(..., "32512")`).
const EXE_ICON_RESOURCE_ID: u16 = 32512;

fn encode_wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(std::iter::once(0)).collect()
}

/// Call once at process start, before any window is created.
pub fn init_process_branding() {
    let wide = encode_wide(TAURI_APP_IDENTIFIER);
    if let Err(err) = unsafe { SetCurrentProcessExplicitAppUserModelID(PCWSTR::from_raw(wide.as_ptr())) } {
        eprintln!("[branding] SetCurrentProcessExplicitAppUserModelID failed: {err}");
    }
}

fn load_resource_icon(width: i32, height: i32) -> Option<HANDLE> {
    unsafe {
        let instance = GetModuleHandleW(None).ok()?;
        let resource = PCWSTR::from_raw(EXE_ICON_RESOURCE_ID as usize as *const u16);
        let flags = if width == 0 && height == 0 {
            LR_DEFAULTSIZE
        } else {
            Default::default()
        };
        LoadImageW(
            Some(instance.into()),
            resource,
            IMAGE_ICON,
            width,
            height,
            flags,
        )
        .ok()
    }
}

fn set_hwnd_icon(hwnd: HWND, icon_type: usize, width: i32, height: i32) {
    let Some(handle) = load_resource_icon(width, height) else {
        return;
    };
    unsafe {
        let _ = SendMessageW(
            hwnd,
            WM_SETICON,
            Some(WPARAM(icon_type)),
            Some(LPARAM(handle.0 as isize)),
        );
    }
}

/// Pin both ICON_SMALL (title bar) and ICON_BIG (taskbar) from the embedded `.exe` ICO.
pub fn apply_hwnd_icons(window: &WebviewWindow) {
    let Ok(hwnd) = window.hwnd() else {
        return;
    };
    let hwnd = HWND(hwnd.0 as *mut _);
    // Win11 taskbar prefers a large layer; 256px avoids silent fallback to the generic icon.
    set_hwnd_icon(hwnd, ICON_BIG as usize, 256, 256);
    set_hwnd_icon(hwnd, ICON_SMALL as usize, 32, 32);
    // Default-size pass catches DPI / explorer restarts when explicit sizes miss a layer.
    set_hwnd_icon(hwnd, ICON_BIG as usize, 0, 0);
}
