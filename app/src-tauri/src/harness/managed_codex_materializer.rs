use crate::harness::download::{
    extract_verified_archive, request_failure_detail, stream_verified_download, DownloadFailure,
    DownloadFailureKind,
};
use crate::harness::managed_cli_manifest::{embedded_managed_release, ManagedCliKind};
use crate::harness::managed_cli_runtime::{
    inspect_codex_code_mode_host, inspect_managed_runtime, ManagedCliReadiness,
    ManagedRuntimeReceipt, CODEX_CODE_MODE_HOST, CODEX_CODE_MODE_HOST_MISSING,
    CODEX_CODE_MODE_HOST_SHA256,
};
use crate::harness::manifest::OpenCodeRelease;
use sha2::{Digest, Sha256};
use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

const CODEX_COMMAND_RUNNER: &str = "codex-command-runner.exe";
const CODEX_COMMAND_RUNNER_SHA256: &str =
    "5a84820fc507e5e3c8689047434259d96197730e92d88e6a915b0da97c758da6";
const CODEX_SANDBOX_SETUP: &str = "codex-windows-sandbox-setup.exe";
const CODEX_SANDBOX_SETUP_SHA256: &str =
    "46b9f3adb62ea6030ea026647b6a29f10566bff7307ca76d10f3a1c1189bd6e9";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ManagedCodexFailureKind {
    Cancelled,
    Network,
    Disk,
    Size,
    Hash,
    Archive,
    Integrity,
    Existing,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ManagedCodexFailure {
    pub kind: ManagedCodexFailureKind,
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
        if self.0.as_os_str().is_empty() {
            return;
        }
        let _ = if self.0.is_dir() {
            fs::remove_dir_all(&self.0)
        } else {
            fs::remove_file(&self.0)
        };
    }
}

struct QuarantinedVersion {
    original: PathBuf,
    quarantine: PathBuf,
    promoted: bool,
    armed: bool,
}

impl QuarantinedVersion {
    fn move_incomplete(
        original: &Path,
        managed_root: &Path,
        release: &crate::harness::managed_cli_manifest::ManagedCliRelease,
    ) -> Result<Option<Self>, ManagedCodexFailure> {
        match inspect_managed_runtime(managed_root, release) {
            ManagedCliReadiness::Incomplete { .. } => {}
            ManagedCliReadiness::Missing => return Ok(None),
            ManagedCliReadiness::Ready { .. } | ManagedCliReadiness::ProbeRequired { .. } => {
                return Err(failure(
                    ManagedCodexFailureKind::Existing,
                    "Managed Codex changed while retrying; check readiness and retry.",
                ));
            }
        }
        match fs::symlink_metadata(original) {
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(_) => {
                return Err(failure(
                    ManagedCodexFailureKind::Disk,
                    "Incomplete managed Codex version could not be inspected for repair.",
                ));
            }
        }
        let parent = original.parent().ok_or_else(|| {
            failure(
                ManagedCodexFailureKind::Disk,
                "Managed Codex version path is invalid.",
            )
        })?;
        let quarantine = parent.join(format!(".quarantine-{}", nanoid::nanoid!(20)));
        fs::rename(original, &quarantine).map_err(|_| {
            failure(
                ManagedCodexFailureKind::Disk,
                "Incomplete managed Codex version could not be preserved for retry.",
            )
        })?;
        Ok(Some(Self {
            original: original.to_path_buf(),
            quarantine,
            promoted: false,
            armed: true,
        }))
    }

    fn mark_promoted(&mut self) {
        self.promoted = true;
    }

    fn commit(mut self) {
        self.armed = false;
        remove_owned_path(&self.quarantine);
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
        if self.promoted && fs::symlink_metadata(&self.original).is_ok() {
            let failed = self
                .original
                .parent()
                .map(|parent| parent.join(format!(".failed-rollback-{}", nanoid::nanoid!(20))));
            if let Some(failed) = failed {
                if fs::rename(&self.original, &failed).is_ok() {
                    remove_owned_path(&failed);
                } else {
                    return;
                }
            }
        }
        if fs::symlink_metadata(&self.original).is_err()
            && fs::rename(&self.quarantine, &self.original).is_ok()
        {
            self.armed = false;
        }
    }
}

