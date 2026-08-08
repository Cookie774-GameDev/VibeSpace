import { readFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { describe, expect, it } from 'vitest';

function repositoryRoot(): string {
  const cwd = process.cwd();
  return path.basename(cwd).toLowerCase() === 'app' ? path.dirname(cwd) : cwd;
}

function readCanonicalText(filePath: string): string {
  return readFileSync(filePath, 'utf8').replace(/\r\n?/g, '\n');
}

const root = repositoryRoot();
const launcherPath = path.join(root, 'scripts', 'shared-intelligence-kernel-smoke.ps1');
const driverPath = path.join(root, 'scripts', 'shared-intelligence-kernel-smoke-driver.mjs');
const launcher = readCanonicalText(launcherPath);
const driver = readCanonicalText(driverPath);
const tabStrip = readCanonicalText(
  path.join(root, 'app', 'src', 'components', 'layout', 'TabStrip.tsx'),
);
const app = readCanonicalText(path.join(root, 'app', 'src', 'App.tsx'));

const POWERSHELL_PROBE_TIMEOUT_MS = 60_000;
const POWERSHELL_PROBE_TEST_TIMEOUT_MS = POWERSHELL_PROBE_TIMEOUT_MS + 5_000;
const itWindows = process.platform === 'win32' ? it : it.skip;

interface PowerShellContractProbe {
  status: number | null;
  diagnostic: string;
  windowContract?: string;
  interopContract?: string;
  identityContract?: string;
}

let cachedPowerShellContractProbe: PowerShellContractProbe | undefined;

function getPowerShellContractProbe(): PowerShellContractProbe {
  if (cachedPowerShellContractProbe) return cachedPowerShellContractProbe;

  const script = `
$scriptPath = Join-Path (Get-Location) 'scripts\\shared-intelligence-kernel-smoke.ps1'
. $scriptPath -ValidateOnly | Out-Null

$config = New-SmokeTauriConfigJson -Identifier 'ai.jarvis.desktop.smoke' | ConvertFrom-Json
$window = @($config.app.windows)[0]
$windowContract = "$($config.identifier)|$($config.app.windows.Count)|$($window.label)|$($window.visible)|$($window.focus)|$($window.skipTaskbar)|$($window.width)|$($window.height)|$($config.app.macOSPrivateApi)|$($window.additionalBrowserArgs)"

try {
    Show-SmokeNativeWindowOffscreen -NativePid $PID -Deadline ([DateTime]::UtcNow)
} catch {
    if ($_.Exception.Message -ne 'kernel_smoke_native_window_position_timeout') {
        throw
    }
}
if (-not ('VibeSpaceSmokeWindow' -as [type])) {
    throw 'kernel_smoke_native_window_interop_missing'
}

$process = [Diagnostics.Process]::GetCurrentProcess()
$startedUtc = $process.StartTime.ToUniversalTime()
$executable = $process.MainModule.FileName
$rootProcess = [pscustomobject]@{ ProcessId = $process.Id; ParentProcessId = 0; ExecutablePath = $executable; CreationUtc = $startedUtc.ToString('O') }
$records = @{}
Register-RecordedProcessRoot -Process $process -Records $records -Snapshot @($rootProcess)
$reused = [pscustomobject]@{ ProcessId = $process.Id; ParentProcessId = 0; ExecutablePath = $executable; CreationUtc = $startedUtc.AddSeconds(1).ToString('O') }
$recordCount = $records.Count
[void](Add-RecordedProcessTree -RootPid $process.Id -Records $records -Snapshot @($reused))
$rootCode = if ($records.Count -eq $recordCount) { 'kernel_smoke_process_root_identity_rejected' } else { 'unsafe_root_identity_accepted' }
$staleChild = [pscustomobject]@{ ProcessId = 2147483000; ParentProcessId = $process.Id; ExecutablePath = $executable; CreationUtc = $startedUtc.AddSeconds(-1).ToString('O') }
[void](Add-RecordedProcessTree -RootPid $process.Id -Records $records -Snapshot @($rootProcess, $staleChild))
$childCode = if ($records.ContainsKey('2147483000')) { 'unsafe_ancestry_accepted' } else { 'kernel_smoke_process_ancestry_rejected' }

[ordered]@{
    windowContract = $windowContract
    interopContract = 'native_window_interop_loaded'
    identityContract = "$rootCode|$childCode"
} | ConvertTo-Json -Compress
`;
  const result = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script],
    {
      cwd: root,
      encoding: 'utf8',
      timeout: POWERSHELL_PROBE_TIMEOUT_MS,
      windowsHide: true,
    },
  );
  const diagnostic = result.stderr.trim() || result.error?.message || '';
  let output: Partial<PowerShellContractProbe> = {};
  try {
    output = JSON.parse(result.stdout.trim()) as Partial<PowerShellContractProbe>;
  } catch {
    // The exact status and diagnostic assertions below report a closed probe failure.
  }
  cachedPowerShellContractProbe = {
    status: result.status,
    diagnostic,
    windowContract: output.windowContract,
    interopContract: output.interopContract,
    identityContract: output.identityContract,
  };
  return cachedPowerShellContractProbe;
}

