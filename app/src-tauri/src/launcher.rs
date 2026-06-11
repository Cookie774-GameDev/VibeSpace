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
            .join("VibeSpace")
            .join("jarvis.exe"),
        local_app_data.join("VibeSpace").join("jarvis.exe"),
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

# Handle --help cleanly before anything else
if ($args -contains '--help') {
    Write-Host @"

  Jarvis          Launch VibeSpace with cyberpunk boot animation.
                  Checks for updates, installs if available, then opens the app.
  Jarvis --help   Show this help message

  After launching, press Ctrl+C inside the animation to stop it cleanly.
"@ -ForegroundColor Cyan
    exit 0
}

$binDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$coreScript = Join-Path $binDir 'JarvisCore.ps1'
$updateScript = Join-Path $binDir 'JarvisUpdate.ps1'

# Use external boot animation if available; fall back to bundled copy
$bootScript = Join-Path $env:USERPROFILE 'Jarvis-Terminal-Boot\jarvis-terminal-boot-forever-local\jarvis_boot_forever.py'
if (-not (Test-Path -LiteralPath $bootScript)) {
    $bootScript = Join-Path $binDir 'jarvis_boot_forever.py'
}

if (-not (Test-Path -LiteralPath $bootScript)) {
  Write-Error 'Jarvis terminal boot script is missing. Reinstall the Jarvis launcher.'
  exit 1
}

# Safe Python detection
$pythonExe = $null
$pythonArgsPrefix = @()

if (Get-Command py -ErrorAction SilentlyContinue) {
    $pythonExe = 'py'
    $pythonArgsPrefix = @('-3')
} elseif (Get-Command python -ErrorAction SilentlyContinue) {
    $pythonExe = 'python'
} elseif (Get-Command python3 -ErrorAction SilentlyContinue) {
    $pythonExe = 'python3'
}

if (-not $pythonExe) {
    Write-Host 'Python was not found. Install Python or add it to PATH.' -ForegroundColor Red
    exit 1
}

# Build sub-commands for update and app launch (never call Jarvis recursively)
$updateCommand = 'powershell -NoProfile -ExecutionPolicy Bypass -File "' + $updateScript + '"'
$argString = ($args | ForEach-Object {
  $a = $_ -replace '"', '\"'
  if ($a -match '\s') { '"{0}"' -f $a } else { $a }
}) -join ' '
$extra = ''
if ($argString) { $extra = ' ' + $argString }
$appCommand = 'powershell -NoProfile -ExecutionPolicy Bypass -File "' + $coreScript + '"' + $extra

$bootArgs = @(
  '--update-command',        $updateCommand,
  '--ignore-update-failure',
  '--app-command',           $appCommand,
  '--app-cwd',               $env:USERPROFILE,
  '--app-process-name',      'jarvis.exe',
  '--launch-wait-seconds',   '7',
  '--timeout',               '900',
  '--forever'
)

# Run the cyberpunk boot animation
& $pythonExe @pythonArgsPrefix $bootScript @bootArgs
exit $LASTEXITCODE
"#
    .to_string()
}

#[cfg(target_os = "windows")]
fn powershell_candidate_array(exe_candidates: &[PathBuf]) -> String {
    // Render every candidate path as a quoted PowerShell array element so the
    // generated scripts try VibeSpace and legacy Jarvis One install paths.
    exe_candidates
        .iter()
        .map(|p| format!("'{}'", p.to_string_lossy().replace('\'', "''")))
        .collect::<Vec<_>>()
        .join(", ")
}

