use crate::harness::managed_cli_manifest::{embedded_managed_release, ManagedCliKind};
use crate::harness::managed_cli_runtime::{
    inspect_managed_runtime, opencodex_closure_sha256, ManagedCliReadiness,
};
use crate::harness::managed_codex_proxy_profile::ManagedCodexProxyProfile;
use std::fs::{self, File, OpenOptions};
use std::path::{Path, PathBuf};

#[cfg(windows)]
use std::os::windows::ffi::OsStrExt;
#[cfg(windows)]
use std::os::windows::fs::OpenOptionsExt;

#[cfg(windows)]
use windows::core::{PCWSTR, PWSTR};
#[cfg(windows)]
use windows::Win32::Foundation::{LocalFree, HLOCAL};
#[cfg(windows)]
use windows::Win32::Security::Authorization::{
    SetEntriesInAclW, SetNamedSecurityInfoW, DENY_ACCESS, EXPLICIT_ACCESS_W, SE_FILE_OBJECT,
    TRUSTEE_IS_SID, TRUSTEE_IS_WELL_KNOWN_GROUP, TRUSTEE_W,
};
#[cfg(windows)]
use windows::Win32::Security::{
    CreateWellKnownSid, GetFileSecurityW, GetSecurityDescriptorControl, GetSecurityDescriptorDacl,
    WinWorldSid, ACL, DACL_SECURITY_INFORMATION, NO_INHERITANCE,
    PROTECTED_DACL_SECURITY_INFORMATION, PSECURITY_DESCRIPTOR, PSID, SECURITY_MAX_SID_SIZE,
    SE_DACL_PROTECTED, UNPROTECTED_DACL_SECURITY_INFORMATION,
};
#[cfg(windows)]
use windows::Win32::Storage::FileSystem::{FILE_ADD_FILE, FILE_ADD_SUBDIRECTORY};

#[cfg(windows)]
const FILE_SHARE_READ_ONLY: u32 = 0x0000_0001;
#[cfg(windows)]
const FILE_FLAG_BACKUP_SEMANTICS: u32 = 0x0200_0000;

const REVIEWED_OPENCODEX_VERSION: &str = "2.36.0";
const SOURCE_ENTRYPOINT: &str = "node_modules/@bitkyc08/opencodex/src/cli/index.ts";
const BUN_ENTRYPOINT: &str = "node_modules/@oven/bun-windows-x64/bin/bun.exe";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReviewedOpenCodexRuntime {
    pub bun_executable: PathBuf,
    pub source_entrypoint: PathBuf,
    pub version: String,
}

#[derive(Debug)]
pub struct SealedReviewedOpenCodexRuntime {
    pub runtime: ReviewedOpenCodexRuntime,
    _closure_files: Vec<File>,
    _directory_dacls: DirectoryDaclGuard,
    version_root: PathBuf,
    expected_closure_sha256: String,
}

#[cfg(windows)]
#[derive(Debug)]
struct SavedDirectoryDacl {
    path: PathBuf,
    descriptor: Vec<usize>,
    protected: bool,
}

#[cfg(windows)]
#[derive(Debug)]
struct DirectoryDaclGuard {
    saved: Vec<SavedDirectoryDacl>,
}

#[cfg(not(windows))]
#[derive(Debug, Default)]
struct DirectoryDaclGuard;

