use crate::harness::managed_bun_materializer::download_and_install_embedded_bun;
use crate::harness::managed_cli_lock::{
    embedded_opencodex_install_files, managed_bun_install_arguments,
};
use crate::harness::managed_cli_manifest::{embedded_managed_release, ManagedCliKind};
use crate::harness::managed_cli_runtime::{
    inspect_managed_runtime, is_rematerializable_legacy_opencodex,
    is_rematerializable_legacy_opencodex_version, opencodex_closure_sha256, ManagedCliReadiness,
    ManagedRuntimeReceipt,
};
use sha2::{Digest, Sha256};
use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;
use std::time::{Duration, Instant};

const INSTALL_TIMEOUT: Duration = Duration::from_secs(15 * 60);
const OPENCODEX_ENTRYPOINT: &str = "node_modules/@bitkyc08/opencodex/bin/ocx.mjs";
const OPENCODEX_BUN_EXECUTABLE: &str = "node_modules/@oven/bun-windows-x64/bin/bun.exe";
const INSTALL_ERROR_TAIL_BYTES: usize = 4096;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ManagedOpenCodexFailureKind {
    Cancelled,
    Bootstrap,
    Disk,
    Process,
    Integrity,
    Existing,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ManagedOpenCodexFailure {
    pub kind: ManagedOpenCodexFailureKind,
    pub message: &'static str,
}

struct CleanupPath(PathBuf);

impl CleanupPath {
    fn disarm(mut self) {
        self.0 = PathBuf::new();
    }
}

impl Drop for CleanupPath {
    fn drop(&mut self) {
        if !self.0.as_os_str().is_empty() {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
}

struct QuarantinedVersion {
    original: PathBuf,
    quarantine: PathBuf,
    promoted: bool,
    armed: bool,
}

impl QuarantinedVersion {
    fn move_aside(original: &Path) -> Result<Self, ManagedOpenCodexFailure> {
        let parent = original.parent().ok_or_else(|| {
            failure(
                ManagedOpenCodexFailureKind::Disk,
                "Managed OpenCodex version root is invalid.",
            )
        })?;
        let quarantine = parent.join(format!(".quarantine-{}", nanoid::nanoid!(20)));
        fs::rename(original, &quarantine).map_err(|_| {
            failure(
                ManagedOpenCodexFailureKind::Disk,
                "Managed OpenCodex legacy version could not be quarantined.",
            )
        })?;
        Ok(Self {
            original: original.to_path_buf(),
            quarantine,
            promoted: false,
            armed: true,
        })
    }

    fn mark_promoted(&mut self) {
        self.promoted = true;
    }

    fn move_validated_legacy(
        original: &Path,
        release: &crate::harness::managed_cli_manifest::ManagedCliRelease,
    ) -> Result<Self, ManagedOpenCodexFailure> {
        Self::move_validated_legacy_with_hook(original, release, |_| {})
    }

    fn move_validated_legacy_with_hook<F>(
        original: &Path,
        release: &crate::harness::managed_cli_manifest::ManagedCliRelease,
        before_move: F,
    ) -> Result<Self, ManagedOpenCodexFailure>
    where
        F: FnOnce(&Path),
    {
        if !is_rematerializable_legacy_opencodex_version(original, release) {
            return Err(failure(
                ManagedOpenCodexFailureKind::Existing,
                "Managed OpenCodex legacy version changed before upgrade.",
            ));
        }
        before_move(original);
        let quarantine = Self::move_aside(original)?;
        if !is_rematerializable_legacy_opencodex_version(&quarantine.quarantine, release) {
            return Err(failure(
                ManagedOpenCodexFailureKind::Existing,
                "Managed OpenCodex quarantined legacy version failed revalidation.",
            ));
        }
        Ok(quarantine)
    }

    fn commit(mut self) {
        self.armed = false;
        remove_owned_path(&self.quarantine);
    }

    fn commit_with<F>(&mut self, remove: F)
    where
        F: FnOnce(&Path) -> std::io::Result<()>,
    {
        self.armed = false;
        // The promoted v2 runtime has already passed its immutable closure inspection. Cleanup of
        // the old quarantine is best-effort and must never roll a verified canonical version back.
        let _ = remove(&self.quarantine);
    }

    fn rollback(&mut self) {
        self.rollback_with(
            |from, to| fs::rename(from, to),
            |path| fs::remove_dir_all(path),
        );
    }

    fn rollback_with<R, D>(&mut self, mut rename: R, mut remove: D)
    where
        R: FnMut(&Path, &Path) -> std::io::Result<()>,
        D: FnMut(&Path) -> std::io::Result<()>,
    {
        let failed = self
            .original
            .parent()
            .map(|parent| parent.join(format!(".failed-rollback-{}", nanoid::nanoid!(20))));
        let moved_failed = if self.promoted && self.original.exists() {
            failed
                .as_ref()
                .is_some_and(|failed| rename(&self.original, failed).is_ok())
        } else {
            true
        };
        if !moved_failed {
            return;
        }
        if rename(&self.quarantine, &self.original).is_ok() {
            if let Some(failed) = failed {
                let _ = remove(&failed);
            }
            self.armed = false;
        } else if let Some(failed) = failed {
            let _ = rename(&failed, &self.original);
        }
    }
}

fn remove_owned_path(path: &Path) {
    let Ok(metadata) = fs::symlink_metadata(path) else {
        return;
    };
    if metadata.file_type().is_symlink() {
        if fs::remove_dir(path).is_err() {
            let _ = fs::remove_file(path);
        }
    } else if metadata.is_dir() {
        let _ = fs::remove_dir_all(path);
    } else {
        let _ = fs::remove_file(path);
    }
}

impl Drop for QuarantinedVersion {
    fn drop(&mut self) {
        if !self.armed {
            return;
        }
        self.rollback();
    }
}

fn failure(kind: ManagedOpenCodexFailureKind, message: &'static str) -> ManagedOpenCodexFailure {
    ManagedOpenCodexFailure { kind, message }
}

fn ensure_regular_directory(path: &Path) -> Result<(), ManagedOpenCodexFailure> {
    fs::create_dir_all(path).map_err(|_| {
        failure(
            ManagedOpenCodexFailureKind::Disk,
            "Managed OpenCodex directory could not be created.",
        )
    })?;
    let metadata = fs::symlink_metadata(path).map_err(|_| {
        failure(
            ManagedOpenCodexFailureKind::Disk,
            "Managed OpenCodex directory could not be inspected.",
        )
    })?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(failure(
            ManagedOpenCodexFailureKind::Disk,
            "Managed OpenCodex directory is not a regular directory.",
        ));
    }
    Ok(())
}

fn bounded_stderr_tail<R: Read>(mut stderr: R) -> Vec<u8> {
    let mut tail = Vec::with_capacity(INSTALL_ERROR_TAIL_BYTES);
    let mut buffer = [0_u8; 1024];
    loop {
        match stderr.read(&mut buffer) {
            Ok(0) | Err(_) => break,
            Ok(read) => {
                if read >= INSTALL_ERROR_TAIL_BYTES {
                    tail.clear();
                    tail.extend_from_slice(&buffer[read - INSTALL_ERROR_TAIL_BYTES..read]);
                } else {
                    let excess = tail
                        .len()
                        .saturating_add(read)
                        .saturating_sub(INSTALL_ERROR_TAIL_BYTES);
                    if excess > 0 {
                        tail.drain(..excess);
                    }
                    tail.extend_from_slice(&buffer[..read]);
                }
            }
        }
    }
    tail
}

fn frozen_install_failure_message(stderr: &[u8]) -> &'static str {
    let diagnostic = String::from_utf8_lossy(stderr).to_ascii_lowercase();
    if diagnostic.contains("enospc")
        || diagnostic.contains("no space left")
        || diagnostic.contains("not enough space")
    {
        "OpenCodex install ran out of disk space; free space and retry."
    } else if diagnostic.contains("401") || diagnostic.contains("403") {
        "The package registry denied OpenCodex access; check proxy/auth settings and retry."
    } else if diagnostic.contains("429") {
        "The package registry is rate-limiting OpenCodex; wait briefly, then retry."
    } else if diagnostic.contains("404") {
        "The pinned OpenCodex package was not found; retry later or contact support."
    } else if ["500", "502", "503", "504"]
        .iter()
        .any(|status| diagnostic.contains(status))
    {
        "The package registry is temporarily unavailable; check registry.npmjs.org and retry."
    } else if diagnostic.contains("econnreset")
        || diagnostic.contains("etimedout")
        || diagnostic.contains("enotfound")
        || diagnostic.contains("fetch failed")
        || diagnostic.contains("network")
    {
        "OpenCodex package download failed; check registry.npmjs.org and proxy access, then retry."
    } else {
        "OpenCodex frozen install failed; check registry.npmjs.org access and free disk space, then retry."
    }
}

fn write_new_file(path: &Path, bytes: &[u8]) -> Result<(), ManagedOpenCodexFailure> {
    let mut output = File::options()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(|_| {
            failure(
                ManagedOpenCodexFailureKind::Disk,
                "Managed OpenCodex install file could not be created.",
            )
        })?;
    output.write_all(bytes).map_err(|_| {
        failure(
            ManagedOpenCodexFailureKind::Disk,
            "Managed OpenCodex install file could not be written.",
        )
    })?;
    output.sync_all().map_err(|_| {
        failure(
            ManagedOpenCodexFailureKind::Disk,
            "Managed OpenCodex install file could not be finalized.",
        )
    })?;
    Ok(())
}

fn canonical_lf_bytes(value: &str) -> Vec<u8> {
    value.replace("\r\n", "\n").replace('\r', "\n").into_bytes()
}

fn regular_file_within(root: &Path, relative_path: &str) -> Option<PathBuf> {
    let canonical_root = fs::canonicalize(root).ok()?;
    let candidate = root.join(relative_path);
    let metadata = fs::symlink_metadata(&candidate).ok()?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return None;
    }
    fs::canonicalize(&candidate)
        .ok()?
        .starts_with(&canonical_root)
        .then_some(candidate)
}

