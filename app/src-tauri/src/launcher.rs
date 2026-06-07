use std::fs;
use std::path::{Path, PathBuf};

#[tauri::command]
pub fn install_terminal_launcher() -> Result<String, String> {
    install_terminal_launcher_impl()
}

#[cfg(target_os = "windows")]
fn install_terminal_launcher_impl() -> Result<String, String> {
    let user_profile = env_path("USERPROFILE")?;
    let local_app_data = env_path("LOCALAPPDATA")?;
    let bin_dir = user_profile.join(".jarvis").join("bin");
    fs::create_dir_all(&bin_dir).map_err(io_err)?;

    let exe_candidates = [
        local_app_data.join("Programs").join("Jarvis One").join("jarvis.exe"),
        local_app_data.join("Jarvis One").join("jarvis.exe"),
    ];
    fs::write(bin_dir.join("Jarvis.cmd"), windows_cmd_launcher()).map_err(io_err)?;
    fs::write(
        bin_dir.join("Jarvis.ps1"),
        windows_powershell_launcher(&exe_candidates),
    )
    .map_err(io_err)?;
    ensure_windows_user_path(&bin_dir)?;
    Ok(bin_dir.to_string_lossy().to_string())
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
fn install_terminal_launcher_impl() -> Result<String, String> {
    let home = env_path("HOME")?;
    let bin_dir = home.join(".jarvis").join("bin");
    fs::create_dir_all(&bin_dir).map_err(io_err)?;

    let script = unix_launcher_script();
    let primary = bin_dir.join("Jarvis");
    fs::write(&primary, script).map_err(io_err)?;
    set_executable(&primary)?;

    let lower = bin_dir.join("jarvis");
    fs::write(&lower, unix_launcher_script()).map_err(io_err)?;
    set_executable(&lower)?;

    ensure_unix_shell_path(&home, &bin_dir)?;
    Ok(bin_dir.to_string_lossy().to_string())
}

fn env_path(key: &str) -> Result<PathBuf, String> {
    std::env::var_os(key)
        .map(PathBuf::from)
        .ok_or_else(|| format!("missing environment variable: {key}"))
}

fn io_err(err: std::io::Error) -> String {
    format!("io: {err}")
}

#[cfg(target_os = "windows")]
fn windows_cmd_launcher() -> &'static str {
    "@echo off\r\npowershell -NoProfile -ExecutionPolicy Bypass -File \"%~dp0Jarvis.ps1\"\r\n"
}

#[cfg(target_os = "windows")]
fn windows_powershell_launcher(exe_candidates: &[PathBuf]) -> String {
    let first = exe_candidates
        .first()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default();
    let second = exe_candidates
        .get(1)
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default();

    format!(
        r#"$ErrorActionPreference = 'Stop'
$jarvisExe = '{first}'
if (-not (Test-Path -LiteralPath $jarvisExe)) {{ $jarvisExe = '{second}' }}
if (-not (Test-Path -LiteralPath $jarvisExe)) {{
  Write-Error 'Jarvis executable not found. Start Jarvis One once from Start Menu, then try again.'
  exit 1
}}

$esc = [char]27
$cyan = "$esc[38;5;51m"
$violet = "$esc[38;5;141m"
$pink = "$esc[38;5;213m"
$blue = "$esc[38;5;39m"
$green = "$esc[38;5;82m"
$bold = "$esc[1m"
$dim = "$esc[2m"
$reset = "$esc[0m"
Clear-Host
$frames = @(
  @($cyan,   '[=                   ]', 'WAKING CORE'),
  @($blue,   '[=====               ]', 'LINKING MODELS'),
  @($violet, '[==========          ]', 'SYNCING MEMORY'),
  @($pink,   '[===============     ]', 'ARMING INTERFACE'),
  @($green,  '[====================]', 'SYSTEM ONLINE')
)
foreach ($frame in $frames) {{
  Write-Host "`r  " -NoNewline
  Write-Host ($frame[0] + $frame[1] + $reset + '  ' + $bold + $frame[2] + $reset) -NoNewline
  Start-Sleep -Milliseconds 110
}}
Write-Host "`n"
Write-Host ($cyan + '  +--------------------------------------------------+' + $reset)
Write-Host ($cyan + '  |' + $reset + $violet + $bold + '              J  A  R  V  I  S    O  N  E           ' + $reset + $cyan + '|' + $reset)
Write-Host ($blue + '  |' + $reset + $dim + '             INTELLIGENT DESKTOP SYSTEM             ' + $reset + $blue + '|' + $reset)
Write-Host ($violet + '  +--------------------------------------------------+' + $reset)
Write-Host ($pink + '       * ' + $cyan + 'VOICE' + $pink + ' * ' + $blue + 'AGENTS' + $pink + ' * ' + $violet + 'MEMORY' + $pink + ' * ' + $green + 'AUTOMATION' + $reset)
Write-Host ($green + $bold + '    >> ACCESS GRANTED' + $reset + $dim + '  Launching your workspace...' + $reset)
Write-Host ''
Start-Process -FilePath $jarvisExe
"#
    )
}

