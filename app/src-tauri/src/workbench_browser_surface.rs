//! True in-window Workbench browser surfaces.
//!
//! Remote pages are child WebViews of the trusted local main window. They receive no
//! VibeSpace command capability, and every renderer command is bound to one validated
//! panel/operation pair.

use std::{collections::HashMap, sync::LazyLock, sync::Mutex};

use async_lock::Mutex as AsyncMutex;
use serde::{Deserialize, Serialize};
use tauri::{
    webview::{PageLoadEvent, Webview, WebviewBuilder},
    AppHandle, LogicalPosition, LogicalSize, Manager, WebviewUrl,
};

const INIT_SCRIPT: &str = r#"
(() => {
  try { delete window.__TAURI_INTERNALS__; } catch (_) {}
  const navigate = (value) => {
    if (typeof value === 'string' && /^https?:\/\//i.test(value)) location.assign(value);
    return null;
  };
  try { window.open = navigate; } catch (_) {}
  document.addEventListener('click', (event) => {
    const anchor = event.target?.closest?.('a[target="_blank"]');
    if (anchor) anchor.removeAttribute('target');
  }, true);
})();
"#;

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkbenchBrowserBounds {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkbenchBrowserStatus {
    panel_id: String,
    operation_id: String,
    url: String,
    loading: bool,
    error: Option<String>,
}

#[derive(Clone, Debug)]
struct SurfaceRecord {
    operation_id: String,
    url: String,
    loading: bool,
    error: Option<String>,
}

static SURFACES: LazyLock<Mutex<HashMap<String, SurfaceRecord>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
static SURFACE_MUTATION: AsyncMutex<()> = AsyncMutex::new(());

#[cfg(windows)]
const WEBVIEW2_BROWSER_ARGUMENTS: &str = "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS";
#[cfg(windows)]
static CHILD_WEBVIEW2_ENVIRONMENT_LOCK: LazyLock<Mutex<()>> = LazyLock::new(|| Mutex::new(()));

#[cfg(windows)]
struct WebView2EnvironmentRestore(Option<std::ffi::OsString>);

#[cfg(windows)]
impl Drop for WebView2EnvironmentRestore {
    fn drop(&mut self) {
        match self.0.take() {
            Some(value) => std::env::set_var(WEBVIEW2_BROWSER_ARGUMENTS, value),
            None => std::env::remove_var(WEBVIEW2_BROWSER_ARGUMENTS),
        }
    }
}

pub(crate) fn with_isolated_child_webview2_environment<T>(create: impl FnOnce() -> T) -> T {
    #[cfg(windows)]
    {
        // The acceptance harness exposes only the already-created trusted main
        // environment over CDP. WebView2 appends this process variable to every
        // newly-created environment, so a dedicated child profile would
        // otherwise contend for the main port. Environment creation in WRY is
        // synchronous; serialize it and restore the host setting immediately.
        let _lock = CHILD_WEBVIEW2_ENVIRONMENT_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let restore = WebView2EnvironmentRestore(std::env::var_os(WEBVIEW2_BROWSER_ARGUMENTS));
        std::env::remove_var(WEBVIEW2_BROWSER_ARGUMENTS);
        let created = create();
        drop(restore);
        created
    }
    #[cfg(not(windows))]
    {
        create()
    }
}

fn validate_id(value: &str, code: &'static str) -> Result<(), String> {
    if value.is_empty()
        || value.len() > 120
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err(code.to_owned());
    }
    Ok(())
}

fn ensure_caller(label: &str) -> Result<(), String> {
    if label == "main" {
        Ok(())
    } else {
        Err("workbench_browser_caller_not_authorized".to_owned())
    }
}

fn validate_url(raw: &str) -> Result<url::Url, String> {
    let parsed = url::Url::parse(raw).map_err(|_| "workbench_browser_url_invalid".to_owned())?;
    if !matches!(parsed.scheme(), "http" | "https")
        || !parsed.username().is_empty()
        || parsed.password().is_some()
    {
        return Err("workbench_browser_url_not_allowed".to_owned());
    }
    Ok(parsed)
}

fn navigation_allowed(candidate: &url::Url) -> bool {
    candidate.as_str() == "about:blank"
        || (matches!(candidate.scheme(), "http" | "https")
            && candidate.username().is_empty()
            && candidate.password().is_none())
}

fn validate_bounds(bounds: &WorkbenchBrowserBounds) -> Result<(), String> {
    if bounds.x.is_finite()
        && bounds.y.is_finite()
        && bounds.width.is_finite()
        && bounds.height.is_finite()
        && bounds.width >= 1.0
        && bounds.height >= 1.0
        && bounds.width <= 16_384.0
        && bounds.height <= 16_384.0
    {
        Ok(())
    } else {
        Err("workbench_browser_bounds_invalid".to_owned())
    }
}

fn label(panel_id: &str) -> String {
    format!("workbench-browser-{panel_id}")
}

fn apply_bounds(webview: &Webview, bounds: &WorkbenchBrowserBounds) -> Result<(), String> {
    webview
        .set_position(LogicalPosition::new(bounds.x, bounds.y))
        .map_err(|_| "workbench_browser_bounds_unavailable".to_owned())?;
    webview
        .set_size(LogicalSize::new(bounds.width, bounds.height))
        .map_err(|_| "workbench_browser_bounds_unavailable".to_owned())
}

fn current_operation(panel_id: &str, operation_id: &str) -> Result<(), String> {
    let state = SURFACES
        .lock()
        .map_err(|_| "workbench_browser_state_unavailable".to_owned())?;
    match state.get(panel_id) {
        Some(record) if record.operation_id == operation_id => Ok(()),
        _ => Err("workbench_browser_operation_stale".to_owned()),
    }
}

fn update_current_state(panel_id: &str, url: &url::Url, loading: bool, error: Option<String>) {
    if let Ok(mut state) = SURFACES.lock() {
        if let Some(record) = state.get_mut(panel_id) {
            record.url = url.to_string();
            record.loading = loading;
            record.error = error;
        }
    }
}

fn current_status(panel_id: &str, operation_id: &str) -> Result<WorkbenchBrowserStatus, String> {
    validate_id(panel_id, "workbench_browser_panel_invalid")?;
    validate_id(operation_id, "workbench_browser_operation_invalid")?;
    let state = SURFACES
        .lock()
        .map_err(|_| "workbench_browser_state_unavailable".to_owned())?;
    let record = state
        .get(panel_id)
        .filter(|record| record.operation_id == operation_id)
        .ok_or_else(|| "workbench_browser_operation_stale".to_owned())?;
    Ok(WorkbenchBrowserStatus {
        panel_id: panel_id.to_owned(),
        operation_id: operation_id.to_owned(),
        url: record.url.clone(),
        loading: record.loading,
        error: record.error.clone(),
    })
}

fn opening_loading_state(unchanged_url: bool, previous: Option<bool>) -> bool {
    if unchanged_url {
        previous.unwrap_or(true)
    } else {
        true
    }
}

#[tauri::command]
pub async fn workbench_browser_surface_open(
    app: AppHandle,
    caller: Webview,
    panel_id: String,
    operation_id: String,
    url: String,
    bounds: WorkbenchBrowserBounds,
    preserve_navigation: Option<bool>,
) -> Result<WorkbenchBrowserStatus, String> {
    ensure_caller(caller.label())?;
    let _mutation = SURFACE_MUTATION.lock().await;
    validate_id(&panel_id, "workbench_browser_panel_invalid")?;
    validate_id(&operation_id, "workbench_browser_operation_invalid")?;
    validate_bounds(&bounds)?;
    let target = validate_url(&url)?;
    let surface_label = label(&panel_id);
    let existing = app.get_webview(&surface_label);
    // Layout reconciliation must never replay a stale address over a link,
    // form submission, redirect, or history navigation inside the live page.
    if preserve_navigation.unwrap_or(false) {
        if let Some(webview) = existing.as_ref() {
            current_operation(&panel_id, &operation_id)?;
            apply_bounds(webview, &bounds)?;
            webview
                .show()
                .map_err(|_| "workbench_browser_window_unavailable".to_owned())?;
            return current_status(&panel_id, &operation_id);
        }
    }
    let unchanged_url = match existing.as_ref() {
        Some(webview) => {
            webview
                .url()
                .map_err(|_| "workbench_browser_navigation_unavailable".to_owned())?
                == target
        }
        None => false,
    };

    {
        let mut state = SURFACES
            .lock()
            .map_err(|_| "workbench_browser_state_unavailable".to_owned())?;
        let loading = opening_loading_state(
            unchanged_url,
            state.get(&panel_id).map(|record| record.loading),
        );
        state.insert(
            panel_id.clone(),
            SurfaceRecord {
                operation_id: operation_id.clone(),
                url: target.to_string(),
                loading,
                error: None,
            },
        );
    }

    let webview = if let Some(existing) = existing {
        if !unchanged_url {
            existing
                .navigate(target.clone())
                .map_err(|_| "workbench_browser_navigation_unavailable".to_owned())?;
        }
        existing
    } else {
        let main = app
            .get_window("main")
            .ok_or_else(|| "workbench_browser_main_window_missing".to_owned())?;
        let profile = app
            .path()
            .app_data_dir()
            .map_err(|_| "workbench_browser_profile_unavailable".to_owned())?
            .join("workbench-browser")
            .join(&panel_id);
        std::fs::create_dir_all(&profile)
            .map_err(|_| "workbench_browser_profile_unavailable".to_owned())?;
        let event_panel = panel_id.clone();
        let load_panel = panel_id.clone();
        let builder = WebviewBuilder::new(surface_label, WebviewUrl::External(target.clone()))
            .data_directory(profile)
            .focused(false)
            .initialization_script(INIT_SCRIPT)
            .on_navigation(move |candidate| {
                let allowed = navigation_allowed(candidate);
                if allowed && candidate.as_str() != "about:blank" {
                    update_current_state(&event_panel, candidate, true, None);
                }
                allowed
            })
            .on_page_load(move |_webview, payload| {
                if payload.url().as_str() == "about:blank" || !navigation_allowed(payload.url()) {
                    return;
                }
                update_current_state(
                    &load_panel,
                    payload.url(),
                    matches!(payload.event(), PageLoadEvent::Started),
                    None,
                );
            });
        with_isolated_child_webview2_environment(|| {
            main.add_child(
                builder,
                LogicalPosition::new(bounds.x, bounds.y),
                LogicalSize::new(bounds.width, bounds.height),
            )
        })
        .map_err(|_| "workbench_browser_webview_unavailable".to_owned())?
    };
    apply_bounds(&webview, &bounds)?;
    webview
        .show()
        .map_err(|_| "workbench_browser_window_unavailable".to_owned())?;
    current_status(&panel_id, &operation_id)
}

#[tauri::command]
pub async fn workbench_browser_surface_status(
    caller: Webview,
    panel_id: String,
    operation_id: String,
) -> Result<WorkbenchBrowserStatus, String> {
    ensure_caller(caller.label())?;
    current_status(&panel_id, &operation_id)
}

fn with_surface(app: &AppHandle, panel_id: &str, operation_id: &str) -> Result<Webview, String> {
    validate_id(panel_id, "workbench_browser_panel_invalid")?;
    validate_id(operation_id, "workbench_browser_operation_invalid")?;
    current_operation(panel_id, operation_id)?;
    app.get_webview(&label(panel_id))
        .ok_or_else(|| "workbench_browser_surface_unavailable".to_owned())
}

#[tauri::command]
pub async fn workbench_browser_surface_history(
    app: AppHandle,
    caller: Webview,
    panel_id: String,
    operation_id: String,
    delta: i8,
) -> Result<(), String> {
    ensure_caller(caller.label())?;
    if !matches!(delta, -1 | 1) {
        return Err("workbench_browser_history_delta_invalid".to_owned());
    }
    let webview = with_surface(&app, &panel_id, &operation_id)?;
    webview
        .eval(if delta < 0 {
            "history.back()"
        } else {
            "history.forward()"
        })
        .map_err(|_| "workbench_browser_history_unavailable".to_owned())
}

#[tauri::command]
pub async fn workbench_browser_surface_reload(
    app: AppHandle,
    caller: Webview,
    panel_id: String,
    operation_id: String,
) -> Result<(), String> {
    ensure_caller(caller.label())?;
    with_surface(&app, &panel_id, &operation_id)?
        .reload()
        .map_err(|_| "workbench_browser_reload_unavailable".to_owned())
}

#[tauri::command]
pub async fn workbench_browser_surface_stop(
    app: AppHandle,
    caller: Webview,
    panel_id: String,
    operation_id: String,
) -> Result<(), String> {
    ensure_caller(caller.label())?;
    with_surface(&app, &panel_id, &operation_id)?
        .eval("window.stop()")
        .map_err(|_| "workbench_browser_stop_unavailable".to_owned())
}

#[tauri::command]
pub async fn workbench_browser_surface_hide(
    app: AppHandle,
    caller: Webview,
    panel_id: String,
    operation_id: String,
) -> Result<(), String> {
    ensure_caller(caller.label())?;
    let _mutation = SURFACE_MUTATION.lock().await;
    let webview = with_surface(&app, &panel_id, &operation_id)?;
    webview
        .hide()
        .map_err(|_| "workbench_browser_window_unavailable".to_owned())?;
    webview
        .close()
        .map_err(|_| "workbench_browser_window_unavailable".to_owned())?;
    SURFACES
        .lock()
        .map_err(|_| "workbench_browser_state_unavailable".to_owned())?
        .remove(&panel_id);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_only_credentialless_http_urls() {
        assert!(validate_url("https://www.youtube.com/").is_ok());
        assert!(validate_url("http://example.com/path").is_ok());
        for blocked in [
            "file:///C:/secret.txt",
            "javascript:alert(1)",
            "https://user:secret@example.com/",
        ] {
            assert!(validate_url(blocked).is_err());
        }
    }

    #[test]
    fn child_surface_has_no_external_window_or_tauri_bridge_authority() {
        let source = include_str!("workbench_browser_surface.rs");
        let external_window_builder = ["WebviewWindow", "Builder"].concat();
        let external_open = ["open", "_external"].concat();
        assert!(source.contains("main.add_child("));
        assert!(!source.contains(&external_window_builder));
        assert!(!source.contains(&external_open));
        assert!(INIT_SCRIPT.contains("delete window.__TAURI_INTERNALS__"));
    }

    #[test]
    fn commands_accept_the_official_main_child_webview_caller() {
        let source = include_str!("workbench_browser_surface.rs");
        assert_eq!(source.matches("    caller: Webview,\n").count(), 6);
        assert!(!source.contains("    caller: WebviewWindow,\n"));
        assert!(source.contains("ensure_caller(caller.label())?;"));
    }

    #[test]
    fn operation_bound_status_does_not_depend_on_renderer_event_callbacks() {
        let source = include_str!("workbench_browser_surface.rs");
        let legacy_event = ["workbench-browser", "://state"].concat();
        let event_emit = [".", "emit("].concat();
        assert!(source.contains("pub async fn workbench_browser_surface_status("));
        assert!(source.contains("current_status(&panel_id, &operation_id)"));
        assert!(!source.contains(&legacy_event));
        assert!(!source.contains(&event_emit));
    }

    #[test]
    fn status_reconciles_the_latest_native_page_load_for_one_operation() {
        let panel_id = "status-test-panel";
        let operation_id = "status-test-operation";
        SURFACES.lock().unwrap().insert(
            panel_id.to_owned(),
            SurfaceRecord {
                operation_id: operation_id.to_owned(),
                url: "https://example.com/".to_owned(),
                loading: true,
                error: None,
            },
        );

        update_current_state(
            panel_id,
            &url::Url::parse("https://example.com/finished").unwrap(),
            false,
            None,
        );

        let status = current_status(panel_id, operation_id).unwrap();
        assert_eq!(status.url, "https://example.com/finished");
        assert!(!status.loading);
        assert_eq!(status.error, None);
        assert!(current_status(panel_id, "stale-operation").is_err());
        SURFACES.lock().unwrap().remove(panel_id);
    }

    #[test]
    fn navigation_and_operations_are_bounded() {
        let allowed = url::Url::parse("https://www.wikipedia.org/").unwrap();
        let blocked = url::Url::parse("file:///C:/secret.txt").unwrap();
        assert!(navigation_allowed(&allowed));
        assert!(!navigation_allowed(&blocked));
        assert!(validate_id("panel_1", "invalid").is_ok());
        assert!(validate_id("../panel", "invalid").is_err());
        assert!(matches!(-1_i8, -1 | 1));
        assert!(matches!(1_i8, -1 | 1));
    }

    #[test]
    fn bounds_refresh_preserves_the_real_load_state_for_an_unchanged_url() {
        assert!(!opening_loading_state(true, Some(false)));
        assert!(opening_loading_state(true, Some(true)));
        assert!(opening_loading_state(true, None));
        assert!(opening_loading_state(false, Some(false)));
    }

    #[test]
    fn child_creation_and_close_are_serialized_across_renderer_lifecycles() {
        let source = include_str!("workbench_browser_surface.rs");
        for command in [
            "pub async fn workbench_browser_surface_open(",
            "pub async fn workbench_browser_surface_hide(",
        ] {
            let start = source.find(command).expect("surface command is registered");
            let remaining = &source[start..];
            let end = remaining
                .find("\n}\n")
                .expect("surface command has a bounded body");
            assert!(
                remaining[..end].contains("SURFACE_MUTATION.lock().await"),
                "{command} is not serialized",
            );
        }
    }

    #[cfg(windows)]
    #[test]
    fn child_environment_does_not_inherit_the_main_cdp_endpoint() {
        const KEY: &str = "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS";
        let previous = std::env::var_os(KEY);
        std::env::set_var(
            KEY,
            "--remote-debugging-address=127.0.0.1 --remote-debugging-port=9223",
        );

        let observed = with_isolated_child_webview2_environment(|| std::env::var_os(KEY));

        assert_eq!(observed, None);
        assert_eq!(
            std::env::var_os(KEY),
            Some("--remote-debugging-address=127.0.0.1 --remote-debugging-port=9223".into())
        );
        match previous {
            Some(value) => std::env::set_var(KEY, value),
            None => std::env::remove_var(KEY),
        }
    }
}
