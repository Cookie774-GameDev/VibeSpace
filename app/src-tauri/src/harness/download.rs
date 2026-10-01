use crate::harness::manifest::OpenCodeRelease;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;
use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, State};
use zip::ZipArchive;

const RUNTIME_STATE_EVENT: &str = "vibespace://opencode-runtime-state";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DownloadFailureKind {
    Cancelled,
    Network,
    Disk,
    Size,
    Hash,
    Archive,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DownloadFailure {
    pub kind: DownloadFailureKind,
    pub message: &'static str,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DownloadReceipt {
    pub bytes: u64,
    pub sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InstalledRuntime {
    pub version: String,
    pub executable: PathBuf,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum RuntimeInstallEvent {
    Downloading {
        progress: f64,
    },
    Verifying,
    Installing,
    Ready {
        source: crate::harness::runtime::RuntimeSource,
        version: String,
    },
    Failed {
        recoverable: bool,
        message: &'static str,
    },
}

#[derive(Clone, Default)]
pub struct OpenCodeDownloadState {
    active: Arc<Mutex<Option<Arc<AtomicBool>>>>,
}

struct InstallLease {
    active: Arc<Mutex<Option<Arc<AtomicBool>>>>,
    cancellation: Arc<AtomicBool>,
}

impl OpenCodeDownloadState {
    fn begin(&self) -> Result<InstallLease, &'static str> {
        let mut active = self
            .active
            .lock()
            .map_err(|_| "Harness installer state is unavailable.")?;
        if active.is_some() {
            return Err("A harness installation is already running.");
        }
        let cancellation = Arc::new(AtomicBool::new(false));
        *active = Some(cancellation.clone());
        Ok(InstallLease {
            active: self.active.clone(),
            cancellation,
        })
    }

    fn cancel(&self) -> Result<bool, &'static str> {
        let active = self
            .active
            .lock()
            .map_err(|_| "Harness installer state is unavailable.")?;
        if let Some(cancellation) = active.as_ref() {
            cancellation.store(true, Ordering::Release);
            return Ok(true);
        }
        Ok(false)
    }
}

impl Drop for InstallLease {
    fn drop(&mut self) {
        if let Ok(mut active) = self.active.lock() {
            if active
                .as_ref()
                .map(|current| Arc::ptr_eq(current, &self.cancellation))
                .unwrap_or(false)
            {
                *active = None;
            }
        }
    }
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ActiveRuntime {
    version: String,
}

struct CleanupPath {
    path: PathBuf,
    armed: bool,
}

impl CleanupPath {
    fn armed(path: PathBuf) -> Self {
        Self { path, armed: true }
    }

    fn disarm(&mut self) {
        self.armed = false;
    }
}

impl Drop for CleanupPath {
    fn drop(&mut self) {
        if !self.armed {
            return;
        }
        let _ = if self.path.is_dir() {
            fs::remove_dir_all(&self.path)
        } else {
            fs::remove_file(&self.path)
        };
    }
}

fn failure(kind: DownloadFailureKind, message: &'static str) -> DownloadFailure {
    DownloadFailure { kind, message }
}

pub fn stream_verified_download<R, W, F>(
    mut reader: R,
    mut writer: W,
    expected_bytes: u64,
    expected_sha256: &str,
    cancellation: &AtomicBool,
    mut on_progress: F,
) -> Result<DownloadReceipt, DownloadFailure>
where
    R: Read,
    W: Write,
    F: FnMut(f64),
{
    if expected_bytes == 0 {
        return Err(failure(
            DownloadFailureKind::Size,
            "Harness download has an invalid pinned size.",
        ));
    }
    if cancellation.load(Ordering::Acquire) {
        return Err(failure(
            DownloadFailureKind::Cancelled,
            "Harness download was cancelled.",
        ));
    }

    let mut hasher = Sha256::new();
    let mut total = 0_u64;
    let mut buffer = [0_u8; 64 * 1_024];
    on_progress(0.0);

    loop {
        if cancellation.load(Ordering::Acquire) {
            return Err(failure(
                DownloadFailureKind::Cancelled,
                "Harness download was cancelled.",
            ));
        }
        let read = reader.read(&mut buffer).map_err(|_| {
            failure(
                DownloadFailureKind::Network,
                "Harness download could not be read.",
            )
        })?;
        if read == 0 {
            break;
        }
        if cancellation.load(Ordering::Acquire) {
            return Err(failure(
                DownloadFailureKind::Cancelled,
                "Harness download was cancelled.",
            ));
        }

        let next_total = total.saturating_add(read as u64);
        if next_total > expected_bytes {
            return Err(failure(
                DownloadFailureKind::Size,
                "Harness download exceeded the pinned size.",
            ));
        }
        writer.write_all(&buffer[..read]).map_err(|_| {
            failure(
                DownloadFailureKind::Disk,
                "Harness download could not be written.",
            )
        })?;
        hasher.update(&buffer[..read]);
        total = next_total;
        on_progress((total as f64 / expected_bytes as f64).clamp(0.0, 1.0));
    }

    writer.flush().map_err(|_| {
        failure(
            DownloadFailureKind::Disk,
            "Harness download could not be finalized.",
        )
    })?;
    if total != expected_bytes {
        return Err(failure(
            DownloadFailureKind::Size,
            "Harness download did not match the pinned size.",
        ));
    }
    let sha256 = format!("{:x}", hasher.finalize());
    if sha256 != expected_sha256 {
        return Err(failure(
            DownloadFailureKind::Hash,
            "Harness download failed integrity verification.",
        ));
    }
    on_progress(1.0);

    Ok(DownloadReceipt {
        bytes: total,
        sha256,
    })
}

#[derive(Debug)]
struct ValidatedEntry {
    index: usize,
    relative_path: PathBuf,
    is_directory: bool,
    expanded_bytes: u64,
}

fn validate_archive_entries(
    archive: &mut ZipArchive<File>,
    release: &OpenCodeRelease,
    cancellation: &AtomicBool,
) -> Result<Vec<ValidatedEntry>, DownloadFailure> {
    if archive.len() == 0 || archive.len() > release.maximum_entries {
        return Err(failure(
            DownloadFailureKind::Archive,
            "Harness archive entry count is invalid.",
        ));
    }

    let mut validated = Vec::with_capacity(archive.len());
    let mut seen = BTreeSet::new();
    let mut total_expanded = 0_u64;
    let mut expected_executable_count = 0_usize;

    for index in 0..archive.len() {
        if cancellation.load(Ordering::Acquire) {
            return Err(failure(
                DownloadFailureKind::Cancelled,
                "Harness installation was cancelled.",
            ));
        }
        let entry = archive.by_index(index).map_err(|_| {
            failure(
                DownloadFailureKind::Archive,
                "Harness archive could not be inspected.",
            )
        })?;
        let entry_name = entry.name();
        if entry_name.contains('\\')
            || entry_name.contains(':')
            || entry_name
                .split('/')
                .any(|component| component.ends_with(['.', ' ']))
        {
            return Err(failure(
                DownloadFailureKind::Archive,
                "Harness archive contains an unsafe Windows path.",
            ));
        }
        let relative_path = entry.enclosed_name().ok_or_else(|| {
            failure(
                DownloadFailureKind::Archive,
                "Harness archive contains an unsafe path.",
            )
        })?;
        let comparison_path = relative_path
            .to_string_lossy()
            .replace('\\', "/")
            .to_ascii_lowercase();
        if relative_path.as_os_str().is_empty() || !seen.insert(comparison_path) {
            return Err(failure(
                DownloadFailureKind::Archive,
                "Harness archive contains a duplicate or empty path.",
            ));
        }

        let is_directory = entry.is_dir();
        if !is_directory && !entry.is_file() {
            return Err(failure(
                DownloadFailureKind::Archive,
                "Harness archive contains an unsupported entry.",
            ));
        }
        if let Some(mode) = entry.unix_mode() {
            let file_type = mode & 0o170000;
            let accepted_type = if is_directory { 0o040000 } else { 0o100000 };
            if file_type != 0 && file_type != accepted_type {
                return Err(failure(
                    DownloadFailureKind::Archive,
                    "Harness archive contains a non-regular entry.",
                ));
            }
        }

        let expanded_bytes = if is_directory { 0 } else { entry.size() };
        total_expanded = total_expanded.checked_add(expanded_bytes).ok_or_else(|| {
            failure(
                DownloadFailureKind::Archive,
                "Harness archive expanded size overflowed.",
            )
        })?;
        if total_expanded > release.maximum_expanded_bytes {
            return Err(failure(
                DownloadFailureKind::Archive,
                "Harness archive exceeds the expanded size limit.",
            ));
        }
        if !is_directory && relative_path == Path::new(&release.executable) {
            expected_executable_count += 1;
        }
        validated.push(ValidatedEntry {
            index,
            relative_path,
            is_directory,
            expanded_bytes,
        });
    }

    if expected_executable_count != 1 {
        return Err(failure(
            DownloadFailureKind::Archive,
            "Harness archive does not contain the expected executable.",
        ));
    }
    Ok(validated)
}

pub fn extract_verified_archive(
    archive_path: &Path,
    destination: &Path,
    release: &OpenCodeRelease,
    cancellation: &AtomicBool,
) -> Result<(), DownloadFailure> {
    if cancellation.load(Ordering::Acquire) {
        return Err(failure(
            DownloadFailureKind::Cancelled,
            "Harness installation was cancelled.",
        ));
    }
    let archive_file = File::open(archive_path).map_err(|_| {
        failure(
            DownloadFailureKind::Disk,
            "Verified harness archive could not be opened.",
        )
    })?;
    let mut archive = ZipArchive::new(archive_file).map_err(|_| {
        failure(
            DownloadFailureKind::Archive,
            "Harness archive format is invalid.",
        )
    })?;
    let entries = validate_archive_entries(&mut archive, release, cancellation)?;
    fs::create_dir_all(destination).map_err(|_| {
        failure(
            DownloadFailureKind::Disk,
            "Harness staging directory could not be created.",
        )
    })?;

    let mut actual_expanded = 0_u64;
    for validated in entries {
        if cancellation.load(Ordering::Acquire) {
            return Err(failure(
                DownloadFailureKind::Cancelled,
                "Harness installation was cancelled.",
            ));
        }
        let output_path = destination.join(&validated.relative_path);
        if validated.is_directory {
            fs::create_dir_all(&output_path).map_err(|_| {
                failure(
                    DownloadFailureKind::Disk,
                    "Harness archive directory could not be created.",
                )
            })?;
            continue;
        }
        if let Some(parent) = output_path.parent() {
            fs::create_dir_all(parent).map_err(|_| {
                failure(
                    DownloadFailureKind::Disk,
                    "Harness archive directory could not be created.",
                )
            })?;
        }
        let entry = archive.by_index(validated.index).map_err(|_| {
            failure(
                DownloadFailureKind::Archive,
                "Harness archive entry could not be reopened.",
            )
        })?;
        let mut bounded = entry.take(validated.expanded_bytes.saturating_add(1));
        let mut output = File::create(&output_path).map_err(|_| {
            failure(
                DownloadFailureKind::Disk,
                "Harness archive file could not be created.",
            )
        })?;
        let written = std::io::copy(&mut bounded, &mut output).map_err(|_| {
            failure(
                DownloadFailureKind::Disk,
                "Harness archive file could not be written.",
            )
        })?;
        if written != validated.expanded_bytes {
            return Err(failure(
                DownloadFailureKind::Archive,
                "Harness archive entry size changed during extraction.",
            ));
        }
        actual_expanded = actual_expanded.checked_add(written).ok_or_else(|| {
            failure(
                DownloadFailureKind::Archive,
                "Harness archive expanded size overflowed.",
            )
        })?;
        if actual_expanded > release.maximum_expanded_bytes {
            return Err(failure(
                DownloadFailureKind::Archive,
                "Harness archive exceeds the expanded size limit.",
            ));
        }
    }

    let executable = destination.join(&release.executable);
    if !fs::metadata(executable)
        .map(|metadata| metadata.is_file())
        .unwrap_or(false)
    {
        return Err(failure(
            DownloadFailureKind::Archive,
            "Harness executable is missing after extraction.",
        ));
    }
    Ok(())
}

fn existing_runtime(
    version_root: &Path,
    release: &OpenCodeRelease,
) -> Result<Option<InstalledRuntime>, DownloadFailure> {
    if !version_root.exists() {
        return Ok(None);
    }
    let version_metadata = fs::symlink_metadata(version_root).map_err(|_| {
        failure(
            DownloadFailureKind::Archive,
            "Managed harness destination could not be inspected.",
        )
    })?;
    if !version_metadata.is_dir() || version_metadata.file_type().is_symlink() {
        return Err(failure(
            DownloadFailureKind::Archive,
            "Managed harness destination is not a directory.",
        ));
    }
    let installed_release = fs::read(version_root.join("manifest.json"))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<OpenCodeRelease>(&bytes).ok());
    let executable = version_root.join(&release.executable);
    if installed_release.as_ref() != Some(release)
        || !fs::metadata(&executable)
            .map(|metadata| metadata.is_file())
            .unwrap_or(false)
    {
        return Err(failure(
            DownloadFailureKind::Archive,
            "Existing managed harness is incomplete or does not match.",
        ));
    }
    Ok(Some(InstalledRuntime {
        version: release.version.clone(),
        executable,
    }))
}

#[cfg(target_os = "windows")]
fn atomic_replace_file(temporary: &Path, destination: &Path) -> Result<(), DownloadFailure> {
    use std::os::windows::ffi::OsStrExt;
    use windows::core::PCWSTR;
    use windows::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };

    let temporary_wide = temporary
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let destination_wide = destination
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    unsafe {
        MoveFileExW(
            PCWSTR(temporary_wide.as_ptr()),
            PCWSTR(destination_wide.as_ptr()),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    }
    .map_err(|_| {
        failure(
            DownloadFailureKind::Disk,
            "Harness active manifest could not be committed.",
        )
    })
}

#[cfg(not(target_os = "windows"))]
fn atomic_replace_file(temporary: &Path, destination: &Path) -> Result<(), DownloadFailure> {
    fs::rename(temporary, destination).map_err(|_| {
        failure(
            DownloadFailureKind::Disk,
            "Harness active manifest could not be committed.",
        )
    })
}

fn write_active_manifest(
    managed_root: &Path,
    release: &OpenCodeRelease,
) -> Result<(), DownloadFailure> {
    let temporary = managed_root.join(format!(".active-{}.tmp", nanoid::nanoid!(16)));
    let mut cleanup = CleanupPath::armed(temporary.clone());
    let bytes = serde_json::to_vec(&ActiveRuntime {
        version: release.version.clone(),
    })
    .map_err(|_| {
        failure(
            DownloadFailureKind::Disk,
            "Harness active manifest could not be serialized.",
        )
    })?;
    let mut output = File::options()
        .write(true)
        .create_new(true)
        .open(&temporary)
        .map_err(|_| {
            failure(
                DownloadFailureKind::Disk,
                "Harness active manifest could not be created.",
            )
        })?;
    output.write_all(&bytes).map_err(|_| {
        failure(
            DownloadFailureKind::Disk,
            "Harness active manifest could not be written.",
        )
    })?;
    output.sync_all().map_err(|_| {
        failure(
            DownloadFailureKind::Disk,
            "Harness active manifest could not be finalized.",
        )
    })?;
    drop(output);
    atomic_replace_file(&temporary, &managed_root.join("active.json"))?;
    cleanup.disarm();
    Ok(())
}

pub fn install_verified_archive(
    managed_root: &Path,
    archive_path: &Path,
    release: &OpenCodeRelease,
    cancellation: &AtomicBool,
) -> Result<InstalledRuntime, DownloadFailure> {
    if cancellation.load(Ordering::Acquire) {
        return Err(failure(
            DownloadFailureKind::Cancelled,
            "Harness installation was cancelled.",
        ));
    }
    fs::create_dir_all(managed_root).map_err(|_| {
        failure(
            DownloadFailureKind::Disk,
            "Managed harness directory could not be created.",
        )
    })?;
    let version_root = managed_root.join(&release.version);
    if let Some(installed) = existing_runtime(&version_root, release)? {
        write_active_manifest(managed_root, release)?;
        return Ok(installed);
    }

    let staging_root = managed_root.join(format!(".staging-{}", nanoid::nanoid!(20)));
    fs::create_dir(&staging_root).map_err(|_| {
        failure(
            DownloadFailureKind::Disk,
            "Harness staging directory could not be created.",
        )
    })?;
    let mut staging_cleanup = CleanupPath::armed(staging_root.clone());
    extract_verified_archive(archive_path, &staging_root, release, cancellation)?;
    if cancellation.load(Ordering::Acquire) {
        return Err(failure(
            DownloadFailureKind::Cancelled,
            "Harness installation was cancelled.",
        ));
    }

    let manifest_bytes = serde_json::to_vec_pretty(release).map_err(|_| {
        failure(
            DownloadFailureKind::Disk,
            "Harness install manifest could not be serialized.",
        )
    })?;
    let mut manifest_file = File::create(staging_root.join("manifest.json")).map_err(|_| {
        failure(
            DownloadFailureKind::Disk,
            "Harness install manifest could not be created.",
        )
    })?;
    manifest_file.write_all(&manifest_bytes).map_err(|_| {
        failure(
            DownloadFailureKind::Disk,
            "Harness install manifest could not be written.",
        )
    })?;
    manifest_file.sync_all().map_err(|_| {
        failure(
            DownloadFailureKind::Disk,
            "Harness install manifest could not be finalized.",
        )
    })?;
    drop(manifest_file);

    fs::rename(&staging_root, &version_root).map_err(|_| {
        failure(
            DownloadFailureKind::Disk,
            "Harness version directory could not be committed.",
        )
    })?;
    staging_cleanup.disarm();
    write_active_manifest(managed_root, release)?;
    existing_runtime(&version_root, release)?.ok_or_else(|| {
        failure(
            DownloadFailureKind::Archive,
            "Managed harness verification failed after installation.",
        )
    })
}

fn managed_root(app: &AppHandle) -> Result<PathBuf, DownloadFailure> {
    app.path()
        .app_local_data_dir()
        .map(|path| path.join("runtimes").join("opencode"))
        .map_err(|_| {
            failure(
                DownloadFailureKind::Disk,
                "VibeSpace runtime storage is unavailable.",
            )
        })
}

fn emit_install_state(app: &AppHandle, event: RuntimeInstallEvent) {
    let _ = app.emit(RUNTIME_STATE_EVENT, event);
}

fn download_and_install(
    app: &AppHandle,
    cancellation: &AtomicBool,
) -> Result<InstalledRuntime, DownloadFailure> {
    let release =
        crate::harness::manifest::embedded_release_for("windows", "x86_64").map_err(|_| {
            failure(
                DownloadFailureKind::Archive,
                "Harness release manifest is unavailable.",
            )
        })?;
    let root = managed_root(app)?;
    fs::create_dir_all(&root).map_err(|_| {
        failure(
            DownloadFailureKind::Disk,
            "Managed harness directory could not be created.",
        )
    })?;
    let archive_path = root.join(format!(".download-{}.zip", nanoid::nanoid!(20)));
    let _archive_cleanup = CleanupPath::armed(archive_path.clone());
    let mut archive_file = File::options()
        .write(true)
        .create_new(true)
        .open(&archive_path)
        .map_err(|_| {
            failure(
                DownloadFailureKind::Disk,
                "Harness download file could not be created.",
            )
        })?;

    let client = reqwest::blocking::Client::builder()
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(15 * 60))
        .build()
        .map_err(|_| {
            failure(
                DownloadFailureKind::Network,
                "Harness download client could not be created.",
            )
        })?;
    let response = client
        .get(&release.url)
        .send()
        .and_then(reqwest::blocking::Response::error_for_status)
        .map_err(|_| {
            failure(
                DownloadFailureKind::Network,
                "Harness download request failed.",
            )
        })?;
    if response.content_length() != Some(release.compressed_bytes) {
        return Err(failure(
            DownloadFailureKind::Size,
            "Harness download response size is invalid.",
        ));
    }
    stream_verified_download(
        response,
        &mut archive_file,
        release.compressed_bytes,
        &release.sha256,
        cancellation,
        |progress| emit_install_state(app, RuntimeInstallEvent::Downloading { progress }),
    )?;
    archive_file.sync_all().map_err(|_| {
        failure(
            DownloadFailureKind::Disk,
            "Harness download could not be finalized.",
        )
    })?;
    drop(archive_file);
    emit_install_state(app, RuntimeInstallEvent::Verifying);
    if cancellation.load(Ordering::Acquire) {
        return Err(failure(
            DownloadFailureKind::Cancelled,
            "Harness installation was cancelled.",
        ));
    }
    emit_install_state(app, RuntimeInstallEvent::Installing);
    install_verified_archive(&root, &archive_path, &release, cancellation)
}

