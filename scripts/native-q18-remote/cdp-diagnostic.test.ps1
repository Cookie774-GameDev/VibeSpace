$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'lifecycle.ps1')
. (Join-Path $PSScriptRoot 'cdp-diagnostic.ps1')
$profile='C:\owned profile'
$good='msedgewebview2.exe --user-data-dir="C:\owned profile" --remote-debugging-port=9228 PRIVATE_SYNTHETIC'
$count=0
$f=Get-CdpFlagFacts $good $profile 9228
if(-not $f.profileMatches -or -not $f.expectedPortMatches -or $f.kind -cne 'Browser'){throw 'exact_flags'};$count++
$f=Get-CdpFlagFacts ($good.Replace('9228','9252')) $profile 9228
if($f.expectedPortMatches -or -not $f.differentPortRequested){throw 'different_port'};$count++
$f=Get-CdpFlagFacts ($good.Replace('9228','0')) $profile 9228
if(-not $f.zeroPortRequested){throw 'ephemeral_port'};$count++
$f=Get-CdpFlagFacts 'msedgewebview2.exe --type=renderer' $profile 9228
if($f.kind -cne 'renderer' -or $f.portSwitchCount -ne 0 -or $f.profileMatches){throw 'renderer_flags_absent'};$count++
$f=Get-CdpFlagFacts ($good+' --remote-debugging-port=9228') $profile 9228
if($f.expectedPortMatches -or $f.portSwitchCount -ne 2){throw 'duplicate_switch'};$count++
$rows=@([pscustomobject]@{pid=100;parentPid=1;bornMs=1000;name='jarvis.exe';commandLine=''},
 [pscustomobject]@{pid=200;parentPid=100;bornMs=1100;name='msedgewebview2.exe';commandLine=$good},
 [pscustomobject]@{pid=300;parentPid=999;bornMs=1200;name='msedgewebview2.exe';commandLine='PEER_PRIVATE'})
$listeners=@([pscustomobject]@{ownerPid=200;port=9252;address='127.0.0.1'},[pscustomobject]@{ownerPid=300;port=9228;address='127.0.0.1'})
$d=Get-OwnedCdpDiagnostic @{pid=100;bornMs=1000} $rows $listeners $profile 9228
if($d.ownedWebViewCount -ne 1 -or $d.rows[0].expectedLoopbackListeners -ne 0 -or $d.rows[0].otherLoopbackListenerCount -ne 1){throw 'owned_only_listener'};$count++
if(($d|ConvertTo-Json -Depth 5).Contains('PRIVATE') -or ($d|ConvertTo-Json -Depth 5).Contains($profile)){throw 'private_redaction'};$count++
$d=Get-OwnedCdpDiagnostic @{pid=100;bornMs=999} $rows $listeners $profile 9228
if($d.ownedWebViewCount){throw 'birth_reuse'};$count++
$f=Get-CdpPolicyValueFact 'PRIVATE_SYNTHETIC' @(0,1,2)
if($f.recognizedEnum -or $null -ne $f.value){throw 'policy_nonenum_redaction'};$count++
$f=Get-CdpPolicyValueFact 2 @(0,1,2)
if(-not $f.recognizedEnum -or $f.value -ne 2){throw 'policy_known_enum'};$count++
$many=@($rows[0])+@(1..34|ForEach-Object{[pscustomobject]@{pid=(400+$_);parentPid=100;bornMs=1200;name='msedgewebview2.exe';commandLine=$good}})
$d=Get-OwnedCdpDiagnostic @{pid=100;bornMs=1000} $many @() $profile 9228
if($d.ownedWebViewCount -ne 34 -or $d.rows.Count -ne 32 -or -not $d.rowsTruncated){throw 'row_bound'};$count++
$request=Get-CdpLaunchRequestFacts @{WEBVIEW2_USER_DATA_FOLDER=$profile;WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS='--remote-debugging-address=127.0.0.1 --remote-debugging-port=9228'} $profile 9228
if(-not $request.debugArgumentsMatch -or -not $request.profileMatches -or $request.githubTokenPresent){throw 'request_exact'};$count++
$request=Get-CdpLaunchRequestFacts @{GITHUB_TOKEN='PRIVATE_SYNTHETIC'} $profile 9228
if($request.debugArgumentsMatch -or $request.profileMatches -or -not $request.githubTokenPresent -or ($request|ConvertTo-Json).Contains('PRIVATE')){throw 'request_missing_redaction'};$count++
$diag=[ordered]@{first=$null;last=$null;probes=0;failedProbes=0}
Update-CdpDiagnostic $diag 1 $d $false
Update-CdpDiagnostic $diag 5001 $null $true
if($diag.probes -ne 2 -or $diag.failedProbes -ne 1 -or $diag.first.elapsedMs -ne 1 -or -not $diag.last.probeFailed){throw 'first_last_failures'};$count++
$f=Get-CdpFlagFacts '' $profile 9228
if($f.commandLineAvailable -or $f.profileMatches -or $f.expectedPortMatches){throw 'missing_argv'};$count++
[ordered]@{tests=$count;passed=$count;failed=0;skipped=0;scope='Synthetic owned PID-birth/flag/policy/redaction/request/bounds only; no process query, registry, native or network'}|
 ConvertTo-Json|Set-Content -LiteralPath (Join-Path $PSScriptRoot 'cdp-regression.json') -Encoding utf8
Get-Content -LiteralPath (Join-Path $PSScriptRoot 'cdp-regression.json')