fn file_sha256(path: &Path) -> Result<String, ManagedOpenCodexFailure> {
    let bytes = fs::read(path).map_err(|_| {
        failure(
            ManagedOpenCodexFailureKind::Disk,
            "Managed OpenCodex installed file could not be read.",
        )
    })?;
    Ok(format!("{:x}", Sha256::digest(bytes)))
}

fn remove_staging_cache(staging: &Path) -> Result<(), ManagedOpenCodexFailure> {
    let cache = staging.join(".bun-cache");
    if !cache.exists() {
        return Ok(());
    }
    let staging_root = fs::canonicalize(staging).map_err(|_| {
        failure(
            ManagedOpenCodexFailureKind::Integrity,
            "Managed OpenCodex staging root is unsafe.",
        )
    })?;
    let metadata = fs::symlink_metadata(&cache).map_err(|_| {
        failure(
            ManagedOpenCodexFailureKind::Integrity,
            "Managed OpenCodex staging cache is unsafe.",
        )
    })?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(failure(
            ManagedOpenCodexFailureKind::Integrity,
            "Managed OpenCodex staging cache is unsafe.",
        ));
    }
    let canonical_cache = fs::canonicalize(&cache).map_err(|_| {
        failure(
            ManagedOpenCodexFailureKind::Integrity,
            "Managed OpenCodex staging cache is unsafe.",
        )
    })?;
    if canonical_cache.parent() != Some(staging_root.as_path())
        || canonical_cache.file_name().and_then(|name| name.to_str()) != Some(".bun-cache")
    {
        return Err(failure(
            ManagedOpenCodexFailureKind::Integrity,
            "Managed OpenCodex staging cache escaped its owned root.",
        ));
    }
    fs::remove_dir_all(&canonical_cache).map_err(|_| {
        failure(
            ManagedOpenCodexFailureKind::Disk,
            "Managed OpenCodex staging cache could not be removed.",
        )
    })
}

