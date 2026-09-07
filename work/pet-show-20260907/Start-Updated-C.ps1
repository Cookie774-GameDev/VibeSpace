$ErrorActionPreference = 'Stop'
$petSource = 'C:\Users\viper\VibeSpace-UnifiedChungus-Final'
$petExe = Join-Path $petSource 'work\pet-show-20260907\VibeSpace-C-pet-dismiss.exe'
if ((git -C $petSource branch --show-current) -ne 'integration/UnifiedChungus-final') { throw 'The shared source is not on integration/UnifiedChungus-final.' }
if (Get-CimInstance Win32_Process | Where-Object ExecutablePath -eq $petExe) { Write-Output 'Updated C instance is already running.'; exit }
$env:VIBESPACE_DEV_MULTI_INSTANCE = '1'
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = '--remote-debugging-port=9237'
$env:APPDATA = Join-Path $env:USERPROFILE 'AppData\Roaming'
$env:LOCALAPPDATA = Join-Path $env:USERPROFILE 'AppData\Local'
foreach ($petVariable in @('VIBESPACE_LOCAL_INSTANCE_ROOT','WEBVIEW2_USER_DATA_FOLDER','XDG_CONFIG_HOME','XDG_DATA_HOME','XDG_CACHE_HOME')) { Remove-Item "Env:\$petVariable" -ErrorAction SilentlyContinue }
Start-Process -FilePath $petExe -WorkingDirectory $petSource -PassThru | Select-Object Id,Path
