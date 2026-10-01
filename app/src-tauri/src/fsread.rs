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
//!   - No globbing — keep the surface tight.
//!   - The size cap (100 MiB) is high enough for large project files,
//!     while prompt callers use `fs_read_text_sample` so huge logs do
//!     not get copied wholesale into the WebView heap.

use base64::Engine;
use cap_fs_ext::{DirExt, FollowSymlinks, OpenOptionsFollowExt};
use cap_std::fs::{Dir, OpenOptions};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::ffi::OsString;
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;

/// Hard ceiling on a single file. Anything bigger is rejected with
/// `too_large` so callers don't accidentally force a multi-GB read
/// into the WebView heap. Prompt callers should prefer
/// `fs_read_text_sample` and then apply their own token budget.
const MAX_FILE_BYTES: u64 = 100 * 1024 * 1024;
const MAX_WRITE_BYTES: usize = 1024 * 1024;
const MAX_DIR_ENTRIES: usize = 500;
const MAX_SAMPLE_BYTES: u64 = 1024 * 1024;
const MAX_IMAGE_BYTES: u64 = 8 * 1024 * 1024;
const MAX_TEXT_MUTATION_BYTES: usize = 256 * 1024;
const MAX_COPY_BYTES: u64 = 16 * 1024 * 1024;
static TEXT_MUTATION_LOCK: Mutex<()> = Mutex::new(());

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

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FsImageData {
    pub data: String,
    pub mime_type: String,
    pub size: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FsTextMutationReceipt {
    pub before_sha256: Option<String>,
    pub after_sha256: Option<String>,
    pub before_bytes: usize,
    pub after_bytes: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FsPathMetadata {
    pub kind: String,
    pub size: Option<u64>,
    pub created_ms: Option<u128>,
    pub modified_ms: Option<u128>,
    pub sha256: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FsFileTransferReceipt {
    pub bytes: u64,
    pub sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FsDirectoryReceipt {
    pub created: bool,
}

fn require_absolute(path: &str) -> Result<PathBuf, String> {
    let p = PathBuf::from(path);
    if !p.is_absolute() {
        return Err("not_absolute".to_string());
    }
    Ok(p)
}

fn reject_lexical_traversal(path: &Path) -> Result<(), String> {
    if path
        .components()
        .any(|component| matches!(component, Component::ParentDir))
    {
        return Err("outside_root".to_string());
    }
    Ok(())
}

#[cfg(windows)]
fn path_is_contained_or_equal(path: &Path, root: &Path) -> bool {
    let normalize = |value: &Path| {
        value
            .to_string_lossy()
            .replace('/', "\\")
            .trim_end_matches('\\')
            .to_lowercase()
    };
    let path = normalize(path);
    let root = normalize(root);
    path == root || path.starts_with(&format!("{root}\\"))
}

#[cfg(not(windows))]
fn path_is_contained_or_equal(path: &Path, root: &Path) -> bool {
    path == root || path.starts_with(root)
}

fn enforce_user_boundary(path: &Path, profile: &Path) -> Result<(), String> {
    let users_root = profile
        .parent()
        .ok_or_else(|| "other_user_folder".to_string())?;
    if path_is_contained_or_equal(path, users_root) && !path_is_contained_or_equal(path, profile) {
        return Err("other_user_folder".to_string());
    }
    Ok(())
}

#[cfg(windows)]
fn current_user_profile() -> Result<PathBuf, String> {
    use windows::Win32::System::Com::CoTaskMemFree;
    use windows::Win32::UI::Shell::{FOLDERID_Profile, SHGetKnownFolderPath, KF_FLAG_DEFAULT};

    let raw = unsafe { SHGetKnownFolderPath(&FOLDERID_Profile, KF_FLAG_DEFAULT, None) }
        .map_err(|_| "other_user_folder".to_string())?;
    let result = unsafe { raw.to_string() }
        .map(PathBuf::from)
        .map_err(|_| "other_user_folder".to_string());
    unsafe {
        CoTaskMemFree(Some(raw.0.cast()));
    }
    result.and_then(|path| {
        if path.is_absolute() {
            Ok(path)
        } else {
            Err("other_user_folder".to_string())
        }
    })
}

#[cfg(unix)]
fn current_user_profile() -> Result<PathBuf, String> {
    use users::os::unix::UserExt;

    let user = users::get_user_by_uid(users::get_current_uid())
        .ok_or_else(|| "other_user_folder".to_string())?;
    let profile = user.home_dir().to_path_buf();
    if profile.is_absolute() {
        Ok(profile)
    } else {
        Err("other_user_folder".to_string())
    }
}

fn validate_user_boundary(path: &Path) -> Result<(), String> {
    enforce_user_boundary(path, &current_user_profile()?)
}

fn absolute_anchor_and_components(path: &Path) -> Result<(PathBuf, Vec<OsString>), String> {
    require_absolute(&path.to_string_lossy())?;
    reject_lexical_traversal(path)?;

    let mut anchor = PathBuf::new();
    let mut relative = Vec::new();
    for component in path.components() {
        match component {
            Component::Prefix(prefix) => {
                #[cfg(windows)]
                if !matches!(prefix.kind(), std::path::Prefix::Disk(_)) {
                    return Err("outside_root".to_string());
                }
                anchor.push(component.as_os_str());
            }
            Component::RootDir => anchor.push(component.as_os_str()),
            Component::CurDir => {}
            Component::ParentDir => return Err("outside_root".to_string()),
            Component::Normal(value) => relative.push(value.to_os_string()),
        }
    }
    if anchor.as_os_str().is_empty() {
        return Err("not_absolute".to_string());
    }
    Ok((anchor, relative))
}

#[cfg(windows)]
fn path_component_eq(left: &OsString, right: &OsString) -> bool {
    left.to_string_lossy()
        .eq_ignore_ascii_case(&right.to_string_lossy())
}

#[cfg(not(windows))]
fn path_component_eq(left: &OsString, right: &OsString) -> bool {
    left == right
}

fn strict_relative_path(path: &Path, root: &Path) -> Result<PathBuf, String> {
    let (path_anchor, path_components) = absolute_anchor_and_components(path)?;
    let (root_anchor, root_components) = absolute_anchor_and_components(root)?;
    if !path_component_eq(
        &path_anchor.as_os_str().to_os_string(),
        &root_anchor.as_os_str().to_os_string(),
    ) || path_components.len() < root_components.len()
        || !path_components
            .iter()
            .zip(root_components.iter())
            .all(|(left, right)| path_component_eq(left, right))
    {
        return Err("outside_root".to_string());
    }
    Ok(path_components[root_components.len()..].iter().collect())
}

fn cap_entry_is_link(dir: &Dir, path: &Path) -> bool {
    dir.symlink_metadata(path)
        .map(|metadata| metadata.is_symlink())
        .unwrap_or(false)
}

fn map_cap_open_error(dir: &Dir, path: &Path, error: std::io::Error) -> String {
    if cap_entry_is_link(dir, path) {
        "symlink_blocked".to_string()
    } else if error.kind() == std::io::ErrorKind::NotFound {
        "not_found".to_string()
    } else {
        format!("io: {error}")
    }
}

struct StrictProjectRoot {
    dir: Dir,
    lexical_root: PathBuf,
}

impl StrictProjectRoot {
    fn open(root: Option<&str>) -> Result<Self, String> {
        let root = root
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| "outside_root".to_string())?;
        let lexical_root = require_absolute(root)?;
        reject_lexical_traversal(&lexical_root)?;
        validate_user_boundary(&lexical_root)?;

        let (anchor, components) = absolute_anchor_and_components(&lexical_root)?;
        let mut dir = Dir::open_ambient_dir(anchor, cap_fs_ext::ambient_authority())
            .map_err(|error| format!("io: {error}"))?;
        for component in components {
            let component_path = Path::new(&component);
            match dir.symlink_metadata(component_path) {
                Ok(metadata) if metadata.is_symlink() => {
                    return Err("symlink_blocked".to_string());
                }
                Ok(metadata) if !metadata.is_dir() => return Err("root_not_dir".to_string()),
                Ok(_) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    return Err("root_not_found".to_string());
                }
                Err(error) => return Err(format!("io: {error}")),
            }
            dir = dir.open_dir_nofollow(component_path).map_err(|error| {
                if cap_entry_is_link(&dir, component_path) {
                    "symlink_blocked".to_string()
                } else if error.kind() == std::io::ErrorKind::NotFound {
                    "root_not_found".to_string()
                } else {
                    format!("io: {error}")
                }
            })?;
        }

        #[cfg(unix)]
        {
            use cap_fs_ext::OsMetadataExt;
            if dir
                .dir_metadata()
                .map_err(|error| format!("io: {error}"))?
                .uid()
                != users::get_current_uid()
            {
                return Err("other_user_folder".to_string());
            }
        }

        Ok(Self { dir, lexical_root })
    }

    fn relative(&self, path: &str) -> Result<PathBuf, String> {
        strict_relative_path(&require_absolute(path)?, &self.lexical_root)
    }

    fn open_dir(&self, relative: &Path) -> Result<Dir, String> {
        let mut dir = Dir::reopen_dir(&self.dir).map_err(|error| format!("io: {error}"))?;
        for component in relative.components() {
            let Component::Normal(name) = component else {
                return Err("outside_root".to_string());
            };
            let component_path = Path::new(name);
            if cap_entry_is_link(&dir, component_path) {
                return Err("symlink_blocked".to_string());
            }
            dir = dir
                .open_dir_nofollow(component_path)
                .map_err(|error| map_cap_open_error(&dir, component_path, error))?;
        }
        Ok(dir)
    }

    fn open_file(&self, relative: &Path) -> Result<cap_std::fs::File, String> {
        let name = relative
            .file_name()
            .ok_or_else(|| "not_a_file".to_string())?;
        let parent = relative.parent().unwrap_or_else(|| Path::new(""));
        let dir = self.open_dir(parent)?;
        let name_path = Path::new(name);
        if cap_entry_is_link(&dir, name_path) {
            return Err("symlink_blocked".to_string());
        }
        let mut options = OpenOptions::new();
        options.read(true).follow(FollowSymlinks::No);
        dir.open_with(name_path, &options)
            .map_err(|error| map_cap_open_error(&dir, name_path, error))
    }

    fn file_parent_and_name(&self, path: &str) -> Result<(Dir, PathBuf), String> {
        let relative = self.relative(path)?;
        let name = relative
            .file_name()
            .ok_or_else(|| "not_a_file".to_string())?;
        let parent = relative.parent().unwrap_or_else(|| Path::new(""));
        Ok((self.open_dir(parent)?, PathBuf::from(name)))
    }

    fn create_directory_path(&self, path: &str) -> Result<bool, String> {
        let relative = self.relative(path)?;
        if relative.as_os_str().is_empty() {
            return Ok(false);
        }
        let mut dir = Dir::reopen_dir(&self.dir).map_err(|error| format!("io: {error}"))?;
        let mut created = false;
        for component in relative.components() {
            let Component::Normal(name) = component else {
                return Err("outside_root".to_string());
            };
            let component_path = Path::new(name);
            match dir.symlink_metadata(component_path) {
                Ok(metadata) if metadata.is_symlink() => {
                    return Err("symlink_blocked".to_string());
                }
                Ok(metadata) if !metadata.is_dir() => return Err("not_a_dir".to_string()),
                Ok(_) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    dir.create_dir(component_path).map_err(|create_error| {
                        if create_error.kind() == std::io::ErrorKind::AlreadyExists {
                            "already_exists".to_string()
                        } else {
                            format!("io: {create_error}")
                        }
                    })?;
                    created = true;
                }
                Err(error) => return Err(format!("io: {error}")),
            }
            dir = dir.open_dir_nofollow(component_path).map_err(|error| {
                if cap_entry_is_link(&dir, component_path) {
                    "symlink_blocked".to_string()
                } else if error.kind() == std::io::ErrorKind::NotFound {
                    "not_found".to_string()
                } else {
                    format!("io: {error}")
                }
            })?;
        }
        Ok(created)
    }
}

fn cap_time_ms(value: std::io::Result<cap_std::time::SystemTime>) -> Option<u128> {
    value
        .ok()
        .and_then(|time| time.into_std().duration_since(std::time::UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis())
}

fn hash_open_file(
    mut file: cap_std::fs::File,
    maximum_bytes: u64,
) -> Result<(String, u64), String> {
    let metadata = file.metadata().map_err(|error| format!("io: {error}"))?;
    if !metadata.is_file() {
        return Err("not_a_file".to_string());
    }
    if metadata.len() > maximum_bytes {
        return Err("too_large".to_string());
    }
    let mut digest = Sha256::new();
    let mut bytes = 0_u64;
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|error| format!("io: {error}"))?;
        if read == 0 {
            break;
        }
        bytes = bytes
            .checked_add(read as u64)
            .ok_or_else(|| "too_large".to_string())?;
        if bytes > maximum_bytes {
            return Err("too_large".to_string());
        }
        digest.update(&buffer[..read]);
    }
    Ok((format!("sha256:{:x}", digest.finalize()), bytes))
}

