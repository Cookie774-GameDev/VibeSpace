<#
.SYNOPSIS
  Download, verify, and run the current-user VibeSpace Windows installer.
.DESCRIPTION
  Optional JARVIS_VERSION, JARVIS_LOCAL=1, JARVIS_SILENT=1,
  JARVIS_DRYRUN=1, JARVIS_DOWNLOAD_DIR and JARVIS_FORMAT=nsis.
  Local bootstrap uses releases/SHA256SUMS.txt without a service request.
  The packaged installer may need internet to provision missing WebView2.
  Downloads are retained for diagnosis. Existing app settings are left to the
  packaged installer; this bootstrap never removes profiles or edits config.
#>
[CmdletBinding()]
param()

function Test-VibeSpaceFlag {
  param([string]$Value)
  return $Value -match '^(?i:1|true|yes|on)$'
}

function Assert-VibeSpaceVersion {
  param([string]$Version)
  $normalized = $Version -replace '^v', ''
  if ($normalized -notmatch '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$') {
    throw 'Invalid release version. Use a version such as 1.5.0.'
  }
  return $normalized
}

function Assert-VibeSpacePlatform {
  param([string]$Platform, [string]$Architecture, [int]$WindowsBuild)
  # Matches docs/FEATURES_GUIDE.md: Windows 10 1809+; release target is x64.
  if ($Platform -ne 'Win32NT' -or $Architecture -ne 'AMD64' -or $WindowsBuild -lt 17763) {
    throw 'This installer requires Windows 10 1809 (build 17763) or later on x64, as documented by VibeSpace. Download a supported package for other platforms.'
  }
}

function Get-VibeSpaceInstallerNames {
  param([string]$Version)
  $versionValue = Assert-VibeSpaceVersion $Version
  return @("VibeSpace_${versionValue}_x64-setup.exe", "VibeSpace-${versionValue}-Windows-x64.exe")
}

function Get-VibeSpaceChecksum {
  param([string]$Text, [string]$FileName)
  if ($Text.Length -gt 1048576 -or [IO.Path]::GetFileName($FileName) -ne $FileName) {
    throw 'Invalid release checksum list.'
  }
  $foundHashes = @()
  foreach ($line in ($Text -split '\r?\n')) {
    $trimmed = $line.Trim().TrimStart([char]0xFEFF)
    if (-not $trimmed -or $trimmed.StartsWith('#')) { continue }
    if ($trimmed -notmatch '^([0-9a-fA-F]{64})[ \t]+\*?([^\r\n]+)$') {
      throw 'Invalid release checksum entry.'
    }
    if ($Matches[2] -ceq $FileName) { $foundHashes += $Matches[1].ToLowerInvariant() }
  }
  if ($foundHashes.Count -ne 1) { throw 'Expected exactly one checksum for the selected installer.' }
  return $foundHashes[0]
}

function Assert-VibeSpaceReleaseUrl {
  param([string]$Url, [string]$Tag, [string]$Name)
  $expected = 'https://github.com/Cookie774-GameDev/VibeSpace/releases/download/' + [Uri]::EscapeDataString($Tag) + '/' + [Uri]::EscapeDataString($Name)
  if ($Url -cne $expected) { throw 'Release asset does not belong to the selected VibeSpace release.' }
  return $Url
}

function Select-VibeSpaceReleaseAsset {
  param($Release, [string]$Version)
  if ($Release.draft -or $Release.tag_name -cne "v$Version") { throw 'Release identity does not match the requested version.' }
  $assets = @($Release.assets)
  foreach ($name in (Get-VibeSpaceInstallerNames $Version)) {
    $selected = @($assets | Where-Object { $_.name -ceq $name })
    if ($selected.Count -gt 1) { throw 'Duplicate release installer assets.' }
    if ($selected.Count -eq 1) {
      $asset = $selected[0]
      if ([long]$asset.size -le 0 -or [long]$asset.size -gt 2147483648) { throw 'Invalid release installer size.' }
      [void](Assert-VibeSpaceReleaseUrl $asset.browser_download_url $Release.tag_name $name)
      return $asset
    }
  }
  throw 'This release has no supported Windows x64 NSIS installer.'
}