fn failure(kind: ManagedCodexFailureKind, message: &'static str) -> ManagedCodexFailure {
    ManagedCodexFailure { kind, message }
}

fn map_download_failure(download: DownloadFailure) -> ManagedCodexFailure {
    let kind = match download.kind {
        DownloadFailureKind::Cancelled => ManagedCodexFailureKind::Cancelled,
        DownloadFailureKind::Network => ManagedCodexFailureKind::Network,
        DownloadFailureKind::Disk => ManagedCodexFailureKind::Disk,
        DownloadFailureKind::Size => ManagedCodexFailureKind::Size,
        DownloadFailureKind::Hash => ManagedCodexFailureKind::Hash,
        DownloadFailureKind::Archive => ManagedCodexFailureKind::Archive,
    };
    ManagedCodexFailure {
        kind,
        message: download.message,
    }
}

fn ensure_regular_directory(path: &Path) -> Result<(), ManagedCodexFailure> {
    fs::create_dir_all(path).map_err(|_| {
        failure(
            ManagedCodexFailureKind::Disk,
            "Managed Codex directory could not be created.",
        )
    })?;
    let metadata = fs::symlink_metadata(path).map_err(|_| {
        failure(
            ManagedCodexFailureKind::Disk,
            "Managed Codex directory could not be inspected.",
        )
    })?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(failure(
            ManagedCodexFailureKind::Disk,
            "Managed Codex directory is not a regular directory.",
        ));
    }
    Ok(())
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