#[cfg(target_os = "windows")]
fn windows_core_launcher(exe_candidates: &[PathBuf]) -> String {
    let candidates = powershell_candidate_array(exe_candidates);

    const TEMPLATE: &str = r#"$ErrorActionPreference = 'Stop'

function Write-LaunchLog([string]$level, [string]$msg) {
    $c = @{'INFO'='Cyan';'WARN'='Yellow';'ERROR'='Red';'OK'='Green';'DIM'='Gray'}[$level]
    if (-not $c) { $c = 'White' }
    Write-Host ("[" + (Get-Date -Format 'HH:mm:ss') + "] [" + $level + "] " + $msg) -ForegroundColor $c
}

$mode = if ($args -contains 'dev' -or $args -contains '--dev') { 'dev' } else { 'production' }

Write-LaunchLog 'INFO' "Launch mode: $mode"

if ($mode -eq 'production') {
    $jarvisCandidates = @($$CANDIDATES$$)
    $jarvisExe = $null
    foreach ($candidate in $jarvisCandidates) {
        if (Test-Path -LiteralPath $candidate) { $jarvisExe = $candidate; break }
    }
    if (-not $jarvisExe) {
        Write-LaunchLog 'ERROR' 'Jarvis executable not found. Start VibeSpace once from Start Menu, then try again.'
        exit 1
    }

    $info = Get-Item -LiteralPath $jarvisExe
    $ver = $info.VersionInfo.ProductVersion
    $built = $info.LastWriteTime
    $sizeMB = [math]::Round($info.Length / 1MB, 2)

    Write-LaunchLog 'INFO' "Exe path: $jarvisExe"
    Write-LaunchLog 'INFO' "Version: $ver"
    Write-LaunchLog 'INFO' "Built: $built"
    Write-LaunchLog 'INFO' "Size: $sizeMB MB"
    Write-LaunchLog 'INFO' 'Localhost expected: NO'

    # Guardrail: detect unbundled raw build (too small)
    if ($sizeMB -lt 9.0) {
        Write-LaunchLog 'WARN' ("Executable is only " + $sizeMB + " MB (expected >= 9.0 MB for a bundled build).")
        Write-LaunchLog 'WARN' "This may be an unbundled raw binary that cannot load its UI without a running dev server."
        Write-LaunchLog 'ERROR' "Please reinstall using the latest NSIS installer from GitHub Releases: https://github.com/Cookie774-GameDev/VibeSpace/releases"
        exit 1
    }

    # Guardrail: detect stale installed exe (older than 7 days is suspicious)
    $ageDays = ((Get-Date) - $built).TotalDays
    if ($ageDays -gt 7) {
        Write-LaunchLog 'WARN' ("Executable is " + ([math]::Round($ageDays,1)) + " days old.")
    }

    Write-LaunchLog 'OK' 'Launching production build...'
    try {
        $proc = Start-Process -FilePath $jarvisExe -WorkingDirectory (Split-Path -Parent $jarvisExe) -PassThru
        Write-LaunchLog 'OK' ("Started PID " + $proc.Id)
    } catch {
        Write-LaunchLog 'ERROR' ("Failed to start: " + $_.Exception.Message)
        exit 1
    }
} else {
    Write-LaunchLog 'INFO' 'Dev mode: launching from repo...'
    $repo = Join-Path $env:USERPROFILE 'projects\Jarvis\app'
    if (-not (Test-Path $repo)) {
        Write-LaunchLog 'ERROR' ("Repo not found at " + $repo)
        exit 1
    }

    # Check for port conflict on 5173
    $listener = $null
    try {
        $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 5173)
        $listener.Start()
        $listener.Stop()
        Write-LaunchLog 'INFO' 'Port 5173 is free'
    } catch {
        Write-LaunchLog 'WARN' 'Port 5173 is already in use. Another dev server may be running.'
    } finally {
        if ($listener -ne $null) { try { $listener.Stop() } catch {} }
    }

    Set-Location $repo
    Write-LaunchLog 'INFO' 'Starting Tauri dev server...'
    & npm run tauri:dev
}
"#;

    TEMPLATE.replace("$$CANDIDATES$$", &candidates)
}

