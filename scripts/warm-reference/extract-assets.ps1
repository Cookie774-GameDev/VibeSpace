param(
  [Parameter(Mandatory = $true)]
  [string] $SourceHtml,

  [Parameter(Mandatory = $true)]
  [string] $OutputRoot
)

$ErrorActionPreference = 'Stop'

$assets = @(
  @{ Name = 'brand-logo.png'; Bytes = 13462; Sha256 = '7b992d8c46528baeb0d123fa9f635413e3aa73a77ec6e731d1ee299bfa31e1a9' },
  @{ Name = 'chat-notebook.png'; Bytes = 100027; Sha256 = '305213eef824a04b1ed8a83006dffc37d67fdfe2f75f39532fdb6397642b0f57' },
  @{ Name = 'files-stationery.png'; Bytes = 164661; Sha256 = '9121cb53df4ed256c9260fc6e4064289d6005fd4188a775a701246ee69d15b73' },
  @{ Name = 'scheduler-center.png'; Bytes = 74158; Sha256 = '03681b34b4587423547c23550c1044518031cfe6ca937488f06ca616f39710b3' },
  @{ Name = 'scheduler-landscape.jpg'; Bytes = 40495; Sha256 = 'fda60fb99315a1a2a4816a68a5361fe93c99b19ded39456706b0d62aef20b207' },
  @{ Name = 'skills-corner.png'; Bytes = 85477; Sha256 = '856aa9514f1858baff4f1f174592123d1e17ed7ba8b494656434a7810fedd625' },
  @{ Name = 'skills-landscape.jpg'; Bytes = 69551; Sha256 = '75133117307f3121b18bec4552abfb265957ba5a43f6e01b0550fcb6013d41b4' },
  @{ Name = 'tools-corner.png'; Bytes = 22968; Sha256 = '143311d2ad5e7e3026391a70062b2e43facf5f6a13a61f0170c08c84f653cb7e' },
  @{ Name = 'tools-landscape.jpg'; Bytes = 39529; Sha256 = '46d26bdfa226a1b56b3a9b3e265d692ae25c8636c2f2d95a4f9c813ffe7895dd' },
  @{ Name = 'kanban-checklist.png'; Bytes = 75379; Sha256 = '7996c901da622357fa841d621a765cde9ef3898cd319a52456ee356f85f8c9e0' },
  @{ Name = 'kanban-milestone.png'; Bytes = 66060; Sha256 = '541b113632edaaff7221349b14446bf47687b6f10f6ccf57b9d199f97bd5de80' }
)

$resolvedSource = (Resolve-Path -LiteralPath $SourceHtml).Path
$resolvedOutput = [IO.Path]::GetFullPath($OutputRoot)
$html = [IO.File]::ReadAllText($resolvedSource)
$matches = [regex]::Matches(
  $html,
  'data:([^;,]+);base64,([A-Za-z0-9+/=\r\n]+)',
  [Text.RegularExpressions.RegexOptions]::CultureInvariant
)

if ($matches.Count -ne $assets.Count) {
  throw "Expected $($assets.Count) embedded assets, found $($matches.Count)."
}

[IO.Directory]::CreateDirectory($resolvedOutput) | Out-Null

for ($index = 0; $index -lt $assets.Count; $index += 1) {
  $asset = $assets[$index]
  $payload = $matches[$index].Groups[2].Value -replace '\s', ''
  $bytes = [Convert]::FromBase64String($payload)
  $sha256 = [Convert]::ToHexString(
    [Security.Cryptography.SHA256]::HashData($bytes)
  ).ToLowerInvariant()

  if ($bytes.Length -ne $asset.Bytes) {
    throw "$($asset.Name) byte mismatch: expected $($asset.Bytes), found $($bytes.Length)."
  }
  if ($sha256 -ne $asset.Sha256) {
    throw "$($asset.Name) SHA-256 mismatch: expected $($asset.Sha256), found $sha256."
  }

  [IO.File]::WriteAllBytes((Join-Path $resolvedOutput $asset.Name), $bytes)
}

Write-Output "Extracted $($assets.Count) verified Warm reference assets to $resolvedOutput."
