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
//!
//! ## Plugins to wire up as features land
//! - `tauri-plugin-global-shortcut` – cmd-space style global hotkeys
//! - `tauri-plugin-fs`              – scoped reads/writes to ~/.jarvis
//! - `tauri-plugin-store`           – persistent JSON preferences
//! - `tauri-plugin-window-state`    – remember window size + position
//! - `tauri-plugin-single-instance` – one Jarvis per user account
//! - `tauri-plugin-process`         – relaunch / exit
//! - `tauri-plugin-updater`         – auto-update channel
//! - `tauri-plugin-deep-link`       – `jarvis://` URL handler
//!
//! New commands should be small and pure; heavy logic belongs in the Node
//! runtime sidecar so we keep the Rust core boring and stable.

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
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .invoke_handler(tauri::generate_handler![greet, app_version])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
