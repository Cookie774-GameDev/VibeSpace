//! PTY terminal backend (Wave 4 slice 1).
//!
//! Owns a `HashMap<sessionId, PtyHandle>` behind an `Arc<Mutex>`, exposes 5
//! Tauri commands (`spawn` / `write` / `resize` / `kill` / `list`) and emits 2
//! events (`terminal://output`, `terminal://exit`).
//!
//! Each session gets a `tokio::task::spawn_blocking` reader that loops on a
//! 4 KiB buffer, lossy UTF-8 decodes the bytes, and forwards them to the
//! WebView. When the PTY closes, the same task waits the child and emits
//! `terminal://exit` on its way out.
//!
//! No PII or terminal contents are ever written to logs; every failure mode
//! is mapped into a `"terminal: ..."`-prefixed `String` error so commands
//! never panic across the IPC boundary.
//!
//! Front-end contract: see `WAVE4_CONTRACTS.md` § Tauri command surface.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use tauri::async_runtime::{spawn_blocking, JoinHandle, Mutex as AsyncMutex};
use tauri::{AppHandle, Emitter, State};

/// Tauri-managed shared state. Keyed by short session id (`tty_<nanoid12>`).
///
/// We hide the inner map behind an async `Mutex` so commands can `.await`
/// while holding it; in practice we only hold it long enough to insert,
/// remove, or clone an `Arc` out of a value.
#[derive(Default)]
pub struct TerminalState(pub Arc<AsyncMutex<HashMap<String, PtyHandle>>>);

/// Per-session bookkeeping. Writer / master / child-killer each live behind
/// their own async mutex + `Arc` so a long-running `write` can't block a
/// concurrent `resize`, and the reader task can keep streaming output while
/// the main task issues control operations.
pub struct PtyHandle {
    info: TerminalInfo,
    writer: Arc<AsyncMutex<Box<dyn Write + Send>>>,
    master: Arc<AsyncMutex<Box<dyn MasterPty + Send>>>,
    killer: Arc<AsyncMutex<Box<dyn ChildKiller + Send + Sync>>>,
    reader_task: JoinHandle<()>,
}

/// Metadata returned by `terminal_list`. Serialised as camelCase to match
/// the JS contract (`{ sessionId, command, cwd, rows, cols, startedAt }`).
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalInfo {
    pub session_id: String,
    pub command: String,
    pub cwd: String,
    pub rows: u16,
    pub cols: u16,
    pub started_at: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpawnResponse {
    pub session_id: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct OutputPayload {
    session_id: String,
    data: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ExitPayload {
    session_id: String,
    code: Option<i32>,
}

/// Resolve which executable to launch when the caller didn't pick one.
///
/// * Windows -> `powershell.exe` (Windows 10 1809+ ships ConPTY, which is
///   what `portable-pty` uses behind the scenes).
/// * Unix    -> `$SHELL`, falling back to `/bin/zsh` then `/bin/bash`.
fn pick_default_shell(custom: Option<String>) -> String {
    if let Some(cmd) = custom {
        return cmd;
    }
    #[cfg(target_os = "windows")]
    {
        "powershell.exe".to_string()
    }
    #[cfg(not(target_os = "windows"))]
    {
        if let Ok(s) = std::env::var("SHELL") {
            if !s.is_empty() {
                return s;
            }
        }
        if std::path::Path::new("/bin/zsh").exists() {
            "/bin/zsh".to_string()
        } else {
            "/bin/bash".to_string()
        }
    }
}

fn now_unix_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Spawn a new PTY-backed child process and return its session id. The reader
/// task is started in the background; subsequent output flows over the
/// `terminal://output` event.
#[tauri::command]
pub async fn terminal_spawn(
    state: State<'_, TerminalState>,
    app: AppHandle,
    command: Option<String>,
    cwd: Option<String>,
    rows: u16,
    cols: u16,
    env: Option<HashMap<String, String>>,
) -> Result<SpawnResponse, String> {
    let cmd_str = pick_default_shell(command);

    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("terminal: open pty failed: {e}"))?;

    let mut builder = CommandBuilder::new(&cmd_str);
    let resolved_cwd = if let Some(c) = cwd {
        builder.cwd(&c);
        c
    } else {
        std::env::current_dir()
            .ok()
            .and_then(|p| p.to_str().map(String::from))
            .unwrap_or_default()
    };
    if let Some(env_map) = env {
        for (k, v) in env_map {
            builder.env(k, v);
        }
    }

    let child = pair
        .slave
        .spawn_command(builder)
        .map_err(|e| format!("terminal: spawn failed: {e}"))?;
    // Drop the slave handle now: the child process holds its own reference
    // to the slave fd, and dropping ours means the master will see EOF as
    // soon as the child exits (instead of hanging forever).
    drop(pair.slave);

    let reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("terminal: reader clone failed: {e}"))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("terminal: writer take failed: {e}"))?;
    let killer = child.clone_killer();

    let session_id = format!("tty_{}", nanoid::nanoid!(12));
    let info = TerminalInfo {
        session_id: session_id.clone(),
        command: cmd_str,
        cwd: resolved_cwd,
        rows,
        cols,
        started_at: now_unix_ms(),
    };

    // Reader task. Owns the child + reader so it can wait() once the master
    // closes; emits `terminal://exit` exactly once on its way out. We use
    // `spawn_blocking` because `Read` is synchronous and waiting on PTY I/O
    // would otherwise stall the runtime.
    let app_emit = app.clone();
    let session_for_task = session_id.clone();
    let reader_task = spawn_blocking(move || {
        let mut child = child;
        let mut reader = reader;
        let mut buf = [0u8; 4096];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    // Lossy UTF-8 — terminals frequently emit partial code
                    // points across read boundaries; replacement chars are
                    // acceptable because xterm.js will repaint on the next
                    // chunk.
                    let data = String::from_utf8_lossy(&buf[..n]).to_string();
                    let _ = app_emit.emit(
                        "terminal://output",
                        OutputPayload {
                            session_id: session_for_task.clone(),
                            data,
                        },
                    );
                }
                Err(_) => break,
            }
        }
        let code = child.wait().ok().map(|s| s.exit_code() as i32);
        let _ = app_emit.emit(
            "terminal://exit",
            ExitPayload {
                session_id: session_for_task,
                code,
            },
        );
    });

    let handle = PtyHandle {
        info,
        writer: Arc::new(AsyncMutex::new(writer)),
        master: Arc::new(AsyncMutex::new(pair.master)),
        killer: Arc::new(AsyncMutex::new(killer)),
        reader_task,
    };

    state.0.lock().await.insert(session_id.clone(), handle);
    Ok(SpawnResponse { session_id })
}

