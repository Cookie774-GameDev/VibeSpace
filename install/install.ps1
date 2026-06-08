# Jarvis - Windows Terminal Installer
# Usage:    irm https://jarvis.app/install.ps1 | iex
# Or:       irm https://get.jarvis.app | iex
# GitHub:   irm https://raw.githubusercontent.com/Cookie774-GameDev/Jarivs-One/main/install/install.ps1 | iex
#
# Optional environment variables (set before piping into iex):
#   $env:JARVIS_VERSION  = "0.1.20"    pin to a specific version (default: latest published release)
#   $env:JARVIS_CHANNEL  = "stable"    stable or nightly (default: stable)
#   $env:JARVIS_FORMAT   = "nsis"      nsis (smaller, friendlier) or msi (IT-managed) (default: nsis)
#   $env:JARVIS_LOCAL    = "1"         install from the local C:\Users\viper\projects\Jarvis build (for self-testing)
#   $env:JARVIS_SILENT   = "0"         force the interactive installer UI (default: silent current-user NSIS install)
#   $env:JARVIS_DRYRUN   = "1"         download + verify only, do not run installer
#   $env:JARVIS_DOWNLOAD_DIR = "D:\Jarvis-Tests\downloads" stage downloads in a specific folder
#   $env:JARVIS_KEEP_DOWNLOAD = "1"    keep the downloaded installer after a normal run

#Requires -Version 5.1
$ErrorActionPreference = 'Stop'
$ProgressPreference     = 'SilentlyContinue'

# --- Constants ------------------------------------------------------------
$JarvisRepo       = 'Cookie774-GameDev/Jarivs-One'
$JarvisGitHubApi  = "https://api.github.com/repos/$JarvisRepo/releases"
$JarvisDownloads  = "https://github.com/$JarvisRepo/releases/download"
$JarvisLocalBuild = 'C:\Users\viper\projects\Jarvis\app\src-tauri\target\release\bundle'

# GitHub requires modern TLS. Windows PowerShell 5.1 can inherit older defaults
# on some machines, so force TLS 1.2 before any release API or asset request.
try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
} catch {
    # Best-effort only; PowerShell 7+ and modern Windows already negotiate this.
}

# --- Pretty banner --------------------------------------------------------
# PS 5.1 does not interpret `e as ESC; build it from [char]27 so colors work everywhere.
$ESC = [char]27
function Write-Banner {
    $line   = '-' * 60
    $cyan   = "$ESC[38;5;51m"
    $violet = "$ESC[38;5;141m"
    $dim    = "$ESC[2m"
    $reset  = "$ESC[0m"
    Write-Host ""
    Write-Host "$cyan$line$reset"
    Write-Host "$cyan      _                   _      $reset"
    Write-Host "$cyan     | | __ _ _ ____   _(_)___  $violet  the AI workspace$reset"
    Write-Host "$cyan  _  | |/ _`` | '__\ \ / / / __| $violet  for every model,$reset"
    Write-Host "$cyan | |_| | (_| | |   \ V /| \__ \ $violet  agent, voice & task$reset"
    Write-Host "$cyan  \___/ \__,_|_|    \_/ |_|___/ $reset"
    Write-Host "$dim                                  https://github.com/$JarvisRepo$reset"
    Write-Host "$cyan$line$reset"
    Write-Host ""
}

function Write-Step ($msg) {
    Write-Host "  ->  " -NoNewline -ForegroundColor Cyan
    Write-Host $msg
}
function Write-Ok ($msg) {
    Write-Host "  OK  " -NoNewline -ForegroundColor Green
    Write-Host $msg
}
function Write-Warn ($msg) {
    Write-Host "  !!  " -NoNewline -ForegroundColor Yellow
    Write-Host $msg -ForegroundColor Yellow
}
function Write-Fail ($msg) {
    Write-Host "  XX  " -NoNewline -ForegroundColor Red
    Write-Host $msg -ForegroundColor Red
}

