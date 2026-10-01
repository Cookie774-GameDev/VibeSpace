# Small offline regression only; no real npm/install/network/product/native calls.
param([Parameter(Mandatory)][ValidatePattern('^[A-Z0-9-]{2,32}$')][string]$Attempt)
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'dependency-launch.ps1')
$fixture=Join-Path $PSScriptRoot ('direct cli fixture-'+$Attempt)
if(Test-Path -LiteralPath $fixture){throw 'fixture_existing_attempt'}
New-Item -ItemType Directory -Path $fixture|Out-Null
$cli=Join-Path $fixture 'npm-cli.mjs'
[IO.File]::WriteAllText($cli,"if(JSON.stringify(process.argv.slice(2))!==JSON.stringify(['ci','--ignore-scripts','--no-audit','--no-fund']))process.exitCode=2;else console.log('FRESH2_DIRECT_PLAN_OK');")
$plan=Get-NpmLaunchPlan (Get-Command node).Source $cli
$p=[Diagnostics.Process]::new()
$p.StartInfo=[Diagnostics.ProcessStartInfo]::new($plan.command)
$p.StartInfo.UseShellExecute=$false;$p.StartInfo.CreateNoWindow=$true
$p.StartInfo.RedirectStandardOutput=$true;$p.StartInfo.RedirectStandardError=$true
$p.StartInfo.ArgumentList.Add('--max-old-space-size=16')
foreach($a in $plan.argv){$p.StartInfo.ArgumentList.Add($a)}
if(-not $p.Start()){throw 'fixture_start'}
$born=$p.StartTime.ToUniversalTime()
$out=$p.StandardOutput.ReadToEndAsync();$err=$p.StandardError.ReadToEndAsync()
if(-not $p.WaitForExit(2000)){$p.Kill($true);throw 'fixture_timeout'}
if($p.ExitCode -ne 0 -or $out.GetAwaiter().GetResult().Trim() -cne 'FRESH2_DIRECT_PLAN_OK' -or $err.GetAwaiter().GetResult().Length){throw 'direct_plan_argv_regression'}
$count=1
$private="npm error code EUSAGE"+[char]10+"Authorization: SYNTHETIC_PRIVATE_DO_NOT_EXPORT"+[char]10+"https://example.invalid/private?token=SYNTHETIC_PRIVATE_DO_NOT_EXPORT"
$d=Get-NpmDiagnostic $private 1 $false
if(@($d.errorCodes).Count -ne 1 -or $d.errorCodes[0] -cne 'EUSAGE'){throw 'npm_error_code_regression'};$count++
$safe=$d|ConvertTo-Json -Compress
if($safe.Contains('SYNTHETIC_PRIVATE_DO_NOT_EXPORT') -or $safe.Contains('https://') -or $safe.Contains('Authorization')){throw 'private_diagnostic_leak'};$count++
$d=Get-NpmDiagnostic "npm error code SECRET=https://example.invalid" 1 $false
if(@($d.errorCodes).Count){throw 'noncode_rejection'};$count++
$d=Get-NpmDiagnostic 'npm error code SYNTHETIC_PRIVATE_DO_NOT_EXPORT' 1 $false
if(@($d.errorCodes).Count -or -not $d.unknownErrorCodeObserved){throw 'unknown_code_rejection'};$count++
$big=[string]::new('x',1048580)
$d=Get-NpmDiagnostic $big -1 $true
if(-not $d.diagnosticTruncated -or @($d.errorCodes).Count -or -not $d.timedOut){throw 'diagnostic_budget'};$count++
[ordered]@{tests=$count;passed=$count;failed=0;skipped=0;nodeChildPID=$p.Id;bornUTC=$born.ToString('o');exitCode=$p.ExitCode;exited=$p.HasExited;
 scope='Offline harmless CLI argv with spaces and allowlisted diagnostic cases; no npm/install/network/native'}|ConvertTo-Json|
 Set-Content -LiteralPath (Join-Path $PSScriptRoot ('dependency-regression-'+$Attempt+'.json')) -Encoding utf8
Get-Content -LiteralPath (Join-Path $PSScriptRoot ('dependency-regression-'+$Attempt+'.json'))
