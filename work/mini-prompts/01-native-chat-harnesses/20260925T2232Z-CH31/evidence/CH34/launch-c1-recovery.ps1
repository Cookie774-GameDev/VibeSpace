$ErrorActionPreference = 'Stop'
$repoPath = 'C:\Users\viper\VibeSpace-UnifiedChungus-Final'
$exePath = Join-Path $repoPath 'app\src-tauri\target\debug\jarvis.exe'
$expectedHash = '526A980B05D48DFF6F27BF7ACC4C892E452A869F90B464369584C04B5C4D9CA8'
$expectedProfile = 'C:\Users\viper\AppData\Local\ai.jarvis.desktop\EBWebView'
$outPath = Join-Path $PSScriptRoot ('native-c1-recovery-relaunch-' + [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfffZ') + '.json')
$receipt = [ordered]@{ at = [DateTime]::UtcNow.ToString('o'); executable = $exePath; profile = $expectedProfile; pid = $null; webviewPid = $null; executableSha256 = $null; passed = $false; failure = $null }
try {
  if ((git -C $repoPath branch --show-current) -ne 'integration/UnifiedChungus-final') { throw 'branch_changed' }
  if (Get-CimInstance Win32_Process -Filter 'ProcessId=36580') { throw 'old_C1_still_alive' }
  if (Get-NetTCPConnection -LocalPort 9223 -State Listen -ErrorAction SilentlyContinue) { throw 'C1_CDP_port_owned_before_launch' }
  if (!(Test-Path -LiteralPath $exePath)) { throw 'expected_executable_missing' }
  $receipt.executableSha256 = (Get-FileHash -LiteralPath $exePath -Algorithm SHA256).Hash
  if ($receipt.executableSha256 -ne $expectedHash) { throw 'executable_hash_changed' }
  $env:VIBESPACE_DEV_MULTI_INSTANCE = '1'
  $env:WEBVIEW2_USER_DATA_FOLDER = 'C:\Users\viper\AppData\Local\ai.jarvis.desktop'
  $nativeProcess = Start-Process -FilePath $exePath -WorkingDirectory (Join-Path $repoPath 'app\src-tauri') -PassThru -WindowStyle Hidden
  $receipt.pid = $nativeProcess.Id
  $until = [DateTime]::UtcNow.AddSeconds(45)
  do {
    Start-Sleep -Milliseconds 750
    $listener = Get-NetTCPConnection -LocalPort 9223 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($listener) { break }
  } while ([DateTime]::UtcNow -lt $until)
  if (!$listener) { throw 'C1_CDP_listener_missing' }
  $web = Get-CimInstance Win32_Process -Filter "ProcessId=$($listener.OwningProcess)"
  $app = Get-CimInstance Win32_Process -Filter "ProcessId=$($nativeProcess.Id)"
  if (!$web -or !$app -or $web.ParentProcessId -ne $nativeProcess.Id -or $app.ExecutablePath -ne $exePath -or $web.CommandLine -notlike "*$expectedProfile*") {
    throw 'C1_process_profile_parent_mismatch'
  }
  $receipt.webviewPid = $web.ProcessId
  $receipt.passed = $true
} catch { $receipt.failure = $_.Exception.Message; $global:LASTEXITCODE = 1 }
finally { $receipt | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $outPath; Write-Output ($receipt | ConvertTo-Json -Compress -Depth 4) }
if (!$receipt.passed) { exit 1 }
