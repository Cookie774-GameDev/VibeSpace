//! Fixed native transport for the Jev decision capability.
//!
//! Jev is deliberately outside the normal chat-provider transport. The
//! renderer can save a key and request a typed operation, but the key is read
//! and attached to the request only inside this module. There is no arbitrary
//! URL, method, header, or credential-readback command here.

use std::io::Read;
use std::time::Duration;

use reqwest::blocking::{Client, Response};
use reqwest::header::{ACCEPT, CONTENT_TYPE};
use reqwest::redirect::Policy;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::credentials;

const JEV_MODELS_URL: &str = "https://api.typesafe.ai/v1/models";
const JEV_SYSTEM_ONE_URL: &str = "https://api.typesafe.ai/v1/systemone";
const JEV_API_KEY_ENV: &str = "TYPESAFE_API_KEY";
const MAX_CREDENTIAL_BYTES: usize = 32 * 1024;
const MAX_REQUEST_BYTES: usize = 128 * 1024;
const MAX_RESPONSE_BYTES: u64 = 512 * 1024;
const MAX_MODEL_COUNT: usize = 255;
const MAX_MODEL_ID_BYTES: usize = 128;
const MAX_JSON_DEPTH: usize = 12;
const MAX_JSON_ARRAY_ITEMS: usize = 256;
const MAX_JSON_OBJECT_FIELDS: usize = 128;
const MAX_JSON_STRING_BYTES: usize = 32 * 1024;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct JevModelOption {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct JevCredentialStatus {
    pub configured: bool,
}

/// Stable transport result. Error bodies and provider diagnostics never cross
/// this boundary; the client receives a small status code and, on success,
/// bounded JSON/model metadata only.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct JevHttpOutcome {
    pub kind: String,
    pub status: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub models: Option<Vec<JevModelOption>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub body: Option<Value>,
}

/// The command accepts a JSON object that is already typed and sanitized by
/// the Jev client. Rust still bounds and rejects transport/credential-shaped
/// fields before forwarding it to the one fixed POST endpoint.
#[derive(Debug, Deserialize)]
#[serde(transparent)]
pub struct JevSystemOneRequest(pub Value);

fn outcome(kind: &str, status: Option<u16>) -> JevHttpOutcome {
    JevHttpOutcome {
        kind: kind.to_string(),
        status,
        models: None,
        body: None,
    }
}

fn client() -> Result<Client, String> {
    Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(30))
        .redirect(Policy::none())
        .build()
        .map_err(|_| "native_http_unavailable".to_string())
}

fn normalize_jev_key(value: Option<String>) -> Option<String> {
    value.and_then(|value| {
        let trimmed = value.trim();
        if trimmed.is_empty() || trimmed.len() > MAX_CREDENTIAL_BYTES {
            None
        } else {
            Some(trimmed.to_string())
        }
    })
}

fn select_jev_key(vault: Option<String>, environment: Option<String>) -> Option<String> {
    normalize_jev_key(vault).or_else(|| normalize_jev_key(environment))
}

fn load_jev_key() -> Result<Option<String>, JevHttpOutcome> {
    let vault = credentials::credential_get_internal(credentials::JEV_CREDENTIAL_PROVIDER)
        .map_err(|_| outcome("storage_error", None))?;
    // The environment source is an approved machine/user credential location.
    // Keep it inside native Rust; never return, log, or serialize its value.
    let environment = std::env::var(JEV_API_KEY_ENV).ok();
    Ok(select_jev_key(vault, environment))
}

fn classify_status(status: u16) -> &'static str {
    match status {
        401 => "invalid_key",
        403 => "forbidden",
        408 | 425 | 429 | 500..=599 => "provider_error",
        _ => "provider_error",
    }
}