fn run_frozen_install(
    bun_executable: &Path,
    staging: &Path,
    cancellation: &AtomicBool,
) -> Result<(), ManagedOpenCodexFailure> {
    let cache = staging.join(".bun-cache");
    let mut child = Command::new(bun_executable)
        .args(managed_bun_install_arguments(staging))
        .current_dir(staging)
        .env("BUN_INSTALL_CACHE_DIR", &cache)
        .env("NO_UPDATE_NOTIFIER", "1")
        .env_remove("BUN_CONFIG_REGISTRY")
        .env_remove("NPM_CONFIG_USERCONFIG")
        .env_remove("npm_config_userconfig")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|_| {
            failure(
                ManagedOpenCodexFailureKind::Process,
                "Managed OpenCodex frozen install could not start.",
            )
        })?;
    let Some(stderr) = child.stderr.take() else {
        let _ = child.kill();
        let _ = child.wait();
        return Err(failure(
            ManagedOpenCodexFailureKind::Process,
            "Managed OpenCodex install diagnostics could not be read.",
        ));
    };
    let stderr_reader = thread::spawn(move || bounded_stderr_tail(stderr));
    let started = Instant::now();
    let status = loop {
        if cancellation.load(Ordering::Acquire) {
            let _ = child.kill();
            let _ = child.wait();
            let _ = stderr_reader.join();
            return Err(failure(
                ManagedOpenCodexFailureKind::Cancelled,
                "Managed OpenCodex installation was cancelled.",
            ));
        }
        if started.elapsed() >= INSTALL_TIMEOUT {
            let _ = child.kill();
            let _ = child.wait();
            let _ = stderr_reader.join();
            return Err(failure(
                ManagedOpenCodexFailureKind::Process,
                "Managed OpenCodex frozen install timed out.",
            ));
        }
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => thread::sleep(Duration::from_millis(50)),
            Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                let _ = stderr_reader.join();
                return Err(failure(
                    ManagedOpenCodexFailureKind::Process,
                    "Managed OpenCodex frozen install could not be observed.",
                ));
            }
        }
    };
    let diagnostics = stderr_reader.join().unwrap_or_default();
    if !status.success() {
        return Err(failure(
            ManagedOpenCodexFailureKind::Process,
            frozen_install_failure_message(&diagnostics),
        ));
    }
    remove_staging_cache(staging)?;
    Ok(())
}

