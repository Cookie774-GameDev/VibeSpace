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
        local_app_data
            .join("Programs")
            .join("Jarvis One")
            .join("jarvis.exe"),
        local_app_data.join("Jarvis One").join("jarvis.exe"),
    ];
    write_windows_launcher_file(
        &bin_dir.join("jarvis_boot_forever.py"),
        windows_boot_python(),
    )?;
    write_windows_launcher_file(&bin_dir.join("Jarvis.cmd"), windows_cmd_launcher())?;
    write_windows_launcher_file(
        &bin_dir.join("JarvisCore.ps1"),
        windows_core_launcher(&exe_candidates),
    )?;
    write_windows_launcher_file(
        &bin_dir.join("JarvisUpdate.ps1"),
        windows_update_launcher(&exe_candidates),
    )?;
    write_windows_launcher_file(&bin_dir.join("Jarvis.ps1"), windows_powershell_launcher())?;
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
    "@echo off\r\npowershell -NoProfile -ExecutionPolicy Bypass -File \"%~dp0Jarvis.ps1\" %*\r\n"
}

#[cfg(target_os = "windows")]
fn windows_boot_python() -> &'static str {
    include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../tools/terminal_boot/jarvis_boot_forever.py"
    ))
}

#[cfg(target_os = "windows")]
fn windows_powershell_launcher() -> String {
    r#"$ErrorActionPreference = 'Stop'
$binDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$bootScript = Join-Path $binDir 'jarvis_boot_forever.py'
$coreScript = Join-Path $binDir 'JarvisCore.ps1'
$updateScript = Join-Path $binDir 'JarvisUpdate.ps1'

function Resolve-PythonCommand {
  if (Get-Command python -ErrorAction SilentlyContinue) { return @('python') }
  if (Get-Command py -ErrorAction SilentlyContinue) { return @('py', '-3') }
  return $null
}

if (-not (Test-Path -LiteralPath $bootScript)) {
  Write-Error 'Jarvis terminal boot script is missing. Reinstall the Jarvis launcher.'
  exit 1
}

$pythonCommand = Resolve-PythonCommand
if (-not $pythonCommand) {
  Write-Warning 'Python was not found. Launching Jarvis One directly.'
  & powershell -NoProfile -ExecutionPolicy Bypass -File $coreScript
  exit $LASTEXITCODE
}

$updateCommand = 'powershell -NoProfile -ExecutionPolicy Bypass -File "' + $updateScript + '"'
$appCommand = 'powershell -NoProfile -ExecutionPolicy Bypass -File "' + $coreScript + '"'
$bootArgs = @(
  $bootScript,
  '--update-command', $updateCommand,
  '--ignore-update-failure',
  '--app-command', $appCommand,
  '--app-cwd', $env:USERPROFILE,
  '--app-process-name', 'jarvis.exe',
  '--launch-wait-seconds', '7',
  '--timeout', '900',
  '--forever'
)
& $pythonCommand[0] @($pythonCommand | Select-Object -Skip 1) @bootArgs
exit $LASTEXITCODE
"#
    .to_string()
}

#[cfg(target_os = "windows")]
fn windows_core_launcher(exe_candidates: &[PathBuf]) -> String {
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
Start-Process -FilePath $jarvisExe -WorkingDirectory (Split-Path -Parent $jarvisExe)
"#
    )
}