fn canonical_root(root: Option<&str>) -> Result<Option<PathBuf>, String> {
    let Some(root) = root.filter(|value| !value.trim().is_empty()) else {
        return Ok(None);
    };
    let root_path = require_absolute(root)?;
    let canonical = std::fs::canonicalize(&root_path).map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            "root_not_found".to_string()
        } else {
            format!("io: {}", e)
        }
    })?;
    if !canonical.is_dir() {
        return Err("root_not_dir".to_string());
    }
    Ok(Some(canonical))
}

fn ensure_inside_root(path: &Path, root: Option<&PathBuf>) -> Result<(), String> {
    if let Some(root) = root {
        if !path.starts_with(root) {
            return Err("outside_root".to_string());
        }
    }
    Ok(())
}

fn existing_path(path: &str, root: Option<&str>) -> Result<PathBuf, String> {
    let p = require_absolute(path)?;
    let root = canonical_root(root)?;
    let canonical = std::fs::canonicalize(&p).map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            "not_found".to_string()
        } else {
            format!("io: {}", e)
        }
    })?;
    ensure_inside_root(&canonical, root.as_ref())?;
    Ok(canonical)
}

fn writable_path(path: &str, root: Option<&str>) -> Result<PathBuf, String> {
    let p = require_absolute(path)?;
    let root = canonical_root(root)?;
    if p.exists() {
        let canonical = std::fs::canonicalize(&p).map_err(|e| format!("io: {}", e))?;
        ensure_inside_root(&canonical, root.as_ref())?;
        return Ok(canonical);
    }
    let parent = p.parent().ok_or_else(|| "parent_not_found".to_string())?;
    if !parent.exists() {
        return Err("parent_not_found".to_string());
    }
    let canonical_parent = std::fs::canonicalize(parent).map_err(|e| format!("io: {}", e))?;
    ensure_inside_root(&canonical_parent, root.as_ref())?;
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
pub fn fs_read_text(path: String, root: Option<String>) -> Result<String, String> {
    let p = existing_path(&path, root.as_deref())?;
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
pub fn fs_read_text_sample(
    path: String,
    max_bytes: Option<u64>,
    root: Option<String>,
    strict_project_boundary: Option<bool>,
) -> Result<String, String> {
    let limit = max_bytes
        .unwrap_or(MAX_SAMPLE_BYTES)
        .clamp(1, MAX_SAMPLE_BYTES);
    if strict_project_boundary.unwrap_or(false) {
        let strict_root = StrictProjectRoot::open(root.as_deref())?;
        let relative = strict_root.relative(&path)?;
        let file = strict_root.open_file(&relative)?;
        return read_text_sample_from_open_file(file, limit);
    }

    let p = existing_path(&path, root.as_deref())?;
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
    let mut file = std::fs::File::open(&p).map_err(|e| format!("io: {}", e))?;
    let mut bytes = Vec::with_capacity(limit as usize);
    Read::by_ref(&mut file)
        .take(limit)
        .read_to_end(&mut bytes)
        .map_err(|e| format!("io: {}", e))?;
    Ok(String::from_utf8_lossy(&bytes).to_string())
}

fn read_text_sample_from_open_file(
    mut file: cap_std::fs::File,
    limit: u64,
) -> Result<String, String> {
    let metadata = file.metadata().map_err(|error| format!("io: {error}"))?;
    if !metadata.is_file() {
        return Err("not_a_file".to_string());
    }
    if metadata.len() > MAX_FILE_BYTES {
        return Err("too_large".to_string());
    }
    let mut bytes = Vec::with_capacity(limit as usize);
    Read::by_ref(&mut file)
        .take(limit)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("io: {error}"))?;
    Ok(String::from_utf8_lossy(&bytes).to_string())
}

fn image_mime_for_path(path: &std::path::Path) -> Option<&'static str> {
    match path
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.to_ascii_lowercase())
    {
        Some(ext) if ext == "png" => Some("image/png"),
        Some(ext) if ext == "jpg" || ext == "jpeg" => Some("image/jpeg"),
        Some(ext) if ext == "webp" => Some("image/webp"),
        Some(ext) if ext == "gif" => Some("image/gif"),
        _ => None,
    }
}