function Assert-VibeSpacePlainPath {
  param([string]$Path)
  $current = [IO.Path]::GetFullPath($Path)
  while ($current) {
    if (Test-Path -LiteralPath $current) {
      $item = Get-Item -LiteralPath $current -Force -ErrorAction Stop
      if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Installer paths must not traverse a symbolic link or junction.' }
    }
    $parent = [IO.Path]::GetDirectoryName($current.TrimEnd('\', '/'))
    if (-not $parent -or $parent -eq $current) { break }
    $current = $parent
  }
  return [IO.Path]::GetFullPath($Path)
}

function Invoke-VibeSpaceVerifiedInstaller {
  param([string]$Path, [string]$Checksum, [switch]$DryRun, [switch]$Silent)
  $fullPath = Assert-VibeSpacePlainPath $Path
  if ($Checksum -notmatch '^[0-9a-f]{64}$') { throw 'Invalid expected installer checksum.' }
  # Keep the verified file bound through launch; replacement/writing is refused.
  $file = [IO.File]::Open($fullPath, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
  $hasher = [Security.Cryptography.SHA256]::Create()
  try {
    $actual = ([BitConverter]::ToString($hasher.ComputeHash($file))).Replace('-', '').ToLowerInvariant()
    if ($actual -cne $Checksum) { throw 'Installer checksum mismatch. The retained download was not executed; retry from the published release.' }
    if ($DryRun) { return [pscustomobject]@{ Status = 'Verified'; Path = $fullPath; Sha256 = $actual; Installed = $false } }
    $startArgs = @{ FilePath = $fullPath; Wait = $true; PassThru = $true }
    if ($Silent) { $startArgs.ArgumentList = @('/S') }
    $process = Start-Process @startArgs
    if ($process.ExitCode -ne 0) { throw "VibeSpace installer failed with exit code $($process.ExitCode). The download is retained for retry; existing settings were not removed." }
    return [pscustomobject]@{ Status = 'InstallerCompleted'; Path = $fullPath; Sha256 = $actual; Installed = $true }
  } finally {
    $hasher.Dispose()
    $file.Dispose()
  }
}

function Invoke-VibeSpaceWindowsInstall {
  param([string]$ScriptRoot)
  $ErrorActionPreference = 'Stop'
  $architecture = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
  Assert-VibeSpacePlatform ([Environment]::OSVersion.Platform.ToString()) $architecture ([Environment]::OSVersion.Version.Build)
  if ($env:JARVIS_FORMAT -and $env:JARVIS_FORMAT -ne 'nsis') { throw 'The current-user bootstrap supports JARVIS_FORMAT=nsis. Use the published MSI directly if needed.' }
  $dryRun = Test-VibeSpaceFlag $env:JARVIS_DRYRUN
  $silent = Test-VibeSpaceFlag $env:JARVIS_SILENT
  if (Test-VibeSpaceFlag $env:JARVIS_LOCAL) {
    if (-not $ScriptRoot) { throw 'Local mode requires running the saved install/install.ps1 file from the checkout.' }
    $root = Split-Path -Parent $ScriptRoot
    $version = if ($env:JARVIS_VERSION) { Assert-VibeSpaceVersion $env:JARVIS_VERSION } else { Assert-VibeSpaceVersion ((Get-Content -LiteralPath (Join-Path $root 'package.json') -Raw | ConvertFrom-Json).version) }
    $releaseRoot = Assert-VibeSpacePlainPath (Join-Path $root 'releases')
    $selected = @(Get-VibeSpaceInstallerNames $version | ForEach-Object { Join-Path $releaseRoot $_ } | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf })
    if ($selected.Count -eq 0) { throw 'No local installer for this version. Run release:windows first.' }
    $checksum = Get-VibeSpaceChecksum (Get-Content -LiteralPath (Join-Path $releaseRoot 'SHA256SUMS.txt') -Raw) ([IO.Path]::GetFileName($selected[0]))
    return Invoke-VibeSpaceVerifiedInstaller $selected[0] $checksum -DryRun:$dryRun -Silent:$silent
  }
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
  $api = 'https://api.github.com/repos/Cookie774-GameDev/VibeSpace/releases/'
  $endpoint = if ($env:JARVIS_VERSION) { 'tags/' + [Uri]::EscapeDataString('v' + (Assert-VibeSpaceVersion $env:JARVIS_VERSION)) } else { 'latest' }
  try {
    $release = Invoke-RestMethod -Uri ($api + $endpoint) -Headers @{ 'User-Agent' = 'VibeSpace-Windows-Installer'; Accept = 'application/vnd.github+json' } -TimeoutSec 60
    $version = Assert-VibeSpaceVersion $release.tag_name
    $asset = Select-VibeSpaceReleaseAsset $release $version
    $sums = @($release.assets | Where-Object { $_.name -ceq 'SHA256SUMS.txt' })
    if ($sums.Count -ne 1 -or [long]$sums[0].size -le 0 -or [long]$sums[0].size -gt 1048576) { throw 'Release checksum asset is missing or invalid.' }
    $checksumUrl = Assert-VibeSpaceReleaseUrl $sums[0].browser_download_url $release.tag_name 'SHA256SUMS.txt'
    $checksumText = (Invoke-WebRequest -Uri $checksumUrl -UseBasicParsing -TimeoutSec 60).Content
    $checksum = Get-VibeSpaceChecksum $checksumText $asset.name
    $downloadParent = if ($env:JARVIS_DOWNLOAD_DIR) { $env:JARVIS_DOWNLOAD_DIR } else { [IO.Path]::GetTempPath() }
    $downloadParent = Assert-VibeSpacePlainPath $downloadParent
    [void][IO.Directory]::CreateDirectory($downloadParent)
    $downloadDir = Join-Path $downloadParent ('vibespace-install-' + [Guid]::NewGuid().ToString('N'))
    [void][IO.Directory]::CreateDirectory($downloadDir)
    $download = Join-Path $downloadDir $asset.name
    Invoke-WebRequest -Uri $asset.browser_download_url -UseBasicParsing -OutFile $download -TimeoutSec 600
    if ((Get-Item -LiteralPath $download).Length -ne [long]$asset.size) { throw 'Incomplete installer download.' }
    return Invoke-VibeSpaceVerifiedInstaller $download $checksum -DryRun:$dryRun -Silent:$silent
  } catch {
    throw "VibeSpace setup stopped: $($_.Exception.Message) Retry when online, or download the installer and SHA256SUMS.txt from the same published release. No profile data was deleted."
  }
}

if ($MyInvocation.InvocationName -ne '.') {
  Invoke-VibeSpaceWindowsInstall -ScriptRoot $PSScriptRoot
}
