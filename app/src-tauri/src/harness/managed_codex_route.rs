use serde::{Deserialize, Serialize};
use std::collections::{HashMap, VecDeque};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Webview};

use crate::harness::codex_server::connected_provider::{self, ConnectedProvider};

const ROUTE_TTL_MS: u64 = 120_000;
const MAX_ROUTES: usize = 64;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ManagedCodexRouteRequest {
    account_id: String,
    connection_id: String,
    model_id: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedCodexRouteCapability {
    authority: &'static str,
    account_id: String,
    connection_id: String,
    model_id: String,
    provider_id: String,
    upstream_model_id: String,
    route_handle: String,
    configuration_generation: String,
    expires_at: u64,
    authenticated: bool,
    route: &'static str,
    wire_protocol: &'static str,
    contract: &'static str,
    adapter: &'static str,
    translator_verified: bool,
    supported_efforts: Vec<String>,
    supported_service_tiers: Vec<String>,
    supports: ManagedCodexRouteSupports,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ManagedCodexRouteSupports {
    tools: bool,
    cancellation: bool,
    streaming: bool,
    usage: bool,
    reasoning: bool,
}

#[derive(Debug, Clone)]
struct StoredRoute {
    account_id: String,
    connection_id: String,
    model_id: String,
    provider_id: String,
    upstream_model_id: String,
    adapter: String,
    configuration_generation: String,
    expires_at: u64,
}

#[derive(Default)]
struct RouteRegistry {
    routes: HashMap<String, StoredRoute>,
    order: VecDeque<String>,
}

#[derive(Default)]
pub struct ManagedCodexRouteState {
    inner: Mutex<RouteRegistry>,
}

fn now_ms() -> Result<u64, String> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_millis() as u64)
        .map_err(|_| "Codex route clock is unavailable.".to_string())
}

fn valid_identifier(value: &str) -> bool {
    let mut bytes = value.bytes();
    matches!(bytes.next(), Some(first) if first.is_ascii_alphanumeric())
        && value.len() <= 256
        && bytes.all(|byte| {
            byte.is_ascii_alphanumeric()
                || matches!(byte, b'.' | b'_' | b':' | b'@' | b'/' | b'-' | b'+')
        })
        && !value.to_ascii_lowercase().starts_with("sk-")
        && !value.to_ascii_lowercase().starts_with("github_pat_")
        && !value.to_ascii_lowercase().starts_with("bearer")
}

fn caller_allowed(label: &str) -> bool {
    matches!(label, "main" | "workbench-main")
}

fn reviewed_translation_adapter(adapter: &str) -> Option<&'static str> {
    match adapter {
        "openai-chat" => Some("chat-completions"),
        "anthropic" => Some("anthropic"),
        "google" => Some("google"),
        "azure-openai" => Some("azure-openai"),
        // The pinned OpenCodex runtime registers openai-responses as a
        // Codex-owned adapter and owns the Responses request/stream translation.
        // VibeSpace still revalidates the exact connected provider and route
        // generation at launch; this is not generic direct-provider passthrough.
        "openai-responses" => Some("responses"),
        _ => None,
    }
}

fn prune(registry: &mut RouteRegistry, now: u64) {
    registry.routes.retain(|_, route| route.expires_at > now);
    registry
        .order
        .retain(|handle| registry.routes.contains_key(handle));
    while registry.order.len() > MAX_ROUTES {
        if let Some(handle) = registry.order.pop_front() {
            registry.routes.remove(&handle);
        }
    }
}

fn build_route(
    app: &AppHandle,
    request: &ManagedCodexRouteRequest,
) -> Result<(ConnectedProvider, ManagedCodexRouteCapability, StoredRoute), String> {
    if !valid_identifier(&request.account_id)
        || !valid_identifier(&request.connection_id)
        || !valid_identifier(&request.model_id)
    {
        return Err("Codex route selection contains an invalid identity.".into());
    }
    if request.connection_id != "opencode-cli" {
        return Err(
            "This connection has no native-owned Codex compatibility route; keep it on its native runtime."
                .into(),
        );
    }
    let provider = connected_provider::resolve(app, &request.model_id)?;
    let wire_protocol = reviewed_translation_adapter(provider.adapter_id()).ok_or(
        "This provider's direct Responses semantics are not verified for Codex; keep it on its native runtime.",
    )?;
    let now = now_ms()?;
    let expires_at = now.saturating_add(ROUTE_TTL_MS);
    let route_handle = format!("codex-route-{}", nanoid::nanoid!(24));
    let configuration_generation = format!("codex-route-generation-{}", nanoid::nanoid!(16));
    let efforts = provider.supported_efforts().to_vec();
    let capability = ManagedCodexRouteCapability {
        authority: "native-owned",
        account_id: request.account_id.clone(),
        connection_id: request.connection_id.clone(),
        model_id: request.model_id.clone(),
        provider_id: provider.provider_id().to_string(),
        upstream_model_id: provider.upstream_model_id().to_string(),
        route_handle: route_handle.clone(),
        configuration_generation: configuration_generation.clone(),
        expires_at,
        authenticated: true,
        route: "opencodex-translation",
        wire_protocol,
        contract: "reviewed-opencodex-v1",
        adapter: match provider.adapter_id() {
            "openai-chat" => "openai-chat",
            "openai-responses" => "openai-responses",
            "anthropic" => "anthropic",
            "google" => "google",
            "azure-openai" => "azure-openai",
            _ => return Err("The selected translation adapter is not reviewed.".into()),
        },
        translator_verified: true,
        supported_efforts: efforts.clone(),
        supported_service_tiers: Vec::new(),
        supports: ManagedCodexRouteSupports {
            tools: true,
            cancellation: true,
            streaming: true,
            usage: true,
            reasoning: !efforts.is_empty(),
        },
    };
    let stored = StoredRoute {
        account_id: request.account_id.clone(),
        connection_id: request.connection_id.clone(),
        model_id: request.model_id.clone(),
        provider_id: provider.provider_id().to_string(),
        upstream_model_id: provider.upstream_model_id().to_string(),
        adapter: provider.adapter_id().to_string(),
        configuration_generation,
        expires_at,
    };
    Ok((provider, capability, stored))
}