#[cfg(windows)]
impl Drop for DirectoryDaclGuard {
    fn drop(&mut self) {
        for saved in self.saved.iter().rev() {
            let mut wide = saved.path.as_os_str().encode_wide().collect::<Vec<_>>();
            wide.push(0);
            let descriptor = PSECURITY_DESCRIPTOR(saved.descriptor.as_ptr().cast_mut().cast());
            let mut present = windows::core::BOOL::default();
            let mut defaulted = windows::core::BOOL::default();
            let mut dacl = std::ptr::null_mut();
            if unsafe {
                GetSecurityDescriptorDacl(descriptor, &mut present, &mut dacl, &mut defaulted)
            }
            .is_err()
            {
                continue;
            }
            let protection = if saved.protected {
                PROTECTED_DACL_SECURITY_INFORMATION
            } else {
                UNPROTECTED_DACL_SECURITY_INFORMATION
            };
            let _ = unsafe {
                SetNamedSecurityInfoW(
                    PWSTR(wide.as_mut_ptr()),
                    SE_FILE_OBJECT,
                    DACL_SECURITY_INFORMATION | protection,
                    None,
                    None,
                    Some(dacl),
                    None,
                )
            };
        }
    }
}

#[cfg(windows)]
fn read_directory_dacl(path: &Path) -> Result<SavedDirectoryDacl, ManagedCodexProxyRuntimeError> {
    let mut wide = path.as_os_str().encode_wide().collect::<Vec<_>>();
    wide.push(0);
    let mut needed = 0_u32;
    let _ = unsafe {
        GetFileSecurityW(
            PCWSTR(wide.as_ptr()),
            DACL_SECURITY_INFORMATION.0,
            None,
            0,
            &mut needed,
        )
    };
    if needed == 0 {
        return Err(ManagedCodexProxyRuntimeError::RuntimeUnreviewed);
    }
    let word = std::mem::size_of::<usize>();
    let mut descriptor = vec![0_usize; (needed as usize + word - 1) / word];
    if !unsafe {
        GetFileSecurityW(
            PCWSTR(wide.as_ptr()),
            DACL_SECURITY_INFORMATION.0,
            Some(PSECURITY_DESCRIPTOR(descriptor.as_mut_ptr().cast())),
            needed,
            &mut needed,
        )
    }
    .as_bool()
    {
        return Err(ManagedCodexProxyRuntimeError::RuntimeUnreviewed);
    }
    let mut control = 0_u16;
    let mut revision = 0_u32;
    unsafe {
        GetSecurityDescriptorControl(
            PSECURITY_DESCRIPTOR(descriptor.as_mut_ptr().cast()),
            &mut control,
            &mut revision,
        )
    }
    .map_err(|_| ManagedCodexProxyRuntimeError::RuntimeUnreviewed)?;
    Ok(SavedDirectoryDacl {
        path: path.to_path_buf(),
        descriptor,
        protected: control & SE_DACL_PROTECTED.0 != 0,
    })
}

#[cfg(windows)]
fn deny_directory_entry_creation(
    saved: &SavedDirectoryDacl,
) -> Result<(), ManagedCodexProxyRuntimeError> {
    let descriptor = PSECURITY_DESCRIPTOR(saved.descriptor.as_ptr().cast_mut().cast());
    let mut present = windows::core::BOOL::default();
    let mut defaulted = windows::core::BOOL::default();
    let mut old_dacl = std::ptr::null_mut::<ACL>();
    unsafe { GetSecurityDescriptorDacl(descriptor, &mut present, &mut old_dacl, &mut defaulted) }
        .map_err(|_| ManagedCodexProxyRuntimeError::RuntimeUnreviewed)?;
    if !present.as_bool() || old_dacl.is_null() {
        return Err(ManagedCodexProxyRuntimeError::RuntimeUnreviewed);
    }

    let mut world = vec![0_u8; SECURITY_MAX_SID_SIZE as usize];
    let mut world_size = world.len() as u32;
    unsafe {
        CreateWellKnownSid(
            WinWorldSid,
            None,
            Some(PSID(world.as_mut_ptr().cast())),
            &mut world_size,
        )
    }
    .map_err(|_| ManagedCodexProxyRuntimeError::RuntimeUnreviewed)?;
    let entry = EXPLICIT_ACCESS_W {
        grfAccessPermissions: FILE_ADD_FILE.0 | FILE_ADD_SUBDIRECTORY.0,
        grfAccessMode: DENY_ACCESS,
        grfInheritance: NO_INHERITANCE,
        Trustee: TRUSTEE_W {
            pMultipleTrustee: std::ptr::null_mut(),
            MultipleTrusteeOperation: Default::default(),
            TrusteeForm: TRUSTEE_IS_SID,
            TrusteeType: TRUSTEE_IS_WELL_KNOWN_GROUP,
            ptstrName: PWSTR(world.as_mut_ptr().cast()),
        },
    };
    let mut new_dacl = std::ptr::null_mut::<ACL>();
    let status = unsafe { SetEntriesInAclW(Some(&[entry]), Some(old_dacl), &mut new_dacl) };
    if status.0 != 0 || new_dacl.is_null() {
        return Err(ManagedCodexProxyRuntimeError::RuntimeUnreviewed);
    }
    let mut wide = saved.path.as_os_str().encode_wide().collect::<Vec<_>>();
    wide.push(0);
    let status = unsafe {
        SetNamedSecurityInfoW(
            PWSTR(wide.as_mut_ptr()),
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
            None,
            None,
            Some(new_dacl),
            None,
        )
    };
    unsafe { LocalFree(Some(HLOCAL(new_dacl.cast()))) };
    if status.0 != 0 {
        return Err(ManagedCodexProxyRuntimeError::RuntimeUnreviewed);
    }
    Ok(())
}

