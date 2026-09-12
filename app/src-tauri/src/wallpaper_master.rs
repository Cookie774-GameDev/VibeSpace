//! Full-quality wallpaper master import (local folder → app cache).
//! Used when cloud signed downloads are unavailable so Desktop can still
//! install the complete MP4, not the tiny 1s catalog preview.

use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::Manager;

use crate::static_server::CommandError;

type CmdResult<T> = Result<T, CommandError>;

fn err(code: &str, message: impl Into<String>, recoverable: bool) -> CommandError {
    CommandError {
        code: code.to_string(),
        message: message.into(),
        recoverable,
    }
}

fn slugify_stem(stem: &str) -> String {
    let mut s: String = stem
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() {
                c.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .collect();
    while s.contains("--") {
        s = s.replace("--", "-");
    }
    s.trim_matches('-').chars().take(80).collect()
}

/// Default masters folder used for local full-quality imports on this machine.
fn default_masters_dir() -> PathBuf {
    if let Ok(custom) = std::env::var("VIBESPACE_WALLPAPER_MASTERS") {
        return PathBuf::from(custom);
    }
    // Developer catalog source folder (Windows).
    if let Ok(user) = std::env::var("USERPROFILE") {
        let p = PathBuf::from(user)
            .join("Downloads")
            .join("VibeSpace-WallpAPPERS");
        if p.is_dir() {
            return p;
        }
    }
    PathBuf::from(r"C:\Users\viper\Downloads\VibeSpace-WallpAPPERS")
}

fn find_master_for_slug(masters: &Path, slug: &str) -> Option<PathBuf> {
    let target = slug.to_ascii_lowercase();
    let Ok(rd) = fs::read_dir(masters) else {
        return None;
    };
    for entry in rd.flatten() {
        let path = entry.path();
        if !path
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.eq_ignore_ascii_case("mp4"))
            .unwrap_or(false)
        {
            continue;
        }
        let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("");
        if slugify_stem(stem) == target {
            return Some(path);
        }
    }
    None
}

#[derive(Debug, Clone, Serialize)]
pub struct WallpaperMasterInfo {
    pub slug: String,
    pub source_path: String,
    pub size_bytes: u64,
}

#[tauri::command]
pub fn wallpaper_find_local_master(
    slug: String,
    masters_dir: Option<String>,
) -> CmdResult<WallpaperMasterInfo> {
    let dir = masters_dir
        .filter(|s| !s.trim().is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(default_masters_dir);
    if !dir.is_dir() {
        return Err(err(
            "masters_missing",
            format!("Wallpaper masters folder not found: {}", dir.display()),
            true,
        ));
    }
    let path = find_master_for_slug(&dir, &slug).ok_or_else(|| {
        err(
            "master_not_found",
            format!("No full MP4 for slug '{slug}' in {}", dir.display()),
            true,
        )
    })?;
    let meta = fs::metadata(&path).map_err(|e| err("io", e.to_string(), true))?;
    Ok(WallpaperMasterInfo {
        slug,
        source_path: path.display().to_string(),
        size_bytes: meta.len(),
    })
}

/// Copy full master MP4 into app data and return the absolute cache path.
#[tauri::command]
pub fn wallpaper_cache_full_master(
    app: tauri::AppHandle,
    slug: String,
    wallpaper_id: String,
    masters_dir: Option<String>,
) -> CmdResult<serde_json::Value> {
    let dir = masters_dir
        .filter(|s| !s.trim().is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(default_masters_dir);
    let source = find_master_for_slug(&dir, &slug).ok_or_else(|| {
        err(
            "master_not_found",
            format!("No full MP4 for slug '{slug}' in {}", dir.display()),
            true,
        )
    })?;

    let cache_root = app
        .path()
        .app_data_dir()
        .map_err(|e| err("cache_path", e.to_string(), true))?
        .join("wallpapers")
        .join("full");
    fs::create_dir_all(&cache_root).map_err(|e| err("cache_path", e.to_string(), true))?;

    let safe_id = wallpaper_id
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect::<String>();
    let dest = cache_root.join(format!("{safe_id}.mp4"));

    // Always refresh from master so quality is never a stale tiny preview.
    fs::copy(&source, &dest).map_err(|e| {
        err(
            "copy_failed",
            format!("Could not cache full wallpaper: {e}"),
            true,
        )
    })?;

    let meta = fs::metadata(&dest).map_err(|e| err("io", e.to_string(), true))?;
    if meta.len() < 500_000 {
        // Guard against accidentally caching a tiny preview file as "full".
        let _ = fs::remove_file(&dest);
        return Err(err(
            "too_small",
            format!(
                "Cached file is only {} bytes — refusing (expected full master).",
                meta.len()
            ),
            true,
        ));
    }

    Ok(serde_json::json!({
        "path": dest.display().to_string(),
        "size_bytes": meta.len(),
        "slug": slug,
        "source_path": source.display().to_string(),
    }))
}

#[tauri::command]
pub fn wallpaper_full_cache_path(app: tauri::AppHandle, wallpaper_id: String) -> Option<String> {
    let safe_id = wallpaper_id
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect::<String>();
    let path = app
        .path()
        .app_data_dir()
        .ok()?
        .join("wallpapers")
        .join("full")
        .join(format!("{safe_id}.mp4"));
    if path.is_file() {
        Some(path.display().to_string())
    } else {
        None
    }
}