#[cfg(target_os = "windows")]
fn ensure_windows_user_path(bin_dir: &Path) -> Result<(), String> {
    use winreg::enums::{HKEY_CURRENT_USER, KEY_READ, KEY_WRITE};
    use winreg::RegKey;

    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let env = hkcu
        .open_subkey_with_flags("Environment", KEY_READ | KEY_WRITE)
        .map_err(|err| format!("registry: {err}"))?;
    let current: String = env.get_value("Path").unwrap_or_default();
    let bin = bin_dir.to_string_lossy().to_string();
    if !path_contains(&current, &bin) {
        let updated = if current.trim().is_empty() {
            bin.clone()
        } else {
            format!("{current};{bin}")
        };
        env.set_value("Path", &updated)
            .map_err(|err| format!("registry: {err}"))?;
    }

    let process_path = std::env::var("PATH").unwrap_or_default();
    if !path_contains(&process_path, &bin) {
        let joined = if process_path.is_empty() {
            bin
        } else {
            format!("{process_path};{bin}")
        };
        std::env::set_var("PATH", joined);
    }
    Ok(())
}

#[cfg(target_os = "windows")]
fn path_contains(path_value: &str, needle: &str) -> bool {
    path_value
        .split(';')
        .any(|entry| entry.trim().eq_ignore_ascii_case(needle))
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
fn unix_launcher_script() -> &'static str {
    r#"#!/usr/bin/env bash
set -euo pipefail
ESC=$'\033'
CYAN="${ESC}[38;5;51m"
VIOLET="${ESC}[38;5;141m"
PINK="${ESC}[38;5;213m"
BLUE="${ESC}[38;5;39m"
GREEN="${ESC}[38;5;82m"
BOLD="${ESC}[1m"
DIM="${ESC}[2m"
RESET="${ESC}[0m"

clear
for frame in \
  "${CYAN}|=                   | WAKING CORE" \
  "${BLUE}|=====               | LINKING MODELS" \
  "${VIOLET}|==========          | SYNCING MEMORY" \
  "${PINK}|===============     | ARMING INTERFACE" \
  "${GREEN}|====================| SYSTEM ONLINE"
do
  color=${frame%%|*}
  rest=${frame#*|}
  bar=${rest%%|*}
  label=${rest#*|}
  printf "\r  %b[%-20s]%b  %b%s%b" "$color" "$bar" "$RESET" "$BOLD" "$label" "$RESET"
  sleep 0.11
done
printf "\n\n"
printf "%b\n" "${CYAN}  +--------------------------------------------------+${RESET}"
printf "%b\n" "${CYAN}  |${RESET}${VIOLET}${BOLD}              J  A  R  V  I  S    O  N  E           ${RESET}${CYAN}|${RESET}"
printf "%b\n" "${BLUE}  |${RESET}${DIM}             INTELLIGENT DESKTOP SYSTEM             ${RESET}${BLUE}|${RESET}"
printf "%b\n" "${VIOLET}  +--------------------------------------------------+${RESET}"
printf "%b\n" "${PINK}       * ${CYAN}VOICE${PINK} * ${BLUE}AGENTS${PINK} * ${VIOLET}MEMORY${PINK} * ${GREEN}AUTOMATION${RESET}"
printf "%b\n\n" "${GREEN}${BOLD}    >> ACCESS GRANTED${RESET}${DIM}  Launching your workspace...${RESET}"

if [ "$(uname -s)" = "Darwin" ]; then
  APP_PATH="$HOME/Applications/Jarvis One.app"
  if [ ! -d "$APP_PATH" ]; then
    APP_PATH="/Applications/Jarvis One.app"
  fi
  if [ ! -d "$APP_PATH" ]; then
    echo "Jarvis One.app not found. Launch Jarvis once from Finder, then try again." >&2
    exit 1
  fi
  open "$APP_PATH"
  exit 0
fi

TARGET="$HOME/.local/bin/jarvis"
if [ ! -x "$TARGET" ]; then
  TARGET="/usr/local/bin/jarvis"
fi
if [ ! -x "$TARGET" ]; then
  TARGET="/usr/bin/jarvis"
fi
if [ ! -x "$TARGET" ]; then
  echo "Jarvis launcher target not found. Start Jarvis once from your apps menu, then try again." >&2
  exit 1
fi
nohup "$TARGET" >/dev/null 2>&1 &
"#
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
fn ensure_unix_shell_path(home: &Path, bin_dir: &Path) -> Result<(), String> {
    let line = r#"export PATH="$HOME/.jarvis/bin:$PATH""#;
    let marker_start = "# >>> Jarvis launcher >>>";
    let marker_end = "# <<< Jarvis launcher <<<";
    let block = format!("{marker_start}\n{line}\n{marker_end}\n");
    let files = [".profile", ".bashrc", ".zprofile", ".zshrc"];

    for file in files {
        let path = home.join(file);
        let current = fs::read_to_string(&path).unwrap_or_default();
        if current.contains(marker_start) || current.contains(line) {
            continue;
        }
        let mut next = current;
        if !next.is_empty() && !next.ends_with('\n') {
            next.push('\n');
        }
        next.push_str(&block);
        fs::write(&path, next).map_err(io_err)?;
    }

    let process_path = std::env::var("PATH").unwrap_or_default();
    let bin = bin_dir.to_string_lossy().to_string();
    if !process_path.split(':').any(|entry| entry == bin) {
        let joined = if process_path.is_empty() {
            bin
        } else {
            format!("{bin}:{process_path}")
        };
        std::env::set_var("PATH", joined);
    }
    Ok(())
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
fn set_executable(path: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;

    let mut perms = fs::metadata(path).map_err(io_err)?.permissions();
    perms.set_mode(0o755);
    fs::set_permissions(path, perms).map_err(io_err)
}

#[cfg(all(test, target_os = "windows"))]
mod tests {
    use super::{windows_cmd_launcher, windows_powershell_launcher};
    use std::path::PathBuf;

    #[test]
    fn windows_launcher_uses_native_paths_and_styled_output() {
        let script = windows_powershell_launcher(&[
            PathBuf::from(r"C:\Users\Test\Programs\Jarvis One\jarvis.exe"),
            PathBuf::from(r"C:\Users\Test\Jarvis One\jarvis.exe"),
        ]);

        assert!(script.contains(r"$jarvisExe = 'C:\Users\Test\Programs\Jarvis One\jarvis.exe'"));
        assert!(script.contains("J  A  R  V  I  S    O  N  E"));
        assert!(script.contains("SYSTEM ONLINE"));
        assert!(script.contains("Launching your workspace..."));
        assert!(script.contains("Start-Process -FilePath $jarvisExe"));
        assert!(!script.contains(r"C:\\Users"));
        assert!(windows_cmd_launcher().contains(r#""%~dp0Jarvis.ps1""#));
    }
}