fn file_sha256(path: &Path) -> Result<String, ManagedCodexFailure> {
    let mut input = File::open(path).map_err(|_| {
        failure(
            ManagedCodexFailureKind::Disk,
            "Managed Codex installed file could not be opened.",
        )
    })?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = input.read(&mut buffer).map_err(|_| {
            failure(
                ManagedCodexFailureKind::Disk,
                "Managed Codex installed file could not be read.",
            )
        })?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

fn write_receipt(
    staging: &Path,
    release: &crate::harness::managed_cli_manifest::ManagedCliRelease,
) -> Result<(), ManagedCodexFailure> {
    let executable = regular_file_within(staging, &release.entrypoint).ok_or_else(|| {
        failure(
            ManagedCodexFailureKind::Integrity,
            "Managed Codex executable is unavailable after extraction.",
        )
    })?;
    for (path, expected_sha256) in [
        (CODEX_COMMAND_RUNNER, CODEX_COMMAND_RUNNER_SHA256),
        (CODEX_SANDBOX_SETUP, CODEX_SANDBOX_SETUP_SHA256),
    ] {
        let helper = regular_file_within(staging, path).ok_or_else(|| {
            failure(
                ManagedCodexFailureKind::Integrity,
                "Managed Codex sandbox helper is unavailable.",
            )
        })?;
        if file_sha256(&helper)? != expected_sha256 {
            return Err(failure(
                ManagedCodexFailureKind::Integrity,
                "Managed Codex sandbox helper integrity failed.",
            ));
        }
    }
    let receipt = ManagedRuntimeReceipt::codex(release, &file_sha256(&executable)?);
    let bytes = serde_json::to_vec_pretty(&receipt).map_err(|_| {
        failure(
            ManagedCodexFailureKind::Disk,
            "Managed Codex receipt could not be serialized.",
        )
    })?;
    let mut output = File::options()
        .write(true)
        .create_new(true)
        .open(staging.join("vibespace-runtime.json"))
        .map_err(|_| {
            failure(
                ManagedCodexFailureKind::Disk,
                "Managed Codex receipt could not be created.",
            )
        })?;
    output.write_all(&bytes).map_err(|_| {
        failure(
            ManagedCodexFailureKind::Disk,
            "Managed Codex receipt could not be written.",
        )
    })?;
    output.sync_all().map_err(|_| {
        failure(
            ManagedCodexFailureKind::Disk,
            "Managed Codex receipt could not be finalized.",
        )
    })?;
    Ok(())
}

/// Materialize only the missing, pinned companion. Existing bytes are never replaced.
fn install_code_mode_host<F>(
    root: &Path,
    cancellation: &AtomicBool,
    mut on_progress: F,
) -> Result<(), ManagedCodexFailure>
where
    F: FnMut(f64),
{
    match inspect_codex_code_mode_host(root) {
        Ok(()) => return Ok(()),
        Err(CODEX_CODE_MODE_HOST_MISSING) => {}
        Err(reason) => return Err(failure(ManagedCodexFailureKind::Integrity, reason)),
    }
    if cancellation.load(Ordering::Acquire) {
        return Err(failure(
            ManagedCodexFailureKind::Cancelled,
            "Managed Codex installation was cancelled.",
        ));
    }
    ensure_regular_directory(root)?;
    let temporary = root.join(format!(".code-mode-{}.download", nanoid::nanoid!(20)));
    let _cleanup = CleanupPath(temporary.clone());
    let mut output = File::options()
        .write(true)
        .create_new(true)
        .open(&temporary)
        .map_err(|_| {
            failure(
                ManagedCodexFailureKind::Disk,
                "Managed Codex helper staging failed.",
            )
        })?;
    let response = reqwest::blocking::Client::builder().connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(15 * 60)).build()
        .and_then(|client| client.get("https://github.com/openai/codex/releases/download/rust-v0.151.0/codex-code-mode-host-x86_64-pc-windows-msvc.exe").send())
        .and_then(reqwest::blocking::Response::error_for_status)
        .map_err(|error| failure(ManagedCodexFailureKind::Network, request_failure_detail(error.status().map(|status| status.as_u16()), error.is_timeout(), error.is_connect(), error.is_body())))?;
    stream_verified_download(
        response,
        &mut output,
        72_271_664,
        CODEX_CODE_MODE_HOST_SHA256,
        cancellation,
        |progress| on_progress(progress),
    )
    .map_err(map_download_failure)?;
    output.sync_all().map_err(|_| {
        failure(
            ManagedCodexFailureKind::Disk,
            "Managed Codex helper finalization failed.",
        )
    })?;
    drop(output);
    if cancellation.load(Ordering::Acquire) {
        return Err(failure(
            ManagedCodexFailureKind::Cancelled,
            "Managed Codex installation was cancelled.",
        ));
    }
    // Hard-link promotion is atomic and cannot overwrite a concurrently created target.
    fs::hard_link(&temporary, root.join(CODEX_CODE_MODE_HOST)).map_err(|_| {
        failure(
            ManagedCodexFailureKind::Existing,
            "Managed Codex helper promotion failed.",
        )
    })?;
    inspect_codex_code_mode_host(root)
        .map_err(|reason| failure(ManagedCodexFailureKind::Integrity, reason))
}