#[cfg(target_os = "windows")]
fn windows_update_launcher(exe_candidates: &[PathBuf]) -> String {
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
$repo = 'Cookie774-GameDev/Jarivs-One'
$localInstaller = Join-Path $env:USERPROFILE 'projects\Jarvis\install\install.ps1'
$remoteInstaller = "https://raw.githubusercontent.com/$repo/main/install/install.ps1"

function Normalize-Version([string]$value) {{
  if ([string]::IsNullOrWhiteSpace($value)) {{ return [version]'0.0.0' }}
  $clean = ($value -replace '^v', '') -replace '[^0-9\.].*$', ''
  try {{ return [version]$clean }} catch {{ return [version]'0.0.0' }}
}}

function Get-InstalledVersion() {{
  if (-not (Test-Path -LiteralPath $jarvisExe)) {{ return [version]'0.0.0' }}
  try {{
    return Normalize-Version ((Get-Item -LiteralPath $jarvisExe).VersionInfo.ProductVersion)
  }} catch {{
    return [version]'0.0.0'
  }}
}}

try {{
  $release = Invoke-RestMethod -Uri "https://api.github.com/repos/$repo/releases/latest" -Headers @{{ 'User-Agent' = 'jarvis-terminal-launcher' }} -TimeoutSec 15
  $latestVersion = Normalize-Version $release.tag_name
  $installedVersion = Get-InstalledVersion
  if ($latestVersion -le $installedVersion) {{
    exit 0
  }}

  $env:JARVIS_SILENT = '1'
  $env:JARVIS_FORMAT = 'nsis'
  if (Test-Path -LiteralPath $localInstaller) {{
    & powershell -NoProfile -ExecutionPolicy Bypass -File $localInstaller
    exit $LASTEXITCODE
  }}

  & powershell -NoProfile -ExecutionPolicy Bypass -Command "irm '$remoteInstaller' | iex"
  exit $LASTEXITCODE
}} catch {{
  Write-Warning ('Jarvis update check failed: ' + $_.Exception.Message)
  exit 0
}}
"#
    )
}

#[cfg(target_os = "windows")]
fn write_windows_launcher_file(path: &Path, content: impl AsRef<[u8]>) -> Result<(), String> {
    backup_windows_launcher_file(path)?;
    fs::write(path, content).map_err(io_err)
}

#[cfg(target_os = "windows")]
fn backup_windows_launcher_file(path: &Path) -> Result<(), String> {
    if !path.exists() {
        return Ok(());
    }
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|err| format!("time: {err}"))?
        .as_secs();
    let file_name = path
        .file_name()
        .ok_or_else(|| "missing launcher file name".to_string())?
        .to_string_lossy();
    let backup = path.with_file_name(format!("{file_name}.bak.{stamp}"));
    fs::copy(path, backup).map_err(io_err)?;
    Ok(())
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
    use super::{
        windows_cmd_launcher, windows_core_launcher, windows_powershell_launcher,
        windows_update_launcher,
    };
    use std::path::PathBuf;

    #[test]
    fn windows_launcher_uses_boot_wrapper_without_recursion() {
        let core = windows_core_launcher(&[
            PathBuf::from(r"C:\Users\Test\Programs\Jarvis One\jarvis.exe"),
            PathBuf::from(r"C:\Users\Test\Jarvis One\jarvis.exe"),
        ]);
        let update = windows_update_launcher(&[
            PathBuf::from(r"C:\Users\Test\Programs\Jarvis One\jarvis.exe"),
            PathBuf::from(r"C:\Users\Test\Jarvis One\jarvis.exe"),
        ]);
        let script = windows_powershell_launcher();

        assert!(core.contains(r"$jarvisExe = 'C:\Users\Test\Programs\Jarvis One\jarvis.exe'"));
        assert!(core.contains("Start-Process -FilePath $jarvisExe"));
        assert!(update.contains("releases/latest"));
        assert!(update.contains("install\\install.ps1"));
        assert!(script.contains("jarvis_boot_forever.py"));
        assert!(script.contains("JarvisCore.ps1"));
        assert!(script.contains("JarvisUpdate.ps1"));
        assert!(script.contains("--forever"));
        assert!(!script.contains("--app-command Jarvis"));
        assert!(!script.contains(r"C:\\Users"));
        assert!(windows_cmd_launcher().contains(r#""%~dp0Jarvis.ps1""#));
        assert!(windows_cmd_launcher().contains("%*"));
    }
}
