# Synthetic responses and diagnostic redaction only; no network/process/UI/native.
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'startup-predicate.ps1')
$main=[pscustomobject]@{type='page';url='http://localhost:5173/'}
$foreign=[pscustomobject]@{type='page';url='https://private.invalid/SYNTHETIC_PRIVATE'}
$count=0
if((Get-StartupWindowStyle 'jarvis') -ne [Diagnostics.ProcessWindowStyle]::Normal){throw 'app_visible_launch_required'};$count++
if((Get-StartupWindowStyle 'vite') -ne [Diagnostics.ProcessWindowStyle]::Hidden){throw 'helper_hidden_launch_preserved'};$count++
if(-not(Get-StartupTargetFacts @($main)).oneOfficialURL){throw 'one_target'};$count++
if((Get-StartupTargetFacts @($main,$main)).oneOfficialURL){throw 'duplicate_target'};$count++
if((Get-StartupTargetFacts @()).oneOfficialURL){throw 'empty_target'};$count++
if((Get-StartupTargetFacts @($foreign)).oneOfficialURL){throw 'foreign_target'};$count++
if(-not(Get-StartupTargetFacts @($foreign,$main)).oneOfficialURL){throw 'auxiliary_target'};$count++
if((Get-StartupTargetFacts @([pscustomobject]@{type='page';url='http://localhost:5173'})).oneOfficialURL){throw 'exact_url_required'};$count++
if((Get-StartupTargetFacts @([pscustomobject]@{type=@('page','page');url=@('http://localhost:5173/','http://localhost:5173/')})).oneOfficialURL){throw 'array_property_rejected'};$count++
$failed=$false
try{Get-StartupTargetFacts @((1..65)|ForEach-Object{$main})|Out-Null}catch{$failed=$true}
if(-not $failed){throw 'target_budget'};$count++
$d=[ordered]@{first=$null;last=$null;lastFingerprint=$null;changedStates=0;changes=[Collections.Generic.List[object]]::new()}
for($i=0;$i -lt 25;$i++){Add-StartupSnapshot $d @{elapsedMs=$i;cdpListenerCount=$i;windowVisible=$false;privateURL='SYNTHETIC_PRIVATE'}}
if($d.changes.Count -ne 16 -or $d.last.cdpListenerCount -ne 24 -or $d.changedStates -ne 25){throw 'diagnostic_bound_and_last'};$count++
$serialized=$d|ConvertTo-Json -Depth 6
if($serialized.Contains('SYNTHETIC_PRIVATE') -or $serialized.Contains('privateURL')){throw 'diagnostic_redaction'};$count++
$failed=$false
try{Add-StartupSnapshot $d @{windowVisible='SYNTHETIC_PRIVATE'}}catch{$failed=$true}
if(-not $failed){throw 'diagnostic_type'};$count++
[ordered]@{tests=$count;passed=$count;failed=0;skipped=0;scope='Synthetic target counting and bounded typed diagnostic; no REST/native/process'}|
 ConvertTo-Json|Set-Content -LiteralPath (Join-Path $PSScriptRoot 'startup-regression.json') -Encoding utf8
Get-Content -LiteralPath (Join-Path $PSScriptRoot 'startup-regression.json')