fn read_bounded(response: Response) -> Result<Vec<u8>, &'static str> {
    if response
        .content_length()
        .is_some_and(|length| length > MAX_RESPONSE_BYTES)
    {
        return Err("response_too_large");
    }
    let mut body = Vec::new();
    response
        .take(MAX_RESPONSE_BYTES + 1)
        .read_to_end(&mut body)
        .map_err(|_| "network")?;
    if body.len() as u64 > MAX_RESPONSE_BYTES {
        return Err("response_too_large");
    }
    Ok(body)
}

fn valid_model_id(value: &str) -> bool {
    let trimmed = value.trim();
    !trimmed.is_empty()
        && trimmed.len() <= MAX_MODEL_ID_BYTES
        && trimmed
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | '-'))
}

fn string_field(value: &Value, names: &[&str]) -> Option<String> {
    names.iter().find_map(|name| {
        value
            .get(*name)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|text| !text.is_empty())
            .map(|text| text.chars().take(MAX_MODEL_ID_BYTES).collect())
    })
}

fn parse_models(body: &[u8], secret: &str) -> Result<Vec<JevModelOption>, &'static str> {
    let value: Value = serde_json::from_slice(body).map_err(|_| "malformed")?;
    let models = value
        .get("data")
        .or_else(|| value.get("models"))
        .or_else(|| value.as_array().map(|_| &value))
        .and_then(Value::as_array)
        .ok_or("malformed")?;

    let mut parsed = Vec::with_capacity(models.len().min(MAX_MODEL_COUNT));
    for model in models.iter().take(MAX_MODEL_COUNT) {
        // TypeSafe's current catalog identifies models with `name`.
        // Validate the complete identifier; truncation could route to another model.
        let Some(id) = model
            .get("id")
            .or_else(|| model.get("model"))
            .or_else(|| model.get("name"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|id| valid_model_id(id))
        else {
            continue;
        };
        if !secret.is_empty() && id.contains(secret) {
            continue;
        }
        let label = string_field(model, &["label", "name"])
            .filter(|value| value.len() <= MAX_MODEL_ID_BYTES)
            .filter(|value| secret.is_empty() || !value.contains(secret));
        parsed.push(JevModelOption { id: id.to_string(), label });
    }
    if models.is_empty() || !parsed.is_empty() {
        return Ok(parsed);
    }
    Err("malformed")
}

fn request_models(key: &str) -> JevHttpOutcome {
    let client = match client() {
        Ok(client) => client,
        Err(_) => return outcome("network", None),
    };
    let response = match client
        .get(JEV_MODELS_URL)
        .header(ACCEPT, "application/json")
        .bearer_auth(key)
        .send()
    {
        Ok(response) => response,
        Err(_) => return outcome("network", None),
    };
    let status = response.status().as_u16();
    if !response.status().is_success() {
        return outcome(classify_status(status), Some(status));
    }
    let body = match read_bounded(response) {
        Ok(body) => body,
        Err(kind) => return outcome(kind, Some(status)),
    };
    match parse_models(&body, key) {
        Ok(models) => JevHttpOutcome {
            kind: "connected".to_string(),
            status: Some(status),
            models: Some(models),
            body: None,
        },
        Err(kind) => outcome(kind, Some(status)),
    }
}

fn sensitive_field(name: &str) -> bool {
    let canonical = name
        .chars()
        .filter(|character| character.is_ascii_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect::<String>();
    matches!(
        canonical.as_str(),
        "authorization"
            | "apikey"
            | "accesstoken"
            | "refreshtoken"
            | "credential"
            | "password"
            | "secret"
            | "token"
            | "url"
            | "method"
            | "headers"
    )
}

fn valid_question_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_MODEL_ID_BYTES
        && !value.chars().any(char::is_control)
}