pub fn download_and_install_embedded_codex<F>(
    managed_base: &Path,
    cancellation: &AtomicBool,
    mut on_progress: F,
) -> Result<ManagedCliReadiness, ManagedCodexFailure>
where
    F: FnMut(f64),
{
    if cancellation.load(Ordering::Acquire) {
        return Err(failure(
            ManagedCodexFailureKind::Cancelled,
            "Managed Codex installation was cancelled.",
        ));
    }
    let release =
        embedded_managed_release(ManagedCliKind::Codex, "windows", "x86_64").map_err(|_| {
            failure(
                ManagedCodexFailureKind::Integrity,
                "Managed Codex release manifest is unavailable.",
            )
        })?;
    let managed_root = managed_base.join("codex");
    let mut repair_incomplete = false;
    match inspect_managed_runtime(&managed_root, &release) {
        ready @ ManagedCliReadiness::Ready { .. } => return Ok(ready),
        ManagedCliReadiness::Incomplete {
            reason: CODEX_CODE_MODE_HOST_MISSING,
        } => {
            // inspect_managed_runtime reaches this reason only after verifying the
            // existing pinned receipt and executable; preserve those exact bytes.
            install_code_mode_host(
                &managed_root.join("versions").join(&release.version),
                cancellation,
                |progress| on_progress(progress * 0.98),
            )?;
            return Ok(inspect_managed_runtime(&managed_root, &release));
        }
        ManagedCliReadiness::Incomplete { .. } => repair_incomplete = true,
        ManagedCliReadiness::Missing | ManagedCliReadiness::ProbeRequired { .. } => {}
    }

    ensure_regular_directory(&managed_root)?;
    let archive_path = managed_root.join(format!(".download-{}.zip", nanoid::nanoid!(20)));
    let archive_cleanup = CleanupPath(archive_path.clone());
    let archive_file = File::options()
        .write(true)
        .create_new(true)
        .open(&archive_path)
        .map_err(|_| {
            failure(
                ManagedCodexFailureKind::Disk,
                "Managed Codex download file could not be created.",
            )
        })?;
    let client = reqwest::blocking::Client::builder()
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(15 * 60))
        .build()
        .map_err(|_| {
            failure(
                ManagedCodexFailureKind::Network,
                "Managed Codex download client could not be created.",
            )
        })?;
    let response = client
        .get(&release.url)
        .send()
        .and_then(reqwest::blocking::Response::error_for_status)
        .map_err(|error| {
            failure(
                ManagedCodexFailureKind::Network,
                request_failure_detail(
                    error.status().map(|status| status.as_u16()),
                    error.is_timeout(),
                    error.is_connect(),
                    error.is_body(),
                ),
            )
        })?;
    if response.content_length() != Some(release.compressed_bytes) {
        return Err(failure(
            ManagedCodexFailureKind::Size,
            "Managed Codex download response size is invalid.",
        ));
    }
    stream_verified_download(
        response,
        archive_file,
        release.compressed_bytes,
        &release.sha256,
        cancellation,
        |progress| on_progress(progress * 0.7),
    )
    .map_err(map_download_failure)?;

    let versions_root = managed_root.join("versions");
    ensure_regular_directory(&versions_root)?;
    let destination = versions_root.join(&release.version);
    if fs::symlink_metadata(&destination).is_ok() && !repair_incomplete {
        return Err(failure(
            ManagedCodexFailureKind::Existing,
            "Existing managed Codex installation is incomplete.",
        ));
    }
    let staging = versions_root.join(format!(".staging-{}", nanoid::nanoid!(20)));
    fs::create_dir(&staging).map_err(|_| {
        failure(
            ManagedCodexFailureKind::Disk,
            "Managed Codex staging directory could not be created.",
        )
    })?;
    let staging_cleanup = CleanupPath(staging.clone());
    let archive_release = OpenCodeRelease {
        platform: release.platform.clone(),
        architecture: release.architecture.clone(),
        version: release.version.clone(),
        asset: release.asset.clone(),
        url: release.url.clone(),
        compressed_bytes: release.compressed_bytes,
        sha256: release.sha256.clone(),
        executable: release.entrypoint.clone(),
        maximum_expanded_bytes: release.maximum_expanded_bytes,
        maximum_entries: release.maximum_entries,
    };
    extract_verified_archive(&archive_path, &staging, &archive_release, cancellation)
        .map_err(map_download_failure)?;
    on_progress(0.9);
    install_code_mode_host(&staging, cancellation, |progress| {
        on_progress(0.9 + progress * 0.09)
    })?;
    write_receipt(&staging, &release)?;
    on_progress(0.99);
    if cancellation.load(Ordering::Acquire) {
        return Err(failure(
            ManagedCodexFailureKind::Cancelled,
            "Managed Codex installation was cancelled.",
        ));
    }
    let mut quarantine = if repair_incomplete {
        QuarantinedVersion::move_incomplete(&destination, &managed_root, &release)?
    } else {
        None
    };
    if fs::symlink_metadata(&destination).is_ok() {
        return Err(failure(
            ManagedCodexFailureKind::Existing,
            "Managed Codex version appeared during installation; retry after readiness refresh.",
        ));
    }
    fs::rename(&staging, &destination).map_err(|_| {
        failure(
            ManagedCodexFailureKind::Disk,
            "Managed Codex version could not be promoted.",
        )
    })?;
    if let Some(quarantine) = quarantine.as_mut() {
        quarantine.mark_promoted();
    }
    staging_cleanup.disarm();
    drop(archive_cleanup);
    let mut promoted_cleanup = quarantine
        .is_none()
        .then(|| CleanupPath(destination.clone()));
    match inspect_managed_runtime(&managed_root, &release) {
        readiness @ ManagedCliReadiness::Ready { .. } => {
            if let Some(quarantine) = quarantine.take() {
                quarantine.commit();
            }
            if let Some(cleanup) = promoted_cleanup.take() {
                cleanup.disarm();
            }
            on_progress(1.0);
            Ok(readiness)
        }
        _ => Err(failure(
            ManagedCodexFailureKind::Integrity,
            "Managed Codex verification failed after installation.",
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::{download_and_install_embedded_codex, QuarantinedVersion};
    use crate::harness::managed_cli_manifest::{embedded_managed_release, ManagedCliKind};
    use crate::harness::managed_cli_runtime::ManagedCliReadiness;
    use std::fs;
    use std::path::PathBuf;
    use std::process::Command;
    use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

    fn temp_dir(name: &str) -> PathBuf {
        static SEQUENCE: AtomicU64 = AtomicU64::new(0);
        std::env::temp_dir().join(format!(
            "vibespace-managed-codex-{name}-{}-{}",
            std::process::id(),
            SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ))
    }

    #[test]
    fn cancellation_before_download_never_creates_a_version() {
        let fixture = temp_dir("cancelled");
        assert!(
            download_and_install_embedded_codex(&fixture, &AtomicBool::new(true), |_| {},).is_err()
        );
        assert!(!fixture.join("codex/versions/0.151.0").exists());
    }

    #[test]
    fn incomplete_pinned_version_is_preserved_until_verified_replacement() {
        let fixture = temp_dir("repair-rollback");
        let release = embedded_managed_release(ManagedCliKind::Codex, "windows", "x86_64")
            .expect("embedded release");
        let managed_root = fixture.join("codex");
        let destination = managed_root.join("versions").join(&release.version);
        fs::create_dir_all(&destination).unwrap();
        fs::write(destination.join("partial.marker"), b"old-partial").unwrap();

        let mut quarantine =
            QuarantinedVersion::move_incomplete(&destination, &managed_root, &release)
                .expect("quarantine incomplete pinned version")
                .expect("incomplete version exists");
        assert!(!destination.exists());
        fs::create_dir_all(&destination).unwrap();
        fs::write(destination.join("verified.marker"), b"new-pinned").unwrap();
        quarantine.mark_promoted();
        drop(quarantine);

        assert_eq!(
            fs::read(destination.join("partial.marker")).unwrap(),
            b"old-partial"
        );
        assert!(!destination.join("verified.marker").exists());
        fs::remove_dir_all(fixture).unwrap();
    }

    #[test]
    #[ignore = "downloads and installs the exact pinned official Codex bundle"]
    fn audited_official_codex_bundle_materializes_and_executes() {
        let fixture = temp_dir("official");
        let readiness =
            download_and_install_embedded_codex(&fixture, &AtomicBool::new(false), |_| {})
                .expect("managed Codex install");
        let ManagedCliReadiness::Ready { launch } = readiness else {
            panic!("managed Codex must be ready after exact install");
        };
        let output = Command::new(&launch.executable)
            .arg("--version")
            .output()
            .expect("managed Codex launch");
        assert!(output.status.success());
        assert_eq!(
            String::from_utf8_lossy(&output.stdout).trim(),
            "codex-cli 0.151.0"
        );
        fs::remove_dir_all(fixture).unwrap();
    }
}
