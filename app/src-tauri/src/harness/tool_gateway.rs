use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::io::{Read, Write};
use std::net::{IpAddr, Ipv4Addr, Shutdown, SocketAddr, TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, State};

pub const MAX_REQUEST_BODY_BYTES: usize = 64 * 1024;
pub const MAX_RESPONSE_BODY_BYTES: usize = 128 * 1024;
const MAX_ID_BYTES: usize = 200;
const MAX_HEADER_BYTES: usize = 16 * 1024;
const MAX_ACTIVE_CONNECTIONS: usize = 16;
const RESPONSE_TIMEOUT: Duration = Duration::from_secs(30);
const RESPONSE_POLL_INTERVAL: Duration = Duration::from_millis(50);
const MAX_MCP_CALL_IDS: usize = 4096;
pub const TOOL_REQUEST_EVENT: &str = "vibespace://tool-gateway/request";

const TOOL_CATALOG: &[&str] = &[
    "terminal.list",
    "terminal.open",
    "terminal.focus",
    "terminal.spawn",
    "terminal.write",
    "terminal.read",
    "terminal.schedule",
    "command.list",
    "command.run",
    "profile.allAboutMe.read",
    "profile.allAboutMe.update",
    "memory.learning.read",
    "memory.learning.update",
    "context.list",
    "context.read",
    "context.attach",
    "vibespace_context",
    "skills.list",
    "skills.load",
    "plugins.list",
    "plugins.run",
    "tasks.create",
    "tasks.update",
    "schedule.create",
    "app.navigate",
    "app.getState",
];

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct ToolGatewayRequest {
    pub protocol_version: u8,
    pub request_id: String,
    pub session_id: String,
    pub message_id: String,
    pub tool: String,
    pub args: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub directory: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub worktree: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolGatewayResponse {
    pub request_id: String,
    pub ok: bool,
    pub code: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ToolGatewayError {
    pub code: &'static str,
    pub message: &'static str,
}

fn error(code: &'static str, message: &'static str) -> ToolGatewayError {
    ToolGatewayError { code, message }
}

fn safe_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_ID_BYTES
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._:/@-".contains(&byte))
}

fn safe_absolute_directory(value: &str) -> bool {
    if value.is_empty() || value.len() > 4096 || value.contains('\0') {
        return false;
    }
    let bytes = value.as_bytes();
    value.starts_with('/')
        || value.starts_with(r"\\")
        || (bytes.len() >= 3
            && bytes[0].is_ascii_alphabetic()
            && bytes[1] == b':'
            && (bytes[2] == b'\\' || bytes[2] == b'/'))
}

pub fn validate_bearer(header: Option<&str>, expected: &str) -> bool {
    if expected.len() < 32 {
        return false;
    }
    let Some(candidate) = header.and_then(|value| value.strip_prefix("Bearer ")) else {
        return false;
    };
    let expected_hash = Sha256::digest(expected.as_bytes());
    let candidate_hash = Sha256::digest(candidate.as_bytes());
    expected_hash
        .iter()
        .zip(candidate_hash.iter())
        .fold(0_u8, |difference, (left, right)| {
            difference | (left ^ right)
        })
        == 0
}

pub fn parse_tool_request(body: &[u8]) -> Result<ToolGatewayRequest, ToolGatewayError> {
    if body.len() > MAX_REQUEST_BODY_BYTES {
        return Err(error(
            "request_too_large",
            "The tool request exceeded the safe size limit.",
        ));
    }
    let request: ToolGatewayRequest = serde_json::from_slice(body).map_err(|_| {
        error(
            "invalid_request",
            "The tool request did not match the gateway protocol.",
        )
    })?;
    if request.protocol_version != 1
        || !safe_id(&request.request_id)
        || !safe_id(&request.session_id)
        || !safe_id(&request.message_id)
        || !request.args.is_object()
    {
        return Err(error(
            "invalid_request",
            "The tool request did not match the gateway protocol.",
        ));
    }
    if !TOOL_CATALOG.contains(&request.tool.as_str()) {
        return Err(error(
            "unknown_tool",
            "The requested semantic tool is unavailable.",
        ));
    }
    if request
        .directory
        .as_deref()
        .is_some_and(|value| !safe_absolute_directory(value))
        || request
            .worktree
            .as_deref()
            .is_some_and(|value| !safe_absolute_directory(value))
    {
        return Err(error(
            "invalid_scope",
            "The tool request directory scope is invalid.",
        ));
    }
    Ok(request)
}

#[derive(Default)]
pub struct PendingRequests {
    inner: Mutex<HashMap<String, mpsc::SyncSender<ToolGatewayResponse>>>,
}

impl PendingRequests {
    pub fn reserve(
        &self,
        request_id: &str,
    ) -> Result<mpsc::Receiver<ToolGatewayResponse>, ToolGatewayError> {
        if !safe_id(request_id) {
            return Err(error("invalid_request", "The tool request ID is invalid."));
        }
        let (sender, receiver) = mpsc::sync_channel(1);
        let mut pending = self
            .inner
            .lock()
            .map_err(|_| error("internal_error", "The tool gateway is unavailable."))?;
        if pending.contains_key(request_id) {
            return Err(error("conflict", "The tool request ID is already active."));
        }
        pending.insert(request_id.to_string(), sender);
        Ok(receiver)
    }

    pub fn respond(&self, response: ToolGatewayResponse) -> Result<(), ToolGatewayError> {
        let sender = self
            .inner
            .lock()
            .map_err(|_| error("internal_error", "The tool gateway is unavailable."))?
            .remove(&response.request_id)
            .ok_or_else(|| error("request_not_found", "The tool request is no longer active."))?;
        sender
            .send(response)
            .map_err(|_| error("request_not_found", "The tool request is no longer active."))
    }

    fn cancel(&self, request_id: &str) {
        if let Ok(mut pending) = self.inner.lock() {
            pending.remove(request_id);
        }
    }
}

pub fn bounded_response_json(
    mut response: ToolGatewayResponse,
) -> Result<Vec<u8>, ToolGatewayError> {
    if !safe_id(&response.request_id) || !safe_id(&response.code) {
        return Err(error(
            "invalid_response",
            "The tool response did not match the gateway protocol.",
        ));
    }
    fn safe_semantic_token_field(key: &str, value: &Value) -> bool {
        const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
        const MAX_SEMANTIC_TOKEN_DECIMAL: u64 = 10_000_000_000_000_000;
        match key {
            "contextTokens" | "estimatedTokens" => value
                .as_u64()
                .is_some_and(|count| count <= MAX_SAFE_INTEGER),
            "totalTokens" | "indexedTokens" | "tokenStart" | "tokenEnd" => value
                .as_str()
                .filter(|decimal| {
                    decimal.len() <= "10000000000000000".len()
                        && (*decimal == "0"
                            || (!decimal.starts_with('0')
                                && decimal.bytes().all(|byte| byte.is_ascii_digit())))
                })
                .and_then(|decimal| decimal.parse::<u64>().ok())
                .is_some_and(|decimal| decimal <= MAX_SEMANTIC_TOKEN_DECIMAL),
            _ => false,
        }
    }

    fn secret_bearing_json_key(key: &str) -> bool {
        let normalized = key.to_ascii_lowercase();
        [
            "secret",
            "token",
            "password",
            "authorization",
            "authentication",
            "authheader",
            "cookie",
            "credential",
            "apikey",
            "api_key",
            "api-key",
            "api.key",
        ]
        .iter()
        .any(|fragment| normalized.contains(fragment))
    }

    fn redact(value: &mut Value) {
        match value {
            Value::Object(object) => {
                for (key, value) in object {
                    if !safe_semantic_token_field(key, value) && secret_bearing_json_key(key) {
                        *value = Value::String("[redacted]".into());
                    } else {
                        redact(value);
                    }
                }
            }
            Value::Array(values) => values.iter_mut().for_each(redact),
            _ => {}
        }
    }
    if let Some(data) = response.data.as_mut() {
        redact(data);
    }
    if !response.ok && response.code == "internal_error" {
        response.message = "The tool request could not be completed.".into();
        response.data = None;
    }
    response.message = response.message.chars().take(2048).collect();
    let mut encoded = serde_json::to_vec(&response).map_err(|_| {
        error(
            "invalid_response",
            "The tool response could not be encoded.",
        )
    })?;
    if encoded.len() > MAX_RESPONSE_BODY_BYTES {
        response.ok = false;
        response.code = "response_too_large".into();
        response.message = "The tool response exceeded the safe size limit.".into();
        response.data = None;
        encoded = serde_json::to_vec(&response).map_err(|_| {
            error(
                "invalid_response",
                "The tool response could not be encoded.",
            )
        })?;
    }
    Ok(encoded)
}

#[derive(Clone)]
pub struct ToolGatewayEndpoint {
    pub url: String,
    pub token: String,
}

#[derive(Default)]
pub struct ToolGatewayState {
    endpoint: Mutex<Option<ToolGatewayEndpoint>>,
    pending: Arc<PendingRequests>,
}

pub struct CodexContextLease {
    url: String,
    token: String,
    authority: Arc<CodexLeaseAuthority>,
    address: SocketAddr,
    listener: Option<std::thread::JoinHandle<()>>,
}

impl CodexContextLease {
    pub fn url(&self) -> &str {
        &self.url
    }

    pub fn token(&self) -> &str {
        &self.token
    }
}

impl Drop for CodexContextLease {
    fn drop(&mut self) {
        self.authority.revoke();
        let _ = TcpStream::connect(self.address);
        if let Some(listener) = self.listener.take() {
            let _ = listener.join();
        }
    }
}

#[derive(Default)]
struct CodexLeaseAuthority {
    revoked: AtomicBool,
    gate: Mutex<()>,
    connections: Mutex<HashMap<u64, TcpStream>>,
    next_connection_id: AtomicU64,
}

impl CodexLeaseAuthority {
    fn is_revoked(&self) -> bool {
        self.revoked.load(Ordering::Acquire)
    }

    fn dispatch(
        &self,
        request: ToolGatewayRequest,
        emit: &dyn Fn(ToolGatewayRequest) -> bool,
    ) -> bool {
        let Ok(_gate) = self.gate.lock() else {
            return false;
        };
        !self.is_revoked() && emit(request)
    }

    fn select_response(&self, response: ToolGatewayResponse) -> ToolGatewayResponse {
        let Ok(_gate) = self.gate.lock() else {
            return revoked_tool_response(response.request_id);
        };
        if self.is_revoked() {
            revoked_tool_response(response.request_id)
        } else {
            response
        }
    }

    fn register_connection(self: &Arc<Self>, stream: &TcpStream) -> Option<CodexConnectionGuard> {
        let _gate = self.gate.lock().ok()?;
        if self.is_revoked() {
            return None;
        }
        let id = self.next_connection_id.fetch_add(1, Ordering::Relaxed);
        self.connections
            .lock()
            .ok()?
            .insert(id, stream.try_clone().ok()?);
        Some(CodexConnectionGuard {
            id,
            authority: Arc::clone(self),
        })
    }

    fn revoke(&self) {
        let _gate = self.gate.lock();
        self.revoked.store(true, Ordering::Release);
        if let Ok(mut connections) = self.connections.lock() {
            for stream in connections.values() {
                let _ = stream.shutdown(Shutdown::Both);
            }
            connections.clear();
        }
    }
}

struct CodexConnectionGuard {
    id: u64,
    authority: Arc<CodexLeaseAuthority>,
}

impl Drop for CodexConnectionGuard {
    fn drop(&mut self) {
        if let Ok(mut connections) = self.authority.connections.lock() {
            connections.remove(&self.id);
        }
    }
}

fn revoked_tool_response(request_id: String) -> ToolGatewayResponse {
    ToolGatewayResponse {
        request_id,
        ok: false,
        code: "authority_revoked".into(),
        message: "The Context Map lease was revoked.".into(),
        data: None,
    }
}

impl ToolGatewayState {
    pub fn endpoint(&self) -> Result<ToolGatewayEndpoint, ToolGatewayError> {
        self.endpoint
            .lock()
            .map_err(|_| error("internal_error", "The tool gateway is unavailable."))?
            .clone()
            .ok_or_else(|| error("gateway_unavailable", "The tool gateway is not running."))
    }
}

fn http_response(status: &str, body: &[u8]) -> Vec<u8> {
    let header = format!(
        "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\nCache-Control: no-store\r\n\r\n",
        body.len()
    );
    [header.as_bytes(), body].concat()
}

fn mcp_response(id: &Value, result: Value) -> Vec<u8> {
    let encoded = serde_json::to_vec(&serde_json::json!({
        "jsonrpc": "2.0",
        "id": id,
        "result": result,
    }))
    .unwrap_or_else(|_| {
        br#"{"jsonrpc":"2.0","id":null,"error":{"code":-32603,"message":"Internal error"}}"#
            .to_vec()
    });
    if encoded.len() <= MAX_RESPONSE_BODY_BYTES {
        encoded
    } else {
        mcp_error(Some(id), -32002, "Response exceeded the safe size limit")
    }
}

fn mcp_error(id: Option<&Value>, code: i64, message: &str) -> Vec<u8> {
    serde_json::to_vec(&serde_json::json!({
        "jsonrpc": "2.0",
        "id": id.unwrap_or(&Value::Null),
        "error": { "code": code, "message": message },
    }))
    .unwrap_or_else(|_| {
        br#"{"jsonrpc":"2.0","id":null,"error":{"code":-32603,"message":"Internal error"}}"#
            .to_vec()
    })
}

fn context_tool_descriptor() -> Value {
    serde_json::json!({
        "name": "vibespace_context",
        "description": "Search, open, boundedly expand, or resolve an exact logical token address from the current VibeSpace Context Map.",
        "annotations": {
            "readOnlyHint": true,
            "destructiveHint": false,
            "idempotentHint": true,
            "openWorldHint": false
        },
        "inputSchema": {
            "type": "object",
            "additionalProperties": false,
            "required": ["operation"],
            "properties": {
                "operation": { "type": "string", "enum": ["search", "open", "expand", "address"] },
                "query": { "type": "string", "maxLength": 32768 },
                "corpusId": {
                    "type": "string",
                    "maxLength": 200,
                    "pattern": "^[A-Za-z0-9][A-Za-z0-9._@-]{0,199}$"
                },
                "position": {
                    "type": "string",
                    "maxLength": 17,
                    "pattern": "^(?:0|[1-9][0-9]{0,15}|10000000000000000)$"
                },
                "limit": { "type": "integer", "minimum": 1, "maximum": 5 },
                "beforeBytes": { "type": "integer", "minimum": 1, "maximum": 2048 },
                "afterBytes": { "type": "integer", "minimum": 1, "maximum": 2048 },
                "pointer": {
                    "description": "Use the exact pointer object returned by search. A JSON-encoded pointer string remains accepted for compatibility.",
                    "oneOf": [
                        { "type": "string", "maxLength": 8192 },
                        {
                            "type": "object",
                            "additionalProperties": false,
                            "required": ["id", "recordId", "sourceVersion", "contentHash"],
                            "oneOf": [
                                {
                                    "required": ["byteStart", "byteEnd"],
                                    "not": {
                                        "anyOf": [
                                            { "required": ["lineStart"] },
                                            { "required": ["lineEnd"] }
                                        ]
                                    }
                                },
                                {
                                    "required": ["lineStart", "lineEnd"],
                                    "not": {
                                        "anyOf": [
                                            { "required": ["byteStart"] },
                                            { "required": ["byteEnd"] }
                                        ]
                                    }
                                }
                            ],
                            "properties": {
                                "id": { "type": "string", "maxLength": 512 },
                                "recordId": { "type": "string", "maxLength": 512 },
                                "sourceVersion": { "type": "string", "maxLength": 512 },
                                "contentHash": {
                                    "type": "string",
                                    "pattern": "^[a-f0-9]{64}$"
                                },
                                "lineStart": {
                                    "type": "integer",
                                    "minimum": 1,
                                    "maximum": 9_007_199_254_740_991_i64
                                },
                                "lineEnd": {
                                    "description": "Must be greater than lineStart.",
                                    "type": "integer",
                                    "minimum": 2,
                                    "maximum": 9_007_199_254_740_991_i64
                                },
                                "byteStart": {
                                    "type": "integer",
                                    "minimum": 0,
                                    "maximum": 9_007_199_254_740_991_i64
                                },
                                "byteEnd": {
                                    "description": "Must be greater than byteStart.",
                                    "type": "integer",
                                    "minimum": 1,
                                    "maximum": 9_007_199_254_740_991_i64
                                },
                                "messageId": { "type": "string", "maxLength": 512 },
                                "eventId": { "type": "string", "maxLength": 512 },
                                "toolCallId": { "type": "string", "maxLength": 512 }
                            }
                        }
                    ]
                }
            },
            "allOf": [
                {
                    "if": { "properties": { "operation": { "const": "search" } } },
                    "then": { "required": ["query"] }
                },
                {
                    "if": { "properties": { "operation": { "const": "open" } } },
                    "then": { "required": ["pointer"] }
                },
                {
                    "if": { "properties": { "operation": { "const": "expand" } } },
                    "then": {
                        "required": ["pointer"],
                        "properties": {
                            "pointer": { "type": "object" }
                        },
                        "anyOf": [
                            { "required": ["beforeBytes"] },
                            { "required": ["afterBytes"] }
                        ]
                    }
                },
                {
                    "if": { "properties": { "operation": { "const": "address" } } },
                    "then": { "required": ["corpusId", "position"] }
                }
            ]
        }
    })
}

fn reserve_mcp_call_id(seen: &mut HashSet<String>, id: Option<&Value>) -> bool {
    let Some(id) = id.and_then(|value| match value {
        Value::String(value) if safe_id(value) => Some(format!("s:{value}")),
        Value::Number(value) => Some(format!("n:{value}")),
        _ => None,
    }) else {
        return false;
    };
    if seen.len() >= MAX_MCP_CALL_IDS {
        return false;
    }
    seen.insert(id)
}

fn reserve_shared_mcp_call_id(seen: &Mutex<HashSet<String>>, id: Option<&Value>) -> bool {
    seen.lock()
        .map(|mut seen| reserve_mcp_call_id(&mut seen, id))
        .unwrap_or(false)
}

fn parse_http_request(
    stream: &mut TcpStream,
    expected_path: &str,
    authority: &CodexLeaseAuthority,
) -> Result<(String, Vec<u8>), ToolGatewayError> {
    let _ = stream.set_read_timeout(Some(RESPONSE_POLL_INTERVAL));
    let mut deadline = Instant::now() + Duration::from_secs(5);
    let mut bytes = Vec::new();
    let mut buffer = [0_u8; 4096];
    let header_end = loop {
        if authority.is_revoked() {
            return Err(error(
                "authority_revoked",
                "The Context Map lease was revoked.",
            ));
        }
        let read = match stream.read(&mut buffer) {
            Ok(read) => read,
            Err(failure)
                if matches!(
                    failure.kind(),
                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                ) && Instant::now() < deadline =>
            {
                continue;
            }
            Err(_) => return Err(error("invalid_request", "The request was unreadable.")),
        };
        if read == 0 {
            return Err(error("invalid_request", "The request ended early."));
        }
        deadline = Instant::now() + Duration::from_secs(5);
        bytes.extend_from_slice(&buffer[..read]);
        if let Some(index) = bytes.windows(4).position(|window| window == b"\r\n\r\n") {
            break index + 4;
        }
        if bytes.len() > MAX_HEADER_BYTES {
            return Err(error(
                "request_too_large",
                "The headers exceeded the safe size limit.",
            ));
        }
    };
    let header = std::str::from_utf8(&bytes[..header_end])
        .map_err(|_| error("invalid_request", "The request headers were invalid."))?;
    let mut lines = header.split("\r\n");
    let expected_request_line = format!("POST {expected_path} HTTP/1.1");
    if lines.next() != Some(expected_request_line.as_str()) {
        return Err(error("invalid_request", "The endpoint is unavailable."));
    }
    let mut authorization = None;
    let mut content_length = None;
    for line in lines {
        let Some((name, value)) = line.split_once(':') else {
            continue;
        };
        if name.eq_ignore_ascii_case("authorization") {
            authorization = Some(value.trim().to_string());
        } else if name.eq_ignore_ascii_case("content-length") {
            content_length = value.trim().parse::<usize>().ok();
        }
    }
    let length = content_length
        .ok_or_else(|| error("invalid_request", "The request length was missing."))?;
    if length > MAX_REQUEST_BODY_BYTES {
        return Err(error(
            "request_too_large",
            "The request exceeded the safe size limit.",
        ));
    }
    while bytes.len() - header_end < length {
        if authority.is_revoked() {
            return Err(error(
                "authority_revoked",
                "The Context Map lease was revoked.",
            ));
        }
        let read = match stream.read(&mut buffer) {
            Ok(read) => read,
            Err(failure)
                if matches!(
                    failure.kind(),
                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                ) && Instant::now() < deadline =>
            {
                continue;
            }
            Err(_) => return Err(error("invalid_request", "The request body was unreadable.")),
        };
        if read == 0 {
            return Err(error("invalid_request", "The request body ended early."));
        }
        deadline = Instant::now() + Duration::from_secs(5);
        bytes.extend_from_slice(&buffer[..read]);
    }
    Ok((
        authorization.unwrap_or_default(),
        bytes[header_end..header_end + length].to_vec(),
    ))
}

fn handle_codex_mcp_connection(
    mut stream: TcpStream,
    path: &str,
    token: &str,
    session_id: &str,
    directory: Option<&str>,
    pending: &PendingRequests,
    seen_call_ids: &Mutex<HashSet<String>>,
    authority: &Arc<CodexLeaseAuthority>,
    emit_request: &dyn Fn(ToolGatewayRequest) -> bool,
) -> Result<(), ToolGatewayError> {
    let Some(_connection_guard) = authority.register_connection(&stream) else {
        return Ok(());
    };
    let (authorization, body) = match parse_http_request(&mut stream, path, authority) {
        Ok(value) => value,
        Err(_) => {
            let _ = stream.write_all(&http_response(
                "400 Bad Request",
                &mcp_error(None, -32600, "Invalid request"),
            ));
            return Ok(());
        }
    };
    if !validate_bearer(Some(&authorization), token) {
        let _ = stream.write_all(&http_response(
            "401 Unauthorized",
            &mcp_error(None, -32001, "Authentication failed"),
        ));
        return Ok(());
    }
    let value: Value = match serde_json::from_slice::<Value>(&body) {
        Ok(value) if value.is_object() => value,
        _ => {
            let _ = stream.write_all(&http_response(
                "400 Bad Request",
                &mcp_error(None, -32700, "Parse error"),
            ));
            return Ok(());
        }
    };
    if authority.is_revoked() {
        let _ = stream.write_all(&http_response(
            "503 Service Unavailable",
            &mcp_error(None, -32004, "Context lease revoked"),
        ));
        return Ok(());
    }
    let id = value.get("id");
    let method = value
        .get("method")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let response = match method {
        "initialize" => {
            let protocol_version = value
                .pointer("/params/protocolVersion")
                .and_then(Value::as_str)
                .filter(|version| matches!(*version, "2024-11-05" | "2025-03-26" | "2025-06-18"))
                .unwrap_or("2025-06-18");
            mcp_response(
                id.unwrap_or(&Value::Null),
                serde_json::json!({
                    "protocolVersion": protocol_version,
                    "capabilities": { "tools": { "listChanged": false } },
                    "serverInfo": { "name": "vibespace-context", "version": "1" }
                }),
            )
        }
        "notifications/initialized" => {
            let _ = stream.write_all(&http_response("202 Accepted", &[]));
            return Ok(());
        }
        "tools/list" => mcp_response(
            id.unwrap_or(&Value::Null),
            serde_json::json!({ "tools": [context_tool_descriptor()] }),
        ),
        "tools/call" => {
            let params = value.get("params").and_then(Value::as_object);
            if !reserve_shared_mcp_call_id(seen_call_ids, id) {
                mcp_error(id, -32600, "Invalid or replayed request ID")
            } else if params
                .and_then(|item| item.get("name"))
                .and_then(Value::as_str)
                != Some("vibespace_context")
            {
                mcp_error(id, -32601, "Tool unavailable")
            } else {
                let args = params
                    .and_then(|item| item.get("arguments"))
                    .cloned()
                    .unwrap_or_else(|| serde_json::json!({}));
                if !args.is_object() {
                    mcp_error(id, -32602, "Invalid tool arguments")
                } else {
                    let request_id = format!("codex-{}", nanoid::nanoid!(32));
                    let request = ToolGatewayRequest {
                        protocol_version: 1,
                        request_id: request_id.clone(),
                        session_id: session_id.to_string(),
                        message_id: format!("mcp-{}", nanoid::nanoid!(24)),
                        tool: "vibespace_context".into(),
                        args,
                        directory: directory.map(str::to_string),
                        worktree: directory.map(str::to_string),
                    };
                    let receiver = pending.reserve(&request_id)?;
                    if !authority.dispatch(request, emit_request) {
                        pending.cancel(&request_id);
                        if authority.is_revoked() {
                            mcp_error(id, -32004, "Context lease revoked")
                        } else {
                            mcp_error(id, -32603, "Context routing unavailable")
                        }
                    } else {
                        let deadline = Instant::now() + RESPONSE_TIMEOUT;
                        let tool_response = loop {
                            if authority.is_revoked() {
                                pending.cancel(&request_id);
                                break revoked_tool_response(request_id.clone());
                            }
                            let now = Instant::now();
                            if now >= deadline {
                                pending.cancel(&request_id);
                                break ToolGatewayResponse {
                                    request_id: request_id.clone(),
                                    ok: false,
                                    code: "request_timeout".into(),
                                    message: "The Context Map request timed out.".into(),
                                    data: None,
                                };
                            }
                            let wait = RESPONSE_POLL_INTERVAL.min(deadline.duration_since(now));
                            match receiver.recv_timeout(wait) {
                                Ok(response) => break authority.select_response(response),
                                Err(mpsc::RecvTimeoutError::Timeout) => continue,
                                Err(mpsc::RecvTimeoutError::Disconnected) => {
                                    pending.cancel(&request_id);
                                    break ToolGatewayResponse {
                                        request_id: request_id.clone(),
                                        ok: false,
                                        code: "context_unavailable".into(),
                                        message: "The Context Map response became unavailable."
                                            .into(),
                                        data: None,
                                    };
                                }
                            }
                        };
                        let bounded = bounded_response_json(tool_response.clone())?;
                        let text = String::from_utf8(bounded)
                            .unwrap_or_else(|_| r#"{"ok":false,"code":"invalid_response"}"#.into());
                        mcp_response(
                            id.unwrap_or(&Value::Null),
                            serde_json::json!({
                                "content": [{ "type": "text", "text": text }],
                                "isError": !tool_response.ok
                            }),
                        )
                    }
                }
            }
        }
        _ => mcp_error(id, -32601, "Method unavailable"),
    };
    stream
        .write_all(&http_response("200 OK", &response))
        .map_err(|_| {
            error(
                "connection_closed",
                "The Codex Context Map connection closed.",
            )
        })
}

type ToolRequestEmitter = Arc<dyn Fn(ToolGatewayRequest) -> bool + Send + Sync>;

struct ActiveHandlerGuard {
    active: Arc<Mutex<usize>>,
}

impl Drop for ActiveHandlerGuard {
    fn drop(&mut self) {
        if let Ok(mut active) = self.active.lock() {
            *active = active.saturating_sub(1);
        }
    }
}

fn reserve_active_handler(active: &Arc<Mutex<usize>>) -> Option<ActiveHandlerGuard> {
    let mut count = active.lock().ok()?;
    if *count >= MAX_ACTIVE_CONNECTIONS {
        return None;
    }
    *count += 1;
    drop(count);
    Some(ActiveHandlerGuard {
        active: Arc::clone(active),
    })
}

fn reject_overloaded_codex_connection(stream: TcpStream) {
    let _ = stream.shutdown(Shutdown::Both);
}

fn reap_finished_handlers(handlers: &mut Vec<std::thread::JoinHandle<()>>) {
    let mut index = 0;
    while index < handlers.len() {
        if handlers[index].is_finished() {
            let handler = handlers.swap_remove(index);
            let _ = handler.join();
        } else {
            index += 1;
        }
    }
}

fn serve_codex_context_listener(
    listener: TcpListener,
    path: String,
    token: String,
    session_id: String,
    directory: Option<String>,
    pending: Arc<PendingRequests>,
    authority: Arc<CodexLeaseAuthority>,
    emit_request: ToolRequestEmitter,
) {
    let seen_call_ids = Arc::new(Mutex::new(HashSet::new()));
    let active = Arc::new(Mutex::new(0_usize));
    let mut handlers = Vec::with_capacity(MAX_ACTIVE_CONNECTIONS);
    while !authority.is_revoked() {
        reap_finished_handlers(&mut handlers);
        match listener.accept() {
            Ok((stream, _)) => {
                if authority.is_revoked() {
                    continue;
                }
                let Some(active_guard) = reserve_active_handler(&active) else {
                    reject_overloaded_codex_connection(stream);
                    continue;
                };
                let path = path.clone();
                let token = token.clone();
                let session_id = session_id.clone();
                let directory = directory.clone();
                let pending = Arc::clone(&pending);
                let authority = Arc::clone(&authority);
                let seen_call_ids = Arc::clone(&seen_call_ids);
                let emit_request = Arc::clone(&emit_request);
                if let Ok(handler) = std::thread::Builder::new()
                    .name(format!("codex-context-request-{session_id}"))
                    .spawn(move || {
                        let _active_guard = active_guard;
                        let _ = handle_codex_mcp_connection(
                            stream,
                            &path,
                            &token,
                            &session_id,
                            directory.as_deref(),
                            &pending,
                            &seen_call_ids,
                            &authority,
                            emit_request.as_ref(),
                        );
                    })
                {
                    handlers.push(handler);
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(Duration::from_millis(10));
            }
            Err(_) => break,
        }
    }
    for handler in handlers {
        let _ = handler.join();
    }
}

pub fn create_codex_context_lease(
    app: &AppHandle,
    state: &ToolGatewayState,
    session_id: &str,
    directory: Option<&str>,
) -> Result<CodexContextLease, String> {
    if !safe_id(session_id) {
        return Err("The Codex Context Map session ID is invalid.".into());
    }
    if directory.is_some_and(|value| !safe_absolute_directory(value)) {
        return Err("The Codex Context Map directory scope is invalid.".into());
    }
    let listener = TcpListener::bind(SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0))
        .map_err(|_| "The Codex Context Map lease could not bind to loopback.".to_string())?;
    listener
        .set_nonblocking(true)
        .map_err(|_| "The Codex Context Map lease could not be isolated.".to_string())?;
    let address = listener
        .local_addr()
        .map_err(|_| "The Codex Context Map lease address is unavailable.".to_string())?;
    let lease_id = nanoid::nanoid!(32);
    let path = format!("/v1/codex-context/{lease_id}");
    let token = nanoid::nanoid!(64);
    let authority = Arc::new(CodexLeaseAuthority::default());
    let thread_authority = Arc::clone(&authority);
    let app = app.clone();
    let pending = Arc::clone(&state.pending);
    let thread_token = token.clone();
    let thread_session_id = session_id.to_string();
    let thread_directory = directory.map(str::to_string);
    let thread_path = path.clone();
    let listener = std::thread::Builder::new()
        .name(format!("codex-context-{lease_id}"))
        .spawn(move || {
            let emit_request: ToolRequestEmitter =
                Arc::new(move |request| app.emit(TOOL_REQUEST_EVENT, request).is_ok());
            serve_codex_context_listener(
                listener,
                thread_path,
                thread_token,
                thread_session_id,
                thread_directory,
                pending,
                thread_authority,
                emit_request,
            );
        })
        .map_err(|_| "The Codex Context Map lease could not start.".to_string())?;
    Ok(CodexContextLease {
        url: format!("http://{address}{path}"),
        token,
        authority,
        address,
        listener: Some(listener),
    })
}

fn error_body(request_id: &str, failure: ToolGatewayError) -> Vec<u8> {
    bounded_response_json(ToolGatewayResponse {
        request_id: if safe_id(request_id) {
            request_id.into()
        } else {
            "invalid-request".into()
        },
        ok: false,
        code: failure.code.into(),
        message: failure.message.into(),
        data: None,
    })
    .unwrap_or_else(|_| br#"{"ok":false,"code":"internal_error"}"#.to_vec())
}

fn read_http_request(stream: &mut TcpStream) -> Result<(String, Vec<u8>), ToolGatewayError> {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
    let mut bytes = Vec::new();
    let mut buffer = [0_u8; 4096];
    let header_end = loop {
        let read = stream.read(&mut buffer).map_err(|_| {
            error(
                "invalid_request",
                "The tool gateway request was unreadable.",
            )
        })?;
        if read == 0 {
            return Err(error(
                "invalid_request",
                "The tool gateway request ended early.",
            ));
        }
        bytes.extend_from_slice(&buffer[..read]);
        if let Some(index) = bytes.windows(4).position(|window| window == b"\r\n\r\n") {
            break index + 4;
        }
        if bytes.len() > MAX_HEADER_BYTES {
            return Err(error(
                "request_too_large",
                "The tool gateway headers exceeded the safe size limit.",
            ));
        }
    };
    let header = std::str::from_utf8(&bytes[..header_end])
        .map_err(|_| error("invalid_request", "The tool gateway headers were invalid."))?;
    let mut lines = header.split("\r\n");
    if lines.next() != Some("POST /v1/tool HTTP/1.1") {
        return Err(error(
            "invalid_request",
            "Only the semantic tool endpoint is available.",
        ));
    }
    let mut authorization = None;
    let mut content_length = None;
    for line in lines {
        let Some((name, value)) = line.split_once(':') else {
            continue;
        };
        if name.eq_ignore_ascii_case("authorization") {
            authorization = Some(value.trim().to_string());
        } else if name.eq_ignore_ascii_case("content-length") {
            content_length = value.trim().parse::<usize>().ok();
        }
    }
    let length = content_length.ok_or_else(|| {
        error(
            "invalid_request",
            "The tool gateway request length was missing.",
        )
    })?;
    if length > MAX_REQUEST_BODY_BYTES {
        return Err(error(
            "request_too_large",
            "The tool request exceeded the safe size limit.",
        ));
    }
    while bytes.len() - header_end < length {
        let read = stream
            .read(&mut buffer)
            .map_err(|_| error("invalid_request", "The tool request body was unreadable."))?;
        if read == 0 {
            return Err(error(
                "invalid_request",
                "The tool request body ended early.",
            ));
        }
        bytes.extend_from_slice(&buffer[..read]);
    }
    Ok((
        authorization.unwrap_or_default(),
        bytes[header_end..header_end + length].to_vec(),
    ))
}

fn handle_connection(
    mut stream: TcpStream,
    token: &str,
    app: &AppHandle,
    pending: &PendingRequests,
) -> Result<(), ToolGatewayError> {
    let (authorization, body) = match read_http_request(&mut stream) {
        Ok(value) => value,
        Err(failure) => {
            let response =
                http_response("400 Bad Request", &error_body("invalid-request", failure));
            let _ = stream.write_all(&response);
            return Ok(());
        }
    };
    if !validate_bearer(Some(&authorization), token) {
        let response = http_response(
            "401 Unauthorized",
            &error_body(
                "invalid-request",
                error(
                    "authentication_failed",
                    "Tool gateway authentication failed.",
                ),
            ),
        );
        let _ = stream.write_all(&response);
        return Ok(());
    }
    let request = match parse_tool_request(&body) {
        Ok(request) => request,
        Err(failure) => {
            let response =
                http_response("400 Bad Request", &error_body("invalid-request", failure));
            let _ = stream.write_all(&response);
            return Ok(());
        }
    };
    let receiver = pending.reserve(&request.request_id)?;
    if app.emit(TOOL_REQUEST_EVENT, request.clone()).is_err() {
        pending.cancel(&request.request_id);
        let response = http_response(
            "503 Service Unavailable",
            &error_body(
                &request.request_id,
                error(
                    "renderer_unavailable",
                    "VibeSpace could not route the semantic tool request.",
                ),
            ),
        );
        let _ = stream.write_all(&response);
        return Ok(());
    }
    let response = match receiver.recv_timeout(RESPONSE_TIMEOUT) {
        Ok(response) => response,
        Err(_) => {
            pending.cancel(&request.request_id);
            ToolGatewayResponse {
                request_id: request.request_id,
                ok: false,
                code: "request_timeout".into(),
                message: "VibeSpace did not complete the tool request in time.".into(),
                data: None,
            }
        }
    };
    let body = bounded_response_json(response)?;
    stream
        .write_all(&http_response("200 OK", &body))
        .map_err(|_| error("connection_closed", "The OpenCode tool connection closed."))
}

pub fn start_tool_gateway_server(
    app: &AppHandle,
    state: &ToolGatewayState,
) -> Result<ToolGatewayEndpoint, String> {
    let listener = TcpListener::bind(SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0))
        .map_err(|_| "The VibeSpace tool gateway could not bind to loopback.".to_string())?;
    let address = listener
        .local_addr()
        .map_err(|_| "The VibeSpace tool gateway address is unavailable.".to_string())?;
    let endpoint = ToolGatewayEndpoint {
        url: format!("http://{address}/v1/tool"),
        token: nanoid::nanoid!(64),
    };
    *state
        .endpoint
        .lock()
        .map_err(|_| "The VibeSpace tool gateway state is unavailable.".to_string())? =
        Some(endpoint.clone());

    let app = app.clone();
    let pending = Arc::clone(&state.pending);
    let token = endpoint.token.clone();
    std::thread::spawn(move || {
        let active = Arc::new(Mutex::new(0_usize));
        for connection in listener.incoming() {
            let Ok(stream) = connection else {
                continue;
            };
            let mut count = match active.lock() {
                Ok(count) => count,
                Err(_) => continue,
            };
            if *count >= MAX_ACTIVE_CONNECTIONS {
                drop(stream);
                continue;
            }
            *count += 1;
            drop(count);
            let app = app.clone();
            let pending = Arc::clone(&pending);
            let token = token.clone();
            let active = Arc::clone(&active);
            std::thread::spawn(move || {
                let _ = handle_connection(stream, &token, &app, &pending);
                if let Ok(mut count) = active.lock() {
                    *count = count.saturating_sub(1);
                }
            });
        }
    });
    Ok(endpoint)
}

#[tauri::command]
pub fn tool_gateway_respond(
    state: State<'_, ToolGatewayState>,
    response: ToolGatewayResponse,
) -> Result<(), String> {
    state
        .pending
        .respond(response)
        .map_err(|failure| failure.message.to_string())
}

#[cfg(test)]
mod tests {
    use super::{
        bounded_response_json, context_tool_descriptor, mcp_response, parse_tool_request,
        reserve_active_handler, reserve_mcp_call_id, reserve_shared_mcp_call_id,
        serve_codex_context_listener, validate_bearer, CodexContextLease, CodexLeaseAuthority,
        PendingRequests, ToolGatewayRequest, ToolGatewayResponse, MAX_ACTIVE_CONNECTIONS,
        MAX_REQUEST_BODY_BYTES, MAX_RESPONSE_BODY_BYTES,
    };
    use serde_json::json;
    use std::collections::HashSet;
    use std::io::{Read, Write};
    use std::net::{IpAddr, Ipv4Addr, SocketAddr, TcpListener, TcpStream};
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Arc, Barrier, Mutex};
    use std::time::{Duration, Instant};

    fn request(tool: &str) -> Vec<u8> {
        serde_json::to_vec(&json!({
            "protocolVersion": 1,
            "requestId": "tool-request-1",
            "sessionId": "session-1",
            "messageId": "message-1",
            "tool": tool,
            "args": {},
            "directory": "C:\\workspace",
            "worktree": "C:\\workspace"
        }))
        .unwrap()
    }

    fn codex_context_call(
        address: SocketAddr,
        path: &str,
        token: &str,
        id: usize,
        query: &str,
    ) -> serde_json::Value {
        let body = serde_json::to_vec(&json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": "tools/call",
            "params": {
                "name": "vibespace_context",
                "arguments": {
                    "operation": "search",
                    "query": query,
                    "limit": 3
                }
            }
        }))
        .unwrap();
        let mut stream = TcpStream::connect(address).unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        write!(
            stream,
            "POST {path} HTTP/1.1\r\nHost: {address}\r\nAuthorization: Bearer {token}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            body.len()
        )
        .unwrap();
        stream.write_all(&body).unwrap();
        let mut response = String::new();
        stream.read_to_string(&mut response).unwrap();
        serde_json::from_str(response.split("\r\n\r\n").nth(1).unwrap()).unwrap()
    }

    #[test]
    fn accepts_only_the_fixed_semantic_catalog_and_never_generic_native_invoke() {
        let parsed = parse_tool_request(&request("terminal.list")).unwrap();
        assert_eq!(parsed.tool, "terminal.list");
        assert_eq!(parsed.directory.as_deref(), Some("C:\\workspace"));
        assert_eq!(
            parse_tool_request(&request("vibespace_context"))
                .unwrap()
                .tool,
            "vibespace_context"
        );

        for rejected in [
            "tauri.invoke",
            "native.invoke",
            "terminal_list",
            "terminal.list;rm",
            "context.update",
            "",
        ] {
            assert_eq!(
                parse_tool_request(&request(rejected)).unwrap_err().code,
                "unknown_tool"
            );
        }
    }

    #[test]
    fn codex_mcp_catalog_exposes_only_bounded_context_map_and_lease_drop_revokes() {
        let descriptor = context_tool_descriptor();
        assert_eq!(descriptor["name"], "vibespace_context");
        assert_eq!(descriptor["inputSchema"]["additionalProperties"], false);
        assert_eq!(
            descriptor["inputSchema"]["properties"]["operation"]["enum"],
            json!(["search", "open", "expand", "address"])
        );
        assert_eq!(
            descriptor["inputSchema"]["properties"]["position"]["type"],
            "string"
        );
        assert_eq!(
            descriptor["inputSchema"]["properties"]["position"]["pattern"],
            "^(?:0|[1-9][0-9]{0,15}|10000000000000000)$"
        );
        assert_eq!(
            descriptor["inputSchema"]["properties"]["corpusId"]["maxLength"],
            200
        );
        assert_eq!(
            descriptor["inputSchema"]["properties"]["corpusId"]["pattern"],
            "^[A-Za-z0-9][A-Za-z0-9._@-]{0,199}$"
        );
        assert_eq!(
            descriptor["inputSchema"]["properties"]["limit"]["maximum"],
            5
        );
        for direction in ["beforeBytes", "afterBytes"] {
            assert_eq!(
                descriptor["inputSchema"]["properties"][direction]["minimum"],
                1
            );
            assert_eq!(
                descriptor["inputSchema"]["properties"][direction]["maximum"],
                2048
            );
        }
        assert_eq!(
            descriptor["inputSchema"]["allOf"],
            json!([
                {
                    "if": { "properties": { "operation": { "const": "search" } } },
                    "then": { "required": ["query"] }
                },
                {
                    "if": { "properties": { "operation": { "const": "open" } } },
                    "then": { "required": ["pointer"] }
                },
                {
                    "if": { "properties": { "operation": { "const": "expand" } } },
                    "then": {
                        "required": ["pointer"],
                        "properties": {
                            "pointer": { "type": "object" }
                        },
                        "anyOf": [
                            { "required": ["beforeBytes"] },
                            { "required": ["afterBytes"] }
                        ]
                    }
                },
                {
                    "if": { "properties": { "operation": { "const": "address" } } },
                    "then": { "required": ["corpusId", "position"] }
                }
            ])
        );
        assert_eq!(
            descriptor["inputSchema"]["allOf"][2]["then"]["properties"]["pointer"]["type"],
            "object"
        );
        assert!(descriptor["inputSchema"]["properties"]
            .get("offset")
            .is_none());
        assert!(descriptor["inputSchema"]["properties"]
            .get("recordId")
            .is_none());
        let pointer_schema = &descriptor["inputSchema"]["properties"]["pointer"];
        assert_eq!(pointer_schema["oneOf"][0]["type"], "string");
        assert_eq!(pointer_schema["oneOf"][0]["maxLength"], 8192);
        assert_eq!(pointer_schema["oneOf"][1]["type"], "object");
        assert_eq!(pointer_schema["oneOf"][1]["additionalProperties"], false);
        assert_eq!(
            pointer_schema["oneOf"][1]["required"],
            json!(["id", "recordId", "sourceVersion", "contentHash"])
        );
        assert_eq!(
            pointer_schema["oneOf"][1]["properties"]["contentHash"]["pattern"],
            "^[a-f0-9]{64}$"
        );
        assert_eq!(
            pointer_schema["oneOf"][1]["properties"]["byteStart"]["maximum"],
            9_007_199_254_740_991_i64
        );
        assert_eq!(
            pointer_schema["oneOf"][1]["oneOf"][0]["required"],
            json!(["byteStart", "byteEnd"])
        );
        assert_eq!(
            pointer_schema["oneOf"][1]["oneOf"][1]["required"],
            json!(["lineStart", "lineEnd"])
        );
        assert_eq!(
            pointer_schema["oneOf"][1]["oneOf"][0]["not"]["anyOf"],
            json!([
                { "required": ["lineStart"] },
                { "required": ["lineEnd"] }
            ])
        );
        assert_eq!(
            descriptor["annotations"],
            json!({
                "readOnlyHint": true,
                "destructiveHint": false,
                "idempotentHint": true,
                "openWorldHint": false
            })
        );
        let authority = Arc::new(CodexLeaseAuthority::default());
        let lease = CodexContextLease {
            url: "http://127.0.0.1:1/v1/codex-context/test".into(),
            token: "t".repeat(64),
            authority: Arc::clone(&authority),
            address: "127.0.0.1:1".parse().unwrap(),
            listener: None,
        };
        assert!(!authority.is_revoked());
        drop(lease);
        assert!(authority.is_revoked());
        let oversized = mcp_response(
            &json!(1),
            json!({ "data": "x".repeat(MAX_RESPONSE_BODY_BYTES) }),
        );
        assert!(oversized.len() <= MAX_RESPONSE_BODY_BYTES);
        assert!(String::from_utf8(oversized)
            .unwrap()
            .contains("Response exceeded the safe size limit"));
        let mut seen = HashSet::new();
        assert!(reserve_mcp_call_id(&mut seen, Some(&json!("call-1"))));
        assert!(!reserve_mcp_call_id(&mut seen, Some(&json!("call-1"))));
        assert!(!reserve_mcp_call_id(&mut seen, None));
    }

    #[test]
    fn codex_mcp_dispatches_five_parallel_calls_without_head_of_line_cancellation() {
        let listener =
            TcpListener::bind(SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0)).unwrap();
        listener.set_nonblocking(true).unwrap();
        let address = listener.local_addr().unwrap();
        let path = "/v1/codex-context/parallel".to_string();
        let token = "t".repeat(64);
        let pending = Arc::new(PendingRequests::default());
        let authority = Arc::new(CodexLeaseAuthority::default());
        let observed = Arc::new(Mutex::new(Vec::<ToolGatewayRequest>::new()));
        let emit_pending = Arc::clone(&pending);
        let emit_observed = Arc::clone(&observed);
        let emit = Arc::new(move |request: ToolGatewayRequest| {
            let ready = {
                let mut observed = emit_observed.lock().unwrap();
                observed.push(request);
                (observed.len() == 5).then(|| observed.clone())
            };
            ready.is_none_or(|requests| {
                requests.into_iter().all(|request| {
                    emit_pending
                        .respond(ToolGatewayResponse {
                            request_id: request.request_id,
                            ok: true,
                            code: "ok".into(),
                            message: "Ready".into(),
                            data: Some(json!({ "query": request.args["query"] })),
                        })
                        .is_ok()
                })
            })
        });
        let server_authority = Arc::clone(&authority);
        let server_path = path.clone();
        let server_token = token.clone();
        let server_pending = Arc::clone(&pending);
        let server = std::thread::spawn(move || {
            serve_codex_context_listener(
                listener,
                server_path,
                server_token,
                "session-parallel".into(),
                Some("C:\\workspace".into()),
                server_pending,
                server_authority,
                emit,
            );
        });

        let barrier = Arc::new(Barrier::new(6));
        let clients = (0..5)
            .map(|index| {
                let barrier = Arc::clone(&barrier);
                let path = path.clone();
                let token = token.clone();
                std::thread::spawn(move || {
                    barrier.wait();
                    let envelope = codex_context_call(
                        address,
                        &path,
                        &token,
                        index + 1,
                        &format!("question-{index}"),
                    );
                    let result: serde_json::Value = serde_json::from_str(
                        envelope["result"]["content"][0]["text"].as_str().unwrap(),
                    )
                    .unwrap();
                    (
                        envelope["id"].as_u64().unwrap(),
                        result["data"]["query"].as_str().unwrap().to_string(),
                    )
                })
            })
            .collect::<Vec<_>>();
        barrier.wait();
        let mut results = clients
            .into_iter()
            .map(|client| client.join().unwrap())
            .collect::<Vec<_>>();
        results.sort();

        authority.revoke();
        server.join().unwrap();
        assert_eq!(
            results,
            vec![
                (1, "question-0".into()),
                (2, "question-1".into()),
                (3, "question-2".into()),
                (4, "question-3".into()),
                (5, "question-4".into()),
            ]
        );
        let requests = observed.lock().unwrap();
        assert_eq!(requests.len(), 5);
        let distinct_ids = requests
            .iter()
            .map(|request| request.request_id.as_str())
            .collect::<HashSet<_>>();
        assert_eq!(distinct_ids.len(), 5);
    }

    #[test]
    fn codex_mcp_revocation_terminates_an_inflight_renderer_wait() {
        let listener =
            TcpListener::bind(SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0)).unwrap();
        listener.set_nonblocking(true).unwrap();
        let address = listener.local_addr().unwrap();
        let path = "/v1/codex-context/revoke".to_string();
        let token = "t".repeat(64);
        let pending = Arc::new(PendingRequests::default());
        let authority = Arc::new(CodexLeaseAuthority::default());
        let (emitted, received) = std::sync::mpsc::sync_channel(1);
        let emit = Arc::new(move |_request: ToolGatewayRequest| emitted.send(()).is_ok());
        let server_authority = Arc::clone(&authority);
        let server_path = path.clone();
        let server_token = token.clone();
        let server = std::thread::spawn(move || {
            serve_codex_context_listener(
                listener,
                server_path,
                server_token,
                "session-revoke".into(),
                Some("C:\\workspace".into()),
                pending,
                server_authority,
                emit,
            );
        });
        let client = std::thread::spawn(move || {
            std::panic::catch_unwind(|| {
                codex_context_call(address, &path, &token, 1, "question-revoke")
            })
        });

        received.recv_timeout(Duration::from_secs(5)).unwrap();
        authority.revoke();
        assert!(client.join().unwrap().is_err());
        server.join().unwrap();
        assert!(authority.connections.lock().unwrap().is_empty());
    }

    #[test]
    fn codex_mcp_never_dispatches_to_renderer_after_revoke_linearizes() {
        let authority = Arc::new(CodexLeaseAuthority::default());
        let dispatched = Arc::new(AtomicBool::new(false));
        let dispatch_authority = Arc::clone(&authority);
        let dispatch_observed = Arc::clone(&dispatched);
        let (emit_entered, entered_emit) = std::sync::mpsc::sync_channel(1);
        let (emit_released, release_emit) = std::sync::mpsc::sync_channel(1);
        let release_emit = Mutex::new(release_emit);
        let dispatch = std::thread::spawn(move || {
            dispatch_authority.dispatch(
                ToolGatewayRequest {
                    protocol_version: 1,
                    request_id: "request-race".into(),
                    session_id: "session-race".into(),
                    message_id: "message-race".into(),
                    tool: "vibespace_context".into(),
                    args: json!({ "operation": "search", "query": "race", "limit": 3 }),
                    directory: None,
                    worktree: None,
                },
                &move |_| {
                    emit_entered.send(()).unwrap();
                    release_emit.lock().unwrap().recv().unwrap();
                    dispatch_observed.store(true, Ordering::Release);
                    true
                },
            )
        });
        entered_emit.recv_timeout(Duration::from_secs(5)).unwrap();
        let revoke_authority = Arc::clone(&authority);
        let revoke = std::thread::spawn(move || {
            revoke_authority.revoke();
        });
        assert!(!authority.is_revoked());
        emit_released.send(()).unwrap();
        assert!(dispatch.join().unwrap());
        revoke.join().unwrap();
        assert!(dispatched.load(Ordering::Acquire));
        assert!(!authority.dispatch(
            ToolGatewayRequest {
                protocol_version: 1,
                request_id: "request-after-revoke".into(),
                session_id: "session-race".into(),
                message_id: "message-after-revoke".into(),
                tool: "vibespace_context".into(),
                args: json!({ "operation": "search", "query": "after", "limit": 3 }),
                directory: None,
                worktree: None,
            },
            &|_| panic!("renderer dispatch occurred after revoke linearized"),
        ));
    }

    #[test]
    fn codex_mcp_revocation_wins_a_concurrent_renderer_success() {
        let authority = Arc::new(CodexLeaseAuthority::default());
        let gate = authority.gate.lock().unwrap();
        let response_authority = Arc::clone(&authority);
        let response = std::thread::spawn(move || {
            response_authority.select_response(ToolGatewayResponse {
                request_id: "request-response-race".into(),
                ok: true,
                code: "ok".into(),
                message: "Ready".into(),
                data: Some(json!({ "query": "stale" })),
            })
        });
        authority.revoked.store(true, Ordering::Release);
        drop(gate);

        let selected = response.join().unwrap();
        assert!(!selected.ok);
        assert_eq!(selected.code, "authority_revoked");
        assert!(selected.data.is_none());
    }

    #[test]
    fn codex_context_lease_drop_joins_partial_read_and_renderer_wait_handlers() {
        let listener =
            TcpListener::bind(SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0)).unwrap();
        listener.set_nonblocking(true).unwrap();
        let address = listener.local_addr().unwrap();
        let path = "/v1/codex-context/drop-lifetime".to_string();
        let token = "t".repeat(64);
        let authority = Arc::new(CodexLeaseAuthority::default());
        let thread_authority = Arc::clone(&authority);
        let pending = Arc::new(PendingRequests::default());
        let (emitted, request_emitted) = std::sync::mpsc::sync_channel(1);
        let emit = Arc::new(move |_request: ToolGatewayRequest| emitted.send(()).is_ok());
        let thread_path = path.clone();
        let thread_token = token.clone();
        let listener_thread = std::thread::spawn(move || {
            serve_codex_context_listener(
                listener,
                thread_path,
                thread_token,
                "session-drop-lifetime".into(),
                Some("C:\\workspace".into()),
                pending,
                thread_authority,
                emit,
            );
        });
        let lease = CodexContextLease {
            url: format!("http://{address}{path}"),
            token: token.clone(),
            authority: Arc::clone(&authority),
            address,
            listener: Some(listener_thread),
        };

        let mut partial = TcpStream::connect(address).unwrap();
        partial
            .write_all(format!("POST {path} HTTP/1.1\r\nHost: {address}\r\n").as_bytes())
            .unwrap();
        let renderer_wait = std::thread::spawn(move || {
            std::panic::catch_unwind(|| {
                codex_context_call(address, &path, &token, 1, "drop-lifetime")
            })
        });
        request_emitted
            .recv_timeout(Duration::from_secs(5))
            .unwrap();
        while authority.connections.lock().unwrap().len() < 2 {
            std::thread::yield_now();
        }

        let started = Instant::now();
        drop(lease);
        assert!(started.elapsed() < Duration::from_secs(1));
        assert!(authority.connections.lock().unwrap().is_empty());
        assert_eq!(Arc::strong_count(&authority), 1);
        drop(partial);
        let _ = renderer_wait.join();
    }

    #[test]
    fn codex_mcp_bounds_active_handlers_and_synchronizes_replay_ids() {
        let active = Arc::new(Mutex::new(0_usize));
        let guards = (0..MAX_ACTIVE_CONNECTIONS)
            .map(|_| reserve_active_handler(&active).expect("capacity should be available"))
            .collect::<Vec<_>>();
        assert!(reserve_active_handler(&active).is_none());
        drop(guards);
        assert!(reserve_active_handler(&active).is_some());

        let seen = Arc::new(Mutex::new(HashSet::new()));
        let barrier = Arc::new(Barrier::new(9));
        let reservations = (0..8)
            .map(|_| {
                let seen = Arc::clone(&seen);
                let barrier = Arc::clone(&barrier);
                std::thread::spawn(move || {
                    barrier.wait();
                    reserve_shared_mcp_call_id(&seen, Some(&json!("same-call")))
                })
            })
            .collect::<Vec<_>>();
        barrier.wait();
        assert_eq!(
            reservations
                .into_iter()
                .map(|reservation| reservation.join().unwrap())
                .filter(|reserved| *reserved)
                .count(),
            1
        );
    }

    #[test]
    fn rejects_missing_or_inexact_bearer_authority() {
        let token = "t".repeat(64);
        assert!(validate_bearer(Some(&format!("Bearer {token}")), &token));
        assert!(!validate_bearer(None, &token));
        assert!(!validate_bearer(Some(&format!("bearer {token}")), &token));
        assert!(!validate_bearer(Some(&format!("Bearer {token}x")), &token));
    }

    #[test]
    fn rejects_oversized_malformed_or_unscoped_requests() {
        assert_eq!(
            parse_tool_request(&vec![b'x'; MAX_REQUEST_BODY_BYTES + 1])
                .unwrap_err()
                .code,
            "request_too_large"
        );
        assert_eq!(
            parse_tool_request(br#"{"protocolVersion":1}"#)
                .unwrap_err()
                .code,
            "invalid_request"
        );
        let mut unsafe_scope: serde_json::Value =
            serde_json::from_slice(&request("app.getState")).unwrap();
        unsafe_scope["directory"] = json!("..\\outside");
        assert_eq!(
            parse_tool_request(&serde_json::to_vec(&unsafe_scope).unwrap())
                .unwrap_err()
                .code,
            "invalid_scope"
        );
    }

    #[test]
    fn reserves_each_request_id_once_until_the_response_is_consumed() {
        let pending = PendingRequests::default();
        let receiver = pending.reserve("request-1").unwrap();
        assert_eq!(pending.reserve("request-1").unwrap_err().code, "conflict");
        pending
            .respond(ToolGatewayResponse {
                request_id: "request-1".into(),
                ok: true,
                code: "ok".into(),
                message: "Ready".into(),
                data: Some(json!({ "route": "chat" })),
            })
            .unwrap();
        assert_eq!(receiver.recv().unwrap().code, "ok");
        assert!(pending.reserve("request-1").is_ok());
    }

    #[test]
    fn bounds_and_sanitizes_renderer_results_before_returning_them_to_opencode() {
        let response = ToolGatewayResponse {
            request_id: "request-1".into(),
            ok: false,
            code: "internal_error".into(),
            message: format!("secret-token {}", "x".repeat(MAX_RESPONSE_BODY_BYTES)),
            data: Some(json!({ "apiKey": "must-not-leak" })),
        };
        let encoded = bounded_response_json(response).unwrap();
        assert!(encoded.len() <= MAX_RESPONSE_BODY_BYTES);
        let value: serde_json::Value = serde_json::from_slice(&encoded).unwrap();
        assert_eq!(value["requestId"], "request-1");
        assert_eq!(value["ok"], false);
        assert!(!value["message"].as_str().unwrap().contains("secret-token"));
        assert!(!value.to_string().contains("must-not-leak"));
    }

    #[test]
    fn preserves_bounded_semantic_token_counts_and_ranges() {
        let data = json!({
            "contextTokens": 73,
            "estimatedTokens": 71,
            "totalTokens": "10000000000000000",
            "indexedTokens": "10000000000000000",
            "tokenStart": "9007199254740992",
            "tokenEnd": "9007199254740993"
        });
        let encoded = bounded_response_json(ToolGatewayResponse {
            request_id: "request-1".into(),
            ok: true,
            code: "ok".into(),
            message: "Ready".into(),
            data: Some(data.clone()),
        })
        .unwrap();
        let value: serde_json::Value = serde_json::from_slice(&encoded).unwrap();
        assert_eq!(value["data"], data);
    }

    #[test]
    fn redacts_invalid_semantic_and_non_allowlisted_token_fields_recursively() {
        for (key, unsafe_value) in [
            ("contextTokens", json!(-1)),
            ("estimatedTokens", json!(1.5)),
            ("contextTokens", json!(9_007_199_254_740_992_u64)),
            ("totalTokens", json!("01")),
            ("indexedTokens", json!("1e9")),
            ("tokenStart", json!("+1")),
            ("tokenEnd", json!("\u{0000}1")),
            ("totalTokens", json!("1".repeat(100))),
            ("indexedTokens", json!("10000000000000001")),
            ("tokenStart", json!("secret-token")),
            ("accessToken", json!("never-return")),
            ("refreshToken", json!("never-return")),
            ("sessionToken", json!("never-return")),
            ("subscriptionToken", json!("never-return")),
            ("authToken", json!("never-return")),
            ("authorization", json!("never-return")),
            ("authentication", json!("never-return")),
            ("authHeader", json!("never-return")),
            ("apiKey", json!("never-return")),
            ("api_key", json!("never-return")),
            ("api-key", json!("never-return")),
            ("api.key", json!("never-return")),
            ("cookie", json!("never-return")),
            ("credential", json!("never-return")),
        ] {
            let mut root = serde_json::Map::new();
            root.insert(key.into(), unsafe_value.clone());
            let mut nested = serde_json::Map::new();
            nested.insert(key.into(), unsafe_value);
            for (data, pointer) in [
                (serde_json::Value::Object(root), format!("/data/{key}")),
                (json!({ "nested": nested }), format!("/data/nested/{key}")),
            ] {
                let encoded = bounded_response_json(ToolGatewayResponse {
                    request_id: "request-1".into(),
                    ok: true,
                    code: "ok".into(),
                    message: "Ready".into(),
                    data: Some(data),
                })
                .unwrap();
                let value: serde_json::Value = serde_json::from_slice(&encoded).unwrap();
                assert_eq!(value.pointer(&pointer).unwrap(), "[redacted]", "{key}");
            }
        }
    }

    #[test]
    fn does_not_overmatch_ordinary_author_or_authority_keys() {
        for key in ["author", "authority"] {
            let mut data = serde_json::Map::new();
            data.insert(key.into(), json!("bounded-value"));
            let encoded = bounded_response_json(ToolGatewayResponse {
                request_id: "request-1".into(),
                ok: true,
                code: "ok".into(),
                message: "Ready".into(),
                data: Some(serde_json::Value::Object(data)),
            })
            .unwrap();
            let value: serde_json::Value = serde_json::from_slice(&encoded).unwrap();
            assert_eq!(value["data"][key], "bounded-value", "{key}");
        }
    }

    #[test]
    fn retains_the_encoded_response_size_cap_for_otherwise_safe_data() {
        let encoded = bounded_response_json(ToolGatewayResponse {
            request_id: "request-1".into(),
            ok: true,
            code: "ok".into(),
            message: "Ready".into(),
            data: Some(json!({ "body": "x".repeat(MAX_RESPONSE_BODY_BYTES) })),
        })
        .unwrap();
        let value: serde_json::Value = serde_json::from_slice(&encoded).unwrap();
        assert_eq!(value["ok"], false);
        assert_eq!(value["code"], "response_too_large");
        assert!(value.get("data").is_none());
    }
}
