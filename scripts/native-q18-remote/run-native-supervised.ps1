# PROPOSED / UNRUN. Future ROOT-granted Windows-runner controller; never starts the product.
param([Parameter(Mandatory)][string]$SpecPath,
  [Parameter(Mandatory)][string]$RootGrantId,
  [Parameter(Mandatory)][ValidateRange(0,1048576)][double]$ReservedGrowthMiB,
  [Parameter(Mandatory)][ValidateRange(0,1048576)][double]$ReservedCommitMiB)
$ErrorActionPreference = 'Stop'
if (-not $IsWindows -or $env:GITHUB_ACTIONS -cne 'true') { throw 'smoke_future_windows_runner_only' }
if ((Get-Item -LiteralPath $SpecPath).Length -gt 1048576) { throw 'smoke_spec_budget' }
$s = Get-Content -LiteralPath $SpecPath -Raw | ConvertFrom-Json
if ($RootGrantId -cne $s.grantId -or $RootGrantId -cnotmatch '^ROOT[A-Za-z0-9_-]+$') { throw 'smoke_root_grant_mismatch' }
if ($s.taskId -cnotmatch '^[A-Z0-9_]{8,64}$' -or $s.totalMs -lt 1 -or $s.totalMs -gt 900000) { throw 'smoke_task_deadline' }
if ([IO.Path]::GetFullPath($s.workspace) -ine [IO.Path]::GetFullPath($env:GITHUB_WORKSPACE) -or [IO.Path]::GetFullPath($s.runnerTemp) -ine [IO.Path]::GetFullPath($env:RUNNER_TEMP)) { throw 'smoke_runner_scope' }
$out = Join-Path $env:RUNNER_TEMP ($s.taskId + '/supervisor')
if (Test-Path -LiteralPath $out) { throw 'smoke_existing_supervisor_attempt' }
$parent = Split-Path -Parent $out
if ((Get-Item -LiteralPath $parent).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'smoke_supervisor_link' }
New-Item -ItemType Directory -Path $out | Out-Null
$memory = Get-CimInstance Win32_PerfFormattedData_PerfOS_Memory
$requiredRAM = [math]::Ceiling(3584*1.25 + 1024 + $ReservedGrowthMiB)
$requiredCommit = [math]::Ceiling(4864*1.25 + 1024 + $ReservedCommitMiB)
$available = [double]$memory.AvailableMBytes
$commit = ([double]$memory.CommitLimit-[double]$memory.CommittedBytes)/1MB
$disk = @($s.workspace,$s.runnerTemp,$s.nativeDataPath | ForEach-Object {
  $drive = [IO.DriveInfo]::new([IO.Path]::GetPathRoot([IO.Path]::GetFullPath($_)))
  [ordered]@{ root=$drive.RootDirectory.FullName; availableBytes=$drive.AvailableFreeSpace; requiredBytes=8589934592 }
})
$admitted = $available -ge $requiredRAM -and $commit -ge $requiredCommit -and @($disk | Where-Object { $_.availableBytes -lt $_.requiredBytes }).Count -eq 0
[ordered]@{ admitted=$admitted; observedUTC=[DateTime]::UtcNow.ToString('o'); availableRAMMiB=$available; availableCommitMiB=$commit;
  requiredRAMMiB=$requiredRAM; requiredCommitMiB=$requiredCommit; disk=$disk; grantId=$RootGrantId;
  estimate='Unmeasured whole native tree3584WS4864private INCLUDING two default PTYs; not enforced containment or an install/build grant' } |
  ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $out 'admission.json') -Encoding utf8
if (-not $admitted) { throw 'smoke_fresh_native_admission_failed' }
$info = [Diagnostics.ProcessStartInfo]::new((Get-Command node).Source)
$info.WorkingDirectory = $PSScriptRoot
$info.UseShellExecute = $false
$info.CreateNoWindow = $true
$info.RedirectStandardOutput = $true
$info.RedirectStandardError = $true
[void]$info.Environment.Remove('DEBUG')
[void]$info.Environment.Remove('PWDEBUG')
[void]$info.Environment.Remove('NODE_OPTIONS')
foreach ($arg in @('--max-old-space-size=256',(Join-Path $PSScriptRoot 'driver.mjs'),'--execute-native',$SpecPath)) { $info.ArgumentList.Add($arg) }
$child = [Diagnostics.Process]::new()
$child.StartInfo = $info
if (-not $child.Start()) { throw 'smoke_owned_driver_start_failed' }
$ownedPid = $child.Id
$birth = $child.StartTime.ToUniversalTime()
$stdout = $child.StandardOutput.ReadToEndAsync()
$stderr = $child.StandardError.ReadToEndAsync()
$terminal = $child.WaitForExit([int]$s.totalMs)
if (-not $terminal) {
  if ($child.Id -ne $ownedPid -or $child.StartTime.ToUniversalTime() -ne $birth) { throw 'smoke_driver_birth_changed' }
  # Product/Vite processes predate this controller and are not its children.
  # Only this newly owned Node + its read-only attestation children are eligible.
  $child.Kill($true)
  [void]$child.WaitForExit(5000)
}
$exitCode = if ($child.HasExited) { $child.ExitCode } else { $null }
if ($child.HasExited) {
  $log = $stdout.GetAwaiter().GetResult() + $stderr.GetAwaiter().GetResult()
  if ($log.Length -gt 1048576) { throw 'smoke_supervisor_log_budget' }
  [IO.File]::WriteAllText((Join-Path $out 'driver.log'),$log)
}
[ordered]@{ taskId=$s.taskId; grantId=$RootGrantId; driverPID=$ownedPid; bornUTC=$birth.ToString('o');
  finishedUTC=[DateTime]::UtcNow.ToString('o'); timedOut=(-not $terminal); exitCode=$exitCode;
  driverHasExited=$child.HasExited; runtimeAcceptance='Read actual driver receipt/checkpoints; controller exit alone is not native PASS';
  productShutdown='UNRUN by controller; future launcher owns app/WebView/Vite PID-birth cleanup' } |
  ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $out 'terminal.json') -Encoding utf8
if (-not $terminal -or $exitCode -ne 0) { throw 'smoke_owned_driver_failed' }