#[tauri::command]
pub fn fs_read_image_base64(path: String, root: Option<String>) -> Result<FsImageData, String> {
    let p = existing_path(&path, root.as_deref())?;
    let mime_type = image_mime_for_path(&p)
        .ok_or_else(|| "unsupported_type".to_string())?
        .to_string();
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
    if meta.len() > MAX_IMAGE_BYTES {
        return Err("too_large".to_string());
    }
    let bytes = std::fs::read(&p).map_err(|e| format!("io: {}", e))?;
    Ok(FsImageData {
        data: base64::engine::general_purpose::STANDARD.encode(bytes),
        mime_type,
        size: meta.len(),
    })
}

#[tauri::command]
pub fn fs_list_dir(
    path: String,
    root: Option<String>,
    strict_project_boundary: Option<bool>,
) -> Result<Vec<FsEntry>, String> {
    let strict_project_boundary = strict_project_boundary.unwrap_or(false);
    if strict_project_boundary {
        let strict_root = StrictProjectRoot::open(root.as_deref())?;
        let relative = strict_root.relative(&path)?;
        let directory = strict_root.open_dir(&relative)?;
        return list_open_directory(&directory, Path::new(&path), true);
    }

    let p = existing_path(&path, root.as_deref())?;
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
    out.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(out)
}

fn list_open_directory(
    directory: &Dir,
    display_path: &Path,
    reject_links: bool,
) -> Result<Vec<FsEntry>, String> {
    let mut out = Vec::new();
    for entry in directory
        .entries()
        .map_err(|error| format!("io: {error}"))?
    {
        if out.len() >= MAX_DIR_ENTRIES {
            break;
        }
        let entry = entry.map_err(|error| format!("io: {error}"))?;
        let file_type = entry.file_type().ok();
        if reject_links
            && file_type
                .as_ref()
                .map(|kind| kind.is_symlink())
                .unwrap_or(true)
        {
            continue;
        }
        let name = entry.file_name();
        let name_path = Path::new(&name);
        let metadata = if file_type
            .as_ref()
            .map(|kind| kind.is_dir())
            .unwrap_or(false)
        {
            directory
                .open_dir_nofollow(name_path)
                .and_then(|opened| opened.dir_metadata())
                .ok()
        } else {
            let mut options = OpenOptions::new();
            options.read(true).follow(FollowSymlinks::No);
            directory
                .open_with(name_path, &options)
                .and_then(|opened| opened.metadata())
                .ok()
        };
        let Some(metadata) = metadata else {
            continue;
        };
        let is_dir = metadata.is_dir();
        let created_ms = metadata
            .created()
            .ok()
            .and_then(|value| value.into_std().duration_since(std::time::UNIX_EPOCH).ok())
            .map(|duration| duration.as_millis());
        let modified_ms = metadata
            .modified()
            .ok()
            .and_then(|value| value.into_std().duration_since(std::time::UNIX_EPOCH).ok())
            .map(|duration| duration.as_millis());
        out.push(FsEntry {
            name: name.to_string_lossy().to_string(),
            path: display_path.join(&name).to_string_lossy().to_string(),
            is_dir,
            size: metadata.is_file().then(|| metadata.len()),
            created_ms,
            modified_ms,
        });
    }
    out.sort_by(|left, right| {
        right
            .is_dir
            .cmp(&left.is_dir)
            .then_with(|| left.name.to_lowercase().cmp(&right.name.to_lowercase()))
    });
    Ok(out)
}

#[tauri::command]
pub fn fs_write_text(path: String, content: String, root: Option<String>) -> Result<(), String> {
    let p = writable_path(&path, root.as_deref())?;
    if content.len() > MAX_WRITE_BYTES {
        return Err("too_large".to_string());
    }
    std::fs::write(&p, content.as_bytes()).map_err(|e| format!("io: {}", e))
}

#[tauri::command]
pub fn fs_create_text_file(path: String, root: Option<String>) -> Result<(), String> {
    let p = writable_path(&path, root.as_deref())?;
    if p.exists() {
        return Err("already_exists".to_string());
    }
    std::fs::write(&p, b"").map_err(|e| format!("io: {}", e))
}

#[tauri::command]
pub fn fs_create_text_with_content(
    path: String,
    content: String,
    root: Option<String>,
) -> Result<(), String> {
    if content.len() > MAX_WRITE_BYTES {
        return Err("too_large".to_string());
    }
    let p = writable_path(&path, root.as_deref())?;
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&p)
        .map_err(|e| {
            if e.kind() == std::io::ErrorKind::AlreadyExists {
                "already_exists".to_string()
            } else {
                format!("io: {}", e)
            }
        })?;
    std::io::Write::write_all(&mut file, content.as_bytes()).map_err(|e| format!("io: {}", e))
}

fn text_sha256(bytes: &[u8]) -> String {
    format!("sha256:{:x}", Sha256::digest(bytes))
}

