use std::fs;
use std::path::{Path, PathBuf};

use serde_json::{json, Value};
use url::Url;

const CONFIG_SCHEMA: &str = "https://opencode.ai/config.json";
const PLUGIN_DIRECTORY: &str = "terminal-identity/plugins";
const PLUGIN_FILE_NAME: &str = "vibespace-terminal-identity.ts";

/// This source is materialized only into VibeSpace's app-local data directory
/// and is loaded through OPENCODE_CONFIG_CONTENT for directly managed panes.
/// It observes OpenCode's official chat.message hook, then uses the inherited
/// authenticated VibeSpace CLI shim. It never reads or carries credentials.
pub const TERMINAL_IDENTITY_PLUGIN_SOURCE: &str = r#"import type { Plugin } from "@opencode-ai/plugin"

const safe = (value: unknown, maximum: number) =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= maximum &&
  /^[A-Za-z0-9][A-Za-z0-9._:/@+\-]*$/.test(value)

const record = (value: unknown) =>
  value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined

export default (async ({ $ }) => {
  const inFlight = new Set<string>()
  const published = new Map<string, string>()
  const publish = (sessionID: unknown, modelValue: unknown, variant: unknown) => {
    const processInstanceId = process.env.VIBESPACE_TERMINAL_PROCESS_INSTANCE_ID
    const model = record(modelValue)
    const providerID = model?.providerID
    const modelID = model?.modelID ?? model?.id
    if (
      !safe(processInstanceId, 200) ||
      !safe(sessionID, 512) ||
      !safe(providerID, 128) ||
      !safe(modelID, 512) ||
      !safe(variant, 128)
    ) return
    const key = `${sessionID}\u0000${providerID}\u0000${modelID}\u0000${variant}\u0000${processInstanceId}`
    if (inFlight.has(key) || published.get(String(sessionID)) === key) return
    inFlight.add(key)
    void $`vibespace-context --json cao identity publish --opencode-session ${sessionID} --provider ${providerID} --model ${modelID} --variant ${variant} --process-instance ${processInstanceId}`
      .then(() => published.set(String(sessionID), key))
      .catch(() => {})
      .finally(() => inFlight.delete(key))
  }

  return {
    // chat.message may omit model/variant. When present it is a useful early
    // observation, but it never blocks the OpenCode turn on the CLI shim.
    "chat.message": async (input) => {
      published.delete(input.sessionID)
      publish(input.sessionID, input.model, input.variant)
    },
    // chat.params has the resolved model and the selected variant on the
    // authoritative user message, including default model turns.
    "chat.params": async (input) => {
      const message = record(input.message)
      const messageModel = record(message?.model)
      publish(input.sessionID, input.model, message?.variant ?? messageModel?.variant)
    },
    // The assistant event is the post-dispatch receipt. Current OpenCode
    // emits provider/model/variant here; absent variant remains unavailable.
    event: async ({ event }) => {
      if (event.type !== "message.updated") return
      const properties = record(event.properties)
      const info = record(properties?.info)
      if (info?.role !== "assistant") return
      publish(info.sessionID, info, info.variant)
    },
  }
}) satisfies Plugin
"#;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MaterializedTerminalIdentityPlugin {
    pub plugin_path: PathBuf,
    pub config_content: String,
}

fn merge_config_content(
    existing: Option<&str>,
    plugin_spec: &str,
) -> Result<Option<String>, String> {
    let mut config = match existing {
        Some(raw) => match serde_json::from_str::<Value>(raw) {
            Ok(value) => value,
            Err(_) => return Ok(None),
        },
        None => json!({"$schema": CONFIG_SCHEMA}),
    };
    let Some(object) = config.as_object_mut() else {
        return Ok(None);
    };
    let plugins = object
        .entry("plugin")
        .or_insert_with(|| Value::Array(Vec::new()));
    let Some(plugins) = plugins.as_array_mut() else {
        return Ok(None);
    };
    if !plugins
        .iter()
        .any(|candidate| candidate.as_str() == Some(plugin_spec))
    {
        plugins.push(Value::String(plugin_spec.to_string()));
    }
    serde_json::to_string(&config)
        .map(Some)
        .map_err(|_| "terminal identity OpenCode config could not be serialized".to_string())
}

