# Jarvis - Windows Terminal Installer
# Usage:    irm https://jarvis.app/install.ps1 | iex
# Or:       irm https://get.jarvis.app | iex
# GitHub:   irm https://raw.githubusercontent.com/Cookie774-GameDev/Jarivs-One/main/install/install.ps1 | iex
#
# Optional environment variables (set before piping into iex):
#   $env:JARVIS_VERSION  = "0.1.4"     pin to a specific version (default: latest)
#   $env:JARVIS_CHANNEL  = "stable"    stable or nightly (default: stable)
#   $env:JARVIS_FORMAT   = "nsis"      nsis (smaller, friendlier) or msi (IT-managed) (default: nsis)
#   $env:JARVIS_LOCAL    = "1"         install from the local C:\Users\viper\projects\Jarvis build (for self-testing)
#   $env:JARVIS_SILENT   = "1"         no UI, no prompts (current-user NSIS install)
#   $env:JARVIS_DRYRUN   = "1"         download + verify only, do not run installer

#Requires -Version 5.1
$ErrorActionPreference = 'Stop'
$ProgressPreference     = 'SilentlyContinue'

# --- Constants ------------------------------------------------------------
$JarvisRepo       = 'Cookie774-GameDev/Jarivs-One'
$JarvisGitHubApi  = "https://api.github.com/repos/$JarvisRepo/releases"
$JarvisDownloads  = "https://github.com/$JarvisRepo/releases/download"
$JarvisLocalBuild = 'C:\Users\viper\projects\Jarvis\app\src-tauri\target\release\bundle'

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
    try {
        $rel = Invoke-RestMethod -Uri "$JarvisGitHubApi/latest" -Headers @{ 'User-Agent' = 'jarvis-installer' } -TimeoutSec 15
        if ($rel.tag_name) {
            $v = ($rel.tag_name -replace '^v','')
            Write-Ok "Latest version: $v"
            return $v
        }
    } catch {
        Write-Warn "Could not reach GitHub (probably no public release yet). Falling back to a known good version."
    }
    return '0.1.4'
}

function Get-DownloadUrl ($version, $format) {
    # Match Tauri's bundle naming convention.
    if ($format -eq 'msi') {
        return "$JarvisDownloads/v$version/Jarvis%20One_${version}_x64_en-US.msi"
    } else {
        return "$JarvisDownloads/v$version/Jarvis%20One_${version}_x64-setup.exe"
    }
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
    try {
        Invoke-WebRequest -Uri $url -OutFile $tmp -UseBasicParsing -TimeoutSec 300
        Move-Item -LiteralPath $tmp -Destination $outFile -Force
        $size = [math]::Round((Get-Item $outFile).Length / 1MB, 2)
        Write-Ok "Downloaded $size MB"
    } catch {
        if (Test-Path $tmp) { Remove-Item $tmp -Force -ErrorAction SilentlyContinue }
        throw "Download failed: $($_.Exception.Message)"
    }
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

# --- Main -----------------------------------------------------------------
Write-Banner

$arch    = Test-Architecture
$format  = if ($env:JARVIS_FORMAT) { $env:JARVIS_FORMAT.ToLower() } else { 'nsis' }
$silent  = $env:JARVIS_SILENT -eq '1'
$dryrun  = $env:JARVIS_DRYRUN -eq '1'

if ($silent -and $format -eq 'msi') {
    Write-Warn 'Silent mode requires NSIS to avoid UAC elevation. Switching format from msi to nsis.'
    $format = 'nsis'
}

Write-Step "Architecture:   $arch"
Write-Step "Format:         $format"
Write-Step "Silent:         $silent"
Write-Step "Dry run:        $dryrun"

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
$tmpDir = Join-Path $env:TEMP "jarvis-installer-$(Get-Random)"
New-Item -ItemType Directory -Path $tmpDir -Force | Out-Null
$installerPath = $null

if ($env:JARVIS_LOCAL -eq '1') {
    Write-Step "Using LOCAL build (JARVIS_LOCAL=1)"
    $installerPath = Get-LocalInstaller -format $format
    Write-Ok "Local installer: $installerPath"
} else {
    $version = Get-LatestVersion
    $url     = Get-DownloadUrl -version $version -format $format
    $fname   = Split-Path $url -Leaf
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
    Write-Host "  Launch with:" -ForegroundColor Cyan
    Write-Host "      Start menu -> Jarvis One"
    Write-Host "      or: & `"`$env:LOCALAPPDATA\Jarvis One\jarvis.exe`""
    Write-Host ""
    Write-Host "  Voice push-to-talk:  Cmd/Ctrl + Space"
    Write-Host "  Command palette:     Cmd/Ctrl + K"
    Write-Host ""
} else {
    Write-Fail "Installer exited with code $exit"
    Write-Warn "If you cancelled the UAC prompt, run again. Otherwise see logs in %TEMP%."
    exit $exit
}
