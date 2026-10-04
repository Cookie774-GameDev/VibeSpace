use serde::Serialize;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::fs::{self, File};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

const MINIMUM_OPENCODE_VERSION: RuntimeVersion = RuntimeVersion {
    major: 1,
    minor: 18,
    patch: 16,
};
const MAX_REASON_LENGTH: usize = 2_048;
const MAX_VERSION_OUTPUT_LENGTH: usize = 4_096;
const VERSION_PROBE_TIMEOUT: Duration = Duration::from_secs(5);
const VERSION_PROBE_TIMEOUT_REASON: &str = "OpenCode version probe timed out.";
const MAX_TRANSIENT_VERSION_PROBE_RETRIES: usize = 1;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;
#[cfg(windows)]
const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
#[cfg(windows)]
const CREATE_SUSPENDED: u32 = 0x0000_0004;

#[cfg(windows)]
pub(crate) mod version_probe_job {
    use super::*;
    use std::ffi::c_void;
    use std::mem::size_of;
    use std::os::windows::io::AsRawHandle;
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::{CloseHandle, HANDLE};
    use windows::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Thread32First, Thread32Next, TH32CS_SNAPTHREAD, THREADENTRY32,
    };
    use windows::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, TerminateJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    use windows::Win32::System::Threading::{OpenThread, ResumeThread, THREAD_SUSPEND_RESUME};

    struct OwnedHandle(HANDLE);
    impl Drop for OwnedHandle {
        fn drop(&mut self) {
            let _ = unsafe { CloseHandle(self.0) };
        }
    }

    pub(crate) struct ProbeJob(OwnedHandle);
    // A job HANDLE has no thread affinity. Ownership remains unique and Drop closes it once.
    unsafe impl Send for ProbeJob {}
    impl ProbeJob {
        pub(crate) fn create() -> Result<Self, String> {
            let handle = unsafe { CreateJobObjectW(None, PCWSTR::null()) }.map_err(|error| {
                format!("OpenCode version probe job could not be created: {error}")
            })?;
            let job = Self(OwnedHandle(handle));
            let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            unsafe {
                SetInformationJobObject(
                    job.0 .0,
                    JobObjectExtendedLimitInformation,
                    (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast::<c_void>(),
                    size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                )
            }
            .map_err(|error| {
                format!("OpenCode version probe job could not be configured: {error}")
            })?;
            Ok(job)
        }

        pub(crate) fn assign_suspended(&self, child: &Child) -> Result<(), String> {
            unsafe { AssignProcessToJobObject(self.0 .0, HANDLE(child.as_raw_handle())) }
                .map_err(|error| format!("OpenCode version probe could not be contained: {error}"))
        }

        pub(crate) fn resume_suspended(&self, child: &Child) -> Result<(), String> {
            let snapshot = OwnedHandle(
                unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0) }.map_err(|error| {
                    format!("OpenCode version probe thread could not be found: {error}")
                })?,
            );
            let mut entry = THREADENTRY32 {
                dwSize: size_of::<THREADENTRY32>() as u32,
                ..Default::default()
            };
            let mut thread_id = None;
            if unsafe { Thread32First(snapshot.0, &mut entry) }.is_ok() {
                loop {
                    if entry.th32OwnerProcessID == child.id() {
                        if thread_id.replace(entry.th32ThreadID).is_some() {
                            return Err(
                                "OpenCode suspended probe exposed multiple threads.".to_string()
                            );
                        }
                    }
                    if unsafe { Thread32Next(snapshot.0, &mut entry) }.is_err() {
                        break;
                    }
                }
            }
            let thread = OwnedHandle(
                unsafe {
                    OpenThread(
                        THREAD_SUSPEND_RESUME,
                        false,
                        thread_id.ok_or_else(|| {
                            "OpenCode suspended probe thread was unavailable.".to_string()
                        })?,
                    )
                }
                .map_err(|error| {
                    format!("OpenCode suspended probe thread could not be opened: {error}")
                })?,
            );
            let previous = unsafe { ResumeThread(thread.0) };
            if previous != 1 {
                return Err(
                    "OpenCode suspended probe could not be resumed exactly once.".to_string(),
                );
            }
            Ok(())
        }

        pub(crate) fn assign_and_resume(&self, child: &Child) -> Result<(), String> {
            self.assign_suspended(child)?;
            self.resume_suspended(child)
        }

        pub(crate) fn terminate(&self) {
            let _ = unsafe { TerminateJobObject(self.0 .0, 1) };
        }
        pub(crate) fn try_terminate(&self) -> Result<(), String> {
            unsafe { TerminateJobObject(self.0 .0, 1) }
                .map_err(|error| format!("Owned job termination was not acknowledged: {error}"))
        }

        pub(crate) fn is_empty(&self) -> Result<bool, String> {
            use windows::Win32::System::JobObjects::{QueryInformationJobObject, JobObjectBasicAccountingInformation, JOBOBJECT_BASIC_ACCOUNTING_INFORMATION};
            let mut info = JOBOBJECT_BASIC_ACCOUNTING_INFORMATION::default();
            unsafe {
                QueryInformationJobObject(Some(self.0 .0), JobObjectBasicAccountingInformation,
                    (&mut info as *mut JOBOBJECT_BASIC_ACCOUNTING_INFORMATION).cast::<c_void>(),
                    size_of::<JOBOBJECT_BASIC_ACCOUNTING_INFORMATION>() as u32, None)
            }.map_err(|error| format!("Owned job closure could not be verified: {error}"))?;
            Ok(info.ActiveProcesses == 0)
        }
    }

    pub(crate) fn configure_suspended(command: &mut Command) {
        command.creation_flags(
            super::CREATE_NO_WINDOW | super::CREATE_NEW_PROCESS_GROUP | super::CREATE_SUSPENDED,
        );
    }

    pub(crate) fn reap_failed_containment(child: &mut Child, job: ProbeJob) {
        job.terminate();
        drop(job);
        // Assignment may have failed before the suspended process entered the job. Killing the
        // direct child is therefore mandatory before waiting; CREATE_SUSPENDED cannot exit alone.
        let _ = child.kill();
        let _ = child.wait();
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum RuntimeSource {
    System,
    Managed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CandidateOrigin {
    Path,
    Scoop,
    Chocolatey,
    Standalone,
    NpmNative,
    Managed,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct RuntimeCandidate {
    path: PathBuf,
    origin: CandidateOrigin,
    source: RuntimeSource,
}

#[derive(Debug, Clone)]
struct DiscoveryContext {
    path_entries: Vec<PathBuf>,
    environment: BTreeMap<String, String>,
    managed_root: PathBuf,
    windows: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
struct RuntimeVersion {
    major: u64,
    minor: u64,
    patch: u64,
}

impl RuntimeVersion {
    fn display(self) -> String {
        format!("{}.{}.{}", self.major, self.minor, self.patch)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum OpenCodeRuntimeStatus {
    SystemCompatible,
    ManagedCompatible,
    Incompatible,
    Missing,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenCodeRuntimeDetection {
    pub status: OpenCodeRuntimeStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<RuntimeSource>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub executable_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub executable_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fingerprint_sha256: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

#[derive(Debug, Clone)]
struct TrustedRuntime {
    canonical_path: PathBuf,
    fingerprint_sha256: String,
    version: String,
    source: RuntimeSource,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ResolvedTrustedRuntime {
    pub path: PathBuf,
    pub version: String,
    pub source: RuntimeSource,
}

#[derive(Default)]
pub struct OpenCodeRuntimeState {
    trusted: Mutex<HashMap<String, TrustedRuntime>>,
}

impl OpenCodeRuntimeState {
    fn register(
        &self,
        path: &Path,
        version: String,
        source: RuntimeSource,
    ) -> Result<(String, String), String> {
        let canonical = canonical_native_file(path).ok_or_else(|| {
            "OpenCode executable is no longer a canonical native file.".to_string()
        })?;
        let fingerprint_sha256 = fingerprint_sha256(&canonical)?;
        self.register_verified(&canonical, fingerprint_sha256, version, source)
    }

    fn register_verified(
        &self,
        canonical_path: &Path,
        fingerprint_sha256: String,
        version: String,
        source: RuntimeSource,
    ) -> Result<(String, String), String> {
        let canonical = canonical_native_file(canonical_path).ok_or_else(|| {
            "OpenCode executable is no longer a canonical native file.".to_string()
        })?;
        if canonical != canonical_path {
            return Err("OpenCode executable changed before registry publication.".to_string());
        }
        let mut identity_hasher = Sha256::new();
        identity_hasher.update(canonical.to_string_lossy().as_bytes());
        identity_hasher.update(fingerprint_sha256.as_bytes());
        let identity_hash = format!("{:x}", identity_hasher.finalize());
        let executable_id = format!("opencode-runtime-{}", &identity_hash[..24]);

        self.trusted
            .lock()
            .map_err(|_| "OpenCode runtime registry lock was poisoned.".to_string())?
            .insert(
                executable_id.clone(),
                TrustedRuntime {
                    canonical_path: canonical,
                    fingerprint_sha256: fingerprint_sha256.clone(),
                    version,
                    source,
                },
            );

        Ok((executable_id, fingerprint_sha256))
    }

    pub(crate) fn resolve_trusted(&self, executable_id: &str) -> Result<PathBuf, String> {
        self.resolve_trusted_runtime(executable_id)
            .map(|runtime| runtime.path)
    }

    pub(crate) fn resolve_trusted_runtime(
        &self,
        executable_id: &str,
    ) -> Result<ResolvedTrustedRuntime, String> {
        let trusted = self
            .trusted
            .lock()
            .map_err(|_| "OpenCode runtime registry lock was poisoned.".to_string())?
            .get(executable_id)
            .cloned()
            .ok_or_else(|| "OpenCode executable ID is not registered.".to_string())?;
        let canonical = canonical_native_file(&trusted.canonical_path)
            .ok_or_else(|| "Trusted OpenCode executable is missing or unsafe.".to_string())?;
        let fingerprint = fingerprint_sha256(&canonical)?;
        if canonical != trusted.canonical_path || fingerprint != trusted.fingerprint_sha256 {
            return Err("Trusted OpenCode executable was replaced after discovery.".to_string());
        }
        Ok(ResolvedTrustedRuntime {
            path: canonical,
            version: trusted.version,
            source: trusted.source,
        })
    }
}

fn parse_opencode_version(output: &str) -> Option<RuntimeVersion> {
    output.split_whitespace().find_map(|token| {
        let candidate = token
            .trim_matches(|character: char| {
                !(character.is_ascii_digit() || character == '.' || character == 'v')
            })
            .strip_prefix('v')
            .unwrap_or_else(|| {
                token.trim_matches(|character: char| {
                    !(character.is_ascii_digit() || character == '.')
                })
            });
        let numeric = candidate
            .chars()
            .take_while(|character| character.is_ascii_digit() || *character == '.')
            .collect::<String>();
        let mut parts = numeric.split('.');
        let major = parts.next()?.parse().ok()?;
        let minor = parts.next()?.parse().ok()?;
        let patch = parts.next()?.parse().ok()?;
        if parts.next().is_some() {
            return None;
        }
        Some(RuntimeVersion {
            major,
            minor,
            patch,
        })
    })
}

fn fingerprint_sha256(path: &Path) -> Result<String, String> {
    let mut file = File::open(path)
        .map_err(|error| format!("OpenCode executable could not be read: {error}"))?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1_024];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|error| format!("OpenCode executable could not be fingerprinted: {error}"))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

fn empty_detection(
    status: OpenCodeRuntimeStatus,
    reason: Option<String>,
) -> OpenCodeRuntimeDetection {
    OpenCodeRuntimeDetection {
        status,
        source: None,
        version: None,
        executable_id: None,
        executable_path: None,
        fingerprint_sha256: None,
        reason,
    }
}

fn detect_with_probe<F>(
    state: &OpenCodeRuntimeState,
    context: &DiscoveryContext,
    probe: F,
) -> Result<OpenCodeRuntimeDetection, String>
where
    F: FnMut(&Path) -> Result<String, String>,
{
    detect_with_probe_and_fingerprinter(state, context, probe, fingerprint_sha256)
}

fn detect_with_probe_and_fingerprinter<F, G>(
    state: &OpenCodeRuntimeState,
    context: &DiscoveryContext,
    mut probe: F,
    mut fingerprinter: G,
) -> Result<OpenCodeRuntimeDetection, String>
where
    F: FnMut(&Path) -> Result<String, String>,
    G: FnMut(&Path) -> Result<String, String>,
{
    let candidates = candidate_paths(context);
    if candidates.is_empty() {
        return Ok(empty_detection(OpenCodeRuntimeStatus::Missing, None));
    }

    let mut diagnostics = Vec::new();
    'candidate: for candidate in candidates {
        let fingerprint_before = match fingerprinter(&candidate.path) {
            Ok(fingerprint) => fingerprint,
            Err(error) => {
                diagnostics.push(error);
                continue;
            }
        };
        let mut transient_retries = 0;
        let output = loop {
            match probe(&candidate.path) {
                Ok(output) => break output,
                Err(error)
                    if error == VERSION_PROBE_TIMEOUT_REASON
                        && transient_retries < MAX_TRANSIENT_VERSION_PROBE_RETRIES =>
                {
                    let Some(canonical_retry) = canonical_native_file(&candidate.path) else {
                        diagnostics.push(
                            "OpenCode executable changed during its version probe.".to_string(),
                        );
                        continue 'candidate;
                    };
                    let fingerprint_retry = match fingerprinter(&canonical_retry) {
                        Ok(fingerprint) => fingerprint,
                        Err(error) => {
                            diagnostics.push(error);
                            continue 'candidate;
                        }
                    };
                    if canonical_retry != candidate.path || fingerprint_retry != fingerprint_before
                    {
                        diagnostics.push(
                            "OpenCode executable changed during its version probe.".to_string(),
                        );
                        continue 'candidate;
                    }
                    transient_retries += 1;
                }
                Err(error) => {
                    diagnostics.push(error);
                    continue 'candidate;
                }
            }
        };
        let Some(canonical_after) = canonical_native_file(&candidate.path) else {
            diagnostics.push("OpenCode executable changed during its version probe.".to_string());
            continue;
        };
        let fingerprint_after = match fingerprinter(&canonical_after) {
            Ok(fingerprint) => fingerprint,
            Err(error) => {
                diagnostics.push(error);
                continue;
            }
        };
        if canonical_after != candidate.path || fingerprint_after != fingerprint_before {
            diagnostics.push("OpenCode executable changed during its version probe.".to_string());
            continue;
        }
        let Some(version) = parse_opencode_version(&output) else {
            diagnostics.push("OpenCode returned an unreadable version.".to_string());
            continue;
        };
        if version < MINIMUM_OPENCODE_VERSION {
            diagnostics.push(format!(
                "OpenCode {} is older than required {}.",
                version.display(),
                MINIMUM_OPENCODE_VERSION.display()
            ));
            continue;
        }

        let version = version.display();
        let (executable_id, fingerprint_sha256) = match state.register_verified(
            &canonical_after,
            fingerprint_after,
            version.clone(),
            candidate.source,
        ) {
            Ok(registration) => registration,
            Err(error) => {
                diagnostics.push(error);
                continue;
            }
        };
        let status = match candidate.source {
            RuntimeSource::System => OpenCodeRuntimeStatus::SystemCompatible,
            RuntimeSource::Managed => OpenCodeRuntimeStatus::ManagedCompatible,
        };
        return Ok(OpenCodeRuntimeDetection {
            status,
            source: Some(candidate.source),
            version: Some(version),
            executable_id: Some(executable_id),
            executable_path: Some(candidate.path.to_string_lossy().into_owned()),
            fingerprint_sha256: Some(fingerprint_sha256),
            reason: None,
        });
    }

    let reason = format!(
        "No native OpenCode candidate met minimum version {}. {}",
        MINIMUM_OPENCODE_VERSION.display(),
        diagnostics.join(" ")
    );
    Ok(empty_detection(
        OpenCodeRuntimeStatus::Incompatible,
        Some(reason.chars().take(MAX_REASON_LENGTH).collect()),
    ))
}

fn production_context(managed_root: PathBuf) -> DiscoveryContext {
    let path_entries = std::env::var_os("PATH")
        .map(|value| std::env::split_paths(&value).collect())
        .unwrap_or_default();
    let environment = [
        "SCOOP",
        "USERPROFILE",
        "ChocolateyInstall",
        "LOCALAPPDATA",
        "APPDATA",
    ]
    .into_iter()
    .filter_map(|key| {
        std::env::var_os(key).map(|value| (key.to_string(), value.to_string_lossy().into_owned()))
    })
    .collect();
    DiscoveryContext {
        path_entries,
        environment,
        managed_root,
        windows: cfg!(windows),
    }
}

fn read_bounded(mut reader: impl Read, maximum: usize) -> Vec<u8> {
    let mut kept = Vec::new();
    let mut buffer = [0_u8; 1_024];
    loop {
        let Ok(read) = reader.read(&mut buffer) else {
            break;
        };
        if read == 0 {
            break;
        }
        let remaining = maximum.saturating_sub(kept.len());
        kept.extend_from_slice(&buffer[..read.min(remaining)]);
    }
    kept
}

fn probe_native_version(path: &Path) -> Result<String, String> {
    let mut command = Command::new(path);
    command
        .arg("--version")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP | CREATE_SUSPENDED);

    #[cfg(windows)]
    let probe_job = version_probe_job::ProbeJob::create()?;

    let mut child = command
        .spawn()
        .map_err(|error| format!("OpenCode version probe could not start: {error}"))?;
    let Some(stdout) = child.stdout.take() else {
        let _ = child.kill();
        let _ = child.wait();
        return Err("OpenCode version probe stdout was unavailable.".to_string());
    };
    let Some(stderr) = child.stderr.take() else {
        let _ = child.kill();
        let _ = child.wait();
        return Err("OpenCode version probe stderr was unavailable.".to_string());
    };
    #[cfg(windows)]
    if let Err(error) = probe_job.assign_and_resume(&child) {
        version_probe_job::reap_failed_containment(&mut child, probe_job);
        return Err(error);
    }
    let stdout_reader = thread::spawn(move || read_bounded(stdout, MAX_VERSION_OUTPUT_LENGTH));
    let stderr_reader = thread::spawn(move || read_bounded(stderr, MAX_VERSION_OUTPUT_LENGTH));
    let started = Instant::now();

    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Ok(status),
            Ok(None) => {}
            Err(error) => {
                break Err(format!(
                    "OpenCode version probe could not be observed: {error}"
                ));
            }
        }
        if started.elapsed() >= VERSION_PROBE_TIMEOUT {
            break Err(VERSION_PROBE_TIMEOUT_REASON.to_string());
        }
        thread::sleep(Duration::from_millis(20));
    };

    #[cfg(windows)]
    {
        // A successful parent may still have descendants holding inherited pipes. Terminating
        // and closing the owned job makes both reader joins finite before this function returns.
        probe_job.terminate();
        drop(probe_job);
    }
    #[cfg(not(windows))]
    if status.is_err() {
        let _ = child.kill();
    }
    let _ = child.wait();
    let stdout = stdout_reader
        .join()
        .map_err(|_| "OpenCode version probe stdout reader failed.".to_string())?;
    let stderr = stderr_reader
        .join()
        .map_err(|_| "OpenCode version probe stderr reader failed.".to_string())?;
    let status = status?;
    if !status.success() {
        return Err(format!(
            "OpenCode version probe exited with code {}.",
            status.code().unwrap_or(-1)
        ));
    }

    let output = if stdout.is_empty() { stderr } else { stdout };
    String::from_utf8(output)
        .map(|value| value.trim().to_string())
        .map_err(|_| "OpenCode version output was not valid UTF-8.".to_string())
}

#[tauri::command]
pub async fn opencode_runtime_detect(app: AppHandle) -> Result<OpenCodeRuntimeDetection, String> {
    let worker_app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let state = worker_app.state::<OpenCodeRuntimeState>();
        detect_opencode_runtime(&worker_app, state.inner())
    })
    .await
    .map_err(|_| "OpenCode runtime detection worker failed.".to_string())?
}

pub fn detect_opencode_runtime(
    app: &AppHandle,
    state: &OpenCodeRuntimeState,
) -> Result<OpenCodeRuntimeDetection, String> {
    let managed_root = app
        .path()
        .app_local_data_dir()
        .map_err(|error| format!("VibeSpace app-local-data path is unavailable: {error}"))?
        .join("runtimes")
        .join("opencode");
    detect_with_probe(
        state,
        &production_context(managed_root),
        probe_native_version,
    )
}

fn executable_name(windows: bool) -> &'static str {
    if windows {
        "opencode.exe"
    } else {
        "opencode"
    }
}

fn canonical_native_file(path: &Path) -> Option<PathBuf> {
    let has_blocked_extension = |candidate: &Path| {
        let extension = candidate
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or_default();
        ["cmd", "bat", "ps1"]
            .iter()
            .any(|blocked| extension.eq_ignore_ascii_case(blocked))
    };
    if has_blocked_extension(path) {
        return None;
    }

    let canonical = fs::canonicalize(path).ok()?;
    if has_blocked_extension(&canonical) {
        return None;
    }
    let file_name = canonical
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or_default();
    if file_name != "opencode" && !file_name.eq_ignore_ascii_case("opencode.exe") {
        return None;
    }
    if !fs::metadata(&canonical).ok()?.is_file() {
        return None;
    }
    Some(canonical)
}

fn push_candidate(
    output: &mut Vec<RuntimeCandidate>,
    seen: &mut BTreeSet<PathBuf>,
    path: PathBuf,
    origin: CandidateOrigin,
    source: RuntimeSource,
) {
    let Some(canonical) = canonical_native_file(&path) else {
        return;
    };
    if seen.insert(canonical.clone()) {
        output.push(RuntimeCandidate {
            path: canonical,
            origin,
            source,
        });
    }
}

fn environment_path(context: &DiscoveryContext, key: &str) -> Option<PathBuf> {
    context.environment.get(key).map(PathBuf::from)
}

fn candidate_paths(context: &DiscoveryContext) -> Vec<RuntimeCandidate> {
    let mut output = Vec::new();
    let mut seen = BTreeSet::new();
    let native_name = executable_name(context.windows);

    for directory in &context.path_entries {
        push_candidate(
            &mut output,
            &mut seen,
            directory.join(native_name),
            CandidateOrigin::Path,
            RuntimeSource::System,
        );
    }

    let scoop_root = environment_path(context, "SCOOP")
        .or_else(|| environment_path(context, "USERPROFILE").map(|root| root.join("scoop")));
    if let Some(root) = scoop_root {
        push_candidate(
            &mut output,
            &mut seen,
            root.join("apps")
                .join("opencode")
                .join("current")
                .join(native_name),
            CandidateOrigin::Scoop,
            RuntimeSource::System,
        );
    }

    if let Some(root) = environment_path(context, "ChocolateyInstall") {
        push_candidate(
            &mut output,
            &mut seen,
            root.join("bin").join(native_name),
            CandidateOrigin::Chocolatey,
            RuntimeSource::System,
        );
    }

    if let Some(root) = environment_path(context, "LOCALAPPDATA") {
        push_candidate(
            &mut output,
            &mut seen,
            root.join("Programs").join("opencode").join(native_name),
            CandidateOrigin::Standalone,
            RuntimeSource::System,
        );
    }
    if let Some(root) = environment_path(context, "USERPROFILE") {
        push_candidate(
            &mut output,
            &mut seen,
            root.join(".opencode").join("bin").join(native_name),
            CandidateOrigin::Standalone,
            RuntimeSource::System,
        );
    }

    if let Some(root) = environment_path(context, "APPDATA") {
        let npm_modules = root.join("npm").join("node_modules");
        if context.windows {
            let native_packages: &[&str] = match std::env::consts::ARCH {
                "x86_64" => &["opencode-windows-x64", "opencode-windows-x64-baseline"],
                "aarch64" => &["opencode-windows-arm64"],
                _ => &[],
            };
            // Optional packages hold the native executable even when npm's postinstall
            // has not replaced the wrapper. Keep these inside the normal verified probe.
            for package in native_packages {
                for modules in [
                    npm_modules.join("opencode-ai").join("node_modules"),
                    npm_modules.clone(),
                ] {
                    push_candidate(
                        &mut output,
                        &mut seen,
                        modules.join(package).join("bin").join(native_name),
                        CandidateOrigin::NpmNative,
                        RuntimeSource::System,
                    );
                }
            }
        }
        push_candidate(
            &mut output,
            &mut seen,
            npm_modules
                .join("opencode-ai")
                .join("bin")
                .join(native_name),
            CandidateOrigin::NpmNative,
            RuntimeSource::System,
        );
    }

    let mut managed_versions = fs::read_dir(&context.managed_root)
        .ok()
        .into_iter()
        .flatten()
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false))
        .map(|entry| entry.path())
        .collect::<Vec<_>>();
    managed_versions.sort();
    managed_versions.reverse();
    for version_root in managed_versions {
        push_candidate(
            &mut output,
            &mut seen,
            version_root.join(native_name),
            CandidateOrigin::Managed,
            RuntimeSource::Managed,
        );
    }

    output
}