fn valid_sha256(value: &str) -> bool {
    value.len() == 71
        && value.starts_with("sha256:")
        && value[7..]
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

/// Applies one bounded text create/modify/delete against an exact base digest.
///
/// An absent base digest means create-new. A present digest requires an
/// existing regular UTF-8 file with exactly that digest. `next_content = None`
/// deletes the matching file. A process-wide lock serializes app mutations;
/// the opened capability-relative handle prevents symlink/reparse traversal.
#[tauri::command]
pub fn fs_compare_and_swap_text(
    path: String,
    expected_sha256: Option<String>,
    next_content: Option<String>,
    root: Option<String>,
) -> Result<FsTextMutationReceipt, String> {
    if expected_sha256.is_none() && next_content.is_none() {
        return Err("mutation_invalid".to_string());
    }
    if expected_sha256
        .as_deref()
        .is_some_and(|value| !valid_sha256(value))
    {
        return Err("mutation_invalid".to_string());
    }
    if next_content
        .as_ref()
        .is_some_and(|content| content.len() > MAX_TEXT_MUTATION_BYTES)
    {
        return Err("too_large".to_string());
    }

    let _guard = TEXT_MUTATION_LOCK
        .lock()
        .map_err(|_| "runtime_failure".to_string())?;
    let strict_root = StrictProjectRoot::open(root.as_deref())?;
    let (parent, name) = strict_root.file_parent_and_name(&path)?;
    if cap_entry_is_link(&parent, &name) {
        return Err("symlink_blocked".to_string());
    }

    if expected_sha256.is_none() {
        match parent.symlink_metadata(&name) {
            Ok(_) => return Err("already_exists".to_string()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(format!("io: {error}")),
        }
        let next = next_content.expect("validated create content");
        let mut options = OpenOptions::new();
        options
            .write(true)
            .create_new(true)
            .follow(FollowSymlinks::No);
        let mut file = parent.open_with(&name, &options).map_err(|error| {
            if error.kind() == std::io::ErrorKind::AlreadyExists {
                "already_exists".to_string()
            } else if cap_entry_is_link(&parent, &name) {
                "symlink_blocked".to_string()
            } else {
                format!("io: {error}")
            }
        })?;
        file.write_all(next.as_bytes())
            .map_err(|error| format!("io: {error}"))?;
        file.flush().map_err(|error| format!("io: {error}"))?;
        file.sync_all().map_err(|error| format!("io: {error}"))?;
        return Ok(FsTextMutationReceipt {
            before_sha256: None,
            after_sha256: Some(text_sha256(next.as_bytes())),
            before_bytes: 0,
            after_bytes: next.len(),
        });
    }

    let metadata = parent
        .symlink_metadata(&name)
        .map_err(|error| map_cap_open_error(&parent, &name, error))?;
    if !metadata.is_file() {
        return Err("not_a_file".to_string());
    }
    if metadata.len() > MAX_TEXT_MUTATION_BYTES as u64 {
        return Err("too_large".to_string());
    }
    let mut options = OpenOptions::new();
    options
        .read(true)
        .write(next_content.is_some())
        .follow(FollowSymlinks::No);
    let mut file = parent
        .open_with(&name, &options)
        .map_err(|error| map_cap_open_error(&parent, &name, error))?;
    let mut before = Vec::with_capacity(metadata.len() as usize);
    file.read_to_end(&mut before)
        .map_err(|error| format!("io: {error}"))?;
    if before.len() > MAX_TEXT_MUTATION_BYTES {
        return Err("too_large".to_string());
    }
    std::str::from_utf8(&before).map_err(|_| "not_utf8".to_string())?;
    let before_sha256 = text_sha256(&before);
    if expected_sha256.as_deref() != Some(before_sha256.as_str()) {
        return Err("stale_base".to_string());
    }

    match next_content {
        Some(next) => {
            file.seek(SeekFrom::Start(0))
                .map_err(|error| format!("io: {error}"))?;
            file.write_all(next.as_bytes())
                .map_err(|error| format!("io: {error}"))?;
            file.set_len(next.len() as u64)
                .map_err(|error| format!("io: {error}"))?;
            file.flush().map_err(|error| format!("io: {error}"))?;
            file.sync_all().map_err(|error| format!("io: {error}"))?;
            Ok(FsTextMutationReceipt {
                before_sha256: Some(before_sha256),
                after_sha256: Some(text_sha256(next.as_bytes())),
                before_bytes: before.len(),
                after_bytes: next.len(),
            })
        }
        None => {
            drop(file);
            parent
                .remove_file(&name)
                .map_err(|error| map_cap_open_error(&parent, &name, error))?;
            Ok(FsTextMutationReceipt {
                before_sha256: Some(before_sha256),
                after_sha256: None,
                before_bytes: before.len(),
                after_bytes: 0,
            })
        }
    }
}

#[tauri::command]
pub fn fs_create_dir_all(path: String, root: Option<String>) -> Result<(), String> {
    let p = require_absolute(&path)?;
    let canonical_root = canonical_root(root.as_deref())?;
    if p.exists() {
        let canonical = std::fs::canonicalize(&p).map_err(|e| format!("io: {}", e))?;
        ensure_inside_root(&canonical, canonical_root.as_ref())?;
        return if canonical.is_dir() {
            Ok(())
        } else {
            Err("not_a_dir".to_string())
        };
    }

    let mut existing_ancestor = p.parent().ok_or_else(|| "parent_not_found".to_string())?;
    while !existing_ancestor.exists() {
        existing_ancestor = existing_ancestor
            .parent()
            .ok_or_else(|| "parent_not_found".to_string())?;
    }
    let canonical_ancestor =
        std::fs::canonicalize(existing_ancestor).map_err(|e| format!("io: {}", e))?;
    ensure_inside_root(&canonical_ancestor, canonical_root.as_ref())?;
    std::fs::create_dir_all(&p).map_err(|e| format!("io: {}", e))?;
    let canonical = std::fs::canonicalize(&p).map_err(|e| format!("io: {}", e))?;
    ensure_inside_root(&canonical, canonical_root.as_ref())
}

#[tauri::command]
pub fn fs_create_dir_all_strict(
    path: String,
    root: Option<String>,
) -> Result<FsDirectoryReceipt, String> {
    let _guard = TEXT_MUTATION_LOCK
        .lock()
        .map_err(|_| "runtime_failure".to_string())?;
    StrictProjectRoot::open(root.as_deref())?
        .create_directory_path(&path)
        .map(|created| FsDirectoryReceipt { created })
}

#[tauri::command]
pub fn fs_stat_path(
    path: String,
    include_sha256: bool,
    root: Option<String>,
) -> Result<FsPathMetadata, String> {
    let strict_root = StrictProjectRoot::open(root.as_deref())?;
    let relative = strict_root.relative(&path)?;
    if relative.as_os_str().is_empty() {
        let metadata = strict_root
            .dir
            .dir_metadata()
            .map_err(|error| format!("io: {error}"))?;
        return Ok(FsPathMetadata {
            kind: "directory".to_string(),
            size: None,
            created_ms: cap_time_ms(metadata.created()),
            modified_ms: cap_time_ms(metadata.modified()),
            sha256: None,
        });
    }

    let (parent, name) = strict_root.file_parent_and_name(&path)?;
    if cap_entry_is_link(&parent, &name) {
        return Err("symlink_blocked".to_string());
    }
    let metadata = parent
        .symlink_metadata(&name)
        .map_err(|error| map_cap_open_error(&parent, &name, error))?;
    if metadata.is_dir() {
        let directory = strict_root.open_dir(&relative)?;
        let metadata = directory
            .dir_metadata()
            .map_err(|error| format!("io: {error}"))?;
        return Ok(FsPathMetadata {
            kind: "directory".to_string(),
            size: None,
            created_ms: cap_time_ms(metadata.created()),
            modified_ms: cap_time_ms(metadata.modified()),
            sha256: None,
        });
    }
    if !metadata.is_file() {
        return Err("unsupported_type".to_string());
    }
    let file = strict_root.open_file(&relative)?;
    let metadata = file.metadata().map_err(|error| format!("io: {error}"))?;
    let sha256 = if include_sha256 {
        Some(hash_open_file(file, MAX_FILE_BYTES)?.0)
    } else {
        None
    };
    Ok(FsPathMetadata {
        kind: "file".to_string(),
        size: Some(metadata.len()),
        created_ms: cap_time_ms(metadata.created()),
        modified_ms: cap_time_ms(metadata.modified()),
        sha256,
    })
}

#[tauri::command]
pub fn fs_copy_file(
    path: String,
    new_path: String,
    root: Option<String>,
) -> Result<FsFileTransferReceipt, String> {
    let _guard = TEXT_MUTATION_LOCK
        .lock()
        .map_err(|_| "runtime_failure".to_string())?;
    let strict_root = StrictProjectRoot::open(root.as_deref())?;
    let source_relative = strict_root.relative(&path)?;
    let mut source = strict_root.open_file(&source_relative)?;
    let source_metadata = source.metadata().map_err(|error| format!("io: {error}"))?;
    if source_metadata.len() > MAX_COPY_BYTES {
        return Err("too_large".to_string());
    }
    let (destination_dir, destination_name) = strict_root.file_parent_and_name(&new_path)?;
    match destination_dir.symlink_metadata(&destination_name) {
        Ok(_) => return Err("already_exists".to_string()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(format!("io: {error}")),
    }
    let mut options = OpenOptions::new();
    options
        .write(true)
        .create_new(true)
        .follow(FollowSymlinks::No);
    let mut destination = destination_dir
        .open_with(&destination_name, &options)
        .map_err(|error| {
            if error.kind() == std::io::ErrorKind::AlreadyExists {
                "already_exists".to_string()
            } else if cap_entry_is_link(&destination_dir, &destination_name) {
                "symlink_blocked".to_string()
            } else {
                format!("io: {error}")
            }
        })?;

    let copied = (|| -> Result<FsFileTransferReceipt, String> {
        let mut digest = Sha256::new();
        let mut bytes = 0_u64;
        let mut buffer = [0_u8; 64 * 1024];
        loop {
            let read = source
                .read(&mut buffer)
                .map_err(|error| format!("io: {error}"))?;
            if read == 0 {
                break;
            }
            bytes = bytes
                .checked_add(read as u64)
                .ok_or_else(|| "too_large".to_string())?;
            if bytes > MAX_COPY_BYTES {
                return Err("too_large".to_string());
            }
            destination
                .write_all(&buffer[..read])
                .map_err(|error| format!("io: {error}"))?;
            digest.update(&buffer[..read]);
        }
        destination
            .flush()
            .map_err(|error| format!("io: {error}"))?;
        destination
            .sync_all()
            .map_err(|error| format!("io: {error}"))?;
        Ok(FsFileTransferReceipt {
            bytes,
            sha256: format!("sha256:{:x}", digest.finalize()),
        })
    })();
    if copied.is_err() {
        drop(destination);
        let _ = destination_dir.remove_file(&destination_name);
    }
    copied
}

#[tauri::command]
pub fn fs_rename_file(path: String, new_path: String, root: Option<String>) -> Result<(), String> {
    let _guard = TEXT_MUTATION_LOCK
        .lock()
        .map_err(|_| "runtime_failure".to_string())?;
    let strict_root = StrictProjectRoot::open(root.as_deref())?;
    let (source_dir, source_name) = strict_root.file_parent_and_name(&path)?;
    let (destination_dir, destination_name) = strict_root.file_parent_and_name(&new_path)?;

    if cap_entry_is_link(&source_dir, &source_name) {
        return Err("symlink_blocked".to_string());
    }
    let source_metadata = source_dir
        .symlink_metadata(&source_name)
        .map_err(|error| map_cap_open_error(&source_dir, &source_name, error))?;
    if !source_metadata.is_file() {
        return Err("not_a_file".to_string());
    }
    match destination_dir.symlink_metadata(&destination_name) {
        Ok(_) => return Err("already_exists".to_string()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(format!("io: {error}")),
    }
    source_dir
        .hard_link(&source_name, &destination_dir, &destination_name)
        .map_err(|error| {
            if error.kind() == std::io::ErrorKind::AlreadyExists {
                "already_exists".to_string()
            } else {
                format!("io: {error}")
            }
        })?;
    if cap_entry_is_link(&destination_dir, &destination_name) {
        let _ = destination_dir.remove_file(&destination_name);
        return Err("symlink_blocked".to_string());
    }
    if let Err(error) = source_dir.remove_file(&source_name) {
        let _ = destination_dir.remove_file(&destination_name);
        return Err(if error.kind() == std::io::ErrorKind::NotFound {
            "not_found".to_string()
        } else {
            format!("io: {error}")
        });
    }
    Ok(())
}

#[tauri::command]
pub fn fs_move_file_with_receipt(
    path: String,
    new_path: String,
    root: Option<String>,
) -> Result<FsFileTransferReceipt, String> {
    let _guard = TEXT_MUTATION_LOCK
        .lock()
        .map_err(|_| "runtime_failure".to_string())?;
    let strict_root = StrictProjectRoot::open(root.as_deref())?;
    let source_relative = strict_root.relative(&path)?;
    let (source_sha256, source_bytes) =
        hash_open_file(strict_root.open_file(&source_relative)?, MAX_FILE_BYTES)?;
    let (source_dir, source_name) = strict_root.file_parent_and_name(&path)?;
    let (destination_dir, destination_name) = strict_root.file_parent_and_name(&new_path)?;

    if cap_entry_is_link(&source_dir, &source_name) {
        return Err("symlink_blocked".to_string());
    }
    let source_metadata = source_dir
        .symlink_metadata(&source_name)
        .map_err(|error| map_cap_open_error(&source_dir, &source_name, error))?;
    if !source_metadata.is_file() {
        return Err("not_a_file".to_string());
    }

    match destination_dir.symlink_metadata(&destination_name) {
        Ok(_) => return Err("already_exists".to_string()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(format!("io: {error}")),
    }

    // A hard-link-first move gives the destination create-new semantics: an
    // existing file is never overwritten, even if it appears after the check
    // above. Both paths are capability-relative to the already opened root.
    source_dir
        .hard_link(&source_name, &destination_dir, &destination_name)
        .map_err(|error| {
            if error.kind() == std::io::ErrorKind::AlreadyExists {
                "already_exists".to_string()
            } else {
                format!("io: {error}")
            }
        })?;

    if cap_entry_is_link(&destination_dir, &destination_name) {
        let _ = destination_dir.remove_file(&destination_name);
        return Err("symlink_blocked".to_string());
    }
    let destination_relative = strict_root.relative(&new_path)?;
    let (destination_sha256, destination_bytes) = match hash_open_file(
        strict_root.open_file(&destination_relative)?,
        MAX_FILE_BYTES,
    ) {
        Ok(receipt) => receipt,
        Err(error) => {
            let _ = destination_dir.remove_file(&destination_name);
            return Err(error);
        }
    };
    if destination_sha256 != source_sha256 || destination_bytes != source_bytes {
        let _ = destination_dir.remove_file(&destination_name);
        return Err("runtime_failure".to_string());
    }

    if let Err(error) = source_dir.remove_file(&source_name) {
        let _ = destination_dir.remove_file(&destination_name);
        return Err(if error.kind() == std::io::ErrorKind::NotFound {
            "not_found".to_string()
        } else {
            format!("io: {error}")
        });
    }
    Ok(FsFileTransferReceipt {
        bytes: destination_bytes,
        sha256: destination_sha256,
    })
}

#[tauri::command]
pub fn fs_delete_file(path: String, root: Option<String>) -> Result<(), String> {
    let _guard = TEXT_MUTATION_LOCK
        .lock()
        .map_err(|_| "runtime_failure".to_string())?;
    let strict_root = StrictProjectRoot::open(root.as_deref())?;
    let (parent, name) = strict_root.file_parent_and_name(&path)?;
    if cap_entry_is_link(&parent, &name) {
        return Err("symlink_blocked".to_string());
    }
    let metadata = parent
        .symlink_metadata(&name)
        .map_err(|error| map_cap_open_error(&parent, &name, error))?;
    if !metadata.is_file() {
        return Err("not_a_file".to_string());
    }
    parent.remove_file(&name).map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            "not_found".to_string()
        } else {
            format!("io: {error}")
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_root(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "vibespace-fsread-{}-{}-{}",
            label,
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ))
    }

    #[test]
    fn sample_rejects_outside_root() {
        let root = test_root("sample-root");
        let outside = test_root("sample-outside");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        let file = outside.join("notes.txt");
        std::fs::write(&file, b"outside").unwrap();

        assert_eq!(
            fs_read_text_sample(
                file.to_string_lossy().to_string(),
                Some(1),
                Some(root.to_string_lossy().to_string()),
                None,
            ),
            Err("outside_root".to_string())
        );

        std::fs::remove_dir_all(root).unwrap();
        std::fs::remove_dir_all(outside).unwrap();
    }

    #[test]
    fn sample_rejects_too_large() {
        let root = test_root("sample-large");
        std::fs::create_dir_all(&root).unwrap();
        let file = root.join("oversized.txt");
        let handle = std::fs::File::create(&file).unwrap();
        handle.set_len(MAX_FILE_BYTES + 1).unwrap();
        drop(handle);

        assert_eq!(
            fs_read_text_sample(
                file.to_string_lossy().to_string(),
                Some(1),
                Some(root.to_string_lossy().to_string()),
                None,
            ),
            Err("too_large".to_string())
        );

        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn strict_sample_reads_a_complete_bounded_context_shard() {
        let root = test_root("sample-context-shard");
        std::fs::create_dir_all(&root).unwrap();
        let file = root.join("shard.txt");
        let content = vec![b'x'; 700 * 1024];
        std::fs::write(&file, &content).unwrap();

        let result = fs_read_text_sample(
            file.to_string_lossy().to_string(),
            Some(1024 * 1024),
            Some(root.to_string_lossy().to_string()),
            Some(true),
        )
        .unwrap();
        assert_eq!(result.as_bytes(), content);

        std::fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn sample_rejects_symlink_file_escape() {
        let root = test_root("sample-symlink-file-root");
        let outside = test_root("sample-symlink-file-outside");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        let outside_file = outside.join("secret.txt");
        std::fs::write(&outside_file, b"secret").unwrap();
        let link = root.join("linked.txt");
        std::os::unix::fs::symlink(&outside_file, &link).unwrap();

        assert_eq!(
            fs_read_text_sample(
                link.to_string_lossy().to_string(),
                Some(1),
                Some(root.to_string_lossy().to_string()),
                None,
            ),
            Err("outside_root".to_string())
        );

        std::fs::remove_dir_all(root).unwrap();
        std::fs::remove_dir_all(outside).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn sample_rejects_symlink_directory_escape() {
        let root = test_root("sample-symlink-dir-root");
        let outside = test_root("sample-symlink-dir-outside");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        let outside_file = outside.join("secret.txt");
        std::fs::write(&outside_file, b"secret").unwrap();
        let link = root.join("linked");
        std::os::unix::fs::symlink(&outside, &link).unwrap();

        assert_eq!(
            fs_read_text_sample(
                link.join("secret.txt").to_string_lossy().to_string(),
                Some(1),
                Some(root.to_string_lossy().to_string()),
                None,
            ),
            Err("outside_root".to_string())
        );

        std::fs::remove_dir_all(root).unwrap();
        std::fs::remove_dir_all(outside).unwrap();
    }

    #[test]
    fn strict_sample_rejects_lexical_traversal_even_when_it_resolves_inside_root() {
        let root = test_root("strict-traversal");
        std::fs::create_dir_all(root.join("nested")).unwrap();
        let file = root.join("readme.md");
        std::fs::write(&file, b"safe").unwrap();
        let traversing = root.join("nested").join("..").join("readme.md");

        assert_eq!(
            fs_read_text_sample(
                traversing.to_string_lossy().to_string(),
                Some(4),
                Some(root.to_string_lossy().to_string()),
                Some(true),
            ),
            Err("outside_root".to_string())
        );

        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn strict_sample_requires_an_explicit_root() {
        let root = test_root("strict-root-required");
        std::fs::create_dir_all(&root).unwrap();
        let file = root.join("readme.md");
        std::fs::write(&file, b"safe").unwrap();

        assert_eq!(
            fs_read_text_sample(
                file.to_string_lossy().to_string(),
                Some(4),
                None,
                Some(true),
            ),
            Err("outside_root".to_string())
        );

        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn strict_list_preserves_root_not_found_and_root_not_dir_errors() {
        let missing = test_root("strict-missing-root");
        assert_eq!(
            fs_list_dir(
                missing.to_string_lossy().to_string(),
                Some(missing.to_string_lossy().to_string()),
                Some(true),
            )
            .unwrap_err(),
            "root_not_found"
        );

        let root_file = test_root("strict-root-file");
        std::fs::write(&root_file, b"not a directory").unwrap();
        assert_eq!(
            fs_list_dir(
                root_file.to_string_lossy().to_string(),
                Some(root_file.to_string_lossy().to_string()),
                Some(true),
            )
            .unwrap_err(),
            "root_not_dir"
        );
        std::fs::remove_file(root_file).unwrap();
    }

    #[test]
    fn strict_reads_remain_bound_to_the_open_root_handle_after_path_replacement() {
        let root = test_root("strict-root-handle");
        let moved = test_root("strict-root-handle-moved");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("readme.md"), b"original").unwrap();
        let root_text = root.to_string_lossy().to_string();
        let strict_root = StrictProjectRoot::open(Some(&root_text)).unwrap();

        let root_replaced = match std::fs::rename(&root, &moved) {
            Ok(()) => {
                std::fs::create_dir_all(&root).unwrap();
                std::fs::write(root.join("readme.md"), b"replacement").unwrap();
                true
            }
            #[cfg(windows)]
            Err(error) if error.raw_os_error() == Some(32) => false,
            Err(error) => panic!("replace selected root: {error}"),
        };

        let relative = strict_root
            .relative(&root.join("readme.md").to_string_lossy())
            .unwrap();
        let file = strict_root.open_file(&relative).unwrap();
        assert_eq!(
            read_text_sample_from_open_file(file, 64).unwrap(),
            "original"
        );
        let listed = list_open_directory(&strict_root.dir, &root, true).unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].name, "readme.md");

        drop(strict_root);
        std::fs::remove_dir_all(&root).unwrap();
        if root_replaced {
            std::fs::remove_dir_all(moved).unwrap();
        }
    }

    #[test]
    fn strict_sample_reads_metadata_and_bytes_from_the_same_open_file() {
        let root = test_root("strict-file-handle");
        std::fs::create_dir_all(&root).unwrap();
        let file_path = root.join("readme.md");
        let moved_path = root.join("original.md");
        std::fs::write(&file_path, b"original").unwrap();
        let root_text = root.to_string_lossy().to_string();
        let strict_root = StrictProjectRoot::open(Some(&root_text)).unwrap();
        let relative = strict_root.relative(&file_path.to_string_lossy()).unwrap();
        let file = strict_root.open_file(&relative).unwrap();

        std::fs::rename(&file_path, &moved_path).unwrap();
        std::fs::write(&file_path, b"replacement").unwrap();

        assert_eq!(
            read_text_sample_from_open_file(file, 64).unwrap(),
            "original"
        );

        drop(strict_root);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn strict_sample_rejects_a_symlink_that_stays_inside_the_root() {
        let root = test_root("strict-symlink");
        std::fs::create_dir_all(root.join("real")).unwrap();
        let file = root.join("real").join("readme.md");
        std::fs::write(&file, b"safe").unwrap();
        let link = root.join("linked");
        std::os::unix::fs::symlink(root.join("real"), &link).unwrap();

        assert_eq!(
            fs_read_text_sample(
                link.join("readme.md").to_string_lossy().to_string(),
                Some(4),
                Some(root.to_string_lossy().to_string()),
                Some(true),
            ),
            Err("symlink_blocked".to_string())
        );
        let listed = fs_list_dir(
            root.to_string_lossy().to_string(),
            Some(root.to_string_lossy().to_string()),
            Some(true),
        )
        .unwrap();
        assert!(!listed.iter().any(|entry| entry.name == "linked"));

        std::fs::remove_dir_all(root).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn strict_sample_rejects_a_reparse_directory_that_stays_inside_the_root() {
        use std::os::windows::fs::symlink_dir;

        let root = test_root("strict-reparse");
        std::fs::create_dir_all(root.join("real")).unwrap();
        let file = root.join("real").join("readme.md");
        std::fs::write(&file, b"safe").unwrap();
        let link = root.join("linked");
        match symlink_dir(root.join("real"), &link) {
            Ok(()) => {}
            Err(error)
                if error.kind() == std::io::ErrorKind::PermissionDenied
                    || error.raw_os_error() == Some(1314) =>
            {
                std::fs::remove_dir_all(root).unwrap();
                return;
            }
            Err(error) => panic!("create test reparse directory: {error}"),
        }

        assert_eq!(
            fs_read_text_sample(
                link.join("readme.md").to_string_lossy().to_string(),
                Some(4),
                Some(root.to_string_lossy().to_string()),
                Some(true),
            ),
            Err("symlink_blocked".to_string())
        );
        let listed = fs_list_dir(
            root.to_string_lossy().to_string(),
            Some(root.to_string_lossy().to_string()),
            Some(true),
        )
        .unwrap();
        assert!(!listed.iter().any(|entry| entry.name == "linked"));

        std::fs::remove_dir_all(root).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn user_boundary_rejects_other_windows_profiles_case_insensitively() {
        let profile = Path::new(r"C:\Users\Viper");
        assert!(enforce_user_boundary(Path::new(r"c:\users\viper\Projects"), profile).is_ok());
        assert_eq!(
            enforce_user_boundary(Path::new(r"C:\Users\Other\Secrets"), profile),
            Err("other_user_folder".to_string())
        );
        assert_eq!(
            enforce_user_boundary(Path::new(r"C:\Users"), profile),
            Err("other_user_folder".to_string())
        );
        assert!(enforce_user_boundary(Path::new(r"D:\Projects"), profile).is_ok());
    }

    #[cfg(windows)]
    #[test]
    fn user_boundary_rejects_siblings_under_a_custom_profile_root() {
        let profile = Path::new(r"D:\CompanyProfiles\Viper");
        assert!(
            enforce_user_boundary(Path::new(r"d:\companyprofiles\viper\Projects"), profile).is_ok()
        );
        assert_eq!(
            enforce_user_boundary(Path::new(r"D:\CompanyProfiles\Other\Secrets"), profile),
            Err("other_user_folder".to_string())
        );
        assert_eq!(
            enforce_user_boundary(Path::new(r"D:\CompanyProfiles"), profile),
            Err("other_user_folder".to_string())
        );
    }

    #[cfg(windows)]
    #[test]
    fn strict_roots_reject_verbatim_device_and_unc_namespaces() {
        for path in [
            Path::new(r"\\?\C:\Users\Other"),
            Path::new(r"\\.\C:\Users\Other"),
            Path::new(r"\\server\share\project"),
        ] {
            assert_eq!(
                absolute_anchor_and_components(path).unwrap_err(),
                "outside_root"
            );
        }
    }

    #[test]
    fn user_boundary_fails_closed_without_a_profile_parent() {
        assert_eq!(
            enforce_user_boundary(Path::new("/project"), Path::new("/")),
            Err("other_user_folder".to_string())
        );
    }

    #[cfg(not(windows))]
    #[test]
    fn user_boundary_rejects_other_unix_profiles() {
        let profile = Path::new("/home/viper");
        assert!(enforce_user_boundary(Path::new("/home/viper/projects"), profile).is_ok());
        assert_eq!(
            enforce_user_boundary(Path::new("/home/other/secrets"), profile),
            Err("other_user_folder".to_string())
        );
        assert_eq!(
            enforce_user_boundary(Path::new("/home"), profile),
            Err("other_user_folder".to_string())
        );
        assert!(enforce_user_boundary(Path::new("/srv/projects"), profile).is_ok());
    }

    #[test]
    fn creates_content_once_and_refuses_overwrite() {
        let root = test_root("create");
        std::fs::create_dir_all(&root).unwrap();
        let file = root.join("dogs.md");
        let root_text = root.to_string_lossy().to_string();
        let file_text = file.to_string_lossy().to_string();
        fs_create_text_with_content(
            file_text.clone(),
            "# Dogs".to_string(),
            Some(root_text.clone()),
        )
        .unwrap();
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "# Dogs");
        assert_eq!(
            fs_create_text_with_content(file_text, "changed".to_string(), Some(root_text)),
            Err("already_exists".to_string())
        );
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "# Dogs");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn creates_nested_directory_inside_root_and_rejects_file_collision() {
        let root = test_root("dir");
        std::fs::create_dir_all(&root).unwrap();
        let nested = root.join("Projects").join("FarmLife");
        let root_text = root.to_string_lossy().to_string();
        let receipt = fs_create_dir_all_strict(
            nested.to_string_lossy().to_string(),
            Some(root_text.clone()),
        )
        .unwrap();
        assert!(receipt.created);
        assert!(
            !fs_create_dir_all_strict(
                nested.to_string_lossy().to_string(),
                Some(root_text.clone()),
            )
            .unwrap()
            .created
        );
        assert!(nested.is_dir());
        let collision = root.join("Projects").join("not-a-folder");
        std::fs::write(&collision, b"file").unwrap();
        assert_eq!(
            fs_create_dir_all_strict(collision.to_string_lossy().to_string(), Some(root_text)),
            Err("not_a_dir".to_string())
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn renames_and_deletes_regular_files_without_overwriting() {
        let root = test_root("file-mutations");
        std::fs::create_dir_all(root.join("nested")).unwrap();
        let source = root.join("notes.md");
        let renamed = root.join("nested").join("renamed.md");
        let collision = root.join("collision.md");
        std::fs::write(&source, b"private test content").unwrap();
        std::fs::write(&collision, b"keep").unwrap();
        let root_text = root.to_string_lossy().to_string();

        fs_rename_file(
            source.to_string_lossy().to_string(),
            renamed.to_string_lossy().to_string(),
            Some(root_text.clone()),
        )
        .unwrap();
        assert!(!source.exists());
        assert_eq!(
            std::fs::read_to_string(&renamed).unwrap(),
            "private test content"
        );
        assert_eq!(
            fs_rename_file(
                renamed.to_string_lossy().to_string(),
                collision.to_string_lossy().to_string(),
                Some(root_text.clone()),
            ),
            Err("already_exists".to_string())
        );
        assert_eq!(std::fs::read_to_string(&collision).unwrap(), "keep");

        fs_delete_file(
            renamed.to_string_lossy().to_string(),
            Some(root_text.clone()),
        )
        .unwrap();
        assert!(!renamed.exists());
        assert_eq!(
            fs_delete_file(renamed.to_string_lossy().to_string(), Some(root_text)),
            Err("not_found".to_string())
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn file_mutations_require_an_explicit_root_and_reject_outside_paths() {
        let root = test_root("mutation-root");
        let outside = test_root("mutation-outside");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        let inside = root.join("inside.md");
        let outside_file = outside.join("outside.md");
        std::fs::write(&inside, b"inside").unwrap();
        std::fs::write(&outside_file, b"outside").unwrap();
        let root_text = root.to_string_lossy().to_string();

        assert_eq!(
            fs_delete_file(inside.to_string_lossy().to_string(), None),
            Err("outside_root".to_string())
        );
        assert_eq!(
            fs_delete_file(
                outside_file.to_string_lossy().to_string(),
                Some(root_text.clone()),
            ),
            Err("outside_root".to_string())
        );
        assert_eq!(
            fs_rename_file(
                inside.to_string_lossy().to_string(),
                outside.join("renamed.md").to_string_lossy().to_string(),
                Some(root_text),
            ),
            Err("outside_root".to_string())
        );
        assert!(inside.exists());
        assert!(outside_file.exists());
        std::fs::remove_dir_all(root).unwrap();
        std::fs::remove_dir_all(outside).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn file_mutations_reject_symlink_sources() {
        let root = test_root("mutation-symlink");
        std::fs::create_dir_all(&root).unwrap();
        let real = root.join("real.md");
        let link = root.join("linked.md");
        std::fs::write(&real, b"real").unwrap();
        std::os::unix::fs::symlink(&real, &link).unwrap();
        let root_text = root.to_string_lossy().to_string();

        assert_eq!(
            fs_delete_file(link.to_string_lossy().to_string(), Some(root_text.clone())),
            Err("symlink_blocked".to_string())
        );
        assert_eq!(
            fs_rename_file(
                link.to_string_lossy().to_string(),
                root.join("renamed.md").to_string_lossy().to_string(),
                Some(root_text),
            ),
            Err("symlink_blocked".to_string())
        );
        assert!(real.exists());
        assert!(link.exists());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn compare_and_swap_text_creates_once_and_returns_hash_evidence() {
        let root = test_root("cas-create");
        std::fs::create_dir_all(&root).unwrap();
        let file = root.join("notes.md");
        let root_text = root.to_string_lossy().to_string();
        let file_text = file.to_string_lossy().to_string();

        let receipt = fs_compare_and_swap_text(
            file_text.clone(),
            None,
            Some("first".to_string()),
            Some(root_text.clone()),
        )
        .unwrap();
        assert_eq!(receipt.before_sha256, None);
        assert_eq!(receipt.after_sha256, Some(text_sha256(b"first")));
        assert_eq!(receipt.before_bytes, 0);
        assert_eq!(receipt.after_bytes, 5);
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "first");
        assert_eq!(
            fs_compare_and_swap_text(
                file_text,
                None,
                Some("overwrite".to_string()),
                Some(root_text),
            )
            .unwrap_err(),
            "already_exists"
        );

        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn compare_and_swap_text_modifies_and_deletes_only_the_exact_base() {
        let root = test_root("cas-update-delete");
        std::fs::create_dir_all(&root).unwrap();
        let file = root.join("notes.md");
        std::fs::write(&file, b"before").unwrap();
        let root_text = root.to_string_lossy().to_string();
        let file_text = file.to_string_lossy().to_string();
        let before_hash = text_sha256(b"before");

        let modified = fs_compare_and_swap_text(
            file_text.clone(),
            Some(before_hash.clone()),
            Some("after".to_string()),
            Some(root_text.clone()),
        )
        .unwrap();
        assert_eq!(modified.before_sha256, Some(before_hash));
        assert_eq!(modified.after_sha256, Some(text_sha256(b"after")));
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "after");

        assert_eq!(
            fs_compare_and_swap_text(
                file_text.clone(),
                Some(text_sha256(b"stale")),
                Some("unsafe".to_string()),
                Some(root_text.clone()),
            )
            .unwrap_err(),
            "stale_base"
        );
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "after");

        let deleted =
            fs_compare_and_swap_text(file_text, modified.after_sha256, None, Some(root_text))
                .unwrap();
        assert_eq!(deleted.after_sha256, None);
        assert_eq!(deleted.after_bytes, 0);
        assert!(!file.exists());

        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn stats_and_hashes_files_and_directories_from_strict_handles() {
        let root = test_root("strict-stat");
        let nested = root.join("nested");
        let file = nested.join("notes.bin");
        std::fs::create_dir_all(&nested).unwrap();
        std::fs::write(&file, b"bounded binary fixture").unwrap();
        let root_text = root.to_string_lossy().to_string();

        let directory = fs_stat_path(
            nested.to_string_lossy().to_string(),
            true,
            Some(root_text.clone()),
        )
        .unwrap();
        assert_eq!(directory.kind, "directory");
        assert_eq!(directory.size, None);
        assert_eq!(directory.sha256, None);

        let metadata = fs_stat_path(
            file.to_string_lossy().to_string(),
            true,
            Some(root_text.clone()),
        )
        .unwrap();
        assert_eq!(metadata.kind, "file");
        assert_eq!(metadata.size, Some(22));
        assert_eq!(
            metadata.sha256,
            Some(text_sha256(b"bounded binary fixture"))
        );

        assert_eq!(
            fs_stat_path(file.to_string_lossy().to_string(), false, None),
            Err("outside_root".to_string())
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn copies_and_moves_files_without_overwrite_and_returns_hash_evidence() {
        let root = test_root("strict-transfer");
        let nested = root.join("nested");
        std::fs::create_dir_all(&nested).unwrap();
        let source = root.join("source.bin");
        let copied = nested.join("copied.bin");
        let moved = root.join("moved.bin");
        std::fs::write(&source, b"copy fixture").unwrap();
        let root_text = root.to_string_lossy().to_string();

        let copy_receipt = fs_copy_file(
            source.to_string_lossy().to_string(),
            copied.to_string_lossy().to_string(),
            Some(root_text.clone()),
        )
        .unwrap();
        assert_eq!(copy_receipt.bytes, 12);
        assert_eq!(copy_receipt.sha256, text_sha256(b"copy fixture"));
        assert_eq!(std::fs::read(&copied).unwrap(), b"copy fixture");
        assert_eq!(
            fs_copy_file(
                source.to_string_lossy().to_string(),
                copied.to_string_lossy().to_string(),
                Some(root_text.clone()),
            ),
            Err("already_exists".to_string())
        );

        let move_receipt = fs_move_file_with_receipt(
            copied.to_string_lossy().to_string(),
            moved.to_string_lossy().to_string(),
            Some(root_text),
        )
        .unwrap();
        assert_eq!(move_receipt.bytes, 12);
        assert_eq!(move_receipt.sha256, copy_receipt.sha256);
        assert!(!copied.exists());
        assert_eq!(std::fs::read(&moved).unwrap(), b"copy fixture");

        std::fs::remove_dir_all(root).unwrap();
    }
}
