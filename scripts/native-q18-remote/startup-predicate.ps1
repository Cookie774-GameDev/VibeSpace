function Get-StartupWindowStyle([string]$Name){
 if($Name -ceq 'jarvis'){return [Diagnostics.ProcessWindowStyle]::Normal}
 return [Diagnostics.ProcessWindowStyle]::Hidden
}
function Get-StartupTargetFacts([object]$Response){
 # Enumerate rows from the REST response itself; do not wrap command output into a nested array.
 $rows=@($Response|ForEach-Object{$_})
 if($rows.Count -gt 64){throw 'consumer_startup_target_budget'}
 $main=0;$malformed=0
 foreach($row in $rows){
  if($null -eq $row -or $row -is [array] -or $row.type -isnot [string] -or $row.url -isnot [string]){$malformed++;continue}
  if($row.type -ceq 'page' -and $row.url -ceq 'http://localhost:5173/'){$main++}
 }
 [ordered]@{targetCount=$rows.Count;mainTargetCount=$main;malformedRows=$malformed;oneOfficialURL=($main -eq 1 -and $malformed -eq 0)}
}
function Add-StartupSnapshot([object]$Diagnostic,[object]$Snapshot){
 # Accept only fixed numeric/boolean predicate fields. Never export remote URLs, titles, errors or logs.
 $safe=[ordered]@{}
 foreach($key in @('elapsedMs','appAlive','viteAlive','cdpListenerCount','viteListenerOwnerMatches','viteHTTPResponded',
   'ancestryMatches','webviewNameMatches','runtimePathMatches','cdpQuerySucceeded','targetCount','mainTargetCount',
   'malformedTargetRows','oneOfficialURL','sessionMatches','hasWindowHandle','windowVisible','targetProcessingFailed','windowProbeFailed')){
  $value=$Snapshot[$key]
  if($null -ne $value -and $value -isnot [bool] -and $value -isnot [int] -and $value -isnot [long]){throw 'consumer_startup_diagnostic_type'}
  $safe[$key]=$value
 }
 $Diagnostic.last=$safe
 if($null -eq $Diagnostic.first){$Diagnostic.first=$safe}
 $comparison=[ordered]@{}
 foreach($key in $safe.Keys|Where-Object{$_ -ne 'elapsedMs'}){$comparison[$key]=$safe[$key]}
 $fingerprint=$comparison|ConvertTo-Json -Compress
 if($Diagnostic.lastFingerprint -cne $fingerprint){
  $Diagnostic.changedStates++
  if($Diagnostic.changes.Count -lt 16){$Diagnostic.changes.Add($safe)}
  $Diagnostic.lastFingerprint=$fingerprint
 }
}