#[tauri::command]
pub async fn opencode_runtime_install(
    app: AppHandle,
    download_state: State<'_, OpenCodeDownloadState>,
    runtime_state: State<'_, crate::harness::runtime::OpenCodeRuntimeState>,
) -> Result<crate::harness::runtime::OpenCodeRuntimeDetection, String> {
    let lease = download_state.begin().map_err(str::to_string)?;
    let cancellation = lease.cancellation.clone();
    let worker_app = app.clone();
    let install_result = tauri::async_runtime::spawn_blocking(move || {
        download_and_install(&worker_app, &cancellation)
    })
    .await
    .map_err(|_| "Harness installer worker failed.".to_string())?;
    drop(lease);

    if let Err(error) = install_result {
        emit_install_state(
            &app,
            RuntimeInstallEvent::Failed {
                recoverable: true,
                message: error.message,
            },
        );
        return Err(error.message.to_string());
    }
    let detection = match crate::harness::runtime::detect_opencode_runtime(&app, &runtime_state) {
        Ok(detection) => detection,
        Err(_) => {
            let message = "Installed harness could not be detected.";
            emit_install_state(
                &app,
                RuntimeInstallEvent::Failed {
                    recoverable: true,
                    message,
                },
            );
            return Err(message.to_string());
        }
    };
    if detection.status != crate::harness::runtime::OpenCodeRuntimeStatus::ManagedCompatible {
        let message = "Installed harness did not pass managed runtime detection.";
        emit_install_state(
            &app,
            RuntimeInstallEvent::Failed {
                recoverable: true,
                message,
            },
        );
        return Err(message.to_string());
    }
    emit_install_state(
        &app,
        RuntimeInstallEvent::Ready {
            source: crate::harness::runtime::RuntimeSource::Managed,
            version: detection
                .version
                .clone()
                .unwrap_or_else(|| "1.18.16".to_string()),
        },
    );
    Ok(detection)
}

