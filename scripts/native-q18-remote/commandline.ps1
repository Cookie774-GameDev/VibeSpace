function Test-WebViewArguments {
  param([string]$CommandLine,[string]$Profile,[int]$Port)
  $normalized = $CommandLine.Replace('/','\')
  $profiles = [regex]::Matches($normalized,'(?:^|\s)--user-data-dir(?:=|\s+)(?:"([^"]+)"|([^\s"]+))(?=\s|$)')
  $ports = [regex]::Matches($CommandLine,'(?:^|\s)--remote-debugging-port(?:=|\s+)([0-9]+)(?=\s|$)')
  $profileMatches = $false
  $portMatches = $false
  if ($profiles.Count -eq 1) {
    $actual = if ($profiles[0].Groups[1].Success) { $profiles[0].Groups[1].Value } else { $profiles[0].Groups[2].Value }
    $profileMatches = $actual -ieq $Profile.Replace('/','\')
  }
  if ($ports.Count -eq 1) {
    $parsed = 0
    $portMatches = [int]::TryParse($ports[0].Groups[1].Value,[ref]$parsed) -and $parsed -eq $Port -and $Port -ge 1024 -and $Port -le 65535
  }
  [ordered]@{ profileMatches=[bool]$profileMatches; portMatches=[bool]$portMatches }
}
function Test-ViteArguments {
  param([string]$CommandLine,[string]$Workspace)
  $matches = [regex]::Matches($CommandLine,'(?:"([^"]*)"|([^\s"]+))')
  $tokens = [Collections.Generic.List[string]]::new()
  $end = 0
  foreach ($m in $matches) {
    if ($CommandLine.Substring($end,$m.Index-$end).Trim().Length) { return $false }
    $tokens.Add($(if ($m.Groups[1].Success) { $m.Groups[1].Value } else { $m.Groups[2].Value }))
    $end = $m.Index+$m.Length
  }
  if ($CommandLine.Substring($end).Trim().Length -or $tokens.Count -ne 8) { return $false }
  $root = $Workspace.Replace('/','\').TrimEnd('\')
  ($tokens[1].Replace('/','\') -ieq "$root\node_modules\vite\bin\vite.js") -and
    ($tokens[2].Replace('/','\') -ieq "$root\app") -and
    ($tokens[3] -ceq '--host') -and ($tokens[4] -ceq '127.0.0.1') -and
    ($tokens[5] -ceq '--port') -and ($tokens[6] -ceq '5173') -and ($tokens[7] -ceq '--strictPort')
}
