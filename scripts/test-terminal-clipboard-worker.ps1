$ErrorActionPreference = 'Stop'
$repository = Split-Path $PSScriptRoot -Parent
$fixtureRoot = Join-Path $repository 'work/chat-repair/clipboard-fixture'
[IO.Directory]::CreateDirectory($fixtureRoot) | Out-Null
$fixtureFile = Join-Path $fixtureRoot "O'Brien file.txt"
[IO.File]::WriteAllText($fixtureFile, 'fixture')
$script = [IO.File]::ReadAllText((Join-Path $repository 'app/src-tauri/src/terminal_clipboard.ps1'))
# Substitute only the OS snapshot acquisition. The actual clipboard is never read or changed.
$script = $script.Replace('[System.Windows.Forms.Clipboard]::GetDataObject()', '(New-ClipboardFixture)')
$fixture = @'
$script:fixtureRead = 0
function New-ClipboardFixture {
    $script:fixtureRead++
    $value = [pscustomobject]@{}
    $value | Add-Member ScriptMethod GetDataPresent {
        param($format)
        if ($script:fixtureRead -eq 1) { return $format -eq [System.Windows.Forms.DataFormats]::FileDrop }
        if ($script:fixtureRead -eq 2) { return $format -eq [System.Windows.Forms.DataFormats]::Bitmap }
        return $format -eq [System.Windows.Forms.DataFormats]::UnicodeText
    }
    $value | Add-Member ScriptMethod GetData {
        param($format)
        if ($script:fixtureRead -eq 1) { return @($env:VIBESPACE_CLIPBOARD_FIXTURE) }
        if ($script:fixtureRead -eq 2) { return [System.Drawing.Bitmap]::new(2, 3) }
        return "exact text`nsecond line"
    }
    return $value
}
'@
$start = [Diagnostics.ProcessStartInfo]::new()
$start.FileName = Join-Path $env:SystemRoot 'System32/WindowsPowerShell/v1.0/powershell.exe'
$start.Arguments = '-NoProfile -NonInteractive -STA -EncodedCommand ' + [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($fixture + "`n" + $script))
$start.UseShellExecute = $false
$start.CreateNoWindow = $true
$start.RedirectStandardInput = $true
$start.RedirectStandardOutput = $true
$start.RedirectStandardError = $true
$start.StandardOutputEncoding = [Text.UTF8Encoding]::new($false)
$start.EnvironmentVariables['VIBESPACE_CLIPBOARD_SERVER'] = '1'
$start.EnvironmentVariables['VIBESPACE_CLIPBOARD_DIR'] = $fixtureRoot
$start.EnvironmentVariables['VIBESPACE_CLIPBOARD_FIXTURE'] = $fixtureFile
$process = [Diagnostics.Process]::Start($start)
try {
    $results = @()
    $times = @()
    1..3 | ForEach-Object {
        $timer = [Diagnostics.Stopwatch]::StartNew()
        $process.StandardInput.WriteLine('read')
        $process.StandardInput.Flush()
        $line = $process.StandardOutput.ReadLineAsync()
        if (-not $line.Wait(15000)) { throw 'Clipboard fixture timed out' }
        $results += ($line.Result | ConvertFrom-Json)
        $times += $timer.ElapsedMilliseconds
    }
    if ($results[0].paths[0] -ne $fixtureFile) { throw 'File path was not preserved' }
    if (-not [IO.File]::Exists($results[1].paths[0])) { throw 'Bitmap was not saved' }
    if (-not $results[1].paths[0].StartsWith($fixtureRoot + [IO.Path]::DirectorySeparatorChar)) { throw 'Bitmap escaped clipboard storage' }
    if ($results[2].text -ne "exact text`nsecond line") { throw 'Text was not preserved' }
    $process.StandardInput.Close()
    if (-not $process.WaitForExit(5000)) { throw 'Worker did not exit after parent EOF' }
    if ($process.ExitCode -ne 0) { throw 'Worker exited with an error' }
    [pscustomobject]@{ result = 'PASS'; requests = 3; processes = 1; requestMilliseconds = $times; parentEofExit = $true } | ConvertTo-Json -Compress
} finally {
    if (-not $process.HasExited) { $process.Kill(); $process.WaitForExit() }
    $process.Dispose()
}
