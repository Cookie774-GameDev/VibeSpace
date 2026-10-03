param(
 [Parameter(Mandatory)][string]$RootAdmissionJSON,
 [Parameter(Mandatory)][string]$RootAdmissionSHA256,
 [Parameter(Mandatory)][string]$SupervisionOutputRoot,
 [Parameter(Mandatory)][string]$ExistingPython,
 [Parameter(Mandatory)][string]$PythonSHA256,
 [Parameter(Mandatory)][string]$CargoLockSHA256,
 [ValidateRange(1,5390)][int]$MaximumSeconds=1800
)
$ErrorActionPreference='Stop'
$utf8=[Text.UTF8Encoding]::new($false)
function Hash([string]$path){(Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()}
function NoReparse([string]$path){$cursor=[IO.Path]::GetFullPath($path);while($cursor){if(Test-Path -LiteralPath $cursor){if(((Get-Item -LiteralPath $cursor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0){throw 'Reparse path denied'}};$parent=[IO.Directory]::GetParent($cursor);if(!$parent){break};$cursor=$parent.FullName}}
NoReparse $RootAdmissionJSON; NoReparse $ExistingPython; NoReparse $PSCommandPath
if((Hash $RootAdmissionJSON) -ne $RootAdmissionSHA256){throw 'ROOT admission hash mismatch'}
$grant=Get-Content -LiteralPath $RootAdmissionJSON -Raw|ConvertFrom-Json
if($grant.supervisorDriverSHA256 -ne (Hash $PSCommandPath) -or $grant.authority -ne 'ROOT' -or $grant.explicitGrant -ne $true -or $grant.purpose -ne 'S61A4_FOUNDRY_REAL_LIFECYCLE' -or $grant.preflightExitCode -ne 0 -or $grant.peakMiB -lt 2048 -or $grant.commitPeakMiB -lt 4096 -or $grant.disposableOwnership -ne 'ROOT_NEW_EXCLUSIVE_CHECKOUT'){throw 'Actual whole supervisor/Cargo/tree ROOT grant required'}
$metadata=[IO.Path]::GetFullPath($SupervisionOutputRoot)
$checkout=[IO.Path]::GetFullPath($grant.disposableCheckout)
$output=[IO.Path]::GetFullPath($grant.outputRoot)
foreach($path in @($metadata,$checkout,$output)){if(!$path.StartsWith('D:\CodexTaskScratch\sol61-mission-20261001-S61\',[StringComparison]::OrdinalIgnoreCase)){throw 'Only exact task-owned D output/checkout admitted'};NoReparse $path}
if($metadata -eq $output -or $metadata.StartsWith($output+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'Supervisor metadata must be separate from new runner output'}
if(Test-Path -LiteralPath $metadata){throw 'Never overwrite earlier supervisor evidence'}
$packet=Split-Path $PSScriptRoot -Parent
$runner=Join-Path $packet 'run-focused.ps1';$verify=Join-Path $packet 'verify-root-supervision.ps1';$tests=Join-Path $packet 'lifecycle-tests.rs'
foreach($row in @(@($runner,'a375ef9909f0abeb20e97c21d2a887dfa0a635708d3d62aecede5820dc7eea54'),@($verify,'0fe73de35dc4340b17614ecc11e063ddf75eb9a59e49671690015677df6d322c'),@($tests,'b9fa2f38329cda4e4b347aa7408214c6a8a01dfdef3970c8a37e8a51c1eb4654'))){if((Hash $row[0]) -ne $row[1]){throw 'Frozen lifecycle packet mismatch'}}
if((Hash (Join-Path $checkout 'app\src-tauri\src\model_foundry_training.rs')) -ne 'b647a3d2311e3af010e0b43739aabe61a1c2e8a0fe7c1b2642e434e5f8fb3222' -or (Hash (Join-Path $checkout 'app\src-tauri\src\harness\runtime.rs')) -ne 'f709d98dc4ecc1b1cc08fb5488f4e4d86dfd21643a7ddb42d97d66cb521497d1'){throw 'Applied source tuple mismatch'}
if((Hash $ExistingPython) -ne $PythonSHA256 -or (Hash (Join-Path $checkout 'app\src-tauri\Cargo.lock')) -ne $CargoLockSHA256){throw 'Python/locked graph mismatch'}
# This is an external supervisor in the ROOT caller process; never run as an
# unobserved standalone powershell process that would discard retained handles.
$watchdog=Get-CimInstance Win32_Process -Filter ('ProcessId='+$PID)
$watchdogBirth=([DateTimeOffset]$watchdog.CreationDate.ToUniversalTime()).ToString('o')
$watchdogExecutable=$watchdog.ExecutablePath
if(!$watchdogExecutable -or !(Test-Path -LiteralPath $watchdogExecutable)){throw 'Supervisor executable identity absent'}
$helperPath=Join-Path $PSScriptRoot 'owned-job.cs'
NoReparse $helperPath
if((Hash $helperPath) -ne 'ed93063cdbc8c2fba506b35dc4d6026fef5aaa59541b4ce7b34eb60e86db4763'){throw 'Pinned C# companion source mismatch'}
Add-Type -Path $helperPath
if([S61LifecycleJob]::RetainedOwner){throw 'Earlier cleanup owner retained; ROOT must settle before another lifecycle run'}
$now=[DateTimeOffset]::UtcNow
if([DateTimeOffset]::Parse($grant.preflightAtUtc) -gt $now -or ($now-[DateTimeOffset]::Parse($grant.preflightAtUtc)).TotalSeconds -gt 30 -or $now -ge [DateTimeOffset]::Parse($grant.expiresAtUtc)){throw 'Stale/denied ROOT gate; no runner/process created'}
$available=([DateTimeOffset]::Parse($grant.expiresAtUtc)-$now).TotalSeconds
$runSeconds=[Math]::Min($MaximumSeconds,[Math]::Floor($available)-10)
if($runSeconds -lt 1){throw 'ROOT grant lacks finite run+cleanup margin'}
[IO.Directory]::CreateDirectory($metadata)|Out-Null
$jobName='Local\S61-Foundry-'+[Guid]::NewGuid().ToString('N')
$job=[S61LifecycleJob]::new($jobName)
$clock=[Diagnostics.Stopwatch]::StartNew();$stopReason='setup_failure';$errorText=$null;$exitCode=$null;$closed=$false;$retained=$false;$cancelAccepted=$false
$supervisionPath=Join-Path $metadata 'supervision.json'
$cancelPath=Join-Path $metadata 'cancel.json';$cancelToken=[Guid]::NewGuid().ToString('N')
try {
 $supervision=[ordered]@{authority='ROOT';purpose='S61A4_FOUNDRY_REAL_LIFECYCLE';watchdogArmed=$true;killOnClose=$true;processTreeScope='THIS_RUNNER_AND_ALL_DESCENDANTS';jobName=$jobName;maximumSeconds=$runSeconds;expiresAtUtc=$now.AddSeconds($runSeconds).ToString('o');supervisorPID=$PID;supervisorBirthUtc=$watchdogBirth;supervisorExecutableSHA256=(Hash $watchdogExecutable);watchdogDriverSHA256=(Hash $PSCommandPath);runnerAdmissionSHA256=$RootAdmissionSHA256;cancelToken=$cancelToken;cancelPath=$cancelPath}
 [IO.File]::WriteAllText($supervisionPath,($supervision|ConvertTo-Json -Depth 5),$utf8)
 $parameters=@('-NoLogo','-NoProfile','-NonInteractive','-File',$runner,'-DisposableCheckout',$checkout,'-OutputRoot',$output,'-ExistingPython',$ExistingPython,'-PythonSHA256',$PythonSHA256,'-CargoLockSHA256',$CargoLockSHA256,'-RootAdmissionJSON',$RootAdmissionJSON,'-RootAdmissionSHA256',$RootAdmissionSHA256,'-RootSupervisionJSON',$supervisionPath,'-RootSupervisionSHA256',(Hash $supervisionPath))
 $command=([S61LifecycleJob]::Quote($watchdogExecutable))+' '+(($parameters|ForEach-Object{[S61LifecycleJob]::Quote($_)}) -join ' ')
 # Check capacity receipt AGAIN immediately before actual process creation; no refresh/bypass.
 $fresh=[DateTimeOffset]::UtcNow
 if($fresh -ge [DateTimeOffset]::Parse($grant.expiresAtUtc) -or $fresh -ge [DateTimeOffset]::Parse($supervision.expiresAtUtc) -or $clock.Elapsed.TotalSeconds -ge $runSeconds -or ($fresh-[DateTimeOffset]::Parse($grant.preflightAtUtc)).TotalSeconds -gt 30 -or [DateTimeOffset]::Parse($grant.preflightAtUtc) -gt $fresh){throw 'Prelaunch grant/supervision/deadline expired or gate stale'}
 NoReparse $RootAdmissionJSON; NoReparse $helperPath; NoReparse $ExistingPython
 foreach($checkPath in @($checkout,$output,$metadata,$runner,$verify,$tests,(Join-Path $checkout 'app\src-tauri\src\model_foundry_training.rs'),(Join-Path $checkout 'app\src-tauri\src\harness\runtime.rs'),(Join-Path $checkout 'app\src-tauri\Cargo.lock'))){NoReparse $checkPath}
 if((Hash $RootAdmissionJSON) -ne $RootAdmissionSHA256 -or (Hash $helperPath) -ne 'ed93063cdbc8c2fba506b35dc4d6026fef5aaa59541b4ce7b34eb60e86db4763' -or (Hash $ExistingPython) -ne $PythonSHA256){throw 'Prelaunch authority/helper/Python changed'}
 $fresh=[DateTimeOffset]::UtcNow
 if($fresh -ge [DateTimeOffset]::Parse($grant.expiresAtUtc) -or $fresh -ge [DateTimeOffset]::Parse($supervision.expiresAtUtc) -or $clock.Elapsed.TotalSeconds -ge $runSeconds -or ($fresh-[DateTimeOffset]::Parse($grant.preflightAtUtc)).TotalSeconds -gt 30){throw 'Final adjacent launch authority expired'}
 $job.SpawnSuspended($watchdogExecutable,$command,$checkout)
 $job.Resume()
 $stopReason='running'
 while(!$job.RootExited()) {
  if(Test-Path -LiteralPath $cancelPath){
   if((Get-Item -LiteralPath $cancelPath).Length -gt 4096){throw 'Oversized own cancellation receipt'}
   $cancel=Get-Content -LiteralPath $cancelPath -Raw|ConvertFrom-Json
   if($cancel.authority -ne 'ROOT' -or $cancel.token -ne $cancelToken -or $cancel.jobName -ne $jobName){throw 'Foreign cancellation receipt refused; owned tree will be cleaned'}
   $cancelAccepted=$true;$stopReason='cancelled';break
  }
  if($clock.Elapsed.TotalSeconds -ge $runSeconds){$stopReason='timeout';break}
  Start-Sleep -Milliseconds 100
 }
 if($stopReason -eq 'running'){$stopReason='root_terminal';$exitCode=$job.ExitCode()}
} catch {$errorText=$_.Exception.Message;$stopReason='failure'} finally {
 # Always close only this exact job/root handle, including failed assign/resume.
 try {$job.Terminate()} catch {$errorText=([string]$errorText)+'; '+$_.Exception.Message}
 $cleanup=[Diagnostics.Stopwatch]::StartNew()
 while($cleanup.Elapsed.TotalSeconds -lt 8){try{if($job.ConfirmClosed()){$closed=$true;break}}catch{$errorText=([string]$errorText)+'; '+$_.Exception.Message;break};Start-Sleep -Milliseconds 25}
 if(!$closed){[S61LifecycleJob]::RetainedOwner=$job;$retained=$true}else{$job.Dispose()}
 $terminalPath=Join-Path $output 'terminal.json';$runnerTerminal=$null
 if(Test-Path -LiteralPath $terminalPath){
  try {
   NoReparse $terminalPath
   $parseClock=[Diagnostics.Stopwatch]::StartNew()
   if((Get-Item -LiteralPath $terminalPath).Length -gt 16384){throw 'Oversized terminal JSON'}
   $stream=[IO.File]::Open($terminalPath,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::ReadWrite)
   try {$buffer=[byte[]]::new(16385);$total=0;while($total -lt $buffer.Length){$read=$stream.Read($buffer,$total,$buffer.Length-$total);if($read -eq 0){break};$total+=$read};if($total -gt 16384){throw 'Growing terminal JSON exceeded cap'};$text=[Text.UTF8Encoding]::new($false,$true).GetString($buffer,0,$total)}finally{$stream.Dispose()}
   $runnerTerminal=$text|ConvertFrom-Json -Depth 8
   if($parseClock.ElapsedMilliseconds -gt 1000){throw 'Terminal read/parse exceeded one-second budget'}
  } catch {$errorText=([string]$errorText)+'; bounded terminal proof failed: '+$_.Exception.Message;$runnerTerminal=$null}
 }
 $cleanupFailures=@();if(Test-Path -LiteralPath $output){foreach($dir in @(Get-ChildItem -LiteralPath $output -Directory -Filter 's61-lifecycle-*')){$failure=Join-Path $dir.FullName 'cleanup-unconfirmed.json';if(Test-Path -LiteralPath $failure){$cleanupFailures+=$failure}}}
 $pass=($stopReason -eq 'root_terminal' -and $exitCode -eq 0 -and $closed -and !$retained -and !$errorText -and $cleanupFailures.Count -eq 0 -and $runnerTerminal.sourceRestored -eq $true -and $runnerTerminal.lockMatches -eq $true -and $runnerTerminal.runtimeMatches -eq $true)
 $receipt=[ordered]@{status=$(if($pass){'PASS'}elseif($retained){'BLOCKED_RETAINED_OWNED_HANDLES'}else{'FAIL'});stopReason=$stopReason;error=$errorText;rootExitCode=$exitCode;jobName=$jobName;ownedRunnerPID=$job.ChildPID;outerRootReaped=$closed;outerJobEmpty=$closed;retainedOwnedHandles=$retained;noRetainedChild=($closed -and $cleanupFailures.Count -eq 0);retainedOwnershipProcessPID=$(if($retained){$PID}else{$null});cancelAccepted=$cancelAccepted;elapsedMilliseconds=$clock.ElapsedMilliseconds;rootAdmissionSHA256=$RootAdmissionSHA256;supervisionSHA256=(Hash $supervisionPath);nativeAppAcceptance=$false}
 [IO.File]::WriteAllText((Join-Path $metadata 'watchdog-terminal.json'),($receipt|ConvertTo-Json -Depth 5),$utf8)
}
$receipt