<#
.SYNOPSIS
  Verify a downloaded VibeSpace installer against SHA256SUMS.txt from GitHub.

.DESCRIPTION
  Free integrity check for users — does not install anything.
  Example:
    .\scripts\verify-release-checksum.ps1 -Version 0.1.44 -InstallerPath .\VibeSpace_0.1.44_x64-setup.exe
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$Version,

  [Parameter(Mandatory = $true)]
  [string]$InstallerPath,

  [string]$Repo = 'Cookie774-GameDev/VibeSpace'
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path -LiteralPath $InstallerPath)) {
  throw "Installer not found: $InstallerPath"
}

$tag = "v$Version"
$sumsUrl = "https://github.com/$Repo/releases/download/$tag/SHA256SUMS.txt"
Write-Host "Fetching $sumsUrl"
$sumsText = (Invoke-WebRequest -Uri $sumsUrl -UseBasicParsing).Content
$fileName = Split-Path -Leaf $InstallerPath
$expected = $null
foreach ($line in ($sumsText -split "`n")) {
  $trimmed = $line.Trim()
  if (-not $trimmed -or $trimmed.StartsWith('#')) { continue }
  $parts = $trimmed -split '\s+', 2
  if ($parts.Count -eq 2 -and $parts[1] -eq $fileName) {
    $expected = $parts[0].ToLower()
    break
  }
}

if (-not $expected) {
  throw "No SHA-256 entry for $fileName in $tag SHA256SUMS.txt"
}

$actual = (Get-FileHash -LiteralPath $InstallerPath -Algorithm SHA256).Hash.ToLower()
if ($actual -ne $expected) {
  Write-Host "FAIL: hash mismatch" -ForegroundColor Red
  Write-Host "  expected: $expected"
  Write-Host "  actual:   $actual"
  exit 1
}

Write-Host "OK: $fileName matches official $tag SHA-256" -ForegroundColor Green