#[cfg(windows)]
fn seal_directory_dacls(
    directories: &[PathBuf],
) -> Result<DirectoryDaclGuard, ManagedCodexProxyRuntimeError> {
    let mut guard = DirectoryDaclGuard { saved: Vec::new() };
    for directory in directories {
        let saved = read_directory_dacl(directory)?;
        deny_directory_entry_creation(&saved)?;
        guard.saved.push(saved);
    }
    Ok(guard)
}

#[cfg(not(windows))]
fn seal_directory_dacls(
    _directories: &[PathBuf],
) -> Result<DirectoryDaclGuard, ManagedCodexProxyRuntimeError> {
    Ok(DirectoryDaclGuard)
}

impl SealedReviewedOpenCodexRuntime {
    pub fn revalidate(&self) -> Result<(), ManagedCodexProxyRuntimeError> {
        if opencodex_closure_sha256(&self.version_root).as_deref()
            == Some(self.expected_closure_sha256.as_str())
        {
            Ok(())
        } else {
            Err(ManagedCodexProxyRuntimeError::RuntimeUnreviewed)
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IsolatedCodexProxyPaths {
    pub root: PathBuf,
    pub opencodex_home: PathBuf,
    pub codex_home: PathBuf,
    pub opencodex_config: PathBuf,
    pub codex_config: PathBuf,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ManagedCodexProxyRuntimeError {
    UnsafeRoot,
    RuntimeUnavailable,
    RuntimeUnreviewed,
    ProfileContainsSecret,
    Disk,
}

fn runtime_from_attested_readiness(
    readiness: ManagedCliReadiness,
) -> Result<ReviewedOpenCodexRuntime, ManagedCodexProxyRuntimeError> {
    match readiness {
        ManagedCliReadiness::Missing => Err(ManagedCodexProxyRuntimeError::RuntimeUnavailable),
        ManagedCliReadiness::Incomplete { .. } | ManagedCliReadiness::Ready { .. } => {
            Err(ManagedCodexProxyRuntimeError::RuntimeUnreviewed)
        }
        ManagedCliReadiness::ProbeRequired { launch, .. } => {
            if launch.arguments.len() != 3
                || launch.arguments[1] != "ready"
                || launch.arguments[2] != "--json"
                || !launch.executable.ends_with(BUN_ENTRYPOINT)
            {
                return Err(ManagedCodexProxyRuntimeError::RuntimeUnreviewed);
            }
            let source_entrypoint = PathBuf::from(&launch.arguments[0]);
            if !source_entrypoint.ends_with(SOURCE_ENTRYPOINT) {
                return Err(ManagedCodexProxyRuntimeError::RuntimeUnreviewed);
            }
            Ok(ReviewedOpenCodexRuntime {
                bun_executable: launch.executable,
                source_entrypoint,
                version: REVIEWED_OPENCODEX_VERSION.to_string(),
            })
        }
    }
}

pub fn resolve_reviewed_opencodex_runtime(
    managed_base: &Path,
    _roaming_app_data: Option<&Path>,
) -> Result<ReviewedOpenCodexRuntime, ManagedCodexProxyRuntimeError> {
    let release = embedded_managed_release(ManagedCliKind::OpenCodex, "windows", "x86_64")
        .map_err(|_| ManagedCodexProxyRuntimeError::RuntimeUnreviewed)?;
    if release.version != REVIEWED_OPENCODEX_VERSION {
        return Err(ManagedCodexProxyRuntimeError::RuntimeUnreviewed);
    }
    runtime_from_attested_readiness(inspect_managed_runtime(
        &managed_base.join("opencodex"),
        &release,
    ))
}

fn collect_regular_closure_paths(
    root: &Path,
    directory: &Path,
    files: &mut Vec<PathBuf>,
    directories: &mut Vec<PathBuf>,
) -> Result<(), ManagedCodexProxyRuntimeError> {
    directories.push(
        fs::canonicalize(directory)
            .map_err(|_| ManagedCodexProxyRuntimeError::RuntimeUnreviewed)?,
    );
    for entry in
        fs::read_dir(directory).map_err(|_| ManagedCodexProxyRuntimeError::RuntimeUnreviewed)?
    {
        let entry = entry.map_err(|_| ManagedCodexProxyRuntimeError::RuntimeUnreviewed)?;
        let path = entry.path();
        let metadata = fs::symlink_metadata(&path)
            .map_err(|_| ManagedCodexProxyRuntimeError::RuntimeUnreviewed)?;
        if metadata.file_type().is_symlink() {
            return Err(ManagedCodexProxyRuntimeError::RuntimeUnreviewed);
        }
        if metadata.is_dir() {
            collect_regular_closure_paths(root, &path, files, directories)?;
        } else if metadata.is_file() {
            let canonical = fs::canonicalize(&path)
                .map_err(|_| ManagedCodexProxyRuntimeError::RuntimeUnreviewed)?;
            if !canonical.starts_with(root) {
                return Err(ManagedCodexProxyRuntimeError::RuntimeUnreviewed);
            }
            files.push(canonical);
        } else {
            return Err(ManagedCodexProxyRuntimeError::RuntimeUnreviewed);
        }
    }
    Ok(())
}

fn seal_closure_files(
    version_root: &Path,
) -> Result<(Vec<File>, DirectoryDaclGuard), ManagedCodexProxyRuntimeError> {
    let canonical_root = fs::canonicalize(version_root)
        .map_err(|_| ManagedCodexProxyRuntimeError::RuntimeUnreviewed)?;
    let mut paths = Vec::new();
    let mut directories = Vec::new();
    collect_regular_closure_paths(
        &canonical_root,
        &canonical_root,
        &mut paths,
        &mut directories,
    )?;
    paths.sort();
    directories.sort();
    let mut sealed = paths
        .into_iter()
        .map(|path| {
            let mut options = OpenOptions::new();
            options.read(true);
            #[cfg(windows)]
            options.share_mode(FILE_SHARE_READ_ONLY);
            options
                .open(path)
                .map_err(|_| ManagedCodexProxyRuntimeError::RuntimeUnreviewed)
        })
        .collect::<Result<Vec<_>, _>>()?;
    #[cfg(windows)]
    for directory in &directories {
        let mut options = OpenOptions::new();
        options
            .access_mode(0)
            .share_mode(FILE_SHARE_READ_ONLY)
            .custom_flags(FILE_FLAG_BACKUP_SEMANTICS);
        sealed.push(
            options
                .open(directory)
                .map_err(|_| ManagedCodexProxyRuntimeError::RuntimeUnreviewed)?,
        );
    }
    let directory_dacls = seal_directory_dacls(&directories)?;
    Ok((sealed, directory_dacls))
}

pub fn seal_reviewed_opencodex_runtime(
    managed_base: &Path,
    roaming_app_data: Option<&Path>,
) -> Result<SealedReviewedOpenCodexRuntime, ManagedCodexProxyRuntimeError> {
    let expected_closure_sha256 =
        embedded_managed_release(ManagedCliKind::OpenCodex, "windows", "x86_64")
            .map_err(|_| ManagedCodexProxyRuntimeError::RuntimeUnreviewed)?
            .closure_sha256
            .ok_or(ManagedCodexProxyRuntimeError::RuntimeUnreviewed)?;
    let first = resolve_reviewed_opencodex_runtime(managed_base, roaming_app_data)?;
    let version_root = first
        .source_entrypoint
        .ancestors()
        .find(|path| {
            path.file_name().and_then(|name| name.to_str()) == Some(REVIEWED_OPENCODEX_VERSION)
        })
        .ok_or(ManagedCodexProxyRuntimeError::RuntimeUnreviewed)?;
    let (closure_files, directory_dacls) = seal_closure_files(version_root)?;
    let second = resolve_reviewed_opencodex_runtime(managed_base, roaming_app_data)?;
    if first != second {
        return Err(ManagedCodexProxyRuntimeError::RuntimeUnreviewed);
    }
    Ok(SealedReviewedOpenCodexRuntime {
        runtime: second,
        _closure_files: closure_files,
        _directory_dacls: directory_dacls,
        version_root: version_root.to_path_buf(),
        expected_closure_sha256,
    })
}

fn ensure_owned_directory(path: &Path) -> Result<(), ManagedCodexProxyRuntimeError> {
    fs::create_dir_all(path).map_err(|_| ManagedCodexProxyRuntimeError::Disk)?;
    let metadata = fs::symlink_metadata(path).map_err(|_| ManagedCodexProxyRuntimeError::Disk)?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(ManagedCodexProxyRuntimeError::UnsafeRoot);
    }
    Ok(())
}

fn replace_owned_file(path: &Path, bytes: &[u8]) -> Result<(), ManagedCodexProxyRuntimeError> {
    if let Ok(metadata) = fs::symlink_metadata(path) {
        if !metadata.is_file() || metadata.file_type().is_symlink() {
            return Err(ManagedCodexProxyRuntimeError::UnsafeRoot);
        }
    }
    let parent = path
        .parent()
        .ok_or(ManagedCodexProxyRuntimeError::UnsafeRoot)?;
    let temporary = parent.join(format!(".vibespace-profile-{}.tmp", nanoid::nanoid!(16)));
    fs::write(&temporary, bytes).map_err(|_| ManagedCodexProxyRuntimeError::Disk)?;
    if path.exists() {
        fs::remove_file(path).map_err(|_| ManagedCodexProxyRuntimeError::Disk)?;
    }
    fs::rename(&temporary, path).map_err(|_| ManagedCodexProxyRuntimeError::Disk)
}

pub fn materialize_isolated_profile(
    app_data_root: &Path,
    profile: &ManagedCodexProxyProfile,
) -> Result<IsolatedCodexProxyPaths, ManagedCodexProxyRuntimeError> {
    if !app_data_root.is_absolute()
        || profile
            .opencodex_config_json
            .windows(b"VIBESPACE_OPENCODE_GO_API_KEY=".len())
            .any(|window| window == b"VIBESPACE_OPENCODE_GO_API_KEY=")
    {
        return Err(if app_data_root.is_absolute() {
            ManagedCodexProxyRuntimeError::ProfileContainsSecret
        } else {
            ManagedCodexProxyRuntimeError::UnsafeRoot
        });
    }
    let root = app_data_root.join("managed/codex-opencodex");
    let opencodex_home = root.join("opencodex-home");
    let codex_home = root.join("codex-home");
    ensure_owned_directory(&opencodex_home)?;
    ensure_owned_directory(&codex_home)?;
    let opencodex_config = opencodex_home.join("config.json");
    let codex_config = codex_home.join("config.toml");
    replace_owned_file(&opencodex_config, &profile.opencodex_config_json)?;
    replace_owned_file(&codex_config, &profile.codex_config_toml)?;
    Ok(IsolatedCodexProxyPaths {
        root,
        opencodex_home,
        codex_home,
        opencodex_config,
        codex_config,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::harness::managed_codex_proxy_profile::build_managed_codex_proxy_profile;
    use std::net::Ipv4Addr;
    use std::sync::atomic::{AtomicU64, Ordering};

    fn temp_root(name: &str) -> PathBuf {
        static SEQUENCE: AtomicU64 = AtomicU64::new(0);
        std::env::temp_dir().join(format!(
            "vibespace-proxy-runtime-{name}-{}-{}",
            std::process::id(),
            SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ))
    }

    fn metadata_only_runtime(root: &Path, version: &str) {
        fs::create_dir_all(root.join(SOURCE_ENTRYPOINT).parent().unwrap()).unwrap();
        fs::create_dir_all(root.join("node_modules/@oven/bun-windows-x64/bin")).unwrap();
        fs::write(
            root.join("node_modules/@bitkyc08/opencodex/package.json"),
            format!(r#"{{"name":"@bitkyc08/opencodex","version":"{version}"}}"#),
        )
        .unwrap();
        fs::write(root.join(SOURCE_ENTRYPOINT), b"source").unwrap();
        fs::write(root.join(BUN_ENTRYPOINT), b"bun").unwrap();
    }

    #[test]
    fn metadata_only_or_byte_mutated_managed_runtime_fails_closed() {
        let fixture = temp_root("resolve");
        let managed = fixture
            .join("managed/opencodex/versions")
            .join(REVIEWED_OPENCODEX_VERSION);
        metadata_only_runtime(&managed, REVIEWED_OPENCODEX_VERSION);
        assert_eq!(
            resolve_reviewed_opencodex_runtime(&fixture.join("managed"), None).err(),
            Some(ManagedCodexProxyRuntimeError::RuntimeUnreviewed)
        );
        fs::write(managed.join(BUN_ENTRYPOINT), b"mutated bun").unwrap();
        assert_eq!(
            resolve_reviewed_opencodex_runtime(&fixture.join("managed"), None).err(),
            Some(ManagedCodexProxyRuntimeError::RuntimeUnreviewed)
        );
        fs::write(managed.join(BUN_ENTRYPOINT), b"bun").unwrap();
        fs::write(managed.join(SOURCE_ENTRYPOINT), b"mutated source").unwrap();
        assert_eq!(
            resolve_reviewed_opencodex_runtime(&fixture.join("managed"), None).err(),
            Some(ManagedCodexProxyRuntimeError::RuntimeUnreviewed)
        );
        fs::remove_dir_all(fixture).unwrap();
    }

    #[test]
    fn roaming_package_metadata_never_attests_a_runtime() {
        let fixture = temp_root("roaming-metadata");
        let roaming = fixture.join("roaming/npm/node_modules/@bitkyc08/opencodex");
        metadata_only_runtime(&roaming, REVIEWED_OPENCODEX_VERSION);

        assert_eq!(
            resolve_reviewed_opencodex_runtime(
                &fixture.join("managed"),
                Some(&fixture.join("roaming")),
            )
            .err(),
            Some(ManagedCodexProxyRuntimeError::RuntimeUnavailable)
        );
        fs::remove_dir_all(fixture).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn sealed_closure_denies_dependency_and_receipt_rewrites_until_released() {
        let fixture = temp_root("sealed-closure");
        fs::create_dir_all(&fixture).unwrap();
        let dependency = fixture.join("node_modules/dependency/index.js");
        let receipt = fixture.join("vibespace-runtime.json");
        fs::create_dir_all(dependency.parent().unwrap()).unwrap();
        fs::write(&dependency, b"reviewed").unwrap();
        fs::write(&receipt, b"receipt").unwrap();

        let seal = seal_closure_files(&fixture).expect("sealed closure");
        assert!(fs::write(&dependency, b"mutated").is_err());
        assert!(fs::write(&receipt, b"rewritten receipt").is_err());
        assert!(fs::write(fixture.join("new-dependency.js"), b"extra").is_err());
        let swapped = fixture.with_extension("swapped");
        assert!(fs::rename(&fixture, &swapped).is_err());
        drop(seal);
        fs::write(&dependency, b"mutated after release").unwrap();
        fs::write(fixture.join("new-dependency.js"), b"extra after release").unwrap();
        fs::rename(&fixture, &swapped).unwrap();
        fs::rename(&swapped, &fixture).unwrap();
        fs::remove_dir_all(fixture).unwrap();
    }

    #[test]
    fn installer_attested_probe_plan_maps_to_the_reviewed_runtime() {
        let root = temp_root("attested-plan");
        let bun = root.join(BUN_ENTRYPOINT);
        let source = root.join(SOURCE_ENTRYPOINT);
        let runtime = runtime_from_attested_readiness(ManagedCliReadiness::ProbeRequired {
            launch: crate::harness::managed_cli_runtime::ManagedCliLaunch {
                executable: bun.clone(),
                arguments: vec![
                    source.to_string_lossy().into_owned(),
                    "ready".to_string(),
                    "--json".to_string(),
                ],
            },
            dependency_lock_sha256: "a".repeat(64),
        })
        .expect("attested runtime projection");

        assert_eq!(runtime.bun_executable, bun);
        assert_eq!(runtime.source_entrypoint, source);
        assert_eq!(runtime.version, REVIEWED_OPENCODEX_VERSION);
    }

    #[test]
    fn profile_materialization_is_isolated_secret_free_and_idempotent() {
        let fixture = temp_root("profile");
        fs::create_dir(&fixture).unwrap();
        let profile = build_managed_codex_proxy_profile(
            Ipv4Addr::LOCALHOST,
            10_101,
            "opencode-go/deepseek-v4-flash-vision-exp",
            "chat_1",
        )
        .unwrap();
        let first = materialize_isolated_profile(&fixture, &profile).expect("first");
        let second = materialize_isolated_profile(&fixture, &profile).expect("second");
        assert_eq!(first, second);
        assert_eq!(
            fs::read(first.opencodex_config).unwrap(),
            profile.opencodex_config_json
        );
        assert_eq!(
            fs::read(first.codex_config).unwrap(),
            profile.codex_config_toml
        );
        fs::remove_dir_all(fixture).unwrap();
    }

    #[test]
    fn relative_roots_and_non_files_fail_closed() {
        let profile = build_managed_codex_proxy_profile(
            Ipv4Addr::LOCALHOST,
            10_101,
            "opencode-go/deepseek-v4-flash-vision-exp",
            "chat_1",
        )
        .unwrap();
        assert_eq!(
            materialize_isolated_profile(Path::new("relative"), &profile).err(),
            Some(ManagedCodexProxyRuntimeError::UnsafeRoot)
        );
        let fixture = temp_root("unsafe");
        fs::create_dir_all(fixture.join("managed/codex-opencodex/opencodex-home/config.json"))
            .unwrap();
        assert!(materialize_isolated_profile(&fixture, &profile).is_err());
        fs::remove_dir_all(fixture).unwrap();
    }
}
