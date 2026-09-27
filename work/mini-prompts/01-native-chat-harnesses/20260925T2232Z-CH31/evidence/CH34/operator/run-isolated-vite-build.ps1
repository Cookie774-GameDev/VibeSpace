param(
  [Parameter(Mandatory = $true)]
  [string]$BuildTag
)

$ErrorActionPreference = 'Stop'
$repo = 'C:\Users\viper\VibeSpace-UnifiedChungus-Final'
$app = Join-Path $repo 'app'
$operator = Join-Path $repo 'work\mini-prompts\01-native-chat-harnesses\20260925T2232Z-CH31\evidence\CH34\operator'
$outDir = Join-Path $operator "isolated-vite-dist-$BuildTag"
$cacheDir = Join-Path $operator "isolated-vite-cache-$BuildTag"
$logPath = Join-Path $operator "isolated-vite-build-$BuildTag.log"
$receiptPath = Join-Path $operator "isolated-vite-build-$BuildTag.json"

foreach ($candidate in @($outDir, $cacheDir, $logPath, $receiptPath)) {
  if (-not $candidate.StartsWith($operator, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Build artifact escaped operator scope: $candidate"
  }
  if (Test-Path -LiteralPath $candidate) {
    throw "Build artifact path already exists: $candidate"
  }
}

function Get-TreeSnapshot([string]$path) {
  if (-not (Test-Path -LiteralPath $path -PathType Container)) {
    return [pscustomobject]@{ exists = $false; fileCount = 0; bytes = 0; newestFileWriteUtc = $null }
  }
  $files = @(Get-ChildItem -LiteralPath $path -File -Recurse -Force)
  $newest = $files | Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1
  return [pscustomobject]@{
    exists = $true
    fileCount = $files.Count
    bytes = [long](($files | Measure-Object -Property Length -Sum).Sum)
    newestFileWriteUtc = if ($newest) { $newest.LastWriteTimeUtc.ToString('o') } else { $null }
  }
}

function Get-AppSourceSnapshot {
  $entries = [ordered]@{}
  $bytes = [long]0
  $files = @(Get-ChildItem -LiteralPath (Join-Path $app 'src') -File -Recurse | Sort-Object FullName)
  foreach ($file in $files) {
    $relative = $file.FullName.Substring($repo.Length + 1).Replace('\', '/')
    $hash = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash
    $entries[$relative] = $hash
    $bytes += $file.Length
  }
  $canonical = foreach ($key in $entries.Keys) { "$key`t$($entries[$key])" }
  $sha = [Security.Cryptography.SHA256]::Create()
  try {
    $aggregate = $sha.ComputeHash([Text.Encoding]::UTF8.GetBytes([string]::Join("`n", $canonical)))
  } finally {
    $sha.Dispose()
  }
  return [pscustomobject]@{
    fileCount = $files.Count
    bytes = $bytes
    fingerprintSha256 = [BitConverter]::ToString($aggregate).Replace('-', '')
    entries = $entries
  }
}

function Get-CriticalSourceHashes {
  $paths = @(
    'app/package.json',
    'app/vite.config.ts',
    'app/src/features/chat/assistant-rich-text.css',
    'app/src/lib/ai/runtime.ts',
    'app/src/features/chat/AssistantRichText.tsx',
    'app/src/features/chat/AssistantRichText.test.tsx'
  )
  $hashes = [ordered]@{}
  foreach ($relative in $paths) {
    $hashes[$relative] = (Get-FileHash -LiteralPath (Join-Path $repo $relative) -Algorithm SHA256).Hash
  }
  return $hashes
}

function Get-FileSnapshot([string]$path) {
  if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { return $null }
  $item = Get-Item -LiteralPath $path
  return [pscustomobject]@{
    path = $path
    bytes = $item.Length
    sha256 = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash
    lastWriteUtc = $item.LastWriteTimeUtc.ToString('o')
  }
}

function Get-FreeMemoryGiB {
  $os = Get-CimInstance Win32_OperatingSystem
  return [math]::Round($os.FreePhysicalMemory / 1MB, 2)
}

$outParent = Split-Path -Parent $outDir
$cacheParent = Split-Path -Parent $cacheDir
$artifactRoot = (Resolve-Path -LiteralPath $operator).Path
$headBefore = (& git -C $repo rev-parse HEAD).Trim()
$sourceBefore = Get-AppSourceSnapshot
$criticalBefore = Get-CriticalSourceHashes
$distBefore = Get-TreeSnapshot (Join-Path $app 'dist')
$defaultCacheBefore = Get-TreeSnapshot (Join-Path $app 'node_modules\.vite')
$tsBuildInfoBefore = Get-FileSnapshot (Join-Path $app 'tsconfig.tsbuildinfo')
$freeBefore = Get-FreeMemoryGiB
$largeRust = @(Get-CimInstance Win32_Process | Where-Object {
  $_.Name -ieq 'rustc.exe' -and (Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue).WorkingSet64 -gt 1GB
})
$activeBuild = @(Get-CimInstance Win32_Process | Where-Object {
  $_.Name -ieq 'node.exe' -and $_.CommandLine -match 'vite(?:\.js|\.mjs)?\s+build'
})
$preflightBlockers = @()
if ($freeBefore -lt 1.8) { $preflightBlockers += "Free memory below 1.8 GiB ($freeBefore GiB)." }
if ($largeRust.Count -gt 0) { $preflightBlockers += 'A rustc process is using more than 1 GiB.' }
if ($activeBuild.Count -gt 0) { $preflightBlockers += 'Another Vite build is active.' }

$receipt = [ordered]@{
  measuredAtUtc = [DateTime]::UtcNow.ToString('o')
  command = 'node .\node_modules\vite\bin\vite.js build --outDir <absolute fresh operator path> --emptyOutDir'
  workingDirectory = $app
  outDir = $outDir
  cacheDir = $cacheDir
  logPath = $logPath
  headBefore = $headBefore
  environment = @{ TAURI_ENV_PLATFORM = 'windows'; TAURI_ENV_DEBUG = $null; sourcemaps = 'disabled' }
  freeMemoryAtStartGiB = $freeBefore
  preflightBlockers = $preflightBlockers
  sourceBefore = [pscustomobject]@{ fileCount = $sourceBefore.fileCount; bytes = $sourceBefore.bytes; fingerprintSha256 = $sourceBefore.fingerprintSha256 }
  criticalSourceHashesBefore = $criticalBefore
  appDistBefore = $distBefore
  defaultViteCacheBefore = $defaultCacheBefore
  tsBuildInfoBefore = $tsBuildInfoBefore
}

if ($preflightBlockers.Count -gt 0) {
  $receipt['result'] = 'preflight_blocked'
  $receipt['exitCode'] = 75
  $receipt | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $receiptPath -Encoding utf8
  Write-Output ($receipt | ConvertTo-Json -Depth 4 -Compress)
  exit 75
}

$oldPlatform = [Environment]::GetEnvironmentVariable('TAURI_ENV_PLATFORM', 'Process')
$oldDebug = [Environment]::GetEnvironmentVariable('TAURI_ENV_DEBUG', 'Process')
$oldCache = [Environment]::GetEnvironmentVariable('VIBESPACE_VITE_CACHE_DIR', 'Process')
$started = [DateTime]::UtcNow
$stopwatch = [Diagnostics.Stopwatch]::StartNew()
$exitCode = 1
try {
  $env:TAURI_ENV_PLATFORM = 'windows'
  Remove-Item Env:TAURI_ENV_DEBUG -ErrorAction SilentlyContinue
  $env:VIBESPACE_VITE_CACHE_DIR = $cacheDir
  Push-Location $app
  try {
    & node .\node_modules\vite\bin\vite.js build --outDir $outDir --emptyOutDir *> $logPath
    $exitCode = $LASTEXITCODE
  } finally {
    Pop-Location
  }
} catch {
  $receipt['executionError'] = $_.Exception.Message
} finally {
  $stopwatch.Stop()
  [Environment]::SetEnvironmentVariable('TAURI_ENV_PLATFORM', $oldPlatform, 'Process')
  [Environment]::SetEnvironmentVariable('TAURI_ENV_DEBUG', $oldDebug, 'Process')
  [Environment]::SetEnvironmentVariable('VIBESPACE_VITE_CACHE_DIR', $oldCache, 'Process')
}

$finished = [DateTime]::UtcNow
$sourceAfter = Get-AppSourceSnapshot
$criticalAfter = Get-CriticalSourceHashes
$distAfter = Get-TreeSnapshot (Join-Path $app 'dist')
$defaultCacheAfter = Get-TreeSnapshot (Join-Path $app 'node_modules\.vite')
$tsBuildInfoAfter = Get-FileSnapshot (Join-Path $app 'tsconfig.tsbuildinfo')
$output = Get-TreeSnapshot $outDir
$changedSourcePaths = @()
$allSourcePaths = @($sourceBefore.entries.Keys + $sourceAfter.entries.Keys | Sort-Object -Unique)
foreach ($path in $allSourcePaths) {
  if ($sourceBefore.entries[$path] -ne $sourceAfter.entries[$path]) { $changedSourcePaths += $path }
}
$headAfter = (& git -C $repo rev-parse HEAD).Trim()
$mainHtml = Get-FileSnapshot (Join-Path $outDir 'index.html')
$introHtml = Get-FileSnapshot (Join-Path $outDir 'cold-start-intro.html')
$receipt['buildStartedUtc'] = $started.ToString('o')
$receipt['buildFinishedUtc'] = $finished.ToString('o')
$receipt['buildLatencyMs'] = $stopwatch.ElapsedMilliseconds
$receipt['exitCode'] = $exitCode
$receipt['headAfter'] = $headAfter
$receipt['sourceAfter'] = [pscustomobject]@{ fileCount = $sourceAfter.fileCount; bytes = $sourceAfter.bytes; fingerprintSha256 = $sourceAfter.fingerprintSha256 }
$receipt['sourceChangedDuringBuild'] = $changedSourcePaths.Count -gt 0
$receipt['changedSourcePaths'] = $changedSourcePaths
$receipt['criticalSourceHashesAfter'] = $criticalAfter
$receipt['appDistAfter'] = $distAfter
$receipt['defaultViteCacheAfter'] = $defaultCacheAfter
$receipt['tsBuildInfoAfter'] = $tsBuildInfoAfter
$receipt['output'] = [pscustomobject]@{
  fileCount = $output.fileCount
  bytes = $output.bytes
  decimalMB = [math]::Round($output.bytes / 1000000, 2)
  mebibytes = [math]::Round($output.bytes / 1MB, 2)
  indexHtml = $mainHtml
  coldStartIntroHtml = $introHtml
}
$receipt['limitation'] = 'Isolated Vite production bundle only; TypeScript tsc -b/npm build lifecycle and native installer were not run.'
$receipt | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $receiptPath -Encoding utf8
Write-Output ($receipt | ConvertTo-Json -Depth 4 -Compress)
exit $exitCode