fn validate_json_shape(value: &Value, depth: usize) -> Result<(), &'static str> {
    if depth > MAX_JSON_DEPTH {
        return Err("invalid_request");
    }
    match value {
        Value::Null | Value::Bool(_) | Value::Number(_) => Ok(()),
        Value::String(text) => {
            if text.len() <= MAX_JSON_STRING_BYTES {
                Ok(())
            } else {
                Err("invalid_request")
            }
        }
        Value::Array(items) => {
            if items.len() > MAX_JSON_ARRAY_ITEMS {
                return Err("invalid_request");
            }
            items
                .iter()
                .try_for_each(|item| validate_json_shape(item, depth + 1))
        }
        Value::Object(fields) => {
            if fields.len() > MAX_JSON_OBJECT_FIELDS {
                return Err("invalid_request");
            }
            for (name, field) in fields {
                if sensitive_field(name) {
                    return Err("invalid_request");
                }
                validate_json_shape(field, depth + 1)?;
            }
            Ok(())
        }
    }
}

fn exact_fields(fields: &Map<String, Value>, allowed: &[&str]) -> bool {
    fields.len() == allowed.len()
        && fields
            .keys()
            .all(|field| allowed.iter().any(|candidate| candidate == field))
}

fn validate_question_instructions(value: &Value, depth: usize) -> Result<(), &'static str> {
    validate_json_shape(value, depth)
}

fn validate_question(value: &Value, depth: usize) -> Result<(), &'static str> {
    let object = value.as_object().ok_or("invalid_request")?;
    let question_type = object
        .get("type")
        .and_then(Value::as_str)
        .ok_or("invalid_request")?;
    let instructions = object.get("instructions").ok_or("invalid_request")?;
    match question_type {
        "noul" => {
            if !exact_fields(object, &["type", "instructions", "criteria"])
                && !exact_fields(object, &["type", "instructions"])
            {
                return Err("invalid_request");
            }
            validate_question_instructions(instructions, depth + 1)?;
            if let Some(criteria) = object.get("criteria") {
                let criteria = criteria.as_object().ok_or("invalid_request")?;
                if criteria.len() > 2
                    || criteria
                        .keys()
                        .any(|key| key != "true" && key != "false")
                {
                    return Err("invalid_request");
                }
                for value in criteria.values() {
                    validate_question_instructions(value, depth + 2)?;
                }
            }
            Ok(())
        }
        "choice" => {
            if !exact_fields(object, &["type", "instructions", "criteria"]) {
                return Err("invalid_request");
            }
            validate_question_instructions(instructions, depth + 1)?;
            let criteria = object
                .get("criteria")
                .and_then(Value::as_object)
                .ok_or("invalid_request")?;
            if !(2..=MAX_JSON_OBJECT_FIELDS).contains(&criteria.len()) {
                return Err("invalid_request");
            }
            for (key, value) in criteria {
                if !valid_question_id(key) {
                    return Err("invalid_request");
                }
                validate_question_instructions(value, depth + 2)?;
            }
            Ok(())
        }
        "score" => {
            if !exact_fields(object, &["type", "instructions", "criteria"]) {
                return Err("invalid_request");
            }
            validate_question_instructions(instructions, depth + 1)?;
            let criteria = object
                .get("criteria")
                .and_then(Value::as_array)
                .ok_or("invalid_request")?;
            if !(2..=10).contains(&criteria.len()) {
                return Err("invalid_request");
            }
            for value in criteria {
                validate_question_instructions(value, depth + 2)?;
            }
            Ok(())
        }
        _ => Err("invalid_request"),
    }
}

fn validate_systemone_request(value: &Value) -> Result<(), &'static str> {
    let bytes = serde_json::to_vec(value).map_err(|_| "invalid_request")?;
    if bytes.len() > MAX_REQUEST_BYTES {
        return Err("request_too_large");
    }
    let object = value.as_object().ok_or("invalid_request")?;
    if !exact_fields(object, &["model", "state", "questions"]) {
        return Err("invalid_request");
    }
    let model = object
        .get("model")
        .and_then(Value::as_str)
        .ok_or("invalid_request")?;
    if !valid_model_id(model) {
        return Err("invalid_request");
    }
    validate_json_shape(object.get("state").ok_or("invalid_request")?, 0)?;
    let questions = object
        .get("questions")
        .and_then(Value::as_object)
        .ok_or("invalid_request")?;
    if questions.is_empty() || questions.len() > MAX_JSON_OBJECT_FIELDS {
        return Err("invalid_request");
    }
    for (id, question) in questions {
        if !valid_question_id(id) {
            return Err("invalid_request");
        }
        validate_question(question, 0)?;
    }
    Ok(())
}

