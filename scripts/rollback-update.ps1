<#
.SYNOPSIS
  Point all VibeSpace clients at a specific published version (rollback or promote).

.DESCRIPTION
  Updates releases/channel.json from an archived manifest in releases/manifests/.
  The desktop updater (v0.1.39+) checks this file on GitHub main, so pushing the
  change rolls every user back to a known-good installer without deleting releases.

.PARAMETER Version
  Target semver, e.g. 0.1.38

.PARAMETER Push
  git commit + push channel.json to origin/main after updating.

.EXAMPLE
  .\scripts\rollback-update.ps1 -Version 0.1.38 -Push
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory)]
  [string]$Version,
  [switch]$Push
)

$ErrorActionPreference = 'Stop'
$RepoRoot = Split-Path -Parent $PSScriptRoot
$ManifestsDir = Join-Path $RepoRoot 'releases\manifests'
$ChannelPath = Join-Path $RepoRoot 'releases\channel.json'
$Source = Join-Path $ManifestsDir "v$Version.json"

if (-not (Test-Path -LiteralPath $Source)) {
  throw "Manifest not found: $Source. Archive it first with release-windows.ps1 or copy from a published latest.json."
}

$json = Get-Content -LiteralPath $Source -Raw | ConvertFrom-Json
if ([string]$json.version -ne $Version) {
  throw "Manifest version mismatch: file says $($json.version), expected $Version"
}

Copy-Item -LiteralPath $Source -Destination $ChannelPath -Force
Write-Host "OK  channel.json -> v$Version ($Source)" -ForegroundColor Green

if ($Push) {
  Push-Location $RepoRoot
  try {
    git add releases/channel.json
    git commit -m "Rollback update channel to v$Version." -m "All clients on the channel.json updater endpoint will receive v$Version on next check."
    git push origin HEAD
    Write-Host "OK  Pushed channel.json to origin" -ForegroundColor Green
  } finally {
    Pop-Location
  }
} else {
  Write-Host "Next: git add releases/channel.json && git commit && git push" -ForegroundColor Cyan
  Write-Host "Or rerun with -Push" -ForegroundColor Cyan
}
