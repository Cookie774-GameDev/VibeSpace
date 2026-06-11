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
     Matching updater signatures are generated and copied too.
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

# Tauri-canonical filenames as written by the bundler (productName may be Jarvis One or VibeSpace).
function Resolve-BundleArtifact {
  param([string]$Dir, [string[]]$Patterns)
  if (-not (Test-Path -LiteralPath $Dir)) { return $null }
  foreach ($pattern in $Patterns) {
    $hit = Get-ChildItem -LiteralPath $Dir -Filter $pattern -File -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($hit) { return $hit.FullName }
  }
  return $null
}

$nsisSrc = Resolve-BundleArtifact $nsisDir @(
  "VibeSpace_${Version}_x64-setup.exe",
  "Jarvis One_${Version}_x64-setup.exe"
)
$msiSrc = Resolve-BundleArtifact $msiDir @(
  "VibeSpace_${Version}_x64_en-US.msi",
  "Jarvis One_${Version}_x64_en-US.msi"
)
$nsisName = if ($nsisSrc) { Split-Path -Leaf $nsisSrc } else { "VibeSpace_${Version}_x64-setup.exe" }
$msiName  = if ($msiSrc)  { Split-Path -Leaf $msiSrc }  else { "VibeSpace_${Version}_x64_en-US.msi" }
$friendlyNsisName = "Jarvis-One-${Version}-Windows-x64.exe"
$friendlyMsiName = "Jarvis-One-${Version}-Windows-x64.msi"
$script:UpdaterSigningPasswordIsBlank = $false

# --- Pretty output ---------------------------------------------------------
function Write-Step ($msg) { Write-Host "  -> " -NoNewline -ForegroundColor Cyan; Write-Host $msg }
function Write-Ok   ($msg) { Write-Host "  OK " -NoNewline -ForegroundColor Green; Write-Host $msg }
function Write-Warn ($msg) { Write-Host "  !! " -NoNewline -ForegroundColor Yellow; Write-Host $msg -ForegroundColor Yellow }
function Write-Fail ($msg) { Write-Host "  XX " -NoNewline -ForegroundColor Red; Write-Host $msg -ForegroundColor Red }

function Get-ConfiguredUpdaterPublicKey {
  $tauriConfigPath = Join-Path $AppDir 'src-tauri\tauri.conf.json'
  $tauriConfig = Get-Content -LiteralPath $tauriConfigPath -Raw | ConvertFrom-Json
  $publicKey = $tauriConfig.plugins.updater.pubkey
  if ([string]::IsNullOrWhiteSpace($publicKey)) {
    Write-Fail "Updater public key is missing from $tauriConfigPath"
    exit 1
  }
  return $publicKey.Trim()
}

function Test-UpdaterKeyPair {
  param(
    [Parameter(Mandatory = $true)]
    [string]$PrivateKeyPath,
    [Parameter(Mandatory = $true)]
    [string]$ConfiguredPublicKey
  )

  $publicKeyPath = "$PrivateKeyPath.pub"
  if (-not (Test-Path -LiteralPath $publicKeyPath)) {
    return $false
  }

  $candidatePublicKey = (Get-Content -LiteralPath $publicKeyPath -Raw).Trim()
  return $candidatePublicKey -eq $ConfiguredPublicKey
}

function Initialize-UpdaterSigningKey {
  $hasInlineKey = -not [string]::IsNullOrWhiteSpace($env:TAURI_SIGNING_PRIVATE_KEY)
  $hasKeyPath = -not [string]::IsNullOrWhiteSpace($env:TAURI_SIGNING_PRIVATE_KEY_PATH)
  $configuredPublicKey = Get-ConfiguredUpdaterPublicKey
  $tauriKeyDir = Join-Path $env:USERPROFILE '.tauri'
  $defaultKeyPaths = @(
    (Join-Path $tauriKeyDir 'jarvis.key'),
    (Join-Path $tauriKeyDir 'jarvis-plain.key')
  )

  if ($hasKeyPath -and -not (Test-Path -LiteralPath $env:TAURI_SIGNING_PRIVATE_KEY_PATH)) {
    Write-Fail "TAURI_SIGNING_PRIVATE_KEY_PATH does not exist: $env:TAURI_SIGNING_PRIVATE_KEY_PATH"
    exit 1
  }

  if (-not $hasInlineKey -and -not $hasKeyPath) {
    $matchingKeyPath = $defaultKeyPaths |
      Where-Object {
        (Test-Path -LiteralPath $_) -and
        (Test-UpdaterKeyPair -PrivateKeyPath $_ -ConfiguredPublicKey $configuredPublicKey)
      } |
      Select-Object -First 1

    if ($matchingKeyPath) {
      $env:TAURI_SIGNING_PRIVATE_KEY_PATH = $matchingKeyPath
      $hasKeyPath = $true
      Write-Ok "Using updater signing key at $matchingKeyPath"
    }
  }

  if (-not $hasInlineKey -and -not $hasKeyPath) {
    Write-Fail 'Missing Tauri updater signing private key.'
    Write-Warn 'Set TAURI_SIGNING_PRIVATE_KEY or TAURI_SIGNING_PRIVATE_KEY_PATH before running release:windows.'
    Write-Warn "For local maintainer builds, place the key and matching .pub file in $tauriKeyDir."
    Write-Warn 'Without this key, Tauri cannot generate .sig files and latest.json cannot be valid.'
    exit 1
  }

  if ($hasKeyPath) {
    $keyPath = (Resolve-Path -LiteralPath $env:TAURI_SIGNING_PRIVATE_KEY_PATH).Path
    if (-not (Test-UpdaterKeyPair -PrivateKeyPath $keyPath -ConfiguredPublicKey $configuredPublicKey)) {
      Write-Fail "Updater key does not match app/src-tauri/tauri.conf.json: $keyPath"
      Write-Warn "Expected a matching public key at $keyPath.pub"
      exit 1
    }

    $env:TAURI_SIGNING_PRIVATE_KEY_PATH = $keyPath
    $passwordPath = "$keyPath.password"
    if ([string]::IsNullOrWhiteSpace($env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD) -and (Test-Path -LiteralPath $passwordPath)) {
      $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = (Get-Content -LiteralPath $passwordPath -Raw).TrimEnd()
      Write-Ok "Loaded updater signing key password from $passwordPath"
    } elseif ([string]::IsNullOrWhiteSpace($env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD)) {
      $blankPasswordPath = Join-Path $tauriKeyDir 'empty-password.txt'
      if (Test-Path -LiteralPath $blankPasswordPath) {
        $script:UpdaterSigningPasswordIsBlank = $true
        Write-Ok "Using an empty updater signing key password"
      }
    }
  } elseif ([string]::IsNullOrWhiteSpace($env:TAURI_SIGNING_PUBLIC_KEY)) {
    Write-Fail 'Inline updater keys require TAURI_SIGNING_PUBLIC_KEY for pair validation.'
    Write-Warn 'Prefer TAURI_SIGNING_PRIVATE_KEY_PATH with a sibling .pub file.'
    exit 1
  } elseif ($env:TAURI_SIGNING_PUBLIC_KEY.Trim() -ne $configuredPublicKey) {
    Write-Fail 'TAURI_SIGNING_PUBLIC_KEY does not match app/src-tauri/tauri.conf.json.'
    exit 1
  }
}

