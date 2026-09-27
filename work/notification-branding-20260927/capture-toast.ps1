param(
  [Parameter(Mandatory)][string]$OutputPath,
  [Parameter(Mandatory)][ValidateSet('Full', 'Toast', 'NotificationCenter', 'Taskbar')][string]$Capture,
  [int]$TargetPid = 1060
)

$ErrorActionPreference = 'Stop'
$compilerTemp = Join-Path $PSScriptRoot '.tc28-native-capture-tmp'
if (-not (Test-Path -LiteralPath $compilerTemp -PathType Container)) {
  New-Item -ItemType Directory -Path $compilerTemp | Out-Null
}
$env:TEMP = $compilerTemp
$env:TMP = $compilerTemp
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
$nativeAssembly = Join-Path $compilerTemp 'tc28-native-capture.dll'
$nativeSource = @'
using System;
using System.Runtime.InteropServices;
public static class VibeSpaceNativeCaptureV1 {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint from, uint to, bool attach);
  [DllImport("user32.dll")] public static extern IntPtr SetActiveWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern IntPtr SetFocus(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] public static extern void SwitchToThisWindow(IntPtr hWnd, bool altTab);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr FindWindow(string className, string windowName);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int index);
  [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr dpiContext);
  [DllImport("user32.dll")] public static extern void keybd_event(byte key, byte scan, uint flags, UIntPtr extraInfo);
}
'@
if (Test-Path -LiteralPath $nativeAssembly -PathType Leaf) {
  Add-Type -Path $nativeAssembly
} else {
  Add-Type -TypeDefinition $nativeSource -OutputAssembly $nativeAssembly | Out-Null
  Add-Type -Path $nativeAssembly
}

function Send-Key([byte]$Key) {
  [VibeSpaceNativeCaptureV1]::keybd_event($Key, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 70
  [VibeSpaceNativeCaptureV1]::keybd_event($Key, 0, 2, [UIntPtr]::Zero)
}

function Send-WinN {
  [VibeSpaceNativeCaptureV1]::keybd_event(0x5B, 0, 0, [UIntPtr]::Zero)
  [VibeSpaceNativeCaptureV1]::keybd_event(0x4E, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 80
  [VibeSpaceNativeCaptureV1]::keybd_event(0x4E, 0, 2, [UIntPtr]::Zero)
  [VibeSpaceNativeCaptureV1]::keybd_event(0x5B, 0, 2, [UIntPtr]::Zero)
}

# The Windows PowerShell process is DPI-unaware by default on this host. Switch
# this capture thread to per-monitor-v2 so Win32 bounds, cursor positions, and
# CopyFromScreen all use the same physical pixels as the native WebView.
$previousDpiContext = [VibeSpaceNativeCaptureV1]::SetThreadDpiAwarenessContext([IntPtr](-4))
if ($previousDpiContext -eq [IntPtr]::Zero) { throw 'Could not set per-monitor DPI awareness for physical-pixel native capture.' }

$target = Get-Process -Id $TargetPid
if ($target.MainWindowHandle -eq 0) { throw "Target PID $TargetPid has no main window handle." }
$hwnd = [IntPtr]$target.MainWindowHandle
$targetNativePid = [uint32]0
$targetThread = [VibeSpaceNativeCaptureV1]::GetWindowThreadProcessId($hwnd, [ref]$targetNativePid)
if ($targetNativePid -ne $TargetPid) { throw "Window handle $hwnd is PID $targetNativePid, expected C2 PID $TargetPid." }
$oldForeground = [VibeSpaceNativeCaptureV1]::GetForegroundWindow()
$oldForegroundPid = [uint32]0
$oldForegroundThread = [VibeSpaceNativeCaptureV1]::GetWindowThreadProcessId($oldForeground, [ref]$oldForegroundPid)
$currentThread = [VibeSpaceNativeCaptureV1]::GetCurrentThreadId()
$attachedOld = $false
$attachedTarget = $false
try {
  $attachedOld = [VibeSpaceNativeCaptureV1]::AttachThreadInput($currentThread, $oldForegroundThread, $true)
  $attachedTarget = [VibeSpaceNativeCaptureV1]::AttachThreadInput($currentThread, $targetThread, $true)
  [void][VibeSpaceNativeCaptureV1]::ShowWindow($hwnd, 9)
  # Temporarily raise only the already-verified C2 window so Windows permits
  # the native foreground transition; restore its previous non-topmost state.
  [void][VibeSpaceNativeCaptureV1]::SetWindowPos($hwnd, [IntPtr](-1), 0, 0, 0, 0, 0x0003 -bor 0x0040)
  [VibeSpaceNativeCaptureV1]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero)
  [VibeSpaceNativeCaptureV1]::SwitchToThisWindow($hwnd, $true)
  [void][VibeSpaceNativeCaptureV1]::SetForegroundWindow($hwnd)
  [void][VibeSpaceNativeCaptureV1]::SetActiveWindow($hwnd)
  [void][VibeSpaceNativeCaptureV1]::SetFocus($hwnd)
  [VibeSpaceNativeCaptureV1]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero)
} finally {
  [VibeSpaceNativeCaptureV1]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero)
  [void][VibeSpaceNativeCaptureV1]::SetWindowPos($hwnd, [IntPtr](-2), 0, 0, 0, 0, 0x0003 -bor 0x0040)
  if ($attachedTarget) { [void][VibeSpaceNativeCaptureV1]::AttachThreadInput($currentThread, $targetThread, $false) }
  if ($attachedOld) { [void][VibeSpaceNativeCaptureV1]::AttachThreadInput($currentThread, $oldForegroundThread, $false) }
}
$foregroundPid = 0
$foreground = [VibeSpaceNativeCaptureV1]::GetForegroundWindow()
[void][VibeSpaceNativeCaptureV1]::GetWindowThreadProcessId($foreground, [ref]$foregroundPid)
if ($foregroundPid -ne $TargetPid) { throw "Could not foreground authorized C2 PID $TargetPid; current foreground PID is $foregroundPid." }