fn sanitize_json(value: &Value, depth: usize, secret: &str) -> Value {
    if depth > MAX_JSON_DEPTH {
        return Value::String("[truncated]".to_string());
    }
    match value {
        Value::Object(fields) => {
            let mut sanitized = Map::new();
            for (name, field) in fields.iter().take(MAX_JSON_OBJECT_FIELDS) {
                let safe_name = if !secret.is_empty() && name.contains(secret) {
                    "[redacted]".to_string()
                } else {
                    name.clone()
                };
                sanitized.insert(
                    safe_name,
                    if sensitive_field(name) {
                        Value::String("[redacted]".to_string())
                    } else {
                        sanitize_json(field, depth + 1, secret)
                    },
                );
            }
            Value::Object(sanitized)
        }
        Value::Array(items) => Value::Array(
            items
                .iter()
                .take(MAX_JSON_ARRAY_ITEMS)
                .map(|item| sanitize_json(item, depth + 1, secret))
                .collect(),
        ),
        Value::String(text) => {
            let safe_text = if secret.is_empty() {
                text.clone()
            } else {
                text.replace(secret, "[redacted]")
            };
            if safe_text.len() <= MAX_JSON_STRING_BYTES {
                Value::String(safe_text)
            } else {
                Value::String(safe_text.chars().take(MAX_JSON_STRING_BYTES).collect())
            }
        }
        other => other.clone(),
    }
}

fn request_systemone(key: &str, request: &Value) -> JevHttpOutcome {
    if let Err(kind) = validate_systemone_request(request) {
        return outcome(kind, None);
    }
    let client = match client() {
        Ok(client) => client,
        Err(_) => return outcome("network", None),
    };
    let response = match client
        .post(JEV_SYSTEM_ONE_URL)
        .header(ACCEPT, "application/json")
        .header(CONTENT_TYPE, "application/json")
        .bearer_auth(key)
        .json(request)
        .send()
    {
        Ok(response) => response,
        Err(_) => return outcome("network", None),
    };
    let status = response.status().as_u16();
    if !response.status().is_success() {
        return outcome(classify_status(status), Some(status));
    }
    let body = match read_bounded(response) {
        Ok(body) => body,
        Err(kind) => return outcome(kind, Some(status)),
    };
    let parsed = match serde_json::from_slice::<Value>(&body) {
        Ok(value) => value,
        Err(_) => return outcome("malformed", Some(status)),
    };
    JevHttpOutcome {
        kind: "ok".to_string(),
        status: Some(status),
        models: None,
        body: Some(sanitize_json(&parsed, 0, key)),
    }
}

fn jev_caller_allowed(label: &str) -> bool {
    matches!(label, "main" | "workbench-main")
}

fn ensure_jev_caller(window: &tauri::Webview) -> Result<(), String> {
    if jev_caller_allowed(window.label()) {
        Ok(())
    } else {
        Err("jev_caller_not_authorized".to_string())
    }
}

#[tauri::command]
pub fn jev_credential_set(window: tauri::Webview, key: String) -> Result<(), String> {
    ensure_jev_caller(&window)?;
    let trimmed = key.trim();
    if trimmed.is_empty() {
        return Err("key_required".to_string());
    }
    if trimmed.len() > MAX_CREDENTIAL_BYTES {
        return Err("credential_too_large".to_string());
    }
    credentials::credential_set_internal(credentials::JEV_CREDENTIAL_PROVIDER, trimmed)?;
    let stored = credentials::credential_get_internal(credentials::JEV_CREDENTIAL_PROVIDER)?;
    if stored.as_deref().map(str::trim) == Some(trimmed) {
        Ok(())
    } else {
        Err("credential_verification_failed".to_string())
    }
}

