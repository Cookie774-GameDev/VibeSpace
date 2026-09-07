use serde_json::json;
use std::net::Ipv4Addr;

pub const OPENCODE_GO_API_KEY_ENV: &str = "VIBESPACE_OPENCODE_GO_API_KEY";
pub const OPENCODE_GO_PROVIDER_ID: &str = "opencode-go";
pub const OPENCODE_GO_BASE_URL: &str = "https://opencode.ai/zen/go/v1";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ManagedCodexProxyProfile {
    pub opencodex_config_json: Vec<u8>,
    pub codex_config_toml: Vec<u8>,
    pub provider_environment_name: &'static str,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ManagedCodexProxyProfileError {
    NonLoopback,
    UnsafePort,
    InvalidModel,
    InvalidSession,
    Encoding,
}

fn valid_model(model: &str) -> bool {
    let Some(native) = model.strip_prefix("opencode-go/") else {
        return false;
    };
    !native.is_empty()
        && model.len() <= 256
        && model.bytes().all(|byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'/' | b'-')
        })
}

/// Builds the two isolated profile files used only by VibeSpace-owned child processes.
/// The provider key is intentionally represented by an environment reference; callers
/// must never replace the reference in these durable bytes.
pub fn build_managed_codex_proxy_profile(
    host: Ipv4Addr,
    port: u16,
    model: &str,
    session_id: &str,
) -> Result<ManagedCodexProxyProfile, ManagedCodexProxyProfileError> {
    if host != Ipv4Addr::LOCALHOST {
        return Err(ManagedCodexProxyProfileError::NonLoopback);
    }
    if port < 1024 || port == 11_434 {
        return Err(ManagedCodexProxyProfileError::UnsafePort);
    }
    if !valid_model(model) {
        return Err(ManagedCodexProxyProfileError::InvalidModel);
    }
    if session_id.is_empty() || session_id.len() > 256 || !session_id.bytes().all(|byte| {
        byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'@' | b'/' | b'-')
    }) {
        return Err(ManagedCodexProxyProfileError::InvalidSession);
    }

    let config = json!({
        "port": port,
        "hostname": host.to_string(),
        "providers": {
            OPENCODE_GO_PROVIDER_ID: {
                "adapter": "openai-chat",
                "baseUrl": OPENCODE_GO_BASE_URL,
                "apiKey": format!("${{{OPENCODE_GO_API_KEY_ENV}}}"),
                "headers": {
                    "x-opencode-session": session_id,
                    "user-agent": concat!("VibeSpace/", env!("CARGO_PKG_VERSION")),
                },
                "defaultAliases": false
            }
        },
        "defaultProvider": OPENCODE_GO_PROVIDER_ID,
        "defaultModelAliases": false,
        "modelPickerOrder": [model],
        "subagentModels": [model],
        "clientIntegrations": {
            "codex": true,
            "grok": false,
            "claude-desktop": false
        },
        "claudeCode": {
            "enabled": false
        }
    });
    let mut opencodex_config_json =
        serde_json::to_vec_pretty(&config).map_err(|_| ManagedCodexProxyProfileError::Encoding)?;
    opencodex_config_json.push(b'\n');
    let codex_config_toml = format!(
        "# Managed by VibeSpace inside an isolated CODEX_HOME.\nopenai_base_url = \"http://{host}:{port}/v1\"\nmodel = \"{model}\"\nmodel_provider = \"openai\"\n"
    )
    .into_bytes();

    Ok(ManagedCodexProxyProfile {
        opencodex_config_json,
        codex_config_toml,
        provider_environment_name: OPENCODE_GO_API_KEY_ENV,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const MODEL: &str = "opencode-go/deepseek-v4-flash-vision-exp";

    #[test]
    fn profile_is_loopback_exact_provider_and_environment_only() {
        let profile =
            build_managed_codex_proxy_profile(Ipv4Addr::LOCALHOST, 10_100, MODEL, "chat_1").expect("profile");
        let config: serde_json::Value =
            serde_json::from_slice(&profile.opencodex_config_json).expect("config JSON");
        assert_eq!(config["hostname"], "127.0.0.1");
        assert_eq!(config["port"], 10_100);
        assert_eq!(config["defaultProvider"], OPENCODE_GO_PROVIDER_ID);
        assert_eq!(
            config["providers"][OPENCODE_GO_PROVIDER_ID]["baseUrl"],
            OPENCODE_GO_BASE_URL
        );
        assert_eq!(
            config["providers"][OPENCODE_GO_PROVIDER_ID]["apiKey"],
            format!("${{{OPENCODE_GO_API_KEY_ENV}}}")
        );
        assert_eq!(config["clientIntegrations"]["codex"], true);
        assert_eq!(config["clientIntegrations"]["grok"], false);
        assert_eq!(config["clientIntegrations"]["claude-desktop"], false);
        assert_eq!(config["claudeCode"]["enabled"], false);
        assert_eq!(profile.provider_environment_name, OPENCODE_GO_API_KEY_ENV);
        assert_eq!(config["providers"][OPENCODE_GO_PROVIDER_ID]["headers"]["x-opencode-session"], "chat_1");
        assert_eq!(config["providers"][OPENCODE_GO_PROVIDER_ID]["headers"]["user-agent"], concat!("VibeSpace/", env!("CARGO_PKG_VERSION")));
    }

    #[test]
    fn session_header_is_stable_per_chat_and_rejects_header_injection() {
        let profile = |session| build_managed_codex_proxy_profile(Ipv4Addr::LOCALHOST, 10_100, MODEL, session);
        assert_eq!(profile("chat_1"), profile("chat_1"));
        assert_ne!(profile("chat_1"), profile("chat_2"));
        for invalid in ["", "chat\r\nx-api-key: bad", "chat one"] {
            assert_eq!(profile(invalid).err(), Some(ManagedCodexProxyProfileError::InvalidSession));
        }
    }

    #[test]
    fn codex_profile_routes_responses_to_the_exact_owned_proxy() {
        let profile =
            build_managed_codex_proxy_profile(Ipv4Addr::LOCALHOST, 23_417, MODEL, "chat_1").expect("profile");
        let codex = String::from_utf8(profile.codex_config_toml).expect("UTF-8");
        assert!(codex.contains("openai_base_url = \"http://127.0.0.1:23417/v1\""));
        assert!(codex.contains(&format!("model = \"{MODEL}\"")));
        assert!(codex.contains("model_provider = \"openai\""));
        assert!(!codex.to_ascii_lowercase().contains("ollama"));
        assert!(!codex.contains(OPENCODE_GO_API_KEY_ENV));
    }

    #[test]
    fn rejects_non_loopback_unsafe_ports_and_nonqualified_models() {
        assert_eq!(
            build_managed_codex_proxy_profile(Ipv4Addr::UNSPECIFIED, 10_100, MODEL, "chat_1").err(),
            Some(ManagedCodexProxyProfileError::NonLoopback)
        );
        for port in [0, 1_023, 11_434] {
            assert_eq!(
                build_managed_codex_proxy_profile(Ipv4Addr::LOCALHOST, port, MODEL, "chat_1").err(),
                Some(ManagedCodexProxyProfileError::UnsafePort)
            );
        }
        for model in [
            "deepseek-v4-flash-vision-exp",
            "opencode-go/",
            "opencode-go/bad model",
            "other/deepseek-v4-flash-vision-exp",
        ] {
            assert_eq!(
                build_managed_codex_proxy_profile(Ipv4Addr::LOCALHOST, 10_100, model, "chat_1").err(),
                Some(ManagedCodexProxyProfileError::InvalidModel)
            );
        }
    }
}
