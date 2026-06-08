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
use std::sync::atomic::{AtomicBool, Ordering};
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
    active: Arc<AtomicBool>,
    deleted: Arc<AtomicBool>,
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
    pub project_id: Option<String>,
    pub project_name: Option<String>,
    pub deleted: bool,
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

const MAX_TERMINAL_SESSIONS: usize = 10;

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

fn decode_terminal_bytes(pending_utf8: &mut Vec<u8>, chunk: &[u8]) -> Option<String> {
    if chunk.is_empty() && pending_utf8.is_empty() {
        return None;
    }

    let mut bytes = Vec::with_capacity(pending_utf8.len() + chunk.len());
    if !pending_utf8.is_empty() {
        bytes.extend_from_slice(pending_utf8);
        pending_utf8.clear();
    }
    bytes.extend_from_slice(chunk);

    match std::str::from_utf8(&bytes) {
        Ok(text) => Some(text.to_string()),
        Err(err) if err.error_len().is_none() => {
            let valid_up_to = err.valid_up_to();
            *pending_utf8 = bytes[valid_up_to..].to_vec();
            if valid_up_to == 0 {
                None
            } else {
                Some(String::from_utf8_lossy(&bytes[..valid_up_to]).to_string())
            }
        }
        Err(_) => Some(String::from_utf8_lossy(&bytes).to_string()),
    }
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
    project_id: Option<String>,
    project_name: Option<String>,
) -> Result<SpawnResponse, String> {
    let cmd_str = pick_default_shell(command);
    let mut evicted_handles = Vec::new();
    {
        let mut map = state.0.lock().await;
        let mut project_sessions: Vec<(String, u64)> = map
            .values()
            .filter(|h| {
                h.info.project_id == project_id
                    && h.active.load(Ordering::SeqCst)
                    && !h.deleted.load(Ordering::SeqCst)
            })
            .map(|h| (h.info.session_id.clone(), h.info.started_at))
            .collect();
        println!(
            "[terminal] Spawning PTY. Active sessions for project {:?} (name: {:?}): {}/{}",
            project_id,
            project_name,
            project_sessions.len(),
            MAX_TERMINAL_SESSIONS
        );
        if project_sessions.len() >= MAX_TERMINAL_SESSIONS {
            // Sort by started_at ascending (oldest first)
            project_sessions.sort_by_key(|k| k.1);
            let evict_count = project_sessions.len() - MAX_TERMINAL_SESSIONS + 1;
            for i in 0..evict_count {
                if let Some((sid, _)) = project_sessions.get(i) {
                    println!("[terminal] Evicting oldest session: {}", sid);
                    if let Some(handle) = map.remove(sid) {
                        evicted_handles.push(handle);
                    }
                }
            }
        }
    }
    for handle in evicted_handles {
        let mut killer = handle.killer.lock().await;
        let _ = killer.kill();
        handle.reader_task.abort();
    }

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
    #[cfg(target_os = "windows")]
    {
        builder.arg("-NoLogo");
        builder.arg("-NoProfile");
        builder.arg("-NoExit");
        builder.env("JARVIS_EMBEDDED_TERMINAL", "1");
    }
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
        project_id: project_id.clone(),
        project_name: project_name.clone(),
        deleted: false,
    };

    // Reader task. Owns the child + reader so it can wait() once the master
    // closes; emits `terminal://exit` exactly once on its way out. We use
    // `spawn_blocking` because `Read` is synchronous and waiting on PTY I/O
    // would otherwise stall the runtime.
    let app_emit = app.clone();
    let state_for_task = state.0.clone();
    let active_for_task = Arc::new(AtomicBool::new(true));
    let active_flag_for_task = active_for_task.clone();
    let session_for_task = session_id.clone();
    let reader_task = spawn_blocking(move || {
        let mut child = child;
        let mut reader = reader;
        let mut buf = [0u8; 4096];
        let mut pending_utf8 = Vec::new();
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    if let Some(data) = decode_terminal_bytes(&mut pending_utf8, &buf[..n]) {
                        let _ = app_emit.emit(
                            "terminal://output",
                            OutputPayload {
                                session_id: session_for_task.clone(),
                                data,
                            },
                        );
                    }
                }
                Err(_) => break,
            }
        }
        if let Some(data) = decode_terminal_bytes(&mut pending_utf8, &[]) {
            let _ = app_emit.emit(
                "terminal://output",
                OutputPayload {
                    session_id: session_for_task.clone(),
                    data,
                },
            );
        }
        let code = child.wait().ok().map(|s| s.exit_code() as i32);
        active_flag_for_task.store(false, Ordering::SeqCst);
        // Drop exited sessions from the active map so they no longer count
        // toward the per-project cap. This keeps natural shell exits from
        // permanently consuming one of the 10 project slots.
        state_for_task.blocking_lock().remove(&session_for_task);
        let _ = app_emit.emit(
            "terminal://exit",
            ExitPayload {
                session_id: session_for_task,
                code,
            },
        );
    });

    let deleted_flag_for_task = Arc::new(AtomicBool::new(false));
    let handle = PtyHandle {
        info,
        writer: Arc::new(AsyncMutex::new(writer)),
        master: Arc::new(AsyncMutex::new(pair.master)),
        killer: Arc::new(AsyncMutex::new(killer)),
        reader_task,
        active: active_for_task,
        deleted: deleted_flag_for_task,
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
    spawn_blocking(move || {
        let mut writer = writer_arc.blocking_lock();
        writer
            .write_all(data.as_bytes())
            .map_err(|e| format!("terminal: write failed: {e}"))?;
        writer
            .flush()
            .map_err(|e| format!("terminal: flush failed: {e}"))?;
        Ok::<(), String>(())
    })
    .await
    .map_err(|e| format!("terminal: spawn_blocking failed: {e}"))?
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
    spawn_blocking(move || {
        let master = master_arc.blocking_lock();
        master
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| format!("terminal: resize failed: {e}"))?;
        Ok::<(), String>(())
    })
    .await
    .map_err(|e| format!("terminal: spawn_blocking failed: {e}"))?
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
    let mut map = state.0.lock().await;
    if let Some(handle) = map.remove(&session_id) {
        handle.deleted.store(true, Ordering::SeqCst);
        handle.active.store(false, Ordering::SeqCst);
        handle.reader_task.abort();
        let killer_arc = handle.killer;
        spawn_blocking(move || {
            let mut killer = killer_arc.blocking_lock();
            let _ = killer.kill();
        });
    }
    Ok(())
}

