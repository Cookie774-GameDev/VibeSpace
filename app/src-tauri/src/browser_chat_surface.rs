//! Browser Chat provider surfaces managed by native window APIs.
//!
//! The remote provider origin never receives VibeSpace capability authority:
//! every command verifies that the invoking webview is the local `main` view,
//! and provider URLs are selected from this fixed registry rather than supplied
//! by renderer input.

use std::collections::HashSet;
use std::sync::{LazyLock, Mutex};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

const PROVIDER_LABELS: [&str; 3] = [
    "browser-chat-chatgpt",
    "browser-chat-claude",
    "browser-chat-gemini",
];
static IN_FLIGHT: LazyLock<Mutex<HashSet<&'static str>>> =
    LazyLock::new(|| Mutex::new(HashSet::new()));

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserChatBounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserChatSurfaceStatus {
    pub provider_id: String,
    pub created: bool,
}

struct ProviderConfig {
    id: &'static str,
    label: &'static str,
    url: url::Url,
}

fn provider_config(provider_id: &str) -> Result<ProviderConfig, String> {
    let (id, label, url) = match provider_id {
        "chatgpt" => ("chatgpt", "browser-chat-chatgpt", "https://chatgpt.com/"),
        "claude" => ("claude", "browser-chat-claude", "https://claude.ai/new"),
        "gemini" => (
            "gemini",
            "browser-chat-gemini",
            "https://gemini.google.com/",
        ),
        _ => return Err("browser_chat_provider_not_allowed".to_string()),
    };
    Ok(ProviderConfig {
        id,
        label,
        url: url
            .parse()
            .map_err(|_| "browser_chat_provider_url_invalid".to_string())?,
    })
}

fn ensure_main_caller(label: &str) -> Result<(), String> {
    if label == "main" {
        Ok(())
    } else {
        Err("browser_chat_caller_not_authorized".to_string())
    }
}

fn validate_bounds(bounds: &BrowserChatBounds) -> Result<(), String> {
    if bounds.x.is_finite()
        && bounds.y.is_finite()
        && bounds.width.is_finite()
        && bounds.height.is_finite()
        && bounds.width >= 1.0
        && bounds.height >= 1.0
    {
        Ok(())
    } else {
        Err("browser_chat_bounds_invalid".to_string())
    }
}

fn absolute_bounds(
    main: &WebviewWindow,
    bounds: &BrowserChatBounds,
) -> Result<(tauri::PhysicalPosition<i32>, tauri::PhysicalSize<u32>), String> {
    validate_bounds(bounds)?;
    let scale = main
        .scale_factor()
        .map_err(|error| format!("browser_chat_scale_failed:{error}"))?;
    let origin = main
        .inner_position()
        .map_err(|error| format!("browser_chat_position_failed:{error}"))?;
    Ok((
        tauri::PhysicalPosition::new(
            origin.x + (bounds.x * scale).round() as i32,
            origin.y + (bounds.y * scale).round() as i32,
        ),
        tauri::PhysicalSize::new(
            (bounds.width * scale).round().max(1.0) as u32,
            (bounds.height * scale).round().max(1.0) as u32,
        ),
    ))
}

fn apply_bounds(
    provider: &tauri::Window,
    main: &WebviewWindow,
    bounds: &BrowserChatBounds,
) -> Result<(), String> {
    let (position, size) = absolute_bounds(main, bounds)?;
    provider
        .set_position(position)
        .map_err(|error| format!("browser_chat_position_failed:{error}"))?;
    provider
        .set_size(size)
        .map_err(|error| format!("browser_chat_size_failed:{error}"))
}

fn hide_other_providers(app: &AppHandle, selected: Option<&str>) {
    for label in PROVIDER_LABELS {
        if Some(label) != selected {
            if let Some(window) = app.get_window(label) {
                let _ = window.hide();
            }
        }
    }
}

fn should_activate_provider(is_visible: bool) -> bool {
    !is_visible
}