/// Materialize the product-owned plugin and a final local config merge. The
/// user's config files are never opened or modified; an inherited inline
/// config is preserved field-for-field except for appending this plugin.
pub fn materialize(
    app_local_data_dir: &Path,
    existing_config_content: Option<&str>,
) -> Result<Option<MaterializedTerminalIdentityPlugin>, String> {
    let plugin_path = app_local_data_dir
        .join(PLUGIN_DIRECTORY)
        .join(PLUGIN_FILE_NAME);
    let plugin_spec = Url::from_file_path(&plugin_path)
        .map_err(|_| "terminal identity plugin path could not be represented".to_string())?
        .to_string();
    let Some(config_content) = merge_config_content(existing_config_content, &plugin_spec)? else {
        return Ok(None);
    };

    let plugin_directory = plugin_path
        .parent()
        .ok_or_else(|| "terminal identity plugin directory unavailable".to_string())?;
    fs::create_dir_all(plugin_directory)
        .map_err(|_| "terminal identity plugin directory unavailable".to_string())?;
    fs::write(&plugin_path, TERMINAL_IDENTITY_PLUGIN_SOURCE)
        .map_err(|_| "terminal identity plugin could not be materialized".to_string())?;

    Ok(Some(MaterializedTerminalIdentityPlugin {
        plugin_path,
        config_content,
    }))
}

#[cfg(test)]
mod tests {
    use std::fs;

    use serde_json::Value;

    use super::{materialize, TERMINAL_IDENTITY_PLUGIN_SOURCE};

    fn fixture_root(label: &str) -> std::path::PathBuf {
        let root = std::env::temp_dir().join(format!(
            "vibespace-terminal-identity-plugin-{label}-{}",
            nanoid::nanoid!(10)
        ));
        fs::create_dir_all(&root).expect("fixture root");
        root
    }

    #[test]
    fn materializes_product_plugin_and_preserves_inline_user_config() {
        let root = fixture_root("merge");
        let result = materialize(
            &root,
            Some(r#"{"model":"openrouter/deepseek/deepseek-v4-flash","plugin":["user-plugin"]}"#),
        )
        .expect("materialize")
        .expect("valid config should receive plugin");

        assert!(result.plugin_path.is_file());
        let config: Value = serde_json::from_str(&result.config_content).expect("config JSON");
        assert_eq!(config["model"], "openrouter/deepseek/deepseek-v4-flash");
        assert_eq!(config["plugin"][0], "user-plugin");
        assert_eq!(config["plugin"].as_array().unwrap().len(), 2);
        let source = fs::read_to_string(&result.plugin_path).expect("plugin source");
        assert!(source.contains("\"chat.message\""));
        assert!(source.contains("\"chat.params\""));
        assert!(source.contains("input.message"));
        assert!(source.contains("message?.variant"));
        assert!(source.contains("messageModel?.variant"));
        assert!(source.contains("\"message.updated\""));
        assert!(source.contains("published"));
        assert!(source.contains("void $"));
        assert!(!source.contains("await $"));
        assert!(source.contains("input.sessionID"));
        assert!(source.contains("model?.providerID"));
        assert!(source.contains("model?.modelID"));
        assert!(source.contains("input.variant"));
        assert!(source.contains("cao identity publish"));
        assert!(!source.contains("TOKEN"));
        assert!(!source.contains("Authorization"));

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn new_inline_config_has_only_schema_and_owned_plugin() {
        let root = fixture_root("new");
        let result = materialize(&root, None)
            .expect("materialize")
            .expect("new config should receive plugin");
        let config: Value = serde_json::from_str(&result.config_content).expect("config JSON");
        assert_eq!(config["$schema"], "https://opencode.ai/config.json");
        assert_eq!(config["plugin"].as_array().unwrap().len(), 1);
        assert!(config["plugin"][0]
            .as_str()
            .unwrap()
            .starts_with("file:///"));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn malformed_or_non_array_user_inline_config_is_left_untouched() {
        let root = fixture_root("invalid");
        assert!(materialize(&root, Some("not-json")).unwrap().is_none());
        assert!(materialize(&root, Some(r#"{"plugin":"user-plugin"}"#))
            .unwrap()
            .is_none());
        assert!(!root
            .join("terminal-identity/plugins/vibespace-terminal-identity.ts")
            .exists());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn plugin_source_has_no_provider_or_credential_transport() {
        for forbidden in [
            "fetch(",
            "Authorization",
            "apiKey",
            "credential",
            "VIBESPACE_TOOL_GATEWAY_TOKEN",
        ] {
            assert!(!TERMINAL_IDENTITY_PLUGIN_SOURCE.contains(forbidden));
        }
    }
}