#[tauri::command]
pub fn opencode_runtime_install_cancel(
    download_state: State<'_, OpenCodeDownloadState>,
) -> Result<bool, String> {
    download_state.cancel().map_err(str::to_string)
}

#[cfg(test)]
mod tests {
    use super::{
        extract_verified_archive, install_verified_archive, stream_verified_download,
        DownloadFailureKind,
    };
    use crate::harness::manifest::OpenCodeRelease;
    use sha2::{Digest, Sha256};
    use std::fs::{self, File};
    use std::io::{self, Cursor, Read, Write};
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::atomic::{AtomicU64, Ordering as AtomicOrdering};
    use zip::write::SimpleFileOptions;
    use zip::ZipWriter;

    static FIXTURE_SEQUENCE: AtomicU64 = AtomicU64::new(0);

    struct FixtureRoot(PathBuf);

    impl FixtureRoot {
        fn new(name: &str) -> Self {
            let sequence = FIXTURE_SEQUENCE.fetch_add(1, AtomicOrdering::Relaxed);
            let path = std::env::temp_dir().join(format!(
                "vibespace-opencode-download-{name}-{}-{sequence}",
                std::process::id()
            ));
            fs::create_dir_all(&path).expect("fixture root");
            Self(path)
        }

        fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for FixtureRoot {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn sha256(bytes: &[u8]) -> String {
        format!("{:x}", Sha256::digest(bytes))
    }

    fn release(maximum_expanded_bytes: u64, maximum_entries: usize) -> OpenCodeRelease {
        OpenCodeRelease {
            platform: "windows".to_string(),
            architecture: "x86_64".to_string(),
            version: "1.18.16".to_string(),
            asset: "opencode-windows-x64.zip".to_string(),
            url: "https://github.com/anomalyco/opencode/releases/download/v1.18.16/opencode-windows-x64.zip".to_string(),
            compressed_bytes: 1,
            sha256: "0".repeat(64),
            executable: "opencode.exe".to_string(),
            maximum_expanded_bytes,
            maximum_entries,
        }
    }

    fn write_zip(path: &Path, entries: &[(&str, &[u8], u32)]) {
        let file = File::create(path).expect("zip fixture");
        let mut archive = ZipWriter::new(file);
        for (name, bytes, mode) in entries {
            archive
                .start_file(*name, SimpleFileOptions::default().unix_permissions(*mode))
                .expect("zip entry");
            archive.write_all(bytes).expect("zip bytes");
        }
        archive.finish().expect("zip finish");
    }

    fn write_symlink_zip(path: &Path, name: &str, target: &str) {
        let file = File::create(path).expect("zip fixture");
        let mut archive = ZipWriter::new(file);
        archive
            .add_symlink(name, target, SimpleFileOptions::default())
            .expect("zip symlink");
        archive.finish().expect("zip finish");
    }

    struct FailingReader;

    impl Read for FailingReader {
        fn read(&mut self, _buffer: &mut [u8]) -> io::Result<usize> {
            Err(io::Error::new(io::ErrorKind::ConnectionReset, "synthetic"))
        }
    }

    struct FailingWriter;

    impl Write for FailingWriter {
        fn write(&mut self, _buffer: &[u8]) -> io::Result<usize> {
            Err(io::Error::new(io::ErrorKind::WriteZero, "synthetic"))
        }

        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    struct CancellingReader<'a> {
        inner: Cursor<Vec<u8>>,
        cancellation: &'a AtomicBool,
        first_read: bool,
    }

    impl Read for CancellingReader<'_> {
        fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
            let read = self.inner.read(buffer)?;
            if self.first_read && read > 0 {
                self.first_read = false;
                self.cancellation.store(true, Ordering::Release);
            }
            Ok(read)
        }
    }

