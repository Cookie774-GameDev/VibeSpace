<#
.SYNOPSIS
  Authenticode-sign a Windows build artifact for VibeSpace.

.DESCRIPTION
  Intended for Tauri's bundle.windows.signCommand hook so Authenticode
  signing happens before Tauri generates updater signatures. This matters:
  signing after .sig generation changes the installer bytes and invalidates
  the updater signature.

  Supported inputs:
    WINDOWS_CERT_BASE64 + WINDOWS_CERT_PASSWORD
      Base64-encoded PFX and its password.

    WINDOWS_CERT_THUMBPRINT
      Thumbprint of a certificate already available in the CurrentUser or
      LocalMachine certificate store.

  If no certificate env is configured, the script no-ops by default so local
  unsigned builds still work. Set JARVIS_WINDOWS_SIGN_REQUIRED=1 to fail hard.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true, Position = 0)]
  [string]$FilePath
)

$ErrorActionPreference = 'Stop'

function Write-SignInfo($Message) {
  Write-Host "[VibeSpace signing] $Message"
}

function Find-SignTool {
  if ($env:SIGNTOOL_PATH -and (Test-Path -LiteralPath $env:SIGNTOOL_PATH)) {
    return $env:SIGNTOOL_PATH
  }

  $kitsRoot = "${env:ProgramFiles(x86)}\Windows Kits\10\bin"
  if (Test-Path -LiteralPath $kitsRoot) {
    $candidate = Get-ChildItem -LiteralPath $kitsRoot -Recurse -Filter signtool.exe -ErrorAction SilentlyContinue |
      Where-Object { $_.FullName -match '\\x64\\signtool\.exe$' } |
      Sort-Object FullName -Descending |
      Select-Object -First 1
    if ($candidate) {
      return $candidate.FullName
    }
  }

  $cmd = Get-Command signtool.exe -ErrorAction SilentlyContinue
  if ($cmd) {
    return $cmd.Source
  }

  throw 'signtool.exe was not found. Install Windows SDK or set SIGNTOOL_PATH.'
}

function Normalize-Base64($Value) {
  return ($Value -replace '\s+', '').Trim()
}

if (-not (Test-Path -LiteralPath $FilePath)) {
  throw "File to sign not found: $FilePath"
}

$hasPfx = -not [string]::IsNullOrWhiteSpace($env:WINDOWS_CERT_BASE64)
$hasThumbprint = -not [string]::IsNullOrWhiteSpace($env:WINDOWS_CERT_THUMBPRINT)

if (-not $hasPfx -and -not $hasThumbprint) {
  $message = 'No WINDOWS_CERT_BASE64 or WINDOWS_CERT_THUMBPRINT configured; leaving artifact unsigned.'
  if ($env:JARVIS_WINDOWS_SIGN_REQUIRED -eq '1') {
    throw $message
  }
  Write-SignInfo $message
  exit 0
}

$signtool = Find-SignTool
$timestampUrl = if ($env:WINDOWS_TIMESTAMP_URL) { $env:WINDOWS_TIMESTAMP_URL } else { 'http://timestamp.digicert.com' }
$description = if ($env:WINDOWS_SIGN_DESCRIPTION) { $env:WINDOWS_SIGN_DESCRIPTION } else { 'VibeSpace' }
$commonArgs = @(
  'sign',
  '/fd', 'SHA256',
  '/tr', $timestampUrl,
  '/td', 'SHA256',
  '/d', $description
)

$tempPfx = $null
try {
  if ($hasPfx) {
    if ([string]::IsNullOrWhiteSpace($env:WINDOWS_CERT_PASSWORD)) {
      throw 'WINDOWS_CERT_PASSWORD is required when WINDOWS_CERT_BASE64 is set.'
    }
    $tempPfx = Join-Path ([System.IO.Path]::GetTempPath()) ("jarvis-signing-{0}.pfx" -f ([Guid]::NewGuid()))
    [IO.File]::WriteAllBytes($tempPfx, [Convert]::FromBase64String((Normalize-Base64 $env:WINDOWS_CERT_BASE64)))
    $args = $commonArgs + @('/f', $tempPfx, '/p', $env:WINDOWS_CERT_PASSWORD, $FilePath)
  } else {
    $thumbprint = ($env:WINDOWS_CERT_THUMBPRINT -replace '\s+', '').Trim()
    $args = $commonArgs + @('/sha1', $thumbprint, $FilePath)
  }

  Write-SignInfo "Signing $(Split-Path -Leaf $FilePath)"
  & $signtool @args
  if ($LASTEXITCODE -ne 0) {
    throw "signtool failed with exit code $LASTEXITCODE"
  }
} finally {
  if ($tempPfx -and (Test-Path -LiteralPath $tempPfx)) {
    Remove-Item -LiteralPath $tempPfx -Force -ErrorAction SilentlyContinue
  }
}