/// Reassign an active PTY to a different project without restarting the child.
/// The renderer uses this when a terminal tile is dragged onto another project.
#[tauri::command]
pub async fn terminal_move(
    state: State<'_, TerminalState>,
    session_id: String,
    project_id: Option<String>,
    project_name: Option<String>,
) -> Result<(), String> {
    let mut map = state.0.lock().await;
    let h = map
        .get_mut(&session_id)
        .ok_or_else(|| format!("terminal: unknown session {session_id}"))?;
    h.info.project_id = project_id;
    h.info.project_name = project_name;
    Ok(())
}

/// Snapshot of every active session — useful for restoring panes after a
/// reload or for diagnostics in the UI.
#[tauri::command]
pub async fn terminal_list(state: State<'_, TerminalState>) -> Result<Vec<TerminalInfo>, String> {
    let map = state.0.lock().await;
    Ok(map
        .values()
        .filter(|h| h.active.load(Ordering::SeqCst) && !h.deleted.load(Ordering::SeqCst))
        .map(|h| {
            let mut info = h.info.clone();
            info.deleted = h.deleted.load(Ordering::SeqCst);
            info
        })
        .collect())
}

/// Prune terminal sessions that are not listed in active_session_ids
#[tauri::command]
pub async fn terminal_reconcile(
    state: State<'_, TerminalState>,
    active_session_ids: Vec<String>,
) -> Result<(), String> {
    if active_session_ids.is_empty() {
        println!("[terminal] Skipping reconcile with empty active session list");
        return Ok(());
    }

    let mut map = state.0.lock().await;
    let keys_to_remove: Vec<String> = map
        .keys()
        .filter(|k| !active_session_ids.contains(k))
        .cloned()
        .collect();

    for key in keys_to_remove {
        if let Some(handle) = map.remove(&key) {
            println!("[terminal] Killing orphaned PTY session: {}", key);
            let mut killer = handle.killer.lock().await;
            let _ = killer.kill();
            handle.reader_task.abort();
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::decode_terminal_bytes;

    #[test]
    fn decode_terminal_bytes_holds_split_utf8_until_complete() {
        let mut pending = Vec::new();
        let icon = "⚡".as_bytes();

        assert_eq!(decode_terminal_bytes(&mut pending, &icon[..1]), None);
        assert_eq!(
            decode_terminal_bytes(&mut pending, &icon[1..]),
            Some("⚡".to_string()),
        );
        assert!(pending.is_empty());
    }

    #[test]
    fn decode_terminal_bytes_emits_valid_prefix_before_pending_tail() {
        let mut pending = Vec::new();
        let icon = "⚡".as_bytes();

        assert_eq!(
            decode_terminal_bytes(&mut pending, &[b'O', b'K', icon[0]]),
            Some("OK".to_string()),
        );
        assert_eq!(
            decode_terminal_bytes(&mut pending, &icon[1..]),
            Some("⚡".to_string()),
        );
    }
}