# --- Helpers --------------------------------------------------------------
function Test-IsAdmin {
    $id  = [Security.Principal.WindowsIdentity]::GetCurrent()
    $pri = New-Object Security.Principal.WindowsPrincipal($id)
    return $pri.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Test-Architecture {
    if ([Environment]::Is64BitOperatingSystem) { return 'x64' }
    throw 'Jarvis requires 64-bit Windows. 32-bit is not supported.'
}

function Test-WindowsVersion {
    $os = [Environment]::OSVersion.Version
    if ($os.Major -lt 10) {
        Write-Warn "Windows $($os.Major).$($os.Minor) detected. Jarvis is tested on Windows 10 1809+ and Windows 11."
    }
}

function Test-WebView2 {
    # WebView2 ships with Windows 11 and is widely deployed on Win10.
    # Tauri requires it. We check; if missing we point at the bootstrapper.
    $regPaths = @(
        'HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}',
        'HKLM:\SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}',
        'HKCU:\SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}'
    )
    foreach ($p in $regPaths) {
        if (Test-Path $p) {
            $v = (Get-ItemProperty $p -ErrorAction SilentlyContinue).pv
            if ($v) { return $v }
        }
    }
    return $null
}

function Get-LatestVersion {
    if ($env:JARVIS_VERSION) {
        return $env:JARVIS_VERSION
    }
    Write-Step 'Checking GitHub for the latest release...'
    $apiError = $null
    try {
        $rel = Invoke-RestMethod -Uri "$JarvisGitHubApi/latest" -Headers @{ 'User-Agent' = 'jarvis-installer' } -TimeoutSec 15
        if ($rel.tag_name) {
            $v = ($rel.tag_name -replace '^v','')
            Write-Ok "Latest version: $v"
            return $v
        }
    } catch {
        $apiError = $_.Exception.Message
    }

    $curl = Get-Command curl.exe -ErrorAction SilentlyContinue
    if ($curl) {
        try {
            $effective = & $curl.Source -Ls -o NUL -w '%{url_effective}' -A 'jarvis-installer' "https://github.com/$JarvisRepo/releases/latest"
            if ($LASTEXITCODE -eq 0 -and $effective -match '/releases/tag/v?([^/\s]+)$') {
                $v = $Matches[1]
                Write-Ok "Latest version: $v"
                return $v
            }
        } catch {
            if (-not $apiError) { $apiError = $_.Exception.Message }
        }
    }

    if ($apiError) {
        Write-Warn "GitHub latest-release lookup failed: $apiError"
    }
    Write-Fail "No published Jarvis One GitHub Release was found."
    Write-Warn "Publish a release with installer assets, or set JARVIS_VERSION/JARVIS_LOCAL for controlled testing."
    exit 1
}

function Get-DownloadUrl ($version, $format) {
    # Match Tauri's bundle naming convention.
    if ($format -eq 'msi') {
        return "$JarvisDownloads/v$version/Jarvis%20One_${version}_x64_en-US.msi"
    } else {
        return "$JarvisDownloads/v$version/Jarvis%20One_${version}_x64-setup.exe"
    }
}

function Get-AssetPattern ($format) {
    if ($format -eq 'msi') {
        return '(?i)(^|/)(jarvis(%20|\s|-|_)?one|jarvis-one|jarvis).*(x64|amd64).*\.msi$'
    }
    return '(?i)(^|/)(jarvis(%20|\s|-|_)?one|jarvis-one|jarvis).*(x64|amd64).*(setup)?\.exe$'
}

function Resolve-DownloadUrl ($version, $format) {
    $fallback = Get-DownloadUrl -version $version -format $format
    $pattern = Get-AssetPattern -format $format
    $headers = @{ 'User-Agent' = 'jarvis-installer' }
    try {
        $rel = Invoke-RestMethod -Uri "$JarvisGitHubApi/tags/v$version" -Headers $headers -TimeoutSec 15
        $assets = @($rel.assets)
        $match = $assets |
            Where-Object {
                $name = [string]$_.name
                $url = [string]$_.browser_download_url
                ($name -match $pattern) -or ($url -match $pattern)
            } |
            Select-Object -First 1
        if ($match -and $match.browser_download_url) {
            return [string]$match.browser_download_url
        }
        Write-Warn "No matching $format asset found in release metadata; trying canonical Tauri filename."
    } catch {
        Write-Warn "Could not inspect release assets: $($_.Exception.Message)"
        Write-Warn "Trying canonical Tauri filename."
    }
    return $fallback
}

function Get-LocalInstaller ($format) {
    # Find the highest-versioned local build, used when JARVIS_LOCAL=1.
    $sub = if ($format -eq 'msi') { 'msi' } else { 'nsis' }
    $pattern = if ($format -eq 'msi') { 'Jarvis One_*_x64_en-US.msi' } else { 'Jarvis One_*_x64-setup.exe' }
    $dir = Join-Path $JarvisLocalBuild $sub
    if (-not (Test-Path $dir)) {
        throw "Local build not found at $dir. Either build the app first (npm run tauri:build) or unset JARVIS_LOCAL."
    }
    $found = Get-ChildItem -LiteralPath $dir -Filter $pattern -ErrorAction SilentlyContinue |
             Sort-Object LastWriteTime -Descending |
             Select-Object -First 1
    if (-not $found) {
        throw "No installer found in $dir matching $pattern."
    }
    return $found.FullName
}

function Save-DownloadFile ($url, $outFile) {
    Write-Step "Downloading: $url"
    $tmp = "$outFile.partial"
    $headers = @{ 'User-Agent' = 'jarvis-installer' }
    $lastError = $null

    for ($attempt = 1; $attempt -le 3; $attempt++) {
        try {
            if (Test-Path $tmp) { Remove-Item $tmp -Force -ErrorAction SilentlyContinue }
            Invoke-WebRequest -Uri $url -OutFile $tmp -UseBasicParsing -TimeoutSec 300 -Headers $headers
            Move-Item -LiteralPath $tmp -Destination $outFile -Force
            $size = [math]::Round((Get-Item $outFile).Length / 1MB, 2)
            Write-Ok "Downloaded $size MB"
            return
        } catch {
            $lastError = $_.Exception.Message
            if (Test-Path $tmp) { Remove-Item $tmp -Force -ErrorAction SilentlyContinue }
            if ($attempt -lt 3) {
                Write-Warn "Download attempt $attempt failed; retrying..."
                Start-Sleep -Seconds ([math]::Min(2 * $attempt, 6))
            }
        }
    }

    $curl = Get-Command curl.exe -ErrorAction SilentlyContinue
    if ($curl) {
        try {
            if (Test-Path $tmp) { Remove-Item $tmp -Force -ErrorAction SilentlyContinue }
            Write-Step "Retrying with curl.exe..."
            & $curl.Source -fL --retry 3 --connect-timeout 30 --max-time 600 -A 'jarvis-installer' -o $tmp $url
            if ($LASTEXITCODE -ne 0) {
                throw "curl.exe exited with code $LASTEXITCODE"
            }
            Move-Item -LiteralPath $tmp -Destination $outFile -Force
            $size = [math]::Round((Get-Item $outFile).Length / 1MB, 2)
            Write-Ok "Downloaded $size MB"
            return
        } catch {
            $lastError = $_.Exception.Message
            if (Test-Path $tmp) { Remove-Item $tmp -Force -ErrorAction SilentlyContinue }
        }
    }

    throw "Download failed: $lastError"
}

function New-InstallerTempDir {
    if ($env:JARVIS_DOWNLOAD_DIR) {
        $downloadRoot = [System.IO.Path]::GetFullPath($env:JARVIS_DOWNLOAD_DIR)
        New-Item -ItemType Directory -Path $downloadRoot -Force | Out-Null
        return (New-Item -ItemType Directory -Path (Join-Path $downloadRoot "jarvis-installer-$(Get-Random)") -Force).FullName
    }
    return (New-Item -ItemType Directory -Path (Join-Path $env:TEMP "jarvis-installer-$(Get-Random)") -Force).FullName
}

function Test-FileSignature ($file) {
    try {
        $sig = Get-AuthenticodeSignature -FilePath $file
        if ($sig.Status -eq 'Valid') {
            Write-Ok "Signature: valid ($($sig.SignerCertificate.Subject))"
        } elseif ($sig.Status -eq 'NotSigned') {
            Write-Warn "This build is unsigned. Windows SmartScreen will warn on first run."
            Write-Warn "Production builds will be Authenticode-signed (post-launch)."
        } else {
            Write-Warn "Signature status: $($sig.Status)"
        }
    } catch {
        Write-Warn "Could not check signature: $($_.Exception.Message)"
    }
}

function Get-FileHashShort ($file) {
    return (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.Substring(0, 16).ToLower()
}

function Invoke-Installer ($file, $format, $silent) {
    Write-Step "Running installer: $(Split-Path -Leaf $file)"
    $installerArgs = @()
    try {
        if ($format -eq 'nsis') {
            if ($silent) { $installerArgs += '/S' }
            # Run NSIS installer as standard user (currentUser installs to Local AppData, bypassing UAC)
            if ($installerArgs.Count -gt 0) {
                $proc = Start-Process -FilePath $file -ArgumentList $installerArgs -Wait -PassThru
            } else {
                $proc = Start-Process -FilePath $file -Wait -PassThru
            }
            return $proc.ExitCode
        } elseif ($format -eq 'msi') {
            $installerArgs = @('/i', "`"$file`"")
            if ($silent) { $installerArgs += '/quiet','/passive','/norestart' }
            $exe   = 'msiexec.exe'
            if ($installerArgs.Count -gt 0) {
                $proc  = Start-Process -FilePath $exe -ArgumentList $installerArgs -Verb RunAs -Wait -PassThru
            } else {
                $proc  = Start-Process -FilePath $exe -Verb RunAs -Wait -PassThru
            }
            return $proc.ExitCode
        }
    } catch {
        $message = $_.Exception.Message
        if ($message -match 'Application Control|blocked this file|SmartScreen|virus|policy') {
            Write-Fail 'Windows blocked the installer before it could run.'
            Write-Warn 'This is an OS trust/reputation policy, not a Jarvis installer argument failure.'
            Write-Warn 'Production mitigation: Authenticode-sign the installer/exe with a trusted certificate and build reputation on the same publisher identity.'
        }
        throw
    }
    return 1
}

function Get-InstalledJarvisExe {
    $candidates = @(
        (Join-Path $env:LOCALAPPDATA 'Programs\Jarvis One\jarvis.exe'),
        (Join-Path $env:LOCALAPPDATA 'Jarvis One\jarvis.exe'),
        (Join-Path $env:ProgramFiles 'Jarvis One\jarvis.exe')
    )
    if (${env:ProgramFiles(x86)}) {
        $candidates += (Join-Path ${env:ProgramFiles(x86)} 'Jarvis One\jarvis.exe')
    }
    foreach ($candidate in $candidates) {
        if (Test-Path -LiteralPath $candidate) {
            return $candidate
        }
    }
    return $null
}

function Install-TerminalLauncher ($exePath) {
    $binDir = Join-Path $env:USERPROFILE '.jarvis\bin'
    $cmdPath = Join-Path $binDir 'Jarvis.cmd'
    $scriptPath = Join-Path $binDir 'Jarvis.ps1'
    New-Item -ItemType Directory -Path $binDir -Force | Out-Null

    $cmdLauncher = @'
@echo off
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0Jarvis.ps1" %*
'@
    $psLauncher = @"
`$ErrorActionPreference = 'Stop'
`$jarvisExe = '$($exePath.Replace("'", "''"))'
`$esc = [char]27
`$cyan = "`$esc[38;5;51m"
`$cyanBright = "`$esc[38;5;87m"
`$blue = "`$esc[38;5;33m"
`$blueBright = "`$esc[38;5;39m"
`$green = "`$esc[38;5;82m"
`$greenDim = "`$esc[38;5;29m"
`$white = "`$esc[38;5;255m"
`$bold = "`$esc[1m"
`$dim = "`$esc[2m"
`$reset = "`$esc[0m"
`$bgDark = "`$esc[48;5;17m"

function Show-Header {
  Clear-Host
  Write-Host (`$cyan + '  JARVIS' + `$reset + `$dim + ' // TERMINAL INTELLIGENCE' + `$reset)
  Write-Host (`$blue + '  --------------------------------------------------------' + `$reset)
  Write-Host (`$dim + '  Workspace: ' + `$reset + (Get-Location).Path)
  Write-Host ''
}

function Start-CodeAgent([string]`$requested, [string[]]`$agentArgs = @()) {
  `$available = @()
  if (Get-Command claude -ErrorAction SilentlyContinue) { `$available += 'claude' }
  if (Get-Command codex -ErrorAction SilentlyContinue) { `$available += 'codex' }
  if (Get-Command opencode -ErrorAction SilentlyContinue) { `$available += 'opencode' }
  `$target = `$requested
  if (`$requested -eq 'ultra' -or `$requested -eq 'code') {
    `$target = @('claude', 'codex', 'opencode') | Where-Object { `$available -contains `$_ } | Select-Object -First 1
  }
  if (-not `$target -or -not (Get-Command `$target -ErrorAction SilentlyContinue)) {
    Write-Host (`$cyan + `$bold + '  No coding agent CLI was found.' + `$reset)
    Write-Host (`$dim + '  Install Claude Code, Codex, or OpenCode, then run Jarvis ultra again.' + `$reset)
    exit 1
  }
  Show-Header
  Write-Host (`$green + `$bold + '  ULTRA CODE ONLINE' + `$reset)
  Write-Host (`$dim + '  Agent: ' + `$reset + `$target)
  Write-Host (`$dim + '  Scope: ' + `$reset + (Get-Location).Path)
  Write-Host (`$dim + '  Full repository context, native terminal control, persistent session.' + `$reset)
  Write-Host ''
  & `$target @agentArgs
  exit `$LASTEXITCODE
}

function Show-BootSequence {
  Clear-Host
  Write-Host ''

  `$logo = @(
    '       ??? ?????? ??????? ???   ??????????????',
    '       ??????????????????????   ??????????????',
    '       ??????????????????????   ??????????????',
    '  ??   ??????????????????????? ???????????????',
    '  ???????????  ??????  ??? ??????? ???????????',
    '   ?????? ???  ??????  ???  ?????  ???????????'
  )
  foreach (`$line in `$logo) {
    Write-Host (`$cyan + `$bold + `$line + `$reset)
    Start-Sleep -Milliseconds 35
  }

  Write-Host (`$cyanBright + '                        - ' + `$bold + 'ONE' + `$reset + `$cyanBright + ' -' + `$reset)
  Start-Sleep -Milliseconds 60
  Write-Host (`$blue + '            SYMBIOTE INTEGRATED INTELLIGENCE' + `$reset)
  Write-Host ''
  Write-Host (`$blueBright + '  ???????????????????????????????????????????????????' + `$reset)
  Write-Host ''

  `$steps = @(
    @('Initializing Symbiote Core', '100%'),
    @('Loading memory maps',        '100%'),
    @('Connecting voice link',      'OK'),
    @('Preparing workspace',        'OK'),
    @('Calibrating neural mesh',    'OK'),
    @('System diagnostics',         'OK')
  )

  `$barFull = [string]::new([char]0x2588, 20)
  foreach (`$step in `$steps) {
    `$label = `$step[0].PadRight(34)
    `$result = `$step[1]

    Write-Host ('  ' + `$blueBright + '[' + `$cyanBright + [char]0x25A0 + `$blueBright + '] ' + `$reset) -NoNewline
    Write-Host (`$white + `$label + `$reset) -NoNewline

    `$segments = 20
    for (`$i = 1; `$i -le `$segments; `$i++) {
      `$filled = [string]::new([char]0x2588, `$i)
      `$empty  = [string]::new([char]0x2591, (`$segments - `$i))
      Write-Host ("`r  " + `$blueBright + '[' + `$cyanBright + [char]0x25A0 + `$blueBright + '] ' + `$reset + `$white + `$label + `$reset + `$cyan + `$filled + `$greenDim + `$empty + `$reset) -NoNewline
      Start-Sleep -Milliseconds 8
    }

    Write-Host ("`r  " + `$blueBright + '[' + `$cyanBright + [char]0x25A0 + `$blueBright + '] ' + `$reset + `$white + `$label + `$cyan + `$barFull + '  ' + `$green + `$bold + `$result + `$reset)
    Start-Sleep -Milliseconds 40
  }

  Write-Host ''
  Write-Host (`$blueBright + '  ???????????????????????????????????????????????????' + `$reset)
  Write-Host ''

  `$dotRow = `$cyan + '  '
  for (`$d = 0; `$d -lt 40; `$d++) { `$dotRow += [char]0x25CF + ' ' }
  `$dotRow += `$reset
  Write-Host `$dotRow
  Write-Host ''

  Write-Host ('  ' + `$blueBright + `$bold + '  ' + [char]0x25C9 + '  JARVIS ONLINE' + `$reset)
  Write-Host ('  ' + `$dim + '     All systems nominal.' + `$reset)
  Write-Host ''
  Write-Host ('  ' + `$cyanBright + 'Ready for your command.' + `$reset)
  Write-Host ''
}

`$mode = if (`$args.Count -gt 0) { `$args[0].ToLowerInvariant() } else { '' }
`$modeArgs = @(`$args | Select-Object -Skip 1)
switch (`$mode) {
  'app'      { Start-Process -FilePath `$jarvisExe; exit 0 }
  'open'     { Start-Process -FilePath `$jarvisExe; exit 0 }
  'code'     { Start-CodeAgent 'code' `$modeArgs }
  'ultra'    { Start-CodeAgent 'ultra' `$modeArgs }
  'claude'   { Start-CodeAgent 'claude' `$modeArgs }
  'codex'    { Start-CodeAgent 'codex' `$modeArgs }
  'opencode' { Start-CodeAgent 'opencode' `$modeArgs }
  'help' {
    Show-Header
    Write-Host (`$bold + '  Commands' + `$reset)
    Write-Host '    Jarvis           Launch Jarvis One'
    Write-Host '    Jarvis ultra     Start the best installed coding agent'
    Write-Host '    Jarvis claude    Start Claude Code here'
    Write-Host '    Jarvis codex     Start Codex here'
    Write-Host '    Jarvis opencode  Start OpenCode here'
    exit 0
  }
}

Show-BootSequence
Start-Process -FilePath `$jarvisExe
"@
    Set-Content -LiteralPath $cmdPath -Value $cmdLauncher -Encoding ASCII
    Set-Content -LiteralPath $scriptPath -Value $psLauncher -Encoding UTF8

    $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    $entries = @($userPath -split ';' | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
    if (-not ($entries | Where-Object { $_.Trim().Equals($binDir, [StringComparison]::OrdinalIgnoreCase) })) {
        $updatedPath = (@($entries) + $binDir) -join ';'
        [Environment]::SetEnvironmentVariable('Path', $updatedPath, 'User')
    }
    if (-not (($env:Path -split ';') | Where-Object { $_.Trim().Equals($binDir, [StringComparison]::OrdinalIgnoreCase) })) {
        $env:Path = "$binDir;$env:Path"
    }
    Write-Ok 'Terminal command ready: Jarvis'
}

function Get-TerminalBootSource {
    param(
        [string]$VersionHint
    )

    $localBoot = Join-Path $PSScriptRoot '..\tools\terminal_boot\jarvis_boot_forever.py'
    if (Test-Path -LiteralPath $localBoot) {
        return Get-Content -LiteralPath $localBoot -Raw -Encoding UTF8
    }

    $headers = @{ 'User-Agent' = 'jarvis-installer' }
    $urls = @()
    if ($VersionHint) {
        $urls += "https://raw.githubusercontent.com/$JarvisRepo/v$VersionHint/tools/terminal_boot/jarvis_boot_forever.py"
    }
    $urls += "https://raw.githubusercontent.com/$JarvisRepo/main/tools/terminal_boot/jarvis_boot_forever.py"

    foreach ($url in $urls) {
        try {
            return (Invoke-WebRequest -Uri $url -UseBasicParsing -Headers $headers -TimeoutSec 15).Content
        } catch {
            continue
        }
    }

    throw 'Unable to retrieve jarvis_boot_forever.py.'
}

function Backup-LauncherFile ($path) {
    if (-not (Test-Path -LiteralPath $path)) {
        return
    }
    $stamp = Get-Date -Format 'yyyyMMddHHmmss'
    Copy-Item -LiteralPath $path -Destination "$path.bak.$stamp" -Force
}

function Install-TerminalLauncherForever ($exePath) {
    $binDir = Join-Path $env:USERPROFILE '.jarvis\bin'
    $cmdPath = Join-Path $binDir 'Jarvis.cmd'
    $scriptPath = Join-Path $binDir 'Jarvis.ps1'
    $corePath = Join-Path $binDir 'JarvisCore.ps1'
    $updatePath = Join-Path $binDir 'JarvisUpdate.ps1'
    $bootPath = Join-Path $binDir 'jarvis_boot_forever.py'
    New-Item -ItemType Directory -Path $binDir -Force | Out-Null

    $versionHint = ''
    try {
        $versionHint = (Get-Item -LiteralPath $exePath).VersionInfo.ProductVersion
    } catch {
        $versionHint = ''
    }
    $bootSource = Get-TerminalBootSource -VersionHint $versionHint

    $cmdLauncher = @'
@echo off
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0Jarvis.ps1" %*
'@
    $coreLauncher = @"
`$ErrorActionPreference = 'Stop'
`$jarvisExe = '$($exePath.Replace("'", "''"))'
if (-not (Test-Path -LiteralPath `$jarvisExe)) {
  Write-Error 'Jarvis executable not found. Reinstall Jarvis One and try again.'
  exit 1
}
Start-Process -FilePath `$jarvisExe -WorkingDirectory (Split-Path -Parent `$jarvisExe)
"@
    $updateLauncher = @"
`$ErrorActionPreference = 'Stop'
`$jarvisExe = '$($exePath.Replace("'", "''"))'
`$repo = '$JarvisRepo'
`$localInstaller = Join-Path `$env:USERPROFILE 'projects\Jarvis\install\install.ps1'
`$remoteInstaller = "https://raw.githubusercontent.com/`$repo/main/install/install.ps1"

function Normalize-Version([string]`$value) {
  if ([string]::IsNullOrWhiteSpace(`$value)) { return [version]'0.0.0' }
  `$clean = (`$value -replace '^v', '') -replace '[^0-9\.].*$', ''
  try { return [version]`$clean } catch { return [version]'0.0.0' }
}

function Get-InstalledVersion() {
  if (-not (Test-Path -LiteralPath `$jarvisExe)) { return [version]'0.0.0' }
  try {
    return Normalize-Version ((Get-Item -LiteralPath `$jarvisExe).VersionInfo.ProductVersion)
  } catch {
    return [version]'0.0.0'
  }
}

try {
  `$release = Invoke-RestMethod -Uri "https://api.github.com/repos/`$repo/releases/latest" -Headers @{ 'User-Agent' = 'jarvis-terminal-launcher' } -TimeoutSec 15
  `$latestVersion = Normalize-Version `$release.tag_name
  `$installedVersion = Get-InstalledVersion
  if (`$latestVersion -le `$installedVersion) {
    exit 0
  }

  `$env:JARVIS_SILENT = '1'
  `$env:JARVIS_FORMAT = 'nsis'
  if (Test-Path -LiteralPath `$localInstaller) {
    & powershell -NoProfile -ExecutionPolicy Bypass -File `$localInstaller
    exit `$LASTEXITCODE
  }

  & powershell -NoProfile -ExecutionPolicy Bypass -Command "irm '`$remoteInstaller' | iex"
  exit `$LASTEXITCODE
} catch {
  Write-Warning ('Jarvis update check failed: ' + `$_.Exception.Message)
  exit 0
}
"@
    $psLauncher = @"
`$ErrorActionPreference = 'Stop'
`$binDir = Split-Path -Parent `$MyInvocation.MyCommand.Path
`$bootScript = Join-Path `$binDir 'jarvis_boot_forever.py'
`$coreScript = Join-Path `$binDir 'JarvisCore.ps1'
`$updateScript = Join-Path `$binDir 'JarvisUpdate.ps1'

function Resolve-PythonCommand {
  if (Get-Command python -ErrorAction SilentlyContinue) { return @('python') }
  if (Get-Command py -ErrorAction SilentlyContinue) { return @('py', '-3') }
  return `$null
}

if (-not (Test-Path -LiteralPath `$bootScript)) {
  Write-Error 'Jarvis terminal boot script is missing. Reinstall the Jarvis launcher.'
  exit 1
}

`$pythonCommand = Resolve-PythonCommand
if (-not `$pythonCommand) {
  Write-Warning 'Python was not found. Launching Jarvis One directly.'
  & powershell -NoProfile -ExecutionPolicy Bypass -File `$coreScript
  exit `$LASTEXITCODE
}

`$updateCommand = 'powershell -NoProfile -ExecutionPolicy Bypass -File "' + `$updateScript + '"'
`$appCommand = 'powershell -NoProfile -ExecutionPolicy Bypass -File "' + `$coreScript + '"'
`$bootArgs = @(
  `$bootScript,
  '--update-command', `$updateCommand,
  '--ignore-update-failure',
  '--app-command', `$appCommand,
  '--app-cwd', `$env:USERPROFILE,
  '--app-process-name', 'jarvis.exe',
  '--launch-wait-seconds', '7',
  '--timeout', '900',
  '--forever'
)
& `$pythonCommand[0] @(`$pythonCommand | Select-Object -Skip 1) @bootArgs
exit `$LASTEXITCODE
"@

    Backup-LauncherFile $cmdPath
    Backup-LauncherFile $scriptPath
    Backup-LauncherFile $corePath
    Backup-LauncherFile $updatePath
    Backup-LauncherFile $bootPath
    Set-Content -LiteralPath $cmdPath -Value $cmdLauncher -Encoding ASCII
    Set-Content -LiteralPath $corePath -Value $coreLauncher -Encoding UTF8
    Set-Content -LiteralPath $updatePath -Value $updateLauncher -Encoding UTF8
    Set-Content -LiteralPath $scriptPath -Value $psLauncher -Encoding UTF8
    Set-Content -LiteralPath $bootPath -Value $bootSource -Encoding UTF8

    $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    $entries = @($userPath -split ';' | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
    if (-not ($entries | Where-Object { $_.Trim().Equals($binDir, [StringComparison]::OrdinalIgnoreCase) })) {
        $updatedPath = (@($entries) + $binDir) -join ';'
        [Environment]::SetEnvironmentVariable('Path', $updatedPath, 'User')
    }
    if (-not (($env:Path -split ';') | Where-Object { $_.Trim().Equals($binDir, [StringComparison]::OrdinalIgnoreCase) })) {
        $env:Path = "$binDir;$env:Path"
    }
    Write-Ok 'Terminal command ready: Jarvis'
    return $scriptPath
}

# --- Main -----------------------------------------------------------------
Write-Banner

$arch    = Test-Architecture
$format  = if ($env:JARVIS_FORMAT) { $env:JARVIS_FORMAT.ToLower() } else { 'nsis' }
$silent  = $true
$silentRaw = $env:JARVIS_SILENT
if (-not [string]::IsNullOrWhiteSpace($silentRaw)) {
    $silent = $silentRaw -ne '0'
}
$dryrun  = $env:JARVIS_DRYRUN -eq '1'
$keepDownload = $env:JARVIS_KEEP_DOWNLOAD -eq '1'

if ($format -notin @('nsis', 'msi')) {
    Write-Fail "Unsupported JARVIS_FORMAT '$format'. Use 'nsis' or 'msi'."
    exit 1
}

if ($silent -and $format -eq 'msi') {
    Write-Warn 'Silent mode requires NSIS to avoid UAC elevation. Switching format from msi to nsis.'
    $format = 'nsis'
}

Write-Step "Architecture:   $arch"
Write-Step "Format:         $format"
Write-Step "Silent:         $silent"
Write-Step "Dry run:        $dryrun"
if ($env:JARVIS_DOWNLOAD_DIR) {
    Write-Step "Download dir:   $env:JARVIS_DOWNLOAD_DIR"
}

Test-WindowsVersion

$wv2 = Test-WebView2
if ($wv2) {
    Write-Ok "WebView2 runtime present (version $wv2)"
} else {
    Write-Warn "WebView2 runtime not found."
    Write-Warn "Jarvis needs Microsoft Edge WebView2. Get it from:"
    Write-Warn "  https://developer.microsoft.com/microsoft-edge/webview2/"
    Write-Warn "On Windows 11 it is preinstalled. Continuing - if Jarvis fails to launch, install WebView2 first."
}

# Choose installer source
$tmpDir = $null
$installerPath = $null

if ($env:JARVIS_LOCAL -eq '1') {
    Write-Step "Using LOCAL build (JARVIS_LOCAL=1)"
    $installerPath = Get-LocalInstaller -format $format
    Write-Ok "Local installer: $installerPath"
} else {
    $version = Get-LatestVersion
    $url     = Resolve-DownloadUrl -version $version -format $format
    $fname   = Split-Path $url -Leaf
    $tmpDir = New-InstallerTempDir
    $installerPath = Join-Path $tmpDir $fname
    try {
        Save-DownloadFile -url $url -outFile $installerPath
    } catch {
        Write-Fail $_.Exception.Message
        Write-Warn "If the GitHub release does not exist yet, set JARVIS_LOCAL=1 to install from your local build."
        exit 1
    }
}

# Verify
Test-FileSignature -file $installerPath
$shortHash = Get-FileHashShort -file $installerPath
Write-Ok "SHA256 (first 16): $shortHash"

if ($dryrun) {
    Write-Ok "Dry run complete. Installer staged at: $installerPath"
    exit 0
}

# Admin check (only required for MSI per-machine installs)
if ($format -eq 'msi' -and -not (Test-IsAdmin)) {
    Write-Step "MSI installer requires admin elevation. UAC prompt incoming..."
}

# Run
$exit = Invoke-Installer -file $installerPath -format $format -silent $silent
if ($exit -eq 0) {
    Write-Host ""
    Write-Ok "Jarvis installed."
    Write-Host ""
    
    # Auto-open Jarvis. Tauri's current-user NSIS target installs under
    # %LOCALAPPDATA%\Programs\Jarvis One, while older local builds used the
    # legacy %LOCALAPPDATA%\Jarvis One path.
    $exePath = Get-InstalledJarvisExe
    if ($exePath -and (Test-Path -LiteralPath $exePath)) {
        $launcherScript = Install-TerminalLauncherForever -exePath $exePath
        Write-Step "Auto-launching Jarvis terminal..."
        Start-Process -FilePath 'powershell.exe' -ArgumentList @(
            '-NoProfile',
            '-ExecutionPolicy',
            'Bypass',
            '-File',
            $launcherScript
        )
    } else {
        Write-Warn "Could not locate installed jarvis.exe to auto-launch."
    }
    
    Write-Host ""
    Write-Host "  Launch with:" -ForegroundColor Cyan
    Write-Host "      type 'Jarvis' to start Jarvis"
    Write-Host "      Start menu -> Jarvis One"
    Write-Host "      or: & `"`$env:LOCALAPPDATA\Programs\Jarvis One\jarvis.exe`""
    Write-Host ""
    Write-Host "  Voice push-to-talk:  Cmd/Ctrl + Space"
    Write-Host "  Command palette:     Cmd/Ctrl + K"
    Write-Host ""
} else {
    Write-Fail "Installer exited with code $exit"
    Write-Warn "If you cancelled the UAC prompt, run again. Otherwise see logs in %TEMP%."
    exit $exit
}

if ($tmpDir -and -not $keepDownload -and -not $dryrun -and (Test-Path -LiteralPath $tmpDir)) {
    Remove-Item -LiteralPath $tmpDir -Recurse -Force -ErrorAction SilentlyContinue
}

