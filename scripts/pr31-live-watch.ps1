#Requires -Version 5.1
<#
.SYNOPSIS
  PR31 live watch - keep the local PR31 desktop session on the PR worktree commits.

.DESCRIPTION
  Watches the PR31 worktree (agent/pr30-fixes-and-updates), keeps Vite serving that tree
  on 127.0.0.1:5173, keeps the pr31-run jarvis.exe up, records HEAD drift vs origin, and
  optionally fast-forwards from origin when the tree is clean.

  Safety (never destroys work):
  - No git reset --hard, no force-push, no stash drop.
  - Remote sync is ff-only and only when the worktree is clean.
  - Diverged histories are reported, not rewritten.
  - Only Vite processes whose command line includes this worktree are restarted.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts/pr31-live-watch.ps1
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts/pr31-live-watch.ps1 -Once
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts/pr31-live-watch.ps1 -SyncFromRemote
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts/pr31-live-watch.ps1 -Stop
#>
[CmdletBinding()]
param(
  [switch]$Once,
  [switch]$Stop,
  [switch]$SyncFromRemote,
  [switch]$RestartJarvisOnNativeChange,
  [int]$IntervalSeconds = 20,
  [string]$Worktree = "",
  [string]$Branch = "agent/pr30-fixes-and-updates",
  [string]$Remote = "origin",
  [string]$JarvisExe = "D:\VibeSpaceBuild\pr31-run\debug\jarvis.exe",
  [int]$VitePort = 5173,
  [string]$StatusDir = ""
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Resolve-Pr31Worktree {
  param([string]$Explicit)
  if ($Explicit -and (Test-Path -LiteralPath $Explicit)) {
    return (Resolve-Path -LiteralPath $Explicit).Path
  }
  if ($PSScriptRoot) {
    $root = Split-Path -Parent $PSScriptRoot
    if (Test-Path -LiteralPath (Join-Path $root "app\package.json")) {
      return $root
    }
  }
  $fallback = "C:\Users\viper\VibeSpace\.worktrees\pr30-fixes-updates-20260802"
  if (Test-Path -LiteralPath $fallback) { return $fallback }
  throw "PR31 worktree not found. Pass -Worktree."
}

function Write-Pr31Log {
  param([string]$Level, [string]$Message)
  $ts = (Get-Date).ToString("yyyy-MM-dd HH:mm:ss")
  $line = "[$ts] [$Level] $Message"
  Write-Host $line
  if ($script:LogFile) {
    Add-Content -LiteralPath $script:LogFile -Value $line -Encoding UTF8
  }
}

function Get-Git {
  param(
    [string]$Repo,
    [Parameter(Mandatory = $true)]
    [string[]]$GitArgs
  )
  $prev = Get-Location
  try {
    Set-Location -LiteralPath $Repo
    $out = & git @GitArgs 2>&1
    $code = $LASTEXITCODE
    return [pscustomobject]@{
      ExitCode = $code
      Output   = @($out | ForEach-Object { "$_" })
      Text     = (($out | ForEach-Object { "$_" }) -join "`n").Trim()
    }
  } finally {
    Set-Location $prev
  }
}

function Test-PortOpen {
  param([int]$Port)
  try {
    $c = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
      Select-Object -First 1
    return $null -ne $c
  } catch {
    return $false
  }
}

function Get-ViteProcessesForWorktree {
  param([string]$Repo)
  $needle = $Repo.Replace("\", "\\")
  Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
    Where-Object {
      $_.Name -match '^(node|cmd|pwsh|powershell)\.exe$' -and
      $_.CommandLine -and
      ($_.CommandLine -match 'vite') -and
      ($_.CommandLine -like "*$Repo*" -or $_.CommandLine -match [regex]::Escape($needle))
    }
}

function Stop-Pr31Vite {
  param([string]$Repo)
  $procs = @(Get-ViteProcessesForWorktree -Repo $Repo)
  foreach ($p in $procs) {
    Write-Pr31Log "info" "Stopping Vite pid=$($p.ProcessId)"
    Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
  }
  # Free the port if a stale listener remains.
  Get-NetTCPConnection -LocalPort $script:VitePort -ErrorAction SilentlyContinue |
    ForEach-Object {
      try { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue } catch {}
    }
  Start-Sleep -Milliseconds 400
}

function Start-Pr31Vite {
  param([string]$Repo)
  if (Test-PortOpen -Port $script:VitePort) {
    $existing = @(Get-ViteProcessesForWorktree -Repo $Repo)
    if ($existing.Count -gt 0) {
      Write-Pr31Log "ok" "Vite already listening on $($script:VitePort) for this worktree"
      return
    }
    Write-Pr31Log "warn" "Port $($script:VitePort) is in use by another process; leaving it alone"
    return
  }

  $appDir = Join-Path $Repo "app"
  if (-not (Test-Path -LiteralPath (Join-Path $appDir "package.json"))) {
    throw "Missing app/package.json under $Repo"
  }

  $logOut = Join-Path $script:StatusDir "vite.stdout.log"
  $logErr = Join-Path $script:StatusDir "vite.stderr.log"
  Write-Pr31Log "info" "Starting Vite --host 127.0.0.1 --port $($script:VitePort)"

  $env:TAURI_DEV_HOST = "127.0.0.1"
  $env:BROWSER = "none"
  $arg = "/d /s /c `"npm run dev -- --host 127.0.0.1 --port $($script:VitePort) > `"$logOut`" 2> `"$logErr`"`""
  $proc = Start-Process -FilePath "cmd.exe" -ArgumentList $arg -WorkingDirectory $appDir -WindowStyle Hidden -PassThru

  $deadline = (Get-Date).AddSeconds(60)
  while ((Get-Date) -lt $deadline) {
    if (Test-PortOpen -Port $script:VitePort) {
      Write-Pr31Log "ok" "Vite is up on http://127.0.0.1:$($script:VitePort)/ (pid=$($proc.Id))"
      return
    }
    if ($proc.HasExited) {
      Write-Pr31Log "error" "Vite process exited early; check $logErr"
      return
    }
    Start-Sleep -Milliseconds 500
  }
  Write-Pr31Log "warn" "Vite start timed out; check $logOut / $logErr"
}

function Get-JarvisProcesses {
  param([string]$ExePath)
  $name = [System.IO.Path]::GetFileNameWithoutExtension($ExePath)
  Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
    Where-Object {
      $_.Name -ieq "$name.exe" -and
      $_.CommandLine -and
      ($_.CommandLine -like "*pr31-run*" -or $_.CommandLine -like "*$ExePath*")
    }
}

function Start-Pr31Jarvis {
  param([string]$ExePath)
  if (-not (Test-Path -LiteralPath $ExePath)) {
    Write-Pr31Log "warn" "Jarvis exe missing: $ExePath (UI-only live watch will continue)"
    return
  }
  $running = @(Get-JarvisProcesses -ExePath $ExePath)
  if ($running.Count -gt 0) {
    Write-Pr31Log "ok" "Jarvis already running (pid=$($running[0].ProcessId))"
    return
  }
  Write-Pr31Log "info" "Starting Jarvis: $ExePath"
  Start-Process -FilePath $ExePath -WorkingDirectory (Split-Path -Parent $ExePath) | Out-Null
  Start-Sleep -Seconds 1
}

function Get-RepoState {
  param([string]$Repo, [string]$Branch, [string]$Remote)
  $head = (Get-Git -Repo $Repo -GitArgs @("rev-parse", "HEAD")).Text
  $short = (Get-Git -Repo $Repo -GitArgs @("rev-parse", "--short", "HEAD")).Text
  $subject = (Get-Git -Repo $Repo -GitArgs @("log", "-1", "--pretty=%s")).Text
  $branchNow = (Get-Git -Repo $Repo -GitArgs @("branch", "--show-current")).Text
  $porcelain = (Get-Git -Repo $Repo -GitArgs @("status", "--porcelain")).Text
  $dirty = -not [string]::IsNullOrWhiteSpace($porcelain)

  $fetch = Get-Git -Repo $Repo -GitArgs @("fetch", $Remote, $Branch, "--quiet")
  $remoteRef = "$Remote/$Branch"
  $remoteHead = (Get-Git -Repo $Repo -GitArgs @("rev-parse", $remoteRef)).Text
  $counts = (Get-Git -Repo $Repo -GitArgs @("rev-list", "--left-right", "--count", "${remoteRef}...HEAD")).Text
  $behind = 0
  $ahead = 0
  if ($counts -match '^\s*(\d+)\s+(\d+)\s*$') {
    $behind = [int]$Matches[1]
    $ahead = [int]$Matches[2]
  }

  return [pscustomobject]@{
    Head         = $head
    Short        = $short
    Subject      = $subject
    Branch       = $branchNow
    Dirty        = $dirty
    Porcelain    = $porcelain
    RemoteHead   = $remoteHead
    Ahead        = $ahead
    Behind       = $behind
    FetchOk      = ($fetch.ExitCode -eq 0)
    FetchMessage = $fetch.Text
  }
}

function Try-FastForwardRemote {
  param([string]$Repo, [string]$Branch, [string]$Remote, $State)
  if (-not $SyncFromRemote) {
    return $false
  }
  if ($State.Dirty) {
    Write-Pr31Log "warn" "Skip remote sync: worktree is dirty (uncommitted files present)"
    return $false
  }
  if ($State.Behind -le 0) {
    return $false
  }
  if ($State.Ahead -gt 0) {
    Write-Pr31Log "warn" "Skip remote sync: diverged (ahead=$($State.Ahead) behind=$($State.Behind)). Manual rebase/merge required - refusing to overwrite."
    return $false
  }
  Write-Pr31Log "info" "Fast-forwarding $Branch by $($State.Behind) commit(s) from $Remote"
  $pull = Get-Git -Repo $Repo -GitArgs @("merge", "--ff-only", "$Remote/$Branch")
  if ($pull.ExitCode -ne 0) {
    Write-Pr31Log "error" "ff-only failed: $($pull.Text)"
    return $false
  }
  Write-Pr31Log "ok" "Fast-forward complete: $($pull.Text -replace '\s+', ' ')"
  return $true
}

function Write-StatusJson {
  param($State, [string]$Path, [hashtable]$Extra)
  $payload = [ordered]@{
    updatedAt      = (Get-Date).ToString("o")
    worktree       = $script:WorktreePath
    branch         = $State.Branch
    head           = $State.Head
    short          = $State.Short
    subject        = $State.Subject
    dirty          = $State.Dirty
    ahead          = $State.Ahead
    behind         = $State.Behind
    remoteHead     = $State.RemoteHead
    vitePort       = $script:VitePort
    viteUp         = (Test-PortOpen -Port $script:VitePort)
    jarvisExe      = $script:JarvisExe
    jarvisRunning  = (@(Get-JarvisProcesses -ExePath $script:JarvisExe).Count -gt 0)
    syncFromRemote = [bool]$SyncFromRemote
    mode           = "pr31-live-watch"
  }
  foreach ($k in $Extra.Keys) { $payload[$k] = $Extra[$k] }
  $json = $payload | ConvertTo-Json -Depth 6
  Set-Content -LiteralPath $Path -Value $json -Encoding UTF8
}

# --- main ---
$script:WorktreePath = Resolve-Pr31Worktree -Explicit $Worktree
$script:VitePort = $VitePort
$script:JarvisExe = $JarvisExe
if (-not $StatusDir) {
  $StatusDir = Join-Path $script:WorktreePath "artifacts\pr31-live"
}
New-Item -ItemType Directory -Force -Path $StatusDir | Out-Null
$script:StatusDir = $StatusDir
$script:LogFile = Join-Path $StatusDir "watch.log"
$statusJson = Join-Path $StatusDir "status.json"
$pidFile = Join-Path $StatusDir "watch.pid"

if ($Stop) {
  if (Test-Path -LiteralPath $pidFile) {
    $oldPid = Get-Content -LiteralPath $pidFile -ErrorAction SilentlyContinue
    if ($oldPid) {
      Stop-Process -Id ([int]$oldPid) -Force -ErrorAction SilentlyContinue
    }
    Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
  }
  Stop-Pr31Vite -Repo $script:WorktreePath
  Write-Host "PR31 live watch stopped (Vite for this worktree stopped; jarvis left running)."
  exit 0
}

# Single-instance guard for long-running watch
if (-not $Once) {
  $me = $PID
  Set-Content -LiteralPath $pidFile -Value "$me" -Encoding ascii
}

Write-Pr31Log "info" "PR31 live watch starting"
Write-Pr31Log "info" "Worktree: $($script:WorktreePath)"
Write-Pr31Log "info" "Branch: $Branch | Interval: ${IntervalSeconds}s | SyncFromRemote: $SyncFromRemote"

$script:LastHead = ""
$script:LastNativeWrite = $null
if (Test-Path -LiteralPath $JarvisExe) {
  $script:LastNativeWrite = (Get-Item -LiteralPath $JarvisExe).LastWriteTimeUtc
}

function Invoke-Pr31WatchTick {
  $state = Get-RepoState -Repo $script:WorktreePath -Branch $Branch -Remote $Remote
  if (-not $state.FetchOk -and $state.FetchMessage) {
    Write-Pr31Log "warn" "git fetch: $($state.FetchMessage)"
  }

  if ($state.Branch -and $state.Branch -ne $Branch) {
    Write-Pr31Log "warn" "Current branch is '$($state.Branch)' (expected '$Branch')"
  }

  $synced = Try-FastForwardRemote -Repo $script:WorktreePath -Branch $Branch -Remote $Remote -State $state
  if ($synced) {
    $state = Get-RepoState -Repo $script:WorktreePath -Branch $Branch -Remote $Remote
  }

  if ($state.Head -ne $script:LastHead) {
    if ($script:LastHead) {
      Write-Pr31Log "ok" "HEAD advanced: $($state.Short) - $($state.Subject)"
      Write-Pr31Log "info" "UI source is this worktree; Vite HMR serves committed + uncommitted files from disk"
    } else {
      Write-Pr31Log "ok" "HEAD $($state.Short) - $($state.Subject)"
    }
    $script:LastHead = $state.Head
  }

  if ($state.Behind -gt 0 -and $state.Ahead -gt 0) {
    Write-Pr31Log "warn" "Diverged from $Remote/$Branch (ahead=$($state.Ahead) behind=$($state.Behind)). Live app uses LOCAL worktree commits, not a force-reset to remote."
  } elseif ($state.Behind -gt 0) {
    Write-Pr31Log "warn" "Behind $Remote/$Branch by $($state.Behind). Re-run with -SyncFromRemote when clean to ff-only pull."
  } elseif ($state.Ahead -gt 0) {
    Write-Pr31Log "info" "Local ahead of $Remote/$Branch by $($state.Ahead) commit(s) - live shows local commits"
  }

  Start-Pr31Vite -Repo $script:WorktreePath
  Start-Pr31Jarvis -ExePath $JarvisExe

  if ($RestartJarvisOnNativeChange -and (Test-Path -LiteralPath $JarvisExe)) {
    $write = (Get-Item -LiteralPath $JarvisExe).LastWriteTimeUtc
    if ($script:LastNativeWrite -and $write -gt $script:LastNativeWrite) {
      Write-Pr31Log "info" "Native jarvis.exe changed; restarting app process"
      Get-JarvisProcesses -ExePath $JarvisExe | ForEach-Object {
        Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
      }
      Start-Sleep -Milliseconds 500
      Start-Pr31Jarvis -ExePath $JarvisExe
    }
    $script:LastNativeWrite = $write
  }

  Write-StatusJson -State $state -Path $statusJson -Extra @{
    lastTick = (Get-Date).ToString("o")
    synced   = [bool]$synced
  }
}

try {
  Invoke-Pr31WatchTick
  if ($Once) {
    Write-Pr31Log "ok" "Single pass complete. Status: $statusJson"
    exit 0
  }
  while ($true) {
    Start-Sleep -Seconds ([Math]::Max(5, $IntervalSeconds))
    try {
      Invoke-Pr31WatchTick
    } catch {
      Write-Pr31Log "error" "Tick failed: $($_.Exception.Message)"
    }
  }
} finally {
  if (-not $Once -and (Test-Path -LiteralPath $pidFile)) {
    $cur = Get-Content -LiteralPath $pidFile -ErrorAction SilentlyContinue
    if ("$cur" -eq "$PID") {
      Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
    }
  }
}
