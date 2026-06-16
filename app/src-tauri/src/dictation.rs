use std::{
    io::Write,
    process::{Command, Stdio},
    thread,
    time::Duration,
};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

#[tauri::command]
pub fn dictation_paste_text(text: String) -> Result<(), String> {
    let clean = text.trim();
    if clean.is_empty() {
        return Ok(());
    }
    let previous_clipboard = get_clipboard().ok();
    set_clipboard(clean)?;
    thread::sleep(Duration::from_millis(90));
    let paste_result = paste_clipboard();
    if let Some(previous) = previous_clipboard {
        thread::spawn(move || {
            thread::sleep(Duration::from_millis(1_500));
            let _ = set_clipboard(&previous);
        });
    }
    paste_result
}

#[cfg(target_os = "windows")]
fn get_clipboard() -> Result<String, String> {
    let output = Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", "Get-Clipboard -Raw"])
        .output()
        .map_err(|err| format!("clipboard read unavailable: {err}"))?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).to_string())
    } else {
        Err("clipboard read failed".into())
    }
}

#[cfg(target_os = "windows")]
fn set_clipboard(text: &str) -> Result<(), String> {
    let mut child = Command::new("powershell")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "Set-Clipboard -Value ([Console]::In.ReadToEnd())",
        ])
        .stdin(Stdio::piped())
        .spawn()
        .map_err(|err| format!("clipboard unavailable: {err}"))?;
    child
        .stdin
        .as_mut()
        .ok_or_else(|| "clipboard stdin unavailable".to_string())?
        .write_all(text.as_bytes())
        .map_err(|err| format!("clipboard write failed: {err}"))?;
    let status = child
        .wait()
        .map_err(|err| format!("clipboard process failed: {err}"))?;
    if status.success() {
        Ok(())
    } else {
        Err("clipboard command failed".into())
    }
}

#[cfg(target_os = "windows")]
fn paste_clipboard() -> Result<(), String> {
    let status = Command::new("powershell")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('^v')",
        ])
        .status()
        .map_err(|err| format!("paste unavailable: {err}"))?;
    if status.success() {
        Ok(())
    } else {
        Err("paste command failed".into())
    }
}

#[cfg(target_os = "macos")]
fn get_clipboard() -> Result<String, String> {
    let output = Command::new("pbpaste")
        .output()
        .map_err(|err| format!("clipboard read unavailable: {err}"))?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).to_string())
    } else {
        Err("pbpaste failed".into())
    }
}

#[cfg(target_os = "macos")]
fn set_clipboard(text: &str) -> Result<(), String> {
    let mut child = Command::new("pbcopy")
        .stdin(Stdio::piped())
        .spawn()
        .map_err(|err| format!("clipboard unavailable: {err}"))?;
    child
        .stdin
        .as_mut()
        .ok_or_else(|| "clipboard stdin unavailable".to_string())?
        .write_all(text.as_bytes())
        .map_err(|err| format!("clipboard write failed: {err}"))?;
    let status = child
        .wait()
        .map_err(|err| format!("clipboard process failed: {err}"))?;
    if status.success() {
        Ok(())
    } else {
        Err("pbcopy failed".into())
    }
}

#[cfg(target_os = "macos")]
fn paste_clipboard() -> Result<(), String> {
    let status = Command::new("osascript")
        .args(["-e", "tell application \"System Events\" to keystroke \"v\" using command down"])
        .status()
        .map_err(|err| format!("paste unavailable: {err}"))?;
    if status.success() {
        Ok(())
    } else {
        Err("paste command failed".into())
    }
}

#[cfg(target_os = "linux")]
fn get_clipboard() -> Result<String, String> {
    for args in [
        ("wl-paste", vec!["--no-newline"]),
        ("xclip", vec!["-selection", "clipboard", "-o"]),
    ] {
        if let Ok(output) = Command::new(args.0).args(args.1).output() {
            if output.status.success() {
                return Ok(String::from_utf8_lossy(&output.stdout).to_string());
            }
        }
    }
    Err("clipboard read unavailable".into())
}

#[cfg(target_os = "linux")]
fn set_clipboard(text: &str) -> Result<(), String> {
    for (program, args) in [
        ("wl-copy", Vec::<&str>::new()),
        ("xclip", vec!["-selection", "clipboard"]),
    ] {
        let mut child = match Command::new(program).args(args).stdin(Stdio::piped()).spawn() {
            Ok(child) => child,
            Err(_) => continue,
        };
        if let Some(stdin) = child.stdin.as_mut() {
            let _ = stdin.write_all(text.as_bytes());
        }
        if child.wait().map(|status| status.success()).unwrap_or(false) {
            return Ok(());
        }
    }
    Err("Install wl-copy or xclip to use global dictation paste on Linux.".into())
}

#[cfg(target_os = "linux")]
fn paste_clipboard() -> Result<(), String> {
    let status = Command::new("xdotool")
        .args(["key", "ctrl+v"])
        .status()
        .map_err(|_| "Install xdotool to auto-paste dictation on Linux.".to_string())?;
    if status.success() {
        Ok(())
    } else {
        Err("xdotool paste failed".into())
    }
}

/// Trigger the platform's native speech dictation UI when available.
/// Windows: Win+H voice typing. macOS/Linux: returns an error (Web Speech is used in-app).
#[tauri::command]
pub fn trigger_os_dictation() -> Result<(), String> {
    trigger_os_dictation_inner()
}

fn trigger_os_dictation_inner() -> Result<(), String> {
    #[cfg(windows)]
    {
        use windows::Win32::UI::Input::KeyboardAndMouse::{
            SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYBD_EVENT_FLAGS,
            VK_H, VK_LWIN, VIRTUAL_KEY,
        };

        fn key_input(vk: VIRTUAL_KEY, flags: KEYBD_EVENT_FLAGS) -> INPUT {
            INPUT {
                r#type: INPUT_KEYBOARD,
                Anonymous: INPUT_0 {
                    ki: KEYBDINPUT {
                        wVk: vk,
                        wScan: 0,
                        dwFlags: flags,
                        time: 0,
                        dwExtraInfo: 0,
                    },
                },
            }
        }

        let inputs = [
            key_input(VK_LWIN, KEYBD_EVENT_FLAGS(0)),
            key_input(VK_H, KEYBD_EVENT_FLAGS(0)),
            key_input(VK_H, KEYBD_EVENT_FLAGS(0x0002)),
            key_input(VK_LWIN, KEYBD_EVENT_FLAGS(0x0002)),
        ];
        let sent = unsafe { SendInput(&inputs, std::mem::size_of::<INPUT>() as i32) };
        if sent == inputs.len() as u32 {
            Ok(())
        } else {
            Err("Could not trigger Windows voice typing (Win+H).".into())
        }
    }

    #[cfg(not(windows))]
    {
        Err(
            "Native OS dictation shortcut is only available on Windows. Use built-in Web Speech in the composer."
                .into(),
        )
    }
}
