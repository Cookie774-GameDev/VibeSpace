$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'lifecycle.ps1')
$rows=@(
 [pscustomobject]@{pid=100;parentPid=1;bornMs=1000},
 [pscustomobject]@{pid=200;parentPid=100;bornMs=1100},
 [pscustomobject]@{pid=300;parentPid=200;bornMs=1200},
 [pscustomobject]@{pid=400;parentPid=100;bornMs=500},
 [pscustomobject]@{pid=500;parentPid=999;bornMs=1300},
 [pscustomobject]@{pid=600;parentPid=600;bornMs=1300}
)
$count=0
if(@(Get-OwnedDescendantIdentities $rows 100 1000).Count -ne 3){throw 'owned_descendant_closure'};$count++
if(@(Get-OwnedDescendantIdentities $rows 100 1001).Count){throw 'root_pid_reuse'};$count++
if(@(Get-OwnedDescendantIdentities $rows 999 1000).Count){throw 'absent_root'};$count++
if(@(Get-OwnedDescendantIdentities $rows 200 1100).Count -ne 2){throw 'nested_root'};$count++
if(Test-OwnedBirth 100 1001 100 1000){throw 'birth_reuse_guard'};$count++
if(Test-OwnedBirth 101 1000 100 1000){throw 'pid_changed_guard'};$count++
if(-not(Test-OwnedBirth 100 1000 100 1000)){throw 'exact_birth_guard'};$count++
$failed=$false
try {Get-OwnedDescendantIdentities @($rows[0],$rows[0]) 100 1000 | Out-Null} catch {$failed=$true}
if(-not $failed){throw 'duplicate_pid_guard'};$count++
[ordered]@{tests=$count;passed=$count;failed=0;skipped=0;scope='Pure PID-birth tree selection; no process query/kill/native/UI'}|ConvertTo-Json -Compress