fn open_provider(
    app: AppHandle,
    caller: WebviewWindow,
    provider: ProviderConfig,
    bounds: BrowserChatBounds,
) -> Result<(), String> {
    hide_other_providers(&app, Some(provider.label));

    if let Some(existing) = app.get_window(provider.label) {
        apply_bounds(&existing, &caller, &bounds)?;
        let is_visible = existing
            .is_visible()
            .map_err(|error| format!("browser_chat_visibility_failed:{error}"))?;
        if should_activate_provider(is_visible) {
            existing
                .show()
                .map_err(|error| format!("browser_chat_show_failed:{error}"))?;
            existing
                .set_focus()
                .map_err(|error| format!("browser_chat_focus_failed:{error}"))?;
        }
        return Ok(());
    }

    let (position, size) = absolute_bounds(&caller, &bounds)?;
    let profile_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("browser_chat_profile_failed:{error}"))?
        .join("browser-chat")
        .join(provider.id);
    std::fs::create_dir_all(&profile_dir)
        .map_err(|error| format!("browser_chat_profile_failed:{error}"))?;

    let builder =
        WebviewWindowBuilder::new(&app, provider.label, WebviewUrl::External(provider.url))
            .title("VibeSpace Browser Chat")
            .data_directory(profile_dir)
            .decorations(false)
            .resizable(false)
            .maximizable(false)
            .minimizable(false)
            .skip_taskbar(true)
            .always_on_top(false)
            .focused(false)
            .visible(false)
            .inner_size(size.width as f64, size.height as f64)
            .position(position.x as f64, position.y as f64);

    #[cfg(windows)]
    let builder = builder
        .owner(&caller)
        .map_err(|error| format!("browser_chat_owner_failed:{error}"))?;

    let created = builder
        .build()
        .map_err(|error| format!("browser_chat_create_failed:{error}"))?;
    let native_window = app
        .get_window(created.label())
        .ok_or_else(|| "browser_chat_window_missing".to_string())?;
    apply_bounds(&native_window, &caller, &bounds)?;
    native_window
        .show()
        .map_err(|error| format!("browser_chat_show_failed:{error}"))?;
    native_window
        .set_focus()
        .map_err(|error| format!("browser_chat_focus_failed:{error}"))?;

    Ok(())
}

#[tauri::command]
pub fn browser_chat_surface_open(
    app: AppHandle,
    caller: WebviewWindow,
    provider_id: String,
    bounds: BrowserChatBounds,
) -> Result<BrowserChatSurfaceStatus, String> {
    ensure_main_caller(caller.label())?;
    validate_bounds(&bounds)?;
    let provider = provider_config(&provider_id)?;
    let created = app.get_window(provider.label).is_none();

    {
        let mut in_flight = IN_FLIGHT
            .lock()
            .map_err(|_| "browser_chat_state_unavailable".to_string())?;
        if !in_flight.insert(provider.id) {
            return Ok(BrowserChatSurfaceStatus {
                provider_id: provider.id.to_string(),
                created,
            });
        }
    }

    let provider_id_for_cleanup = provider.id;
    std::thread::spawn(move || {
        if let Err(error) = open_provider(app, caller, provider, bounds) {
            eprintln!("[browser-chat] provider surface failed: {error}");
        }
        if let Ok(mut in_flight) = IN_FLIGHT.lock() {
            in_flight.remove(provider_id_for_cleanup);
        }
    });

    Ok(BrowserChatSurfaceStatus {
        provider_id,
        created,
    })
}

#[tauri::command]
pub fn browser_chat_surface_hide_all(app: AppHandle, caller: WebviewWindow) -> Result<(), String> {
    ensure_main_caller(caller.label())?;
    std::thread::spawn(move || hide_other_providers(&app, None));
    Ok(())
}

#[tauri::command]
pub fn browser_chat_surface_hide(
    app: AppHandle,
    caller: WebviewWindow,
    provider_id: String,
) -> Result<(), String> {
    ensure_main_caller(caller.label())?;
    let provider = provider_config(&provider_id)?;
    std::thread::spawn(move || {
        if let Some(window) = app.get_window(provider.label) {
            if let Err(error) = window.hide() {
                eprintln!("[browser-chat] provider hide failed: {error}");
            }
        }
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_only_registry_owned_provider_ids() {
        let chatgpt = provider_config("chatgpt").expect("ChatGPT is registry-owned");
        assert_eq!(chatgpt.label, "browser-chat-chatgpt");
        assert_eq!(chatgpt.url.as_str(), "https://chatgpt.com/");
        assert!(provider_config("https://attacker.example").is_err());
        assert!(provider_config("../chatgpt").is_err());
    }

    #[test]
    fn rejects_non_main_callers_and_invalid_bounds() {
        assert!(ensure_main_caller("main").is_ok());
        assert!(ensure_main_caller("browser-chat-chatgpt").is_err());
        assert!(validate_bounds(&BrowserChatBounds {
            x: 10.0,
            y: 20.0,
            width: 800.0,
            height: 600.0,
        })
        .is_ok());
        assert!(validate_bounds(&BrowserChatBounds {
            x: f64::NAN,
            y: 0.0,
            width: 0.0,
            height: 600.0,
        })
        .is_err());
    }

    #[test]
    fn visible_provider_does_not_need_reactivation_for_geometry_updates() {
        assert!(!should_activate_provider(true));
        assert!(should_activate_provider(false));
    }
}
