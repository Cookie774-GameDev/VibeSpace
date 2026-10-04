//! Browser Chat provider surfaces embedded as child WebViews of the main VibeSpace window.
//!
//! The remote provider origin never receives VibeSpace capability authority: every command
//! verifies that the invoking webview is the local `main` view, provider URLs come from a fixed
//! registry, navigation is allowlisted, and provider profile directories are hashed per
//! VibeSpace account/provider instead of being shared globally.

use std::{
    fmt::Write as _,
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex,
    },
    time::{SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{
    webview::{NewWindowResponse, PageLoadEvent, Webview, WebviewBuilder},
    AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, WebviewUrl, WebviewWindow,
};

use crate::workbench_browser_surface::with_isolated_child_webview2_environment;

const NAVIGATION_EVENT: &str = "browser-chat://navigation";
const LOAD_EVENT: &str = "browser-chat://load";

#[derive(Debug, Clone)]
struct SurfaceRecord {
    label: String,
}

// Native surface operations are serialized so React geometry updates cannot create duplicate
// child WebViews or race against route-leave hide commands. The visible label lets provider or
// account switches focus once without stealing focus during geometry-only updates.
#[derive(Debug)]
struct SurfaceState {
    visible_label: Option<String>,
    surfaces: Vec<SurfaceRecord>,
}

static SURFACE_STATE: Mutex<SurfaceState> = Mutex::new(SurfaceState {
    visible_label: None,
    surfaces: Vec::new(),
});

// Hide commands increment this before waiting for the native operation mutex. An in-flight open
// therefore knows it is stale before it can show the child on a route that has already changed.
static SURFACE_VISIBILITY_GENERATION: AtomicU64 = AtomicU64::new(0);

const LEGACY_SURFACE_LABELS: [&str; 3] = [
    "browser-chat-chatgpt",
    "browser-chat-claude",
    "browser-chat-gemini",
];

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

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct BrowserChatNavigation {
    provider_id: String,
    surface_id: String,
    account_profile_key: String,
    page_id: String,
    url: String,
    timestamp: u64,
    kind: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct BrowserChatLoad {
    provider_id: String,
    account_profile_key: String,
    page_id: String,
    phase: &'static str,
}

#[derive(Clone)]
struct ProviderConfig {
    id: &'static str,
    label: &'static str,
    hostname: &'static str,
    url: url::Url,
}

fn provider_config(provider_id: &str) -> Result<ProviderConfig, String> {
    let (id, label, hostname, url) = match provider_id {
        "chatgpt" => (
            "chatgpt",
            "browser-chat-chatgpt",
            "chatgpt.com",
            "https://chatgpt.com/",
        ),
        "claude" => (
            "claude",
            "browser-chat-claude",
            "claude.ai",
            "https://claude.ai/new",
        ),
        "gemini" => (
            "gemini",
            "browser-chat-gemini",
            "gemini.google.com",
            "https://gemini.google.com/",
        ),
        _ => return Err("browser_chat_provider_not_allowed".to_string()),
    };

    Ok(ProviderConfig {
        id,
        label,
        hostname,
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

fn validate_profile_key(profile_key: &str) -> Result<(), String> {
    let digest = profile_key
        .strip_prefix("profile_")
        .ok_or_else(|| "browser_chat_profile_key_invalid".to_string())?;
    if digest.len() == 64
        && digest
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        Ok(())
    } else {
        Err("browser_chat_profile_key_invalid".to_string())
    }
}

fn profile_digest(profile_key: &str) -> Result<String, String> {
    validate_profile_key(profile_key)?;
    let digest = Sha256::digest(profile_key.as_bytes());
    let mut encoded = String::with_capacity(digest.len() * 2);
    for byte in digest {
        write!(&mut encoded, "{byte:02x}")
            .map_err(|_| "browser_chat_profile_digest_failed".to_string())?;
    }
    Ok(encoded)
}

fn validate_page_id(page_id: &str) -> Result<(), String> {
    if page_id.is_empty()
        || page_id.len() > 160
        || page_id.trim() != page_id
        || page_id.chars().any(char::is_control)
    {
        return Err("browser_chat_page_id_invalid".to_string());
    }
    Ok(())
}

fn page_digest(page_id: &str) -> Result<String, String> {
    validate_page_id(page_id)?;
    let digest = Sha256::digest(page_id.as_bytes());
    Ok(format!("{digest:x}"))
}

fn surface_label(provider_id: &str, digest: &str, page_digest: &str) -> Result<String, String> {
    if digest.len() < 16
        || page_digest.len() < 16
        || !digest.bytes().all(|byte| byte.is_ascii_hexdigit())
        || !page_digest.bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        return Err("browser_chat_profile_digest_invalid".to_string());
    }
    Ok(format!(
        "browser-chat-{provider_id}-{}-{}",
        &digest[..16],
        &page_digest[..16]
    ))
}

fn relative_bounds(
    bounds: &BrowserChatBounds,
) -> Result<(LogicalPosition<f64>, LogicalSize<f64>), String> {
    validate_bounds(bounds)?;
    Ok((
        LogicalPosition::new(bounds.x, bounds.y),
        LogicalSize::new(bounds.width, bounds.height),
    ))
}

fn apply_bounds(provider: &Webview, bounds: &BrowserChatBounds) -> Result<(), String> {
    let (position, size) = relative_bounds(bounds)?;
    provider
        .set_position(position)
        .map_err(|error| format!("browser_chat_position_failed:{error}"))?;
    provider
        .set_size(size)
        .map_err(|error| format!("browser_chat_size_failed:{error}"))
}

fn is_browser_chat_label(label: &str) -> bool {
    label == "browser-chat-chatgpt"
        || label == "browser-chat-claude"
        || label == "browser-chat-gemini"
        || label.starts_with("browser-chat-chatgpt-")
        || label.starts_with("browser-chat-claude-")
        || label.starts_with("browser-chat-gemini-")
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SurfaceDeactivationMode {
    PreserveSession,
    Destroy,
}

fn is_profile_scoped_browser_chat_label(label: &str) -> bool {
    [
        "browser-chat-chatgpt-",
        "browser-chat-claude-",
        "browser-chat-gemini-",
    ]
    .iter()
    .any(|prefix| {
        label.strip_prefix(prefix).is_some_and(|digest| {
            let mut parts = digest.split('-');
            let profile = parts.next();
            let page = parts.next();
            parts.next().is_none()
                && profile.is_some_and(|part| {
                    part.len() == 16 && part.bytes().all(|byte| byte.is_ascii_hexdigit())
                })
                && page.is_some_and(|part| {
                    part.len() == 16 && part.bytes().all(|byte| byte.is_ascii_hexdigit())
                })
        })
    })
}

fn surface_deactivation_mode(label: &str, tracked: bool) -> SurfaceDeactivationMode {
    if tracked && is_profile_scoped_browser_chat_label(label) {
        SurfaceDeactivationMode::PreserveSession
    } else {
        SurfaceDeactivationMode::Destroy
    }
}

fn deactivate_surface(
    app: &AppHandle,
    label: &str,
    mode: SurfaceDeactivationMode,
) -> Result<(), String> {
    if let Some(webview) = app.get_webview(label) {
        // On Windows/WebView2 a hidden child can retain its last compositor surface
        // and stay painted over the default VibeSpace page. A tracked account surface
        // stays alive but parked off-screen at 1px so ordinary route changes do not
        // reload ChatGPT or trigger its restart/recovery page. Legacy and orphaned
        // surfaces are still closed so an old renderer cannot overlay the shell.
        let _ = webview.set_position(LogicalPosition::new(-32_000.0, -32_000.0));
        let _ = webview.set_size(LogicalSize::new(1.0, 1.0));
        match mode {
            SurfaceDeactivationMode::PreserveSession => {
                // Keeping WebView2 composited at an off-screen 1px location avoids
                // the stale hidden-child frame while retaining the live provider page.
                let _ = webview.show();
            }
            SurfaceDeactivationMode::Destroy => {
                let _ = webview.hide();
                let _ = webview.close();
            }
        }
    }
    Ok(())
}

fn hide_surfaces_except(
    app: &AppHandle,
    state: &SurfaceState,
    selected: Option<&str>,
) -> Result<(), String> {
    for surface in &state.surfaces {
        if Some(surface.label.as_str()) != selected {
            deactivate_surface(
                app,
                &surface.label,
                surface_deactivation_mode(&surface.label, true),
            )?;
        }
    }

    // Older PR-31 builds used static labels. Hide those too so a renderer hot reload or an
    // in-place upgrade cannot leave a legacy provider view floating over the current shell.
    for label in LEGACY_SURFACE_LABELS {
        if Some(label) != selected {
            deactivate_surface(app, label, SurfaceDeactivationMode::Destroy)?;
        }
    }

    let leftover: Vec<String> = app
        .webviews()
        .into_iter()
        .map(|(label, _)| label)
        .filter(|label| {
            is_browser_chat_label(label)
                && Some(label.as_str()) != selected
                && !LEGACY_SURFACE_LABELS.contains(&label.as_str())
                && !state.surfaces.iter().any(|surface| surface.label == *label)
        })
        .collect();
    for label in leftover {
        deactivate_surface(app, &label, SurfaceDeactivationMode::Destroy)?;
    }
    Ok(())
}

fn visibility_generation_is_current(requested: u64) -> bool {
    SURFACE_VISIBILITY_GENERATION.load(Ordering::Acquire) == requested
}

fn host_matches(host: &str, suffix: &str) -> bool {
    host == suffix || host.ends_with(&format!(".{suffix}"))
}

fn provider_navigation_allowed(provider_id: &str, target: &url::Url) -> bool {
    if target.as_str() == "about:blank" {
        return true;
    }
    if target.scheme() != "https" || target.username() != "" || target.password().is_some() {
        return false;
    }
    let Some(host) = target.host_str().map(str::to_ascii_lowercase) else {
        return false;
    };

    let shared_identity_hosts = [
        "accounts.google.com",
        "google.com",
        "login.microsoftonline.com",
        "live.com",
        "apple.com",
        "auth0.com",
        "okta.com",
        "cloudflare.com",
    ];
    let provider_hosts: &[&str] = match provider_id {
        "chatgpt" => &[
            "chatgpt.com",
            "openai.com",
            "oaistatic.com",
            "oaiusercontent.com",
        ],
        "claude" => &["claude.ai", "anthropic.com", "claudeusercontent.com"],
        "gemini" => &[
            "gemini.google.com",
            "google.com",
            "googleapis.com",
            "googleusercontent.com",
            "gstatic.com",
        ],
        _ => return false,
    };

    provider_hosts
        .iter()
        .chain(shared_identity_hosts.iter())
        .any(|suffix| host_matches(&host, suffix))
}

fn safe_navigation_key(value: &str) -> bool {
    !value.is_empty()
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
}

fn navigation_kind(provider_id: &str, path: &str) -> Option<&'static str> {
    let segments: Vec<_> = path
        .trim_matches('/')
        .split('/')
        .filter(|segment| !segment.is_empty())
        .collect();
    match provider_id {
        "chatgpt" => match segments.as_slice() {
            [] => Some("home"),
            ["c", conversation] if safe_navigation_key(conversation) => Some("conversation"),
            ["g", project, "project"] if safe_navigation_key(project) => Some("project"),
            ["g", project, "c", conversation]
                if safe_navigation_key(project) && safe_navigation_key(conversation) =>
            {
                Some("conversation")
            }
            _ => None,
        },
        "claude" => match segments.as_slice() {
            [] | ["new"] => Some("home"),
            ["chat", conversation] if safe_navigation_key(conversation) => Some("conversation"),
            ["project", project] if safe_navigation_key(project) => Some("project"),
            _ => None,
        },
        "gemini" => match segments.as_slice() {
            [] => Some("home"),
            ["app", conversation] if safe_navigation_key(conversation) => Some("conversation"),
            _ => None,
        },
        _ => None,
    }
}

fn normalized_navigation(
    provider: &ProviderConfig,
    account_profile_key: &str,
    page_id: &str,
    candidate: &url::Url,
    timestamp: u64,
) -> Option<BrowserChatNavigation> {
    if candidate.scheme() != "https"
        || candidate.host_str() != Some(provider.hostname)
        || candidate.port().is_some()
        || !candidate.username().is_empty()
        || candidate.password().is_some()
    {
        return None;
    }
    let kind = navigation_kind(provider.id, candidate.path())?;
    Some(BrowserChatNavigation {
        provider_id: provider.id.to_string(),
        surface_id: provider.label.to_string(),
        account_profile_key: account_profile_key.to_string(),
        page_id: page_id.to_string(),
        url: format!("https://{}{}", provider.hostname, candidate.path()),
        timestamp,
        kind: kind.to_string(),
    })
}

fn normalized_provider_url(provider: &ProviderConfig, raw_url: &str) -> Option<url::Url> {
    let candidate = raw_url.parse().ok()?;
    let placeholder_profile =
        "profile_0000000000000000000000000000000000000000000000000000000000000000";
    let navigation =
        normalized_navigation(provider, placeholder_profile, "default", &candidate, 0)?;
    navigation.url.parse().ok()
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}

fn profile_directory(
    app: &AppHandle,
    provider_id: &str,
    digest: &str,
) -> Result<std::path::PathBuf, String> {
    let profile_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("browser_chat_profile_failed:{error}"))?
        .join("browser-chat")
        .join(digest)
        .join(provider_id);
    std::fs::create_dir_all(&profile_dir)
        .map_err(|error| format!("browser_chat_profile_failed:{error}"))?;
    Ok(profile_dir)
}

fn open_provider(
    app: AppHandle,
    provider: ProviderConfig,
    profile_key: String,
    page_id: String,
    navigation_url: Option<url::Url>,
    bounds: BrowserChatBounds,
    requested_generation: u64,
) -> Result<bool, String> {
    let digest = profile_digest(&profile_key)?;
    let page_digest = page_digest(&page_id)?;
    let label = surface_label(provider.id, &digest, &page_digest)?;
    let mut state = SURFACE_STATE
        .lock()
        .map_err(|_| "browser_chat_surface_lock_unavailable".to_string())?;

    hide_surfaces_except(&app, &state, Some(&label))?;

    let (webview, created) = if let Some(existing) = app.get_webview(&label) {
        apply_bounds(&existing, &bounds)?;
        if let Some(target) = navigation_url.as_ref() {
            existing
                .navigate(target.clone())
                .map_err(|error| format!("browser_chat_navigate_failed:{error}"))?;
        }
        (existing, false)
    } else {
        let main = app
            .get_window("main")
            .ok_or_else(|| "browser_chat_main_window_missing".to_string())?;
        let (position, size) = relative_bounds(&bounds)?;
        let target = navigation_url.unwrap_or_else(|| provider.url.clone());
        let provider_id = provider.id;
        let navigation_app = app.clone();
        let navigation_provider = provider.clone();
        let navigation_profile_key = profile_key.clone();
        let navigation_page_id = page_id.clone();
        let load_app = app.clone();
        let load_profile_key = profile_key.clone();
        let load_page_id = page_id.clone();
        let load_provider_id = provider.id;
        let popup_app = app.clone();
        let popup_label = label.clone();
        let popup_provider_id = provider.id;
        let builder = WebviewBuilder::new(label.clone(), WebviewUrl::External(target))
            .data_directory(profile_directory(&app, provider.id, &digest)?)
            .focused(false)
            .on_navigation(move |candidate| {
                let allowed = provider_navigation_allowed(provider_id, candidate);
                if allowed {
                    if let Some(navigation) = normalized_navigation(
                        &navigation_provider,
                        &navigation_profile_key,
                        &navigation_page_id,
                        candidate,
                        now_millis(),
                    ) {
                        let _ = navigation_app.emit_to("main", NAVIGATION_EVENT, navigation);
                    }
                }
                allowed
            })
            .on_page_load(move |_webview, payload| {
                if !provider_navigation_allowed(load_provider_id, payload.url())
                    || payload.url().as_str() == "about:blank"
                {
                    return;
                }
                let phase = if matches!(payload.event(), PageLoadEvent::Finished) {
                    "finished"
                } else {
                    "started"
                };
                let _ = load_app.emit_to(
                    "main",
                    LOAD_EVENT,
                    BrowserChatLoad {
                        provider_id: load_provider_id.to_string(),
                        account_profile_key: load_profile_key.clone(),
                        page_id: load_page_id.clone(),
                        phase,
                    },
                );
            })
            .on_new_window(move |target, _features| {
                if provider_navigation_allowed(popup_provider_id, &target)
                    && target.as_str() != "about:blank"
                {
                    let app = popup_app.clone();
                    let label = popup_label.clone();
                    tauri::async_runtime::spawn(async move {
                        if let Some(webview) = app.get_webview(&label) {
                            let _ = webview.navigate(target);
                        }
                    });
                }
                NewWindowResponse::Deny
            });
        let created =
            with_isolated_child_webview2_environment(|| main.add_child(builder, position, size))
                .map_err(|error| format!("browser_chat_create_failed:{error}"))?;
        (created, true)
    };

    if !state.surfaces.iter().any(|surface| surface.label == label) {
        state.surfaces.push(SurfaceRecord {
            label: label.clone(),
        });
    }

    if !visibility_generation_is_current(requested_generation) {
        let mode = if created {
            SurfaceDeactivationMode::Destroy
        } else {
            SurfaceDeactivationMode::PreserveSession
        };
        deactivate_surface(&app, &label, mode)?;
        if state.visible_label.as_deref() == Some(label.as_str()) {
            state.visible_label = None;
        }
        return Ok(created);
    }

    let should_focus = created || state.visible_label.as_deref() != Some(label.as_str());
    webview
        .show()
        .map_err(|error| format!("browser_chat_show_failed:{error}"))?;

    if !visibility_generation_is_current(requested_generation) {
        let mode = if created {
            SurfaceDeactivationMode::Destroy
        } else {
            SurfaceDeactivationMode::PreserveSession
        };
        deactivate_surface(&app, &label, mode)?;
        state.visible_label = None;
        return Ok(created);
    }

    if should_focus {
        webview
            .set_focus()
            .map_err(|error| format!("browser_chat_focus_failed:{error}"))?;
    }
    state.visible_label = Some(label);
    Ok(created)
}

#[tauri::command]
pub async fn browser_chat_surface_open(
    app: AppHandle,
    caller: WebviewWindow,
    provider_id: String,
    provider_profile_key: String,
    page_id: String,
    navigation_url: Option<String>,
    bounds: BrowserChatBounds,
) -> Result<BrowserChatSurfaceStatus, String> {
    ensure_main_caller(caller.label())?;
    validate_bounds(&bounds)?;
    validate_profile_key(&provider_profile_key)?;
    validate_page_id(&page_id)?;
    let provider = provider_config(&provider_id)?;
    let navigation_url = navigation_url
        .as_deref()
        .map(|raw_url| {
            normalized_provider_url(&provider, raw_url)
                .ok_or_else(|| "browser_chat_navigation_not_allowed".to_string())
        })
        .transpose()?;
    let status_provider_id = provider.id.to_string();
    let requested_generation = SURFACE_VISIBILITY_GENERATION.load(Ordering::Acquire);

    let created = tauri::async_runtime::spawn_blocking(move || {
        open_provider(
            app,
            provider,
            provider_profile_key,
            page_id,
            navigation_url,
            bounds,
            requested_generation,
        )
    })
    .await
    .map_err(|error| format!("browser_chat_task_failed:{error}"))??;

    Ok(BrowserChatSurfaceStatus {
        provider_id: status_provider_id,
        created,
    })
}

#[tauri::command]
pub async fn browser_chat_surface_hide_all(
    app: AppHandle,
    caller: WebviewWindow,
) -> Result<(), String> {
    ensure_main_caller(caller.label())?;
    SURFACE_VISIBILITY_GENERATION.fetch_add(1, Ordering::AcqRel);
    tauri::async_runtime::spawn_blocking(move || {
        let mut state = SURFACE_STATE
            .lock()
            .map_err(|_| "browser_chat_surface_lock_unavailable".to_string())?;
        hide_surfaces_except(&app, &state, None)?;
        state.visible_label = None;
        Ok::<(), String>(())
    })
    .await
    .map_err(|error| format!("browser_chat_task_failed:{error}"))??;
    Ok(())
}

#[tauri::command]
pub async fn browser_chat_surface_hide(
    app: AppHandle,
    caller: WebviewWindow,
    provider_id: String,
    provider_profile_key: String,
    page_id: String,
) -> Result<(), String> {
    ensure_main_caller(caller.label())?;
    let provider = provider_config(&provider_id)?;
    let profile_digest = profile_digest(&provider_profile_key)?;
    let page_digest = page_digest(&page_id)?;
    let label = surface_label(provider.id, &profile_digest, &page_digest)?;
    SURFACE_VISIBILITY_GENERATION.fetch_add(1, Ordering::AcqRel);
    tauri::async_runtime::spawn_blocking(move || {
        let mut state = SURFACE_STATE
            .lock()
            .map_err(|_| "browser_chat_surface_lock_unavailable".to_string())?;
        deactivate_surface(&app, &label, SurfaceDeactivationMode::PreserveSession)?;
        if state.visible_label.as_deref() == Some(label.as_str()) {
            state.visible_label = None;
        }
        Ok::<(), String>(())
    })
    .await
    .map_err(|error| format!("browser_chat_task_failed:{error}"))??;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preserves_tracked_profile_sessions_but_destroys_legacy_or_orphan_surfaces() {
        assert_eq!(
            surface_deactivation_mode(
                "browser-chat-chatgpt-0123456789abcdef-fedcba9876543210",
                true
            ),
            SurfaceDeactivationMode::PreserveSession
        );
        assert_eq!(
            surface_deactivation_mode(
                "browser-chat-claude-0123456789abcdef-fedcba9876543210",
                true
            ),
            SurfaceDeactivationMode::PreserveSession
        );
        assert_eq!(
            surface_deactivation_mode("browser-chat-chatgpt", false),
            SurfaceDeactivationMode::Destroy
        );
        assert_eq!(
            surface_deactivation_mode("browser-chat-chatgpt-fedcba9876543210", false),
            SurfaceDeactivationMode::Destroy
        );
        assert_eq!(
            surface_deactivation_mode("browser-chat-chatgpt-fedcba9876543210", true),
            SurfaceDeactivationMode::Destroy
        );
    }

    #[test]
    fn treats_legacy_and_profile_scoped_labels_as_browser_chat_surfaces() {
        assert!(is_browser_chat_label("browser-chat-chatgpt"));
        assert!(is_browser_chat_label(
            "browser-chat-chatgpt-0123456789abcdef-fedcba9876543210"
        ));
        assert!(!is_browser_chat_label("browser-chat-attacker"));
        assert!(!is_browser_chat_label("main"));
        assert!(!is_browser_chat_label("workbench"));
    }

    #[test]
    fn accepts_only_registry_owned_provider_ids() {
        let chatgpt = provider_config("chatgpt").expect("ChatGPT is registry-owned");
        assert_eq!(chatgpt.id, "chatgpt");
        assert_eq!(chatgpt.url.as_str(), "https://chatgpt.com/");
        assert!(provider_config("https://attacker.example").is_err());
        assert!(provider_config("../chatgpt").is_err());
    }

    #[test]
    fn rejects_non_main_callers_invalid_bounds_and_malformed_profile_keys() {
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
        assert!(validate_profile_key(
            "profile_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        )
        .is_ok());
        assert!(validate_profile_key("").is_err());
        assert!(validate_profile_key("bad\nprofile").is_err());
        assert!(validate_profile_key(
            "profile_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
        )
        .is_err());
        assert!(validate_page_id("chat-one").is_ok());
        assert!(validate_page_id("bad\npage").is_err());
        assert!(validate_page_id("").is_err());
    }

    #[test]
    fn child_bounds_remain_relative_to_the_main_window() {
        let (position, size) = relative_bounds(&BrowserChatBounds {
            x: 120.0,
            y: 90.0,
            width: 880.0,
            height: 620.0,
        })
        .expect("valid relative bounds");

        assert_eq!(position.x, 120.0);
        assert_eq!(position.y, 90.0);
        assert_eq!(size.width, 880.0);
        assert_eq!(size.height, 620.0);
    }

    #[test]
    fn profile_labels_are_stable_but_isolated_between_accounts() {
        let account_a = profile_digest(
            "profile_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        )
        .expect("valid profile");
        let account_a_again = profile_digest(
            "profile_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        )
        .expect("valid profile");
        let account_b = profile_digest(
            "profile_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        )
        .expect("valid profile");
        assert_eq!(account_a, account_a_again);
        assert_ne!(account_a, account_b);
        let page_a = page_digest("chat-one").expect("valid page");
        let page_b = page_digest("chat-two").expect("valid page");
        assert_ne!(
            surface_label("chatgpt", &account_a, &page_a).expect("valid label"),
            surface_label("chatgpt", &account_b, &page_a).expect("valid label")
        );
        assert_ne!(
            surface_label("chatgpt", &account_a, &page_a).expect("valid label"),
            surface_label("chatgpt", &account_a, &page_b).expect("valid label")
        );
    }

    #[test]
    fn route_hide_generation_invalidates_an_older_open() {
        let current = SURFACE_VISIBILITY_GENERATION.load(Ordering::Acquire);
        assert!(visibility_generation_is_current(current));
        SURFACE_VISIBILITY_GENERATION.fetch_add(1, Ordering::AcqRel);
        assert!(!visibility_generation_is_current(current));
    }

    #[test]
    fn navigation_allows_provider_and_identity_hosts_but_blocks_untrusted_origins() {
        assert!(provider_navigation_allowed(
            "chatgpt",
            &"https://chatgpt.com/c/abc".parse().expect("valid url")
        ));
        assert!(provider_navigation_allowed(
            "chatgpt",
            &"https://auth.openai.com/authorize"
                .parse()
                .expect("valid url")
        ));
        assert!(provider_navigation_allowed(
            "chatgpt",
            &"https://accounts.google.com/o/oauth2/v2/auth"
                .parse()
                .expect("valid url")
        ));
        assert!(!provider_navigation_allowed(
            "chatgpt",
            &"https://attacker.example/phish".parse().expect("valid url")
        ));
        assert!(!provider_navigation_allowed(
            "chatgpt",
            &"http://chatgpt.com/".parse().expect("valid url")
        ));
    }

    #[test]
    fn emits_only_normalized_account_scoped_provider_navigation() {
        let provider = provider_config("chatgpt").expect("known provider");
        let account_profile_key =
            "profile_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        let navigation = normalized_navigation(
            &provider,
            account_profile_key,
            "chat-one",
            &"https://chatgpt.com/c/conversation-123?utm_source=test#fragment"
                .parse()
                .expect("valid url"),
            42,
        )
        .expect("supported provider navigation");

        assert_eq!(navigation.provider_id, "chatgpt");
        assert_eq!(navigation.surface_id, "browser-chat-chatgpt");
        assert_eq!(navigation.account_profile_key, account_profile_key);
        assert_eq!(navigation.page_id, "chat-one");
        assert_eq!(navigation.url, "https://chatgpt.com/c/conversation-123");
        assert_eq!(navigation.timestamp, 42);
        assert_eq!(navigation.kind, "conversation");
        assert!(normalized_navigation(
            &provider,
            account_profile_key,
            "chat-one",
            &"https://auth.openai.com/authorize"
                .parse()
                .expect("valid identity url"),
            42,
        )
        .is_none());
        assert!(normalized_navigation(
            &provider,
            account_profile_key,
            "chat-one",
            &"https://chatgpt.com/unsupported/path"
                .parse()
                .expect("valid provider url"),
            42,
        )
        .is_none());
    }

    #[test]
    fn visible_provider_state_distinguishes_activation_from_geometry_updates() {
        let mut state = SurfaceState {
            visible_label: None,
            surfaces: Vec::new(),
        };
        assert_ne!(
            state.visible_label.as_deref(),
            Some("browser-chat-chatgpt-account-a")
        );
        state.visible_label = Some("browser-chat-chatgpt-account-a".to_string());
        assert_eq!(
            state.visible_label.as_deref(),
            Some("browser-chat-chatgpt-account-a")
        );
        assert_ne!(
            state.visible_label.as_deref(),
            Some("browser-chat-claude-account-a")
        );
    }
}