$physicalWidth = [VibeSpaceNativeCaptureV1]::GetSystemMetrics(0)
$physicalHeight = [VibeSpaceNativeCaptureV1]::GetSystemMetrics(1)
if ($physicalWidth -le 0 -or $physicalHeight -le 0) { throw "Invalid physical display bounds ${physicalWidth}x${physicalHeight}." }
$screen = [System.Drawing.Rectangle]::new(0, 0, $physicalWidth, $physicalHeight)
$source = $screen
switch ($Capture) {
  'Full' {
    $source = $screen
  }
  'Toast' {
    Start-Sleep -Milliseconds 250
    # Windows app toasts appear above the taskbar at the lower-right. Keep the
    # evidence crop narrow so unrelated desktop/application content is omitted.
    $width = [Math]::Min(620, $screen.Width)
    $height = [Math]::Min(430, $screen.Height)
    $source = New-Object System.Drawing.Rectangle ($screen.Right - $width), ($screen.Bottom - $height), $width, $height
  }
  'NotificationCenter' {
    Send-WinN
    Start-Sleep -Milliseconds 1000
    $width = [Math]::Min(560, $screen.Width)
    $source = New-Object System.Drawing.Rectangle ($screen.Right - $width), $screen.Top, $width, $screen.Height
  }
  'Taskbar' {
    [void][VibeSpaceNativeCaptureV1]::SetCursorPos([int]($screen.Left + $screen.Width / 2), [int]($screen.Bottom - 1))
    Start-Sleep -Milliseconds 900
    $taskbar = [VibeSpaceNativeCaptureV1]::FindWindow('Shell_TrayWnd', $null)
    if ($taskbar -eq [IntPtr]::Zero) { throw 'Windows taskbar window was not found.' }
    $rect = New-Object VibeSpaceNativeCaptureV1+RECT
    if (-not [VibeSpaceNativeCaptureV1]::GetWindowRect($taskbar, [ref]$rect)) { throw 'Could not read Windows taskbar bounds.' }
    $left = [Math]::Max($screen.Left, $rect.Left)
    $top = [Math]::Max($screen.Top, $rect.Top - 12)
    $right = [Math]::Min($screen.Right, $rect.Right)
    $bottom = [Math]::Min($screen.Bottom, [Math]::Max($rect.Bottom + 12, $top + 72))
    $source = New-Object System.Drawing.Rectangle $left, $top, ($right - $left), ($bottom - $top)
    Write-Output ("C2 foreground PID={0}; taskbar HWND={1}; bounds={2},{3},{4},{5}" -f $TargetPid, $taskbar, $rect.Left, $rect.Top, $rect.Right, $rect.Bottom)
  }
}

$bitmap = New-Object System.Drawing.Bitmap $source.Width, $source.Height
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
try {
  $graphics.CopyFromScreen($source.Location, [System.Drawing.Point]::Empty, $source.Size)
  $bitmap.Save($OutputPath, [System.Drawing.Imaging.ImageFormat]::Png)
  Write-Output ("Captured {0} region {1},{2},{3},{4} to {5}; foreground PID={6}" -f $Capture, $source.Left, $source.Top, $source.Width, $source.Height, $OutputPath, $foregroundPid)
} finally {
  $graphics.Dispose()
  $bitmap.Dispose()
}

if ($Capture -eq 'NotificationCenter') {
  Send-Key 0x1B
  Start-Sleep -Milliseconds 200
}