/// Forward keystrokes (or any UTF-8 byte stream) into the PTY's stdin.
#[tauri::command]
pub async fn terminal_write(
    state: State<'_, TerminalState>,
    session_id: String,
    data: String,
) -> Result<(), String> {
    // Clone just the writer Arc out of the map so we don't hold the global
    // state lock across the actual I/O.
    let writer_arc = {
        let map = state.0.lock().await;
        let h = map
            .get(&session_id)
            .ok_or_else(|| format!("terminal: unknown session {session_id}"))?;
        h.writer.clone()
    };
    let mut writer = writer_arc.lock().await;
    writer
        .write_all(data.as_bytes())
        .map_err(|e| format!("terminal: write failed: {e}"))?;
    writer
        .flush()
        .map_err(|e| format!("terminal: flush failed: {e}"))?;
    Ok(())
}

/// Tell the PTY about a new viewport size. The shell (and any TUI children)
/// will receive a `SIGWINCH` (or the ConPTY equivalent) and reflow.
#[tauri::command]
pub async fn terminal_resize(
    state: State<'_, TerminalState>,
    session_id: String,
    rows: u16,
    cols: u16,
) -> Result<(), String> {
    let master_arc = {
        let mut map = state.0.lock().await;
        let h = map
            .get_mut(&session_id)
            .ok_or_else(|| format!("terminal: unknown session {session_id}"))?;
        h.info.rows = rows;
        h.info.cols = cols;
        h.master.clone()
    };
    let master = master_arc.lock().await;
    master
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("terminal: resize failed: {e}"))?;
    Ok(())
}

/// Kill the child process, drop the writer, abort the reader task, and
/// remove the session from the map. The reader task usually still gets to
/// emit a final `terminal://exit` event because `spawn_blocking::abort` is
/// cooperative — the read syscall returns EOF as soon as the child dies.
#[tauri::command]
pub async fn terminal_kill(
    state: State<'_, TerminalState>,
    session_id: String,
) -> Result<(), String> {
    let removed = state.0.lock().await.remove(&session_id);
    let handle = removed.ok_or_else(|| format!("terminal: unknown session {session_id}"))?;
    {
        let mut killer = handle.killer.lock().await;
        // Best effort: if the child is already gone, the killer returns an
        // error — we don't surface it because the user-visible result is
        // the same.
        let _ = killer.kill();
    }
    handle.reader_task.abort();
    drop(handle.writer);
    Ok(())
}

/// Snapshot of every active session — useful for restoring panes after a
/// reload or for diagnostics in the UI.
#[tauri::command]
pub async fn terminal_list(
    state: State<'_, TerminalState>,
) -> Result<Vec<TerminalInfo>, String> {
    let map = state.0.lock().await;
    Ok(map.values().map(|h| h.info.clone()).collect())
}
