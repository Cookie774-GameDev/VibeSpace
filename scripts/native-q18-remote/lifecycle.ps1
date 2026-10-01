function Test-OwnedBirth {
 param([int]$ActualPid,[long]$ActualBornMs,[int]$ExpectedPid,[long]$ExpectedBornMs)
 $ActualPid -gt 0 -and $ActualBornMs -gt 0 -and $ActualPid -eq $ExpectedPid -and $ActualBornMs -eq $ExpectedBornMs
}
function Get-OwnedDescendantIdentities {
 param([object[]]$Rows,[int]$RootPid,[long]$RootBornMs)
 if ($Rows.Count -gt 4096) {throw 'consumer_process_inventory_budget'}
 $map=@{}
 foreach($row in $Rows) {
  if($map.ContainsKey([int]$row.pid)){throw 'consumer_duplicate_process_pid'}
  $map[[int]$row.pid]=$row
 }
 $root=$map[$RootPid]
 if(-not $root -or -not (Test-OwnedBirth $root.pid $root.bornMs $RootPid $RootBornMs)){return @()}
 $result=[Collections.Generic.List[object]]::new()
 foreach($row in $Rows) {
  if($row.bornMs -lt $RootBornMs){continue}
  $cursor=$row
  $seen=[Collections.Generic.HashSet[int]]::new()
  for($depth=0;$depth -lt 32 -and $cursor;$depth++) {
   if(-not $seen.Add([int]$cursor.pid)){break}
   if($cursor.pid -eq $RootPid){$result.Add([ordered]@{pid=[int]$row.pid;bornMs=[long]$row.bornMs;depth=$depth});break}
   $cursor=$map[[int]$cursor.parentPid]
  }
 }
 if($result.Count -gt 512){throw 'consumer_owned_tree_budget'}
 return $result.ToArray()
}