    #[test]
    fn stream_verification_writes_exact_bytes_hash_and_monotonic_progress() {
        let bytes = b"verified archive bytes";
        let cancellation = AtomicBool::new(false);
        let mut output = Vec::new();
        let mut progress = Vec::new();

        let receipt = stream_verified_download(
            Cursor::new(bytes),
            &mut output,
            bytes.len() as u64,
            &sha256(bytes),
            &cancellation,
            |value| progress.push(value),
        )
        .expect("verified stream");

        assert_eq!(output, bytes);
        assert_eq!(receipt.bytes, bytes.len() as u64);
        assert_eq!(receipt.sha256, sha256(bytes));
        assert_eq!(progress.first().copied(), Some(0.0));
        assert_eq!(progress.last().copied(), Some(1.0));
        assert!(progress.windows(2).all(|window| window[0] <= window[1]));
        assert!(progress.iter().all(|value| (0.0..=1.0).contains(value)));
    }

    #[test]
    fn stream_verification_rejects_short_overflow_and_hash_mismatch() {
        let cancellation = AtomicBool::new(false);
        for (bytes, expected_bytes, expected_hash, kind) in [
            (
                b"short".as_slice(),
                10,
                sha256(b"short"),
                DownloadFailureKind::Size,
            ),
            (
                b"overflow".as_slice(),
                3,
                sha256(b"overflow"),
                DownloadFailureKind::Size,
            ),
            (
                b"wrong hash".as_slice(),
                10,
                sha256(b"different!"),
                DownloadFailureKind::Hash,
            ),
        ] {
            let error = stream_verified_download(
                Cursor::new(bytes),
                Vec::new(),
                expected_bytes,
                &expected_hash,
                &cancellation,
                |_| {},
            )
            .expect_err("verification must fail");
            assert_eq!(error.kind, kind);
        }
    }