#[cfg(target_os = "windows")]
fn windows_update_launcher(exe_candidates: &[PathBuf]) -> String {
    let candidates = powershell_candidate_array(exe_candidates);
    let first = exe_candidates
        .first()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default();

    format!(
        r#"$ErrorActionPreference = 'Stop'
$jarvisCandidates = @({candidates})
$jarvisExe = $null
foreach ($candidate in $jarvisCandidates) {{
  if (Test-Path -LiteralPath $candidate) {{ $jarvisExe = $candidate; break }}
}}
if (-not $jarvisExe) {{ $jarvisExe = '{first}' }}
$repo = 'Cookie774-GameDev/VibeSpace'
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

# --- Guardrail: backup current exe before updating -------------------------
$backupPath = $null
if (Test-Path -LiteralPath $jarvisExe) {{
  $backupDir = Join-Path (Split-Path -Parent $jarvisExe) '.backups'
  New-Item -ItemType Directory -Path $backupDir -Force -ErrorAction SilentlyContinue | Out-Null
  $stamp = Get-Date -Format 'yyyyMMddHHmmss'
  $backupPath = Join-Path $backupDir ("jarvis.exe.bak." + $stamp)
  Copy-Item -LiteralPath $jarvisExe -Destination $backupPath -Force
}}

try {{
  $release = Invoke-RestMethod -Uri "https://api.github.com/repos/$repo/releases/latest" -Headers @{{ 'User-Agent' = 'jarvis-terminal-launcher' }} -TimeoutSec 15
  $latestVersion = Normalize-Version $release.tag_name
  $installedVersion = Get-InstalledVersion
  if ($latestVersion -le $installedVersion) {{
    exit 0
  }}

  Write-Host "[update] New version available: $($release.tag_name)" -ForegroundColor Cyan

  $env:JARVIS_SILENT = '1'
  $env:JARVIS_FORMAT = 'nsis'
  $exitCode = 1
  if (Test-Path -LiteralPath $localInstaller) {{
    & powershell -NoProfile -ExecutionPolicy Bypass -File $localInstaller
    $exitCode = $LASTEXITCODE
  }} else {{
    & powershell -NoProfile -ExecutionPolicy Bypass -Command "irm '$remoteInstaller' | iex"
    $exitCode = $LASTEXITCODE
  }}

  if ($exitCode -ne 0) {{
    Write-Warning "Installer exited with code $exitCode."
  }}

  # --- Guardrail: verify new exe after update ------------------------------
  if (-not (Test-Path -LiteralPath $jarvisExe)) {{
    Write-Warning 'Update failed: jarvis.exe is missing after install.'
    if ($backupPath -and (Test-Path $backupPath)) {{
      Copy-Item -LiteralPath $backupPath -Destination $jarvisExe -Force
      Write-Host "[update] Restored previous working build from backup." -ForegroundColor Green
    }}
    exit 1
  }}

  $sizeMB = [math]::Round((Get-Item -LiteralPath $jarvisExe).Length / 1MB, 2)
  if ($sizeMB -lt 9.0) {{
    Write-Warning ("Update produced a broken build ($sizeMB MB). Restoring previous working build...")
    if ($backupPath -and (Test-Path $backupPath)) {{
      Copy-Item -LiteralPath $backupPath -Destination $jarvisExe -Force
      Write-Host "[update] Restored previous working build from backup." -ForegroundColor Green
    }}
    exit 1
  }}

  Write-Host "[update] Jarvis updated successfully to $latestVersion ($sizeMB MB)." -ForegroundColor Green
  exit 0
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
printf "%b\n" "${CYAN}  |${RESET}${VIOLET}${BOLD}            V  I  B  E  S  P  A  C  E             ${RESET}${CYAN}|${RESET}"
printf "%b\n" "${BLUE}  |${RESET}${DIM}             INTELLIGENT DESKTOP SYSTEM             ${RESET}${BLUE}|${RESET}"
printf "%b\n" "${VIOLET}  +--------------------------------------------------+${RESET}"
printf "%b\n" "${PINK}       * ${CYAN}VOICE${PINK} * ${BLUE}AGENTS${PINK} * ${VIOLET}MEMORY${PINK} * ${GREEN}AUTOMATION${RESET}"
printf "%b\n\n" "${GREEN}${BOLD}    >> ACCESS GRANTED${RESET}${DIM}  Launching your workspace...${RESET}"

if [ "$(uname -s)" = "Darwin" ]; then
  APP_PATH="$HOME/Applications/VibeSpace.app"
  if [ ! -d "$APP_PATH" ]; then
    APP_PATH="/Applications/VibeSpace.app"
  fi
  if [ ! -d "$APP_PATH" ]; then
    echo "VibeSpace.app not found. Launch Jarvis once from Finder, then try again." >&2
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
            PathBuf::from(r"C:\Users\Test\Programs\VibeSpace\jarvis.exe"),
            PathBuf::from(r"C:\Users\Test\VibeSpace\jarvis.exe"),
        ]);
        let update = windows_update_launcher(&[
            PathBuf::from(r"C:\Users\Test\Programs\VibeSpace\jarvis.exe"),
            PathBuf::from(r"C:\Users\Test\VibeSpace\jarvis.exe"),
        ]);
        let script = windows_powershell_launcher();

        assert!(core.contains(r"'C:\Users\Test\Programs\VibeSpace\jarvis.exe'"));
        assert!(core.contains(r"'C:\Users\Test\VibeSpace\jarvis.exe'"));
        assert!(core.contains("$jarvisCandidates = @("));
        assert!(core.contains("Start-Process -FilePath $jarvisExe"));
        assert!(update.contains(r"'C:\Users\Test\VibeSpace\jarvis.exe'"));
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
