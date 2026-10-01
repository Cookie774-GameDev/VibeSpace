param([Parameter(Mandatory)][string]$GrantId,
 [Parameter(Mandatory)][ValidateRange(0,1048576)][double]$ReservedGrowthMiB,
 [Parameter(Mandatory)][ValidateRange(0,1048576)][double]$ReservedCommitMiB)
$ErrorActionPreference='Stop'
if($GrantId -cne 'ROOT02-FRESH2NS01-PURE-R2'){throw 'Exact preparation-test grant required.'}
$expected='C:\Users\viper\VibeSpace-UnifiedChungus-Final\work\native-windows-smoke-20261001-FRESH2'
if($PSScriptRoot -cne $expected){throw 'Unexpected pure-test scope.'}
$out=Join-Path $PSScriptRoot 'pure-R2'
if(Test-Path -LiteralPath $out){throw 'Refuse existing test attempt.'}
New-Item -ItemType Directory -Path $out|Out-Null
$drive=[IO.DriveInfo]::new([IO.Path]::GetPathRoot($out))
if($drive.AvailableFreeSpace -lt 1094713344){throw 'Pure-test disk reserve failed.'}
$python='C:/Users/viper/AppData/Local/Programs/Python/Python312/python.exe'
$preflight='C:/Users/viper/.codex/skills/safe-fast-fix/scripts/heavy_job_preflight.py'
$pwsh=(Get-Command pwsh).Source
$jobs=@(
 @{name='commandline';command=$pwsh;args=@('-NoProfile','-NonInteractive','-File',(Join-Path $PSScriptRoot 'commandline.test.ps1'))},
 @{name='lifecycle';command=$pwsh;args=@('-NoProfile','-NonInteractive','-File',(Join-Path $PSScriptRoot 'lifecycle.test.ps1'))},
 @{name='transfer';command=$python;args=@('-B',(Join-Path $PSScriptRoot 'transfer.test.py'))}
)
foreach($job in $jobs){
 & $python -B $preflight --peak-mib 512 --commit-peak-mib 512 --reserved-growth-mib $ReservedGrowthMiB --reserved-commit-mib $ReservedCommitMiB > (Join-Path $out ($job.name+'-admission.json'))
 if($LASTEXITCODE -ne 0){throw 'Fresh pure-test preflight failed.'}
 $info=[Diagnostics.ProcessStartInfo]::new($job.command)
 $info.WorkingDirectory=$PSScriptRoot;$info.UseShellExecute=$false;$info.CreateNoWindow=$true
 $info.RedirectStandardOutput=$true;$info.RedirectStandardError=$true
 foreach($a in $job.args){$info.ArgumentList.Add($a)}
 $p=[Diagnostics.Process]::new();$p.StartInfo=$info
 if(-not $p.Start()){throw 'Owned pure child failed to start.'}
 $childPID=$p.Id;$born=$p.StartTime.ToUniversalTime()
 $stdout=$p.StandardOutput.ReadToEndAsync();$stderr=$p.StandardError.ReadToEndAsync()
 $done=$p.WaitForExit(30000)
 if(-not $done){if($p.Id -ne $childPID -or $p.StartTime.ToUniversalTime() -ne $born){throw 'Owned pure child changed.'};$p.Kill($true);[void]$p.WaitForExit(5000)}
 $text=$stdout.GetAwaiter().GetResult()+$stderr.GetAwaiter().GetResult()
 if($text.Length -gt 1048576){throw 'Pure log budget failed.'}
 [IO.File]::WriteAllText((Join-Path $out ($job.name+'.log')),$text)
 [ordered]@{grantId=$GrantId;name=$job.name;pid=$childPID;bornUTC=$born.ToString('o');finishedUTC=[DateTime]::UtcNow.ToString('o');
  command=$job.command;argv=$job.args;timedOut=(-not $done);exitCode=$p.ExitCode;scope='Pure parsing/metadata/path/PID-birth fixtures only; no network/process query/native/UI/install/driver'}|
  ConvertTo-Json -Depth 6|Set-Content -LiteralPath (Join-Path $out ($job.name+'-terminal.json')) -Encoding utf8
 Write-Output $text
 if(-not $done -or $p.ExitCode -ne 0){throw 'Owned pure fixture failed; later fixtures not started.'}
}