    #[test]
    fn stream_verification_rejects_a_zero_pinned_size() {
        let error = stream_verified_download(
            Cursor::new([]),
            Vec::new(),
            0,
            &sha256(b""),
            &AtomicBool::new(false),
            |_| {},
        )
        .expect_err("zero pinned size");

        assert_eq!(error.kind, DownloadFailureKind::Size);
    }

    #[test]
    fn stream_verification_classifies_read_and_write_failures() {
        let cancellation = AtomicBool::new(false);
        let read_error = stream_verified_download(
            FailingReader,
            Vec::new(),
            1,
            &sha256(b"x"),
            &cancellation,
            |_| {},
        )
        .expect_err("read failure");
        let write_error = stream_verified_download(
            Cursor::new(b"x"),
            FailingWriter,
            1,
            &sha256(b"x"),
            &cancellation,
            |_| {},
        )
        .expect_err("write failure");

        assert_eq!(read_error.kind, DownloadFailureKind::Network);
        assert_eq!(write_error.kind, DownloadFailureKind::Disk);
    }

    #[test]
    fn stream_verification_honors_cancellation_before_and_during_transfer() {
        let cancelled_before = AtomicBool::new(true);
        let before = stream_verified_download(
            Cursor::new(b"x"),
            Vec::new(),
            1,
            &sha256(b"x"),
            &cancelled_before,
            |_| {},
        )
        .expect_err("pre-cancel");
        assert_eq!(before.kind, DownloadFailureKind::Cancelled);

        let cancelled_during = AtomicBool::new(false);
        let reader = CancellingReader {
            inner: Cursor::new(vec![b'x'; 128 * 1_024]),
            cancellation: &cancelled_during,
            first_read: true,
        };
        let during = stream_verified_download(
            reader,
            Vec::new(),
            128 * 1_024,
            &sha256(&vec![b'x'; 128 * 1_024]),
            &cancelled_during,
            |_| {},
        )
        .expect_err("mid-transfer cancel");
        assert_eq!(during.kind, DownloadFailureKind::Cancelled);
    }

