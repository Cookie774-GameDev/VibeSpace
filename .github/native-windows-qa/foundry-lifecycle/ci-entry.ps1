param(
 [Parameter(Mandatory)][ValidatePattern('^[a-f0-9]{40}$')][string]$ExpectedCommit,
 [Parameter(Mandatory)][ValidatePattern('^[a-f0-9]{40}$')][string]$ExpectedTree,
 [Parameter(Mandatory)][string]$DisposableCheckout,
 [Parameter(Mandatory)][string]$OutputRoot,
 [Parameter(Mandatory)][string]$SupervisorMetadataRoot,
 [Parameter(Mandatory)][string]$AdmissionEvidenceRoot,
 [Parameter(Mandatory)][string]$ExistingPython,
 [Parameter(Mandatory)][ValidatePattern('^[a-f0-9]{64}$')][string]$ExpectedPythonSHA256,
 [Parameter(Mandatory)][ValidatePattern('^[a-f0-9]{64}$')][string]$ExpectedCargoLockSHA256,
 [Parameter(Mandatory)][string]$RootGrantID,
 [Parameter(Mandatory)][ValidateRange(2048,1048576)][int]$WholePeakMiB,
 [Parameter(Mandatory)][ValidateRange(4096,1048576)][int]$WholeCommitPeakMiB,
 [Parameter(Mandatory)][ValidateRange(0,1048576)][int]$ReservedGrowthMiB,
 [Parameter(Mandatory)][ValidateRange(0,1048576)][int]$ReservedCommitMiB,
 [ValidateRange(1,5390)][int]$MaximumSeconds=1800
)
$ErrorActionPreference='Stop';$utf8=[Text.UTF8Encoding]::new($false)
function Hash([string]$path){(Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()}
function NoReparse([string]$path){$cursor=[IO.Path]::GetFullPath($path);while($cursor){if(Test-Path -LiteralPath $cursor){if(((Get-Item -LiteralPath $cursor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0){throw 'Reparse path denied'}};$parent=[IO.Directory]::GetParent($cursor);if(!$parent){break};$cursor=$parent.FullName}}
function Test-S61CallerContainmentProof([object]$Proof,[int]$ExpectedOwnerPID,[string]$ExpectedHelperSHA256) {
 return ($ExpectedOwnerPID -gt 0 -and $Proof.ownerPID -eq $ExpectedOwnerPID -and
  $Proof.actualMembershipAndKillOnClose -eq $true -and $Proof.breakawayAllowed -eq $false -and
  $Proof.expectedCurrentActiveProcesses -eq 1 -and
  $Proof.scope -ceq 'DISPOSABLE_CI_CALLER_AND_ALL_FUTURE_DESCENDANTS' -and
  $Proof.jobName -cmatch '^Local\\S61-Foundry-Caller-[a-f0-9]{32}$' -and
  $ExpectedHelperSHA256 -cmatch '^[a-f0-9]{64}$' -and $Proof.helperSHA256 -ceq $ExpectedHelperSHA256)
}
if($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_OS -ne 'Windows' -or [string]::IsNullOrWhiteSpace($RootGrantID)){throw 'ROOT-authored real Windows CI invocation required; no local fallback'}
$checkout=[IO.Path]::GetFullPath($DisposableCheckout);$output=[IO.Path]::GetFullPath($OutputRoot);$metadata=[IO.Path]::GetFullPath($SupervisorMetadataRoot);$evidence=[IO.Path]::GetFullPath($AdmissionEvidenceRoot)
foreach($path in @($checkout,$output,$metadata,$evidence)){if(!$path.StartsWith('D:\CodexTaskScratch\sol61-mission-20261001-S61\',[StringComparison]::OrdinalIgnoreCase)){throw 'Only ROOT-exclusive task-owned D scope admitted'};NoReparse $path}
if(Test-Path -LiteralPath $evidence){throw 'Admission evidence must be new'}
if(@($checkout,$output,$metadata,$evidence|Select-Object -Unique).Count -ne 4){throw 'Distinct checkout/output/metadata/evidence required'}
foreach($newPath in @($output,$metadata)){if(Test-Path -LiteralPath $newPath){throw 'Never overwrite previous lifecycle outputs'}}
$head=(& git -C $checkout rev-parse HEAD).Trim();if($LASTEXITCODE -ne 0 -or $head -ne $ExpectedCommit){throw 'Compiled checkout commit mismatch'}
$tree=(& git -C $checkout rev-parse 'HEAD^{tree}').Trim();if($LASTEXITCODE -ne 0 -or $tree -ne $ExpectedTree){throw 'Compiled checkout tree mismatch'}
foreach($row in @(@('app\src-tauri\src\model_foundry_training.rs','b647a3d2311e3af010e0b43739aabe61a1c2e8a0fe7c1b2642e434e5f8fb3222'),@('app\src-tauri\src\harness\runtime.rs','f709d98dc4ecc1b1cc08fb5488f4e4d86dfd21643a7ddb42d97d66cb521497d1'),@('app\src-tauri\Cargo.lock',$ExpectedCargoLockSHA256))){$path=Join-Path $checkout $row[0];NoReparse $path;if((Hash $path) -ne $row[1]){throw 'Applied product/graph byte mismatch'}}
NoReparse $ExistingPython;if((Hash $ExistingPython) -ne $ExpectedPythonSHA256){throw 'Approved fixture Python mismatch'}
$supervisor=Join-Path $PSScriptRoot 'supervision-r2\start-supervised.ps1'
if((Hash $supervisor) -ne '127f6020ba51d73c76c245ae3f29f964d4808f8f522a1b60ce3aa7f4045cd4cc'){throw 'Reviewed supervisorR2 mismatch'}
$gate=Join-Path $PSScriptRoot 'heavy_job_preflight.py';NoReparse $gate
if((Hash $gate) -ne 'bd46d3b293cf051f879d204e9cf7f6f3ebfac26a5e26383e26327016f2cac6fb'){throw 'Canonical resource helper byte mismatch'}
[IO.Directory]::CreateDirectory($evidence)|Out-Null
$drive=Get-PSDrive D
$disk=[ordered]@{observedAtUtc=[DateTime]::UtcNow.ToString('o');actualFreeBytes=$drive.Free;requiredFreeBytes=20GB;planningFloor='PROVISIONAL_NO_WAIVER';compiledTargetIsNew=$true}
[IO.File]::WriteAllText((Join-Path $evidence 'disk-preflight.json'),($disk|ConvertTo-Json),$utf8)
if($drive.Free -lt 20GB){throw 'Disk admission denied: fresh cold checkout/target needs >=20 GiB provisional floor; no waiver'}
# Actual canonical memory/commit gate, no synthetic PASS and no lowered estimates.
$gateJSON=(& $ExistingPython $gate --peak-mib $WholePeakMiB --commit-peak-mib $WholeCommitPeakMiB --reserved-growth-mib $ReservedGrowthMiB --reserved-commit-mib $ReservedCommitMiB | Out-String).Trim();$gateExit=$LASTEXITCODE
[IO.File]::WriteAllText((Join-Path $evidence 'memory-preflight.json'),$gateJSON,$utf8)
if($gateExit -ne 0){throw ('Resource admission denied '+$gateExit)}
$observed=$gateJSON|ConvertFrom-Json;if($observed.admitted -ne $true){throw 'Actual resource receipt is not admitted'}
$grant=[ordered]@{authority='ROOT';purpose='S61A4_FOUNDRY_REAL_LIFECYCLE';rootGrantID=$RootGrantID;explicitGrant=$true;preflightExitCode=$gateExit;preflightAtUtc=$observed.observedAtUtc;expiresAtUtc=[DateTimeOffset]::Parse($observed.observedAtUtc).AddSeconds($MaximumSeconds+10).ToString('o');peakMiB=$WholePeakMiB;commitPeakMiB=$WholeCommitPeakMiB;reservedGrowthMiB=$ReservedGrowthMiB;reservedCommitMiB=$ReservedCommitMiB;disposableOwnership='ROOT_NEW_EXCLUSIVE_CHECKOUT';disposableCheckout=$checkout;outputRoot=$output;supervisorDriverSHA256=(Hash $supervisor);publicationCommit=$ExpectedCommit;publicationTree=$ExpectedTree;actualGateSHA256=(Hash (Join-Path $evidence 'memory-preflight.json'));cargoLockSHA256=$ExpectedCargoLockSHA256;pythonSHA256=$ExpectedPythonSHA256}
# Independent caller-level fallback contains EVERY future runner descendant,
# including a suspended root whose inner-job assignment fails. This is CI-only,
# never the user's app/desktop PowerShell session. Handle lifetime is the caller.
$fallbackSource=Join-Path $PSScriptRoot 'caller-exit-containment.cs';NoReparse $fallbackSource
if((Hash $fallbackSource) -ne '4d0e9117e0e4a81e0218265ec4155d83069d7403b6e443a42daba51a5ea68d91'){throw 'Caller containment source mismatch'}
Add-Type -Path $fallbackSource
$fresh=[DateTimeOffset]::UtcNow
if(($fresh-[DateTimeOffset]::Parse($observed.observedAtUtc)).TotalSeconds -gt 30 -or $fresh -ge [DateTimeOffset]::Parse($grant.expiresAtUtc)){throw 'Containment preparation made actual admission stale; no runner permitted'}
$fallbackName='Local\S61-Foundry-Caller-'+[Guid]::NewGuid().ToString('N')
[S61CallerExitContainment]::Arm($fallbackName)
$fallbackProof=[ordered]@{authority='ROOT';scope='DISPOSABLE_CI_CALLER_AND_ALL_FUTURE_DESCENDANTS';ownerPID=[S61CallerExitContainment]::OwnerPID;jobName=[S61CallerExitContainment]::Name;actualMembershipAndKillOnClose=[S61CallerExitContainment]::Armed;breakawayAllowed=$false;expectedCurrentActiveProcesses=[S61CallerExitContainment]::ActiveProcesses();releaseRule='EXACT_HANDLE_RETAINED_UNTIL_OWNER_PROCESS_EXIT';unknownInnerCleanupStillBlocked=$true;helperSHA256=(Hash $fallbackSource)}
if(!(Test-S61CallerContainmentProof $fallbackProof $PID '4d0e9117e0e4a81e0218265ec4155d83069d7403b6e443a42daba51a5ea68d91')){throw 'Caller fallback not exclusively armed before any runner start'}
[IO.File]::WriteAllText((Join-Path $evidence 'caller-containment.json'),($fallbackProof|ConvertTo-Json -Depth 5),$utf8)
$grantPath=Join-Path $evidence 'root-admission.json';[IO.File]::WriteAllText($grantPath,($grant|ConvertTo-Json -Depth 6),$utf8)
$result=& $supervisor -RootAdmissionJSON $grantPath -RootAdmissionSHA256 (Hash $grantPath) -SupervisionOutputRoot $metadata -ExistingPython $ExistingPython -PythonSHA256 $ExpectedPythonSHA256 -CargoLockSHA256 $ExpectedCargoLockSHA256 -MaximumSeconds $MaximumSeconds
if($result.status -eq 'BLOCKED_RETAINED_OWNED_HANDLES'){
 # Same persistent CI step retains exact handles; bounded recovery only its own
 # handle/job. ROOT cannot report PASS or exit without acknowledging this block.
 $job=[S61LifecycleJob]::RetainedOwner;$closed=$false
 if($job){try{$job.Terminate();$until=[Diagnostics.Stopwatch]::StartNew();while($until.Elapsed.TotalSeconds -lt 5){if($job.ConfirmClosed()){$closed=$true;break};Start-Sleep -Milliseconds 25}}catch{};if($closed){$job.Dispose();[S61LifecycleJob]::RetainedOwner=$null}}
 [IO.File]::WriteAllText((Join-Path $evidence 'retained-recovery.json'),(@{status='ORIGINAL_RUN_BLOCKED';confirmedClosedAfterRetry=$closed;pass=$false;callerFallbackArmed=[S61CallerExitContainment]::Armed;callerFallbackJob=[S61CallerExitContainment]::Name;callerFallbackActiveProcesses=[S61CallerExitContainment]::ActiveProcesses();containmentOnOwnerExit='KILL_ON_JOB_CLOSE';acknowledgedInnerClosure=$closed}|ConvertTo-Json),$utf8)
 # Unknown exact child is STILL contained by caller job; throwing/exiting can
 # no longer leave an unassigned suspended runner outside owned containment.
 throw 'Lifecycle run blocked; independent actual caller job remains armed through caller exit, no closure PASS'
}
if(![S61CallerExitContainment]::Armed){throw 'Caller fallback lost; no closure PASS'}
if($result.status -ne 'PASS'){throw 'Actual compiled/process-tree lifecycle gate failed; preserve all receipts'}
$fixtureReceipts=@(Get-ChildItem -LiteralPath $output -Directory -Filter 's61-lifecycle-*'|ForEach-Object{Join-Path $_.FullName 'receipt.json'})
if($fixtureReceipts.Count -ne 4 -or @($fixtureReceipts|Where-Object {!(Test-Path -LiteralPath $_)}).Count -ne 0){throw 'Exactly four actual lifecycle receipts required'}
if([S61CallerExitContainment]::ActiveProcesses() -ne 1){throw 'Caller job still contains descendants; no no-orphan PASS'}
$proof=[ordered]@{status='PASS';callerJobActiveProcesses=1;callerJobOwnPIDOnly=$true;callerFallbackJob=[S61CallerExitContainment]::Name;callerFallbackArmed=[S61CallerExitContainment]::Armed;expectedCommit=$head;expectedTree=$tree;actualCompiledCases=4;actualCompiledFailures=0;sourceBeforeSHA256='b647a3d2311e3af010e0b43739aabe61a1c2e8a0fe7c1b2642e434e5f8fb3222';runtimeSHA256='f709d98dc4ecc1b1cc08fb5488f4e4d86dfd21643a7ddb42d97d66cb521497d1';nativeUIAcceptance=$false;outerRootReaped=$result.outerRootReaped;outerJobEmpty=$result.outerJobEmpty;noRetainedChild=$result.noRetainedChild;artifacts=@($fixtureReceipts+(Join-Path $output 'terminal.json')+(Join-Path $metadata 'watchdog-terminal.json')+(Join-Path $metadata 'supervision.json')|ForEach-Object{@{path=$_;sha256=(Hash $_)}})}
[IO.File]::WriteAllText((Join-Path $evidence 'lifecycle-final-proof.json'),($proof|ConvertTo-Json -Depth 8),$utf8)
'Actual four lifecycle cases and outer job closure PASS; native app acceptance remains false.'