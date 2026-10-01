param(
  [ValidateSet('before-prepare', 'before-cargo')]
  [string]$Phase,
  [string]$EvidenceDirectory = 'work/native-windows-qa'
)

function Test-NativeQaAdmission {
  param([double]$AvailableMiB, [double]$CommitAvailableMiB, [double]$DiskAvailableMiB)
  $reasons = [Collections.Generic.List[string]]::new()
  foreach ($value in @($AvailableMiB, $CommitAvailableMiB, $DiskAvailableMiB)) {
    if ([double]::IsNaN($value) -or [double]::IsInfinity($value) -or $value -lt 0) {
      throw 'Capacity values must be finite and nonnegative.'
    }
  }
  # SP02: measured availability, 25% estimate allowance and 1024 MiB headroom.
  $requiredRam = [math]::Ceiling(6144 * 1.25 + 1024)
  $requiredCommit = [math]::Ceiling(8192 * 1.25 + 1024)
  if ($AvailableMiB -lt $requiredRam) { $reasons.Add('insufficient_available_ram') }
  if ($CommitAvailableMiB -lt $requiredCommit) { $reasons.Add('insufficient_commit_headroom') }
  if ($DiskAvailableMiB -lt 12288) { $reasons.Add('insufficient_disk') }
  [ordered]@{
    admitted = $reasons.Count -eq 0
    reasons = @($reasons.ToArray())
    availableMiB = $AvailableMiB
    requiredAvailableMiB = $requiredRam
    commitAvailableMiB = $CommitAvailableMiB
    requiredCommitAvailableMiB = $requiredCommit
    diskAvailableMiB = $DiskAvailableMiB
    requiredDiskAvailableMiB = 12288
    estimateScope = 'Conservative whole-tree cold build estimate; actual remote peak not measured.'
  }
}

if ($MyInvocation.InvocationName -ne '.') {
  $ErrorActionPreference = 'Stop'
  if (-not $IsWindows -or -not $Phase) { throw 'A Windows phase is required.' }
  $workspace = [IO.Path]::GetFullPath((Get-Location).Path)
  $evidence = [IO.Path]::GetFullPath((Join-Path $workspace $EvidenceDirectory))
  if (-not $evidence.StartsWith($workspace + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Evidence must stay inside the workflow workspace.'
  }
  $memory = Get-CimInstance Win32_PerfFormattedData_PerfOS_Memory
  $diskByDrive = [ordered]@{}
  foreach ($location in @($workspace, $env:TEMP, $env:VIBESPACE_CONNECTOR_BUILD_DIR, $env:VIBESPACE_SIYUAN_CACHE_DIR)) {
    if ([string]::IsNullOrWhiteSpace($location)) { continue }
    $driveName = [IO.Path]::GetPathRoot([IO.Path]::GetFullPath($location)).Substring(0, 1)
    $diskByDrive[$driveName] = (Get-PSDrive -Name $driveName).Free / 1MB
  }
  $minimumDisk = ($diskByDrive.Values | Measure-Object -Minimum).Minimum
  $result = Test-NativeQaAdmission -AvailableMiB $memory.AvailableMBytes `
    -CommitAvailableMiB (($memory.CommitLimit - $memory.CommittedBytes) / 1MB) `
    -DiskAvailableMiB $minimumDisk
  $result.diskByDriveMiB = $diskByDrive
  $result.phase = $Phase
  $result.observedAtUTC = [DateTime]::UtcNow.ToString('o')
  New-Item -ItemType Directory -Path $evidence -Force | Out-Null
  $json = $result | ConvertTo-Json -Depth 4
  [IO.File]::WriteAllText((Join-Path $evidence "preflight-$Phase.json"), $json)
  Write-Output $json
  if (-not $result.admitted) { exit 2 }
}