    #[test]
    fn archive_extraction_accepts_only_the_expected_regular_executable() {
        let fixture = FixtureRoot::new("extract-success");
        let archive = fixture.path().join("runtime.zip");
        let destination = fixture.path().join("extracted");
        write_zip(&archive, &[("opencode.exe", b"native bytes", 0o100755)]);

        extract_verified_archive(
            &archive,
            &destination,
            &release(1_024, 8),
            &AtomicBool::new(false),
        )
        .expect("safe extraction");

        assert_eq!(
            fs::read(destination.join("opencode.exe")).unwrap(),
            b"native bytes"
        );
    }

    #[test]
    fn archive_extraction_rejects_traversal_absolute_and_symlink_entries() {
        for name in ["../escape.exe", "/absolute.exe", "C:\\absolute.exe"] {
            let fixture = FixtureRoot::new("extract-unsafe");
            let archive = fixture.path().join("runtime.zip");
            write_zip(&archive, &[(name, b"unsafe", 0o100755)]);

            let result = extract_verified_archive(
                &archive,
                &fixture.path().join("extracted"),
                &release(1_024, 8),
                &AtomicBool::new(false),
            );

            assert!(result.is_err(), "accepted unsafe archive entry {name}");
            let error = result.expect_err("unsafe archive");
            assert_eq!(error.kind, DownloadFailureKind::Archive);
            assert!(!fixture.path().join("escape.exe").exists());
        }

        let fixture = FixtureRoot::new("extract-symlink");
        let archive = fixture.path().join("runtime.zip");
        write_symlink_zip(&archive, "opencode.exe", "../outside.exe");
        let error = extract_verified_archive(
            &archive,
            &fixture.path().join("extracted"),
            &release(1_024, 8),
            &AtomicBool::new(false),
        )
        .expect_err("symlink entry");
        assert_eq!(error.kind, DownloadFailureKind::Archive);
    }

