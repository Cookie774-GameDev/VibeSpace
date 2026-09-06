#[derive(serde::Serialize, serde::Deserialize)]
pub struct TerminalClipboard {
    text: String,
    paths: Vec<String>,
}

#[cfg(target_os = "windows")]
mod worker {
    use super::TerminalClipboard;
    use std::io::{BufRead, BufReader, Write};
    use std::os::windows::process::CommandExt;
    use std::path::{Path, PathBuf};
    use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
    use std::sync::Mutex;

    struct ClipboardWorker {
        child: Child,
        input: ChildStdin,
        output: BufReader<ChildStdout>,
        directory: PathBuf,
    }
    impl Drop for ClipboardWorker {
        fn drop(&mut self) {
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
    }
    static WORKER: Mutex<Option<ClipboardWorker>> = Mutex::new(None);

    pub fn read(directory: &Path) -> Result<TerminalClipboard, String> {
        let mut slot = WORKER.lock().map_err(|_| "Clipboard worker unavailable")?;
        if slot.as_mut().is_some_and(|worker| {
            worker.directory != directory || !matches!(worker.child.try_wait(), Ok(None))
        }) {
            *slot = None;
        }
        if slot.is_none() {
            let executable = std::env::var_os("SystemRoot")
                .map(PathBuf::from)
                .ok_or("Windows directory is unavailable")?
                .join("System32/WindowsPowerShell/v1.0/powershell.exe");
            let mut child = Command::new(executable)
                .args([
                    "-NoProfile",
                    "-NonInteractive",
                    "-STA",
                    "-Command",
                    include_str!("terminal_clipboard.ps1"),
                ])
                .env("VIBESPACE_CLIPBOARD_DIR", directory)
                .env("VIBESPACE_CLIPBOARD_SERVER", "1")
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::null())
                .creation_flags(0x08000000)
                .spawn()
                .map_err(|_| "Could not start clipboard worker")?;
            let input = child.stdin.take().ok_or("Clipboard input unavailable")?;
            let output = BufReader::new(child.stdout.take().ok_or("Clipboard output unavailable")?);
            *slot = Some(ClipboardWorker {
                child,
                input,
                output,
                directory: directory.to_path_buf(),
            });
        }
        let worker = slot.as_mut().ok_or("Clipboard worker unavailable")?;
        let result = (|| {
            worker
                .input
                .write_all(b"read\n")
                .map_err(|_| "Clipboard worker disconnected")?;
            worker
                .input
                .flush()
                .map_err(|_| "Clipboard worker disconnected")?;
            let mut line = String::new();
            worker
                .output
                .read_line(&mut line)
                .map_err(|_| "Clipboard read failed")?;
            serde_json::from_str::<TerminalClipboard>(&line)
                .map_err(|_| "Clipboard is unavailable; copy the item again and retry")
        })();
        if result.is_err() {
            *slot = None;
        }
        result.map_err(str::to_string)
    }
}

/// Resolve OS clipboard files/images to durable local paths without executing input.
#[tauri::command]
pub async fn terminal_read_clipboard(app: tauri::AppHandle) -> Result<TerminalClipboard, String> {
    #[cfg(target_os = "windows")]
    {
        use tauri::Manager;
        let directory = app
            .path()
            .app_local_data_dir()
            .map_err(|_| "Clipboard storage is unavailable".to_string())?
            .join("terminal-clipboard");
        // A resident STA reader pays PowerShell/Forms startup once. Requests are
        // serialized; EOF on parent exit closes the helper without an orphan service.
        tauri::async_runtime::spawn_blocking(move || worker::read(&directory))
            .await
            .map_err(|_| "Clipboard task failed".to_string())?
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = app;
        Err("Native file clipboard is currently supported on Windows".to_string())
    }
}
