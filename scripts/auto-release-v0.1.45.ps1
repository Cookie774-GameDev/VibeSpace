#Requires -Version 5.1
<#
.SYNOPSIS
  Fully automated VibeSpace v0.1.45 release (gates → commit → tag → CI → sign → channel).

.DESCRIPTION
  Scheduled by VibeSpace Helper. Waits $DelaySeconds (default 1800 = 30 min), then:
    1. Restore install/install.ps1 if missing locally
    2. Run test / typecheck / release-manifest gates
    3. Bump 0.1.44 → 0.1.45 across version files
    4. Write CHANGELOG + RELEASE_NOTES + whats-new entry
    5. Commit, push main, tag v0.1.45, push tag
    6. Wait for GitHub Actions release assets
    7. Sign Windows installer + promote releases/channel.json

  Logs to scripts/auto-release-v0.1.45.log
#>
[CmdletBinding()]
param(
  [int]$DelaySeconds = 1800,
  [string]$RepoRoot = 'C:\Users\viper\VibeSpace',
  [string]$SigningKeyPath = "$env:USERPROFILE\.tauri\jarvis-plain.key"
)

$ErrorActionPreference = 'Stop'
$Version = '0.1.45'
$PrevVersion = '0.1.44'
$Tag = "v$Version"
$LogPath = Join-Path $RepoRoot 'scripts\auto-release-v0.1.45.log'

function Write-Log($Message) {
  $line = "[{0}] {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Message
  Add-Content -LiteralPath $LogPath -Value $line
  Write-Host $line
}

function Fail($Message) {
  Write-Log "FAIL: $Message"
  exit 1
}

function Invoke-Git {
  param([string[]]$Args)
  $out = & git -C $RepoRoot @Args 2>&1
  if ($LASTEXITCODE -ne 0) {
    Fail ("git {0} failed: {1}" -f ($Args -join ' '), ($out | Out-String))
  }
  return $out
}

Set-Location -LiteralPath $RepoRoot
New-Item -ItemType Directory -Force -Path (Split-Path $LogPath) | Out-Null
Write-Log "=== VibeSpace $Tag auto-release armed (delay ${DelaySeconds}s) ==="

if ($DelaySeconds -gt 0) {
  $wakeAt = (Get-Date).AddSeconds($DelaySeconds)
  Write-Log "Sleeping until $wakeAt ..."
  Start-Sleep -Seconds $DelaySeconds
}

Write-Log 'Delay complete — starting release pipeline.'

# --- Restore installer if Windows path lock deleted the working copy ---
$installPs1 = Join-Path $RepoRoot 'install\install.ps1'
if (-not (Test-Path -LiteralPath $installPs1)) {
  Write-Log 'Restoring install/install.ps1 from HEAD'
  Invoke-Git checkout, 'HEAD', '--', 'install/install.ps1'
}

# --- Quality gates ---
Write-Log 'Running npm test (vitest)...'
Push-Location (Join-Path $RepoRoot 'app')
& npm test 2>&1 | Tee-Object -FilePath $LogPath -Append
if ($LASTEXITCODE -ne 0) { Pop-Location; Fail 'vitest failed' }
Pop-Location

Write-Log 'Running typecheck...'
& npm --prefix $RepoRoot run typecheck 2>&1 | Tee-Object -FilePath $LogPath -Append
if ($LASTEXITCODE -ne 0) { Fail 'typecheck failed' }

Write-Log 'Running test:release-manifest...'
& npm --prefix $RepoRoot run test:release-manifest 2>&1 | Tee-Object -FilePath $LogPath -Append
if ($LASTEXITCODE -ne 0) { Fail 'release manifest test failed' }

Write-Log 'Running production build...'
& npm --prefix $RepoRoot run build 2>&1 | Tee-Object -FilePath $LogPath -Append
if ($LASTEXITCODE -ne 0) { Fail 'build failed' }

# --- Version bump (0.1.44 → 0.1.45) ---
$versionFiles = @(
  'package.json',
  'app\package.json',
  'app\src-tauri\Cargo.toml',
  'app\src-tauri\tauri.conf.json',
  'app\src\lib\supabase.ts'
)
foreach ($rel in $versionFiles) {
  $path = Join-Path $RepoRoot $rel
  if (-not (Test-Path -LiteralPath $path)) { Fail "missing version file: $rel" }
  $raw = Get-Content -LiteralPath $path -Raw
  $next = $raw -replace [regex]::Escape($PrevVersion), $Version
  if ($next -eq $raw) { Write-Log "WARN: no $PrevVersion replacement in $rel" }
  Set-Content -LiteralPath $path -Value $next -NoNewline
  Write-Log "Bumped $rel"
}

