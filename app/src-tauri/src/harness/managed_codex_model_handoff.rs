use serde_json::Value;

pub const PRIVATE_PROVIDER_ID: &str = "vibespace-connected";

/// Process-owned translation identity. Public selection and native wire model
/// stay distinct; the private provider key avoids upstream preset collisions.
#[derive(Clone)]
pub struct CodexModelHandoff {
    public_model: String,
    wire_model: String,
}

impl CodexModelHandoff {
    pub fn new(public_model: String, upstream_model: &str) -> Result<Self, String> {
        let wire_model = format!("{PRIVATE_PROVIDER_ID}/{upstream_model}");
        let valid = |value: &str| {
            !value.is_empty()
                && value.len() <= 256
                && value.bytes().all(|byte| {
                    byte.is_ascii_alphanumeric()
                        || matches!(byte, b'.' | b'_' | b':' | b'/' | b'-' | b'@' | b'+')
                })
        };
        if upstream_model.is_empty() || !valid(&public_model) || !valid(&wire_model) {
            return Err("Connected Codex wire model identity is invalid.".into());
        }
        Ok(Self {
            public_model,
            wire_model,
        })
    }

    pub fn wire_model(&self) -> &str {
        &self.wire_model
    }

    pub fn outbound(&self, message: &Value) -> Result<Value, String> {
        let mut frame = message.clone();
        if !matches!(
            message.get("method").and_then(Value::as_str),
            Some(
                "thread/start"
                    | "thread/resume"
                    | "thread/fork"
                    | "thread/queue/start"
                    | "turn/start"
            )
        ) {
            return Ok(frame);
        }
        for path in ["/params/model", "/params/collaborationMode/settings/model"] {
            if let Some(model) = frame.pointer_mut(path) {
                if model.is_null() {
                    continue;
                }
                if model.as_str() != Some(self.public_model.as_str()) {
                    return Err("Codex translation model does not match the selected route.".into());
                }
                *model = Value::String(self.wire_model.clone());
            }
        }
        Ok(frame)
    }

    pub fn inbound(&self, frame: &mut Value) {
        for path in [
            "/result/model",
            "/result/thread/model",
            "/params/thread/model",
        ] {
            if let Some(model) = frame.pointer_mut(path) {
                self.restore_public_model(model);
            }
        }
        if let Some(models) = frame
            .pointer_mut("/result/data")
            .and_then(Value::as_array_mut)
        {
            for row in models {
                if let Some(model) = row.get_mut("model") {
                    self.restore_public_model(model);
                }
            }
        }
    }

    fn restore_public_model(&self, model: &mut Value) {
        if model.as_str() == Some(self.wire_model.as_str()) {
            *model = Value::String(self.public_model.clone());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn handoff() -> CodexModelHandoff {
        CodexModelHandoff::new("opencode-go/gpt-6-luna".into(), "gpt-6-luna").unwrap()
    }

    #[test]
    fn maps_every_model_bearing_request_and_native_collaboration_preset() {
        for method in [
            "thread/start",
            "thread/resume",
            "thread/fork",
            "thread/queue/start",
            "turn/start",
        ] {
            let public = json!({"id":"request", "method":method, "params": {
                "model":"opencode-go/gpt-6-luna", "effort":"low",
                "collaborationMode":{"mode":"plan", "settings":{"model":"opencode-go/gpt-6-luna", "reasoning_effort":"low", "developer_instructions":null}},
                "input":[{"text":"Mention opencode-go/gpt-6-luna without rewriting my text."}]
            }});
            let wire = handoff().outbound(&public).unwrap();
            assert_eq!(wire["params"]["model"], "vibespace-connected/gpt-6-luna");
            assert_eq!(
                wire["params"]["collaborationMode"]["settings"]["model"],
                wire["params"]["model"]
            );
            assert_eq!(wire["params"]["input"], public["params"]["input"]);
            assert_eq!(wire["params"]["collaborationMode"]["mode"], "plan");
            assert_eq!(public["params"]["model"], "opencode-go/gpt-6-luna");
        }
    }

    #[test]
    fn rejects_other_models_and_preserves_missing_or_null_defaults() {
        for value in [
            json!("other/model"),
            json!("vibespace-connected/gpt-6-luna"),
            json!(12),
        ] {
            assert!(handoff()
                .outbound(&json!({"method":"turn/start", "params":{"model":value}}))
                .is_err());
            assert!(handoff().outbound(&json!({"method":"turn/start", "params":{"collaborationMode":{"settings":{"model":value}}}})).is_err());
        }
        for params in [json!({}), json!({"model":null})] {
            let frame = json!({"method":"thread/resume", "params":params});
            assert_eq!(handoff().outbound(&frame).unwrap(), frame);
        }
    }

    #[test]
    fn preserves_interrupts_tool_replies_and_unrelated_model_fields() {
        for frame in [
            json!({"method":"turn/interrupt", "params":{"threadId":"thread", "turnId":"turn"}}),
            json!({"id":"tool", "result":{"model":"opencode-go/gpt-6-luna"}}),
            json!({"method":"other", "params":{"model":"other/model"}}),
        ] {
            assert_eq!(handoff().outbound(&frame).unwrap(), frame);
        }
    }

    #[test]
    fn restores_public_reply_identity_without_rewriting_content_or_other_models() {
        let mut reply = json!({"result":{"model":"vibespace-connected/gpt-6-luna", "thread":{"id":"thread", "model":"vibespace-connected/gpt-6-luna"}, "data":[{"model":"vibespace-connected/gpt-6-luna"},{"model":"other/model"}], "text":"vibespace-connected/gpt-6-luna", "output":{"model":"vibespace-connected/gpt-6-luna"}}});
        handoff().inbound(&mut reply);
        assert_eq!(reply["result"]["model"], "opencode-go/gpt-6-luna");
        assert_eq!(reply["result"]["thread"]["model"], reply["result"]["model"]);
        assert_eq!(
            reply["result"]["data"][0]["model"],
            reply["result"]["model"]
        );
        assert_eq!(reply["result"]["data"][1]["model"], "other/model");
        assert_eq!(reply["result"]["text"], "vibespace-connected/gpt-6-luna");
        assert_eq!(
            reply["result"]["output"]["model"],
            "vibespace-connected/gpt-6-luna"
        );
    }

    #[test]
    fn preserves_errors_and_restores_thread_notifications() {
        let mut error = json!({"error":{"message":"403 for vibespace-connected/gpt-6-luna"}});
        let original = error.clone();
        handoff().inbound(&mut error);
        assert_eq!(error, original);
        let mut notification = json!({"method":"thread/started", "params":{"thread":{"model":"vibespace-connected/gpt-6-luna"}}});
        handoff().inbound(&mut notification);
        assert_eq!(
            notification["params"]["thread"]["model"],
            "opencode-go/gpt-6-luna"
        );
    }

    #[test]
    fn validates_wire_identity_and_preserves_slash_qualified_upstream_names() {
        assert_eq!(
            CodexModelHandoff::new("custom/friendly-model".into(), "vendor/model")
                .unwrap()
                .wire_model(),
            "vibespace-connected/vendor/model"
        );
        for model in ["", "unsafe\"model", "unsafe model", "unsafe\nmodel"] {
            assert!(CodexModelHandoff::new("custom/model".into(), model).is_err());
        }
        assert!(CodexModelHandoff::new("custom/model".into(), &"x".repeat(256)).is_err());
    }
}
