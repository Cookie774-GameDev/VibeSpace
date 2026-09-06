$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$logDirectory = Join-Path $env:LOCALAPPDATA 'VibeSpace\ActivityLog'
New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null
$listener = Get-NetTCPConnection -LocalPort 42841 -State Listen -ErrorAction SilentlyContinue
if ($listener) {
  $existing = Get-CimInstance Win32_Process -Filter "ProcessId = $($listener[0].OwningProcess)"
  if ($existing.CommandLine -notmatch 'live-chat-log[/\\]server\.mjs') { throw 'Port 42841 belongs to another service; nothing was stopped.' }
  Write-Output ('Recorder already running. Open ' + (Join-Path $logDirectory 'Open-Activity-Log.html'))
  exit 0
}
$serverScript = Join-Path $PSScriptRoot 'server.mjs'
$launcher = Join-Path $logDirectory 'Open-Activity-Log.html'
Start-Process -FilePath (Get-Command node).Source -ArgumentList @(('"' + $serverScript + '"'), ('"' + $launcher + '"')) -WorkingDirectory $repoRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $logDirectory 'service.stdout.log') -RedirectStandardError (Join-Path $logDirectory 'service.stderr.log') | Out-Null
Write-Output ('Recorder started independently of this terminal. Open ' + $launcher)
