//! Loopback-only static file server for Preview Studio local HTML projects.
//! Binds 127.0.0.1 only; blocks path traversal; serves common content types.

use std::collections::HashMap;
use std::fs;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU16, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub struct StaticServerInfo {
    pub port: u16,
    pub root: String,
    pub url: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct CommandError {
    pub code: String,
    pub message: String,
    pub recoverable: bool,
}

type CmdResult<T> = Result<T, CommandError>;

struct ServerState {
    root: PathBuf,
    port: u16,
    stop: Arc<AtomicBool>,
}

static ACTIVE: Mutex<Option<ServerState>> = Mutex::new(None);
static LAST_PORT: AtomicU16 = AtomicU16::new(0);

fn err(code: &str, message: impl Into<String>, recoverable: bool) -> CommandError {
    CommandError {
        code: code.to_string(),
        message: message.into(),
        recoverable,
    }
}

fn content_type(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "html" | "htm" => "text/html; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "json" => "application/json; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "map" => "application/json",
        "txt" | "md" => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}

fn safe_join(root: &Path, request_path: &str) -> Option<PathBuf> {
    let decoded = request_path.split('?').next().unwrap_or(request_path);
    let decoded = percent_decode(decoded);
    let rel = decoded.trim_start_matches('/');
    let mut out = root.to_path_buf();
    for comp in Path::new(rel).components() {
        match comp {
            Component::Normal(c) => out.push(c),
            Component::CurDir => {}
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => return None,
        }
    }
    let canon_root = root.canonicalize().ok()?;
    if out.exists() {
        let candidate = out.canonicalize().ok()?;
        if candidate.starts_with(&canon_root) {
            Some(candidate)
        } else {
            None
        }
    } else if out.starts_with(root) {
        Some(out)
    } else {
        None
    }
}

fn percent_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let (Some(h), Some(l)) = (from_hex(bytes[i + 1]), from_hex(bytes[i + 2])) {
                out.push((h << 4) | l);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn from_hex(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

fn handle_client(mut stream: TcpStream, root: PathBuf) {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
    let mut buf = [0u8; 4096];
    let n = match stream.read(&mut buf) {
        Ok(n) if n > 0 => n,
        _ => return,
    };
    let req = String::from_utf8_lossy(&buf[..n]);
    let first = req.lines().next().unwrap_or("");
    let mut parts = first.split_whitespace();
    let method = parts.next().unwrap_or("GET");
    let path = parts.next().unwrap_or("/");
    if method != "GET" && method != "HEAD" {
        let _ = stream.write_all(
            b"HTTP/1.1 405 Method Not Allowed\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
        );
        return;
    }

    let mut file_path = match safe_join(&root, path) {
        Some(p) => p,
        None => {
            let body = b"403 Forbidden";
            let _ = write!(
                stream,
                "HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            );
            let _ = stream.write_all(body);
            return;
        }
    };

    if file_path.is_dir() {
        file_path.push("index.html");
    }

    match fs::read(&file_path) {
        Ok(bytes) => {
            let ct = content_type(&file_path);
            let _ = write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Type: {}\r\nContent-Length: {}\r\nCache-Control: no-cache\r\nConnection: close\r\nAccess-Control-Allow-Origin: *\r\n\r\n",
                ct,
                bytes.len()
            );
            if method == "GET" {
                let _ = stream.write_all(&bytes);
            }
        }
        Err(_) => {
            let body = format!(
                "<!doctype html><html><body style=\"font-family:system-ui;background:#12141c;color:#f3e9d7;padding:2rem\"><h1>404</h1><p>Not found in preview root.</p><code>{}</code></body></html>",
                path
            );
            let _ = write!(
                stream,
                "HTTP/1.1 404 Not Found\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            );
        }
    }
}

fn bind_ephemeral() -> std::io::Result<(TcpListener, u16)> {
    let listener = TcpListener::bind(("127.0.0.1", 0))?;
    let port = listener.local_addr()?.port();
    Ok((listener, port))
}

#[tauri::command]
pub fn preview_start_static_server(root: String) -> CmdResult<StaticServerInfo> {
    let root_path = PathBuf::from(&root);
    if !root_path.is_dir() {
        return Err(err(
            "invalid_root",
            format!("Not a directory: {root}"),
            true,
        ));
    }
    let root_canon = root_path
        .canonicalize()
        .map_err(|e| err("permission_denied", e.to_string(), true))?;

    // Stop any existing server first.
    let _ = preview_stop_static_server();

    let (listener, port) = bind_ephemeral().map_err(|e| {
        err(
            "port_unavailable",
            format!("Could not bind loopback: {e}"),
            true,
        )
    })?;
    let _ = listener.set_nonblocking(false);
    let stop = Arc::new(AtomicBool::new(false));
    let stop_flag = stop.clone();
    let serve_root = root_canon.clone();

    thread::spawn(move || {
        let _ = listener.set_nonblocking(true);
        while !stop_flag.load(Ordering::SeqCst) {
            match listener.accept() {
                Ok((stream, _)) => {
                    let root = serve_root.clone();
                    thread::spawn(move || handle_client(stream, root));
                }
                Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    thread::sleep(Duration::from_millis(25));
                }
                Err(_) => break,
            }
        }
    });

    LAST_PORT.store(port, Ordering::SeqCst);
    *ACTIVE.lock().unwrap() = Some(ServerState {
        root: root_canon.clone(),
        port,
        stop,
    });

    Ok(StaticServerInfo {
        port,
        root: root_canon.display().to_string(),
        url: format!("http://127.0.0.1:{port}/"),
    })
}

#[tauri::command]
pub fn preview_stop_static_server() -> CmdResult<bool> {
    let mut guard = ACTIVE.lock().unwrap();
    if let Some(state) = guard.take() {
        state.stop.store(true, Ordering::SeqCst);
        // Nudge the accept loop by connecting once.
        let _ = TcpStream::connect(("127.0.0.1", state.port));
        return Ok(true);
    }
    Ok(false)
}

#[tauri::command]
pub fn preview_static_server_status() -> Option<StaticServerInfo> {
    ACTIVE.lock().unwrap().as_ref().map(|s| StaticServerInfo {
        port: s.port,
        root: s.root.display().to_string(),
        url: format!("http://127.0.0.1:{}/", s.port),
    })
}

/// Probe common localhost ports for an HTTP response (short timeouts).
#[tauri::command]
pub fn preview_probe_dev_servers() -> Vec<HashMap<String, String>> {
    let ports = [
        5173, 4173, 3000, 3001, 3002, 4200, 4321, 5000, 8000, 8080, 8888,
    ];
    let hosts = ["127.0.0.1", "localhost"];
    let mut found = Vec::new();
    for host in hosts {
        for port in ports {
            let url = format!("http://{host}:{port}/");
            if probe_http(&url) {
                let mut row = HashMap::new();
                row.insert("url".into(), url);
                row.insert("host".into(), host.into());
                row.insert("port".into(), port.to_string());
                found.push(row);
            }
        }
    }
    found
}

fn probe_http(url: &str) -> bool {
    let client = match reqwest::blocking::Client::builder()
        .timeout(Duration::from_millis(350))
        .redirect(reqwest::redirect::Policy::limited(2))
        .build()
    {
        Ok(c) => c,
        Err(_) => return false,
    };
    match client.get(url).send() {
        Ok(res) => res.status().as_u16() < 500,
        Err(_) => false,
    }
}
