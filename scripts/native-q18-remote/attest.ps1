param([Parameter(Mandatory)][string]$SpecPath, [int]$ShellPid = 0, [long]$ShellBornMs = 0)
$ErrorActionPreference = 'Stop'
function Write-SmokePhase {
  param([ValidateSet('BEGIN','SPEC_READ','PROCESS_INVENTORY','PROCESS_IDENTITIES','WEBVIEW_ARGUMENTS','CDP_LISTENER','FRONTEND_LISTENER','FRONTEND_IDENTITY','ANCESTRY','LOADED_MODULES','GIT_HEAD','SHELL_IDENTITY','FINAL_OBSERVATION','COMPLETE')][string]$Phase)
  try { [Console]::Error.WriteLine('FRESH2_Q18_ATTEST_PHASE='+$Phase) } catch {}
}
try {
  Write-SmokePhase 'BEGIN'
  if (-not $IsWindows) { throw 'smoke_windows_required' }
  Write-SmokePhase 'SPEC_READ'
  $s = Get-Content -LiteralPath $SpecPath -Raw | ConvertFrom-Json
  Write-SmokePhase 'PROCESS_INVENTORY'
  $all = @(Get-CimInstance Win32_Process)
  function Get-Identity([int]$processId) {
    $row = @($all | Where-Object { $_.ProcessId -eq $processId })
    if ($row.Count -ne 1 -or -not $row[0].ExecutablePath) { throw 'smoke_process_absent' }
    [ordered]@{ pid=[int]$row[0].ProcessId; bornMs=([DateTimeOffset]$row[0].CreationDate.ToUniversalTime()).ToUnixTimeMilliseconds(); exePath=$row[0].ExecutablePath }
  }
  Write-SmokePhase 'PROCESS_IDENTITIES'
  $app = Get-Identity $s.app.pid
  $webview = Get-Identity $s.webview.pid
  $wv = @($all | Where-Object { $_.ProcessId -eq $s.webview.pid })[0]
  . (Join-Path $PSScriptRoot 'commandline.ps1')
  Write-SmokePhase 'WEBVIEW_ARGUMENTS'
  $arguments = Test-WebViewArguments $wv.CommandLine $s.webview.profile $s.cdpPort
  $profileMatches = $arguments.profileMatches
  $portMatches = $arguments.portMatches
  Write-SmokePhase 'CDP_LISTENER'
  $listeners = @(Get-NetTCPConnection -LocalPort $s.cdpPort -State Listen -ErrorAction Stop)
  if ($listeners.Count -ne 1) { throw 'smoke_ambiguous_cdp_listener' }
  Write-SmokePhase 'FRONTEND_LISTENER'
  $frontendListeners = @(Get-NetTCPConnection -LocalPort 5173 -State Listen -ErrorAction Stop)
  if ($frontendListeners.Count -ne 1 -or $frontendListeners[0].LocalAddress -ne '127.0.0.1') { throw 'smoke_frontend_listener' }
  Write-SmokePhase 'FRONTEND_IDENTITY'
  $frontend = Get-Identity $frontendListeners[0].OwningProcess
  $fp = @($all | Where-Object { $_.ProcessId -eq $frontend.pid })[0]
  $frontend['matchesRoot'] = Test-ViteArguments $fp.CommandLine $s.frontendRoot
  Write-SmokePhase 'ANCESTRY'
  $chain = [Collections.Generic.List[object]]::new()
  $cursor = [int]$s.webview.pid
  for ($n=0; $n -lt 32; $n++) {
    $p = @($all | Where-Object { $_.ProcessId -eq $cursor })
    if ($p.Count -ne 1) { break }
    $chain.Add([ordered]@{ pid=[int]$p[0].ProcessId; parentPid=[int]$p[0].ParentProcessId; bornMs=([DateTimeOffset]$p[0].CreationDate.ToUniversalTime()).ToUnixTimeMilliseconds() })
    if ($cursor -eq $s.app.pid) { break }
    $cursor = [int]$p[0].ParentProcessId
  }
  Write-SmokePhase 'LOADED_MODULES'
  $loaded = @((Get-Process -Id $s.app.pid).Modules | ForEach-Object {
    [ordered]@{ name=$_.ModuleName; path=$_.FileName; sha256=(Get-FileHash -LiteralPath $_.FileName -Algorithm SHA256).Hash.ToLowerInvariant() }
  })
  Write-SmokePhase 'GIT_HEAD'
  $head = & git -C $s.frontendRoot rev-parse HEAD
  if ($LASTEXITCODE -ne 0) { throw 'smoke_git_head_failed' }
  Write-SmokePhase 'SHELL_IDENTITY'
  $shell = $null
  if ($ShellPid -gt 0) {
    $p = @($all | Where-Object { $_.ProcessId -eq $ShellPid })
    if ($p.Count -eq 1) {
      $shell = Get-Identity $ShellPid
      $shell['parentPid'] = [int]$p[0].ParentProcessId
      $shell['sameBirth'] = $shell.bornMs -eq $ShellBornMs
    }
  }
  Write-SmokePhase 'FINAL_OBSERVATION'
  [ordered]@{ capturedAtMs=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds(); sourceSHA=$head.Trim();
    exeSHA256=(Get-FileHash -LiteralPath $app.exePath -Algorithm SHA256).Hash.ToLowerInvariant(); app=$app; webview=$webview;
    profileMatches=[bool]$profileMatches; debugPortMatches=[bool]$portMatches; processes=$chain.ToArray();
    listener=[ordered]@{ ownerPid=[int]$listeners[0].OwningProcess; port=[int]$listeners[0].LocalPort; address=$listeners[0].LocalAddress };
    loadedModules=$loaded; webviewRuntimeVersion=(Get-Item -LiteralPath $webview.exePath).VersionInfo.FileVersion;
    nativeDataExists=(Test-Path -LiteralPath $s.nativeDataPath -PathType Container); systemRoot=$env:SystemRoot; frontend=$frontend;
    shell=$shell } | ConvertTo-Json -Depth 8 -Compress
  Write-SmokePhase 'COMPLETE'
} catch {
  $code = if ($_.Exception.Message -cmatch '^smoke_[a-z0-9_]+$') { $_.Exception.Message } else { 'smoke_attestation_failed' }
  [ordered]@{ failure=$code } | ConvertTo-Json -Compress
  exit 1
}
