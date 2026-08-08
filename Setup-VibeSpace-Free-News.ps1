#Requires -Version 5.1
[CmdletBinding()]
param(
    [string]$ExistingRepo = (Join-Path $HOME "VibeSpace"),
    [switch]$DoNotOpenBrowser
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$RepoUrl = "https://github.com/Cookie774-GameDev/VibeSpace.git"
$Branch = "agent/pr30-fixes-and-updates"
$Root = Join-Path $env:LOCALAPPDATA "VibeSpaceNewsSetup"
$Repo = Join-Path $Root "repo"
$Worker = Join-Path $Repo "workers\ai-news"
$Log = Join-Path $Root "cloudflare-deploy.log"
$EndpointFile = Join-Path $Root "NEWS_API_URL.txt"

function Step([string]$Message) {
    Write-Host ""
    Write-Host "==> $Message" -ForegroundColor Cyan
}

function Refresh-Path {
    $env:Path = (
        [Environment]::GetEnvironmentVariable("Path", "Machine") + ";" +
        [Environment]::GetEnvironmentVariable("Path", "User")
    )
}

function Run([string]$Command, [string[]]$Arguments, [string]$WorkingDirectory = "") {
    $old = Get-Location
    try {
        if ($WorkingDirectory) { Set-Location $WorkingDirectory }
        & $Command @Arguments
        if ($LASTEXITCODE -ne 0) {
            throw "$Command failed with exit code $LASTEXITCODE."
        }
    }
    finally {
        Set-Location $old
    }
}

function Ensure-Command([string]$Command, [string]$PackageId, [string]$Name) {
    if (Get-Command $Command -ErrorAction SilentlyContinue) { return }
    if (-not (Get-Command "winget.exe" -ErrorAction SilentlyContinue)) {
        throw "$Name is missing and winget is unavailable."
    }

    Step "Installing $Name"
    Run "winget.exe" @(
        "install", "--id", $PackageId, "-e",
        "--accept-package-agreements",
        "--accept-source-agreements",
        "--silent"
    )
    Refresh-Path

    if (-not (Get-Command $Command -ErrorAction SilentlyContinue)) {
        throw "$Name was installed, but PowerShell cannot see it yet. Reopen PowerShell and run this script again."
    }
}

function Set-EnvLine([string]$Path, [string]$Name, [string]$Value) {
    $lines = if (Test-Path $Path) { @(Get-Content -LiteralPath $Path) } else { @() }
    $prefix = "$Name="
    $found = $false

    for ($i = 0; $i -lt $lines.Count; $i++) {
        if ($lines[$i].StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
            $lines[$i] = "$Name=$Value"
            $found = $true
        }
    }

    if (-not $found) { $lines += "$Name=$Value" }
    Set-Content -LiteralPath $Path -Value $lines -Encoding UTF8
}

try {
    Write-Host "VibeSpace PR 31 — Free Hourly AI News Setup" -ForegroundColor Green
    Write-Host "Cloudflare runs the hourly job; this PC can be turned off afterward." -ForegroundColor DarkGray

    New-Item -ItemType Directory -Path $Root -Force | Out-Null
    Ensure-Command "git.exe" "Git.Git" "Git"
    Ensure-Command "node.exe" "OpenJS.NodeJS.LTS" "Node.js LTS"

    $nodeMajor = [int](((& node.exe --version).TrimStart("v") -split "\.")[0])
    if ($nodeMajor -lt 20) {
        throw "Node.js 20 or newer is required."
    }

    Step "Preparing PR 31 workspace"
    $existingIsRepo = Test-Path (Join-Path $ExistingRepo ".git")

    if (Test-Path (Join-Path $Repo ".git")) {
        Run "git.exe" @("-C", $Repo, "fetch", "origin", $Branch, "--prune")
        Run "git.exe" @("-C", $Repo, "reset", "--hard", "origin/$Branch")
    }
    elseif (Test-Path $Repo) {
        throw "Installer workspace exists but is not a Git repository: $Repo"
    }
    elseif ($existingIsRepo) {
        Run "git.exe" @("-C", $ExistingRepo, "fetch", "origin", $Branch, "--prune")
        Run "git.exe" @(
            "-C", $ExistingRepo,
            "worktree", "add", "--force", "--detach",
            $Repo, "origin/$Branch"
        )
    }
    else {
        Run "git.exe" @(
            "clone", "--branch", $Branch, "--single-branch", "--depth", "1",
            $RepoUrl, $Repo
        )
    }

    if (-not (Test-Path (Join-Path $Worker "package.json"))) {
        throw "Worker package not found: $Worker"
    }

    Step "Installing and validating Worker"
    Run "npm.cmd" @("install", "--no-audit", "--no-fund") $Worker
    Run "npm.cmd" @("run", "typecheck") $Worker

    Step "Checking Cloudflare authorization"
    $old = Get-Location
    try {
        Set-Location $Worker
        & npx.cmd wrangler whoami --config wrangler.jsonc *> $null
        $loggedIn = $LASTEXITCODE -eq 0
    }
    finally {
        Set-Location $old
    }

    if (-not $loggedIn) {
        Write-Host "Approve the Cloudflare login page that opens in your browser." -ForegroundColor Yellow
        Run "npx.cmd" @("wrangler", "login") $Worker
    }

    Step "Deploying D1, Worker, and hourly Cron"
    if (Test-Path $Log) { Remove-Item -LiteralPath $Log -Force }

    $old = Get-Location
    try {
        Set-Location $Worker
        & npm.cmd run setup:free 2>&1 | Tee-Object -FilePath $Log
        $deployExit = $LASTEXITCODE
    }
    finally {
        Set-Location $old
    }

    if ($deployExit -ne 0) {
        throw "Deployment failed. See: $Log"
    }

    $text = Get-Content -LiteralPath $Log -Raw
    $matches = [regex]::Matches(
        $text,
        "https://[A-Za-z0-9.-]+\.workers\.dev",
        [Text.RegularExpressions.RegexOptions]::IgnoreCase
    )

    if ($matches.Count -eq 0) {
        throw "Deployment completed, but no workers.dev address was found. See: $Log"
    }

    $baseUrl = $matches[$matches.Count - 1].Value.TrimEnd("/")
    $newsUrl = "$baseUrl/api/news?limit=50"

    Set-Content -LiteralPath $EndpointFile -Value $baseUrl -Encoding UTF8
    [Environment]::SetEnvironmentVariable("VITE_NEWS_API_URL", $baseUrl, "User")
    $env:VITE_NEWS_API_URL = $baseUrl

    if ($existingIsRepo -and (Test-Path (Join-Path $ExistingRepo "app"))) {
        Set-EnvLine (Join-Path $ExistingRepo "app\.env.local") "VITE_NEWS_API_URL" $baseUrl
    }

    Step "Testing live output"
    $health = Invoke-RestMethod -Uri "$baseUrl/health" -TimeoutSec 60
    $news = Invoke-RestMethod -Uri $newsUrl -TimeoutSec 120

    try { Set-Clipboard -Value $newsUrl } catch {}

    Write-Host ""
    Write-Host "SETUP COMPLETE" -ForegroundColor Green
    Write-Host "Cron: 7 minutes after every hour" -ForegroundColor White
    Write-Host "Health: $($health.ok)" -ForegroundColor White
    Write-Host "Stories: $($news.count)" -ForegroundColor White
    Write-Host "News JSON: $newsUrl" -ForegroundColor Cyan
    Write-Host "Saved URL: $EndpointFile" -ForegroundColor DarkGray

    if (-not $DoNotOpenBrowser) { Start-Process $newsUrl }
}
catch {
    Write-Host ""
    Write-Host "SETUP STOPPED" -ForegroundColor Red
    Write-Host $_.Exception.Message -ForegroundColor Red
    exit 1
}
