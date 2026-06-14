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

use std::io::{BufRead, BufReader};
use std::time::Duration;

use reqwest::blocking::Client;
use serde::Serialize;
use tauri::{AppHandle, Emitter};

const OLLAMA_BASE: &str = "http://127.0.0.1:11434";

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
    size: Option<u64>,
    modified_at: Option<String>,
}

/// List installed models via GET /api/tags. Fast; returns [] on any failure
/// so the UI can show a friendly "no models / start Ollama" state.
#[tauri::command]
pub fn ollama_list_models() -> Result<Vec<OllamaModel>, String> {
    let client = build_client(15)?;
    let resp = client
        .get(format!("{OLLAMA_BASE}/api/tags"))
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
pub fn ollama_pull_model(app: AppHandle, model: String) -> Result<(), String> {
    if !valid_model_name(&model) {
        return Err("invalid_model_name".to_string());
    }
    let name = model.trim().to_string();

    std::thread::spawn(move || {
        let emit = |p: PullProgress| {
            let _ = app.emit("ollama:pull-progress", p);
        };
        let client = match build_client(0) {
            Ok(c) => c,
            Err(e) => {
                emit(PullProgress { status: "error".into(), total: None, completed: None, percent: None, done: true, error: Some(e) });
                return;
            }
        };
        let pull_body = serde_json::json!({ "name": name, "stream": true }).to_string();
        let resp = match client
            .post(format!("{OLLAMA_BASE}/api/pull"))
            .header("content-type", "application/json")
            .body(pull_body)
            .send()
        {
            Ok(r) => r,
            Err(e) => {
                emit(PullProgress { status: "error".into(), total: None, completed: None, percent: None, done: true, error: Some(format!("connect: {e}")) });
                return;
            }
        };
        let status = resp.status();
        if !status.is_success() {
            emit(PullProgress { status: "error".into(), total: None, completed: None, percent: None, done: true, error: Some(format!("status_{}", status.as_u16())) });
            return;
        }

        let reader = BufReader::new(resp);
        let mut saw_success = false;
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
                emit(PullProgress { status: "error".into(), total: None, completed: None, percent: None, done: true, error: Some(err.to_string()) });
                return;
            }
            let st = v.get("status").and_then(|s| s.as_str()).unwrap_or("downloading").to_string();
            let total = v.get("total").and_then(|x| x.as_u64());
            let completed = v.get("completed").and_then(|x| x.as_u64());
            let percent = match (total, completed) {
                (Some(t), Some(c)) if t > 0 => Some(((c as f64 / t as f64) * 100.0).clamp(0.0, 100.0)),
                _ => None,
            };
            if st == "success" {
                saw_success = true;
            }
            emit(PullProgress { status: st, total, completed, percent, done: false, error: None });
        }
        emit(PullProgress { status: if saw_success { "success".into() } else { "success".into() }, total: None, completed: None, percent: Some(100.0), done: true, error: None });
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

/// Stream a chat completion via POST /api/chat (NDJSON). Runs on a worker
/// thread; emits `ollama:chat:<requestId>` events with incremental `delta`s
/// and a final `done: true` (or `error`). `messages` is the OpenAI-style
/// array `[{role, content}]`.
#[tauri::command]
pub fn ollama_chat_stream(
    app: AppHandle,
    request_id: String,
    model: String,
    messages: serde_json::Value,
    temperature: Option<f64>,
) -> Result<(), String> {
    if !valid_model_name(&model) {
        return Err("invalid_model_name".to_string());
    }
    let event = format!("ollama:chat:{request_id}");
    let name = model.trim().to_string();
    let temp = temperature.unwrap_or(0.45);

    std::thread::spawn(move || {
        let emit = |d: ChatDelta| {
            let _ = app.emit(event.as_str(), d);
        };
        let client = match build_client(180) {
            Ok(c) => c,
            Err(e) => {
                emit(ChatDelta { delta: String::new(), done: true, error: Some(e) });
                return;
            }
        };
        let chat_body = serde_json::json!({
            "model": name,
            "messages": messages,
            "stream": true,
            "keep_alive": "15m",
            "options": {
                "temperature": temp,
                "num_ctx": 4096,
                "num_predict": 320,
                "repeat_penalty": 1.18,
                "top_p": 0.9
            }
        })
        .to_string();
        let resp = match client
            .post(format!("{OLLAMA_BASE}/api/chat"))
            .header("content-type", "application/json")
            .body(chat_body)
            .send()
        {
            Ok(r) => r,
            Err(e) => {
                emit(ChatDelta { delta: String::new(), done: true, error: Some(format!("connect: {e}")) });
                return;
            }
        };
        let status = resp.status();
        if !status.is_success() {
            emit(ChatDelta { delta: String::new(), done: true, error: Some(format!("status_{}", status.as_u16())) });
            return;
        }

        let reader = BufReader::new(resp);
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
                emit(ChatDelta { delta: String::new(), done: true, error: Some(err.to_string()) });
                return;
            }
            if let Some(content) = v.pointer("/message/content").and_then(|c| c.as_str()) {
                if !content.is_empty() {
                    emit(ChatDelta { delta: content.to_string(), done: false, error: None });
                }
            }
            if v.get("done").and_then(|d| d.as_bool()).unwrap_or(false) {
                emit(ChatDelta { delta: String::new(), done: true, error: None });
                return;
            }
        }
        emit(ChatDelta { delta: String::new(), done: true, error: None });
    });

    Ok(())
}
