#[derive(serde::Serialize, serde::Deserialize)]
pub struct TerminalClipboard {
    text: String,
    paths: Vec<String>,
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
        tauri::async_runtime::spawn_blocking(move || {
            use std::os::windows::process::CommandExt;
            // Use the OS executable, not a PATH-provided program. Clipboard content is
            // returned as data only; it is never interpolated into PowerShell code.
            let executable = std::env::var_os("SystemRoot")
                .map(std::path::PathBuf::from)
                .ok_or("Windows directory is unavailable")?
                .join("System32/WindowsPowerShell/v1.0/powershell.exe");
            let output = std::process::Command::new(executable)
                .args([
                    "-NoProfile",
                    "-NonInteractive",
                    "-STA",
                    "-Command",
                    include_str!("terminal_clipboard.ps1"),
                ])
                .env("VIBESPACE_CLIPBOARD_DIR", directory)
                .creation_flags(0x08000000)
                .output()
                .map_err(|_| "Could not read the clipboard")?;
            if !output.status.success() {
                return Err("Clipboard is unavailable; copy the item again and retry".to_string());
            }
            serde_json::from_slice(&output.stdout)
                .map_err(|_| "Could not decode clipboard data".to_string())
        })
        .await
        .map_err(|_| "Clipboard task failed".to_string())?
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = app;
        Err("Native file clipboard is currently supported on Windows".to_string())
    }
}
