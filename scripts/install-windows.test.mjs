import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const script = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../install/install.ps1');
const harness = String.raw`
param([string]$Source,[string]$Fixture)
$ErrorActionPreference='Stop'
Import-Module (Join-Path $PSHOME 'Modules/Microsoft.PowerShell.Utility') -ErrorAction Stop
Import-Module (Join-Path $PSHOME 'Modules/Microsoft.PowerShell.Management') -ErrorAction Stop
$tokens=$null; $errors=$null
$ast=[System.Management.Automation.Language.Parser]::ParseFile($Source,[ref]$tokens,[ref]$errors)
if($errors.Count){throw ($errors.Message -join '; ')}
$functions=$ast.FindAll({param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst]},$true)
Invoke-Expression (($functions.Extent.Text) -join [Environment]::NewLine)
$results=[Collections.Generic.List[object]]::new()
function Case([string]$CaseName,[scriptblock]$Body){
 try { & $Body; $results.Add([pscustomobject]@{name=$CaseName;pass=$true}) }
 catch { $results.Add([pscustomobject]@{name=$CaseName;pass=$false;error=$_.Exception.Message}) }
}
function Equal($Actual,$Expected){if($Actual -cne $Expected){throw 'Unexpected result'}}
function Reject([scriptblock]$Body,[string]$Pattern){
 try{& $Body | Out-Null}catch{if($_.Exception.Message -match $Pattern){return};throw}
 throw 'Expected refusal'
}
$version='1.5.0';$name='VibeSpace_1.5.0_x64-setup.exe'
$hash='a'*64
Case 'semantic version and optional v normalization' {Equal (Assert-VibeSpaceVersion 'v1.5.0-rc.2') '1.5.0-rc.2'}
Case 'invalid version cannot inject a path or command' {foreach($v in @('../1.5.0','1.5.0;calc','01.5.0','1.5')){Reject {Assert-VibeSpaceVersion $v} 'Invalid release version'}}
Case 'documented Windows 10 1809 boundary and newer x64 are admitted' {Assert-VibeSpacePlatform 'Win32NT' 'AMD64' 17763;Assert-VibeSpacePlatform 'Win32NT' 'AMD64' 19041}
Case 'unsupported architecture and below documented Windows boundary refuse' {Reject {Assert-VibeSpacePlatform 'Win32NT' 'ARM64' 22631} 'requires Windows';Reject {Assert-VibeSpacePlatform 'Win32NT' 'AMD64' 17762} 'requires Windows';Reject {Assert-VibeSpacePlatform 'Unix' 'AMD64' 22631} 'requires Windows'}
Case 'checksum accepts BOM comments and GNU binary marker' {Equal (Get-VibeSpaceChecksum (([char]0xFEFF)+'# sums'+[Environment]::NewLine+$hash+' *'+$name) $name) $hash}
Case 'duplicate hash declarations fail closed' {Reject {Get-VibeSpaceChecksum ($hash+'  '+$name+[Environment]::NewLine+$hash+'  '+$name) $name} 'exactly one'}
Case 'checksum cannot match a prefix or another file' {Reject {Get-VibeSpaceChecksum ($hash+'  '+$name+'.other') $name} 'exactly one'}
Case 'malformed hashes and path names fail closed' {Reject {Get-VibeSpaceChecksum ('zzz  '+$name) $name} 'Invalid release checksum';Reject {Get-VibeSpaceChecksum ($hash+'  '+$name) '../bad.exe'} 'Invalid release checksum'}
$url='https://github.com/Cookie774-GameDev/VibeSpace/releases/download/v1.5.0/'+$name
$asset=[pscustomobject]@{name=$name;size=42;browser_download_url=$url}
$release=[pscustomobject]@{tag_name='v1.5.0';draft=$false;assets=@($asset)}
Case 'canonical release asset selected without name guessing' {Equal (Select-VibeSpaceReleaseAsset $release $version).name $name}
Case 'wrong repository or release URL refuses download' {Reject {Assert-VibeSpaceReleaseUrl ($url -replace 'Cookie774-GameDev','other') 'v1.5.0' $name} 'does not belong';Reject {Assert-VibeSpaceReleaseUrl ($url+'?token=x') 'v1.5.0' $name} 'does not belong'}
Case 'duplicate and missing installer assets fail closed' {$duplicate=[pscustomobject]@{tag_name='v1.5.0';draft=$false;assets=@($asset,$asset)};Reject {Select-VibeSpaceReleaseAsset $duplicate $version} 'Duplicate';$empty=[pscustomobject]@{tag_name='v1.5.0';draft=$false;assets=@()};Reject {Select-VibeSpaceReleaseAsset $empty $version} 'no supported'}
Case 'draft and mismatched release version refuse' {$bad=[pscustomobject]@{tag_name='v1.5.1';draft=$false;assets=@($asset)};Reject {Select-VibeSpaceReleaseAsset $bad $version} 'identity';$bad.tag_name='v1.5.0';$bad.draft=$true;Reject {Select-VibeSpaceReleaseAsset $bad $version} 'identity'}
$payload=Join-Path $Fixture 'installer with spaces & symbols.exe'
[IO.File]::WriteAllText($payload,'synthetic installer, never executed')
$payloadHash=(Get-FileHash -LiteralPath $payload -Algorithm SHA256).Hash.ToLowerInvariant()
$script:launches=0;$script:launchArguments=$null
function Start-Process {param($FilePath,$Wait,$PassThru,$ArgumentList) $script:launches++;$script:launchArguments=$PSBoundParameters;[pscustomobject]@{ExitCode=0}}
Case 'dry-run verifies bytes without executing installer' {$result=Invoke-VibeSpaceVerifiedInstaller $payload $payloadHash -DryRun;Equal $result.Status 'Verified';Equal $result.Installed $false;Equal $script:launches 0}
Case 'hash mismatch never invokes installer' {Reject {Invoke-VibeSpaceVerifiedInstaller $payload ('b'*64)} 'checksum mismatch';Equal $script:launches 0}
Case 'silent launch keeps path separate from arguments' {$result=Invoke-VibeSpaceVerifiedInstaller $payload $payloadHash -Silent;Equal $result.Installed $true;Equal $script:launchArguments.FilePath $payload;Equal $script:launchArguments.ArgumentList[0] '/S';Equal $script:launches 1}
Case 'interactive launch contains no silent or elevated argument' {$null=Invoke-VibeSpaceVerifiedInstaller $payload $payloadHash;Equal $script:launchArguments.ContainsKey('ArgumentList') $false;Equal $script:launchArguments.ContainsKey('Verb') $false}
Case 'failed installer preserves file and reports recovery' {function Start-Process {param($FilePath,$Wait,$PassThru,$ArgumentList) [pscustomobject]@{ExitCode=1603}};Reject {Invoke-VibeSpaceVerifiedInstaller $payload $payloadHash} 'exit code 1603';Equal (Test-Path -LiteralPath $payload) $true}
Case 'verified file is bound against modification during launch' {function Start-Process {param($FilePath,$Wait,$PassThru,$ArgumentList) Reject {[IO.File]::WriteAllText($FilePath,'replacement')} 'another process|used by|access';[pscustomobject]@{ExitCode=0}};$null=Invoke-VibeSpaceVerifiedInstaller $payload $payloadHash;Equal (Get-FileHash -LiteralPath $payload -Algorithm SHA256).Hash.ToLowerInvariant() $payloadHash}
$checkout=Join-Path $Fixture 'clean checkout';$installerRoot=Join-Path $checkout 'install';$releaseRoot=Join-Path $checkout 'releases'
[void][IO.Directory]::CreateDirectory($installerRoot);[void][IO.Directory]::CreateDirectory($releaseRoot)
[IO.File]::WriteAllText((Join-Path $checkout 'package.json'),'{"version":"1.5.0"}')
$localPayload=Join-Path $releaseRoot $name
[IO.File]::Copy($payload,$localPayload)
[IO.File]::WriteAllText((Join-Path $releaseRoot 'SHA256SUMS.txt'),$payloadHash+'  '+$name)
$profile=Join-Path $checkout 'existing profile.json';[IO.File]::WriteAllText($profile,'saved setting sentinel')
$env:JARVIS_LOCAL='1';$env:JARVIS_DRYRUN='1';$env:JARVIS_VERSION='';$env:JARVIS_FORMAT='nsis';$env:JARVIS_SILENT=''
Case 'offline local release verifies without network or profile mutation' {function Invoke-RestMethod {throw 'Unexpected network'};function Invoke-WebRequest {throw 'Unexpected network'};$result=Invoke-VibeSpaceWindowsInstall $installerRoot;Equal $result.Status 'Verified';Equal ([IO.File]::ReadAllText($profile)) 'saved setting sentinel'}
Case 'failed local checksum is recoverable and preserves settings' {[IO.File]::WriteAllText((Join-Path $releaseRoot 'SHA256SUMS.txt'),('b'*64)+'  '+$name);Reject {Invoke-VibeSpaceWindowsInstall $installerRoot} 'checksum mismatch';Equal ([IO.File]::ReadAllText($profile)) 'saved setting sentinel'}
Case 'local mode from pasted one-liner gives saved-file recovery' {Reject {Invoke-VibeSpaceWindowsInstall ''} 'saved install/install.ps1'}
Case 'unsupported format is refused before network or execution' {$env:JARVIS_FORMAT='msi';Reject {Invoke-VibeSpaceWindowsInstall $installerRoot} 'supports JARVIS_FORMAT=nsis'}
$results | ConvertTo-Json -Depth 5 -Compress
if(@($results | Where-Object {-not $_.pass}).Count){exit 1}
`;

test('portable Windows installer real PowerShell contract and recovery fixtures', async (t) => {
  if (process.platform !== 'win32') {
    t.skip('Windows PowerShell file/launch contracts require Windows');
    return;
  }
  const temp = await mkdtemp(path.join(os.tmpdir(), 'vibespace-installer-fixture-'));
  const harnessPath = path.join(temp, 'harness.ps1');
  await writeFile(harnessPath, harness);
  await readFile(script);
  let output;
  try {
    output = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', harnessPath, '-Source', script, '-Fixture', temp], { timeout: 45000, maxBuffer: 256 * 1024 });
  } catch (error) {
    if (error.stdout?.trim().startsWith('[')) output = { stdout: error.stdout };
    else assert.fail(`PowerShell fixture failed: ${error.stdout ?? ''}\n${error.stderr ?? ''}`);
  }
  const cases = JSON.parse(output.stdout.trim());
  assert.equal(cases.length, 22);
  for (const result of cases) {
    await t.test(result.name, () => assert.equal(result.pass, true, result.error));
  }
});