#[cfg(test)]
mod tests {
    use super::{
        candidate_paths, detect_with_probe, detect_with_probe_and_fingerprinter,
        fingerprint_sha256, parse_opencode_version, probe_native_version, CandidateOrigin,
        DiscoveryContext, OpenCodeRuntimeState, OpenCodeRuntimeStatus, RuntimeSource,
    };
    #[cfg(windows)]
    use super::{
        read_bounded, CREATE_NEW_PROCESS_GROUP, CREATE_NO_WINDOW, CREATE_SUSPENDED,
        MAX_VERSION_OUTPUT_LENGTH,
    };
    use std::cell::Cell;
    use std::collections::BTreeMap;
    use std::fs;
    use std::path::{Path, PathBuf};
    #[cfg(windows)]
    use std::process::{Command, Stdio};
    use std::sync::atomic::{AtomicU64, Ordering};
    #[cfg(windows)]
    use std::thread;
    use std::time::{Duration, Instant};

    static FIXTURE_SEQUENCE: AtomicU64 = AtomicU64::new(0);

    #[test]
    fn runtime_detection_command_offloads_blocking_discovery() {
        let source = include_str!("runtime.rs");
        let command = source
            .split("pub async fn opencode_runtime_detect")
            .nth(1)
            .and_then(|remainder| remainder.split("pub fn detect_opencode_runtime").next())
            .expect("runtime detection command must remain async");

        assert!(
            command.contains("tauri::async_runtime::spawn_blocking"),
            "runtime detection must not hash files or probe child processes on the command handler"
        );
    }

