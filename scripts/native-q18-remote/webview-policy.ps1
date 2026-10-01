# Prepared remote-only HKLM64 per-app lease. Offline tests inject an in-memory store.
function Get-Q18PolicyAdmission([object]$Token){
 $valid=$Token.querySucceeded -ceq $true -and $Token.elevated -is [bool] -and $Token.integrityRID -is [int]
 $standard=$valid -and -not $Token.elevated -and $Token.integrityRID -in @(0x2000,0x2100)
 $high=$valid -and $Token.elevated -and $Token.integrityRID -eq 0x3000
 [ordered]@{querySucceeded=[bool]$valid;elevated=$Token.elevated;integrityRID=$Token.integrityRID;
  envOverrideLaunchAdmitted=[bool]$standard;policyLaunchAdmitted=[bool]($standard -or $high);
  elevationExplainsEnvRisk=[bool]$high;causeProven=$false;
  reason=$(if($high){'HIGH_TOKEN_HKLM_PATH_REQUIRED'}elseif($standard){'STANDARD_TOKEN_HKLM_PATH_SUPPORTED'}else{'TOKEN_UNPROVEN_OR_UNSUPPORTED'});
  launchMode='HKLM64_PER_APP_POLICY';nativeAcceptance='UNRUN'}
}
function New-Q18PolicyPlan([string]$TaskId,[string]$GrantId,[string]$RunRoot,[string]$Profile){
 if($TaskId -cnotmatch '^FRESH2_CI488_[0-9]+_[0-9]+$' -or $GrantId -cnotmatch '^ROOT02_Q18R6_WEBVIEW_POLICY_[A-Z0-9_]{8,64}$'){throw 'consumer_policy_explicit_grant_required'}
 $root=[IO.Path]::GetFullPath($RunRoot)
 if((Split-Path $root -Leaf) -cne $TaskId -or [IO.Path]::GetFullPath($Profile) -cne (Join-Path $root 'webview')){throw 'consumer_policy_profile_scope'}
 $rows=@()
 foreach($property in @('AdditionalBrowserArguments','UserDataFolder')){
  foreach($appID in @('ai.jarvis.desktop','jarvis.exe')){
   $value=if($property -ceq 'UserDataFolder'){$Profile}else{'--remote-debugging-address=127.0.0.1 --remote-debugging-port=9228'}
   $rows+=@([ordered]@{property=$property;appID=$appID;value=$value;writeAttempted=$false})
  }
 }
 [ordered]@{schema=1;taskId=$TaskId;grantId=$GrantId;runRoot=$root;profile=$Profile;rows=$rows;createdKeys=@();state='PREPARED'}
}
function Install-Q18PolicyLease([object]$Lease,[object]$Store,[scriptblock]$Journal){
 foreach($row in $Lease.rows){if((& $Store.Read $row.property $row.appID).exists){throw 'consumer_policy_preexisting_value'}}
 foreach($property in @('AdditionalBrowserArguments','UserDataFolder')){
  if(-not (& $Store.KeyExists $property)){$Lease.createdKeys+=@($property)}
 }
 & $Journal $Lease
 foreach($row in $Lease.rows){
  if((& $Store.Read $row.property $row.appID).exists){throw 'consumer_policy_value_race'}
  # Journal BEFORE the write, so a partial write can be compared and removed on failure.
  $row.writeAttempted=$true;& $Journal $Lease
  & $Store.Write $row.property $row.appID $row.value
  $actual=& $Store.Read $row.property $row.appID
  if(-not $actual.exists -or $actual.kind -cne 'String' -or $actual.value -cne $row.value){throw 'consumer_policy_readback_failed'}
 }
 $Lease.state='INSTALLED';& $Journal $Lease
 [ordered]@{launchMode='HKLM64_PER_APP_POLICY';ownedValueCount=4;readbackMatches=$true;
  perAppOnly=$true;envOverridesOmitted=$true;nativeAcceptance='UNRUN'}
}
function Remove-Q18PolicyLease([object]$Lease,[object]$Store){
 $removed=0;$absent=0;$changed=0;$errors=0;$emptyKeysRemoved=0
 foreach($row in $Lease.rows|Where-Object{$_.writeAttempted}){
  try{
   $actual=& $Store.Read $row.property $row.appID
   if(-not $actual.exists){$absent++;continue}
   if($actual.kind -cne 'String' -or $actual.value -cne $row.value){$changed++;continue}
   & $Store.Delete $row.property $row.appID $row.value
   if((& $Store.Read $row.property $row.appID).exists){$errors++}else{$removed++}
  }catch{$errors++}
 }
 foreach($property in $Lease.createdKeys){
  try{if(& $Store.DeleteEmptyKey $property){$emptyKeysRemoved++}}catch{$errors++}
 }
 [ordered]@{removed=$removed;alreadyAbsent=$absent;foreignChangesPreserved=$changed;errors=$errors;
  emptyOwnedKeysRemoved=$emptyKeysRemoved;restored=($changed -eq 0 -and $errors -eq 0);nativeAcceptance='UNRUN'}
}
function Get-RemoteQ18PolicyStore {
 # Hard-coded scope. No general registry path/target input is accepted.
 $basePath='Software\Policies\Microsoft\Edge\WebView2'
 $read={param($property,$name)
  $base=[Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::LocalMachine,[Microsoft.Win32.RegistryView]::Registry64)
  try{$key=$base.OpenSubKey($basePath+'\'+$property,$false);if(-not $key){return @{exists=$false}}
   try{if($name -notin $key.GetValueNames()){return @{exists=$false}}
    return @{exists=$true;kind=$key.GetValueKind($name).ToString();value=$key.GetValue($name,$null,[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)}
   }finally{$key.Dispose()}
  }finally{$base.Dispose()}
 }.GetNewClosure()
 $keyExists={param($property)
  $base=[Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::LocalMachine,[Microsoft.Win32.RegistryView]::Registry64)
  try{$key=$base.OpenSubKey($basePath+'\'+$property,$false);if($key){$key.Dispose();return $true};return $false}finally{$base.Dispose()}
 }.GetNewClosure()
 $write={param($property,$name,$value)
  $base=[Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::LocalMachine,[Microsoft.Win32.RegistryView]::Registry64)
  try{$key=$base.CreateSubKey($basePath+'\'+$property,$true)
   try{if($name -in $key.GetValueNames()){throw 'consumer_policy_value_race'}
    $key.SetValue($name,$value,[Microsoft.Win32.RegistryValueKind]::String);$key.Flush()
   }finally{$key.Dispose()}
  }finally{$base.Dispose()}
 }.GetNewClosure()
 $delete={param($property,$name,$expected)
  $base=[Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::LocalMachine,[Microsoft.Win32.RegistryView]::Registry64)
  try{$key=$base.OpenSubKey($basePath+'\'+$property,$true);if(-not $key){return}
   try{if($name -notin $key.GetValueNames()){return}
    if($key.GetValueKind($name) -ne [Microsoft.Win32.RegistryValueKind]::String -or $key.GetValue($name) -cne $expected){throw 'consumer_policy_cleanup_race'}
    $key.DeleteValue($name,$false);$key.Flush()
   }finally{$key.Dispose()}
  }finally{$base.Dispose()}
 }.GetNewClosure()
 # Never delete a shared registry key; empty schema keys may remain on the disposable VM.
 $deleteEmpty={param($property)return $false}
 [pscustomobject]@{Read=$read;KeyExists=$keyExists;Write=$write;Delete=$delete;DeleteEmptyKey=$deleteEmpty}
}
function Assert-RemoteQ18PolicyContext([string]$TaskId,[string]$GrantId){
 if(-not $IsWindows -or $env:GITHUB_ACTIONS -cne 'true' -or $env:RUNNER_ENVIRONMENT -cne 'github-hosted'){throw 'consumer_policy_ephemeral_hosted_runner_only'}
 if($TaskId -cne ('FRESH2_CI488_'+$env:GITHUB_RUN_ID+'_'+$env:GITHUB_RUN_ATTEMPT) -or $GrantId -cnotmatch '^ROOT02_Q18R6_WEBVIEW_POLICY_[A-Z0-9_]{8,64}$'){throw 'consumer_policy_run_bound_grant_required'}
}
function Install-RemoteQ18Policy([string]$TaskId,[string]$GrantId,[string]$RunRoot,[string]$Profile){
 Assert-RemoteQ18PolicyContext $TaskId $GrantId
 if([IO.Path]::GetFullPath($RunRoot) -cne [IO.Path]::GetFullPath((Join-Path $env:RUNNER_TEMP $TaskId))){throw 'consumer_policy_task_root'}
 if(@(Get-Process -Name jarvis -ErrorAction SilentlyContinue).Count){throw 'consumer_policy_foreign_jarvis_present'}
 $lease=New-Q18PolicyPlan $TaskId $GrantId $RunRoot $Profile
 $script:q18PolicyLease=$lease
 $path=Join-Path $RunRoot 'webview-policy-lease.private.json'
 if(Test-Path -LiteralPath $path){throw 'consumer_policy_existing_lease'}
 $stream=[IO.File]::Open($path,[IO.FileMode]::CreateNew);$stream.Dispose()
 $journal={param($value)[IO.File]::WriteAllText($path,($value|ConvertTo-Json -Depth 8),[Text.UTF8Encoding]::new($false))}.GetNewClosure()
 Install-Q18PolicyLease $lease (Get-RemoteQ18PolicyStore) $journal
}
function Remove-RemoteQ18Policy([string]$TaskId,[string]$GrantId,[object]$Lease){
 Assert-RemoteQ18PolicyContext $TaskId $GrantId
 if(-not $Lease -or $Lease.taskId -cne $TaskId -or $Lease.grantId -cne $GrantId){throw 'consumer_policy_cleanup_identity'}
 $plan=New-Q18PolicyPlan $TaskId $GrantId $Lease.runRoot $Lease.profile
 if($Lease.rows.Count -ne 4){throw 'consumer_policy_cleanup_scope'}
 for($i=0;$i -lt 4;$i++){
  if($Lease.rows[$i].property -cne $plan.rows[$i].property -or $Lease.rows[$i].appID -cne $plan.rows[$i].appID -or
   $Lease.rows[$i].value -cne $plan.rows[$i].value -or $Lease.rows[$i].writeAttempted -isnot [bool]){throw 'consumer_policy_cleanup_scope'}
 }
 Remove-Q18PolicyLease $Lease (Get-RemoteQ18PolicyStore)
}
