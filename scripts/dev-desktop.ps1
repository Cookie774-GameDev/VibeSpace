# VibeSpace desktop dev launcher (no app source changes).
# Fixes white-screen dev loads when Vite binds IPv6-only but Tauri hits 127.0.0.1.
$ErrorActionPreference = "Stop"
$Root = Split-Path $PSScriptRoot -Parent

Write-Host "VibeSpace dev: freeing port 5173..."
Get-NetTCPConnection -LocalPort 5173 -ErrorAction SilentlyContinue |
  ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }

$viteCache = Join-Path $Root "app\node_modules\.vite"
if (Test-Path $viteCache) {
  Write-Host "VibeSpace dev: clearing Vite cache..."
  Remove-Item -Recurse -Force $viteCache
}

$env:TAURI_DEV_HOST = "127.0.0.1"
$env:CARGO_TARGET_DIR = Join-Path $Root "app\src-tauri\target"
$env:CARGO_BUILD_JOBS = "1"

Set-Location $Root
Write-Host "VibeSpace dev: starting tauri:dev (Vite on 127.0.0.1:5173)..."
npm run tauri:dev
