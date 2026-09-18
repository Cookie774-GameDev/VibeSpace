import assert from 'node:assert/strict';
import test from 'node:test';
import { validateFrozenManifest, verifyFrozenRuntime } from './run-native.mjs';

function manifest() {
  return {
    schemaVersion: 1,
    candidate: {
      head: 'a'.repeat(40),
      sourceManifestHash: 'b'.repeat(64),
      nativeBinaryHash: 'c'.repeat(64),
    },
    runtime: {
      profile: 'C:\\task\\profile-c\\EBWebView',
      mainTarget: 'main',
      appPid: 100,
      webviewPid: 110,
    },
    limits: {
      realChatSubmissions: 2,
      parallelUiControllers: 1,
      providerTurnDeadlineMs: 120000,
    },
    scenarios: [{
      id: 'A-NATIVE-BINDING',
      sourceDependencies: ['scripts/pr31-native-acceptance-harness.mjs'],
      fixtureHash: null,
      expectedResult: 'exact native identity',
      deadlineMs: 10000,
      allowedEffects: ['read-only process inspection'],
      providerCostClassification: 'none',
      evidenceRequirements: ['app/webview/profile/CDP'],
    }],
    priorEvidence: [],
    excludedClaims: ['all-provider interoperability', 'statistical reliability', 'unmeasured savings'],
  };
}
function state() {
  return {
    capturedAt: '2026-09-18T12:00:00.000Z',
    processes: [
      { Name: 'jarvis.exe', ProcessId: 100, ParentProcessId: 1, ExecutablePath: 'D:\\task\\jarvis.exe' },
      { Name: 'msedgewebview2.exe', ProcessId: 110, ParentProcessId: 100, CommandLine: '"edge" --user-data-dir=C:\\task\\profile-c\\EBWebView --remote-debugging-port=9251' },
    ],
    listeners: [{ LocalAddress: '127.0.0.1', LocalPort: 9251, OwningProcess: 110 }],
  };
}

test('accepts a frozen two-turn manifest and exact observed runtime identity', () => {
  const value = manifest();
  assert.equal(validateFrozenManifest(value), value);
  const identity = verifyFrozenRuntime(value, state(), {
    head: value.candidate.head,
    sourceManifestHash: value.candidate.sourceManifestHash,
    nativeBinaryHash: value.candidate.nativeBinaryHash,
  });
  assert.equal(identity.appPid, 100);
  assert.equal(identity.webviewPid, 110);
  assert.equal(identity.cdpPort, 9251);
  assert.equal(identity.mainTarget, 'main');
});

test('rejects placeholders, changed candidates, wrong profiles, wrong ownership and relaxed limits', () => {
  const value = manifest();
  assert.throws(
    () => validateFrozenManifest({ ...value, candidate: { ...value.candidate, head: 'observed' } }),
    /head_invalid/u,
  );
  assert.throws(
    () => validateFrozenManifest({ ...value, limits: { ...value.limits, realChatSubmissions: 3 } }),
    /limits_invalid/u,
  );
  assert.throws(
    () => verifyFrozenRuntime(value, state(), { head: 'd'.repeat(40) }),
    /head_changed/u,
  );
  const wrongProfile = state();
  wrongProfile.processes[1].CommandLine = '"edge" --user-data-dir=C:\\other\\EBWebView --remote-debugging-port=9251';
  assert.throws(() => verifyFrozenRuntime(value, wrongProfile), /profile_mismatch/u);
  const wrongOwner = state();
  wrongOwner.processes[1].ParentProcessId = 999;
  assert.throws(() => verifyFrozenRuntime(value, wrongOwner), /not_owned/u);
  const wrongListener = state();
  wrongListener.listeners[0].OwningProcess = 999;
  assert.throws(() => verifyFrozenRuntime(value, wrongListener), /cdp_ownership_mismatch/u);
});