#[tauri::command]
pub async fn managed_codex_route_resolve(
    app: AppHandle,
    webview: Webview,
    state: tauri::State<'_, ManagedCodexRouteState>,
    request: ManagedCodexRouteRequest,
) -> Result<ManagedCodexRouteCapability, String> {
    if !caller_allowed(webview.label()) {
        return Err("Codex route caller is not authorized.".into());
    }
    let request_for_worker = request.clone();
    let app_for_worker = app.clone();
    let (capability, stored) = tauri::async_runtime::spawn_blocking(move || {
        let (_, capability, stored) = build_route(&app_for_worker, &request_for_worker)?;
        Ok::<_, String>((capability, stored))
    })
    .await
    .map_err(|_| "Codex route resolution worker failed.".to_string())??;
    let mut registry = state
        .inner
        .lock()
        .map_err(|_| "Codex route state is unavailable.".to_string())?;
    let now = now_ms()?;
    prune(&mut registry, now);
    registry.order.push_back(capability.route_handle.clone());
    registry
        .routes
        .insert(capability.route_handle.clone(), stored);
    prune(&mut registry, now);
    Ok(capability)
}

pub(super) fn revalidate_translation_route(
    app: &AppHandle,
    state: &ManagedCodexRouteState,
    account_id: &str,
    connection_id: &str,
    model_id: &str,
    route_handle: &str,
    configuration_generation: &str,
) -> Result<ConnectedProvider, String> {
    let now = now_ms()?;
    let expected = {
        let mut registry = state
            .inner
            .lock()
            .map_err(|_| "Codex route state is unavailable.".to_string())?;
        prune(&mut registry, now);
        registry
            .routes
            .get(route_handle)
            .cloned()
            .ok_or("Codex route capability is missing or expired.")?
    };
    if expected.expires_at <= now
        || expected.account_id != account_id
        || expected.connection_id != connection_id
        || expected.model_id != model_id
        || expected.configuration_generation != configuration_generation
    {
        return Err("Codex route capability no longer matches the requested route.".into());
    }
    let provider = connected_provider::resolve(app, model_id)?;
    if provider.provider_id() != expected.provider_id
        || provider.upstream_model_id() != expected.upstream_model_id
        || provider.adapter_id() != expected.adapter
        || reviewed_translation_adapter(provider.adapter_id()).is_none()
    {
        return Err("Codex route capability became stale before launch.".into());
    }
    Ok(provider)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn route_identifiers_reject_secret_shapes_and_controls() {
        assert!(valid_identifier("account-1"));
        assert!(valid_identifier("provider/model"));
        assert!(!valid_identifier("sk-private"));
        assert!(!valid_identifier("github_pat_private"));
        assert!(!valid_identifier("bad\nvalue"));
    }

    #[test]
    fn only_reviewed_translation_protocols_are_advertised() {
        assert_eq!(
            reviewed_translation_adapter("openai-chat"),
            Some("chat-completions")
        );
        assert_eq!(
            reviewed_translation_adapter("openai-responses"),
            Some("responses")
        );
        assert_eq!(reviewed_translation_adapter("anthropic"), Some("anthropic"));
        assert_eq!(reviewed_translation_adapter("google"), Some("google"));
        assert_eq!(
            reviewed_translation_adapter("azure-openai"),
            Some("azure-openai")
        );
    }

    #[test]
    fn route_registry_is_bounded_and_expired_handles_are_removed() {
        let mut registry = RouteRegistry::default();
        for index in 0..(MAX_ROUTES + 5) {
            let handle = format!("route-{index}");
            registry.order.push_back(handle.clone());
            registry.routes.insert(
                handle,
                StoredRoute {
                    account_id: "account".into(),
                    connection_id: "opencode-cli".into(),
                    model_id: "provider/model".into(),
                    provider_id: "provider".into(),
                    upstream_model_id: "model".into(),
                    adapter: "openai-chat".into(),
                    configuration_generation: "generation".into(),
                    expires_at: if index == 0 { 1 } else { 1000 },
                },
            );
        }
        prune(&mut registry, 2);
        assert!(registry.routes.len() <= MAX_ROUTES);
        assert!(!registry.routes.contains_key("route-0"));
    }
}
