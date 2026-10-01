. (Join-Path $PSScriptRoot 'commandline.ps1')
function Get-CdpFlagFacts([string]$CommandLine,[string]$Profile,[int]$Port){
 if($CommandLine.Length -gt 32768){throw 'consumer_cdp_command_budget'}
 $parsed=Test-WebViewArguments $CommandLine $Profile $Port
 $ports=[regex]::Matches($CommandLine,'(?:^|\s)--remote-debugging-port(?:=|\s+)([0-9]+)(?=\s|$)')
 $kind='Browser'
 $types=[regex]::Matches($CommandLine,'(?:^|\s)--type=([a-z-]+)(?=\s|$)')
 if($types.Count){
  $kind='Unknown'
  if($types.Count -eq 1 -and $types[0].Groups[1].Value -cin @('renderer','gpu-process','utility','crashpad-handler')){$kind=$types[0].Groups[1].Value}
 }
 $different=$false;$zero=$false
 foreach($p in $ports){$v=0;if([int]::TryParse($p.Groups[1].Value,[ref]$v)){$different=$different -or $v -ne $Port;$zero=$zero -or $v -eq 0}}
 [ordered]@{kind=$kind;commandLineAvailable=(-not [string]::IsNullOrWhiteSpace($CommandLine));profileMatches=$parsed.profileMatches;expectedPortMatches=$parsed.portMatches;
  portSwitchCount=[int]$ports.Count;differentPortRequested=$different;zeroPortRequested=$zero;rawCommandLineExported=$false}
}
function Get-OwnedCdpDiagnostic([object]$Root,[object[]]$Processes,[object[]]$Listeners,[string]$Profile,[int]$Port){
 $ids=@(Get-OwnedDescendantIdentities $Processes $Root.pid $Root.bornMs)
 $byPid=@{};foreach($p in $Processes){$byPid[[int]$p.pid]=$p}
 $views=@($ids|Where-Object{$byPid[[int]$_.pid].name -ieq 'msedgewebview2.exe'})
 $rows=@()
 foreach($id in @($views|Select-Object -First 32)){
  $p=$byPid[[int]$id.pid]
  $flags=Get-CdpFlagFacts ([string]$p.commandLine) $Profile $Port
  $ownListeners=@($Listeners|Where-Object{$_.ownerPid -eq $id.pid})
  $expected=@($ownListeners|Where-Object{$_.port -eq $Port -and $_.address -in @('127.0.0.1','::1')}).Count
  $otherLoopback=@($ownListeners|Where-Object{$_.port -ne $Port -and $_.address -in @('127.0.0.1','::1')}).Count
  $nonLoopback=@($ownListeners|Where-Object{$_.address -notin @('127.0.0.1','::1')}).Count
  $rows+=@([ordered]@{pid=[int]$id.pid;bornMs=[long]$id.bornMs;kind=$flags.kind;commandLineAvailable=$flags.commandLineAvailable;profileMatches=$flags.profileMatches;
   expectedPortMatches=$flags.expectedPortMatches;portSwitchCount=$flags.portSwitchCount;differentPortRequested=$flags.differentPortRequested;
   zeroPortRequested=$flags.zeroPortRequested;expectedLoopbackListeners=[int]$expected;otherLoopbackListenerCount=[int]$otherLoopback;
   nonLoopbackListenerCount=[int]$nonLoopback})
 }
 [ordered]@{ownedWebViewCount=[int]$views.Count;rows=$rows;rowsTruncated=($views.Count -gt 32);nativeAcceptance='UNRUN';
  scope='Own PID-birth descendants only; fixed classifications/boolean/counts, no raw argv/URL/profile path/other endpoints'}
}
function Get-CdpPolicyValueFact([object]$Value,[int[]]$Allowed){
 $present=$null -ne $Value
 $valid=$present -and ($Value -is [int] -or $Value -is [long]) -and $Value -in $Allowed
 [ordered]@{present=$present;recognizedEnum=$valid;value=$(if($valid){[int]$Value}else{$null})}
}
function Get-RemoteCdpPolicyFacts {
 if(-not $IsWindows -or $env:GITHUB_ACTIONS -cne 'true'){throw 'consumer_cdp_policy_remote_only'}
 $facts=@()
 foreach($hive in @('HKLM','HKCU')){
  foreach($product in @('Edge','Edge\WebView2')){
   $key=$hive+':\Software\Policies\Microsoft\'+$product
   foreach($property in @('DeveloperToolsAvailability','RemoteDebuggingAllowed')){
    $value=$null;$queryFailed=$false
    try{$value=(Get-ItemProperty -LiteralPath $key -Name $property -ErrorAction Stop).$property}
    catch{if($_.CategoryInfo.Category -ne [Management.Automation.ErrorCategory]::ObjectNotFound){$queryFailed=$true}}
    $allowed=if($property -ceq 'DeveloperToolsAvailability'){@(0,1,2)}else{@(0,1)}
    $fact=Get-CdpPolicyValueFact $value $allowed
    $facts+=@([ordered]@{hive=$hive;product=$(if($product -ceq 'Edge'){'Edge'}else{'WebView2'});property=$property;
     present=$fact.present;recognizedEnum=$fact.recognizedEnum;value=$fact.value;queryFailed=$queryFailed})
   }
  }
 }
 return $facts
}
function Get-CdpLaunchRequestFacts([object]$Environment,[string]$Profile,[int]$Port){
 [ordered]@{requestedPort=$Port;
  debugArgumentsMatch=($Environment['WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS'] -ceq "--remote-debugging-address=127.0.0.1 --remote-debugging-port=$Port");
  profileMatches=($Environment['WEBVIEW2_USER_DATA_FOLDER'] -ceq $Profile);
  githubTokenPresent=($null -ne $Environment['GITHUB_TOKEN']);
  scope='ProcessStartInfo request only; runtime adoption unverified'}
}
function Get-RemoteOwnedCdpSnapshot([object]$Root,[string]$Profile,[int]$Port){
 if(-not $IsWindows -or $env:GITHUB_ACTIONS -cne 'true'){throw 'consumer_cdp_probe_remote_only'}
 $processes=@(Get-CimInstance Win32_Process -OperationTimeoutSec 2 -ErrorAction Stop|
  ForEach-Object{[pscustomobject]@{pid=[int]$_.ProcessId;parentPid=[int]$_.ParentProcessId;
   bornMs=([DateTimeOffset]$_.CreationDate.ToUniversalTime()).ToUnixTimeMilliseconds();name=$_.Name;commandLine=$_.CommandLine}})
 if($processes.Count -gt 4096){throw 'consumer_cdp_process_budget'}
 $connections=@(Get-NetTCPConnection -State Listen -ErrorAction Stop)
 if($connections.Count -gt 8192){throw 'consumer_cdp_listener_budget'}
 $listeners=@($connections|ForEach-Object{[pscustomobject]@{ownerPid=[int]$_.OwningProcess;port=[int]$_.LocalPort;address=$_.LocalAddress}})
 Get-OwnedCdpDiagnostic $Root $processes $listeners $Profile $Port
}
function Update-CdpDiagnostic([object]$Diagnostic,[long]$ElapsedMs,[object]$Facts,[bool]$ProbeFailed){
 $Diagnostic.probes++
 if($ProbeFailed){$Diagnostic.failedProbes++}
 $snapshot=[ordered]@{elapsedMs=$ElapsedMs;probeFailed=$ProbeFailed;facts=$Facts}
 if($null -eq $Diagnostic.first){$Diagnostic.first=$snapshot}
 $Diagnostic.last=$snapshot
}
