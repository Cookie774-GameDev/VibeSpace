<#
.SYNOPSIS
  Build the Tauri desktop app for Windows and stage installers in releases\.

.DESCRIPTION
  This script automates the "I want to ship Jarvis to a user" flow.

  1. Runs `npm run tauri:build` (unless -SkipBuild). This produces an NSIS
     setup .exe and an MSI inside app\src-tauri\target\release\bundle\.
  2. Copies them into releases\ with two filenames each:
       - The Tauri-canonical name (Jarvis One_<v>_x64-setup.exe) so install.ps1
         keeps working when published to GitHub Releases.
       - A friendly name (Jarvis-<v>-Windows-x64.exe) for direct downloads.
     If Tauri generated updater signatures, matching .sig files are copied too.
  3. Builds releases\latest.json for tauri-plugin-updater.
  4. Computes SHA-256 hashes and updates releases\SHA256SUMS.txt.
  5. Prints a summary.

  Run from any directory; the script resolves paths relative to itself.

.PARAMETER SkipBuild
  Skip the tauri:build step. Use when the bundle is already up to date and
  you only need to re-stage / re-checksum.

.PARAMETER Version
  Override the version string used in friendly filenames. Defaults to the
  version found in package.json.

.EXAMPLE
  npm run release:windows

.EXAMPLE
  npm run release:stage      # uses last successful build
#>
[CmdletBinding()]
param(
  [switch]$SkipBuild,
  [string]$Version
)

$ErrorActionPreference = 'Stop'
$ProgressPreference    = 'SilentlyContinue'

# --- Paths ------------------------------------------------------------------
# Resolve repo root from the script location so this works no matter where
# it's invoked from.
$ScriptDir   = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot    = Split-Path -Parent $ScriptDir
$AppDir      = Join-Path $RepoRoot 'app'
$BundleDir   = Join-Path $AppDir   'src-tauri\target\release\bundle'
$ReleasesDir = Join-Path $RepoRoot 'releases'

if (-not $Version) {
  # Read version from app/package.json so renames stay in lockstep with Tauri.
  $pkgPath = Join-Path $AppDir 'package.json'
  if (-not (Test-Path -LiteralPath $pkgPath)) {
    throw "package.json not found at $pkgPath"
  }
  $pkg = Get-Content -LiteralPath $pkgPath -Raw | ConvertFrom-Json
  $Version = $pkg.version
}

if (-not (Test-Path -LiteralPath $ReleasesDir)) {
  New-Item -ItemType Directory -Path $ReleasesDir -Force | Out-Null
}

$nsisDir = Join-Path $BundleDir 'nsis'
$msiDir  = Join-Path $BundleDir 'msi'

# Tauri-canonical filenames as written by the bundler.
$nsisName = "Jarvis One_${Version}_x64-setup.exe"
$msiName  = "Jarvis One_${Version}_x64_en-US.msi"

$nsisSrc = Join-Path $nsisDir $nsisName
$msiSrc  = Join-Path $msiDir  $msiName
$friendlyNsisName = "Jarvis-One-${Version}-Windows-x64.exe"
$friendlyMsiName = "Jarvis-One-${Version}-Windows-x64.msi"

# --- Pretty output ---------------------------------------------------------
function Write-Step ($msg) { Write-Host "  -> " -NoNewline -ForegroundColor Cyan; Write-Host $msg }
function Write-Ok   ($msg) { Write-Host "  OK " -NoNewline -ForegroundColor Green; Write-Host $msg }
function Write-Warn ($msg) { Write-Host "  !! " -NoNewline -ForegroundColor Yellow; Write-Host $msg -ForegroundColor Yellow }
function Write-Fail ($msg) { Write-Host "  XX " -NoNewline -ForegroundColor Red; Write-Host $msg -ForegroundColor Red }

Write-Host ""
Write-Host "  Jarvis release pipeline (Windows x64)" -ForegroundColor Cyan
Write-Host "  version: $Version" -ForegroundColor Gray
Write-Host ""

# --- 1. Build (unless skipped) ---------------------------------------------
if (-not $SkipBuild) {
  foreach ($staleSig in @("$nsisSrc.sig", "$msiSrc.sig")) {
    if (Test-Path -LiteralPath $staleSig) {
      Remove-Item -LiteralPath $staleSig -Force
      Write-Warn "Removed stale pre-build updater signature: $staleSig"
    }
  }

  $signScript = Join-Path $RepoRoot 'scripts\sign-windows.ps1'
  $signConfig = Join-Path $AppDir 'src-tauri\tauri.windows-signing.generated.json'
  $signingConfigObject = @{
    bundle = @{
      windows = @{
        signCommand = @{
          cmd = 'powershell'
          args = @(
            '-NoProfile',
            '-ExecutionPolicy',
            'Bypass',
            '-File',
            $signScript,
            '%1'
          )
        }
      }
    }
  }
  $signingConfigObject |
    ConvertTo-Json -Depth 8 |
    Set-Content -LiteralPath $signConfig -Encoding UTF8

  Write-Step 'Running npm run tauri:build (this takes 5-15 minutes)...'
  Push-Location -LiteralPath $AppDir
  try {
    & npm run tauri:build -- --config 'src-tauri\tauri.windows-signing.generated.json'
    if ($LASTEXITCODE -ne 0) {
      throw "tauri:build failed with exit code $LASTEXITCODE"
    }
  } finally {
    Pop-Location
  }
  Write-Ok 'Build complete'
} else {
  Write-Warn 'Skipping build (-SkipBuild)'
}

