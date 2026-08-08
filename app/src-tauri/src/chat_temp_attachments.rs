use serde::Serialize;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::Manager;

const RETENTION: Duration = Duration::from_secs(24 * 60 * 60);
const MAX_TEXT_BYTES: usize = 8 * 1024 * 1024;
const FILE_PREFIX: &str = "vibespace-chat-";

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatTempAttachment {
    path: String,
    name: String,
    expires_at: u64,
}

fn attachment_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_cache_dir()
        .map(|path| path.join("chat-attachments"))
        .map_err(|error| format!("cache_dir_unavailable: {error}"))
}

fn is_managed_text_file(path: &Path) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.starts_with(FILE_PREFIX) && name.ends_with(".txt"))
}

fn cleanup_dir(directory: &Path, now: SystemTime) -> Result<u32, String> {
    let entries = match fs::read_dir(directory) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(0),
        Err(error) => return Err(format!("cleanup_read_failed: {error}")),
    };
    let cutoff = now.checked_sub(RETENTION).unwrap_or(UNIX_EPOCH);
    let mut removed = 0;
    for entry in entries.flatten() {
        let path = entry.path();
        let metadata = match entry.metadata() {
            Ok(metadata) if metadata.is_file() && !metadata.file_type().is_symlink() => metadata,
            _ => continue,
        };
        if !is_managed_text_file(&path) {
            continue;
        }
        let expired = metadata
            .modified()
            .map(|modified| modified <= cutoff)
            .unwrap_or(false);
        if expired && fs::remove_file(&path).is_ok() {
            removed += 1;
        }
    }
    Ok(removed)
}

#[tauri::command]
pub fn chat_temp_attachment_cleanup(app: tauri::AppHandle) -> Result<u32, String> {
    cleanup_dir(&attachment_dir(&app)?, SystemTime::now())
}

#[tauri::command]
pub fn chat_temp_attachment_create(
    app: tauri::AppHandle,
    content: String,
) -> Result<ChatTempAttachment, String> {
    if content.trim().is_empty() {
        return Err("empty_content".to_string());
    }
    if content.len() > MAX_TEXT_BYTES {
        return Err("content_too_large".to_string());
    }
    let directory = attachment_dir(&app)?;
    fs::create_dir_all(&directory).map_err(|error| format!("create_dir_failed: {error}"))?;
    let now = SystemTime::now();
    let _ = cleanup_dir(&directory, now);
    let created_at = now
        .duration_since(UNIX_EPOCH)
        .map_err(|_| "clock_invalid".to_string())?
        .as_millis() as u64;

    for _ in 0..8 {
        let name = format!("{FILE_PREFIX}{created_at}-{}.txt", nanoid::nanoid!(8));
        let path = directory.join(&name);
        let mut file = match OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(format!("create_file_failed: {error}")),
        };
        file.write_all(content.as_bytes())
            .and_then(|_| file.sync_all())
            .map_err(|error| {
                let _ = fs::remove_file(&path);
                format!("write_failed: {error}")
            })?;
        return Ok(ChatTempAttachment {
            path: path.to_string_lossy().into_owned(),
            name,
            expires_at: created_at + RETENTION.as_millis() as u64,
        });
    }
    Err("name_collision".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cleanup_only_removes_expired_managed_text_files() {
        let root = std::env::temp_dir().join(format!(
            "vibespace-chat-attachment-test-{}",
            nanoid::nanoid!()
        ));
        fs::create_dir_all(&root).unwrap();
        let expired = root.join("vibespace-chat-old.txt");
        let unrelated = root.join("keep.txt");
        fs::write(&expired, "old").unwrap();
        fs::write(&unrelated, "keep").unwrap();

        let removed = cleanup_dir(
            &root,
            SystemTime::now() + RETENTION + Duration::from_secs(1),
        )
        .unwrap();
        assert_eq!(removed, 1);
        assert!(!expired.exists());
        assert!(unrelated.exists());
        fs::remove_dir_all(root).unwrap();
    }
}
