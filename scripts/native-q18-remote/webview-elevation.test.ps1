# Pure classifier cases and one harmless own-token ABI check. No app/native UI/other tokens.
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'webview-elevation.ps1')
$count=0
$cases=@(
 @($true,$false,0x2000,$true,'STANDARD_TOKEN_ENV_OVERRIDE_PATH_ADMITTED'),
 @($true,$false,0x2100,$true,'STANDARD_TOKEN_ENV_OVERRIDE_PATH_ADMITTED'),
 @($true,$true,0x3000,$false,'ELEVATED_WEBVIEW_ENV_OVERRIDES_IGNORED'),
 @($true,$true,0x2000,$false,'ELEVATED_WEBVIEW_ENV_OVERRIDES_IGNORED'),
 @($true,$false,0x3000,$false,'ELEVATED_WEBVIEW_ENV_OVERRIDES_IGNORED'),
 @($true,$true,0x4000,$false,'ELEVATED_WEBVIEW_ENV_OVERRIDES_IGNORED'),
 @($true,$false,0x1000,$false,'NONSTANDARD_INTEGRITY_BLOCKED'),
 @($true,$false,0x0000,$false,'NONSTANDARD_INTEGRITY_BLOCKED'),
 @($false,$false,0x2000,$false,'TOKEN_UNPROVEN_BLOCKED'),
 @($true,$false,12345,$false,'TOKEN_UNPROVEN_BLOCKED'),
 @($true,'false',0x2000,$false,'TOKEN_UNPROVEN_BLOCKED'),
 @('true',$false,0x2000,$false,'TOKEN_UNPROVEN_BLOCKED'),
 @($true,$false,'PRIVATE_SYNTHETIC',$false,'TOKEN_UNPROVEN_BLOCKED')
)
foreach($c in $cases){
 $f=Get-WebViewElevationFacts $c[0] $c[1] $c[2]
 if($f.envOverrideLaunchAdmitted -cne $c[3] -or $f.reason -cne $c[4] -or $f.nativeAcceptance -cne 'UNRUN'){throw "case_$count"}
 if(($f|ConvertTo-Json).Contains('PRIVATE')){throw 'redaction'}
 $count++
}
if(-not $IsWindows){throw 'Own ABI fixture requires Windows'}
# This always reads THIS fixture process, never Jarvis or any peer PID.
Initialize-Q18CurrentTokenProbe
$v=[Q18CurrentTokenProbe]::ReadCurrent()
$own=Get-WebViewElevationFacts $v[0] $v[1] $v[2]
if(-not $own.querySucceeded){throw 'own_token_abi_query_failed'}
[ordered]@{syntheticTests=$count;passed=$count;failed=0;skipped=0;ownTokenABI='PASS';
 fixturePID=$PID;ownToken=$own;scope='Current fixture token only; no native UI/app/registry/network/impersonation/de-elevation'}|
 ConvertTo-Json -Depth 5|Set-Content -LiteralPath (Join-Path $PSScriptRoot 'elevation-regression.json') -Encoding utf8
Get-Content -LiteralPath (Join-Path $PSScriptRoot 'elevation-regression.json')