# --- 2. Locate built artifacts ---------------------------------------------
foreach ($releaseName in @(
  $nsisName,
  "$nsisName.sig",
  $msiName,
  "$msiName.sig",
  $friendlyNsisName,
  "$friendlyNsisName.sig",
  $friendlyMsiName,
  "$friendlyMsiName.sig",
  'latest.json'
)) {
  $existing = Join-Path $ReleasesDir $releaseName
  if (Test-Path -LiteralPath $existing) {
    Remove-Item -LiteralPath $existing -Force
    Write-Warn "Removed stale staged release asset: $releaseName"
  }
}

# --- 3. Stage with friendly + canonical names ------------------------------
$staged = @()

function Copy-Artifact {
  param([string]$Src, [string]$Canonical, [string]$Friendly)
  if (-not (Test-Path -LiteralPath $Src)) {
    Write-Warn "Not found: $Src - did the build succeed?"
    return @()
  }
  $copies = @()
  foreach ($name in @($Canonical, $Friendly)) {
    $dst = Join-Path $ReleasesDir $name
    Copy-Item -LiteralPath $Src -Destination $dst -Force
    $sizeMB = [math]::Round((Get-Item -LiteralPath $dst).Length / 1MB, 2)
    Write-Ok "Staged $name ($sizeMB MB)"
    $copies += $dst

    $sigSrc = "$Src.sig"
    if (Test-Path -LiteralPath $sigSrc) {
      $artifactItem = Get-Item -LiteralPath $Src
      $sigItem = Get-Item -LiteralPath $sigSrc
      if ($sigItem.LastWriteTimeUtc -lt $artifactItem.LastWriteTimeUtc) {
        Write-Warn "Ignoring stale updater signature for $Canonical; rebuild with TAURI_SIGNING_PRIVATE_KEY."
        continue
      }
      $sigDst = Join-Path $ReleasesDir "$name.sig"
      Copy-Item -LiteralPath $sigSrc -Destination $sigDst -Force
      Write-Ok "Staged $name.sig"
      $copies += $sigDst
    }
  }
  return $copies
}

$staged += Copy-Artifact `
  -Src       $nsisSrc `
  -Canonical $nsisName `
  -Friendly  $friendlyNsisName

$staged += Copy-Artifact `
  -Src       $msiSrc `
  -Canonical $msiName `
  -Friendly  $friendlyMsiName

if ($staged.Count -eq 0) {
  Write-Fail 'No installers staged. Aborting.'
  exit 1
}

# --- 4. Updater manifest ---------------------------------------------------
$manifestScript = Join-Path $RepoRoot 'scripts\build-updater-manifest.mjs'
if (Test-Path -LiteralPath $manifestScript) {
  Write-Step 'Building latest.json updater manifest...'
  $manifestPath = Join-Path $ReleasesDir 'latest.json'
  & node $manifestScript `
    --version $Version `
    --assets-dir $ReleasesDir `
    --base-url "https://github.com/Cookie774-GameDev/Jarivs-One/releases/download/v$Version" `
    --outfile $manifestPath
  if ($LASTEXITCODE -ne 0) {
    throw "updater manifest generation failed with exit code $LASTEXITCODE"
  }
  Write-Ok 'Wrote latest.json'
} else {
  Write-Warn "Manifest script not found: $manifestScript"
}

# --- 5. Checksums ----------------------------------------------------------
Write-Step 'Computing SHA-256 hashes...'
$sumsPath = Join-Path $ReleasesDir 'SHA256SUMS.txt'
$releaseFiles = @($staged)
if ($manifestPath -and (Test-Path -LiteralPath $manifestPath)) {
  $releaseFiles += $manifestPath
}
$releaseFiles = $releaseFiles |
  Where-Object { $_ -and (Test-Path -LiteralPath $_) } |
  ForEach-Object { (Get-Item -LiteralPath $_).FullName } |
  Sort-Object -Unique

# Only include the assets for this release. releases\ may contain older staged
# artifacts for manual testing, but those should not be checksummed or uploaded
# with the current GitHub release.
$lines = @()
$lines += "# SHA-256 checksums for Jarvis One $Version (Windows x64)"
$lines += "# Generated $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss zzz')"
$lines += ""

foreach ($releaseFile in $releaseFiles) {
  $item = Get-Item -LiteralPath $releaseFile
  $hash = (Get-FileHash -LiteralPath $item.FullName -Algorithm SHA256).Hash.ToLower()
  $lines += ('{0}  {1}' -f $hash, $item.Name)
  Write-Ok ("{0}  {1}" -f $hash.Substring(0,16), $item.Name)
}

Set-Content -LiteralPath $sumsPath -Value ($lines -join "`r`n") -Encoding UTF8
Write-Ok "Wrote $sumsPath"

# --- 6. Summary ------------------------------------------------------------
Write-Host ""
Write-Host "  Done." -ForegroundColor Green
Write-Host ""
Write-Host "  Staged in: $ReleasesDir" -ForegroundColor Cyan
Write-Host "  Files:"
$staged `
  | Where-Object { $_ -match '\.(exe|msi)$' -and (Test-Path -LiteralPath $_) } `
  | ForEach-Object { Get-Item -LiteralPath $_ } `
  | Sort-Object Name `
  | ForEach-Object {
      $sizeMB = [math]::Round($_.Length / 1MB, 2)
      Write-Host ("    {0,-45}  {1,8} MB" -f $_.Name, $sizeMB)
    }
Write-Host ""
Write-Host "  Next steps:" -ForegroundColor Cyan
Write-Host "    - Test:    Double-click any .exe in releases\ to install."
Write-Host "    - Publish: gh release create v$Version releases\*${Version}* releases\latest.json releases\SHA256SUMS.txt"
Write-Host "    - Docs:    See DOWNLOAD.md and releases\README.md."
Write-Host ""
