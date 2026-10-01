//! Ollama HTTP via Rust `reqwest` — the CORS/Origin-free path.
//!
//! ROOT CAUSE this module fixes: on Windows the Tauri v2 WebView origin is
//! `http://tauri.localhost`, which Ollama's default origin allow-list rejects
//! with `403 Forbidden`. The Tauri HTTP plugin forwards that origin and strips
//! any manual `Origin` override (it's a forbidden header), so browser-side
//! requests to the local daemon 403 on /api/pull, /api/tags and chat.
//!
//! `reqwest` (a non-browser client) sends NO `Origin` header, which Ollama
//! always accepts — exactly like the `ollama` CLI. So we proxy pull/list/chat
//! through here. This is fully silent and works out-of-the-box regardless of
//! whether the user, the OS, or Jarvis started the daemon.
//!
//! Only loopback endpoints are allowed (defense-in-depth, mirrors local_ai.rs).

use std::io::{BufRead, BufReader, Read};
use std::time::{Duration, Instant};

use reqwest::blocking::Client;
use serde::Serialize;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter};

const OLLAMA_BASE: &str = "http://127.0.0.1:11434";
const MAX_MODEL_DETAILS_BYTES: u64 = 2 * 1024 * 1024;
const MAX_TOOL_PROBE_BYTES: u64 = 1024 * 1024;

fn resolve_base(base_url: Option<String>) -> String {
    let trimmed = base_url
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| OLLAMA_BASE.to_string());
    trimmed.trim_end_matches('/').to_string()
}

fn is_allowed_local_endpoint(base_url: &str) -> bool {
    let Ok(url) = reqwest::Url::parse(base_url) else {
        return false;
    };

    if url.scheme() != "http" {
        return false;
    }

    matches!(
        url.host_str(),
        Some("127.0.0.1") | Some("localhost") | Some("[::1]")
    )
}

fn check_ollama_api(base_url: &str, timeout_secs: u64) -> bool {
    if !is_allowed_local_endpoint(base_url) {
        return false;
    }

    let Ok(client) = build_client(timeout_secs) else {
        return false;
    };

    client
        .get(format!("{base_url}/api/version"))
        .send()
        .map(|response| response.status().is_success())
        .unwrap_or(false)
}

/// Fast loopback health check — used by the UI before listing models.
#[tauri::command]
pub fn ollama_ping(base_url: Option<String>) -> bool {
    check_ollama_api(&resolve_base(base_url), 5)
}

fn build_client(timeout_secs: u64) -> Result<Client, String> {
    let mut builder = Client::builder();
    if timeout_secs > 0 {
        builder = builder.timeout(Duration::from_secs(timeout_secs));
    } else {
        builder = builder.timeout(None);
    }
    builder.build().map_err(|e| e.to_string())
}

/// Basic model-name guard: letters, digits, `_ . - / :` only. Mirrors the
/// frontend validator; rejects path traversal / shell metacharacters.
fn valid_model_name(name: &str) -> bool {
    let n = name.trim();
    if n.is_empty() || n.len() > 128 {
        return false;
    }
    n.chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-' | '/' | ':'))
        && !n.contains("..")
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OllamaModel {
    name: String,
    digest: Option<String>,
    size: Option<u64>,
    modified_at: Option<String>,
}

/// List installed models via GET /api/tags. Fast; returns [] on any failure
/// so the UI can show a friendly "no models / start Ollama" state.
#[tauri::command]
pub fn ollama_list_models(base_url: Option<String>) -> Result<Vec<OllamaModel>, String> {
    let base = resolve_base(base_url);
    if !is_allowed_local_endpoint(&base) {
        return Err("invalid_base_url".to_string());
    }
    let client = build_client(15)?;
    let resp = client
        .get(format!("{base}/api/tags"))
        .send()
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("status_{}", resp.status().as_u16()));
    }
    let text = resp.text().map_err(|e| e.to_string())?;
    let value: serde_json::Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    if let Some(models) = value.get("models").and_then(|m| m.as_array()) {
        for m in models {
            if let Some(name) = m.get("name").and_then(|n| n.as_str()) {
                out.push(OllamaModel {
                    name: name.to_string(),
                    digest: m
                        .get("digest")
                        .and_then(|digest| digest.as_str())
                        .map(str::to_string),
                    size: m.get("size").and_then(|s| s.as_u64()),
                    modified_at: m
                        .get("modified_at")
                        .and_then(|s| s.as_str())
                        .map(str::to_string),
                });
            }
        }
    }
    Ok(out)
}

