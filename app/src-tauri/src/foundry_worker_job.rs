use std::process::{Child, ChildStderr, ChildStdout, Command, ExitStatus};

#[cfg(windows)]
use std::ffi::c_void;
#[cfg(windows)]
use std::mem::size_of;
#[cfg(windows)]
use std::os::windows::io::AsRawHandle;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;
#[cfg(windows)]
const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
#[cfg(windows)]
const CREATE_SUSPENDED: u32 = 0x0000_0004;

#[cfg(windows)]
use windows::core::PCWSTR;
#[cfg(windows)]
use windows::Win32::Foundation::{CloseHandle, HANDLE};
#[cfg(windows)]
use windows::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Thread32First, Thread32Next, TH32CS_SNAPTHREAD, THREADENTRY32,
};
#[cfg(windows)]
use windows::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JobObjectBasicAccountingInformation,
    JobObjectExtendedLimitInformation, QueryInformationJobObject, SetInformationJobObject,
    TerminateJobObject, JOBOBJECT_BASIC_ACCOUNTING_INFORMATION,
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
};
#[cfg(windows)]
use windows::Win32::System::Threading::{OpenThread, ResumeThread, THREAD_SUSPEND_RESUME};

#[cfg(windows)]
struct OwnedHandle(HANDLE);

#[cfg(windows)]
impl Drop for OwnedHandle {
    fn drop(&mut self) {
        let _ = unsafe { CloseHandle(self.0) };
    }
}

#[cfg(windows)]
struct ProcessTreeJob(OwnedHandle);

#[cfg(windows)]
// Job handles are process-wide kernel handles with unique Rust ownership.
unsafe impl Send for ProcessTreeJob {}

#[cfg(windows)]
impl ProcessTreeJob {
    fn create() -> Result<Self, String> {
        let handle = unsafe { CreateJobObjectW(None, PCWSTR::null()) }
            .map_err(|error| format!("Could not create the Model Foundry worker job: {error}"))?;
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
        .map_err(|error| format!("Could not configure the Model Foundry worker job: {error}"))?;
        Ok(job)
    }

    fn assign_and_resume(&self, child: &Child) -> Result<(), String> {
        unsafe { AssignProcessToJobObject(self.0 .0, HANDLE(child.as_raw_handle())) }
            .map_err(|error| format!("Could not contain the Model Foundry worker: {error}"))?;

        let snapshot = OwnedHandle(
            unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0) }.map_err(|error| {
                format!("Could not inspect the worker's suspended thread: {error}")
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
                            "The suspended Model Foundry worker exposed multiple threads.".into(),
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
                        "The suspended Model Foundry worker thread was unavailable.".to_string()
                    })?,
                )
            }
            .map_err(|error| format!("Could not open the worker's suspended thread: {error}"))?,
        );
        if unsafe { ResumeThread(thread.0) } != 1 {
            return Err(
                "The suspended Model Foundry worker could not be resumed exactly once.".into(),
            );
        }
        Ok(())
    }

    fn terminate(&self) -> Result<(), String> {
        unsafe { TerminateJobObject(self.0 .0, 1) }
            .map_err(|error| format!("Could not terminate the Model Foundry worker tree: {error}"))
    }

    fn is_empty(&self) -> Result<bool, String> {
        let mut info = JOBOBJECT_BASIC_ACCOUNTING_INFORMATION::default();
        unsafe {
            QueryInformationJobObject(
                Some(self.0 .0),
                JobObjectBasicAccountingInformation,
                (&mut info as *mut JOBOBJECT_BASIC_ACCOUNTING_INFORMATION).cast::<c_void>(),
                size_of::<JOBOBJECT_BASIC_ACCOUNTING_INFORMATION>() as u32,
                None,
            )
        }
        .map_err(|error| format!("Could not verify Model Foundry worker tree closure: {error}"))?;
        Ok(info.ActiveProcesses == 0)
    }
}

pub(crate) struct WorkerChild {
    child: Child,
    #[cfg(windows)]
    job: ProcessTreeJob,
}

impl WorkerChild {
    pub(crate) fn spawn(command: &mut Command) -> Result<Self, String> {
        #[cfg(windows)]
        {
            let job = ProcessTreeJob::create()?;
            command.creation_flags(CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP | CREATE_SUSPENDED);
            let mut child = command.spawn().map_err(|error| {
                format!("Could not start the local Model Foundry worker: {error}")
            })?;
            if let Err(error) = job.assign_and_resume(&child) {
                let _ = job.terminate();
                let _ = child.kill();
                let reap = child.wait();
                let cleanup = reap
                    .err()
                    .map(|error| format!("; child reap failed: {error}"));
                return Err(format!("{error}{}", cleanup.unwrap_or_default()));
            }
            Ok(Self { child, job })
        }
        #[cfg(not(windows))]
        {
            let child = command.spawn().map_err(|error| {
                format!("Could not start the local Model Foundry worker: {error}")
            })?;
            Ok(Self { child })
        }
    }

    pub(crate) fn take_pipes(&mut self) -> (Option<ChildStdout>, Option<ChildStderr>) {
        (self.child.stdout.take(), self.child.stderr.take())
    }

    pub(crate) fn try_wait(&mut self) -> Result<Option<ExitStatus>, String> {
        let status = self
            .child
            .try_wait()
            .map_err(|error| format!("Could not inspect the Model Foundry worker: {error}"))?;
        #[cfg(windows)]
        if !self
            .job
            .is_empty()
            .map_err(|error| format!("Could not inspect the Model Foundry worker tree: {error}"))?
        {
            return Ok(None);
        }
        Ok(status)
    }

    pub(crate) fn terminate_tree(&mut self) -> Result<(), String> {
        #[cfg(windows)]
        {
            if let Err(tree_error) = self.job.terminate() {
                if self.child.try_wait().ok().flatten().is_none() {
                    let _ = self.child.kill();
                }
                return Err(tree_error);
            }
            Ok(())
        }
        #[cfg(not(windows))]
        {
            self.child
                .kill()
                .map_err(|error| format!("Could not stop the local Model Foundry worker: {error}"))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn launched_worker_has_capturable_pipes() {
        let mut command = if cfg!(windows) {
            let mut command = Command::new("cmd");
            command.args(["/C", "echo foundry-job"]);
            command
        } else {
            let mut command = Command::new("sh");
            command.args(["-c", "echo foundry-job"]);
            command
        };
        command
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());
        let mut child = WorkerChild::spawn(&mut command).unwrap();
        let (stdout, stderr) = child.take_pipes();
        assert!(stdout.is_some());
        assert!(stderr.is_some());
        let until = std::time::Instant::now() + std::time::Duration::from_secs(5);
        loop {
            if child.try_wait().unwrap().is_some() {
                break;
            }
            assert!(
                std::time::Instant::now() < until,
                "worker tree did not finish"
            );
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
    }
}

#[cfg(windows)]
pub(crate) fn configure_worker_command(command: &mut Command) {
    command.creation_flags(CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP | CREATE_SUSPENDED);
}

#[cfg(not(windows))]
pub(crate) fn configure_worker_command(_command: &mut Command) {}
