$ErrorActionPreference = 'Stop'
$appPid = 24748
$expectedTitle = 'VibeSpace - Live C1 CH31'
$output = Join-Path $PSScriptRoot ('c1-root-window-bounce-' + [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() + '.json')

Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class C1WindowApi {
  [StructLayout(LayoutKind.Sequential)]
  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int command);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr insertAfter, int x, int y, int width, int height, uint flags);
}
'@

$process = Get-Process -Id $appPid
if ($process.MainWindowTitle -ne $expectedTitle) { throw 'C1 main-window title changed' }
$handle = [IntPtr]$process.MainWindowHandle
if ($handle -eq [IntPtr]::Zero) { throw 'C1 has no main window' }
$windowPid = [uint32]0
[void][C1WindowApi]::GetWindowThreadProcessId($handle, [ref]$windowPid)
if ($windowPid -ne $appPid) { throw 'Main window belongs to a different process' }
$before = [C1WindowApi+RECT]::new()
if (-not [C1WindowApi]::GetWindowRect($handle, [ref]$before)) { throw 'Could not read C1 window bounds' }
$wasMinimized = [C1WindowApi]::IsIconic($handle)
$width = $before.Right - $before.Left
$height = $before.Bottom - $before.Top
if ($width -lt 500 -or $height -lt 400) { throw 'C1 window bounds unexpectedly small' }
$flags = [uint32]0x16 # SWP_NOMOVE | SWP_NOZORDER | SWP_NOACTIVATE
$first = [C1WindowApi]::SetWindowPos($handle, [IntPtr]::Zero, 0, 0, $width - 1, $height, $flags)
$second = [C1WindowApi]::SetWindowPos($handle, [IntPtr]::Zero, 0, 0, $width, $height, $flags)
$after = [C1WindowApi+RECT]::new()
[void][C1WindowApi]::GetWindowRect($handle, [ref]$after)
$receipt = [ordered]@{
  atUtc = [DateTime]::UtcNow.ToString('o')
  appPid = $appPid
  windowPid = $windowPid
  handle = $handle.ToInt64()
  wasMinimized = $wasMinimized
  before = @{ left = $before.Left; top = $before.Top; width = $width; height = $height }
  resizeDown = $first
  resizeRestore = $second
  after = @{ left = $after.Left; top = $after.Top; width = $after.Right - $after.Left; height = $after.Bottom - $after.Top }
}
$receipt | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $output
$receipt | ConvertTo-Json -Depth 4
if (-not $first -or -not $second) { exit 1 }
