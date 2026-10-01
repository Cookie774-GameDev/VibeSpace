import test from 'node:test';
import assert from 'node:assert/strict';
import { validateSpec, verifyAttestation, createDeadline, validateBinding, assertSameBinding, verifyReceipt, inside, hasEchoOutput, safeFailure } from './contract.mjs';

const spec = () => ({ schema: 1, taskId: 'FRESH2_NS01', grantId: 'ROOT-REMOTE-SMOKE-R1',
  issuedAtMs: 1000, expiresAtMs: 901000,
  sourceSHA: '8579072d21e6a994b3c95f44997922997679324a',
  exeSHA256: '23974fdf89067d4f2399b0f367c54ce64e9350f82e4cdca38b11652aee61956e',
  workspace: 'D:\\a\\VibeSpace\\VibeSpace', runnerTemp: 'D:\\a\\_temp',
  artifactRoot: 'D:\\a\\_temp\\FRESH2_NS01\\staging\\build',
  frontendRoot: 'D:\\a\\VibeSpace\\VibeSpace', inputManifestSHA256: 'a'.repeat(64),
  app: { pid: 100, bornMs: 100, exePath: 'D:\\a\\_temp\\FRESH2_NS01\\staging\\build\\binary\\jarvis.exe' },
  webview: { pid: 200, bornMs: 200, exePath: 'C:\\Program Files\\Microsoft\\EdgeWebView\\Application\\1\\msedgewebview2.exe', profile: 'D:\\a\\_temp\\FRESH2_NS01\\webview' },
  cdpPort: 9228, mainURL: 'http://localhost:5173/', windowLabel: 'main',
  nativeDataPath: 'C:\\Users\\runner\\AppData\\Roaming\\com.jarvis.app',
  cleanProfileReceipt: { capturedAtMs: 50, nativeDataAbsentBeforeStart: true, webviewProfileAbsentBeforeStart: true, ordinaryBlankWorkbenchPreparation: true },
  phaseMs: 60000, totalMs: 900000, schedule: false,
});
const observation = () => ({ capturedAtMs: 1100, sourceSHA: spec().sourceSHA,
  exeSHA256: spec().exeSHA256, app: spec().app, webview: spec().webview,
  profileMatches: true, debugPortMatches: true,
  processes: [{ pid: 100, parentPid: 1, bornMs: 100 }, { pid: 150, parentPid: 100, bornMs: 150 }, { pid: 200, parentPid: 150, bornMs: 200 }],
  listener: { ownerPid: 200, port: 9228, address: '127.0.0.1' },
  loadedModules: [{ name: 'DirectML.dll', path: spec().artifactRoot + '\\binary\\DirectML.dll', sha256: 'b'.repeat(64) }],
  webviewRuntimeVersion: '1.0', nativeDataExists: true,
});
test('accepts exact approved CI488 identity only', () => {
  assert.equal(validateSpec(spec(), 1100).sourceSHA, spec().sourceSHA);
  for (const patch of [{ sourceSHA: '0'.repeat(40) }, { exeSHA256: '0'.repeat(64) }, { expiresAtMs: 1099 }, { phaseMs: 60001 }, { totalMs: 900001 }])
    assert.throws(() => validateSpec({ ...spec(), ...patch }, 1100));
});
test('binds actual artifact staging to the granted task under runner temp', () => {
  assert.equal(validateSpec(spec(), 1100).artifactRoot, spec().artifactRoot);
  for (const root of ['D:\\a\\_temp\\PEER_TASK\\staging\\build', 'D:\\a\\workspace\\artifact', 'D:\\a\\_temp\\FRESH2_NS01\\staging\\foreign']) {
    assert.throws(() => validateSpec({ ...spec(), artifactRoot: root }, 1100), /smoke_artifact_task_scope/);
  }
});
test('rejects unknown credential fields and cloud/browser URLs', () => {
  for (const patch of [{ token: 'private' }, { mainURL: 'https://example.com/' }, { mainURL: 'http://localhost:5173/?smoke=1' }])
    assert.throws(() => validateSpec({ ...spec(), ...patch }, 1100));
});
test('rejects path escape, alias, sibling prefixes, reserved names and UNC', () => {
  for (const path of ['D:\\a\\_temp-peer\\x', 'D:\\a\\_temp\\..\\secret', 'D:\\a\\_temp\\NUL', 'D:\\a\\_temp\\alias.', '\\\\server\\share'])
    assert.throws(() => inside('D:\\a\\_temp', path));
  assert.equal(inside('D:\\a\\_temp', 'D:\\a\\_temp\\owned'), 'd:\\a\\_temp\\owned');
});
test('rejects stale receipt and PID reuse', () => {
  assert.equal(verifyAttestation(spec(), observation(), 1200).listener.ownerPid, 200);
  for (const patch of [{ capturedAtMs: -10000 }, { app: { ...spec().app, bornMs: 101 } }, { webview: { ...spec().webview, bornMs: 201 } }])
    assert.throws(() => verifyAttestation(spec(), { ...observation(), ...patch }, 1200));
});
test('rejects foreign WebView ancestry, cycle and non-loopback listener', () => {
  for (const patch of [{ processes: [{ pid: 200, parentPid: 999, bornMs: 200 }] }, { processes: [{ pid: 200, parentPid: 200, bornMs: 200 }] }, { listener: { ownerPid: 200, port: 9228, address: '0.0.0.0' } }, { profileMatches: false }])
    assert.throws(() => verifyAttestation(spec(), { ...observation(), ...patch }, 1200));
});
test('deadline is global and phase bounded, backwards clock fails closed', () => {
  let now = 0;
  const d = createDeadline(100, () => now);
  assert.equal(d.remaining(20), 20);
  now = 99; assert.equal(d.remaining(20), 1);
  now = 100; assert.throws(() => d.remaining(20));
  now = 1; const x = createDeadline(10, () => now); now = 0; assert.throws(() => x.remaining());
});
test('PTY binding requires session, OS birth, instance and runtime generation', () => {
  const b = { sessionId: 'tty_real', processInstanceId: 'opaque', pid: 300, processStartedAt: 300, runtimeGeneration: 'generation', command: 'powershell.exe' };
  assert.equal(validateBinding(b).pid, 300);
  for (const key of ['sessionId', 'processInstanceId', 'pid', 'processStartedAt', 'runtimeGeneration'])
    assert.throws(() => validateBinding({ ...b, [key]: null }));
  assert.throws(() => assertSameBinding(b, { ...b, processStartedAt: 301 }));
  assert.throws(() => validateBinding({ ...b, command: 'powershell.exe -Command Invoke-WebRequest' }));
});
test('echo proof requires output line, not command/input echo or another session', () => {
  assert.equal(hasEchoOutput('PS> echo FRESH2_NATIVE_NS01\r\n', 'FRESH2_NATIVE_NS01'), false);
  assert.equal(hasEchoOutput('\u001b[32mFRESH2_NATIVE_NS01\u001b[0m\r\nPS>', 'FRESH2_NATIVE_NS01'), true);
});
test('receipt cannot invent native PASS with missing binding, echo or cleanup', () => {
  const receipt = { runtimeStatus: 'PASS', steps: { identity: 'PASS', onboarding: 'PASS', terminal: 'PASS' },
    sourceSHA: spec().sourceSHA, exeSHA256: spec().exeSHA256, echoObserved: true, cancelClosePreservedBinding: true, noAutorunSettings: true,
    binding: { sessionId: 'tty_real', processInstanceId: 'opaque', pid: 300, processStartedAt: 300, runtimeGeneration: 'generation', command: 'powershell.exe' },
    cleanup: { sessionAbsent: true, originalProcessAbsent: true }, providerAcceptance: 'UNRUN', physicalCAcceptance: 'UNRUN' };
  verifyReceipt(receipt);
  for (const patch of [{ binding: null }, { echoObserved: false }, { cancelClosePreservedBinding: false }, { noAutorunSettings: false }, { cleanup: { sessionAbsent: true, originalProcessAbsent: false } }, { providerAcceptance: 'PASS' }])
    assert.throws(() => verifyReceipt({ ...receipt, ...patch }));
});
test('raw exceptions never enter evidence', () => {
  assert.equal(safeFailure(new Error('https://private/?token=secret')), 'unexpected_failure');
  assert.equal(safeFailure(new Error('smoke_pid_birth_changed')), 'smoke_pid_birth_changed');
});
