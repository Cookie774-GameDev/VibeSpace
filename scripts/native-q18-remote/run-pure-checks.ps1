param([Parameter(Mandatory)][string]$GrantId,
  [Parameter(Mandatory)][ValidateRange(0,1048576)][double]$ReservedGrowthMiB,
  [Parameter(Mandatory)][ValidateRange(0,1048576)][double]$ReservedCommitMiB)
$ErrorActionPreference = 'Stop'
if ($GrantId -cne 'ROOT02-FRESH2NS01-PURE-R1') { throw 'Exact ROOT pure-test grant required.' }
$expected = 'C:\Users\viper\VibeSpace-UnifiedChungus-Final\work\native-windows-smoke-20261001-FRESH2'
if ($PSScriptRoot -cne $expected) { throw 'Unexpected test scope.' }
$evidence = Join-Path $PSScriptRoot 'pure-R1'
if (Test-Path -LiteralPath $evidence) { throw 'Refuse existing test attempt.' }
New-Item -ItemType Directory -Path $evidence | Out-Null
$drive = [IO.DriveInfo]::new([IO.Path]::GetPathRoot($PSScriptRoot))
if ($drive.AvailableFreeSpace -lt 1094713344) { throw 'Pure-test disk reserve failed.' }
$python = 'C:/Users/viper/AppData/Local/Programs/Python/Python312/python.exe'
$preflight = 'C:/Users/viper/.codex/skills/safe-fast-fix/scripts/heavy_job_preflight.py'
& $python -B $preflight --peak-mib 512 --commit-peak-mib 512 --reserved-growth-mib $ReservedGrowthMiB --reserved-commit-mib $ReservedCommitMiB > (Join-Path $evidence 'admission.json')
if ($LASTEXITCODE -ne 0) { throw 'Fresh pure-test RAM/commit admission failed.' }
$node = (Get-Command node -ErrorAction Stop).Source
$info = [Diagnostics.ProcessStartInfo]::new($node)
$info.WorkingDirectory = $PSScriptRoot
$info.UseShellExecute = $false
$info.CreateNoWindow = $true
$info.RedirectStandardOutput = $true
$info.RedirectStandardError = $true
foreach ($a in @('--max-old-space-size=64','--test','--test-concurrency=1','contract.test.mjs')) { $info.ArgumentList.Add($a) }
$process = [Diagnostics.Process]::new()
$process.StartInfo = $info
if (-not $process.Start()) { throw 'Owned pure-test child failed to start.' }
$pidOwned = $process.Id
$born = $process.StartTime.ToUniversalTime().ToString('o')
$stdout = $process.StandardOutput.ReadToEndAsync()
$stderr = $process.StandardError.ReadToEndAsync()
$finished = $process.WaitForExit(30000)
if (-not $finished) { $process.Kill($true); $process.WaitForExit(5000) | Out-Null }
$out = $stdout.GetAwaiter().GetResult()
$err = $stderr.GetAwaiter().GetResult()
if ($out.Length + $err.Length -gt 1048576) { throw 'Pure-test log budget exceeded.' }
[IO.File]::WriteAllText((Join-Path $evidence 'test.log'),$out + $err)
[ordered]@{ grantId=$GrantId; pid=$pidOwned; bornUTC=$born; startedAtUTC=$born;
  finishedAtUTC=[DateTime]::UtcNow.ToString('o'); timedOut=(-not $finished); exitCode=$process.ExitCode;
  command=$node; argv=@('--max-old-space-size=64','--test','--test-concurrency=1','contract.test.mjs');
  scope='Pure contract only; no driver/Playwright/browser/native/Cargo/source mutation' } |
  ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $evidence 'terminal.json') -Encoding utf8
if (-not $finished -or $process.ExitCode -ne 0) { throw 'Pure contract check failed.' }
Write-Output $out
