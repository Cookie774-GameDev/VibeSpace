param([Parameter(Mandatory)][string]$TaskId,
 [Parameter(Mandatory)][string]$TransferGrantId,
 [Parameter(Mandatory)][string]$DependencyGrantId,
 [Parameter(Mandatory)][string]$NativeSetupGrantId,
 [Parameter(Mandatory)][string]$HelperManifestSHA256,
 [Parameter(Mandatory)][string]$WebViewPolicyGrantId)
$ErrorActionPreference='Stop'
if(-not $IsWindows -or $env:GITHUB_ACTIONS -cne 'true'){throw 'consumer_remote_entry_only'}
if($TaskId -cnotmatch '^[A-Z0-9_]{8,64}$' -or $HelperManifestSHA256 -cnotmatch '^[a-f0-9]{64}$'){throw 'consumer_entry_identity'}
$manifestPath=Join-Path $PSScriptRoot 'helper-manifest.json'
if((Get-FileHash -LiteralPath $manifestPath).Hash.ToLowerInvariant() -cne $HelperManifestSHA256){throw 'consumer_entry_manifest_identity'}
$manifest=Get-Content -LiteralPath $manifestPath -Raw|ConvertFrom-Json
if($manifest.files.Count -gt 64 -or $manifest.schema -ne 1){throw 'consumer_entry_manifest_schema'}
foreach($item in $manifest.files){
 if($item.path -cnotmatch '^[A-Za-z0-9_.-]+$'){throw 'consumer_entry_file_path'}
 $p=Join-Path $PSScriptRoot $item.path
 if((Get-Item -LiteralPath $p).Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'consumer_entry_file_link'}
 if((Get-FileHash -LiteralPath $p).Hash.ToLowerInvariant() -cne $item.sha256){throw 'consumer_entry_file_identity'}
}
. (Join-Path $PSScriptRoot 'desktop-guard.ps1')
$desktop=Get-RemoteDesktopAdmission
$desktopPath=Join-Path $env:RUNNER_TEMP ($TaskId+'-desktop.json')
$stream=[IO.File]::Open($desktopPath,[IO.FileMode]::CreateNew)
try{$bytes=[Text.Encoding]::UTF8.GetBytes(($desktop|ConvertTo-Json));$stream.Write($bytes,0,$bytes.Length)}finally{$stream.Dispose()}
$argsForConsumer=@{TaskId=$TaskId;TransferGrantId=$TransferGrantId;DependencyGrantId=$DependencyGrantId;NativeSetupGrantId=$NativeSetupGrantId;
 WebViewPolicyGrantId=$WebViewPolicyGrantId;HelperManifestSHA256=$HelperManifestSHA256;ReservedGrowthMiB=0;ReservedCommitMiB=0}
if(-not $desktop.interactive){$argsForConsumer.StaticOnly=$true}
& (Join-Path $PSScriptRoot 'consumer.ps1') @argsForConsumer
if(-not $desktop.interactive){
 throw 'consumer_native_blocked_static_artifact_closure_only'
}