$releasesTs = Join-Path $RepoRoot 'app\src\features\whats-new\releases.ts'
$releasesRaw = Get-Content -LiteralPath $releasesTs -Raw
$releasesRaw = $releasesRaw -replace "export const CURRENT_VERSION = '$PrevVersion'", "export const CURRENT_VERSION = '$Version'"
$newRelease = @"
  {
    version: '$Version',
    date: '$(Get-Date -Format 'yyyy-MM-dd')',
    headline: 'Skills catalog, Inspector panel, and agent coordination',
    summary:
      'Unified skills library with editor and /skills picker, rebuilt Inspector and Kanban milestones, native terminal agent coordination, Apex billing tier, and Windows trust documentation.',
    sections: [
      {
        kind: 'feature',
        items: [
          'Unified skills catalog — built-in + custom skills with editor, preview, and /skills chat picker.',
          'Inspector panel — Today, Quick Launch, Context, Tools Run, Trace milestones, and Active Work.',
          'Terminal agent coordination — native project ledger, locks, and mode-aware prompt payloads for OpenCode CLIs.',
          'Apex plan tier — subscription ladder update with checkout and entitlement wiring.',
        ],
      },
      {
        kind: 'improvement',
        items: [
          'Kanban rebuilt on milestone store with inspector-aligned cards and columns.',
          'Hive balanced preset and frontier model registry polish.',
          'Windows trust docs — publisher metadata, SHA-256 verify script, SmartScreen guidance.',
        ],
      },
      {
        kind: 'fix',
        items: [
          'Top-bar mic routes to composer STT, not the Jarvis voice module.',
          'Terminal viewport and restore-session hardening across pane switches.',
        ],
      },
    ],
  },
"@
$releasesRaw = $releasesRaw -replace '(export const RELEASES: readonly Release\[\] = \[)', "`$1`n$newRelease"
Set-Content -LiteralPath $releasesTs -Value $releasesRaw -NoNewline
Write-Log 'Updated whats-new releases.ts'

# --- CHANGELOG ---
$changelogPath = Join-Path $RepoRoot 'CHANGELOG.md'
$changelogEntry = @"

## [$Version] - $(Get-Date -Format 'yyyy-MM-dd')

### Added

- **Unified skills catalog** — SkillEditor, markdown preview, built-in + custom skills; `/skills` picker uses one catalog.
- **Inspector panel** — Today, Quick Launch, Context, Tools Run, Trace milestones, Active Work.
- **Terminal agent coordination** — Rust-backed ledger, client locks, mode-aware `agentPromptPayload`.
- **Apex billing tier** — plan limits, checkout, and Supabase migration `0027_apex_tier.sql`.
- **Windows trust docs** — `docs/TRUST_AND_WINDOWS.md`, publisher metadata, `verify-release-checksum.ps1`.

### Improved

- **Kanban** — milestone-driven board aligned with Inspector trace store.
- **Hive** — balanced preset and frontier model updates.
- **Agent prompts** — richer terminal briefing delivery and tests.

### Fixed

- **Composer mic** — TopBar mic uses composer STT, separate from Jarvis voice module.
- **Terminals** — viewport isolation and restore-session edge cases.

"@
$changelogRaw = Get-Content -LiteralPath $changelogPath -Raw
$changelogRaw = $changelogRaw -replace '(# Changelog\s+)', "`$1$changelogEntry"
Set-Content -LiteralPath $changelogPath -Value $changelogRaw -NoNewline

# --- RELEASE_NOTES ---
$releaseNotesPath = Join-Path $RepoRoot "releases\RELEASE_NOTES_$Version.md"
@"

# VibeSpace $Version — Skills, Inspector, and agent coordination

## Highlights

- **Skills catalog** — unified library, editor, and `/skills` chat attachments.
- **Inspector** — right-hand panel with Quick Launch, milestones, and active work.
- **Terminal coordination** — native swarm ledger and improved CLI prompt delivery.
- **Kanban milestones** — board rebuilt on trace/milestone store.
- **Apex tier** — new subscription plan on billing.
- **Windows trust** — free credibility checklist and verify script (no app UI changes).

## Install / update

``````powershell
irm https://raw.githubusercontent.com/Cookie774-GameDev/VibeSpace/main/install/install.ps1 | iex
``````

## Assets

- **Windows x64 NSIS**: ``VibeSpace-$Version-Windows-x64.exe`` (signed updater assets after channel promote)
- **Updater channel**: ``releases/channel.json``

"@ | Set-Content -LiteralPath $releaseNotesPath -Encoding UTF8

