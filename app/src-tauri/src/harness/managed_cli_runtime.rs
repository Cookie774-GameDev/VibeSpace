use crate::harness::managed_cli_manifest::{ManagedCliKind, ManagedCliRelease};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

const RUNTIME_RECEIPT_SCHEMA_VERSION: u32 = 2;
const OPENCODEX_ENTRYPOINT: &str = "node_modules/@bitkyc08/opencodex/bin/ocx.mjs";
const OPENCODEX_SOURCE_ENTRYPOINT: &str = "node_modules/@bitkyc08/opencodex/src/cli/index.ts";
const OPENCODEX_PACKAGE_JSON: &str = "node_modules/@bitkyc08/opencodex/package.json";
const OPENCODEX_BUN_EXECUTABLE: &str = "node_modules/@oven/bun-windows-x64/bin/bun.exe";
const OPENCODEX_DEPENDENCY_LOCK: &str = "bun.lock";
// Official rust-v0.151.0 companion; the main Windows ZIP does not contain it.
pub(crate) const CODEX_CODE_MODE_HOST: &str = "codex-code-mode-host.exe";
pub(crate) const CODEX_CODE_MODE_HOST_SHA256: &str =
    "4ea17cf938023f2d0c292b6dbcd4d51e7fbdf72f3885cf341017a380a87e77dc";
pub(crate) const CODEX_CODE_MODE_HOST_MISSING: &str = "Managed Codex code-mode helper is missing.";

pub(crate) fn inspect_codex_code_mode_host(root: &Path) -> Result<(), &'static str> {
    if !root.join(CODEX_CODE_MODE_HOST).try_exists().map_err(|_| "Managed Codex code-mode helper is unavailable.")? {
        return Err(CODEX_CODE_MODE_HOST_MISSING);
    }
    let file = regular_file_within(root, CODEX_CODE_MODE_HOST)
        .ok_or("Managed Codex code-mode helper is unsafe.")?;
    if file_sha256(&file).as_deref() != Some(CODEX_CODE_MODE_HOST_SHA256) {
        return Err("Managed Codex code-mode helper integrity failed.");
    }
    Ok(())
}

const CODEX_ENTRYPOINT_SHA256: &str =
    "cf68265897197ac5f3bff6a10c168eec159842b353129726da5e3ed6b91ef0f4";
const OPENCODEX_ENTRYPOINT_SHA256: &str =
    "5cb1ca93c8569707eba6bd665a0f9960fe37981d8149a14e78654c3b60217a08";
const OPENCODEX_SOURCE_ENTRYPOINT_SHA256: &str =
    "b4ba24ff43ee62b91e8dfb1cb267d044ca2261e2b50a737e310d5ec69fee650b";
const OPENCODEX_DEPENDENCY_LOCK_SHA256: &str =
    "6a3e0bed984743fbe76ae63d23296a72ec1f87ab6df56ee6bd0c66d5529ac2d5";
const OPENCODEX_BUN_EXECUTABLE_SHA256: &str =
    "627d2e4775c24bdedee2cd7ccc18dcadae061e5345274ab6e3c4c797927bfb8f";
