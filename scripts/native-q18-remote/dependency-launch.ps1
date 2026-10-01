function Get-NpmLaunchPlan([string]$NodePath,[string]$CliPath){
 if([string]::IsNullOrWhiteSpace($NodePath) -or [string]::IsNullOrWhiteSpace($CliPath)){throw 'consumer_npm_cli_identity'}
 [ordered]@{command=$NodePath;argv=@($CliPath,'ci','--ignore-scripts','--no-audit','--no-fund')}
}
function Get-NpmDiagnostic([string]$PrivateText,[int]$ExitCode,[bool]$TimedOut){
 # Export fixed-format codes only. No URLs, shell tokens, paths, messages or environment.
 $codes=[Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
 $allowed=@('EUSAGE','ELOCKVERIFY','EINTEGRITY','E401','E403','E404','ETARGET','ERESOLVE','ENOENT','ENOTFOUND','ETIMEDOUT','ECONNRESET','ECONNREFUSED','EAI_AGAIN','EPERM','EACCES','ENOSPC','ELIFECYCLE','EBADENGINE','ECANCELED')
 $unknown=$false
 $bounded=$PrivateText.Substring(0,[math]::Min($PrivateText.Length,1048576))
 foreach($m in [regex]::Matches($bounded,'(?m)^npm (?:error|ERR!) code ([A-Z][A-Z0-9_]{1,31})\r?$')){
  if($codes.Count -ge 8){break}
  if($m.Groups[1].Value -cin $allowed){[void]$codes.Add($m.Groups[1].Value)}else{$unknown=$true}
 }
 [ordered]@{exitCode=$ExitCode;timedOut=$TimedOut;errorCodes=@($codes|Sort-Object);
  privateTextCharacters=$PrivateText.Length;diagnosticTruncated=($PrivateText.Length -gt 1048576);
  unknownErrorCodeObserved=$unknown;
  launchMode='DIRECT_NODE_NPM_CLI';rawMessagesExported=$false;
  scope='Allowlisted npm error codes only; no raw diagnostics, URL, credentials, environment or registry config'}
}
