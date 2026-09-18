use serde_json::{json, Value};
use std::io::Read;
use tauri::{AppHandle, Manager};

use crate::harness::managed_codex_proxy_profile::{ManagedCodexProxyProfile, OPENCODE_GO_PROVIDER_ID};
use crate::harness::server::{opencode_server_status, OpenCodeServerState};

const KEY_ENV: &str = "VIBESPACE_CONNECTED_API_KEY";

// Native-only: never Debug/Serialize credentials or return catalog bytes to JS.
pub(in crate::harness) struct ConnectedProvider {
    provider: String,
    model: String,
    upstream_model: String,
    adapter: &'static str,
    endpoint: String,
    headers: serde_json::Map<String, Value>,
    efforts: Vec<String>,
    context_window: Option<u64>,
    pub(in crate::harness) environment: Vec<(String, String)>,
}

fn clean_value(value: &str) -> bool {
    !value.is_empty() && value.len() <= 16_384 && !value.chars().any(char::is_control)
}

fn from_catalog(catalog: &Value, qualified: &str) -> Result<ConnectedProvider, String> {
    if !super::valid_identifier(qualified, 256) {
        return Err("Invalid connected model identity.".into());
    }
    let (provider_id, model_id) = qualified
        .split_once('/')
        .ok_or("Select a provider-qualified Codex model.")?;
    if !catalog["connected"]
        .as_array()
        .is_some_and(|ids| ids.iter().any(|id| id == provider_id))
    {
        return Err("Selected provider is not connected in OpenCode.".into());
    }
    let provider = catalog["all"]
        .as_array()
        .and_then(|providers| providers.iter().find(|p| p["id"] == provider_id))
        .ok_or("Selected OpenCode provider is unavailable.")?;
    let model = provider["models"]
        .get(model_id)
        .ok_or("Selected model is not in the connected provider catalog.")?;
    let options = &provider["options"];
    let npm = model["api"]["npm"].as_str().unwrap_or_default();
    let adapter =
        match npm {
            "@ai-sdk/openai-compatible" | "@openrouter/ai-sdk-provider" => "openai-chat",
            "@ai-sdk/openai" => "openai-responses",
            "@ai-sdk/anthropic" => "anthropic",
            "@ai-sdk/google" => "google",
            "@ai-sdk/azure" => "azure-openai",
            _ => return Err(
                "This OpenCode provider protocol is not supported by the managed OpenCodex bridge."
                    .into(),
            ),
        };
    let endpoint = options["baseURL"]
        .as_str()
        .or_else(|| model["api"]["url"].as_str())
        .filter(|value| !value.is_empty())
        .or_else(|| match npm {
            "@ai-sdk/google" => Some("https://generativelanguage.googleapis.com"),
            "@ai-sdk/openai" => Some("https://api.openai.com/v1"),
            _ => None,
        })
        .ok_or("Connected provider has no resolved API endpoint.")?;
    let url =
        reqwest::Url::parse(endpoint).map_err(|_| "Connected provider endpoint is invalid.")?;
    if !(url.scheme() == "https"
        || (url.scheme() == "http"
            && matches!(url.host_str(), Some("127.0.0.1" | "localhost" | "[::1]"))))
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || endpoint.contains(['{', '}'])
    {
        return Err("Connected provider requires a resolved HTTPS or local endpoint without embedded credentials.".into());
    }
    let key = options["apiKey"].as_str().filter(|key| !key.is_empty())
        .or_else(|| provider["key"].as_str()).ok_or("Connected provider has no API credential; subscription OAuth must use its native route.")?;
    if !clean_value(key) || key.starts_with("{env:") || key.starts_with("${") {
        return Err("Connected provider credential is unresolved or invalid.".into());
    }
    let mut environment = vec![(KEY_ENV.into(), key.into())];
    let mut headers = serde_json::Map::new();
    if let Some(configured) = options["headers"].as_object() {
        if configured.len() > 64 {
            return Err("Too many connected provider headers.".into());
        }
        for (index, (name, value)) in configured.iter().enumerate() {
            reqwest::header::HeaderName::from_bytes(name.as_bytes())
                .map_err(|_| "Invalid connected provider header.")?;
            let value = value
                .as_str()
                .filter(|value| clean_value(value))
                .ok_or("Invalid connected provider header value.")?;
            let variable = format!("VIBESPACE_CONNECTED_HEADER_{index}");
            headers.insert(name.clone(), Value::String(format!("${{{variable}}}")));
            environment.push((variable, value.into()));
        }
    }
    let upstream_model = model["api"]["id"].as_str().unwrap_or(model_id);
    if !clean_value(upstream_model) || upstream_model.len() > 256 {
        return Err("Connected upstream model identity is invalid.".into());
    }
    let efforts = model["variants"]
        .as_object()
        .map(|variants| {
            ["minimal", "low", "medium", "high", "xhigh", "max"]
                .into_iter()
                .filter(|effort| {
                    variants.contains_key(*effort)
                        || (*effort == "xhigh" && variants.contains_key("ultra"))
                })
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();
    Ok(ConnectedProvider {
        provider: provider_id.into(),
        model: model_id.into(),
        upstream_model: upstream_model.into(),
        adapter,
        endpoint: endpoint.into(),
        headers,
        efforts,
        context_window: model["limit"]["context"].as_u64(),
        environment,
    })
}

pub(in crate::harness) fn resolve(app: &AppHandle, model: &str) -> Result<ConnectedProvider, String> {
    let connection = opencode_server_status(app.state::<OpenCodeServerState>())?
        .ok_or("OpenCode must be ready before selecting its model through Codex.")?;
    // Endpoint and credentials come exclusively from the owned native server.
    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| "Could not read connected providers.")?;
    let response = client
        .get(format!(
            "{}/provider",
            connection.base_url.trim_end_matches('/')
        ))
        .basic_auth(connection.username, Some(connection.password))
        .send()
        .map_err(|_| "OpenCode provider discovery failed.")?;
    if !response.status().is_success() {
        return Err("OpenCode provider discovery was rejected.".into());
    }
    let mut bytes = Vec::new();
    response
        .take(32 * 1024 * 1024 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "Could not read connected providers.")?;
    if bytes.len() > 32 * 1024 * 1024 {
        return Err("Connected provider catalog is too large.".into());
    }
    let catalog: Value =
        serde_json::from_slice(&bytes).map_err(|_| "Connected provider catalog is invalid.")?;
    from_catalog(&catalog, model)
}

impl ConnectedProvider {
    pub(in crate::harness) fn provider_id(&self) -> &str { &self.provider }
    pub(in crate::harness) fn upstream_model_id(&self) -> &str { &self.upstream_model }
    pub(in crate::harness) fn adapter_id(&self) -> &str { self.adapter }
    pub(in crate::harness) fn supported_efforts(&self) -> &[String] { &self.efforts }

    pub(in crate::harness) fn profile(&self, port: u16, session_id: &str) -> Result<ManagedCodexProxyProfile, String> {
        if port < 1024 || port == 11434 {
            return Err("Invalid managed proxy port.".into());
        }
        if !super::valid_identifier(session_id, 256) {
            return Err("Invalid managed proxy session identity.".into());
        }
        // A private ID prevents upstream built-in presets overriding a custom
        // OpenCode destination. Its alias preserves the selected public identity.
        let mut headers = self.headers.clone();
        if self.provider == OPENCODE_GO_PROVIDER_ID {
            headers.insert("x-opencode-session".into(), Value::String(session_id.into()));
            headers.entry("user-agent").or_insert_with(||
                Value::String(concat!("VibeSpace/", env!("CARGO_PKG_VERSION")).into()));
        }
        let mut provider = json!({"alias": self.provider, "adapter": self.adapter, "baseUrl": self.endpoint,
            "apiKey": format!("${{{KEY_ENV}}}"), "headers": headers, "authMode": "key",
            "models": [self.upstream_model], "defaultAliases": false});
        if self.upstream_model != self.model {
            provider["modelAliases"] = json!({self.upstream_model.clone(): self.model});
        }
        if !self.efforts.is_empty() {
            provider["modelReasoningEfforts"] = json!({self.upstream_model.clone(): self.efforts});
        }
        if let Some(context) = self.context_window.filter(|value| *value > 0) {
            provider["modelContextWindows"] = json!({self.upstream_model.clone(): context});
        }
        let model = format!("{}/{}", self.provider, self.model);
        // This newly generated profile uses the pinned runtime's current schema.
        let config = json!({"hostname":"127.0.0.1", "port":port, "openaiProviderTierVersion":2,
            "providers":{"vibespace-connected":provider}, "defaultProvider":"vibespace-connected",
            "defaultModelAliases":false, "modelPickerOrder":[model], "subagentModels":[model],
            "clientIntegrations":{"codex":true,"grok":false,"claude-desktop":false},"claudeCode":{"enabled":false}});
        Ok(ManagedCodexProxyProfile {
            opencodex_config_json: serde_json::to_vec_pretty(&config).map_err(|_| "Could not encode connected provider profile.")?,
            codex_config_toml: format!("openai_base_url = \"http://127.0.0.1:{port}/v1\"\nmodel = \"{model}\"\nmodel_provider = \"openai\"\n").into_bytes(),
            provider_environment_name: KEY_ENV,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture(npm: &str) -> Value {
        json!({"connected":["custom"], "all":[{"id":"custom","key":"test-secret-only",
        "options":{"baseURL":"https://configured.example/v1","headers":{"x-custom":"private-header"}},
        "models":{"vendor/model":{"api":{"id":"vendor/model","npm":npm,"url":"https://wrong.example/v1"}}}}]})
    }
    #[test]
    fn follows_exact_connected_endpoint_model_and_protocol_without_persisting_secrets() {
        for (npm, adapter) in [
            ("@ai-sdk/openai-compatible", "openai-chat"),
            ("@ai-sdk/anthropic", "anthropic"),
            ("@ai-sdk/google", "google"),
            ("@ai-sdk/openai", "openai-responses"),
            ("@openrouter/ai-sdk-provider", "openai-chat"),
        ] {
            let selected = from_catalog(&fixture(npm), "custom/vendor/model").unwrap();
            assert_eq!(selected.adapter, adapter);
            let profile = selected.profile(23567, "chat-1").unwrap();
            let json: Value = serde_json::from_slice(&profile.opencodex_config_json).unwrap();
            assert_eq!(
                json["providers"]["vibespace-connected"]["baseUrl"],
                "https://configured.example/v1"
            );
            assert_eq!(json["providers"]["vibespace-connected"]["alias"], "custom");
            assert_eq!(json["openaiProviderTierVersion"], 2);
            assert_eq!(selected.environment[0].1, "test-secret-only");
            let durable = String::from_utf8(profile.opencodex_config_json).unwrap();
            assert!(!durable.contains("test-secret-only"));
            assert!(!durable.contains("private-header"));
        }
    }
    #[test]
    fn rejects_missing_connection_model_unresolved_credentials_and_unsafe_endpoint() {
        let good = fixture("@ai-sdk/openai-compatible");
        assert!(from_catalog(&good, "other/vendor/model").is_err());
        assert!(from_catalog(&good, "custom/missing").is_err());
        for endpoint in [
            "http://remote.example/v1",
            "https://user:secret@host/v1",
            "https://host/v1?key=secret",
            "https://${resource}.example/v1",
        ] {
            let mut bad = good.clone();
            bad["all"][0]["options"]["baseURL"] = json!(endpoint);
            assert!(from_catalog(&bad, "custom/vendor/model").is_err());
        }
        let mut bad = good;
        bad["all"][0]["key"] = json!("${UNRESOLVED}");
        assert!(from_catalog(&bad, "custom/vendor/model").is_err());
    }
    #[test]
    fn carries_only_observed_efforts_and_supports_google_default_and_local_endpoints() {
        let mut catalog = fixture("@ai-sdk/google");
        catalog["all"][0]["options"]
            .as_object_mut()
            .unwrap()
            .remove("baseURL");
        catalog["all"][0]["models"]["vendor/model"]["api"]
            .as_object_mut()
            .unwrap()
            .remove("url");
        catalog["all"][0]["models"]["vendor/model"]["variants"] =
            json!({"low":{},"high":{},"unknown":{}});
        let selected = from_catalog(&catalog, "custom/vendor/model").unwrap();
        assert_eq!(
            selected.endpoint,
            "https://generativelanguage.googleapis.com"
        );
        let profile: Value =
            serde_json::from_slice(&selected.profile(23568, "chat-1").unwrap().opencodex_config_json)
                .unwrap();
        assert_eq!(
            profile["providers"]["vibespace-connected"]["modelReasoningEfforts"]["vendor/model"],
            json!(["low", "high"])
        );
        catalog["all"][0]["options"]["baseURL"] = json!("http://127.0.0.1:8000/v1");
        assert!(from_catalog(&catalog, "custom/vendor/model").is_ok());
        assert!(from_catalog(&catalog, "custom/\"bad").is_err());
    }

    #[test]
    fn opencode_go_translation_adds_the_required_session_header_from_native_owner_identity() {
        let mut catalog = fixture("@ai-sdk/openai-compatible");
        catalog["connected"] = json!([OPENCODE_GO_PROVIDER_ID]);
        catalog["all"][0]["id"] = json!(OPENCODE_GO_PROVIDER_ID);
        catalog["all"][0]["options"]["baseURL"] = json!("https://opencode.ai/zen/go/v1");
        let selected = from_catalog(&catalog, "opencode-go/vendor/model").unwrap();
        let profile = selected.profile(23569, "chat-session-123").unwrap();
        let json: Value = serde_json::from_slice(&profile.opencodex_config_json).unwrap();
        let headers = &json["providers"]["vibespace-connected"]["headers"];
        assert_eq!(headers["x-opencode-session"], "chat-session-123");
        assert_eq!(headers["user-agent"], concat!("VibeSpace/", env!("CARGO_PKG_VERSION")));
        assert!(!String::from_utf8(profile.opencodex_config_json).unwrap().contains("test-secret-only"));
        assert!(selected.profile(23569, "bad session").is_err());
    }
}
