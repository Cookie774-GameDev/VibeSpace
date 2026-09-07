$ErrorActionPreference = 'Stop'
$petSource = 'C:\Users\viper\VibeSpace-UnifiedChungus-Final'
$petExe = 'D:\CodexBuilds\VibeSpace-UnifiedChungus-Final-codex\debug\VibeSpace-pet-dismiss-20260907.exe'
$petProfile = 'D:\VibeSpace-Instance-2-current-941e2764-profile'
if ((git -C $petSource branch --show-current) -ne 'integration/UnifiedChungus-final') { throw 'The shared source is not on integration/UnifiedChungus-final.' }
if (Get-CimInstance Win32_Process | Where-Object ExecutablePath -eq $petExe) { Write-Output 'Updated D instance is already running.'; exit }
if ((Get-FileHash $petExe).Hash -ne (Get-FileHash (Join-Path $petSource 'work\pet-show-20260907\VibeSpace-C-pet-dismiss.exe')).Hash) { throw 'C and D builds differ.' }
$env:VIBESPACE_DEV_MULTI_INSTANCE = '1'
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = '--remote-debugging-port=9238'
$env:VIBESPACE_LOCAL_INSTANCE_ROOT = $petProfile
$env:APPDATA = Join-Path $petProfile 'Roaming'
$env:LOCALAPPDATA = Join-Path $petProfile 'Local'
$env:WEBVIEW2_USER_DATA_FOLDER = Join-Path $petProfile 'Local\ai.jarvis.desktop\EBWebView'
$env:XDG_CONFIG_HOME = Join-Path $petProfile 'config'
$env:XDG_DATA_HOME = Join-Path $petProfile 'data'
$env:XDG_CACHE_HOME = Join-Path $petProfile 'cache'
$env:TEMP = Join-Path $petProfile 'Temp'
$env:TMP = $env:TEMP
Start-Process -FilePath $petExe -WorkingDirectory $petSource -PassThru | Select-Object Id,Path