const OPENCODEX_REQUIRED_FILES: &[&str] = &[
    OPENCODEX_SOURCE_ENTRYPOINT,
    OPENCODEX_DEPENDENCY_LOCK,
    "node_modules/bun/package.json",
    OPENCODEX_BUN_EXECUTABLE,
    "node_modules/@bufbuild/protobuf/package.json",
    "node_modules/@modelcontextprotocol/sdk/package.json",
    "node_modules/@napi-rs/keyring/package.json",
    "node_modules/@napi-rs/keyring-win32-x64-msvc/package.json",
    "node_modules/@napi-rs/keyring-win32-x64-msvc/keyring.win32-x64-msvc.node",
    "node_modules/@oven/bun-windows-x64/package.json",
    "node_modules/zod/package.json",
];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ManagedCliLaunch {
    pub executable: PathBuf,
    pub arguments: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ManagedCliReadiness {
    Missing,
    Incomplete {
        reason: &'static str,
    },
    ProbeRequired {
        launch: ManagedCliLaunch,
        dependency_lock_sha256: String,
    },
    Ready {
        launch: ManagedCliLaunch,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ManagedCliProbe {
    pub kind: ManagedCliKind,
    pub version: String,
    pub exit_code: i32,
    pub ready: bool,
    pub loopback: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ManagedRuntimeReceipt {
    schema_version: u32,
    kind: ManagedCliKind,
    version: String,
    artifact_sha256: String,
    entrypoint: String,
    entrypoint_sha256: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    dependency_lock_sha256: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    runtime_executable_sha256: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    closure_sha256: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LegacyOpenCodexReceiptV1 {
    schema_version: u32,
    kind: ManagedCliKind,
    version: String,
    artifact_sha256: String,
    entrypoint: String,
    entrypoint_sha256: String,
    dependency_lock_sha256: String,
    runtime_executable_sha256: String,
}

impl ManagedRuntimeReceipt {
    pub fn codex(release: &ManagedCliRelease, entrypoint_sha256: &str) -> Self {
        Self::new(release, entrypoint_sha256, None, None, None)
    }

    pub fn opencodex(
        release: &ManagedCliRelease,
        entrypoint_sha256: &str,
        dependency_lock_sha256: &str,
        runtime_executable_sha256: &str,
        closure_sha256: &str,
    ) -> Self {
        Self::new(
            release,
            entrypoint_sha256,
            Some(dependency_lock_sha256.to_string()),
            Some(runtime_executable_sha256.to_string()),
            Some(closure_sha256.to_string()),
        )
    }

    fn new(
        release: &ManagedCliRelease,
        entrypoint_sha256: &str,
        dependency_lock_sha256: Option<String>,
        runtime_executable_sha256: Option<String>,
        closure_sha256: Option<String>,
    ) -> Self {
        Self {
            schema_version: RUNTIME_RECEIPT_SCHEMA_VERSION,
            kind: release.kind,
            version: release.version.clone(),
            artifact_sha256: release.sha256.clone(),
            entrypoint: runtime_entrypoint(release).to_string(),
            entrypoint_sha256: entrypoint_sha256.to_string(),
            dependency_lock_sha256,
            runtime_executable_sha256,
            closure_sha256,
        }
    }

    fn matches_release(&self, release: &ManagedCliRelease) -> bool {
        self.schema_version == RUNTIME_RECEIPT_SCHEMA_VERSION
            && self.kind == release.kind
            && self.version == release.version
            && self.artifact_sha256 == release.sha256
            && self.entrypoint == runtime_entrypoint(release)
            && is_sha256(&self.entrypoint_sha256)
            && match release.kind {
                ManagedCliKind::Codex => {
                    self.dependency_lock_sha256.is_none()
                        && self.runtime_executable_sha256.is_none()
                        && self.closure_sha256.is_none()
                }
                ManagedCliKind::OpenCodex => {
                    self.dependency_lock_sha256
                        .as_deref()
                        .map(is_sha256)
                        .unwrap_or(false)
                        && self
                            .runtime_executable_sha256
                            .as_deref()
                            .map(is_sha256)
                            .unwrap_or(false)
                        && self
                            .closure_sha256
                            .as_deref()
                            .map(is_sha256)
                            .unwrap_or(false)
                }
            }
    }
}

fn runtime_entrypoint(release: &ManagedCliRelease) -> &str {
    match release.kind {
        ManagedCliKind::Codex => &release.entrypoint,
        ManagedCliKind::OpenCodex => OPENCODEX_ENTRYPOINT,
    }
}

fn is_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

fn regular_file_within(version_root: &Path, relative_path: &str) -> Option<PathBuf> {
    let canonical_root = fs::canonicalize(version_root).ok()?;
    let candidate = version_root.join(relative_path);
    let metadata = fs::symlink_metadata(&candidate).ok()?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return None;
    }
    let canonical_candidate = fs::canonicalize(&candidate).ok()?;
    canonical_candidate
        .starts_with(&canonical_root)
        .then_some(candidate)
}

pub(crate) fn is_rematerializable_legacy_opencodex(
    managed_root: &Path,
    release: &ManagedCliRelease,
) -> bool {
    is_rematerializable_legacy_opencodex_version(
        &managed_root.join("versions").join(&release.version),
        release,
    )
}

pub(crate) fn is_rematerializable_legacy_opencodex_version(
    version_root: &Path,
    release: &ManagedCliRelease,
) -> bool {
    if release.kind != ManagedCliKind::OpenCodex {
        return false;
    }
    let Ok(root_metadata) = fs::symlink_metadata(version_root) else {
        return false;
    };
    if !root_metadata.is_dir() || root_metadata.file_type().is_symlink() {
        return false;
    }
    let Ok(bytes) = fs::read(version_root.join("vibespace-runtime.json")) else {
        return false;
    };
    let Ok(receipt) = serde_json::from_slice::<LegacyOpenCodexReceiptV1>(&bytes) else {
        return false;
    };
    receipt.schema_version == 1
        && receipt.kind == release.kind
        && receipt.version == release.version
        && receipt.artifact_sha256 == release.sha256
        && receipt.entrypoint == OPENCODEX_ENTRYPOINT
        && receipt.entrypoint_sha256 == OPENCODEX_ENTRYPOINT_SHA256
        && receipt.dependency_lock_sha256 == OPENCODEX_DEPENDENCY_LOCK_SHA256
        && receipt.runtime_executable_sha256 == OPENCODEX_BUN_EXECUTABLE_SHA256
        && regular_file_within(version_root, OPENCODEX_ENTRYPOINT)
            .and_then(|path| file_sha256(&path))
            .as_deref()
            == Some(OPENCODEX_ENTRYPOINT_SHA256)
        && regular_file_within(version_root, OPENCODEX_SOURCE_ENTRYPOINT)
            .and_then(|path| file_sha256(&path))
            .as_deref()
            == Some(OPENCODEX_SOURCE_ENTRYPOINT_SHA256)
        && regular_file_within(version_root, OPENCODEX_DEPENDENCY_LOCK)
            .and_then(|path| file_sha256(&path))
            .as_deref()
            == Some(OPENCODEX_DEPENDENCY_LOCK_SHA256)
        && regular_file_within(version_root, OPENCODEX_BUN_EXECUTABLE)
            .and_then(|path| file_sha256(&path))
            .as_deref()
            == Some(OPENCODEX_BUN_EXECUTABLE_SHA256)
        && OPENCODEX_REQUIRED_FILES
            .iter()
            .all(|required| regular_file_within(version_root, required).is_some())
        && [
            ("node_modules/bun/package.json", "1.4.0"),
            ("node_modules/@oven/bun-windows-x64/package.json", "1.4.0"),
            ("node_modules/@napi-rs/keyring/package.json", "1.3.0"),
            (
                "node_modules/@napi-rs/keyring-win32-x64-msvc/package.json",
                "1.3.0",
            ),
            ("node_modules/zod/package.json", "4.4.3"),
        ]
        .iter()
        .all(|(path, version)| package_version(version_root, path).as_deref() == Some(*version))
}

fn file_sha256(path: &Path) -> Option<String> {
    let mut file = fs::File::open(path).ok()?;
    let mut hash = Sha256::new();
    // Runtime binaries are large and revalidated throughout a native session.
    // Keep memory bounded while hashing every byte with the same algorithm.
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let count = match file.read(&mut buffer) {
            Ok(count) => count,
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(_) => return None,
        };
        if count == 0 {
            break;
        }
        hash.update(&buffer[..count]);
    }
    Some(format!("{:x}", hash.finalize()))
}

fn collect_opencodex_closure_files(
    canonical_root: &Path,
    directory: &Path,
    files: &mut Vec<(String, PathBuf)>,
) -> Option<()> {
    for entry in fs::read_dir(directory).ok()? {
        let entry = entry.ok()?;
        let path = entry.path();
        let metadata = fs::symlink_metadata(&path).ok()?;
        if metadata.file_type().is_symlink() {
            return None;
        }
        if metadata.is_dir() {
            collect_opencodex_closure_files(canonical_root, &path, files)?;
            continue;
        }
        if !metadata.is_file() {
            return None;
        }
        let canonical = fs::canonicalize(&path).ok()?;
        if !canonical.starts_with(canonical_root) {
            return None;
        }
        let relative = canonical.strip_prefix(canonical_root).ok()?;
        let relative = relative.to_str()?.replace('\\', "/");
        if relative == "vibespace-runtime.json" {
            continue;
        }
        files.push((relative, canonical));
    }
    Some(())
}

pub(crate) fn opencodex_closure_sha256(version_root: &Path) -> Option<String> {
    let metadata = fs::symlink_metadata(version_root).ok()?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return None;
    }
    let canonical_root = fs::canonicalize(version_root).ok()?;
    let mut files = Vec::new();
    collect_opencodex_closure_files(&canonical_root, &canonical_root, &mut files)?;
    files.sort_by(|left, right| left.0.cmp(&right.0));
    let hashes = closure_file_hashes(&files)?;
    let mut closure = Sha256::new();
    for ((relative, _), file_hash) in files.iter().zip(hashes) {
        closure.update((relative.len() as u64).to_le_bytes());
        closure.update(relative.as_bytes());
        closure.update(file_hash.as_bytes());
    }
    Some(format!("{:x}", closure.finalize()))
}

fn closure_file_hashes(files: &[(String, PathBuf)]) -> Option<Vec<String>> {
    // Every file is still read and verified on every validation. Bound concurrent
    // readers for the large reviewed runtime; keep small closures inexpensive.
    if files.len() < 64 {
        return files.iter().map(|(_, path)| file_sha256(path)).collect();
    }
    std::thread::scope(|scope| {
        let mut workers = Vec::new();
        for chunk in files.chunks(files.len().div_ceil(4)) {
            workers.push(
                std::thread::Builder::new()
                    .name("runtime-integrity".to_string())
                    .spawn_scoped(scope, move || {
                        chunk.iter().map(|(_, path)| file_sha256(path)).collect::<Option<Vec<_>>>()
                    })
                    .ok()?,
            );
        }
        let mut hashes = Vec::with_capacity(files.len());
        // Join in sorted chunk order, regardless of worker completion order.
        for worker in workers {
            hashes.extend(worker.join().ok()??);
        }
        Some(hashes)
    })
}

fn package_version(version_root: &Path, relative_path: &str) -> Option<String> {
    let path = regular_file_within(version_root, relative_path)?;
    let value: serde_json::Value = serde_json::from_slice(&fs::read(path).ok()?).ok()?;
    value.get("version")?.as_str().map(str::to_string)
}

fn inspect_opencodex_closure(
    version_root: &Path,
    release: &ManagedCliRelease,
    receipt: &ManagedRuntimeReceipt,
) -> Result<(), &'static str> {
    let closure_sha256 = opencodex_closure_sha256(version_root)
        .ok_or("OpenCodex executable closure is unsafe or unreadable.")?;
    if Some(closure_sha256.as_str()) != receipt.closure_sha256.as_deref()
        || Some(closure_sha256.as_str()) != release.closure_sha256.as_deref()
    {
        return Err("OpenCodex executable closure checksum is mismatched.");
    }
    if package_version(version_root, OPENCODEX_PACKAGE_JSON).as_deref()
        != Some(release.version.as_str())
    {
        return Err("OpenCodex package identity is missing or mismatched.");
    }
    for required in OPENCODEX_REQUIRED_FILES {
        if regular_file_within(version_root, required).is_none() {
            return Err("OpenCodex dependency closure is incomplete.");
        }
    }
    let source_entrypoint = regular_file_within(version_root, OPENCODEX_SOURCE_ENTRYPOINT)
        .ok_or("OpenCodex source entrypoint is missing.")?;
    if file_sha256(&source_entrypoint).as_deref() != Some(OPENCODEX_SOURCE_ENTRYPOINT_SHA256) {
        return Err("OpenCodex source entrypoint checksum is mismatched.");
    }
    for (path, version) in [
        ("node_modules/bun/package.json", "1.4.0"),
        ("node_modules/@oven/bun-windows-x64/package.json", "1.4.0"),
        ("node_modules/@napi-rs/keyring/package.json", "1.3.0"),
        (
            "node_modules/@napi-rs/keyring-win32-x64-msvc/package.json",
            "1.3.0",
        ),
        ("node_modules/zod/package.json", "4.4.3"),
    ] {
        if package_version(version_root, path).as_deref() != Some(version) {
            return Err("OpenCodex direct dependency identity is mismatched.");
        }
    }
    let lock_path = regular_file_within(version_root, OPENCODEX_DEPENDENCY_LOCK)
        .ok_or("OpenCodex dependency lock is missing.")?;
    let lock_sha256 = file_sha256(&lock_path);
    if lock_sha256.as_deref() != Some(OPENCODEX_DEPENDENCY_LOCK_SHA256)
        || lock_sha256.as_deref() != receipt.dependency_lock_sha256.as_deref()
    {
        return Err("OpenCodex dependency closure checksum is mismatched.");
    }
    let runtime_executable = regular_file_within(version_root, OPENCODEX_BUN_EXECUTABLE)
        .ok_or("OpenCodex managed Bun runtime is missing.")?;
    let runtime_executable_sha256 = file_sha256(&runtime_executable);
    if runtime_executable_sha256.as_deref() != Some(OPENCODEX_BUN_EXECUTABLE_SHA256)
        || runtime_executable_sha256.as_deref() != receipt.runtime_executable_sha256.as_deref()
    {
        return Err("OpenCodex managed Bun runtime checksum is mismatched.");
    }
    Ok(())
}

pub fn confirm_managed_runtime_probe(
    readiness: ManagedCliReadiness,
    release: &ManagedCliRelease,
    probe: &ManagedCliProbe,
) -> ManagedCliReadiness {
    let ManagedCliReadiness::ProbeRequired {
        launch,
        dependency_lock_sha256,
    } = readiness
    else {
        return ManagedCliReadiness::Incomplete {
            reason: "Managed CLI runtime was not awaiting a probe.",
        };
    };
    if release.kind != ManagedCliKind::OpenCodex
        || probe.kind != release.kind
        || probe.version != release.version
        || probe.exit_code != 0
        || !probe.ready
        || !probe.loopback
    {
        return ManagedCliReadiness::Incomplete {
            reason: "OpenCodex bounded readiness probe did not prove the pinned loopback runtime.",
        };
    }
    if !is_sha256(&dependency_lock_sha256) {
        return ManagedCliReadiness::Incomplete {
            reason: "OpenCodex dependency lock proof is invalid.",
        };
    }
    ManagedCliReadiness::Ready { launch }
}

pub fn inspect_managed_runtime(
    managed_root: &Path,
    release: &ManagedCliRelease,
) -> ManagedCliReadiness {
    let version_root = managed_root.join("versions").join(&release.version);
    if !version_root.exists() {
        return ManagedCliReadiness::Missing;
    }
    let version_metadata = match fs::symlink_metadata(&version_root) {
        Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => metadata,
        _ => {
            return ManagedCliReadiness::Incomplete {
                reason: "Managed CLI version root is unsafe.",
            }
        }
    };
    drop(version_metadata);

    let receipt_path = version_root.join("vibespace-runtime.json");
    let receipt = fs::read(&receipt_path)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<ManagedRuntimeReceipt>(&bytes).ok());
    let Some(receipt) = receipt else {
        return ManagedCliReadiness::Incomplete {
            reason: "Managed CLI receipt is missing or invalid.",
        };
    };
    if !receipt.matches_release(release) {
        return ManagedCliReadiness::Incomplete {
            reason: "Managed CLI receipt does not match the pinned release.",
        };
    }

    let Some(entrypoint) = regular_file_within(&version_root, runtime_entrypoint(release)) else {
        return ManagedCliReadiness::Incomplete {
            reason: "Managed CLI entrypoint is missing or unsafe.",
        };
    };
    let entrypoint_sha256 = file_sha256(&entrypoint);
    let expected_entrypoint_sha256 = match release.kind {
        ManagedCliKind::Codex => CODEX_ENTRYPOINT_SHA256,
        ManagedCliKind::OpenCodex => OPENCODEX_ENTRYPOINT_SHA256,
    };
    if entrypoint_sha256.as_deref() != Some(expected_entrypoint_sha256)
        || entrypoint_sha256.as_deref() != Some(receipt.entrypoint_sha256.as_str())
    {
        return ManagedCliReadiness::Incomplete {
            reason: "Managed CLI entrypoint checksum is mismatched.",
        };
    }
    if release.kind == ManagedCliKind::Codex {
        if let Err(reason) = inspect_codex_code_mode_host(&version_root) {
            return ManagedCliReadiness::Incomplete { reason };
        }
    }
    if release.kind == ManagedCliKind::OpenCodex {
        if let Err(reason) = inspect_opencodex_closure(&version_root, release, &receipt) {
            return ManagedCliReadiness::Incomplete { reason };
        }
    }

    match release.kind {
        ManagedCliKind::Codex => ManagedCliReadiness::Ready {
            launch: ManagedCliLaunch {
                executable: entrypoint,
                arguments: Vec::new(),
            },
        },
        ManagedCliKind::OpenCodex => {
            let dependency_lock_sha256 = receipt
                .dependency_lock_sha256
                .expect("validated OpenCodex dependency lock hash");
            ManagedCliReadiness::ProbeRequired {
                launch: ManagedCliLaunch {
                    executable: version_root.join(OPENCODEX_BUN_EXECUTABLE),
                    arguments: vec![
                        version_root
                            .join(OPENCODEX_SOURCE_ENTRYPOINT)
                            .to_string_lossy()
                            .into_owned(),
                        "ready".to_string(),
                        "--json".to_string(),
                    ],
                },
                dependency_lock_sha256,
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{
        closure_file_hashes, confirm_managed_runtime_probe, file_sha256, inspect_managed_runtime,
        opencodex_closure_sha256,
        ManagedCliProbe, ManagedCliReadiness, ManagedRuntimeReceipt,
    };
    use crate::harness::managed_cli_manifest::{embedded_managed_release, ManagedCliKind};
    use sha2::{Digest, Sha256};
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::time::{SystemTime, UNIX_EPOCH};

    struct TestRoot(PathBuf);

    impl TestRoot {
        fn new(name: &str) -> Self {
            let unique = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("clock")
                .as_nanos();
            let path = std::env::temp_dir().join(format!(
                "vibespace-managed-cli-{name}-{}-{unique}",
                std::process::id()
            ));
            fs::create_dir_all(&path).expect("test root");
            Self(path)
        }

        fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for TestRoot {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn file_hash_preserves_exact_digest_across_buffer_boundaries() {
        let root = TestRoot::new("bounded-hash");
        let path = root.path().join("binary.dat");
        fs::write(&path, vec![0x5au8; 65_549]).expect("write fixture");
        assert_eq!(
            file_sha256(&path).as_deref(),
            Some("d1b05572612bce406fabf2977a4587e313cbd0db2251a5c815881b6396ca3721")
        );
        fs::write(&path, []).expect("empty fixture");
        assert_eq!(
            file_sha256(&path).as_deref(),
            Some("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855")
        );
        assert_eq!(file_sha256(&root.path().join("missing")), None);
        assert_eq!(file_sha256(root.path()), None);
    }

    #[test]
    fn parallel_closure_preserves_order_and_rejects_unreadable_files() {
        let root = TestRoot::new("parallel-closure");
        let mut files = Vec::new();
        for index in (0..70).rev() {
            let name = format!("file-{index:03}.txt");
            let path = root.path().join(&name);
            fs::write(&path, format!("payload-{index}")).expect("write fixture");
            files.push((name, path));
        }
        let expected = "f0fe7803474cd520153b4b3b1f75f27808027d41a238fcda3601f08665fa1a2b";
        assert_eq!(opencodex_closure_sha256(root.path()).as_deref(), Some(expected));
        fs::write(root.path().join("file-069.txt"), "changed").expect("mutate last file");
        assert_ne!(opencodex_closure_sha256(root.path()).as_deref(), Some(expected));
        files[35].1 = root.path().join("missing.txt");
        assert_eq!(closure_file_hashes(&files), None);
    }

    fn write_file(path: impl AsRef<Path>, bytes: &[u8]) {
        let path = path.as_ref();
        fs::create_dir_all(path.parent().expect("parent")).expect("create parent");
        fs::write(path, bytes).expect("write fixture");
    }

    fn sha256(bytes: &[u8]) -> String {
        format!("{:x}", Sha256::digest(bytes))
    }

    #[test]
    fn opencodex_closure_digest_covers_imported_js_native_modules_and_extras() {
        let root = TestRoot::new("closure-digest");
        let version_root = root.path().join("versions/2.36.0");
        let js = version_root.join("node_modules/zod/index.js");
        let native = version_root
            .join("node_modules/@napi-rs/keyring-win32-x64-msvc/keyring.win32-x64-msvc.node");
        write_file(&js, b"export const safe = true;");
        write_file(&native, b"MZsafe");
        let original = opencodex_closure_sha256(&version_root).expect("regular closure");

        write_file(&js, b"export const exfiltrate = true;");
        let js_mutated = opencodex_closure_sha256(&version_root).expect("mutated closure");
        assert_ne!(js_mutated, original);
        write_file(&js, b"export const safe = true;");
        write_file(&native, b"MZmutated");
        let native_mutated = opencodex_closure_sha256(&version_root).expect("mutated closure");
        assert_ne!(native_mutated, original);
        write_file(&native, b"MZsafe");
        write_file(
            version_root.join("node_modules/unreviewed/index.js"),
            b"extra",
        );
        assert_ne!(
            opencodex_closure_sha256(&version_root).expect("closure with extra"),
            original
        );

        let link = version_root.join("node_modules/unreviewed/link.js");
        #[cfg(windows)]
        if let Err(error) = std::os::windows::fs::symlink_file(&js, &link) {
            assert_eq!(error.raw_os_error(), Some(1314));
            return;
        }
        #[cfg(unix)]
        std::os::unix::fs::symlink(&js, &link).expect("fixture file symlink");
        assert_eq!(opencodex_closure_sha256(&version_root), None);
    }

    #[test]
    fn codex_requires_the_artifact_pinned_native_entrypoint() {
        let root = TestRoot::new("codex");
        let release =
            embedded_managed_release(ManagedCliKind::Codex, "windows", "x86_64").expect("release");

        assert_eq!(
            inspect_managed_runtime(root.path(), &release),
            ManagedCliReadiness::Missing
        );

        let version_root = root.path().join("versions").join(&release.version);
        write_file(version_root.join(&release.entrypoint), b"MZfixture");
        write_file(
            version_root.join("vibespace-runtime.json"),
            serde_json::to_string(&ManagedRuntimeReceipt::codex(
                &release,
                &sha256(b"MZfixture"),
            ))
            .unwrap()
            .as_bytes(),
        );

        assert!(matches!(
            inspect_managed_runtime(root.path(), &release),
            ManagedCliReadiness::Incomplete { .. }
        ));

        write_file(version_root.join(&release.entrypoint), b"MZreplaced");
        assert!(matches!(
            inspect_managed_runtime(root.path(), &release),
            ManagedCliReadiness::Incomplete { .. }
        ));
        write_file(
            version_root.join("vibespace-runtime.json"),
            serde_json::to_string(&ManagedRuntimeReceipt::codex(
                &release,
                &sha256(b"MZreplaced"),
            ))
            .unwrap()
            .as_bytes(),
        );
        assert!(matches!(
            inspect_managed_runtime(root.path(), &release),
            ManagedCliReadiness::Incomplete { .. }
        ));

        write_file(
            version_root.join("vibespace-runtime.json"),
            br#"{"schemaVersion":1,"kind":"codex","version":"9.9.9","artifactSha256":"9044e64402bf6a92774fe35a8cb86010d254c0d3390d5a7ee9047024588d7355","entrypoint":"package/vendor/x86_64-pc-windows-msvc/bin/codex.exe","entrypointSha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}"#,
        );
        assert!(matches!(
            inspect_managed_runtime(root.path(), &release),
            ManagedCliReadiness::Incomplete { .. }
        ));
    }

    #[test]
    fn raw_opencodex_tarball_is_not_misreported_as_runnable() {
        let root = TestRoot::new("opencodex-raw");
        let release = embedded_managed_release(ManagedCliKind::OpenCodex, "windows", "x86_64")
            .expect("release");
        let version_root = root.path().join("versions").join(&release.version);
        write_file(
            version_root.join(&release.entrypoint),
            b"#!/usr/bin/env node",
        );
        write_file(
            version_root.join("package/package.json"),
            br#"{"version":"2.36.0"}"#,
        );
        write_file(
            version_root.join("vibespace-runtime.json"),
            serde_json::to_string(&ManagedRuntimeReceipt::opencodex(
                &release,
                &sha256(b"#!/usr/bin/env node"),
                "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
                "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
            ))
            .unwrap()
            .as_bytes(),
        );

        assert!(matches!(
            inspect_managed_runtime(root.path(), &release),
            ManagedCliReadiness::Incomplete { .. }
        ));
    }

    #[test]
    fn opencodex_rejects_receipt_rewrites_and_probe_requires_loopback_truth() {
        let root = TestRoot::new("opencodex-complete");
        let release = embedded_managed_release(ManagedCliKind::OpenCodex, "windows", "x86_64")
            .expect("release");
        let version_root = root.path().join("versions").join(&release.version);
        for (path, bytes) in [
            (
                "node_modules/@bitkyc08/opencodex/bin/ocx.mjs",
                &b"#!/usr/bin/env node"[..],
            ),
            (
                "node_modules/@bitkyc08/opencodex/src/cli/index.ts",
                &b"console.log('fixture')"[..],
            ),
            (
                "node_modules/@bitkyc08/opencodex/package.json",
                &b"{\"version\":\"2.36.0\"}"[..],
            ),
            ("bun.lock", &b"{}"[..]),
            (
                "node_modules/bun/package.json",
                &b"{\"version\":\"1.4.0\"}"[..],
            ),
            (
                "node_modules/@oven/bun-windows-x64/bin/bun.exe",
                &b"MZfixture"[..],
            ),
            ("node_modules/@bufbuild/protobuf/package.json", &b"{}"[..]),
            (
                "node_modules/@modelcontextprotocol/sdk/package.json",
                &b"{}"[..],
            ),
            (
                "node_modules/@napi-rs/keyring/package.json",
                &b"{\"version\":\"1.3.0\"}"[..],
            ),
            (
                "node_modules/@napi-rs/keyring-win32-x64-msvc/package.json",
                &b"{\"version\":\"1.3.0\"}"[..],
            ),
            (
                "node_modules/@napi-rs/keyring-win32-x64-msvc/keyring.win32-x64-msvc.node",
                &b"MZfixture"[..],
            ),
            (
                "node_modules/@oven/bun-windows-x64/package.json",
                &b"{\"version\":\"1.4.0\"}"[..],
            ),
            (
                "node_modules/zod/package.json",
                &b"{\"version\":\"4.4.3\"}"[..],
            ),
        ] {
            write_file(version_root.join(path), bytes);
        }
        write_file(
            version_root.join("vibespace-runtime.json"),
            serde_json::to_string(&ManagedRuntimeReceipt::opencodex(
                &release,
                &sha256(b"#!/usr/bin/env node"),
                &sha256(b"{}"),
                &sha256(b"MZfixture"),
                &opencodex_closure_sha256(&version_root).unwrap(),
            ))
            .unwrap()
            .as_bytes(),
        );

        assert!(matches!(
            inspect_managed_runtime(root.path(), &release),
            ManagedCliReadiness::Incomplete { .. }
        ));

        let launch = super::ManagedCliLaunch {
            executable: version_root.join("node_modules/@oven/bun-windows-x64/bin/bun.exe"),
            arguments: vec![
                version_root
                    .join("node_modules/@bitkyc08/opencodex/src/cli/index.ts")
                    .to_string_lossy()
                    .into_owned(),
                "ready".to_string(),
                "--json".to_string(),
            ],
        };
        assert!(launch
            .executable
            .ends_with("node_modules/@oven/bun-windows-x64/bin/bun.exe"));
        assert_eq!(launch.arguments.last().map(String::as_str), Some("--json"));
        assert!(!launch
            .arguments
            .iter()
            .any(|argument| argument.ends_with("ocx.mjs")));
        let candidate = ManagedCliReadiness::ProbeRequired {
            launch,
            dependency_lock_sha256: super::OPENCODEX_DEPENDENCY_LOCK_SHA256.to_string(),
        };

        assert!(matches!(
            confirm_managed_runtime_probe(
                candidate.clone(),
                &release,
                &ManagedCliProbe {
                    kind: ManagedCliKind::OpenCodex,
                    version: release.version.clone(),
                    exit_code: 1,
                    ready: false,
                    loopback: true,
                }
            ),
            ManagedCliReadiness::Incomplete { .. }
        ));
        assert!(matches!(
            confirm_managed_runtime_probe(
                candidate,
                &release,
                &ManagedCliProbe {
                    kind: ManagedCliKind::OpenCodex,
                    version: release.version.clone(),
                    exit_code: 0,
                    ready: true,
                    loopback: true,
                }
            ),
            ManagedCliReadiness::Ready { .. }
        ));

        write_file(
            version_root.join("node_modules/@oven/bun-windows-x64/bin/bun.exe"),
            b"MZrewritten",
        );
        write_file(
            version_root.join("vibespace-runtime.json"),
            serde_json::to_string(&ManagedRuntimeReceipt::opencodex(
                &release,
                &sha256(b"#!/usr/bin/env node"),
                &sha256(b"{}"),
                &sha256(b"MZrewritten"),
                &opencodex_closure_sha256(&version_root).unwrap(),
            ))
            .unwrap()
            .as_bytes(),
        );
        assert!(matches!(
            inspect_managed_runtime(root.path(), &release),
            ManagedCliReadiness::Incomplete { .. }
        ));

        fs::remove_file(version_root.join("node_modules/@oven/bun-windows-x64/bin/bun.exe"))
            .unwrap();
        assert!(matches!(
            inspect_managed_runtime(root.path(), &release),
            ManagedCliReadiness::Incomplete { .. }
        ));
    }

    #[test]
    fn malformed_or_unpinned_closure_receipts_fail_closed() {
        let root = TestRoot::new("invalid-receipt");
        let release = embedded_managed_release(ManagedCliKind::OpenCodex, "windows", "x86_64")
            .expect("release");
        let version_root = root.path().join("versions").join(&release.version);
        write_file(version_root.join(&release.entrypoint), b"launcher");
        for invalid in [
            b"not json".as_slice(),
            br#"{"schemaVersion":2}"#.as_slice(),
            br#"{"schemaVersion":1,"kind":"opencodex","version":"2.36.0","artifactSha256":"95f2bab63125a94b5b53d5cc912a225812aed0a17b926cf556d6fc37651be915","entrypoint":"package/bin/ocx.mjs","dependencyLockSha256":"../../escape"}"#.as_slice(),
        ] {
            write_file(version_root.join("vibespace-runtime.json"), invalid);
            assert!(matches!(
                inspect_managed_runtime(root.path(), &release),
                ManagedCliReadiness::Incomplete { .. }
            ));
        }
    }
}

#[cfg(test)]
mod cao_codex_helper_tests {
    #[test]
    fn missing_or_modified_code_mode_host_cannot_be_ready() {
        let root = std::env::temp_dir().join(format!("cao-codex-helper-{}", nanoid::nanoid!(12)));
        std::fs::create_dir(&root).unwrap();
        assert_eq!(super::inspect_codex_code_mode_host(&root), Err(super::CODEX_CODE_MODE_HOST_MISSING));
        std::fs::write(root.join(super::CODEX_CODE_MODE_HOST), b"untrusted helper").unwrap();
        assert_eq!(super::inspect_codex_code_mode_host(&root), Err("Managed Codex code-mode helper integrity failed."));
        std::fs::remove_dir_all(root).unwrap();
    }
}