    #[test]
    fn archive_extraction_rejects_case_insensitive_duplicate_paths() {
        let fixture = FixtureRoot::new("extract-duplicate");
        let archive = fixture.path().join("runtime.zip");
        write_zip(
            &archive,
            &[
                ("opencode.exe", b"first", 0o100755),
                ("OpenCode.exe", b"second", 0o100755),
            ],
        );

        let error = extract_verified_archive(
            &archive,
            &fixture.path().join("extracted"),
            &release(1_024, 8),
            &AtomicBool::new(false),
        )
        .expect_err("case-insensitive duplicate");
        assert_eq!(error.kind, DownloadFailureKind::Archive);
    }

    #[test]
    fn archive_extraction_rejects_windows_alternate_stream_and_ambiguous_names() {
        for unsafe_name in ["opencode.exe:payload", "nested\\payload", "payload."] {
            let fixture = FixtureRoot::new("extract-windows-path");
            let archive = fixture.path().join("runtime.zip");
            write_zip(
                &archive,
                &[
                    ("opencode.exe", b"native", 0o100755),
                    (unsafe_name, b"unsafe", 0o100644),
                ],
            );

            let error = extract_verified_archive(
                &archive,
                &fixture.path().join("extracted"),
                &release(1_024, 8),
                &AtomicBool::new(false),
            )
            .expect_err("unsafe Windows path");
            assert_eq!(error.kind, DownloadFailureKind::Archive);
        }
    }

    #[test]
    fn archive_extraction_rejects_corrupt_zip_bytes() {
        let fixture = FixtureRoot::new("extract-corrupt");
        let archive = fixture.path().join("runtime.zip");
        fs::write(&archive, b"not a zip archive").unwrap();

        let error = extract_verified_archive(
            &archive,
            &fixture.path().join("extracted"),
            &release(1_024, 8),
            &AtomicBool::new(false),
        )
        .expect_err("corrupt archive");
        assert_eq!(error.kind, DownloadFailureKind::Archive);
    }

    #[test]
    fn archive_extraction_enforces_entry_and_expanded_size_limits() {
        let fixture = FixtureRoot::new("extract-limits");
        let archive = fixture.path().join("runtime.zip");
        write_zip(
            &archive,
            &[
                ("opencode.exe", b"native bytes", 0o100755),
                ("extra.txt", b"extra", 0o100644),
            ],
        );

        let entries_error = extract_verified_archive(
            &archive,
            &fixture.path().join("entries"),
            &release(1_024, 1),
            &AtomicBool::new(false),
        )
        .expect_err("entry limit");
        let size_error = extract_verified_archive(
            &archive,
            &fixture.path().join("size"),
            &release(4, 8),
            &AtomicBool::new(false),
        )
        .expect_err("expanded limit");

        assert_eq!(entries_error.kind, DownloadFailureKind::Archive);
        assert_eq!(size_error.kind, DownloadFailureKind::Archive);
    }

    #[test]
    fn archive_extraction_rejects_a_missing_expected_executable_and_cancellation() {
        let fixture = FixtureRoot::new("extract-missing");
        let archive = fixture.path().join("runtime.zip");
        write_zip(&archive, &[("readme.txt", b"not runtime", 0o100644)]);

        let missing = extract_verified_archive(
            &archive,
            &fixture.path().join("missing"),
            &release(1_024, 8),
            &AtomicBool::new(false),
        )
        .expect_err("missing executable");
        let cancelled = extract_verified_archive(
            &archive,
            &fixture.path().join("cancelled"),
            &release(1_024, 8),
            &AtomicBool::new(true),
        )
        .expect_err("cancelled extraction");

        assert_eq!(missing.kind, DownloadFailureKind::Archive);
        assert_eq!(cancelled.kind, DownloadFailureKind::Cancelled);
    }