    struct FixtureRoot(PathBuf);

    impl FixtureRoot {
        fn new(name: &str) -> Self {
            let sequence = FIXTURE_SEQUENCE.fetch_add(1, Ordering::Relaxed);
            let path = std::env::temp_dir().join(format!(
                "vibespace-opencode-runtime-{name}-{}-{sequence}",
                std::process::id()
            ));
            fs::create_dir_all(&path).expect("fixture root");
            Self(path)
        }

        fn native(&self, relative: &str) -> PathBuf {
            let path = self.0.join(relative);
            fs::create_dir_all(path.parent().expect("fixture parent")).expect("fixture parent");
            fs::write(&path, b"synthetic native executable").expect("fixture executable");
            path
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

    fn context(
        path_entries: Vec<PathBuf>,
        environment: BTreeMap<String, String>,
        managed_root: PathBuf,
    ) -> DiscoveryContext {
        DiscoveryContext {
            path_entries,
            environment,
            managed_root,
            windows: true,
        }
    }

    #[test]
    fn candidate_discovery_is_deterministic_across_supported_native_locations() {
        let fixture = FixtureRoot::new("locations");
        let path_root = fixture.path().join("path-bin");
        let path_binary = fixture.native("path-bin/opencode.exe");
        let scoop_binary = fixture.native("scoop/apps/opencode/current/opencode.exe");
        let chocolatey_binary = fixture.native("chocolatey/bin/opencode.exe");
        let standalone_binary = fixture.native("local/Programs/opencode/opencode.exe");
        let npm_binary = fixture.native("roaming/npm/node_modules/opencode-ai/bin/opencode.exe");
        let managed_binary = fixture.native("managed/1.18.16/opencode.exe");

        let environment = BTreeMap::from([
            (
                "SCOOP".to_string(),
                fixture.path().join("scoop").to_string_lossy().into_owned(),
            ),
            (
                "ChocolateyInstall".to_string(),
                fixture
                    .path()
                    .join("chocolatey")
                    .to_string_lossy()
                    .into_owned(),
            ),
            (
                "LOCALAPPDATA".to_string(),
                fixture.path().join("local").to_string_lossy().into_owned(),
            ),
            (
                "APPDATA".to_string(),
                fixture
                    .path()
                    .join("roaming")
                    .to_string_lossy()
                    .into_owned(),
            ),
        ]);

        let candidates = candidate_paths(&context(
            vec![path_root],
            environment,
            fixture.path().join("managed"),
        ));

        let expected = [
            (path_binary, CandidateOrigin::Path, RuntimeSource::System),
            (scoop_binary, CandidateOrigin::Scoop, RuntimeSource::System),
            (
                chocolatey_binary,
                CandidateOrigin::Chocolatey,
                RuntimeSource::System,
            ),
            (
                standalone_binary,
                CandidateOrigin::Standalone,
                RuntimeSource::System,
            ),
            (
                npm_binary,
                CandidateOrigin::NpmNative,
                RuntimeSource::System,
            ),
            (
                managed_binary,
                CandidateOrigin::Managed,
                RuntimeSource::Managed,
            ),
        ];

        assert_eq!(candidates.len(), expected.len());
        for (candidate, (path, origin, source)) in candidates.iter().zip(expected) {
            assert_eq!(candidate.path, fs::canonicalize(path).unwrap());
            assert_eq!(candidate.origin, origin);
            assert_eq!(candidate.source, source);
        }
    }

    #[test]
    #[cfg(target_arch = "x86_64")]
    fn candidate_discovery_finds_npm_optional_native_binaries_before_wrapper() {
        let fixture = FixtureRoot::new("npm-optional-native");
        let nested = fixture.native(
            "roaming/npm/node_modules/opencode-ai/node_modules/opencode-windows-x64/bin/opencode.exe",
        );
        let hoisted = fixture
            .native("roaming/npm/node_modules/opencode-windows-x64-baseline/bin/opencode.exe");
        let wrapper = fixture.native("roaming/npm/node_modules/opencode-ai/bin/opencode.exe");
        fs::write(&wrapper, b"echo postinstall was not run\nexit 1").unwrap();
        let managed = fixture.native("managed/1.18.16/opencode.exe");
        let candidates = candidate_paths(&context(
            Vec::new(),
            BTreeMap::from([(
                "APPDATA".to_string(),
                fixture
                    .path()
                    .join("roaming")
                    .to_string_lossy()
                    .into_owned(),
            )]),
            fixture.path().join("managed"),
        ));
        assert_eq!(candidates.len(), 4);
        for (candidate, expected) in candidates.iter().zip([nested, hoisted, wrapper, managed]) {
            assert_eq!(candidate.path, fs::canonicalize(expected).unwrap());
        }
        assert_eq!(candidates[0].origin, CandidateOrigin::NpmNative);
        assert_eq!(candidates[0].source, RuntimeSource::System);
    }

    #[test]
    fn candidate_discovery_rejects_script_shims_and_deduplicates_canonical_paths() {
        let fixture = FixtureRoot::new("shims");
        let native = fixture.native("bin/opencode.exe");
        fs::write(fixture.path().join("bin/opencode.cmd"), b"echo unsafe").unwrap();
        fs::write(
            fixture.path().join("bin/opencode.ps1"),
            b"Write-Host unsafe",
        )
        .unwrap();

        let candidates = candidate_paths(&context(
            vec![fixture.path().join("bin"), fixture.path().join("bin")],
            BTreeMap::new(),
            fixture.path().join("missing-managed"),
        ));

        assert_eq!(candidates.len(), 1);
        assert_eq!(candidates[0].path, fs::canonicalize(native).unwrap());
        assert_eq!(candidates[0].origin, CandidateOrigin::Path);
    }

    #[test]
    fn candidate_discovery_returns_empty_for_a_missing_runtime() {
        let fixture = FixtureRoot::new("missing");

        assert!(candidate_paths(&context(
            vec![fixture.path().join("empty")],
            BTreeMap::new(),
            fixture.path().join("managed"),
        ))
        .is_empty());
    }

    #[test]
    fn detection_version_parser_accepts_supported_shapes_and_orders_versions() {
        let minimum = parse_opencode_version("opencode 1.18.16").expect("minimum version");
        let prefixed = parse_opencode_version("v1.18.16").expect("prefixed version");
        let newer = parse_opencode_version("OpenCode 2.0.1 (windows-x64)").expect("newer version");

        assert_eq!(minimum, prefixed);
        assert!(newer > minimum);
        assert!(parse_opencode_version("OpenCode unknown").is_none());
        assert!(parse_opencode_version("1.18").is_none());
    }

    #[test]
    fn detection_selects_a_compatible_system_runtime_without_hidden_substitution() {
        let fixture = FixtureRoot::new("detect-system");
        let system_binary = fixture.native("system/opencode.exe");
        let managed_binary = fixture.native("managed/1.18.16/opencode.exe");
        let context = context(
            vec![fixture.path().join("system")],
            BTreeMap::new(),
            fixture.path().join("managed"),
        );
        let state = OpenCodeRuntimeState::default();

        let result = detect_with_probe(&state, &context, |path| {
            if path == fs::canonicalize(&system_binary).unwrap() {
                Ok("opencode 1.18.16".to_string())
            } else if path == fs::canonicalize(&managed_binary).unwrap() {
                Ok("opencode 9.9.9".to_string())
            } else {
                Err("unexpected candidate".to_string())
            }
        })
        .expect("runtime detection");

        assert_eq!(result.status, OpenCodeRuntimeStatus::SystemCompatible);
        assert_eq!(result.source, Some(RuntimeSource::System));
        assert_eq!(result.version.as_deref(), Some("1.18.16"));
        assert_eq!(
            result.executable_path.as_deref(),
            Some(
                fs::canonicalize(system_binary)
                    .unwrap()
                    .to_string_lossy()
                    .as_ref()
            )
        );
        assert!(result
            .executable_id
            .as_deref()
            .is_some_and(|value| value.starts_with("opencode-runtime-")));
        assert_eq!(result.fingerprint_sha256.as_deref().map(str::len), Some(64));
    }

    #[test]
    fn detection_fingerprints_a_successful_candidate_exactly_before_and_after_probe() {
        let fixture = FixtureRoot::new("detect-two-fingerprints");
        fixture.native("system/opencode.exe");
        let context = context(
            vec![fixture.path().join("system")],
            BTreeMap::new(),
            fixture.path().join("missing-managed"),
        );
        let fingerprint_reads = Cell::new(0_u8);

        let result = detect_with_probe_and_fingerprinter(
            &OpenCodeRuntimeState::default(),
            &context,
            |_| Ok("opencode 1.18.16".to_string()),
            |path| {
                fingerprint_reads.set(fingerprint_reads.get() + 1);
                fingerprint_sha256(path)
            },
        )
        .expect("runtime detection");

        assert_eq!(result.status, OpenCodeRuntimeStatus::SystemCompatible);
        assert_eq!(fingerprint_reads.get(), 2);
    }

    #[test]
    fn detection_retries_one_transient_timeout_with_identity_checks() {
        let fixture = FixtureRoot::new("detect-transient-timeout");
        fixture.native("roaming/npm/node_modules/opencode-ai/bin/opencode.exe");
        let context = context(
            Vec::new(),
            BTreeMap::from([(
                "APPDATA".to_string(),
                fixture
                    .path()
                    .join("roaming")
                    .to_string_lossy()
                    .into_owned(),
            )]),
            fixture.path().join("missing-managed"),
        );
        let probe_attempts = Cell::new(0_u8);
        let fingerprint_reads = Cell::new(0_u8);

        let result = detect_with_probe_and_fingerprinter(
            &OpenCodeRuntimeState::default(),
            &context,
            |_| {
                probe_attempts.set(probe_attempts.get() + 1);
                if probe_attempts.get() == 1 {
                    Err("OpenCode version probe timed out.".to_string())
                } else {
                    Ok("opencode 1.18.23".to_string())
                }
            },
            |path| {
                fingerprint_reads.set(fingerprint_reads.get() + 1);
                fingerprint_sha256(path)
            },
        )
        .expect("transient timeout recovery");

        assert_eq!(result.status, OpenCodeRuntimeStatus::SystemCompatible);
        assert_eq!(result.version.as_deref(), Some("1.18.23"));
        assert_eq!(probe_attempts.get(), 2);
        assert_eq!(fingerprint_reads.get(), 3);
    }

    #[cfg(windows)]
    #[test]
    fn contained_probe_terminates_descendant_inheriting_both_output_pipes() {
        use std::os::windows::process::CommandExt;

        let fixture = FixtureRoot::new("probe-descendant");
        let pid_file = fixture.path().join("descendant.pid");
        let escaped_pid_file = pid_file.to_string_lossy().replace('\'', "''");
        let script = format!(
            "$p=Start-Process -FilePath $env:ComSpec -ArgumentList '/d','/c','ping.exe 127.0.0.1 -t' -NoNewWindow -PassThru; Set-Content -LiteralPath '{escaped_pid_file}' -Value $p.Id; Wait-Process -Id $p.Id"
        );
        let mut command = Command::new("powershell.exe");
        command
            .args(["-NoProfile", "-NonInteractive", "-Command", &script])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        command.creation_flags(CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP | CREATE_SUSPENDED);
        let job = super::version_probe_job::ProbeJob::create().unwrap();
        let mut child = command.spawn().unwrap();
        let stdout = child.stdout.take().unwrap();
        let stderr = child.stderr.take().unwrap();
        let stdout_reader = thread::spawn(move || read_bounded(stdout, MAX_VERSION_OUTPUT_LENGTH));
        let stderr_reader = thread::spawn(move || read_bounded(stderr, MAX_VERSION_OUTPUT_LENGTH));
        job.assign_and_resume(&child).unwrap();
        let deadline = Instant::now() + Duration::from_secs(3);
        while !pid_file.exists() && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(20));
        }
        let descendant_pid = fs::read_to_string(&pid_file).expect("descendant pid");
        let started = Instant::now();
        job.terminate();
        child.wait().unwrap();
        stdout_reader.join().unwrap();
        stderr_reader.join().unwrap();
        assert!(started.elapsed() < Duration::from_secs(2));

