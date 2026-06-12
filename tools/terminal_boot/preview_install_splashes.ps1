# Preview all three VibeSpace install splash variants in separate terminal tabs.
$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$splash = Join-Path $here "vibespace_install_splash.py"
$python = $null
$pythonPrefix = @()
foreach ($candidate in @(
    @{ Exe = "py"; Prefix = @("-3") },
    @{ Exe = "python"; Prefix = @() },
    @{ Exe = "python3"; Prefix = @() }
)) {
    if (Get-Command $candidate.Exe -ErrorAction SilentlyContinue) {
        $python = $candidate.Exe
        $pythonPrefix = $candidate.Prefix
        break
    }
}
if (-not $python) {
    Write-Host "Python not found. Install Python 3 to preview splashes." -ForegroundColor Red
    exit 1
}

$variants = @("nebula", "aurora", "prism")
$wt = Get-Command wt -ErrorAction SilentlyContinue

if ($wt) {
    $args = @("new-tab", "--title", "VibeSpace · Nebula", $python) + $pythonPrefix + @($splash, "--demo", "--variant", "nebula", "--hold", "30")
    foreach ($v in @("aurora", "prism")) {
        $label = $v.Substring(0,1).ToUpper() + $v.Substring(1)
        $args += @(";", "new-tab", "--title", "VibeSpace · $label", $python) + $pythonPrefix + @($splash, "--demo", "--variant", $v, "--hold", "30")
    }
    Start-Process wt -ArgumentList $args -WorkingDirectory $here
    Write-Host "Opened Windows Terminal with 3 splash previews (nebula, aurora, prism)." -ForegroundColor Green
} else {
    foreach ($v in $variants) {
        $title = "VibeSpace · $($v.Substring(0,1).ToUpper() + $v.Substring(1))"
        $argLine = ($pythonPrefix + @($splash, "--demo", "--variant", $v, "--hold", "30") | ForEach-Object {
            if ($_ -match '\s') { '"' + ($_ -replace '"', '""') + '"' } else { $_ }
        }) -join ' '
        Start-Process powershell -ArgumentList @(
            "-NoExit", "-NoProfile", "-Command",
            "`$Host.UI.RawUI.WindowTitle = '$title'; Set-Location '$here'; & '$python' $argLine"
        )
        Start-Sleep -Milliseconds 400
    }
    Write-Host "Opened 3 PowerShell windows with splash previews." -ForegroundColor Green
}

Write-Host ""
Write-Host "Pick your favorite, then tell the agent: nebula, aurora, or prism." -ForegroundColor Cyan