fn read_bounded_response(
    response: reqwest::blocking::Response,
    maximum_bytes: u64,
) -> Result<Vec<u8>, String> {
    let mut bounded = response.take(maximum_bytes + 1);
    let mut body = Vec::new();
    bounded.read_to_end(&mut body).map_err(|e| e.to_string())?;
    if body.len() as u64 > maximum_bytes {
        return Err("response_too_large".to_string());
    }
    Ok(body)
}

fn context_window_tokens(value: &serde_json::Value) -> Option<u64> {
    value
        .get("model_info")
        .and_then(|info| info.as_object())
        .and_then(|info| {
            info.iter()
                .filter(|(key, _)| key.ends_with(".context_length"))
                .filter_map(|(_, value)| value.as_u64())
                .max()
        })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OllamaModelDetails {
    digest: String,
    capabilities: Vec<String>,
    context_window_tokens: Option<u64>,
}

fn show_model_blocking(
    model: String,
    base_url: Option<String>,
) -> Result<OllamaModelDetails, String> {
    if !valid_model_name(&model) {
        return Err("invalid_model".to_string());
    }
    let base = resolve_base(base_url);
    if !is_allowed_local_endpoint(&base) {
        return Err("invalid_base_url".to_string());
    }
    let response = build_client(15)?
        .post(format!("{base}/api/show"))
        .json(&serde_json::json!({ "model": model, "verbose": false }))
        .send()
        .map_err(|e| e.to_string())?;
    if !response.status().is_success() {
        return Err(format!("status_{}", response.status().as_u16()));
    }
    let body = read_bounded_response(response, MAX_MODEL_DETAILS_BYTES)?;
    let value: serde_json::Value = serde_json::from_slice(&body).map_err(|e| e.to_string())?;
    let capabilities = value
        .get("capabilities")
        .and_then(|capabilities| capabilities.as_array())
        .into_iter()
        .flatten()
        .filter_map(|capability| capability.as_str())
        .take(32)
        .map(|capability| capability.chars().take(64).collect())
        .collect();
    let digest = format!("sha256:{:x}", Sha256::digest(&body));
    Ok(OllamaModelDetails {
        digest,
        capabilities,
        context_window_tokens: context_window_tokens(&value),
    })
}

/// Read bounded model metadata used by the local-agent compatibility layer.
#[tauri::command]
pub async fn ollama_show_model(
    model: String,
    base_url: Option<String>,
) -> Result<OllamaModelDetails, String> {
    tauri::async_runtime::spawn_blocking(move || show_model_blocking(model, base_url))
        .await
        .map_err(|_| "model_details_worker_failed".to_string())?
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OllamaToolProbe {
    supported: bool,
    reason: Option<&'static str>,
}

fn probe_tools_blocking(
    model: String,
    base_url: Option<String>,
) -> Result<OllamaToolProbe, String> {
    if !valid_model_name(&model) {
        return Err("invalid_model".to_string());
    }
    let base = resolve_base(base_url);
    if !is_allowed_local_endpoint(&base) {
        return Err("invalid_base_url".to_string());
    }
    let response = build_client(30)?
        .post(format!("{base}/api/chat"))
        .json(&serde_json::json!({
            "model": model,
            "stream": false,
            "messages": [{
                "role": "user",
                "content": "Call compatibility_check exactly once with ok set to true."
            }],
            "tools": [{
                "type": "function",
                "function": {
                    "name": "compatibility_check",
                    "description": "Side-effect-free local compatibility check.",
                    "parameters": {
                        "type": "object",
                        "properties": { "ok": { "type": "boolean" } },
                        "required": ["ok"]
                    }
                }
            }],
            "options": { "temperature": 0, "num_predict": 32 }
        }))
        .send()
        .map_err(|e| e.to_string())?;
    if !response.status().is_success() {
        return Ok(OllamaToolProbe {
            supported: false,
            reason: Some("Ollama rejected the safe tool probe."),
        });
    }
    let body = read_bounded_response(response, MAX_TOOL_PROBE_BYTES)?;
    let value: serde_json::Value = serde_json::from_slice(&body).map_err(|e| e.to_string())?;
    let supported = value
        .pointer("/message/tool_calls")
        .and_then(|calls| calls.as_array())
        .map(|calls| !calls.is_empty())
        .unwrap_or(false);
    Ok(OllamaToolProbe {
        supported,
        reason: (!supported).then_some("No tool call was returned."),
    })
}

/// Run one tiny, side-effect-free tool-schema roundtrip. The advertised tool
/// has no executor and cannot read or write files.
#[tauri::command]
pub async fn ollama_probe_tools(
    model: String,
    base_url: Option<String>,
) -> Result<OllamaToolProbe, String> {
    tauri::async_runtime::spawn_blocking(move || probe_tools_blocking(model, base_url))
        .await
        .map_err(|_| "tool_probe_worker_failed".to_string())?
}

/// Best-effort model discovery for the private OpenCode server. This is
/// deliberately fixed to the default loopback daemon and never starts Ollama.
pub(crate) fn harness_model_names() -> Vec<String> {
    ollama_list_models(Some(OLLAMA_BASE.to_string()))
        .unwrap_or_default()
        .into_iter()
        .map(|model| model.name)
        .collect()
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct PullProgress {
    status: String,
    total: Option<u64>,
    completed: Option<u64>,
    percent: Option<f64>,
    done: bool,
    error: Option<String>,
}

/// Pull a model via POST /api/pull (NDJSON stream). Runs on a worker thread so
/// the UI never blocks; emits `ollama:pull-progress` events with a final
/// `done: true` (or `error`). Returns immediately after spawning.
#[tauri::command]
pub fn ollama_pull_model(
    app: AppHandle,
    model: String,
    base_url: Option<String>,
) -> Result<(), String> {
    if !valid_model_name(&model) {
        return Err("invalid_model_name".to_string());
    }
    let base = resolve_base(base_url);
    if !is_allowed_local_endpoint(&base) {
        return Err("invalid_base_url".to_string());
    }
    let name = model.trim().to_string();

    std::thread::spawn(move || {
        let emit = |p: PullProgress| {
            let _ = app.emit("ollama:pull-progress", p);
        };
        let client = match build_client(0) {
            Ok(c) => c,
            Err(e) => {
                emit(PullProgress {
                    status: "error".into(),
                    total: None,
                    completed: None,
                    percent: None,
                    done: true,
                    error: Some(e),
                });
                return;
            }
        };
        let pull_body = serde_json::json!({ "name": name, "stream": true }).to_string();
        let resp = match client
            .post(format!("{base}/api/pull"))
            .header("content-type", "application/json")
            .body(pull_body)
            .send()
        {
            Ok(r) => r,
            Err(e) => {
                emit(PullProgress {
                    status: "error".into(),
                    total: None,
                    completed: None,
                    percent: None,
                    done: true,
                    error: Some(format!("connect: {e}")),
                });
                return;
            }
        };
        let status = resp.status();
        if !status.is_success() {
            emit(PullProgress {
                status: "error".into(),
                total: None,
                completed: None,
                percent: None,
                done: true,
                error: Some(format!("status_{}", status.as_u16())),
            });
            return;
        }

        let reader = BufReader::new(resp);
        let mut saw_success = false;
        let mut last_emit = Instant::now();
        let mut emit_throttled = |p: PullProgress, force: bool| {
            if force || last_emit.elapsed() >= Duration::from_millis(120) {
                emit(p);
                last_emit = Instant::now();
            }
        };
        for line in reader.lines() {
            let line = match line {
                Ok(l) => l,
                Err(_) => break,
            };
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            let Ok(v) = serde_json::from_str::<serde_json::Value>(trimmed) else {
                continue;
            };
            if let Some(err) = v.get("error").and_then(|e| e.as_str()) {
                emit(PullProgress {
                    status: "error".into(),
                    total: None,
                    completed: None,
                    percent: None,
                    done: true,
                    error: Some(err.to_string()),
                });
                return;
            }
            let st = v
                .get("status")
                .and_then(|s| s.as_str())
                .unwrap_or("downloading")
                .to_string();
            let total = v.get("total").and_then(|x| x.as_u64());
            let completed = v.get("completed").and_then(|x| x.as_u64());
            let percent = match (total, completed) {
                (Some(t), Some(c)) if t > 0 => {
                    Some(((c as f64 / t as f64) * 100.0).clamp(0.0, 100.0))
                }
                _ => None,
            };
            if st == "success" {
                saw_success = true;
            }
            emit_throttled(
                PullProgress {
                    status: st,
                    total,
                    completed,
                    percent,
                    done: false,
                    error: None,
                },
                false,
            );
        }
        emit_throttled(
            PullProgress {
                status: if saw_success {
                    "success".into()
                } else {
                    "success".into()
                },
                total: None,
                completed: None,
                percent: Some(100.0),
                done: true,
                error: None,
            },
            true,
        );
    });

    Ok(())
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ChatDelta {
    delta: String,
    done: bool,
    error: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OllamaChatResult {
    text: String,
    input_tokens: Option<u64>,
    output_tokens: Option<u64>,
}

/// Reliable native chat completion. Unlike the event-only compatibility
/// command below, this returns the completed text through Tauri IPC so a
/// missed WebView event can never leave the chat waiting forever.
#[tauri::command]
pub async fn ollama_chat(
    model: String,
    messages: serde_json::Value,
    options: serde_json::Value,
    think: bool,
    base_url: Option<String>,
) -> Result<OllamaChatResult, String> {
    if !valid_model_name(&model) {
        return Err("invalid_model_name".to_string());
    }
    let base = resolve_base(base_url);
    if !is_allowed_local_endpoint(&base) {
        return Err("invalid_base_url".to_string());
    }
    let name = model.trim().to_string();
    tauri::async_runtime::spawn_blocking(move || {
        let client = build_client(180)?;
        let body = serde_json::json!({
            "model": name,
            "messages": messages,
            "stream": false,
            "think": think,
            "keep_alive": "15m",
            "options": options,
        });
        let response = client
            .post(format!("{base}/api/chat"))
            .json(&body)
            .send()
            .map_err(|error| format!("connect: {error}"))?;
        let status = response.status();
        if !status.is_success() {
            return Err(format!("status_{}", status.as_u16()));
        }
        let value: serde_json::Value = response.json().map_err(|error| error.to_string())?;
        if let Some(error) = value.get("error").and_then(|entry| entry.as_str()) {
            return Err(error.to_string());
        }
        let text = value
            .pointer("/message/content")
            .and_then(|entry| entry.as_str())
            .unwrap_or_default()
            .to_string();
        if text.trim().is_empty() {
            return Err("empty_response".to_string());
        }
        Ok(OllamaChatResult {
            text,
            input_tokens: value
                .get("prompt_eval_count")
                .and_then(|entry| entry.as_u64()),
            output_tokens: value.get("eval_count").and_then(|entry| entry.as_u64()),
        })
    })
    .await
    .map_err(|error| format!("worker: {error}"))?
}

/// Stream a chat completion via POST /api/chat (NDJSON). Runs on a worker
/// thread; emits `ollama:chat:<requestId>` events with incremental `delta`s
/// and a final `done: true` (or `error`). `messages` is the OpenAI-style
/// array `[{role, content}]`.
#[tauri::command]
pub async fn ollama_chat_stream(
    app: AppHandle,
    request_id: String,
    model: String,
    messages: serde_json::Value,
    temperature: Option<f64>,
    options: Option<serde_json::Value>,
    think: Option<bool>,
    base_url: Option<String>,
) -> Result<OllamaChatResult, String> {
    if !valid_model_name(&model) {
        return Err("invalid_model_name".to_string());
    }
    let base = resolve_base(base_url);
    if !is_allowed_local_endpoint(&base) {
        return Err("invalid_base_url".to_string());
    }
    let event = format!("ollama:chat:{request_id}");
    let name = model.trim().to_string();
    let temp = temperature.unwrap_or(0.45);
    let request_options = options.unwrap_or_else(|| {
        serde_json::json!({
            "temperature": temp,
            "num_ctx": 4096,
            "num_predict": 320,
            "repeat_penalty": 1.18,
            "top_p": 0.9
        })
    });
    let request_think = think.unwrap_or(false);

    tauri::async_runtime::spawn_blocking(move || {
        let emit = |d: ChatDelta| {
            let _ = app.emit(event.as_str(), d);
        };
        let client = match build_client(180) {
            Ok(c) => c,
            Err(e) => {
                emit(ChatDelta {
                    delta: String::new(),
                    done: true,
                    error: Some(e.clone()),
                });
                return Err(e);
            }
        };
        let chat_body = serde_json::json!({
            "model": name,
            "messages": messages,
            "stream": true,
            "think": request_think,
            "keep_alive": "15m",
            "options": request_options
        })
        .to_string();
        let resp = match client
            .post(format!("{base}/api/chat"))
            .header("content-type", "application/json")
            .body(chat_body)
            .send()
        {
            Ok(r) => r,
            Err(e) => {
                let error = format!("connect: {e}");
                emit(ChatDelta {
                    delta: String::new(),
                    done: true,
                    error: Some(error.clone()),
                });
                return Err(error);
            }
        };
        let status = resp.status();
        if !status.is_success() {
            let error = format!("status_{}", status.as_u16());
            emit(ChatDelta {
                delta: String::new(),
                done: true,
                error: Some(error.clone()),
            });
            return Err(error);
        }

        let reader = BufReader::new(resp);
        let mut text = String::new();
        let mut input_tokens = None;
        let mut output_tokens = None;
        for line in reader.lines() {
            let line = match line {
                Ok(l) => l,
                Err(error) => {
                    let message = format!("stream: {error}");
                    emit(ChatDelta {
                        delta: String::new(),
                        done: true,
                        error: Some(message.clone()),
                    });
                    return Err(message);
                }
            };
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            let Ok(v) = serde_json::from_str::<serde_json::Value>(trimmed) else {
                continue;
            };
            if let Some(err) = v.get("error").and_then(|e| e.as_str()) {
                let error = err.to_string();
                emit(ChatDelta {
                    delta: String::new(),
                    done: true,
                    error: Some(error.clone()),
                });
                return Err(error);
            }
            if let Some(content) = v.pointer("/message/content").and_then(|c| c.as_str()) {
                if !content.is_empty() {
                    text.push_str(content);
                    emit(ChatDelta {
                        delta: content.to_string(),
                        done: false,
                        error: None,
                    });
                }
            }
            if v.get("done").and_then(|d| d.as_bool()).unwrap_or(false) {
                input_tokens = v.get("prompt_eval_count").and_then(|entry| entry.as_u64());
                output_tokens = v.get("eval_count").and_then(|entry| entry.as_u64());
                emit(ChatDelta {
                    delta: String::new(),
                    done: true,
                    error: None,
                });
                break;
            }
        }
        if text.trim().is_empty() {
            let error = "empty_response".to_string();
            emit(ChatDelta {
                delta: String::new(),
                done: true,
                error: Some(error.clone()),
            });
            return Err(error);
        }
        Ok(OllamaChatResult {
            text,
            input_tokens,
            output_tokens,
        })
    })
    .await
    .map_err(|error| format!("worker: {error}"))?
}