describe('shared intelligence kernel smoke harness contract', () => {
  it('keeps one outer cleanup boundary and tolerates partial startup', () => {
    expect((launcher.match(/^finally/gm) ?? []).length).toBe(1);
    expect(launcher.indexOf('$Dev = $null')).toBeLessThan(launcher.indexOf('\ntry {'));
    expect(launcher).toContain('if ($null -ne $Driver)');
    expect(launcher).toContain('if ($null -ne $Dev)');
    expect(launcher).toContain('if (-not $EnvironmentRestored)');
  });

  it('uses one bounded cold-link allowance for initial and restarted native descendants', () => {
    expect(launcher).toContain('$NativeStartupTimeoutMinutes = 12');
    expect((launcher.match(/AddMinutes\(\$NativeStartupTimeoutMinutes\)/g) ?? []).length).toBe(2);
    expect(launcher).not.toContain('AddMinutes(5)');
  });

  it('uses a stable isolated Tauri identifier so smoke retries reuse the native link cache', () => {
    expect(launcher).toContain("$tauriIdentifier = 'ai.jarvis.desktop.smoke'");
    expect(launcher).not.toContain('$tauriIdentifier = "ai.jarvis.desktop.smoke.s$runId"');
  });

  itWindows(
    'creates an initially hidden non-focus-stealing native smoke window',
    () => {
      const result = getPowerShellContractProbe();

      expect(result.status, result.diagnostic).toBe(0);
      expect(result.windowContract).toBe(
        'ai.jarvis.desktop.smoke|1|main|False|False|True|1280|820|True|--js-flags=--max-old-space-size=4096 --disable-background-timer-throttling --disable-backgrounding-occluded-windows --disable-renderer-backgrounding',
      );
    },
    POWERSHELL_PROBE_TEST_TIMEOUT_MS,
  );

  it('shows only the exact native Tauri window offscreen without activation before CDP', () => {
    expect(launcher).toContain('function Show-SmokeNativeWindowOffscreen');
    expect(launcher).toContain('GetTauriWindows');
    expect(launcher).toContain('HWND_BOTTOM');
    expect(launcher).toContain('SWP_NOACTIVATE');
    expect(launcher).toContain('SWP_SHOWWINDOW');
    expect(launcher).toContain('GetWindowRect');
    expect(launcher).toContain('kernel_smoke_native_window_ambiguous');
    expect(launcher).toContain('kernel_smoke_native_window_position_timeout');
    expect(
      (
        launcher.match(
          /Show-SmokeNativeWindowOffscreen -NativePid \$NativePid -Deadline \$deadline/g,
        ) ?? []
      ).length,
    ).toBe(2);

    let launch = launcher.indexOf('$nativeMatch = Wait-ForNativeDescendant');
    for (let index = 0; index < 2; index += 1) {
      const offscreen = launcher.indexOf(
        'Show-SmokeNativeWindowOffscreen -NativePid $NativePid -Deadline $deadline',
        launch,
      );
      const cdp = launcher.indexOf(
        'Wait-ForCdpEndpoint -Port $CdpPort -Deadline $deadline',
        launch,
      );
      expect(offscreen).toBeGreaterThan(launch);
      expect(cdp).toBeGreaterThan(offscreen);
      launch = launcher.indexOf('$nativeMatch = Wait-ForNativeDescendant', launch + 1);
    }
  });

  itWindows(
    'loads the native window interop under Windows PowerShell before a smoke launch',
    () => {
      const result = getPowerShellContractProbe();

      expect(result.status, result.diagnostic).toBe(0);
      expect(result.interopContract).toBe('native_window_interop_loaded');
    },
    POWERSHELL_PROBE_TEST_TIMEOUT_MS,
  );

  it('builds the signed CLI fixture only for the CLI transport scenario', () => {
    const build = launcher.slice(
      launcher.indexOf('Set-ChildEnvironment -Values @{ TAURI_CONFIG = $tauriConfigJson }'),
      launcher.indexOf('$baseline = Get-CimProcessSnapshot'),
    );

    expect(build).toContain("if ($Scenarios -contains 'transport_cli_success')");
    expect(build).toContain('cargo build --manifest-path $CargoManifest --example');
  });

  it('waits for recorded process trees to exit before deleting the disposable profile', () => {
    const cleanup = launcher.slice(launcher.lastIndexOf('\nfinally {'));
    const driverStop = cleanup.indexOf('Stop-RecordedProcessTree -RootPid $Driver.Id');
    const driverWait = cleanup.indexOf('Wait-ForRecordedProcessTreeExit', driverStop);
    const devStop = cleanup.indexOf('Stop-RecordedProcessTree -RootPid $Dev.Id');
    const devWait = cleanup.indexOf('Wait-ForRecordedProcessTreeExit', devStop);
    const profileRemoval = cleanup.indexOf(
      'Remove-Item -LiteralPath $canonicalRemovalTarget -Recurse -Force',
    );

    expect(driverStop).toBeGreaterThan(0);
    expect(driverWait).toBeGreaterThan(driverStop);
    expect(devStop).toBeGreaterThan(driverWait);
    expect(devWait).toBeGreaterThan(devStop);
    expect(profileRemoval).toBeGreaterThan(devWait);
  });

  it('bounds the driver wait before reading its exact exit code', () => {
    const completion = launcher.slice(
      launcher.indexOf('function Complete-HiddenRedirectedProcess'),
      launcher.indexOf('function Get-CimProcessSnapshot'),
    );
    const waitForExit = completion.indexOf(
      '$Capture.Process.WaitForExit($ProcessWaitMilliseconds)',
    );
    const exitCode = completion.indexOf('return [int]$Capture.Process.ExitCode');

    expect(waitForExit).toBeGreaterThan(0);
    expect(exitCode).toBeGreaterThan(waitForExit);
    expect(completion).not.toContain('$Capture.Process.WaitForExit()');
    expect(launcher).toContain(
      '$driverExitCode = Complete-HiddenRedirectedProcess -Capture $DriverCapture',
    );
  });

  it('streams redirected driver output directly to evidence files', () => {
    const startup = launcher.slice(
      launcher.indexOf('function Start-HiddenRedirectedProcess'),
      launcher.indexOf('function Complete-HiddenRedirectedProcess'),
    );

    expect(startup).toContain('BaseStream.CopyToAsync($standardOutputStream)');
    expect(startup).toContain('BaseStream.CopyToAsync($standardErrorStream)');
    expect(startup).not.toContain('ReadToEndAsync');
  });

  it('bounds retries when Windows process snapshots are temporarily resource constrained', () => {
    const snapshot = launcher.slice(
      launcher.indexOf('function Get-CimProcessSnapshot'),
      launcher.indexOf('function Get-Descendants'),
    );

    expect(snapshot).toContain('$CimSnapshotMaxAttempts');
    expect(snapshot).toContain('Start-Sleep -Milliseconds 250');
    expect(snapshot).toContain("throw 'kernel_smoke_process_snapshot_unavailable'");
  });

  it('flushes driver logs and attempts every cleanup phase before reporting failures', () => {
    const cleanup = launcher.slice(launcher.lastIndexOf('\nfinally {'));
    const driverGuard = cleanup.indexOf('if ($null -ne $Driver)');
    const driverWait = cleanup.indexOf('Wait-ForRecordedProcessTreeExit', driverGuard);
    const cleanupCatch = cleanup.indexOf('catch {', driverWait);
    const logFlush = cleanup.indexOf(
      'Complete-HiddenRedirectedProcess -Capture $DriverCapture',
      cleanupCatch,
    );
    const devGuard = cleanup.indexOf('if ($null -ne $Dev)', logFlush);
    const profileGuard = cleanup.indexOf('if ($null -ne $Profile', devGuard);
    const aggregateThrow = cleanup.indexOf('throw "kernel_smoke_cleanup_failed:', profileGuard);

    expect(driverWait).toBeGreaterThan(driverGuard);
    expect(cleanupCatch).toBeGreaterThan(driverWait);
    expect(logFlush).toBeGreaterThan(cleanupCatch);
    expect(devGuard).toBeGreaterThan(logFlush);
    expect(profileGuard).toBeGreaterThan(devGuard);
    expect(aggregateThrow).toBeGreaterThan(profileGuard);
    expect(cleanup).not.toContain('throw $driverCleanupError');
  });

  it('binds a fresh loopback port and cryptographic nonce into child-only state', () => {
    expect(launcher).toContain('[Net.IPAddress]::Loopback, 0');
    expect(launcher).toContain('[Security.Cryptography.RandomNumberGenerator]::Create()');
    expect(launcher).toContain("$Nonce -notmatch '^[a-f0-9]{64}$'");
    expect(launcher).toContain('VIBESPACE_SIK_CDP_PORT');
    expect(launcher).toContain('VIBESPACE_SIK_PROFILE');
    expect(launcher).toContain('VIBESPACE_SIK_NONCE');
    expect(launcher).toContain("'TAURI_CONFIG'");
    expect(launcher).toContain('macOSPrivateApi = $true');
    expect(launcher).toContain('Set-ChildEnvironment -Values @{ TAURI_CONFIG = $tauriConfigJson }');
    const startup = launcher.indexOf('$Dev = Start-Process');
    const restored = launcher.indexOf('Restore-Environment -Saved $SavedEnvironment', startup);
    const driverLoop = launcher.indexOf('foreach ($scenario in $Scenarios)', restored);
    expect(startup).toBeGreaterThan(0);
    expect(restored).toBeGreaterThan(startup);
    expect(driverLoop).toBeGreaterThan(restored);
  });

  it('confines the development entitlement to the isolated smoke child environment', () => {
    expect(launcher).toContain("'VITE_JARVIS_LOCAL_ADMIN'");
    expect(launcher).toMatch(/VITE_JARVIS_LOCAL_ADMIN\s*=\s*'1'/);
    expect(launcher).toContain('Restore-Environment -Saved $SavedEnvironment');
  });

  it('attests the exact descendant executable and PID creation identity', () => {
    expect(launcher).toContain('target\\debug\\jarvis.exe');
    expect(launcher).toContain(
      '$ExpectedNativeExecutables = @([IO.Path]::GetFullPath($LogicalNativeExecutable))',
    );
    expect(launcher).toContain(
      '$ExpectedNativeExecutables = @(\n            $ExpectedNativeExecutables\n            $physicalNativeExecutable',
    );
    expect(launcher).toContain(
      'Test-PathInSet -Candidate $_.ExecutablePath -Allowed $ExpectedExecutables',
    );
    expect(launcher).toContain('Wait-ForNativeDescendant `');
    expect(launcher).toContain('-Launcher $Dev `');
    expect(launcher).toContain('-ExpectedExecutables $ExpectedNativeExecutables `');
    expect(launcher).toContain('Get-Descendants -RootProcess $root[0] -Snapshot $Snapshot');
    expect(launcher).toContain('return $result.ToArray()');
    expect(launcher).toContain('kernel_smoke_native_wrong_path_descendant');
    expect(launcher).toContain('kernel_smoke_native_non_descendant');
    expect(launcher).toContain('kernel_smoke_native_ambiguous');
    expect(launcher).toContain('CreationUtc');
    expect(launcher).toContain('kernel_smoke_native_creation_time_mismatch');
    expect(launcher).not.toMatch(/Stop-Process\s+-Name/i);
    expect(launcher).not.toMatch(/taskkill[^\r\n]*\/im/i);
  });

  it('anchors every process tree to launch identity and rejects stale PID ancestry', () => {
    const processSafety = launcher.slice(
      launcher.indexOf('function Register-RecordedProcessRoot'),
      launcher.indexOf('function Wait-ForRecordedProcessTreeExit'),
    );
    expect(processSafety).toContain('$Process.StartTime.ToUniversalTime()');
    expect(processSafety).toContain('kernel_smoke_process_root_identity_changed');
    expect(processSafety).toContain('Get-VerifiedRecordedProcessTree');
    expect(processSafety).toContain('$childCreationUtc -lt $current.CreationTimeUtc');
    expect(processSafety).toContain('$childCreationUtc -lt $current.CreationTimeUtc');

    const firstDevStart = launcher.indexOf('$Dev = Start-Process');
    const firstDevRegistered = launcher.indexOf(
      'Register-RecordedProcessRoot -Process $Dev -Records $DevRecords',
      firstDevStart,
    );
    const firstEnvironmentRestore = launcher.indexOf(
      'Restore-Environment -Saved $SavedEnvironment',
      firstDevStart,
    );
    expect(firstDevRegistered).toBeGreaterThan(firstDevStart);
    expect(firstDevRegistered).toBeLessThan(firstEnvironmentRestore);

    const secondDevStart = launcher.indexOf('$Dev = Start-Process', firstDevStart + 1);
    const secondDevRegistered = launcher.indexOf(
      'Register-RecordedProcessRoot -Process $Dev -Records $DevRecords',
      secondDevStart,
    );
    const secondEnvironmentRestore = launcher.indexOf(
      'Restore-Environment -Saved $SavedEnvironment',
      secondDevStart,
    );
    expect(secondDevStart).toBeGreaterThan(firstDevStart);
    expect(secondDevRegistered).toBeGreaterThan(secondDevStart);
    expect(secondDevRegistered).toBeLessThan(secondEnvironmentRestore);

    const driverRoot = launcher.indexOf('$Driver = $DriverCapture.Process');
    const driverRegistered = launcher.indexOf(
      'Register-RecordedProcessRoot -Process $Driver -Records $DriverRecords',
      driverRoot,
    );
    const driverPoll = launcher.indexOf('while (-not $Driver.HasExited)', driverRoot);
    expect(driverRegistered).toBeGreaterThan(driverRoot);
    expect(driverRegistered).toBeLessThan(driverPoll);
  });

  itWindows(
    'rejects a reused root identity and a child older than its verified parent',
    () => {
      const result = getPowerShellContractProbe();

      expect(result.status, result.diagnostic).toBe(0);
      expect(result.identityContract).toBe(
        'kernel_smoke_process_root_identity_rejected|kernel_smoke_process_ancestry_rejected',
      );
    },
    POWERSHELL_PROBE_TEST_TIMEOUT_MS,
  );

  it('retries stopping only exact recorded identities during the bounded exit wait', () => {
    const waiter = launcher.slice(
      launcher.indexOf('function Wait-ForRecordedProcessTreeExit'),
      launcher.indexOf('function Wait-ForNativeDescendant'),
    );
    const remaining = waiter.indexOf('$remaining = @(Get-CimProcessSnapshot');
    const identityCreation = waiter.indexOf('$_.CreationUtc -eq $recorded.CreationUtc', remaining);
    const identityPath = waiter.indexOf(
      '(Test-PathEqual -Left $_.ExecutablePath -Right $recorded.ExecutablePath)',
      identityCreation,
    );
    const deepestFirst = waiter.indexOf('$Records[[string]$_.ProcessId].Depth', identityPath);
    const retry = waiter.indexOf(
      'Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue',
      deepestFirst,
    );
    expect(remaining).toBeGreaterThan(0);
    expect(identityCreation).toBeGreaterThan(remaining);
    expect(identityPath).toBeGreaterThan(identityCreation);
    expect(deepestFirst).toBeGreaterThan(identityPath);
    expect(retry).toBeGreaterThan(deepestFirst);
    expect(launcher).toContain('$ProcessTreeCleanupTimeoutSeconds = 60');
    expect((launcher.match(/AddSeconds\(\$ProcessTreeCleanupTimeoutSeconds\)/g) ?? []).length).toBe(
      3,
    );
  });

  it('bounds every driver phase before fail-closed process cleanup', () => {
    const driverLoop = launcher.slice(
      launcher.indexOf('foreach ($scenario in $Scenarios)'),
      launcher.indexOf('\nfinally {'),
    );
    expect(launcher).toContain('$DriverPhaseTimeoutMinutes');
    expect(driverLoop).toContain(
      '$driverDeadline = [DateTime]::UtcNow.AddMinutes($DriverPhaseTimeoutMinutes)',
    );
    expect(driverLoop).toContain('if ([DateTime]::UtcNow -ge $driverDeadline)');
    expect(driverLoop).toContain(
      'throw "kernel_smoke_driver_phase_timeout:${scenario}:phase${phase}"',
    );
  });

  it('reports only a closed approval-presentation failure code before control timeout', () => {
    expect(driver).toContain('APPROVAL_PRESENTATION_FAILURE_CODES');
    expect(driver).toContain('data-presentation-state');
    expect(driver).toContain('data-presentation-code');
    expect(driver).toContain('kernel_smoke_approval_presentation_failed:');
    expect(driver).toContain("await clickApprovalEvidence(page, 'approval.confirm')");
    expect(driver).toContain("await clickApprovalEvidence(page, 'approval.confirm-dangerous')");
  });

  it('uses hidden startup, strict disposable-profile containment, and all six driver arguments', () => {
    expect(launcher).toContain('-WindowStyle Hidden');
    expect(launcher).toContain('Test-StrictDescendantPath');
    expect(launcher).toContain('kernel_smoke_cleanup_containment_invalid');
    expect(launcher).toContain("$smokeProject = Join-Path $Profile 'SmokeProject'");
    expect(launcher).toContain('kernel_smoke_project_containment_invalid');
    expect(launcher).toContain('New-Item -ItemType Directory -Path $smokeProject');
    for (const argument of [
      '--cdp-port',
      '--scenario',
      '--evidence-dir',
      '--expected-native-pid',
      '--expected-profile',
      '--expected-nonce',
    ]) {
      expect(launcher).toContain(`'${argument}'`);
      expect(driver).toContain(`'${argument}'`);
    }
  });

  it('allows only the plan-mandated Task 22 evidence subtree inside the repository', () => {
    expect(launcher).toContain(
      "$Task22EvidenceBase = Join-Path $RepositoryRoot '.superpowers\\sdd\\evidence\\task-22'",
    );
    expect(launcher).toContain(
      '$task22EvidenceAllowed = Test-StrictDescendantPath -Child $expandedEvidence -Parent $Task22EvidenceBase',
    );
    expect(launcher).toContain(
      '$canonicalTask22EvidenceAllowed = Test-StrictDescendantPath -Child $CanonicalEvidence -Parent $Task22EvidenceBase',
    );
    expect(launcher).toContain(
      '(Test-StrictDescendantPath -Child $expandedEvidence -Parent $RepositoryRoot) -and',
    );
    expect(launcher).toContain('-not $task22EvidenceAllowed');
    expect(launcher).toContain('-not $canonicalTask22EvidenceAllowed');
    const task22EvidenceRoot = driver.slice(
      driver.indexOf('const TASK22_EVIDENCE_ROOT = path.join('),
      driver.indexOf('const TIMEOUT_MS'),
    );
    expect(task22EvidenceRoot).toContain('REPOSITORY_ROOT');
    expect(task22EvidenceRoot).toContain("'.superpowers'");
    expect(task22EvidenceRoot).toContain("'sdd'");
    expect(task22EvidenceRoot).toContain("'evidence'");
    expect(task22EvidenceRoot).toContain("'task-22'");
    expect(driver).toContain(
      'const task22EvidenceAllowed = isStrictDescendant(evidenceDirectory, TASK22_EVIDENCE_ROOT);',
    );
    expect(driver).toContain(
      'isStrictDescendant(evidenceDirectory, REPOSITORY_ROOT) && !task22EvidenceAllowed',
    );
  });

  it('uses only the root Playwright dependency and closed evidence selectors', () => {
    expect(driver).toContain("import { chromium } from 'playwright-core'");
    expect(launcher).toContain('ls playwright-core --depth=0');
    expect(driver).toContain('chromium.connectOverCDP(`http://127.0.0.1:');
    expect(driver).toContain('`[data-sik-evidence="${id}"]`');
    expect(driver).not.toMatch(/\.evaluate\s*\(/);
    expect(driver).not.toMatch(/localStorage|sessionStorage|[?&]scenario=/);
    expect(driver).not.toMatch(/repository|messageRepo|runRepo|eventRepo/);
    expect(driver).toContain("await selectSmokeTransport(page, 'cli')");
    expect(driver).toContain("await selectSmokeTransport(page, 'native')");
    expect(driver).toContain("'model.transport-native'");
    expect(driver).toContain("'model.transport-cli'");
  });

  it('preserves only allowlisted sanitized evidence when a native scenario fails', () => {
    const main = driver.slice(
      driver.indexOf('async function main()'),
      driver.indexOf('main().catch'),
    );
    expect(main).toContain('`${options.scenario}.failure.json`');
    expect(main).toContain("outcome: 'FAIL'");
    expect(main).toContain('observed: await collectSanitizedEvidence(page)');
    expect(main).toContain('await assertNoRawAudio(page, failureEvidence)');
    expect(main).toContain("'kernel_smoke_driver_failed'");
    expect(main).not.toMatch(/innerText|textContent/);
  });

  it('reports closed page and allowlisted selector timeouts without leaking Playwright errors', () => {
    expect(driver).toContain("fail('kernel_smoke_page_closed')");
    expect(driver).toContain('fail(`kernel_smoke_evidence_missing:${id}`)');
    expect(driver).toContain('if (!SELECTOR_IDS.includes(id))');
    expect(driver).toContain("'smoke.binding-error'");
    expect(driver).toContain("'smoke.dispatch-kind'");
    expect(driver).toContain("'smoke.runtime-state'");
    expect(driver).toContain("'data-runtime-state'");
    expect(driver).toContain('kernel_smoke_provider_not_reached:');
    expect(driver).toContain("'data-dispatch-kind'");
    expect(driver).toContain('kernel_smoke_unprotected_provider_dispatch');
    expect(driver).toContain('kernel_smoke_dispatch_state_timeout');
    expect(driver).toContain('kernel_smoke_transport_state_timeout');
    expect(driver).toContain('kernel_smoke_run_state_timeout');
    expect(driver).toContain('kernel_smoke_unexpected_run_status:');
    expect(driver).toContain('async function readOptionalRuntimeFailureCode');
    const runStatusHelper = driver.slice(
      driver.indexOf('async function waitForRunStatus'),
      driver.indexOf('function allZeroDurations'),
    );
    expect(runStatusHelper).toContain('readOptionalRuntimeFailureCode(page)');
    expect(runStatusHelper).not.toContain("requireUniqueEvidence(page, 'smoke.runtime-state')");
    expect(driver).toContain("getAttribute('data-error-code')");
    expect(driver).toContain("getAttribute('data-initialization-phase')");
    expect(driver).toContain("getAttribute('data-terminal-status')");
    expect(driver).toContain('kernel_smoke_terminal_session_timeout:${lastPhase}');
    expect(driver).toContain('async function waitForTerminalSettlement');
    expect(driver).toContain('await waitForTerminalSettlement(terminalExecution)');
    expect(driver).toContain('/^kernel_[a-z0-9_]{1,120}$/');
    expect(driver).toContain('kernel_runtime_failure');
    expect(driver).toContain("lastStatus ?? 'invalid'");
    expect(driver).toContain('safeRuntimeState');
    expect(driver).toContain('kernel_smoke_native_binding_rejected:');
    expect(driver).toContain("'sik_smoke_port_not_bound'");
    expect(driver).not.toMatch(/innerText|textContent/);
  });

  it('requires account-scoped chat runtime readiness before every real composer submit', () => {
    expect(driver).toContain("'chat.runtime-ready'");
    const submitFixture = driver.slice(
      driver.indexOf('async function submitChatFixture'),
      driver.indexOf('async function selectSmokeTransport'),
    );
    const readiness = submitFixture.indexOf("requireUniqueEvidence(page, 'chat.runtime-ready')");
    const priorRunDigest = submitFixture.indexOf('readOptionalRunDigest(page)');
    const submit = submitFixture.indexOf("clickEvidence(page, 'chat.submit')");
    const protectedDispatch = submitFixture.indexOf("path !== 'protected'");
    const newRunDigest = submitFixture.indexOf('waitForNewRunDigest(page, previousRunDigest)');

    expect(readiness).toBeGreaterThan(0);
    expect(priorRunDigest).toBeGreaterThan(readiness);
    expect(submit).toBeGreaterThan(priorRunDigest);
    expect(protectedDispatch).toBeGreaterThan(submit);
    expect(newRunDigest).toBeGreaterThan(protectedDispatch);
    expect(submitFixture).not.toContain('setTimeout');

    const identityHelper = driver.slice(
      driver.indexOf('async function waitForNewRunDigest'),
      driver.indexOf('async function submitChatFixture'),
    );
    expect(identityHelper).toContain("requireUniqueEvidence(page, 'run.status')");
    expect(identityHelper).toContain('waitForDifferentAttribute(');
    expect(identityHelper).toContain('waitForMatchingAttribute(');
    expect(identityHelper).toContain('kernel_smoke_run_digest_invalid');
  });

  it('attests that the Hive fixture reaches the protected provider before waiting on its run', () => {
    const hiveScenario = driver.slice(
      driver.indexOf("case 'hive_dispatch':"),
      driver.indexOf('default:', driver.indexOf("case 'hive_dispatch':")),
    );
    const readiness = hiveScenario.indexOf("requireUniqueEvidence(page, 'chat.runtime-ready')");
    const dispatchClick = hiveScenario.indexOf("clickEvidence(page, 'hive.dispatch')");
    const protectedDispatch = hiveScenario.indexOf(
      "waitForMatchingAttribute(hiveDispatch, 'data-dispatch-kind', /^protected$/)",
    );
    const runtimeDone = hiveScenario.indexOf("'data-runtime-state'", protectedDispatch);
    const runtimeDoneValue = hiveScenario.indexOf("['done']", runtimeDone);
    const chatShell = hiveScenario.indexOf("requireUniqueEvidence(page, 'chat.run-shell')");
    const visibleAssistant = hiveScenario.indexOf(
      "waitForMatchingAttribute(hiveChatShell, 'data-sik-assistant-count', /^[1-9][0-9]*$/)",
    );
    const completed = hiveScenario.indexOf("waitForRunStatus(page, ['completed'])");
    expect(readiness).toBeGreaterThan(0);
    expect(dispatchClick).toBeGreaterThan(readiness);
    expect(hiveScenario).toContain("requireUniqueEvidence(page, 'smoke.runtime-state')");
    expect(hiveScenario).toContain("requireUniqueEvidence(page, 'smoke.dispatch-kind')");
    expect(hiveScenario).toContain("getAttribute('data-initialization-phase')");
    expect(hiveScenario).toContain(
      "waitForMatchingAttribute(hiveDispatch, 'data-dispatch-kind', /^protected$/)",
    );
    expect(hiveScenario).not.toContain('kernel_smoke_hive_unprotected_provider_dispatch');
    expect(protectedDispatch).toBeGreaterThan(dispatchClick);
    expect(runtimeDone).toBeGreaterThan(protectedDispatch);
    expect(runtimeDoneValue).toBeGreaterThan(runtimeDone);
    expect(chatShell).toBeGreaterThan(runtimeDoneValue);
    expect(visibleAssistant).toBeGreaterThan(chatShell);
    expect(completed).toBeGreaterThan(visibleAssistant);
  });

  it('accepts only canonical cancellation or completion truth in the completion race', () => {
    const helper = driver.slice(
      driver.indexOf('async function requestCancellationOrObserveCompletion'),
      driver.indexOf(
        '\nasync function ',
        driver.indexOf('async function requestCancellationOrObserveCompletion') + 1,
      ),
    );
    expect(helper).toContain("requireUniqueEvidence(page, 'run.status')");
    expect(helper).toContain("evidenceLocator(page, 'cancellation.delivery')");
    expect(helper).toContain("['cancelled', 'completed'].includes(status)");
    expect(helper).toContain("fail('kernel_smoke_evidence_ambiguous')");

    const scenario = driver.slice(
      driver.indexOf("case 'cancel_completion_race':"),
      driver.indexOf("case 'transport_provider_success':"),
    );
    const submit = scenario.indexOf('submitChatFixture(page,');
    const request = scenario.indexOf('requestCancellationOrObserveCompletion(page)');
    const terminal = scenario.indexOf("waitForRunStatus(page, ['cancelled', 'completed'])");
    expect(request).toBeGreaterThan(submit);
    expect(terminal).toBeGreaterThan(request);
    expect(scenario).not.toContain("clickEvidence(page, 'cancellation.delivery')");
  });

  it('waits for the complete scheduled zero-effect projection before snapshotting it', () => {
    const scenario = driver.slice(
      driver.indexOf("case 'schedule_transport_retry':"),
      driver.indexOf("case 'provider_failure':"),
    );
    const expected = [
      ['data-attempt-number', '1'],
      ['data-attempt-state', 'retryable_failed'],
      ['data-effect-barrier-state', 'open'],
      ['data-effect-barrier-version', '0'],
      ['data-response-started', 'false'],
      ['data-chunk-count', '0'],
      ['data-action-dispatch-count', '0'],
      ['data-approval-count', '0'],
      ['data-artifact-count', '0'],
      ['data-executor-claim-count', '0'],
    ] as const;
    const snapshot = scenario.indexOf('const before = await readAttributes(status, [');
    expect(snapshot).toBeGreaterThan(0);
    expect(scenario).not.toContain("requireUniqueEvidence(page, 'run.error')");
    expect(scenario).not.toContain("'data-run-status', ['failed']");
    expect(scenario).toContain("waitForScheduleRunState(status, 'running', 'settled')");
    expect(scenario).toContain("waitForScheduleRunState(status, 'running', 'restart')");
    const waitLoop = scenario.indexOf('for (const [name, value] of Object.entries(expected))');
    const attributeWait = scenario.indexOf(
      '`kernel_smoke_schedule_zero_effect_timeout:${name}`',
      waitLoop,
    );
    expect(waitLoop).toBeGreaterThan(0);
    expect(attributeWait).toBeGreaterThan(waitLoop);
    expect(attributeWait).toBeLessThan(snapshot);
    for (const [attribute, value] of expected) {
      expect(scenario).toContain(`'${attribute}': '${value}'`);
    }
  });

  it('waits for the protected voice turn to become cancellable before clicking stop', () => {
    const voiceScenario = driver.slice(
      driver.indexOf("case 'voice_turn_stop':"),
      driver.indexOf("case 'native_stt_voice_turn':"),
    );
    const priorRunDigest = voiceScenario.indexOf(
      'const previousVoiceRunDigest = await readOptionalRunDigest(page)',
    );
    const sessionEvidence = voiceScenario.indexOf("requireUniqueEvidence(page, 'voice.stt-state')");
    const sessionBound = voiceScenario.indexOf("'kernel_smoke_voice_session_timeout'");
    const transcript = voiceScenario.indexOf("clickEvidence(page, 'voice.transcript')");
    const newRunDigest = voiceScenario.indexOf('waitForNewRunDigest(page, previousVoiceRunDigest)');
    const running = voiceScenario.indexOf("waitForRunStatus(page, ['running'])");
    const voiceState = voiceScenario.indexOf("requireUniqueEvidence(page, 'voice.state')", running);
    const cancellable = voiceScenario.indexOf("'kernel_smoke_voice_cancellable_timeout'");
    const chatShell = voiceScenario.indexOf("requireUniqueEvidence(page, 'chat.run-shell')");
    const assistantBeforeStop = voiceScenario.indexOf(
      'const assistantCountBeforeStop = await readAssistantCount(chatShell)',
    );
    const stop = voiceScenario.indexOf("clickEvidence(page, 'voice.stop')");
    const cancelled = voiceScenario.indexOf("waitForRunStatus(page, ['cancelled'])");
    const terminalBefore = voiceScenario.indexOf(
      'const beforeRuntimeSettled = await readAttributes',
    );
    const runtime = voiceScenario.indexOf("requireUniqueEvidence(page, 'smoke.runtime-state')");
    const runtimeCancelled = voiceScenario.indexOf("'kernel_smoke_voice_runtime_cancel_timeout'");
    const terminalAfter = voiceScenario.indexOf('const afterRuntimeSettled = await readAttributes');
    const noSuccess = voiceScenario.indexOf(
      'assertNoVoiceSuccessEvidence(afterRuntimeSettled, assistantCountBeforeStop)',
    );
    const stableTerminal = voiceScenario.indexOf(
      "beforeRuntimeSettled['data-run-digest'] !== afterRuntimeSettled['data-run-digest']",
    );

    expect(priorRunDigest).toBeGreaterThan(0);
    expect(sessionEvidence).toBeGreaterThan(priorRunDigest);
    expect(sessionBound).toBeGreaterThan(sessionEvidence);
    expect(transcript).toBeGreaterThan(sessionBound);
    expect(newRunDigest).toBeGreaterThan(transcript);
    expect(running).toBeGreaterThan(newRunDigest);
    expect(voiceState).toBeGreaterThan(running);
    expect(cancellable).toBeGreaterThan(voiceState);
    expect(chatShell).toBeGreaterThan(cancellable);
    expect(assistantBeforeStop).toBeGreaterThan(chatShell);
    expect(stop).toBeGreaterThan(assistantBeforeStop);
    expect(cancelled).toBeGreaterThan(stop);
    expect(terminalBefore).toBeGreaterThan(cancelled);
    expect(runtime).toBeGreaterThan(terminalBefore);
    expect(runtimeCancelled).toBeGreaterThan(runtime);
    expect(terminalAfter).toBeGreaterThan(runtimeCancelled);
    expect(noSuccess).toBeGreaterThan(terminalAfter);
    expect(stableTerminal).toBeGreaterThan(noSuccess);
    expect(voiceScenario).not.toContain('setTimeout');
  });

  it('preserves terminal confirmation handoff truth and terminalizes the dangerous fixture', () => {
    const dispatchWaiter = driver.slice(
      driver.indexOf('async function waitForCanonicalApprovalDispatch'),
      driver.indexOf('async function waitForRunStatus'),
    );
    const confirm = driver.slice(
      driver.indexOf("case 'approval_confirm':"),
      driver.indexOf("case 'approval_dangerous':"),
    );
    const confirmSubmit = confirm.indexOf('submitChatFixture(page,');
    const confirmAwaiting = confirm.indexOf("waitForRunStatus(page, ['awaiting_approval'])");
    const confirmClick = confirm.indexOf("clickApprovalEvidence(page, 'approval.confirm')");
    const dispatch = confirm.indexOf('waitForCanonicalApprovalDispatch(page)');
    const running = confirm.indexOf("waitForRunStatus(page, ['running'])");

    expect(dispatchWaiter).toContain("evidenceLocator(page, 'approval.card')");
    expect(dispatchWaiter).toContain("requireUniqueEvidence(page, 'run.status')");
    expect(dispatchWaiter).toContain("approvalKind !== 'canonical'");
    expect(dispatchWaiter).toContain("approvalStatus === 'queued'");
    expect(dispatchWaiter).toContain("runStatus === 'running'");
    expect(dispatchWaiter).toContain('kernel_smoke_evidence_ambiguous');
    expect(dispatchWaiter).toContain('kernel_smoke_approval_dispatch_terminal_before_running');
    expect(dispatchWaiter).toContain('kernel_smoke_approval_dispatch_timeout');
    expect(confirmSubmit).toBeGreaterThan(0);
    expect(confirmAwaiting).toBeGreaterThan(confirmSubmit);
    expect(confirmClick).toBeGreaterThan(confirmAwaiting);
    expect(dispatch).toBeGreaterThan(confirmClick);
    expect(running).toBeGreaterThan(dispatch);
    expect(confirm).not.toContain("waitForRunStatus(page, ['completed'])");

    const dangerous = driver.slice(
      driver.indexOf("case 'approval_dangerous':"),
      driver.indexOf("case 'artifact_provider':"),
    );
    const dangerSubmit = dangerous.indexOf('submitChatFixture(page,');
    const dangerAwaiting = dangerous.indexOf("waitForRunStatus(page, ['awaiting_approval'])");
    const dangerClick = dangerous.indexOf(
      "clickApprovalEvidence(page, 'approval.confirm-dangerous')",
    );
    const completed = dangerous.indexOf("waitForRunStatus(page, ['completed'])");
    expect(dangerSubmit).toBeGreaterThan(0);
    expect(dangerAwaiting).toBeGreaterThan(dangerSubmit);
    expect(dangerClick).toBeGreaterThan(dangerAwaiting);
    expect(completed).toBeGreaterThan(dangerClick);
  });

  it('opens the collapsed Command Center before selecting Outputs in every artifact row', () => {
    const normalizer = driver.slice(
      driver.indexOf('async function prepareCollapsedCommandCenter(page)'),
      driver.indexOf(
        '\nasync function ',
        driver.indexOf('async function prepareCollapsedCommandCenter(page)') + 1,
      ),
    );
    expect(normalizer).toContain("requireUniqueEvidence(page, 'command-center.disclosure')");
    expect(normalizer).toContain("getAttribute('aria-expanded')");
    expect(normalizer).toContain("fail('kernel_smoke_command_center_expansion_invalid')");
    expect(normalizer).toContain("waitForAttribute(disclosure, 'aria-expanded', ['false'])");

    const artifactCases = [
      ['artifact_provider', 'artifact_file_action'],
      ['artifact_file_action', 'artifact_terminal'],
      ['artifact_terminal', 'schedule_transport_retry'],
    ] as const;

    for (const [current, next] of artifactCases) {
      const scenario = driver.slice(
        driver.indexOf(`case '${current}':`),
        driver.indexOf(`case '${next}':`),
      );
      const normalize = scenario.indexOf('prepareCollapsedCommandCenter(page)');
      const submit = scenario.indexOf('submitChatFixture(page,');
      const disclosure = scenario.indexOf("clickEvidence(page, 'command-center.disclosure')");
      const outputs = scenario.indexOf("clickEvidence(page, 'outputs.tab')");
      expect(submit).toBeGreaterThan(-1);
      expect(normalize).toBeGreaterThan(submit);
      expect(disclosure).toBeGreaterThan(normalize);
      expect(outputs).toBeGreaterThan(disclosure);
    }

    const terminal = driver.slice(
      driver.indexOf("case 'artifact_terminal':"),
      driver.indexOf("case 'schedule_transport_retry':"),
    );
    const awaitingApproval = terminal.indexOf("waitForRunStatus(page, ['awaiting_approval'])");
    const dangerousApproval = terminal.indexOf(
      "clickApprovalEvidence(page, 'approval.confirm-dangerous')",
    );
    const terminalAttach = terminal.indexOf("requireUniqueEvidence(page, 'terminal.execution')");
    const chatReturn = terminal.indexOf("clickEvidence(page, 'chat.return')");
    const terminalDisclosure = terminal.indexOf("clickEvidence(page, 'command-center.disclosure')");
    expect(awaitingApproval).toBeGreaterThan(terminal.indexOf('submitChatFixture(page,'));
    expect(dangerousApproval).toBeGreaterThan(awaitingApproval);
    expect(terminalAttach).toBeGreaterThan(dangerousApproval);
    expect(chatReturn).toBeGreaterThan(terminalAttach);
    expect(terminalDisclosure).toBeGreaterThan(chatReturn);
    expect(tabStrip).toContain(
      'data-sik-evidence={KERNEL_SMOKE_ENABLED && active ? SIK_CONTROL.chatReturn : undefined}',
    );

    for (const [current, next, status] of [
      ['live_evidence_restart', 'command_center_reduced_motion', 'completed'],
      ['command_center_reduced_motion', 'cancel_before_claim', 'completed'],
    ] as const) {
      const scenario = driver.slice(
        driver.indexOf(`case '${current}':`),
        driver.indexOf(`case '${next}':`),
      );
      const submit = scenario.indexOf('submitChatFixture(page,');
      const completed = scenario.indexOf(`waitForRunStatus(page, ['${status}'])`);
      const normalize = scenario.indexOf('prepareCollapsedCommandCenter(page)');
      expect(completed).toBeGreaterThan(submit);
      expect(normalize).toBeGreaterThan(completed);
    }
  });

  it('reads reconstructed live evidence through the account-bound host without widening Command Center run scope', () => {
    expect(app).toContain('function KernelSmokeReconstructedLiveEvidenceHost');
    expect(app).toContain('binding.dataPort.getLiveEvidenceSnapshot({ accountId, runId: run.id })');
    expect(app).toContain('data-sik-evidence="live.reconstructed-node"');
    expect(driver).toContain("liveNodeEvidence(page, 'live.reconstructed-node')");
    expect(driver).toContain('waitForReconstructedLiveNodeEvidence(');
    expect(driver).toContain('completedProofs,\n          orphanProofs,');
  });

  it('requires exact terminal live-proof restoration without blanks, duplicates, or orphan activity', () => {
    const helper = driver.slice(
      driver.indexOf('const LIVE_PROOF_REF_PATTERN'),
      driver.indexOf('async function runScenario'),
    );
    expect(helper).toContain('/^jlive_[a-f0-9]{64}$/');
    expect(helper).toContain("['completed', 'degraded'].includes(state)");
    expect(helper).toContain('kernel_smoke_live_proof_ref_invalid');
    expect(helper).toContain('kernel_smoke_live_proof_duplicate');
    expect(helper).toContain('kernel_smoke_live_completed_proof_not_restored');
    expect(helper).toContain('kernel_smoke_live_orphan_active_restored');
    expect(helper).toContain('for (const proofRef of completedProofs)');
    expect(helper).toContain('observedProofs.size !== completedProofs.size');
    expect(helper).toContain('kernel_smoke_live_unexpected_terminal_proof_restored');

    const restart = driver.slice(
      driver.indexOf("case 'live_evidence_restart':"),
      driver.indexOf("case 'command_center_reduced_motion':"),
    );
    expect((restart.match(/validateExpectedLiveNodes\(/g) ?? []).length).toBe(4);
    expect(restart).toContain('completedNodes,');
    expect(restart).toContain('activeNodes,');
    expect(restart).toContain('assertExactReconstructedLiveNodeEvidence(');
  });

  it('attests zero motion across the full Command Center subtree and pseudo-elements', () => {
    const helper = driver.slice(
      driver.indexOf('async function reducedMotionEvidence'),
      driver.indexOf('async function readAttributes'),
    );
    expect(helper).toContain("selector: '*'");
    expect(helper).toContain("session.send('DOM.querySelectorAll'");
    expect(helper).toContain("session.send('DOM.describeNode'");
    expect(helper).toContain('pseudoElements');
    expect(helper).toContain('for (const nodeId of checkedNodeIds)');
    expect(helper).toContain('checkedNodeCount');
    expect(helper).toContain('pseudoElementCount');
    expect(helper).toContain('zeroMotion: true');
  });

  it('reports closed terminal-artifact stage codes without exposing Playwright errors', () => {
    const helper = driver.slice(
      driver.indexOf('async function runClosedStage(code, operation)'),
      driver.indexOf(
        '\nasync function ',
        driver.indexOf('async function runClosedStage(code, operation)') + 1,
      ),
    );
    expect(helper).toContain("fail('kernel_smoke_driver_stage_invalid')");
    expect(helper).toContain("if (typeof error?.code === 'string') throw error");
    expect(helper).toContain('fail(code)');

    const terminal = driver.slice(
      driver.indexOf("case 'artifact_terminal':"),
      driver.indexOf("case 'schedule_transport_retry':"),
    );
    for (const code of [
      'kernel_smoke_artifact_terminal_submit_failed',
      'kernel_smoke_artifact_terminal_approval_wait_failed',
      'kernel_smoke_artifact_terminal_approval_click_failed',
      'kernel_smoke_artifact_terminal_attach_wait_failed',
      'kernel_smoke_artifact_terminal_chat_return_failed',
      'kernel_smoke_artifact_terminal_disclosure_prepare_failed',
      'kernel_smoke_artifact_terminal_disclosure_click_failed',
      'kernel_smoke_artifact_terminal_outputs_click_failed',
      'kernel_smoke_artifact_terminal_completion_wait_failed',
    ]) {
      expect(terminal).toContain(`runClosedStage('${code}'`);
    }
  });

  it('requires safe-auto canonical completion before accepting its settled card', () => {
    const scenario = driver.slice(
      driver.indexOf("case 'approval_safe_auto':"),
      driver.indexOf("case 'approval_confirm':"),
    );
    const submit = scenario.indexOf('submitChatFixture');
    const card = scenario.indexOf("requireUniqueEvidence(page, 'approval.card')");
    const canonical = scenario.indexOf("'data-approval-kind', ['canonical']");
    const settled = scenario.indexOf("'data-status', ['success']");
    const completed = scenario.indexOf("waitForRunStatus(page, ['completed'])");

    expect(submit).toBeGreaterThan(-1);
    expect(completed).toBeGreaterThan(submit);
    expect(card).toBeGreaterThan(completed);
    expect(canonical).toBeGreaterThan(card);
    expect(settled).toBeGreaterThan(canonical);
    expect(scenario).not.toContain("'data-approval-kind', ['legacy']");
    expect(scenario).not.toContain("'data-status', ['pending']");
  });

  it('fails closed when the driver is invoked directly without its attested arguments', () => {
    const result = spawnSync(process.execPath, [driverPath], {
      cwd: root,
      encoding: 'utf8',
      timeout: 30_000,
    });

    expect(result.status).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr.trim()).toBe('kernel_smoke_arguments_invalid');
  });

  it('persists restart checkpoints before requesting one bounded relaunch', () => {
    expect(driver).toContain('const restartCheckpoint = await readRestartCheckpoint(options)');
    const runScenarioCall = driver.slice(
      driver.indexOf('const scenarioResult = await runScenario('),
      driver.indexOf('const outcome ='),
    );
    expect(runScenarioCall).toContain('page');
    expect(runScenarioCall).toContain('options.scenario');
    expect(runScenarioCall).toContain('restartCheckpoint');
    expect(runScenarioCall).toContain('options.evidenceDirectory');
    expect(driver).toContain("if (outcome === 'RESTART_REQUIRED')");
    expect(driver).toContain('await writeRestartCheckpoint(options, binding, restartBefore)');
    expect(driver).toContain('process.exitCode = 10');
    expect(driver).toContain('restartCheckpoint.binding.profileSha256 !== binding.profileSha256');
    expect(driver.indexOf("if (outcome === 'RESTART_REQUIRED')")).toBeLessThan(
      driver.indexOf('const evidence = Object.freeze'),
    );
  });
});
