//! Jarvis desktop shell – Tauri 2 Rust core.
//!
//! Architecture (see docs/02-system-architecture.md §2.1):
//!
//! ```text
//!  ┌───────────────────────── Tauri main (this crate) ─────────────────────────┐
//!  │   • Window + tray + native notifications                                  │
//!  │   • Global hotkeys, deep links, mic permissions                           │
//!  │   • IPC broker between WebView, Node runtime, and Python voice sidecar    │
//!  └─────────────────────────────────────────────────────────────────────────-─┘
//!         │                              │                              │
//!  ┌──────▼───────┐                ┌─────▼──────┐                ┌──────▼──────┐
//!  │  WebView     │                │  Node      │                │  Python     │
//!  │  (Vite + R)  │  Tauri cmd     │  runtime   │  stdin/stdout  │  voice      │
//!  │              │ ◀─────────────▶│  (Mastra)  │ ◀────────────▶│  (Pipecat)  │
//!  └──────────────┘                └────────────┘                └─────────────┘
//! ```
//!
//! ## V1 plugins registered
//! - `tauri-plugin-notification`  – OS native banners (todo reminders, errors)
//! - `tauri-plugin-dialog`        – open/save/message dialogs
//! - `tauri-plugin-shell`         – `shell.open` for opening URLs in the OS browser
//! - `tauri-plugin-os`            – platform/arch detection for the runtime
//! - `tauri-plugin-http`          – native HTTP client used by the Ollama bridge
//!                                  to bypass `tauri://localhost` CORS that
//!                                  blocks `fetch` to `http://localhost:11434`
//!                                  in packaged builds.
//! - `tauri-plugin-process`       – relaunch after updater installation
//! - `tauri-plugin-updater`       – signed auto-update channel
//!
//! ## Plugins to wire up as features land
//! - `tauri-plugin-global-shortcut` – cmd-space style global hotkeys
//! - `tauri-plugin-fs`              – scoped reads/writes to ~/.jarvis
//! - `tauri-plugin-store`           – persistent JSON preferences
//! - `tauri-plugin-window-state`    – remember window size + position
//! - `tauri-plugin-single-instance` – one Jarvis per user account
//! - `tauri-plugin-deep-link`       – `jarvis://` URL handler
//!
//! New commands should be small and pure; heavy logic belongs in the Node
//! runtime sidecar so we keep the Rust core boring and stable.

use tauri::Manager;

mod fsread;
mod terminal;

/// Sanity-check command. The JS bridge can call this during startup to verify
/// invoke() round-trips. Wire it in as needed; it returns a friendly string.
#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello {name}, this is Jarvis.")
}

/// Returns the running app version string (matches Cargo.toml package version).
/// Useful when the JS bridge prefers a single command rather than touching the
/// `@tauri-apps/api/app` getVersion API.
#[tauri::command]
fn app_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

/// Runs the Tauri app. Re-exposed under `#[mobile_entry_point]` so the same
/// crate works for future iOS / Android builds via `npx tauri ios|android`.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            println!("[single-instance] Reusing existing Jarvis service instance");
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(terminal::TerminalState::default())
        .setup(|app| {
            let tray_menu = tauri::menu::Menu::with_items(
                app,
                &[
                    &tauri::menu::MenuItem::with_id(app, "show", "Show Jarvis One", true, None::<&str>).unwrap(),
                    &tauri::menu::MenuItem::with_id(app, "exit", "Exit", true, None::<&str>).unwrap(),
                ],
            )?;

            let icon_bytes = include_bytes!("../icons/32x32.png");
            let icon = tauri::image::Image::from_bytes(icon_bytes).unwrap_or_else(|_| {
                app.default_window_icon().cloned().expect("Failed to load default window icon")
            });

            let _tray = tauri::tray::TrayIconBuilder::new()
                .icon(icon)
                .menu(&tray_menu)
                .on_menu_event(|app, event| {
                    match event.id.as_ref() {
                        "show" => {
                            if let Some(window) = app.get_webview_window("main") {
                                let _ = window.show();
                                let _ = window.set_focus();
                            }
                        }
                        "exit" => {
                            std::process::exit(0);
                        }
                        _ => {}
                    }
                })
                .build(app)?;

            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let _ = window.hide();
                api.prevent_close();
            }
        })
        .invoke_handler(tauri::generate_handler![
            greet,
            app_version,
            fsread::fs_create_text_file,
            fsread::fs_list_dir,
            fsread::fs_read_text,
            fsread::fs_write_text,
            terminal::terminal_spawn,
            terminal::terminal_write,
            terminal::terminal_resize,
            terminal::terminal_kill,
            terminal::terminal_move,
            terminal::terminal_list,
            terminal::terminal_reconcile,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app_handle, _event| {});
}
