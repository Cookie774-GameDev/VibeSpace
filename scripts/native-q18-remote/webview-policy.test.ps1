# In-memory registry only. Never call real store, remote installer or token probe.
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'webview-policy.ps1')
$count=0
function New-TestStore {
 $state=@{values=@{};writes=0;failWrite=0;wrongReadback=$false;deleteRace=$false}
 $read={param($property,$name)
  $key=($property+'/'+$name).ToLowerInvariant()
  if(-not $state.values.ContainsKey($key)){return @{exists=$false}}
  @{exists=$true;kind='String';value=$(if($state.wrongReadback -and $state.writes -gt 0){'FOREIGN'}else{$state.values[$key]})}
 }.GetNewClosure()
 $write={param($property,$name,$value)
  $state.writes++;if($state.failWrite -eq $state.writes){throw 'synthetic_write_failure'}
  $state.values[($property+'/'+$name).ToLowerInvariant()]=$value
 }.GetNewClosure()
 $delete={param($property,$name,$expected)
  if($state.deleteRace){throw 'synthetic_race'}
  $state.values.Remove(($property+'/'+$name).ToLowerInvariant())
 }.GetNewClosure()
 [pscustomobject]@{state=$state;Read=$read;Write=$write;Delete=$delete;KeyExists={param($p)$true};DeleteEmptyKey={param($p)$false}}
}
function New-TestPlan {New-Q18PolicyPlan 'FRESH2_CI488_100_1' 'ROOT02_Q18R6_WEBVIEW_POLICY_OFFLINE_FIXTURE' 'C:\temp\FRESH2_CI488_100_1' 'C:\temp\FRESH2_CI488_100_1\webview'}
$noop={param($l)}
$s=New-TestStore;$l=New-TestPlan
$r=Install-Q18PolicyLease $l $s $noop
if($s.state.values.Count -ne 4 -or -not $r.readbackMatches){throw 'install_readback'};$count++
if(@($l.rows|Where-Object{$_.appID -eq '*' -or $_.property -notin @('AdditionalBrowserArguments','UserDataFolder')}).Count){throw 'scope'};$count++
$r=Remove-Q18PolicyLease $l $s
if(-not $r.restored -or $r.removed -ne 4 -or $s.state.values.Count){throw 'restore_exact'};$count++
$r=Remove-Q18PolicyLease $l $s
if(-not $r.restored -or $r.alreadyAbsent -ne 4){throw 'idempotent_restore'};$count++
$s=New-TestStore;$l=New-TestPlan;$s.state.values['additionalbrowserarguments/jarvis.exe']='PREEXISTING'
$caught=$null;try{Install-Q18PolicyLease $l $s $noop}catch{$caught=$_.Exception.Message}
if($caught -cne 'consumer_policy_preexisting_value' -or $s.state.writes -ne 0){throw 'preexisting_preserved'};$count++
$s=New-TestStore;$l=New-TestPlan;$s.state.values['additionalbrowserarguments/JARVIS.EXE'.ToLowerInvariant()]='PREEXISTING'
$caught=$null;try{Install-Q18PolicyLease $l $s $noop}catch{$caught=$_.Exception.Message}
if($caught -cne 'consumer_policy_preexisting_value' -or $s.state.writes){throw 'case_insensitive_collision'};$count++
$s=New-TestStore;$l=New-TestPlan;$s.state.failWrite=3
try{Install-Q18PolicyLease $l $s $noop}catch{}
$r=Remove-Q18PolicyLease $l $s
if(-not $r.restored -or $r.removed -ne 2 -or $r.alreadyAbsent -ne 1 -or $s.state.values.Count){throw 'partial_install_restore'};$count++
$s=New-TestStore;$l=New-TestPlan;$s.state.wrongReadback=$true
$caught=$null;try{Install-Q18PolicyLease $l $s $noop}catch{$caught=$_.Exception.Message}
if($caught -cne 'consumer_policy_readback_failed'){throw 'readback_failure'};$count++
$s=New-TestStore;$l=New-TestPlan;$null=Install-Q18PolicyLease $l $s $noop
$s.state.values['userdatafolder/jarvis.exe']='FOREIGN'
$r=Remove-Q18PolicyLease $l $s
if($r.restored -or $r.foreignChangesPreserved -ne 1 -or $s.state.values['userdatafolder/jarvis.exe'] -cne 'FOREIGN'){throw 'foreign_cleanup_preserved'};$count++
$s=New-TestStore;$l=New-TestPlan;$null=Install-Q18PolicyLease $l $s $noop;$s.state.deleteRace=$true
$r=Remove-Q18PolicyLease $l $s
if($r.restored -or $r.errors -ne 4 -or $s.state.values.Count -ne 4){throw 'cleanup_race'};$count++
foreach($bad in @(
 @('FRESH2_CI488_100_1','FORGED','C:\temp\FRESH2_CI488_100_1','C:\temp\FRESH2_CI488_100_1\webview'),
 @('OTHER','ROOT02_Q18R6_WEBVIEW_POLICY_OFFLINE_FIXTURE','C:\temp\OTHER','C:\temp\OTHER\webview'),
 @('FRESH2_CI488_100_1','ROOT02_Q18R6_WEBVIEW_POLICY_OFFLINE_FIXTURE','C:\temp\OTHER','C:\temp\OTHER\webview'),
 @('FRESH2_CI488_100_1','ROOT02_Q18R6_WEBVIEW_POLICY_OFFLINE_FIXTURE','C:\temp\FRESH2_CI488_100_1','C:\foreign')
)){
 $caught=$false;try{New-Q18PolicyPlan $bad[0] $bad[1] $bad[2] $bad[3]}catch{$caught=$true}
 if(-not $caught){throw 'identity_scope_guard'};$count++
}
foreach($c in @(
 @($true,$false,0x2000,$true,$true,$false),
 @($true,$true,0x3000,$true,$false,$true),
 @($true,$true,0x4000,$false,$false,$false),
 @($false,$false,0x2000,$false,$false,$false),
 @($true,$false,0x3000,$false,$false,$false)
)){
 $r=Get-Q18PolicyAdmission @{querySucceeded=$c[0];elevated=$c[1];integrityRID=$c[2]}
 if($r.policyLaunchAdmitted -cne $c[3] -or $r.envOverrideLaunchAdmitted -cne $c[4] -or $r.elevationExplainsEnvRisk -cne $c[5] -or $r.causeProven){throw 'elevation_discriminator'};$count++
}
[ordered]@{tests=$count;passed=$count;failed=0;skipped=0;
 scope='In-memory registry lease/readback/rollback/CAS/scope + elevation discrimination; actual registry/native/token probes UNRUN'}|
 ConvertTo-Json|Set-Content -LiteralPath (Join-Path $PSScriptRoot 'policy-regression.json') -Encoding utf8
Get-Content -LiteralPath (Join-Path $PSScriptRoot 'policy-regression.json')
