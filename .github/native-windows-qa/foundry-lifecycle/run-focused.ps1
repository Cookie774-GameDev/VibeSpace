param(
 [Parameter(Mandatory)][string]$DisposableCheckout,
 [Parameter(Mandatory)][string]$OutputRoot,
 [Parameter(Mandatory)][string]$ExistingPython,
 [Parameter(Mandatory)][string]$PythonSHA256,
 [Parameter(Mandatory)][string]$CargoLockSHA256,
 [Parameter(Mandatory)][string]$RootAdmissionJSON,
 [Parameter(Mandatory)][string]$RootAdmissionSHA256,
 [Parameter(Mandatory)][string]$RootSupervisionJSON,
 [Parameter(Mandatory)][string]$RootSupervisionSHA256
)
$ErrorActionPreference='Stop'
function Hash([string]$p){(Get-FileHash -LiteralPath $p -Algorithm SHA256).Hash.ToLowerInvariant()}
function Assert-NoReparse([string]$path) {
 $cursor=[IO.Path]::GetFullPath($path)
 while($cursor){
  if(Test-Path -LiteralPath $cursor){$item=Get-Item -LiteralPath $cursor -Force;if(($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0){throw ('Reparse/junction denied: '+$cursor)}}
  $parent=[IO.Directory]::GetParent($cursor);if(!$parent){break};$cursor=$parent.FullName
 }
}
$checkout=[IO.Path]::GetFullPath($DisposableCheckout)
$output=[IO.Path]::GetFullPath($OutputRoot)
# Only NEW ROOT-owned disposable D checkout/output; never live C repository.
if(!$checkout.StartsWith('D:\CodexTaskScratch\sol61-mission-20261001-S61\',[StringComparison]::OrdinalIgnoreCase) -or !$output.StartsWith('D:\CodexTaskScratch\sol61-mission-20261001-S61\',[StringComparison]::OrdinalIgnoreCase)){throw 'Disposable D task scope required'}
Assert-NoReparse $checkout; Assert-NoReparse $output
if((Hash $RootAdmissionJSON) -ne $RootAdmissionSHA256){throw 'ROOT admission hash mismatch'}
$grant=Get-Content -LiteralPath $RootAdmissionJSON -Raw|ConvertFrom-Json
if($grant.authority -ne 'ROOT' -or $grant.purpose -ne 'S61A4_FOUNDRY_REAL_LIFECYCLE' -or $grant.explicitGrant -ne $true -or $grant.preflightExitCode -ne 0 -or $grant.peakMiB -lt 2048 -or $grant.commitPeakMiB -lt 4096){throw 'Explicit measured whole Cargo grant required'}
if($grant.disposableOwnership -ne 'ROOT_NEW_EXCLUSIVE_CHECKOUT' -or $grant.disposableCheckout -ne $checkout -or $grant.outputRoot -ne $output){throw 'Grant output scope mismatch'}
function FreshGrant {
 $now=[DateTimeOffset]::UtcNow
 if([DateTimeOffset]::Parse($grant.preflightAtUtc) -gt $now -or $now -ge [DateTimeOffset]::Parse($grant.expiresAtUtc) -or ($now-[DateTimeOffset]::Parse($grant.preflightAtUtc)).TotalSeconds -gt 30){throw 'Expired/stale admission; ROOT must refresh, no automatic retry'}
}
FreshGrant
$supervision=& (Join-Path $PSScriptRoot 'verify-root-supervision.ps1') -RootSupervisionJSON $RootSupervisionJSON -RootSupervisionSHA256 $RootSupervisionSHA256
if($supervision.runnerAdmissionSHA256 -ne $RootAdmissionSHA256){throw 'Supervisor/admission binding mismatch'}
if((Hash $ExistingPython) -ne $PythonSHA256){throw 'Existing Python SHA mismatch'}
$source=Join-Path $checkout 'app\src-tauri\src\model_foundry_training.rs'
$runtime=Join-Path $checkout 'app\src-tauri\src\harness\runtime.rs'
$lock=Join-Path $checkout 'app\src-tauri\Cargo.lock'
$beforeSHA='b647a3d2311e3af010e0b43739aabe61a1c2e8a0fe7c1b2642e434e5f8fb3222'
if((Hash $source) -ne $beforeSHA -or (Hash $runtime) -ne 'f709d98dc4ecc1b1cc08fb5488f4e4d86dfd21643a7ddb42d97d66cb521497d1' -or (Hash $lock) -ne $CargoLockSHA256){throw 'Actual applied source/lock mismatch'}
if(Test-Path -LiteralPath $output){throw 'Output must be new; preserve earlier fixtures'}
[IO.Directory]::CreateDirectory($output)|Out-Null
Assert-NoReparse $source; Assert-NoReparse $runtime; Assert-NoReparse $lock
$backup=Join-Path $output 'model_foundry_training.before.rs';[IO.File]::Copy($source,$backup,$false)
$priorPython=$env:S61_FOUNDRY_LIFECYCLE_PYTHON;$priorOutput=$env:S61_FOUNDRY_LIFECYCLE_OUTPUT_ROOT
$priorTarget=$env:CARGO_TARGET_DIR;$priorLocation=Get-Location
$exitCode=$null;$restored=$false
try {
 $overlayPath=Join-Path $PSScriptRoot 'lifecycle-tests.rs'
 if((Hash $overlayPath) -ne 'b9fa2f38329cda4e4b347aa7408214c6a8a01dfdef3970c8a37e8a51c1eb4654'){throw 'Frozen overlay hash mismatch'}
 $overlay=[IO.File]::ReadAllText($overlayPath)
 [IO.File]::AppendAllText($source,"`n"+$overlay,[Text.UTF8Encoding]::new($false))
 $injectedSHA=Hash $source
 $env:S61_FOUNDRY_LIFECYCLE_PYTHON=$ExistingPython;$env:S61_FOUNDRY_LIFECYCLE_OUTPUT_ROOT=$output
 $env:CARGO_TARGET_DIR=Join-Path $output 'cargo-target' # ROOT may provision matching cache in this own directory before admission.
 Set-Location (Join-Path $checkout 'app\src-tauri')
 FreshGrant # Refuse before Cargo if source preparation made admission stale.
 & cargo test --locked --lib 's61_real_setup_lifecycle_tests::' -- --test-threads=1 2>&1 | Tee-Object -FilePath (Join-Path $output 'cargo.log')
 $exitCode=$LASTEXITCODE
 if($exitCode -ne 0){throw ('Compiled lifecycle gate failed '+$exitCode)}
 if(@(Get-ChildItem -LiteralPath $output -Filter cleanup-unconfirmed.json -Recurse -File).Count -ne 0){throw 'Retained/unconfirmed cleanup; no lifecycle PASS'}
 $receipts=@(Get-ChildItem -LiteralPath $output -Filter receipt.json -Recurse -File)
 if($receipts.Count -ne 4){throw 'Exactly four actual lifecycle receipts required'}
 foreach($receipt in $receipts){$r=Get-Content -LiteralPath $receipt.FullName -Raw|ConvertFrom-Json;if(!$r.rootStarted -or !$r.grandchildStarted -or !$r.rootReapAndEmptyJobConfirmed -or !$r.ownedHandleReleased -or $r.cleanupPending -or !$r.lateMarkerAbsent){throw 'Incomplete lifecycle cleanup receipt'}}
} finally {
 $overlayUnchanged=(!$injectedSHA -or (Hash $source) -eq $injectedSHA)
 $backupUnchanged=((Hash $backup) -eq $beforeSHA)
 if($overlayUnchanged -and $backupUnchanged){
  Assert-NoReparse $source; Assert-NoReparse $backup
  [IO.File]::Copy($backup,$source,$true)
  $restored=((Hash $source) -eq $beforeSHA)
 }
 $lockMatches=((Hash $lock) -eq $CargoLockSHA256)
 $runtimeMatches=((Hash $runtime) -eq 'f709d98dc4ecc1b1cc08fb5488f4e4d86dfd21643a7ddb42d97d66cb521497d1')
 $env:S61_FOUNDRY_LIFECYCLE_PYTHON=$priorPython;$env:S61_FOUNDRY_LIFECYCLE_OUTPUT_ROOT=$priorOutput;$env:CARGO_TARGET_DIR=$priorTarget;Set-Location $priorLocation
 [IO.File]::WriteAllText((Join-Path $output 'terminal.json'),(@{cargoExitCode=$exitCode;sourceRestored=$restored;injectedSHA=$injectedSHA;overlayUnchanged=$overlayUnchanged;backupUnchanged=$backupUnchanged;lockMatches=$lockMatches;runtimeMatches=$runtimeMatches;outerJobFinalEmpty='ROOT_POSTRUN_REQUIRED';nativeAppAcceptance=$false}|ConvertTo-Json),[Text.UTF8Encoding]::new($false))
 if(!$restored -or !$lockMatches -or !$runtimeMatches){throw 'Restoration/integrity failure; preserve disposable files for ROOT recovery, cannot report PASS'}
}