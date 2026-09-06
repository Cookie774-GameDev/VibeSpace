$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
# AppsFolder is Windows' launchable application inventory (desktop and Store apps).
$shell = New-Object -ComObject Shell.Application
$folder = $shell.Namespace('shell:AppsFolder')
if ($null -eq $folder) { throw 'Windows application inventory unavailable' }
$packagePaths = @{}
Get-AppxPackage -ErrorAction SilentlyContinue | ForEach-Object {
    $package = $_
    try {
        $manifest = Get-AppxPackageManifest -Package $package.PackageFullName -ErrorAction Stop
        foreach ($application in $manifest.Package.Applications.Application) {
            if ($application.Executable) {
                $candidate = Join-Path $package.InstallLocation $application.Executable
                if ([IO.File]::Exists($candidate)) {
                    $packagePaths[($package.PackageFamilyName + '!' + $application.Id)] = $candidate
                }
            }
        }
    } catch { } # An inaccessible package must not hide other installed apps.
}
$rows = @($folder.Items() | ForEach-Object {
    $appId = [string]$_.ExtendedProperty('System.AppUserModel.ID')
    if ($appId -and $_.Name) {
        $target = [string]$_.ExtendedProperty('System.Link.TargetParsingPath')
        if ($packagePaths.ContainsKey($appId)) { $target = $packagePaths[$appId] }
        if (-not $target.EndsWith('.exe', [StringComparison]::OrdinalIgnoreCase) -or -not [IO.File]::Exists($target)) {
            $target = $null
        }
        [pscustomobject]@{ name = [string]$_.Name; appId = $appId; path = $target }
    }
})
ConvertTo-Json -InputObject $rows -Compress -Depth 3
