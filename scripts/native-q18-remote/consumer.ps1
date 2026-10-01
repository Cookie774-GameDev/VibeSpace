# PROPOSED / UNRUN. A future reviewed Windows-runner grant is mandatory.
param([Parameter(Mandatory)][string]$TaskId,
 [Parameter(Mandatory)][string]$TransferGrantId,
 [Parameter(Mandatory)][string]$DependencyGrantId,
 [Parameter(Mandatory)][string]$NativeSetupGrantId,
 [Parameter(Mandatory)][string]$HelperManifestSHA256,
 [Parameter(Mandatory)][ValidateRange(0,1048576)][double]$ReservedGrowthMiB,
 [Parameter(Mandatory)][ValidateRange(0,1048576)][double]$ReservedCommitMiB,
 [switch]$Schedule,
 [switch]$StaticOnly)
$ErrorActionPreference='Stop'
$source='8579072d21e6a994b3c95f44997922997679324a'
$exeSHA='23974fdf89067d4f2399b0f367c54ce64e9350f82e4cdca38b11652aee61956e'
if (-not $IsWindows -or $env:GITHUB_ACTIONS -cne 'true') { throw 'consumer_future_windows_runner_only' }
if ($TaskId -cnotmatch '^[A-Z0-9_]{8,64}$' -or $HelperManifestSHA256 -cnotmatch '^[a-f0-9]{64}$') { throw 'consumer_invalid_identity' }
foreach ($grant in @($TransferGrantId,$DependencyGrantId,$NativeSetupGrantId)) {
 if ($grant -cnotmatch '^ROOT[A-Za-z0-9_-]{4,128}$') { throw 'consumer_explicit_phase_grant_required' }
}
$workspace=[IO.Path]::GetFullPath($env:GITHUB_WORKSPACE)
$runnerTemp=[IO.Path]::GetFullPath($env:RUNNER_TEMP)
function Assert-NoLinks([string]$target) {
 $cursor=Get-Item -LiteralPath $target -Force
 while ($cursor) {
  if ($cursor.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'consumer_path_link' }
  $cursor=$cursor.Parent
 }
}
Assert-NoLinks $workspace
Assert-NoLinks $runnerTemp
Assert-NoLinks $PSScriptRoot
$manifestPath=Join-Path $PSScriptRoot 'helper-manifest.json'
if ((Get-FileHash -LiteralPath $manifestPath -Algorithm SHA256).Hash.ToLowerInvariant() -cne $HelperManifestSHA256) { throw 'consumer_helper_manifest_identity' }
$manifest=Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
if ($manifest.schema -ne 1 -or $manifest.productSource -cne $source -or $manifest.files.Count -gt 64) { throw 'consumer_helper_schema' }
$seen=[Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
foreach ($file in $manifest.files) {
 if ($file.path -cnotmatch '^[A-Za-z0-9_.-]+$' -or -not $seen.Add($file.path)) { throw 'consumer_helper_name' }
 $p=Join-Path $PSScriptRoot $file.path
 Assert-NoLinks $p
 if ((Get-Item -LiteralPath $p).Length -ne $file.bytes -or (Get-FileHash -LiteralPath $p -Algorithm SHA256).Hash.ToLowerInvariant() -cne $file.sha256) { throw 'consumer_helper_file_hash' }
}
foreach ($required in @('consumer.ps1','driver.mjs','contract.mjs','attest.ps1','commandline.ps1','transfer.py','artifact_dll_checks.py','run-native-supervised.ps1','dependency-launch.ps1','startup-predicate.ps1')) {
 if (-not $seen.Contains($required)) { throw 'consumer_helper_missing' }
}
$head=& git -C $workspace rev-parse HEAD
if ($LASTEXITCODE -ne 0 -or $head.Trim() -cne $source) { throw 'consumer_product_source' }
$runRoot=Join-Path $runnerTemp $TaskId
if (Test-Path -LiteralPath $runRoot) { throw 'consumer_existing_task' }
New-Item -ItemType Directory -Path $runRoot | Out-Null
$staging=Join-Path $runRoot 'staging'
New-Item -ItemType Directory -Path $staging | Out-Null
$authority=$env:GITHUB_TOKEN
if ([string]::IsNullOrWhiteSpace($authority)) { throw 'consumer_ephemeral_artifact_authority_missing' }
Remove-Item Env:GITHUB_TOKEN -ErrorAction SilentlyContinue
$node=(Get-Command node).Source
$python=(Get-Command python).Source
$pwsh=(Get-Command pwsh).Source
$git=(Get-Command git).Source
$npm=(Get-Command npm.cmd).Source
$npmCLI=Join-Path (Split-Path $npm) 'node_modules/npm/bin/npm-cli.js'
if(-not (Test-Path -LiteralPath $npmCLI -PathType Leaf)){throw 'consumer_npm_cli_missing'}
Assert-NoLinks $npmCLI
$phaseIndex=0
$owned=[Collections.Generic.List[object]]::new()
$tracked=[Collections.Generic.Dictionary[string,object]]::new()
. (Join-Path $PSScriptRoot 'lifecycle.ps1')
. (Join-Path $PSScriptRoot 'desktop-guard.ps1')
. (Join-Path $PSScriptRoot 'dependency-launch.ps1')
. (Join-Path $PSScriptRoot 'startup-predicate.ps1')
$result=[ordered]@{ taskId=$TaskId; sourceSHA=$source; exeSHA256=$exeSHA; helperManifestSHA256=$HelperManifestSHA256;
 startedUTC=[DateTime]::UtcNow.ToString('o'); runtimeAcceptance='UNRUN'; phases=@(); cleanup=@(); failure=$null }
function Save-Json([string]$file,[object]$value) {
 $bytes=[Text.Encoding]::UTF8.GetBytes(($value | ConvertTo-Json -Depth 14))
 $stream=[IO.File]::Open($file,[IO.FileMode]::CreateNew)
 try {$stream.Write($bytes,0,$bytes.Length)} finally {$stream.Dispose()}
}
function Assert-Capacity([int]$ws,[int]$private,[long]$disk,[string]$grant) {
 $memory=Get-CimInstance Win32_PerfFormattedData_PerfOS_Memory
 $ram=[double]$memory.AvailableMBytes
 $commit=([double]$memory.CommitLimit-[double]$memory.CommittedBytes)/1MB
 $requiredRAM=[math]::Ceiling($ws*1.25+1024+$ReservedGrowthMiB)
 $requiredCommit=[math]::Ceiling($private*1.25+1024+$ReservedCommitMiB)
 $volumes=@($workspace,$runnerTemp,[Environment]::GetFolderPath('ApplicationData') | ForEach-Object {
  $drive=[IO.DriveInfo]::new([IO.Path]::GetPathRoot($_))
  [ordered]@{root=$drive.RootDirectory.FullName;freeBytes=$drive.AvailableFreeSpace;requiredBytes=$disk}
 })
 $pass=$ram -ge $requiredRAM -and $commit -ge $requiredCommit -and @($volumes | Where-Object {$_.freeBytes -lt $_.requiredBytes}).Count -eq 0
 $record=[ordered]@{grantId=$grant; observedUTC=[DateTime]::UtcNow.ToString('o'); admitted=$pass;
  availableRAMMiB=$ram;availableCommitMiB=$commit;requiredRAMMiB=$requiredRAM;requiredCommitMiB=$requiredCommit;volumes=$volumes;
  estimateWSMiB=$ws;estimatePrivateMiB=$private;scope='Whole phase planning estimates plus reserve; not measured peaks or enforced aggregate limits'}
 Save-Json (Join-Path $runRoot ("admission-$script:phaseIndex.json")) $record
 $script:phaseIndex++
 if (-not $pass) { throw 'consumer_fresh_phase_admission_failed' }
}
function Child-Info([string]$command,[string[]]$argv,[string]$cwd,[hashtable]$extra=@{}) {
 $info=[Diagnostics.ProcessStartInfo]::new($command)
 $info.WorkingDirectory=$cwd
 $info.UseShellExecute=$false
 $info.CreateNoWindow=$true
 $info.WindowStyle=[Diagnostics.ProcessWindowStyle]::Hidden
 $info.RedirectStandardOutput=$true
 $info.RedirectStandardError=$true
 # Explicit minimal environment; product/PTYs never receive the artifact token.
 $info.Environment.Clear()
 foreach ($key in @('SystemRoot','WINDIR','USERPROFILE','APPDATA','LOCALAPPDATA','TEMP','TMP','ProgramFiles','ProgramFiles(x86)','ComSpec','PATHEXT','HOMEDRIVE','HOMEPATH','PROCESSOR_ARCHITECTURE','NUMBER_OF_PROCESSORS','GITHUB_ACTIONS','GITHUB_WORKSPACE','RUNNER_TEMP','RUNNER_OS','ImageOS','ImageVersion')) {
  $value=[Environment]::GetEnvironmentVariable($key)
  if ($null -ne $value) {$info.Environment[$key]=$value}
 }
 $info.Environment['Path']=@((Split-Path $node),(Split-Path $python),(Split-Path $pwsh),(Split-Path $git),"$env:SystemRoot\System32","$env:SystemRoot","$env:SystemRoot\System32\WindowsPowerShell\v1.0") -join ';'
 $info.Environment['VITE_SIK_SMOKE']='false'
 foreach ($key in $extra.Keys) {$info.Environment[$key]=[string]$extra[$key]}
 foreach ($a in $argv) {$info.ArgumentList.Add($a)}
 return $info
}
function Start-Owned([string]$name,[string]$command,[string[]]$argv,[string]$cwd,[hashtable]$extra=@{}) {
 $p=[Diagnostics.Process]::new()
 $p.StartInfo=Child-Info $command $argv $cwd $extra
 $p.StartInfo.WindowStyle=Get-StartupWindowStyle $name
 if (-not $p.Start()) {throw 'consumer_owned_child_start_failed'}
 $birth=$p.StartTime.ToUniversalTime()
 $o=[ordered]@{name=$name;process=$p;pid=$p.Id;bornMs=([DateTimeOffset]$birth).ToUnixTimeMilliseconds();bornUTC=$birth.ToString('o');
  stdout=$p.StandardOutput.ReadToEndAsync();stderr=$p.StandardError.ReadToEndAsync()}
 $script:owned.Add($o)
 Save-Json (Join-Path $runRoot ("start-$name.json")) ([ordered]@{name=$name;pid=$o.pid;bornMs=$o.bornMs;bornUTC=$o.bornUTC;command=$command;argv=$argv;workingDirectory=$cwd})
 return $o
}
function Stop-Exact([int]$processId,[long]$bornMs) {
 $p=Get-Process -Id $processId -ErrorAction SilentlyContinue
 if (-not $p) {return 'ABSENT'}
 [void]$p.Handle
 $actualBirth=([DateTimeOffset]$p.StartTime.ToUniversalTime()).ToUnixTimeMilliseconds()
 if (-not (Test-OwnedBirth $p.Id $actualBirth $processId $bornMs)) {return 'PID_REUSED_UNTOUCHED'}
 $p.Kill()
 [void]$p.WaitForExit(5000)
 if (-not $p.HasExited) {throw 'consumer_owned_process_survived'}
 return 'OWNED_TERMINATED'
}
function Stop-OwnedTree([object]$root) {
 $all=@(Get-CimInstance Win32_Process)
 $inputRows=@($all|ForEach-Object{[pscustomobject]@{pid=[int]$_.ProcessId;parentPid=[int]$_.ParentProcessId;bornMs=([DateTimeOffset]$_.CreationDate.ToUniversalTime()).ToUnixTimeMilliseconds()}})
 $rows=@(Get-OwnedDescendantIdentities $inputRows $root.pid $root.bornMs)
 foreach ($row in @($rows | Sort-Object depth -Descending)) {
  $status=Stop-Exact $row.pid $row.bornMs
  $script:result.cleanup+=@([ordered]@{pid=$row.pid;bornMs=$row.bornMs;status=$status})
 }
}
function Capture-Owned {
 $all=@(Get-CimInstance Win32_Process|ForEach-Object{[pscustomobject]@{pid=[int]$_.ProcessId;parentPid=[int]$_.ParentProcessId;bornMs=([DateTimeOffset]$_.CreationDate.ToUniversalTime()).ToUnixTimeMilliseconds()}})
 $roots=@($script:owned.ToArray())+@($script:webviewOwned)
 foreach($o in @($roots|Where-Object{$null -ne $_})) {
  foreach($row in @(Get-OwnedDescendantIdentities $all $o.pid $o.bornMs)) {
   $key=[string]$row.pid+':'+[string]$row.bornMs
   if(-not $script:tracked.ContainsKey($key)){
    if($script:tracked.Count -ge 4096){throw 'consumer_tracked_identity_budget'}
    $script:tracked.Add($key,$row)
    Add-Content -LiteralPath (Join-Path $runRoot 'owned-identities.jsonl') -Value ($row|ConvertTo-Json -Compress)
   }
  }
 }
}
function Run-Phase([string]$name,[string]$command,[string[]]$argv,[string]$cwd,[int]$seconds,[hashtable]$extra=@{}) {
 $o=Start-Owned $name $command $argv $cwd $extra
 $elapsed=[Diagnostics.Stopwatch]::StartNew()
 $done=$false
 while($elapsed.ElapsedMilliseconds -lt $seconds*1000) {
  Capture-Owned
  $left=$seconds*1000-$elapsed.ElapsedMilliseconds
  if($left -le 0){break}
  if($o.process.WaitForExit([int][math]::Min(1000,$left))){$done=$true;break}
 }
 if (-not $done) {Stop-OwnedTree $o}
 $code=if($o.process.HasExited){$o.process.ExitCode}else{$null}
 $log=if($o.process.HasExited){$o.stdout.GetAwaiter().GetResult()+$o.stderr.GetAwaiter().GetResult()}else{''}
 if($name -ceq 'npm-ci'){
  Save-Json (Join-Path $runRoot 'npm-diagnostic.json') (Get-NpmDiagnostic $log $(if($null -eq $code){-1}else{$code}) (-not $done))
 }
 # Only these reviewed helpers produce sanitized stdout. npm diagnostics are kept private.
 if ($log.Length -gt 1048576) {throw 'consumer_child_log_budget'}
 [IO.File]::WriteAllText((Join-Path $runRoot ("$name.log")),$log)
 $terminal=[ordered]@{name=$name;pid=$o.pid;bornMs=$o.bornMs;finishedUTC=[DateTime]::UtcNow.ToString('o');timedOut=(-not $done);exitCode=$code}
 Save-Json (Join-Path $runRoot ("terminal-$name.json")) $terminal
 $script:result.phases+=@($terminal)
 if (-not $done -or $code -ne 0) {throw 'consumer_child_phase_failed'}
}
$app=$null
$vite=$null
$webviewOwned=$null
$startupDiagnostic=$null
try {
 $image=[ordered]@{ImageOS=$env:ImageOS;ImageVersion=$env:ImageVersion;runnerOS=$env:RUNNER_OS;sessionId=(Get-Process -Id $PID).SessionId;cpuCount=[Environment]::ProcessorCount}
 Save-Json (Join-Path $runRoot 'runner-image.json') $image
 foreach ($operation in @(@('download','build'),@('download','evidence'),@('extract','build'),@('extract','evidence'),@('inspect',''))) {
  Assert-Capacity 512 768 4752036225 $TransferGrantId
  $argv=@('-B',(Join-Path $PSScriptRoot 'transfer.py'),$operation[0],'--staging',$staging,'--grant-id',$TransferGrantId)
  if ($operation[1]) {$argv+=@('--kind',$operation[1])}
  $timeout=if($operation[0] -eq 'download'){600}else{120}
  Run-Phase ($operation[0]+'-'+$(if($operation[1]){$operation[1]}else{'closure'})) $python $argv $workspace $timeout @{GITHUB_TOKEN=$authority}
 }
 $authority=$null
 $result.staticArtifactClosure='PASS'
 if($StaticOnly){$result.nativeBlocker='NONINTERACTIVE_OR_UNPROVEN_DESKTOP';return}
 $desktop=Get-RemoteDesktopAdmission
 Save-Json (Join-Path $runRoot 'desktop-before-setup.json') $desktop
 if(-not $desktop.interactive){throw 'consumer_desktop_not_interactive'}
 $artifactRoot=Join-Path $staging 'build'
 $inputPath=Join-Path $artifactRoot 'input-manifest.json'
 $input=Get-Content -LiteralPath $inputPath -Raw | ConvertFrom-Json
 foreach ($item in $input.files | Where-Object {$_.path -in @('package.json','package-lock.json') -or ($_.path.StartsWith('app/') -and -not $_.path.StartsWith('app/src-tauri/'))}) {
  $candidate=[IO.Path]::GetFullPath((Join-Path $workspace $item.path))
  if (-not $candidate.StartsWith($workspace+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)) {throw 'consumer_frontend_escape'}
  Assert-NoLinks $candidate
  if ((Get-FileHash -LiteralPath $candidate -Algorithm SHA256).Hash.ToLowerInvariant() -cne $item.sha256) {throw 'consumer_frozen_frontend_drift'}
 }
 foreach ($base in @($workspace,(Join-Path $workspace 'app'))) {
  foreach ($envFile in @('.env','.env.local','.env.development','.env.development.local')) {
   if (Test-Path -LiteralPath (Join-Path $base $envFile)) {throw 'consumer_env_file_forbidden'}
  }
 }
 # No install scripts, browser downloads or model setup. Separate approved planning estimate.
 Assert-Capacity 1536 2048 8589934592 $DependencyGrantId
 $npmPlan=Get-NpmLaunchPlan $node $npmCLI
 Save-Json (Join-Path $runRoot 'npm-launch-identity.json') ([ordered]@{launchMode='DIRECT_NODE_NPM_CLI';node=$node;npmCLI=$npmCLI;cliSHA256=(Get-FileHash -LiteralPath $npmCLI).Hash.ToLowerInvariant();arguments=@('ci','--ignore-scripts','--no-audit','--no-fund')})
 Run-Phase 'npm-ci' $npmPlan.command $npmPlan.argv $workspace 600
 $config=Get-Content -LiteralPath (Join-Path $workspace 'app/src-tauri/tauri.conf.json') -Raw | ConvertFrom-Json
 if ($config.identifier -cnotmatch '^[A-Za-z0-9_.-]+$') {throw 'consumer_native_identifier'}
 $nativeData=Join-Path ([Environment]::GetFolderPath('ApplicationData')) $config.identifier
 $nativeLocalData=Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) $config.identifier
 $profile=Join-Path $runRoot 'webview'
 if ((Test-Path -LiteralPath $nativeData) -or (Test-Path -LiteralPath $nativeLocalData) -or (Test-Path -LiteralPath $profile)) {throw 'consumer_clean_native_profile_required'}
 $clean=[ordered]@{capturedAtMs=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds();nativeDataAbsentBeforeStart=$true;webviewProfileAbsentBeforeStart=$true;ordinaryBlankWorkbenchPreparation=$false}
 Save-Json (Join-Path $runRoot 'clean-before-start.json') ([ordered]@{receipt=$clean;nativeDataPath=$nativeData;nativeLocalDataPath=$nativeLocalData;profile=$profile})
 $cdpPort=9228
 $runtimePaths=@()
 foreach($base in @([Environment]::GetEnvironmentVariable('ProgramFiles(x86)'),$env:ProgramFiles)) {
  $directory=Join-Path $base 'Microsoft/EdgeWebView/Application'
  if(Test-Path -LiteralPath $directory){
   foreach($version in Get-ChildItem -LiteralPath $directory -Directory){
    $candidate=Join-Path $version.FullName 'msedgewebview2.exe'
    if(Test-Path -LiteralPath $candidate){$runtimePaths+=@([ordered]@{path=$candidate;version=(Get-Item -LiteralPath $candidate).VersionInfo.FileVersion})}
   }
  }
 }
 if(-not $runtimePaths.Count){throw 'consumer_existing_webview_runtime_required'}
 Save-Json (Join-Path $runRoot 'webview-runtime-inventory.json') $runtimePaths
 if (@(Get-NetTCPConnection -LocalPort 5173,$cdpPort -State Listen -ErrorAction SilentlyContinue).Count) {throw 'consumer_competing_loopback_listener'}
 # Includes BOTH default Coding PTYs: extra512WS768private over one-PTY proposal.
 Assert-Capacity 3584 4864 8589934592 $NativeSetupGrantId
 $vite=Start-Owned 'vite' $node @((Join-Path $workspace 'node_modules/vite/bin/vite.js'),(Join-Path $workspace 'app'),'--host','127.0.0.1','--port','5173','--strictPort') $workspace
 $binary=Join-Path $artifactRoot 'binary/jarvis.exe'
 if ((Get-FileHash -LiteralPath $binary -Algorithm SHA256).Hash.ToLowerInvariant() -cne $exeSHA) {throw 'consumer_staged_exe_changed'}
 $desktop=Get-RemoteDesktopAdmission
 Save-Json (Join-Path $runRoot 'desktop-before-native.json') $desktop
 if(-not $desktop.interactive){throw 'consumer_desktop_not_interactive'}
 $app=Start-Owned 'jarvis' $binary @() (Split-Path $binary) @{
  WEBVIEW2_USER_DATA_FOLDER=$profile;WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-address=127.0.0.1 --remote-debugging-port=$cdpPort"
 }
 $startup=[Diagnostics.Stopwatch]::StartNew()
 $startupDiagnostic=[ordered]@{first=$null;last=$null;lastFingerprint=$null;changedStates=0;
  changes=[Collections.Generic.List[object]]::new();iterations=0;appLaunchRequestedStyle='Normal';startupBudgetMs=90000;nativeAcceptance='UNRUN'}
 $viteHTTPResponded=$null;$lastViteHTTPProbe=-5000
 $webview=$null
 $ready=$false
 while ($startup.ElapsedMilliseconds -lt 90000) {
  Capture-Owned
  $startupDiagnostic.iterations++
  $snapshot=[ordered]@{elapsedMs=[long]$startup.ElapsedMilliseconds;appAlive=(-not $app.process.HasExited);viteAlive=(-not $vite.process.HasExited)}
  $viteListeners=@(Get-NetTCPConnection -LocalPort 5173 -State Listen -ErrorAction SilentlyContinue|Where-Object{$_.LocalAddress -in @('127.0.0.1','::1')})
  $snapshot.viteListenerOwnerMatches=(@($viteListeners|Where-Object{$_.OwningProcess -eq $vite.pid}).Count -eq 1)
  if($snapshot.viteListenerOwnerMatches -and $startup.ElapsedMilliseconds-$lastViteHTTPProbe -ge 5000){
   $lastViteHTTPProbe=$startup.ElapsedMilliseconds
   try{$head=Invoke-WebRequest -Method Head -Uri 'http://127.0.0.1:5173/' -TimeoutSec 2;$viteHTTPResponded=($head.StatusCode -eq 200)}
   catch{$viteHTTPResponded=$false}
  }
  $snapshot.viteHTTPResponded=$viteHTTPResponded
  if ($app.process.HasExited -or $vite.process.HasExited) {Add-StartupSnapshot $startupDiagnostic $snapshot;throw 'consumer_owned_startup_child_exited'}
  $webview=$null
  $listeners=@(Get-NetTCPConnection -LocalPort $cdpPort -State Listen -ErrorAction SilentlyContinue | Where-Object {$_.LocalAddress -in @('127.0.0.1','::1')})
  $snapshot.cdpListenerCount=[int]$listeners.Count
  if ($listeners.Count -eq 1) {
   $all=@(Get-CimInstance Win32_Process)
   $cursor=@($all | Where-Object {$_.ProcessId -eq $listeners[0].OwningProcess})[0]
   $candidate=$cursor
   $snapshot.ancestryMatches=$false
   for($depth=0;$depth -lt 32 -and $cursor;$depth++) {
    if ($cursor.ParentProcessId -eq $app.pid) {$webview=$candidate;$snapshot.ancestryMatches=$true;break}
    $cursor=@($all | Where-Object {$_.ProcessId -eq $cursor.ParentProcessId})[0]
   }
   $snapshot.webviewNameMatches=($null -ne $webview -and $webview.Name -ieq 'msedgewebview2.exe')
   if($webview){$snapshot.runtimePathMatches=(@($runtimePaths|Where-Object{$_.path -ieq $webview.ExecutablePath}).Count -eq 1)}
   if ($webview -and $webview.Name -ieq 'msedgewebview2.exe') {
    $queryStage='REST'
    try {
     $response=Invoke-RestMethod -Uri "http://127.0.0.1:$cdpPort/json/list" -TimeoutSec 2
     $snapshot.cdpQuerySucceeded=$true
     $queryStage='TARGETS'
     $targetFacts=Get-StartupTargetFacts $response
     $snapshot.targetCount=[int]$targetFacts.targetCount;$snapshot.mainTargetCount=[int]$targetFacts.mainTargetCount
     $snapshot.malformedTargetRows=[int]$targetFacts.malformedRows;$snapshot.oneOfficialURL=$targetFacts.oneOfficialURL
     $queryStage='WINDOW'
     $app.process.Refresh()
     $snapshot.sessionMatches=($app.process.SessionId -eq (Get-Process -Id $PID).SessionId)
     $snapshot.hasWindowHandle=($app.process.MainWindowHandle -ne [IntPtr]::Zero)
     $snapshot.windowVisible=[Q18DesktopProbe]::IsWindowVisible($app.process.MainWindowHandle)
     Add-StartupSnapshot $startupDiagnostic $snapshot
     if ($targetFacts.oneOfficialURL -and $snapshot.sessionMatches -and $snapshot.hasWindowHandle -and $snapshot.windowVisible) {$ready=$true;break}
    } catch {
     if($queryStage -ceq 'REST'){$snapshot.cdpQuerySucceeded=$false}
     if($queryStage -ceq 'TARGETS'){$snapshot.targetProcessingFailed=$true}
     if($queryStage -ceq 'WINDOW'){$snapshot.windowProbeFailed=$true}
     $webview=$null
    }
   }
  }
  Add-StartupSnapshot $startupDiagnostic $snapshot
  Start-Sleep -Milliseconds 100
 }
 if (-not $ready -or -not $webview -or @($runtimePaths|Where-Object{$_.path -ieq $webview.ExecutablePath}).Count -ne 1) {throw 'consumer_official_webview_startup_deadline'}
 Save-Json (Join-Path $runRoot 'official-window.json') ([ordered]@{appPID=$app.pid;bornMs=$app.bornMs;sessionId=$app.process.SessionId;mainWindowHandle=$app.process.MainWindowHandle.ToInt64();visible=[Q18DesktopProbe]::IsWindowVisible($app.process.MainWindowHandle);desktop=$desktop})
 $webviewBorn=([DateTimeOffset]$webview.CreationDate.ToUniversalTime()).ToUnixTimeMilliseconds()
 $webviewOwned=[ordered]@{pid=[int]$webview.ProcessId;bornMs=$webviewBorn}
 $now=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
 $spec=[ordered]@{schema=1;taskId=$TaskId;grantId=$NativeSetupGrantId;issuedAtMs=$now;expiresAtMs=$now+900000;
  sourceSHA=$source;exeSHA256=$exeSHA;workspace=$workspace;runnerTemp=$runnerTemp;artifactRoot=$artifactRoot;frontendRoot=$workspace;
  inputManifestSHA256=(Get-FileHash -LiteralPath $inputPath -Algorithm SHA256).Hash.ToLowerInvariant();
  app=[ordered]@{pid=$app.pid;bornMs=$app.bornMs;exePath=$binary};
  webview=[ordered]@{pid=[int]$webview.ProcessId;bornMs=$webviewBorn;exePath=$webview.ExecutablePath;profile=$profile};
  cdpPort=$cdpPort;mainURL='http://localhost:5173/';windowLabel='main';nativeDataPath=$nativeData;cleanProfileReceipt=$clean;
  phaseMs=60000;totalMs=900000;schedule=[bool]$Schedule}
 $specPath=Join-Path $runRoot 'runtime-spec.json'
 Save-Json $specPath $spec
 Assert-Capacity 3584 4864 8589934592 $NativeSetupGrantId
 Run-Phase 'native-supervised' $pwsh @('-NoProfile','-NonInteractive','-File',(Join-Path $PSScriptRoot 'run-native-supervised.ps1'),'-SpecPath',$specPath,'-RootGrantId',$NativeSetupGrantId,'-ReservedGrowthMiB',[string]$ReservedGrowthMiB,'-ReservedCommitMiB',[string]$ReservedCommitMiB) $workspace 910
 $receipt=Get-Content -LiteralPath (Join-Path $runRoot 'evidence/receipt.json') -Raw | ConvertFrom-Json
 if ($receipt.runtimeStatus -cne 'PASS' -or -not $receipt.cleanup.sessionAbsent -or -not $receipt.cleanup.originalProcessAbsent -or ($Schedule -and -not $receipt.cleanup.eventAbsent)) {throw 'consumer_genuine_receipt_required'}
 $result.runtimeAcceptance='REMOTE_NATIVE_LOCAL_OFFLINE_SCENARIOS_PASS'
} catch {
 $message=$_.Exception.Message
 $result.failure=if($message -cmatch '^(consumer|smoke)_[a-z0-9_]+$'){$message}else{'consumer_unexpected_failure'}
} finally {
 $authority=$null
 if($startupDiagnostic){
  $export=[ordered]@{first=$startupDiagnostic.first;last=$startupDiagnostic.last;changedStates=$startupDiagnostic.changedStates;
   changes=$startupDiagnostic.changes.ToArray();iterations=$startupDiagnostic.iterations;appLaunchRequestedStyle=$startupDiagnostic.appLaunchRequestedStyle;
   startupBudgetMs=90000;nativeAcceptance='UNRUN';scope='Typed predicate booleans/counts only; no URL/title/commandline/log/exception/credential'};
  try{Save-Json (Join-Path $runRoot 'startup-diagnostic.json') $export}
  catch{$result.startupDiagnosticWriteFailed=$true;if(-not $result.failure){$result.failure='consumer_startup_diagnostic_write_failed'}}
 }
 # Stop tracked WebView independently even if jarvis exited and children became orphaned.
 foreach ($o in @($webviewOwned,$app,$vite) | Where-Object {$null -ne $_}) {
  try {Stop-OwnedTree $o} catch {$result.cleanup+=@([ordered]@{pid=$o.pid;bornMs=$o.bornMs;status='CLEANUP_FAILED'})}
 }
 foreach ($o in $owned) {
  try {if(-not $o.process.HasExited){Stop-OwnedTree $o}} catch {$result.cleanup+=@([ordered]@{pid=$o.pid;bornMs=$o.bornMs;status='CLEANUP_FAILED'})}
 }
 foreach($row in $tracked.Values) {
  try {$status=Stop-Exact $row.pid $row.bornMs;$result.cleanup+=@([ordered]@{pid=$row.pid;bornMs=$row.bornMs;status=$status})}
  catch {$result.cleanup+=@([ordered]@{pid=$row.pid;bornMs=$row.bornMs;status='CLEANUP_FAILED'})}
 }
 $result.finishedUTC=[DateTime]::UtcNow.ToString('o')
 $result.physicalCAcceptance='UNRUN'
 $result.providerCanonicalApprovalAcceptance='UNRUN'
 Save-Json (Join-Path $runRoot 'consumer-terminal.json') $result
}
if ($result.failure -or @($result.cleanup | Where-Object {$_.status -in @('CLEANUP_FAILED','PID_REUSED_UNTOUCHED')}).Count) {throw 'consumer_terminal_failed'}