function Invoke-UpdaterSignature {
  param(
    [Parameter(Mandatory = $true)]
    [string]$ArtifactPath
  )

  if (-not (Test-Path -LiteralPath $ArtifactPath)) {
    Write-Fail "Cannot sign missing updater artifact: $ArtifactPath"
    exit 1
  }

  Write-Step "Generating updater signature for $(Split-Path -Leaf $ArtifactPath)..."
  $tauriCli = Join-Path $RepoRoot 'node_modules\@tauri-apps\cli\tauri.js'
  $nodePath = (Get-Command node -ErrorAction Stop).Source

  if ($script:UpdaterSigningPasswordIsBlank) {
    # Windows PowerShell drops empty native arguments, so cmd.exe is used to
    # preserve the explicit `-p ""` required by an unencrypted minisign key.
    $command = '"{0}" "{1}" signer sign -f "{2}" -p "" "{3}"' -f `
      $nodePath, $tauriCli, $env:TAURI_SIGNING_PRIVATE_KEY_PATH, $ArtifactPath
    & cmd.exe /d /s /c $command
  } else {
    & $nodePath $tauriCli signer sign $ArtifactPath
  }

  if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath "$ArtifactPath.sig")) {
    throw "Updater signing failed for $ArtifactPath"
  }
  Write-Ok "Generated $(Split-Path -Leaf "$ArtifactPath.sig")"
}

Write-Host ""
Write-Host "  Jarvis release pipeline (Windows x64)" -ForegroundColor Cyan
Write-Host "  version: $Version" -ForegroundColor Gray
Write-Host ""

# --- 1. Build (unless skipped) ---------------------------------------------
if (-not $SkipBuild) {
  Initialize-UpdaterSigningKey

  foreach ($dir in @($nsisDir, $msiDir)) {
    if (-not (Test-Path -LiteralPath $dir)) { continue }
    Get-ChildItem -LiteralPath $dir -Filter '*.sig' -File -ErrorAction SilentlyContinue | ForEach-Object {
      Remove-Item -LiteralPath $_.FullName -Force
      Write-Warn "Removed stale pre-build updater signature: $($_.Name)"
    }
  }

  $signScript = Join-Path $RepoRoot 'scripts\sign-windows.ps1'
  $signConfig = Join-Path $AppDir 'src-tauri\tauri.windows-signing.generated.json'
  $signingConfigObject = @{
    bundle = @{
      createUpdaterArtifacts = $false
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
  $nsisSrc = Resolve-BundleArtifact $nsisDir @(
    "VibeSpace_${Version}_x64-setup.exe",
    "Jarvis One_${Version}_x64-setup.exe"
  )
  $msiSrc = Resolve-BundleArtifact $msiDir @(
    "VibeSpace_${Version}_x64_en-US.msi",
    "Jarvis One_${Version}_x64_en-US.msi"
  )
  if (-not $nsisSrc) { throw "NSIS installer not found under $nsisDir after build." }
  $nsisName = Split-Path -Leaf $nsisSrc
  if ($msiSrc) { $msiName = Split-Path -Leaf $msiSrc }
  Invoke-UpdaterSignature -ArtifactPath $nsisSrc
  if ($msiSrc) { Invoke-UpdaterSignature -ArtifactPath $msiSrc }
} else {
  Write-Warn 'Skipping build (-SkipBuild)'
  $nsisSrc = Resolve-BundleArtifact $nsisDir @(
    "VibeSpace_${Version}_x64-setup.exe",
    "Jarvis One_${Version}_x64-setup.exe"
  )
  $msiSrc = Resolve-BundleArtifact $msiDir @(
    "VibeSpace_${Version}_x64_en-US.msi",
    "Jarvis One_${Version}_x64_en-US.msi"
  )
  if ($nsisSrc) { $nsisName = Split-Path -Leaf $nsisSrc }
  if ($msiSrc) { $msiName = Split-Path -Leaf $msiSrc }
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
