use std::path::{Component, Path, PathBuf};
use std::sync::OnceLock;

const INVALID_ROOT: &str = "VibeSpace managed Codex storage override must be an absolute regular directory outside existing Codex/npm stores.";
static STORAGE_OVERRIDE: OnceLock<Option<PathBuf>> = OnceLock::new();

/// This opt-in is scoped to the VibeSpace process. An invalid override is an error,
/// never permission to fall back to another installation or credential store.
pub fn storage_root(default: &Path) -> Result<PathBuf, String> {
    let selected = STORAGE_OVERRIDE.get_or_init(|| configured_storage_root());
    resolve_storage_root(default, selected.as_deref()).map_err(str::to_string)
}

fn configured_storage_root() -> Option<PathBuf> {
    if let Some(value) = std::env::var_os("VIBESPACE_MANAGED_CODEX_ROOT") {
        return Some(PathBuf::from(value));
    }
    // Launchers may retain their old environment after the user's storage
    // preference changes. Read this one VibeSpace setting, not Codex's home.
    #[cfg(windows)]
    {
        use winreg::{enums::HKEY_CURRENT_USER, RegKey};
        if let Ok(environment) = RegKey::predef(HKEY_CURRENT_USER).open_subkey("Environment") {
            if let Ok(value) = environment.get_value::<String, _>("VIBESPACE_MANAGED_CODEX_ROOT") {
                return Some(PathBuf::from(value));
            }
        }
    }
    None
}

pub fn resolve_storage_root(
    default: &Path,
    override_root: Option<&Path>,
) -> Result<PathBuf, &'static str> {
    let Some(root) = override_root else {
        return Ok(default.to_path_buf());
    };
    if !root.is_absolute() || root.parent().is_none() {
        return Err(INVALID_ROOT);
    }
    for component in root.components() {
        match component {
            Component::ParentDir | Component::CurDir => return Err(INVALID_ROOT),
            Component::Normal(name)
                if [".codex", ".opencodex", "npm", "node_modules"]
                    .iter()
                    .any(|protected| name.to_string_lossy().eq_ignore_ascii_case(protected)) =>
            {
                return Err(INVALID_ROOT)
            }
            #[cfg(windows)]
            Component::Prefix(prefix) if !matches!(prefix.kind(), std::path::Prefix::Disk(_)) => {
                return Err(INVALID_ROOT)
            }
            _ => {}
        }
    }
    // Reject links/junctions in any existing ancestor, including roots that do not
    // exist yet. The materializers retain their own verification at file creation.
    for ancestor in root.ancestors() {
        match std::fs::symlink_metadata(ancestor) {
            Ok(metadata) => {
                if !metadata.is_dir() || metadata.file_type().is_symlink() {
                    return Err(INVALID_ROOT);
                }
                #[cfg(windows)]
                {
                    use std::os::windows::fs::MetadataExt;
                    if metadata.file_attributes() & 0x400 != 0 {
                        return Err(INVALID_ROOT);
                    }
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Err(INVALID_ROOT),
        }
    }
    Ok(root.to_path_buf())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn absent_override_preserves_default() {
        let default = std::env::temp_dir().join("vibespace-default");
        assert_eq!(resolve_storage_root(&default, None), Ok(default));
    }
    #[test]
    fn explicit_root_controls_install_and_profile_storage() {
        let default = std::env::temp_dir().join("vibespace-default");
        let isolated = std::env::temp_dir().join("vibespace-isolated");
        assert_eq!(
            resolve_storage_root(&default, Some(&isolated)),
            Ok(isolated)
        );
    }
    #[test]
    fn invalid_override_never_falls_back() {
        let default = std::env::temp_dir().join("vibespace-default");
        for bad in [
            Path::new(""),
            Path::new("relative"),
            Path::new("C:\\safe\\..\\.codex"),
        ] {
            assert!(
                resolve_storage_root(&default, Some(bad)).is_err(),
                "{bad:?}"
            );
        }
    }
    #[test]
    fn protected_codex_store_cannot_be_selected() {
        let default = std::env::temp_dir().join("vibespace-default");
        let protected = std::env::temp_dir().join(".codex").join("managed");
        assert!(resolve_storage_root(&default, Some(&protected)).is_err());
    }
    #[test]
    fn regular_file_ancestor_is_rejected_without_creating_state() {
        let file =
            std::env::temp_dir().join(format!("vibespace-storage-file-{}", std::process::id()));
        std::fs::write(&file, b"fixture").unwrap();
        let result = resolve_storage_root(&std::env::temp_dir(), Some(&file.join("child")));
        std::fs::remove_file(&file).unwrap();
        assert!(result.is_err());
    }
    #[test]
    fn linked_ancestor_is_rejected() {
        let fixture =
            std::env::temp_dir().join(format!("vibespace-storage-link-{}", std::process::id()));
        let target = fixture.join("target");
        let link = fixture.join("link");
        std::fs::create_dir_all(&target).unwrap();
        #[cfg(windows)]
        {
            let status = std::process::Command::new("cmd")
                .args(["/d", "/c", "mklink", "/J"])
                .arg(&link)
                .arg(&target)
                .stdout(std::process::Stdio::null())
                .status()
                .unwrap();
            assert!(status.success());
        }
        #[cfg(unix)]
        std::os::unix::fs::symlink(&target, &link).unwrap();
        let result = resolve_storage_root(&std::env::temp_dir(), Some(&link.join("new-root")));
        #[cfg(windows)]
        std::fs::remove_dir(&link).unwrap();
        #[cfg(unix)]
        std::fs::remove_file(&link).unwrap();
        std::fs::remove_dir(&target).unwrap();
        std::fs::remove_dir(&fixture).unwrap();
        assert!(result.is_err());
    }
}
