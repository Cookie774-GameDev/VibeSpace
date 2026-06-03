//! `fs_read_text` — small, narrowly-scoped command for reading user-
//! authored text files into the WebView.
//!
//! Why a custom command instead of `tauri-plugin-fs`:
//! the plugin is general-purpose and brings its own scope/permission
//! ceremony. We only need a single read path with a hard size cap
//! and a UTF-8 guarantee, so a 30-line command is cleaner than wiring
//! the whole plugin + its capability graph.
//!
//! Surface area:
//!   - Caller passes an absolute path.
//!   - The command rejects relative paths, non-files, files larger
//!     than `MAX_FILE_BYTES`, and non-UTF8 content.
//!   - Returns a `String` on success or a string error code on failure.
//!
//! Used by:
//!   - The "Connected files" pop-out in the terminals page chrome:
//!     when the user pins files to a pane, the AI runtime reads them
//!     here and prepends an excerpt to the agent's system prompt.
//!
//! Invariants (intentional):
//!   - This command is read-only. No write counterpart yet — the AI
//!     workflow doesn't need one and the safest privilege is "only
//!     what's used."
//!   - No directory listing, no globbing — keep the surface tight.
//!   - The size cap (1 MiB) is conservative; readers typically chop
//!     to a few KB before sending to a model anyway. If a user pins a
//!     huge log we surface a clear error rather than reading
//!     gigabytes into the WebView heap.

use serde::Serialize;
use std::path::PathBuf;

/// Hard ceiling on a single file. Anything bigger is rejected with
/// `too_large` so callers don't accidentally force a multi-GB read
/// into the WebView heap. 1 MiB ≈ 250k tokens worth of text — plenty
/// for any prompt context the user could realistically want.
const MAX_FILE_BYTES: u64 = 1024 * 1024;
const MAX_WRITE_BYTES: usize = 1024 * 1024;
const MAX_DIR_ENTRIES: usize = 500;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FsEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size: Option<u64>,
    pub created_ms: Option<u128>,
    pub modified_ms: Option<u128>,
}

fn require_absolute(path: &str) -> Result<PathBuf, String> {
    let p = PathBuf::from(path);
    if !p.is_absolute() {
        return Err("not_absolute".to_string());
    }
    Ok(p)
}

/// Read a UTF-8 text file in full and return its contents.
///
/// Errors are returned as short stable strings so the JS side can
/// branch on them without parsing English. The list:
///
///   - `not_absolute` — path was relative.
///   - `not_found` — path doesn't exist.
///   - `not_a_file` — path exists but is not a regular file (e.g. directory).
///   - `too_large` — file exceeds `MAX_FILE_BYTES`.
///   - `not_utf8` — bytes are not valid UTF-8.
///   - `io: <message>` — anything else, prefixed for grep-ability.
#[tauri::command]
pub fn fs_read_text(path: String) -> Result<String, String> {
    let p = require_absolute(&path)?;
    let meta = match std::fs::metadata(&p) {
        Ok(m) => m,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Err("not_found".to_string());
        }
        Err(e) => return Err(format!("io: {}", e)),
    };
    if !meta.is_file() {
        return Err("not_a_file".to_string());
    }
    if meta.len() > MAX_FILE_BYTES {
        return Err("too_large".to_string());
    }
    let bytes = std::fs::read(&p).map_err(|e| format!("io: {}", e))?;
    String::from_utf8(bytes).map_err(|_| "not_utf8".to_string())
}

#[tauri::command]
pub fn fs_list_dir(path: String) -> Result<Vec<FsEntry>, String> {
    let p = require_absolute(&path)?;
    let meta = match std::fs::metadata(&p) {
        Ok(m) => m,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Err("not_found".to_string());
        }
        Err(e) => return Err(format!("io: {}", e)),
    };
    if !meta.is_dir() {
        return Err("not_a_dir".to_string());
    }

    let mut out = Vec::new();
    for entry in std::fs::read_dir(&p).map_err(|e| format!("io: {}", e))? {
        if out.len() >= MAX_DIR_ENTRIES {
            break;
        }
        let entry = entry.map_err(|e| format!("io: {}", e))?;
        let path = entry.path();
        let meta = entry.metadata().ok();
        let is_dir = meta.as_ref().map(|m| m.is_dir()).unwrap_or(false);
        let created_ms = meta
            .as_ref()
            .and_then(|m| m.created().ok())
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis());
        let modified_ms = meta
            .as_ref()
            .and_then(|m| m.modified().ok())
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis());
        out.push(FsEntry {
            name: entry.file_name().to_string_lossy().to_string(),
            path: path.to_string_lossy().to_string(),
            is_dir,
            size: meta.as_ref().filter(|m| m.is_file()).map(|m| m.len()),
            created_ms,
            modified_ms,
        });
    }
    out.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase())));
    Ok(out)
}

#[tauri::command]
pub fn fs_write_text(path: String, content: String) -> Result<(), String> {
    let p = require_absolute(&path)?;
    if content.len() > MAX_WRITE_BYTES {
        return Err("too_large".to_string());
    }
    if let Some(parent) = p.parent() {
        if !parent.exists() {
            return Err("parent_not_found".to_string());
        }
    }
    std::fs::write(&p, content.as_bytes()).map_err(|e| format!("io: {}", e))
}

#[tauri::command]
pub fn fs_create_text_file(path: String) -> Result<(), String> {
    let p = require_absolute(&path)?;
    if p.exists() {
        return Err("already_exists".to_string());
    }
    if let Some(parent) = p.parent() {
        if !parent.exists() {
            return Err("parent_not_found".to_string());
        }
    }
    std::fs::write(&p, b"").map_err(|e| format!("io: {}", e))
}