pub fn download_and_install_embedded_opencodex<F>(
    managed_base: &Path,
    cancellation: &AtomicBool,
    mut on_progress: F,
) -> Result<ManagedCliReadiness, ManagedOpenCodexFailure>
where
    F: FnMut(f64),
{
    if cancellation.load(Ordering::Acquire) {
        return Err(failure(
            ManagedOpenCodexFailureKind::Cancelled,
            "Managed OpenCodex installation was cancelled.",
        ));
    }
    let release = embedded_managed_release(ManagedCliKind::OpenCodex, "windows", "x86_64")
        .map_err(|_| {
            failure(
                ManagedOpenCodexFailureKind::Integrity,
                "Managed OpenCodex release manifest is unavailable.",
            )
        })?;
    let files = embedded_opencodex_install_files().map_err(|_| {
        failure(
            ManagedOpenCodexFailureKind::Integrity,
            "Managed OpenCodex dependency authority is unavailable.",
        )
    })?;
    if files.dependency_lock.opencodex_version != release.version
        || files.dependency_lock.bun_version != "1.4.0"
        || files.dependency_lock.runs_dependency_scripts
    {
        return Err(failure(
            ManagedOpenCodexFailureKind::Integrity,
            "Managed OpenCodex release and dependency authority do not match.",
        ));
    }

    let opencodex_root = managed_base.join("opencodex");
    let mut legacy_upgrade = false;
    let repair_incomplete = match inspect_managed_runtime(&opencodex_root, &release) {
        ready @ ManagedCliReadiness::Ready { .. }
        | ready @ ManagedCliReadiness::ProbeRequired { .. } => return Ok(ready),
        ManagedCliReadiness::Incomplete { .. } => {
            legacy_upgrade = is_rematerializable_legacy_opencodex(&opencodex_root, &release);
            true
        }
        ManagedCliReadiness::Missing => false,
    };

    let bun =
        download_and_install_embedded_bun(&managed_base.join("bun"), cancellation, |progress| {
            on_progress(progress * 0.45)
        })
        .map_err(|error| failure(ManagedOpenCodexFailureKind::Bootstrap, error.message))?;
    if bun.version != files.dependency_lock.bun_version {
        return Err(failure(
            ManagedOpenCodexFailureKind::Integrity,
            "Managed OpenCodex Bun bootstrap version does not match.",
        ));
    }
    on_progress(0.5);

    let versions_root = opencodex_root.join("versions");
    ensure_regular_directory(&versions_root)?;
    let destination = versions_root.join(&release.version);
    let staging = versions_root.join(format!(".staging-{}", nanoid::nanoid!(20)));
    fs::create_dir(&staging).map_err(|_| {
        failure(
            ManagedOpenCodexFailureKind::Disk,
            "Managed OpenCodex staging directory could not be created.",
        )
    })?;
    let cleanup = CleanupPath(staging.clone());
    write_new_file(
        &staging.join("package.json"),
        &canonical_lf_bytes(files.package_json),
    )?;
    write_new_file(
        &staging.join("bun.lock"),
        &canonical_lf_bytes(files.bun_lock),
    )?;
    write_new_file(
        &staging.join("bunfig.toml"),
        &canonical_lf_bytes(files.bunfig),
    )?;
    run_frozen_install(&bun.executable, &staging, cancellation)?;
    on_progress(0.9);

    let entrypoint = regular_file_within(&staging, OPENCODEX_ENTRYPOINT).ok_or_else(|| {
        failure(
            ManagedOpenCodexFailureKind::Integrity,
            "Managed OpenCodex entrypoint is unavailable after install.",
        )
    })?;
    let runtime_executable =
        regular_file_within(&staging, OPENCODEX_BUN_EXECUTABLE).ok_or_else(|| {
            failure(
                ManagedOpenCodexFailureKind::Integrity,
                "Managed OpenCodex Bun runtime is unavailable after install.",
            )
        })?;
    let lock_path = regular_file_within(&staging, "bun.lock").ok_or_else(|| {
        failure(
            ManagedOpenCodexFailureKind::Integrity,
            "Managed OpenCodex lock is unavailable after install.",
        )
    })?;
    let closure_sha256 = opencodex_closure_sha256(&staging).ok_or_else(|| {
        failure(
            ManagedOpenCodexFailureKind::Integrity,
            "Managed OpenCodex executable closure could not be attested.",
        )
    })?;
    #[cfg(test)]
    eprintln!("AUDITED_OPENCODEX_CLOSURE_SHA256={closure_sha256}");
    if release.closure_sha256.as_deref() != Some(closure_sha256.as_str()) {
        return Err(failure(
            ManagedOpenCodexFailureKind::Integrity,
            "Managed OpenCodex closure does not match the embedded release authority.",
        ));
    }
    let receipt = ManagedRuntimeReceipt::opencodex(
        &release,
        &file_sha256(&entrypoint)?,
        &file_sha256(&lock_path)?,
        &file_sha256(&runtime_executable)?,
        &closure_sha256,
    );
    let receipt_bytes = serde_json::to_vec_pretty(&receipt).map_err(|_| {
        failure(
            ManagedOpenCodexFailureKind::Disk,
            "Managed OpenCodex receipt could not be serialized.",
        )
    })?;
    write_new_file(&staging.join("vibespace-runtime.json"), &receipt_bytes)?;
    if cancellation.load(Ordering::Acquire) {
        return Err(failure(
            ManagedOpenCodexFailureKind::Cancelled,
            "Managed OpenCodex installation was cancelled.",
        ));
    }
    let mut quarantine = if repair_incomplete {
        match inspect_managed_runtime(&opencodex_root, &release) {
            ManagedCliReadiness::Incomplete { .. } => {
                if legacy_upgrade {
                    Some(QuarantinedVersion::move_validated_legacy(
                        &destination,
                        &release,
                    )?)
                } else {
                    match fs::symlink_metadata(&destination) {
                        Ok(_) => Some(QuarantinedVersion::move_aside(&destination)?),
                        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
                        Err(_) => {
                            return Err(failure(
                                ManagedOpenCodexFailureKind::Disk,
                                "Incomplete managed OpenCodex version could not be inspected for repair.",
                            ));
                        }
                    }
                }
            }
            ManagedCliReadiness::Missing => None,
            ManagedCliReadiness::Ready { .. } | ManagedCliReadiness::ProbeRequired { .. } => {
                return Err(failure(
                    ManagedOpenCodexFailureKind::Existing,
                    "Managed OpenCodex changed while retrying; refresh readiness and retry.",
                ));
            }
        }
    } else {
        None
    };
    if fs::symlink_metadata(&destination).is_ok() {
        return Err(failure(
            ManagedOpenCodexFailureKind::Existing,
            "Managed OpenCodex version appeared during installation; refresh readiness and retry.",
        ));
    }
    fs::rename(&staging, &destination).map_err(|_| {
        failure(
            ManagedOpenCodexFailureKind::Disk,
            "Managed OpenCodex version could not be promoted.",
        )
    })?;
    if let Some(quarantine) = quarantine.as_mut() {
        quarantine.mark_promoted();
    }
    cleanup.disarm();
    let mut promoted_cleanup = quarantine
        .is_none()
        .then(|| CleanupPath(destination.clone()));
    match inspect_managed_runtime(&opencodex_root, &release) {
        readiness @ ManagedCliReadiness::ProbeRequired { .. } => {
            if let Some(quarantine) = quarantine {
                quarantine.commit();
            }
            if let Some(cleanup) = promoted_cleanup.take() {
                cleanup.disarm();
            }
            on_progress(1.0);
            Ok(readiness)
        }
        _ => Err(failure(
            ManagedOpenCodexFailureKind::Integrity,
            "Managed OpenCodex verification failed after installation.",
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::{
        canonical_lf_bytes, download_and_install_embedded_opencodex,
        frozen_install_failure_message, remove_staging_cache, QuarantinedVersion,
    };
    use crate::harness::managed_cli_runtime::ManagedCliReadiness;
    use std::fs;
    use std::path::PathBuf;
    use std::process::Command;
    use std::sync::atomic::AtomicU64;
    use std::sync::atomic::{AtomicBool, Ordering};

    fn temp_dir(name: &str) -> PathBuf {
        static SEQUENCE: AtomicU64 = AtomicU64::new(0);
        std::env::temp_dir().join(format!(
            "vibespace-managed-opencodex-{name}-{}-{}",
            std::process::id(),
            SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ))
    }

    #[test]
    fn cancellation_before_bootstrap_never_creates_a_version() {
        let fixture = temp_dir("cancelled");
        let cancellation = AtomicBool::new(true);
        assert!(download_and_install_embedded_opencodex(&fixture, &cancellation, |_| {}).is_err());
        assert!(!fixture.join("opencodex/versions/2.36.0").exists());
    }

    #[test]
    fn package_failure_messages_are_actionable_without_exposing_raw_diagnostics() {
        assert!(
            frozen_install_failure_message(b"error: fetch failed ECONNRESET")
                .contains("registry.npmjs.org")
        );
        assert!(frozen_install_failure_message(b"HTTP 503").contains("registry.npmjs.org"));
        assert!(
            frozen_install_failure_message(b"ENOSPC: no space left on device")
                .contains("disk space")
        );
    }

    #[test]
    fn legacy_quarantine_rolls_back_failed_replacement_atomically() {
        let fixture = temp_dir("legacy-rollback");
        let destination = fixture.join("opencodex/versions/2.36.0");
        fs::create_dir_all(&destination).unwrap();
        fs::write(destination.join("legacy.marker"), b"v1").unwrap();

        let mut quarantine = QuarantinedVersion::move_aside(&destination).unwrap();
        fs::create_dir_all(&destination).unwrap();
        fs::write(destination.join("partial.marker"), b"v2-partial").unwrap();
        quarantine.mark_promoted();
        drop(quarantine);

        assert_eq!(fs::read(destination.join("legacy.marker")).unwrap(), b"v1");
        assert!(!destination.join("partial.marker").exists());
        fs::remove_dir_all(fixture).unwrap();
    }

    #[test]
    fn legacy_quarantine_commit_keeps_verified_replacement() {
        let fixture = temp_dir("legacy-commit");
        let destination = fixture.join("opencodex/versions/2.36.0");
        fs::create_dir_all(&destination).unwrap();
        fs::write(destination.join("legacy.marker"), b"v1").unwrap();

        let quarantine = QuarantinedVersion::move_aside(&destination).unwrap();
        fs::create_dir_all(&destination).unwrap();
        fs::write(destination.join("verified.marker"), b"v2").unwrap();
        quarantine.commit();

        assert_eq!(
            fs::read(destination.join("verified.marker")).unwrap(),
            b"v2"
        );
        assert!(!destination.join("legacy.marker").exists());
        fs::remove_dir_all(fixture).unwrap();
    }

    #[test]
    fn partial_legacy_cleanup_never_replaces_verified_canonical_version() {
        let fixture = temp_dir("legacy-cleanup-failure");
        let destination = fixture.join("opencodex/versions/2.36.0");
        fs::create_dir_all(&destination).unwrap();
        fs::write(destination.join("legacy.marker"), b"v1").unwrap();

        let mut quarantine = QuarantinedVersion::move_aside(&destination).unwrap();
        fs::create_dir_all(&destination).unwrap();
        fs::write(destination.join("verified.marker"), b"v2").unwrap();
        let quarantine_path = quarantine.quarantine.clone();
        quarantine.commit_with(|old| {
            fs::remove_file(old.join("legacy.marker"))?;
            Err(std::io::Error::other("injected partial cleanup failure"))
        });
        drop(quarantine);

        assert_eq!(
            fs::read(destination.join("verified.marker")).unwrap(),
            b"v2"
        );
        assert!(!destination.join("legacy.marker").exists());
        assert!(quarantine_path.exists());
        fs::remove_dir_all(fixture).unwrap();
    }

    #[test]
    fn rollback_never_deletes_replacement_when_move_aside_is_blocked() {
        let fixture = temp_dir("rollback-move-blocked");
        let destination = fixture.join("opencodex/versions/2.36.0");
        fs::create_dir_all(&destination).unwrap();
        fs::write(destination.join("legacy.marker"), b"v1").unwrap();
        let mut quarantine = QuarantinedVersion::move_aside(&destination).unwrap();
        fs::create_dir_all(&destination).unwrap();
        fs::write(destination.join("replacement.marker"), b"v2-partial").unwrap();
        quarantine.mark_promoted();
        let original = destination.clone();

        quarantine.rollback_with(
            |from, to| {
                if from == original {
                    Err(std::io::Error::other("injected replacement move failure"))
                } else {
                    fs::rename(from, to)
                }
            },
            |path| fs::remove_dir_all(path),
        );

        assert_eq!(
            fs::read(destination.join("replacement.marker")).unwrap(),
            b"v2-partial"
        );
        assert_eq!(
            fs::read(quarantine.quarantine.join("legacy.marker")).unwrap(),
            b"v1"
        );
        quarantine.armed = false;
        fs::remove_dir_all(fixture).unwrap();
    }

    #[test]
    fn staging_cache_cleanup_is_exact_and_absent_from_promotable_closure() {
        let fixture = temp_dir("cache-cleanup");
        let staging = fixture.join("staging");
        fs::create_dir_all(staging.join(".bun-cache/nondeterministic")).unwrap();
        fs::write(
            staging.join(".bun-cache/nondeterministic/metadata"),
            b"cache",
        )
        .unwrap();
        fs::write(staging.join("owned-file"), b"closure").unwrap();

        remove_staging_cache(&staging).unwrap();

        assert!(!staging.join(".bun-cache").exists());
        assert_eq!(fs::read(staging.join("owned-file")).unwrap(), b"closure");
        fs::remove_dir_all(fixture).unwrap();
    }

    #[test]
    fn embedded_install_control_files_are_canonical_lf_on_every_checkout() {
        for (lf, crlf) in [
            (
                "{\n  \"private\": true\n}\n",
                "{\r\n  \"private\": true\r\n}\r\n",
            ),
            ("[install]\nvalue = true\n", "[install]\r\nvalue = true\r\n"),
            (
                "{\n  \"lockfileVersion\": 2\n}\n",
                "{\r\n  \"lockfileVersion\": 2\r\n}\r\n",
            ),
        ] {
            assert_eq!(canonical_lf_bytes(lf), canonical_lf_bytes(crlf));
            assert!(!canonical_lf_bytes(crlf).contains(&b'\r'));
        }
    }

    #[test]
    #[ignore = "downloads and installs the exact pinned Bun/OpenCodex closure"]
    fn audited_official_closure_materializes_to_probe_required() {
        let fixture = temp_dir("official");
        let readiness =
            download_and_install_embedded_opencodex(&fixture, &AtomicBool::new(false), |_| {})
                .expect("managed OpenCodex install");
        let ManagedCliReadiness::ProbeRequired { launch, .. } = readiness else {
            panic!("managed OpenCodex must require its bounded loopback probe");
        };
        eprintln!(
            "AUDITED_OPENCODEX_CLOSURE_SHA256={}",
            crate::harness::managed_cli_runtime::opencodex_closure_sha256(
                &fixture.join("opencodex/versions/2.36.0")
            )
            .expect("audited closure digest")
        );
        assert!(launch
            .executable
            .ends_with("node_modules/@oven/bun-windows-x64/bin/bun.exe"));
        assert!(!fixture
            .join("opencodex/versions/2.36.0/.bun-cache")
            .exists());
        assert_eq!(launch.arguments.last().map(String::as_str), Some("--json"));
        let output = Command::new(&launch.executable)
            .args(&launch.arguments)
            .output()
            .expect("bounded ready probe launch");
        assert_eq!(output.status.code(), Some(1));
        let status: serde_json::Value = serde_json::from_slice(&output.stdout).expect("ready JSON");
        assert_eq!(
            status.get("ready").and_then(|value| value.as_bool()),
            Some(false)
        );
        assert_eq!(
            status.get("status").and_then(|value| value.as_str()),
            Some("unreachable")
        );
        let receipt_path = fixture.join("opencodex/versions/2.36.0/vibespace-runtime.json");
        let mut legacy_receipt: serde_json::Value =
            serde_json::from_slice(&fs::read(&receipt_path).unwrap()).unwrap();
        legacy_receipt["schemaVersion"] = serde_json::json!(1);
        legacy_receipt
            .as_object_mut()
            .unwrap()
            .remove("closureSha256");
        fs::write(
            &receipt_path,
            serde_json::to_vec_pretty(&legacy_receipt).unwrap(),
        )
        .unwrap();
        let release = crate::harness::managed_cli_manifest::embedded_managed_release(
            crate::harness::managed_cli_manifest::ManagedCliKind::OpenCodex,
            "windows",
            "x86_64",
        )
        .unwrap();
        assert!(
            crate::harness::managed_cli_runtime::is_rematerializable_legacy_opencodex(
                &fixture.join("opencodex"),
                &release
            )
        );
        let replacement_receipt = fs::read(&receipt_path).unwrap();
        let raced = QuarantinedVersion::move_validated_legacy_with_hook(
            &fixture.join("opencodex/versions/2.36.0"),
            &release,
            |version_root| {
                let receipt_path = version_root.join("vibespace-runtime.json");
                let mut changed: serde_json::Value =
                    serde_json::from_slice(&fs::read(&receipt_path).unwrap()).unwrap();
                changed["schemaVersion"] = serde_json::json!(2);
                changed["closureSha256"] = serde_json::json!(
                    "5beb85ce68247893766641c801390dfbacf1cb77bdab5c2a95ed88f44b52e37c"
                );
                fs::write(&receipt_path, serde_json::to_vec_pretty(&changed).unwrap()).unwrap();
            },
        );
        assert!(raced.is_err());
        assert_ne!(fs::read(&receipt_path).unwrap(), replacement_receipt);
        assert!(fixture.join("opencodex/versions/2.36.0").is_dir());
        fs::remove_dir_all(fixture).unwrap();
    }
}
