param([Parameter(Mandatory=$true)][string]$Name,[Parameter(Mandatory=$true)][string]$Launch,[ValidateSet('get','on','off')][string]$Mode='get')
$ErrorActionPreference = 'Stop'
$runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
if ($Mode -eq 'on') {
  if (-not (Test-Path -LiteralPath $runKey)) { $null = New-Item -Path $runKey }
  $null = New-ItemProperty -LiteralPath $runKey -Name $Name -Value $Launch -PropertyType String -Force
} elseif ($Mode -eq 'off' -and (Test-Path -LiteralPath $runKey)) {
  $before = Get-ItemProperty -LiteralPath $runKey
  if ($null -ne $before.PSObject.Properties[$Name]) { Remove-ItemProperty -LiteralPath $runKey -Name $Name }
}
$registered = $null
if (Test-Path -LiteralPath $runKey) { $registered = (Get-ItemProperty -LiteralPath $runKey).PSObject.Properties[$Name] }
if ($Mode -eq 'off' -and $null -ne $registered) { throw 'Startup removal was not verified.' }
if ($null -ne $registered -and $registered.Value -cne $Launch) { throw 'Startup points to another connector installation.' }
[Console]::Out.Write($(if ($null -ne $registered -and $registered.Value -ceq $Launch) { 'true' } else { 'false' }))
