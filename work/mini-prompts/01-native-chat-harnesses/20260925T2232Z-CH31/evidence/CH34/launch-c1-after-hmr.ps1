$ErrorActionPreference = 'Stop'
$repoPath = 'C:\Users\viper\VibeSpace-UnifiedChungus-Final'
$appPath = Join-Path $repoPath 'app'
$vitePath = Join-Path $appPath 'node_modules\vite\bin\vite.js'
$exePath = Join-Path $appPath 'src-tauri\target\debug\jarvis.exe'
$expectedHash = '526A980B05D48DFF6F27BF7ACC4C892E452A869F90B464369584C04B5C4D9CA8'
$expectedProfile = 'C:\Users\viper\AppData\Local\ai.jarvis.desktop\EBWebView'
$outPath = Join-Path $PSScriptRoot ('native-c1-postfix-relaunch-' + [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfffZ') + '.json')
$receipt = [ordered]@{ at = [DateTime]::UtcNow.ToString('o'); branch = $null; executable = $exePath; profile = $expectedProfile; executableSha256 = $null; vitePid = $null; appPid = $null; webviewPid = $null; passed = $false; failure = $null }
try {
  $receipt.branch = git -C $repoPath branch --show-current
  if ($receipt.branch -ne 'integration/UnifiedChungus-final') { throw 'branch_changed' }
  if (Get-NetTCPConnection -LocalPort 5173,9223 -State Listen -ErrorAction SilentlyContinue) { throw 'C1_port_occupied_before_launch' }
  $matchingApp = Get-CimInstance Win32_Process -Filter "Name='jarvis.exe'" | Where-Object { $_.ExecutablePath -eq $exePath }
  if ($matchingApp) { throw 'owned_C1_already_running' }
  if (!(Test-Path -LiteralPath $vitePath) -or !(Test-Path -LiteralPath $exePath)) { throw 'expected_binary_missing' }
  $receipt.executableSha256 = (Get-FileHash -LiteralPath $exePath -Algorithm SHA256).Hash
  if ($receipt.executableSha256 -ne $expectedHash) { throw 'executable_hash_changed' }
  $vite = Start-Process -FilePath 'C:\Program Files\nodejs\node.exe' -ArgumentList @($vitePath, '--host', 'localhost', '--port', '5173', '--strictPort') -WorkingDirectory $appPath -PassThru -WindowStyle Hidden -RedirectStandardOutput (Join-Path $PSScriptRoot 'vite-postfix.stdout.log') -RedirectStandardError (Join-Path $PSScriptRoot 'vite-postfix.stderr.log')
  $receipt.vitePid = $vite.Id
  $until = [DateTime]::UtcNow.AddSeconds(45)
  do {
    Start-Sleep -Milliseconds 500
    $viteListener = Get-NetTCPConnection -LocalPort 5173 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($viteListener) { break }
  } while ([DateTime]::UtcNow -lt $until)
  if (!$viteListener -or $viteListener.OwningProcess -ne $vite.Id) { throw 'vite_listener_missing_or_wrong_owner' }
  $env:VIBESPACE_DEV_MULTI_INSTANCE = '1'
  $env:WEBVIEW2_USER_DATA_FOLDER = 'C:\Users\viper\AppData\Local\ai.jarvis.desktop'
  $nativeProcess = Start-Process -FilePath $exePath -WorkingDirectory (Join-Path $appPath 'src-tauri') -PassThru -WindowStyle Hidden
  $receipt.appPid = $nativeProcess.Id
  $until = [DateTime]::UtcNow.AddSeconds(45)
  do {
    Start-Sleep -Milliseconds 500
    $listener = Get-NetTCPConnection -LocalPort 9223 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($listener) { break }
  } while ([DateTime]::UtcNow -lt $until)
  if (!$listener) { throw 'C1_CDP_listener_missing' }
  $web = Get-CimInstance Win32_Process -Filter "ProcessId=$($listener.OwningProcess)"
  $app = Get-CimInstance Win32_Process -Filter "ProcessId=$($nativeProcess.Id)"
  if (!$web -or !$app -or $web.ParentProcessId -ne $nativeProcess.Id -or $app.ExecutablePath -ne $exePath -or $web.CommandLine -notlike "*$expectedProfile*") { throw 'C1_process_profile_parent_mismatch' }
  $receipt.webviewPid = $web.ProcessId
  $receipt.passed = $true
} catch { $receipt.failure = $_.Exception.Message; $global:LASTEXITCODE = 1 }
finally { $receipt | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $outPath; Write-Output ($receipt | ConvertTo-Json -Compress -Depth 4) }
if (!$receipt.passed) { exit 1 }