        let tasklist = Command::new("tasklist.exe")
            .args(["/FI", &format!("PID eq {}", descendant_pid.trim()), "/NH"])
            .output()
            .unwrap();
        assert!(!String::from_utf8_lossy(&tasklist.stdout).contains(descendant_pid.trim()));
    }

    #[cfg(windows)]
    #[test]
    fn failed_job_assignment_path_kills_uncontained_suspended_child_before_wait() {
        use std::os::windows::process::CommandExt;

        let mut command = Command::new("powershell.exe");
        command
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "Start-Sleep -Seconds 30",
            ])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        command.creation_flags(CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP | CREATE_SUSPENDED);
        let mut child = command.spawn().unwrap();
        let job = super::version_probe_job::ProbeJob::create().unwrap();
        let started = Instant::now();

        super::version_probe_job::reap_failed_containment(&mut child, job);

        assert!(started.elapsed() < Duration::from_secs(2));
        assert!(child.try_wait().unwrap().is_some());
    }

    #[test]
    fn detection_skips_incompatible_system_runtime_for_compatible_managed_runtime() {
        let fixture = FixtureRoot::new("detect-managed");
        let system_binary = fixture.native("system/opencode.exe");
        let managed_binary = fixture.native("managed/1.18.16/opencode.exe");
        let context = context(
            vec![fixture.path().join("system")],
            BTreeMap::new(),
            fixture.path().join("managed"),
        );
        let system_canonical = fs::canonicalize(system_binary).unwrap();
        let managed_canonical = fs::canonicalize(managed_binary).unwrap();

        let result = detect_with_probe(&OpenCodeRuntimeState::default(), &context, |path| {
            if path == system_canonical {
                Ok("opencode 1.17.9".to_string())
            } else if path == managed_canonical {
                Ok("v1.18.16".to_string())
            } else {
                Err("unexpected candidate".to_string())
            }
        })
        .expect("managed fallback");

        assert_eq!(result.status, OpenCodeRuntimeStatus::ManagedCompatible);
        assert_eq!(result.source, Some(RuntimeSource::Managed));
        assert_eq!(result.version.as_deref(), Some("1.18.16"));
    }

    #[test]
    fn detection_reports_incompatible_or_missing_truthfully() {
        let fixture = FixtureRoot::new("detect-failure");
        fixture.native("system/opencode.exe");
        let incompatible = detect_with_probe(
            &OpenCodeRuntimeState::default(),
            &context(
                vec![fixture.path().join("system")],
                BTreeMap::new(),
                fixture.path().join("managed"),
            ),
            |_| Ok("opencode 1.2.3".to_string()),
        )
        .expect("incompatible detection");
        let missing = detect_with_probe(
            &OpenCodeRuntimeState::default(),
            &context(
                vec![fixture.path().join("missing")],
                BTreeMap::new(),
                fixture.path().join("missing-managed"),
            ),
            |_| Err("must not probe".to_string()),
        )
        .expect("missing detection");

        assert_eq!(incompatible.status, OpenCodeRuntimeStatus::Incompatible);
        assert!(incompatible
            .reason
            .as_deref()
            .is_some_and(|reason| reason.contains("1.18.16")));
        assert!(incompatible
            .reason
            .as_deref()
            .is_some_and(|reason| reason.len() <= 2_048));
        assert_eq!(missing.status, OpenCodeRuntimeStatus::Missing);
        assert_eq!(missing.source, None);
        assert_eq!(missing.executable_id, None);
    }

    #[test]
    fn detection_native_probe_rejects_non_executable_bytes() {
        let fixture = FixtureRoot::new("detect-invalid-native");
        let executable = fixture.native("bin/opencode.exe");

        assert!(probe_native_version(&executable).is_err());
    }

    #[test]
    fn detection_rejects_an_executable_replaced_during_the_version_probe() {
        let fixture = FixtureRoot::new("detect-probe-replacement");
        fixture.native("bin/opencode.exe");

        let result = detect_with_probe(
            &OpenCodeRuntimeState::default(),
            &context(
                vec![fixture.path().join("bin")],
                BTreeMap::new(),
                fixture.path().join("managed"),
            ),
            |path| {
                fs::write(path, b"replacement during probe").unwrap();
                Ok("opencode 1.18.16".to_string())
            },
        )
        .expect("replacement detection");

        assert_eq!(result.status, OpenCodeRuntimeStatus::Incompatible);
        assert!(result
            .reason
            .as_deref()
            .is_some_and(|reason| reason.contains("changed during its version probe")));
        assert_eq!(result.executable_id, None);
    }

    #[test]
    fn detection_statuses_serialize_to_the_frontend_contract() {
        assert_eq!(
            serde_json::to_value(OpenCodeRuntimeStatus::SystemCompatible).unwrap(),
            "systemCompatible"
        );
        assert_eq!(
            serde_json::to_value(OpenCodeRuntimeStatus::ManagedCompatible).unwrap(),
            "managedCompatible"
        );
        assert_eq!(
            serde_json::to_value(OpenCodeRuntimeStatus::Incompatible).unwrap(),
            "incompatible"
        );
        assert_eq!(
            serde_json::to_value(OpenCodeRuntimeStatus::Missing).unwrap(),
            "missing"
        );
    }

    #[test]
    fn registry_uses_an_opaque_identity_and_resolves_an_unchanged_executable() {
        let fixture = FixtureRoot::new("registry-unchanged");
        let executable = fixture.native("bin/opencode.exe");
        let canonical = fs::canonicalize(&executable).unwrap();
        let state = OpenCodeRuntimeState::default();

        let (executable_id, fingerprint) = state
            .register(&canonical, "1.18.16".to_string(), RuntimeSource::System)
            .expect("registration");

        assert_ne!(executable_id, canonical.to_string_lossy());
        assert!(executable_id.starts_with("opencode-runtime-"));
        assert_eq!(fingerprint.len(), 64);
        assert_eq!(
            state.resolve_trusted(&executable_id).expect("resolution"),
            canonical
        );
        assert_eq!(
            state
                .resolve_trusted_runtime(&executable_id)
                .expect("runtime metadata")
                .version,
            "1.18.16"
        );
        assert_eq!(
            state
                .resolve_trusted_runtime(&executable_id)
                .expect("runtime source")
                .source,
            RuntimeSource::System
        );
    }

    #[test]
    fn registry_rejects_replaced_or_deleted_executables() {
        let fixture = FixtureRoot::new("registry-replaced");
        let executable = fixture.native("bin/opencode.exe");
        let state = OpenCodeRuntimeState::default();
        let (executable_id, _) = state
            .register(&executable, "1.18.16".to_string(), RuntimeSource::System)
            .expect("registration");

        fs::write(&executable, b"replacement bytes").unwrap();
        assert!(state
            .resolve_trusted(&executable_id)
            .expect_err("replacement must fail")
            .contains("replaced"));

        let deleted = fixture.native("deleted/opencode.exe");
        let (deleted_id, _) = state
            .register(&deleted, "1.18.16".to_string(), RuntimeSource::System)
            .expect("deleted registration");
        fs::remove_file(deleted).unwrap();
        assert!(state.resolve_trusted(&deleted_id).is_err());
    }

    #[test]
    fn registry_rejects_directories_and_windows_script_shims() {
        let fixture = FixtureRoot::new("registry-unsafe");
        let shim = fixture.native("bin/opencode.cmd");
        let arbitrary = fixture.native("bin/not-opencode.exe");
        let state = OpenCodeRuntimeState::default();

        assert!(state
            .register(fixture.path(), "1.18.16".to_string(), RuntimeSource::System,)
            .is_err());
        assert!(state
            .register(&shim, "1.18.16".to_string(), RuntimeSource::System)
            .is_err());
        assert!(state
            .register(&arbitrary, "1.18.16".to_string(), RuntimeSource::System,)
            .is_err());
    }
}
