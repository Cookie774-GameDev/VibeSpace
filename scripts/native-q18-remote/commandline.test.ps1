$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'commandline.ps1')
$profile='D:\a\_temp\owned profile'
$tabline = 'msedgewebview2.exe{0}--user-data-dir={1}D:\a\_temp\owned profile{1}{0}--remote-debugging-port{0}9228' -f [char]9,[char]34
$cases=@(
  @('"C:\Program Files\Microsoft\EdgeWebView\msedgewebview2.exe" --user-data-dir="D:\a\_temp\owned profile" --remote-debugging-port=9228',$true,$true),
  @('msedgewebview2.exe --user-data-dir D:\a\_temp\owned --remote-debugging-port 9228',$false,$true),
  @('msedgewebview2.exe --user-data-dir="D:\a\_temp\owned profile-peer" --remote-debugging-port=9228',$false,$true),
  @('msedgewebview2.exe --user-data-dir="D:\a\_temp\wrong" --remote-debugging-port=9228',$false,$true),
  @('msedgewebview2.exe --user-data-dir="D:\a\_temp\owned profile" --remote-debugging-port=92280',$true,$false),
  @('msedgewebview2.exe --user-data-dir="D:\a\_temp\owned profile" --remote-debugging-port=9227',$true,$false),
  @('msedgewebview2.exe --user-data-dir="D:\a\_temp\owned profile" x--remote-debugging-port=9228',$true,$false),
  @('msedgewebview2.exe --user-data-dir=D:\a\_temp\owned profile --remote-debugging-port=9228',$false,$true),
  @('msedgewebview2.exe --user-data-dir="D:\a\_temp\owned profile" --remote-debugging-port=9228 --remote-debugging-port=9228',$true,$false),
  @('msedgewebview2.exe --user-data-dir="D:\a\_temp\owned profile" --user-data-dir=foreign --remote-debugging-port=9228',$false,$true),
  @($tabline,$true,$true)
)
$count=0
foreach ($c in $cases) {
  $v=Test-WebViewArguments $c[0] $profile 9228
  if ($v.profileMatches -cne $c[1] -or $v.portMatches -cne $c[2]) { throw "collector_fixture_$count" }
  $count++
}
$unquoted=Test-WebViewArguments 'msedgewebview2.exe --user-data-dir=D:\a\_temp\owned --remote-debugging-port=9228' 'D:\a\_temp\owned' 9228
if (-not $unquoted.profileMatches -or -not $unquoted.portMatches) { throw 'collector_unquoted_fixture' }
$count++
$root='D:\a\workspace with spaces'
$good='"C:\Program Files\nodejs\node.exe" "D:\a\workspace with spaces\node_modules\vite\bin\vite.js" "D:\a\workspace with spaces\app" --host 127.0.0.1 --port 5173 --strictPort'
if (-not (Test-ViteArguments $good $root)) { throw 'vite_quoted_positive' }
$count++
foreach ($bad in @($good.Replace('\app"','\app-peer"'),$good.Replace('5173','51730'),$good.Replace('127.0.0.1','0.0.0.0'),$good.Replace('--strictPort','--strictPorts'))) {
  if (Test-ViteArguments $bad $root) { throw 'vite_negative' }
  $count++
}
[ordered]@{ tests=$count; passed=$count; failed=0; skipped=0; scope='Pure Windows commandline parsing; no process/collector/UI/native launch' } | ConvertTo-Json -Compress