# --- Stage & commit ---
Write-Log 'Staging release files...'
Invoke-Git add, '-A'
foreach ($unstage in @('.cursor', 'install/install_new.ps1', 'releases/RELEASE_NOTES_0.1.43.md', 'releases/download-tmp')) {
  if (Test-Path (Join-Path $RepoRoot ($unstage -replace '/', '\'))) {
    Invoke-Git reset, 'HEAD', '--', $unstage 2>$null
  }
}
# Ensure install.ps1 is staged
Invoke-Git add, 'install/install.ps1'

$commitMsg = "Release v${Version}: skills catalog, Inspector, and terminal agent coordination."
Invoke-Git commit, '-m', $commitMsg
Write-Log "Committed $(Invoke-Git rev-parse, '--short', 'HEAD')"

Write-Log 'Pushing main...'
Invoke-Git push, 'origin', 'main'

if (Invoke-Git tag, '-l', $Tag) {
  Write-Log "Tag $Tag already exists - skipping tag create"
} else {
  Invoke-Git tag, $Tag
}
Invoke-Git push, 'origin', $Tag
Write-Log "Tag $Tag pushed - waiting for CI release assets..."

# --- Wait for CI (up to 120 min) ---
$assetName = "VibeSpace_${Version}_x64-setup.exe"
$deadline = (Get-Date).AddMinutes(120)
$downloaded = $false
while ((Get-Date) -lt $deadline) {
  try {
    gh release view $Tag --repo Cookie774-GameDev/VibeSpace 2>&1 | Out-Null
    $view = gh release view $Tag --repo Cookie774-GameDev/VibeSpace --json assets -q '.assets[].name' 2>&1
    if ($view -match [regex]::Escape($assetName)) {
      $downloaded = $true
      break
    }
  } catch {}
  Write-Log 'CI not ready - sleeping 90s...'
  Start-Sleep -Seconds 90
}
if (-not $downloaded) { Fail "Timed out waiting for $assetName on $Tag" }

Write-Log 'Publishing GitHub release (draft to published)...'
gh release edit $Tag --repo Cookie774-GameDev/VibeSpace --draft=false 2>&1 | Tee-Object -FilePath $LogPath -Append

# --- Sign + channel promote ---
$nsisDir = Join-Path $RepoRoot "app\src-tauri\target\release\bundle\nsis"
$msiDir = Join-Path $RepoRoot "app\src-tauri\target\release\bundle\msi"
$tmp = Join-Path $RepoRoot 'releases\download-tmp'
New-Item -ItemType Directory -Force -Path $nsisDir, $msiDir, $tmp | Out-Null
gh release download $Tag --repo Cookie774-GameDev/VibeSpace --pattern "VibeSpace_${Version}_x64-setup.exe" --dir $nsisDir --clobber
gh release download $Tag --repo Cookie774-GameDev/VibeSpace --pattern "VibeSpace_${Version}_x64_en-US.msi" --dir $msiDir --clobber 2>$null

if (-not (Test-Path -LiteralPath $SigningKeyPath)) {
  Fail "Signing key missing: $SigningKeyPath"
}
$env:TAURI_SIGNING_PRIVATE_KEY_PATH = $SigningKeyPath
$tauriCli = Join-Path $RepoRoot 'node_modules\@tauri-apps\cli\tauri.js'
$nodePath = (Get-Command node).Source
$blankPw = (Test-Path "$SigningKeyPath.password") -or (Test-Path (Join-Path (Split-Path $SigningKeyPath -Parent) 'empty-password.txt'))
foreach ($artifact in @(
  "$nsisDir\VibeSpace_${Version}_x64-setup.exe",
  "$msiDir\VibeSpace_${Version}_x64_en-US.msi"
)) {
  if (-not (Test-Path -LiteralPath $artifact)) { continue }
  if ($blankPw) {
    $cmd = "`"$nodePath`" `"$tauriCli`" signer sign -f `"$SigningKeyPath`" -p `"`" `"$artifact`""
    cmd.exe /d /s /c $cmd
  } else {
    & $nodePath $tauriCli signer sign -f $SigningKeyPath $artifact
  }
  if ($LASTEXITCODE -ne 0) { Fail "sign failed: $artifact" }
}

Push-Location $RepoRoot
& npm run release:stage 2>&1 | Tee-Object -FilePath $LogPath -Append
if ($LASTEXITCODE -ne 0) { Pop-Location; Fail 'release:stage failed' }
Pop-Location

gh release upload $Tag --repo Cookie774-GameDev/VibeSpace --clobber `
  "releases\VibeSpace-$Version-Windows-x64.exe" `
  "releases\VibeSpace-$Version-Windows-x64.exe.sig" `
  "releases\latest.json" `
  "releases\SHA256SUMS.txt" 2>&1 | Tee-Object -FilePath $LogPath -Append

Invoke-Git add, 'releases/channel.json', "releases/manifests/v$Version.json"
Invoke-Git commit, '-m', "Promote in-app updater channel to v$Version."
Invoke-Git push, 'origin', 'main'

Write-Log "=== VibeSpace $Tag release COMPLETE ==="
Write-Host "AGENT_RELEASE_DONE_$Version"