    #[test]
    fn atomic_install_commits_version_and_manifests_without_staging_debris() {
        let fixture = FixtureRoot::new("install-success");
        let archive = fixture.path().join("runtime.zip");
        let managed = fixture.path().join("managed");
        let release = release(1_024, 8);
        write_zip(&archive, &[("opencode.exe", b"native bytes", 0o100755)]);

        let installed =
            install_verified_archive(&managed, &archive, &release, &AtomicBool::new(false))
                .expect("atomic install");

        assert_eq!(installed.version, release.version);
        assert_eq!(
            fs::read(&installed.executable).expect("installed executable"),
            b"native bytes"
        );
        let installed_manifest: OpenCodeRelease =
            serde_json::from_slice(&fs::read(managed.join("1.18.16/manifest.json")).unwrap())
                .unwrap();
        assert_eq!(installed_manifest, release);
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(
                &fs::read(managed.join("active.json")).unwrap()
            )
            .unwrap(),
            serde_json::json!({ "version": "1.18.16" })
        );
        assert!(fs::read_dir(&managed).unwrap().all(|entry| !entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .starts_with('.')));
    }

    #[test]
    fn atomic_install_cleans_staging_after_failure_and_cancellation() {
        let fixture = FixtureRoot::new("install-cleanup");
        let archive = fixture.path().join("runtime.zip");
        let managed = fixture.path().join("managed");
        let release = release(1_024, 8);
        write_zip(&archive, &[("readme.txt", b"not runtime", 0o100644)]);

        let error = install_verified_archive(&managed, &archive, &release, &AtomicBool::new(false))
            .expect_err("invalid archive");
        assert_eq!(error.kind, DownloadFailureKind::Archive);
        assert!(!managed.join("1.18.16").exists());
        assert!(!managed.join("active.json").exists());
        assert!(fs::read_dir(&managed).unwrap().next().is_none());

        let cancelled = AtomicBool::new(true);
        let error = install_verified_archive(&managed, &archive, &release, &cancelled)
            .expect_err("cancelled install");
        assert_eq!(error.kind, DownloadFailureKind::Cancelled);
        assert!(fs::read_dir(&managed).unwrap().next().is_none());
    }

    #[test]
    fn atomic_install_reuses_only_an_identical_complete_runtime_and_replaces_active_atomically() {
        let fixture = FixtureRoot::new("install-existing");
        let archive = fixture.path().join("runtime.zip");
        let managed = fixture.path().join("managed");
        let release = release(1_024, 8);
        write_zip(&archive, &[("opencode.exe", b"native bytes", 0o100755)]);
        install_verified_archive(&managed, &archive, &release, &AtomicBool::new(false))
            .expect("initial install");
        fs::write(managed.join("active.json"), br#"{"version":"old"}"#).unwrap();
        fs::remove_file(&archive).unwrap();

        let installed =
            install_verified_archive(&managed, &archive, &release, &AtomicBool::new(false))
                .expect("reuse existing");

        assert_eq!(fs::read(installed.executable).unwrap(), b"native bytes");
        assert_eq!(
            fs::read_to_string(managed.join("active.json")).unwrap(),
            r#"{"version":"1.18.16"}"#
        );
        assert!(fs::read_dir(&managed).unwrap().all(|entry| !entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .starts_with('.')));
    }

    #[test]
    fn install_lease_is_single_flight_cancel_scoped_and_released_on_drop() {
        let state = super::OpenCodeDownloadState::default();
        assert!(!state.cancel().unwrap());
        let first = state.begin().expect("first lease");
        assert_eq!(
            state.begin().err(),
            Some("A harness installation is already running.")
        );
        assert!(state.cancel().unwrap());
        assert!(first.cancellation.load(Ordering::Acquire));
        drop(first);
        assert!(!state.cancel().unwrap());
        let second = state.begin().expect("lease released");
        assert!(!second.cancellation.load(Ordering::Acquire));
    }

    #[test]
    fn install_events_serialize_to_bounded_runtime_state_fields() {
        for (event, expected) in [
            (
                super::RuntimeInstallEvent::Downloading { progress: 0.5 },
                serde_json::json!({"kind": "downloading", "progress": 0.5}),
            ),
            (
                super::RuntimeInstallEvent::Verifying,
                serde_json::json!({"kind": "verifying"}),
            ),
            (
                super::RuntimeInstallEvent::Installing,
                serde_json::json!({"kind": "installing"}),
            ),
            (
                super::RuntimeInstallEvent::Ready {
                    source: crate::harness::runtime::RuntimeSource::Managed,
                    version: "1.18.16".to_string(),
                },
                serde_json::json!({
                    "kind": "ready",
                    "source": "managed",
                    "version": "1.18.16"
                }),
            ),
            (
                super::RuntimeInstallEvent::Failed {
                    recoverable: true,
                    message: "Harness download request failed.",
                },
                serde_json::json!({
                    "kind": "failed",
                    "recoverable": true,
                    "message": "Harness download request failed."
                }),
            ),
        ] {
            assert_eq!(serde_json::to_value(event).unwrap(), expected);
        }
    }
}
