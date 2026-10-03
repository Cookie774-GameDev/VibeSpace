#requires -Version 7.0
param(
  [Parameter(Mandatory=$true)][string]$RepositoryRoot,
  [Parameter(Mandatory=$true)][string]$OutputDirectory,
  [switch]$IncludeRestorationRegression
)
$ErrorActionPreference='Stop'
if(-not $IsWindows){throw 'Windows required: one new fixture is Windows-only'}
if(Test-Path -LiteralPath $OutputDirectory){throw 'Preserve prior Cargo receipt directory'}
[void][System.IO.Directory]::CreateDirectory($OutputDirectory)
$taskNewTests=@(
 'native_app_surface::embedding::tests::packaged_content_requires_its_ready_shell_frame',
 'native_app_surface::tests::attachment_waits_for_two_matching_ready_observations',
 'native_app_surface::tests::changed_or_missing_content_resets_attachment_readiness',
 'native_app_surface::tests::crash_containment_is_scoped_to_the_observed_packaged_notepad',
 'native_app_surface::tests::contained_notepad_is_fallback_without_embedding_or_process_ownership',
 'kernel_host::tests::source_revision_closed_dto_rejects_null_partial_and_unknown_binding',
 'kernel_host::tests::source_revision_dto_rejects_oversized_ids_and_invalid_attempts',
 'kernel_host::tests::source_revision_response_rejects_epoch_and_hash_boundaries',
 'kernel_host::tests::source_revision_response_requires_exact_scope_and_binding_correlation',
 'kernel_host::tests::source_revision_main_reads_use_broker_epoch_without_action_admission'
)
$taskTests=@($taskNewTests)
if($IncludeRestorationRegression){$taskTests+=@(
 'native_app_surface::embedding::tests::hosts_resizes_hides_and_restores_a_disposable_external_window',
 'native_app_surface::embedding::tests::restores_content_to_its_original_frame_after_hosting',
 'native_app_surface::embedding::tests::restores_a_hidden_content_frame_after_hosting',
 'native_app_surface::embedding::tests::restores_the_original_hidden_state_of_a_hosted_window'
)}
$taskArgs=@('test','--locked','--manifest-path',(Join-Path $RepositoryRoot 'app/src-tauri/Cargo.toml'),'--lib','--','--exact','--test-threads=1','--color=never')+$taskTests
$taskSeen=[System.Collections.Generic.Dictionary[string,string]]::new()
$taskPriorModules=$env:PSModulePath
$taskLog=Join-Path $OutputDirectory 'cargo.log'
$taskUtf8=[System.Text.UTF8Encoding]::new($false)
$taskStarted=[DateTimeOffset]::UtcNow.ToString('o')
try {
 # Scope only this CI process and its owned Cargo/WinPS children; restore afterward.
 $env:PSModulePath=(Join-Path $env:SystemRoot 'System32/WindowsPowerShell/v1.0/Modules')+[IO.Path]::PathSeparator+$taskPriorModules
 & cargo @taskArgs 2>&1 | ForEach-Object {
  $taskLine="$_"
  [IO.File]::AppendAllText($taskLog,$taskLine+[Environment]::NewLine,$taskUtf8)
  Write-Host $taskLine
  $taskMatch=[regex]::Match($taskLine,'^test (.+) \.\.\. (ok|FAILED|ignored)$')
  if($taskMatch.Success){
   $taskName=$taskMatch.Groups[1].Value
   if($taskSeen.ContainsKey($taskName)){throw 'Duplicate test result row'}
   $taskSeen.Add($taskName,$taskMatch.Groups[2].Value)
  }
 }
 $taskExit=$LASTEXITCODE
} finally {$env:PSModulePath=$taskPriorModules}
$taskMissing=@($taskTests|Where-Object {-not $taskSeen.ContainsKey($_)})
$taskFailed=@($taskTests|Where-Object {$taskSeen.ContainsKey($_) -and $taskSeen[$_] -ne 'ok'})
$taskUnexpected=@($taskSeen.Keys|Where-Object {$_ -notin $taskTests})
$taskPassed=$taskExit -eq 0 -and $taskMissing.Count -eq 0 -and $taskFailed.Count -eq 0 -and $taskUnexpected.Count -eq 0 -and $taskSeen.Count -eq $taskTests.Count
$taskReceipt=[ordered]@{startedAt=$taskStarted;finishedAt=[DateTimeOffset]::UtcNow.ToString('o');status=$(if($taskPassed){'PASS_FOCUSED_RUST_CODE_ONLY'}else{'FAIL'});cargoExitCode=$taskExit;arguments=$taskArgs;newTests=$taskNewTests;expectedCount=$taskTests.Count;actualResultRows=$taskSeen;missing=$taskMissing;failed=$taskFailed;unexpected=$taskUnexpected;nativeAppAcceptance=$false;compilationIncluded=$true;oneCargoInvocation=$true;requiresRootCloudResourceAdmission=$true}
[IO.File]::WriteAllText((Join-Path $OutputDirectory 'receipt.json'),($taskReceipt|ConvertTo-Json -Depth 8),$taskUtf8)
if(-not $taskPassed){throw 'Cargo failed, or exact expected test rows did not all pass'}