#[tauri::command]
pub fn jev_credential_status(window: tauri::Webview) -> Result<JevCredentialStatus, String> {
    ensure_jev_caller(&window)?;
    let configured = load_jev_key()
        .map_err(|_| "credential store unavailable".to_string())?
        .is_some();
    Ok(JevCredentialStatus { configured })
}

#[tauri::command]
pub fn jev_credential_delete(window: tauri::Webview) -> Result<(), String> {
    ensure_jev_caller(&window)?;
    credentials::credential_delete_internal(credentials::JEV_CREDENTIAL_PROVIDER)
}

#[tauri::command]
pub async fn jev_http_models(window: tauri::Webview) -> JevHttpOutcome {
    if ensure_jev_caller(&window).is_err() {
        return outcome("forbidden", None);
    }
    tauri::async_runtime::spawn_blocking(|| match load_jev_key() {
        Ok(Some(key)) => request_models(&key),
        Ok(None) => outcome("missing_key", None),
        Err(result) => result,
    })
    .await
    .unwrap_or_else(|_| outcome("network", None))
}

#[tauri::command]
pub async fn jev_http_systemone(
    window: tauri::Webview,
    request: JevSystemOneRequest,
) -> JevHttpOutcome {
    if ensure_jev_caller(&window).is_err() {
        return outcome("forbidden", None);
    }
    tauri::async_runtime::spawn_blocking(move || match load_jev_key() {
        Ok(Some(key)) => request_systemone(&key, &request.0),
        Ok(None) => outcome("missing_key", None),
        Err(result) => result,
    })
    .await
    .unwrap_or_else(|_| outcome("network", None))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn key_selection_prefers_a_bounded_native_vault_value() {
        assert_eq!(
            select_jev_key(Some("  vault-key  ".into()), Some("env-key".into())).as_deref(),
            Some("vault-key")
        );
    }

    #[test]
    fn key_selection_uses_the_bounded_environment_value_when_vault_is_empty() {
        assert_eq!(
            select_jev_key(Some("  ".into()), Some("  env-key  ".into())).as_deref(),
            Some("env-key")
        );
        assert_eq!(select_jev_key(None, Some("  ".into())), None);
    }

    #[test]
    fn key_selection_rejects_an_oversized_environment_value() {
        assert_eq!(
            select_jev_key(None, Some("x".repeat(MAX_CREDENTIAL_BYTES + 1))),
            None
        );
    }

    #[test]
    fn model_parser_accepts_bounded_public_catalogs_only() {
        let models = parse_models(
            br#"{"data":[{"id":"jev-1","name":"Jev"},{"id":"bad/id"}]}"#,
            "",
        )
        .expect("catalog should parse");
        assert_eq!(models, vec![JevModelOption { id: "jev-1".into(), label: Some("Jev".into()) }]);
    }

    #[test]
    fn model_parser_rejects_unbounded_or_malformed_shapes() {
        assert_eq!(parse_models(br#"{"unexpected":[]}"#, ""), Err("malformed"));
        assert_eq!(parse_models(br#"{"data":[{"id":"bad/id"}]}"#, ""), Err("malformed"));
        let secret = "private-jev-secret";
        let models = parse_models(
            format!(r#"{{"data":[{{"id":"jev-1","name":"{secret}"}}]}}"#).as_bytes(),
            secret,
        )
        .expect("public catalog with a reflected secret should still parse");
        assert_eq!(models, vec![JevModelOption { id: "jev-1".into(), label: None }]);
    }

    #[test]
    fn model_parser_accepts_typesafe_name_identifiers_without_rewriting_them() {
        let models = parse_models(
            br#"{"models":[{"name":"jev-1","description":"Decision model","release_date":"2026-01-01"}]}"#,
            "",
        ).expect("TypeSafe name-based catalog should parse");
        assert_eq!(models[0].id, "jev-1");
        assert_eq!(models[0].label.as_deref(), Some("jev-1"));
        for id in ["x".repeat(MAX_MODEL_ID_BYTES + 1), "bad/id".into(), "private-key".into()] {
            let body = serde_json::json!({"models": [{"name": id}]}).to_string();
            assert_eq!(parse_models(body.as_bytes(), "private-key"), Err("malformed"));
        }
        let body = serde_json::json!({"models": [{"id": "x".repeat(MAX_MODEL_ID_BYTES + 1), "name": "jev-1"}]}).to_string();
        assert_eq!(parse_models(body.as_bytes(), ""), Err("malformed"));
    }

    #[test]
    fn request_validator_requires_exact_typed_systemone_shape() {
        assert_eq!(
            validate_systemone_request(&serde_json::json!({"input": []})),
            Err("invalid_request")
        );
        assert_eq!(
            validate_systemone_request(&serde_json::json!({
                "model": "jev-1",
                "state": {"bounded": true},
                "questions": {
                    "action": {
                        "type": "choice",
                        "instructions": "Choose one",
                        "criteria": {"noop": "No action", "wake": null}
                    }
                },
                "headers": {"Authorization": "Bearer secret"}
            })),
            Err("invalid_request")
        );
        assert_eq!(
            validate_systemone_request(&serde_json::json!({
                "model": "jev-1",
                "state": {"bounded": true},
                "questions": {
                    "action": {
                        "type": "choice",
                        "instructions": "Choose one",
                        "criteria": {"noop": "No action", "wake": null}
                    }
                }
            })),
            Ok(())
        );
        for question in [
            serde_json::json!({"type":"noul", "instructions":"Decide"}),
            serde_json::json!({"type":"score", "instructions":"Score", "criteria":["low", "high"]}),
        ] {
            assert_eq!(
                validate_systemone_request(&serde_json::json!({
                    "model": "jev-1",
                    "state": null,
                    "questions": {"decision": question}
                })),
                Ok(())
            );
        }
        assert_eq!(
            validate_systemone_request(&serde_json::json!({
                "model": "jev-1",
                "state": null,
                "questions": {}
            })),
            Err("invalid_request")
        );
        assert_eq!(
            validate_systemone_request(&serde_json::json!({
                "model": "jev-1",
                "state": "x".repeat(MAX_REQUEST_BYTES),
                "questions": {"decision": {"type": "noul", "instructions": "Decide"}}
            })),
            Err("request_too_large")
        );
    }

    #[test]
    fn response_sanitizer_redacts_sensitive_fields_without_logging_or_echoing_values() {
        let secret = "private-jev-secret";
        let value = sanitize_json(
            &serde_json::json!({
                "decision": "wake_main_cao",
                "apiKey": secret,
                "nested": {"token": secret}
            }),
            0,
            secret,
        );
        assert_eq!(value["decision"], "wake_main_cao");
        assert_eq!(value["apiKey"], "[redacted]");
        assert_eq!(value["nested"]["token"], "[redacted]");
        assert!(!value.to_string().contains(secret));
        let reflected = sanitize_json(
            &serde_json::json!({"message": format!("provider echoed {secret}")}),
            0,
            secret,
        );
        assert!(!reflected.to_string().contains(secret));
    }

    #[test]
    fn outcome_never_contains_a_credential_field() {
        let serialized = serde_json::to_string(&outcome("missing_key", None)).unwrap();
        assert!(!serialized.contains("credential"));
        assert!(!serialized.contains("authorization"));
    }

    #[test]
    fn caller_gate_allows_only_main_and_workbench_main() {
        assert!(jev_caller_allowed("main"));
        assert!(jev_caller_allowed("workbench-main"));
        for label in ["dictation", "pet-overlay", "browser-chat-provider", "workbench-browser-1"] {
            assert!(!jev_caller_allowed(label));
        }
    }
}
