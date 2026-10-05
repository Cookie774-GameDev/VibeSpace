import { beforeEach, describe, expect, it } from 'vitest';
import {
  createTelemetryConsentStore,
  canCollectAppDiagnostics,
  APP_DIAGNOSTICS_CONSENT_KEY,
  DEFAULT_TELEMETRY_CONSENT,
  type TelemetryStorage,
} from './telemetryConsent';

function memoryStorage(): TelemetryStorage {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => void values.set(key, value),
    removeItem: (key) => void values.delete(key),
  };
}

describe('telemetry consent', () => {
  let storage: TelemetryStorage;

  beforeEach(() => {
    storage = memoryStorage();
  });

  it('is fully off by default and records explicit granular consent changes', () => {
    const store = createTelemetryConsentStore(storage, () => 1_000);
    expect(store.getSnapshot().consent).toEqual(DEFAULT_TELEMETRY_CONSENT);

    store.updateConsent({ productUsage: true, diagnostics: true });
    expect(store.getSnapshot().consent).toMatchObject({
      productUsage: true,
      diagnostics: true,
      toolOutcomes: false,
    });
    expect(store.getSnapshot().audit).toEqual([
      expect.objectContaining({
        action: 'consent_updated',
        enabledClasses: ['product_usage', 'diagnostics'],
      }),
    ]);
  });

  it('revokes every optional class without deleting the consent audit', () => {
    const store = createTelemetryConsentStore(storage, () => 2_000);
    store.updateConsent({ productUsage: true, diagnostics: true, toolOutcomes: true });
    store.revoke();
    expect(store.getSnapshot().consent).toEqual(DEFAULT_TELEMETRY_CONSENT);
    expect(store.getSnapshot().audit.at(-1)?.action).toBe('consent_revoked');
  });

  it('stops local collection and notifies listeners even when persistence fails', () => {
    const store = createTelemetryConsentStore(storage);
    store.updateConsent({ productUsage: true, diagnostics: true, toolOutcomes: true });
    storage.setItem = () => {
      throw new Error('quota');
    };
    let notifications = 0;
    store.subscribe(() => {
      notifications += 1;
    });
    expect(() => store.revoke()).not.toThrow();
    expect(store.getSnapshot().consent).toEqual(DEFAULT_TELEMETRY_CONSENT);
    expect(store.getSnapshot().storageError).toBe(true);
    expect(notifications).toBe(1);
  });

  it('fails closed without crashing when persisted consent cannot be read', () => {
    storage.getItem = () => {
      throw new Error('storage blocked');
    };
    const store = createTelemetryConsentStore(storage);
    expect(store.getSnapshot().consent).toEqual(DEFAULT_TELEMETRY_CONSENT);
    expect(store.getSnapshot().storageError).toBe(true);
  });

  it('exports a content-free audit and supports local deletion', () => {
    const store = createTelemetryConsentStore(storage, () => 3_000);
    store.updateConsent({ toolOutcomes: true });
    const exported = JSON.parse(store.exportAudit()) as Record<string, unknown>;
    expect(JSON.stringify(exported)).not.toContain('prompt');
    expect(exported).toMatchObject({ schemaVersion: 1 });

    store.deleteAudit();
    expect(store.getSnapshot().audit).toEqual([]);
  });

  it('never invents a reward when authoritative billing configuration is absent', () => {
    const store = createTelemetryConsentStore(storage, () => 4_000, {});
    expect(store.getSnapshot().reward).toEqual({
      configured: false,
      label: null,
      status: 'unavailable',
    });
  });
});

const expandedState = {
  enabled: true,
  eligible: true,
  policyVersion: 'telemetry-app-diagnostics-2026-10-05-v1',
  acceptedPolicyVersion: 'telemetry-app-diagnostics-2026-10-05-v1',
  diagnosticsScope: 'app-diagnostics-v1',
  acceptedDiagnosticsScope: 'app-diagnostics-v1',
  supportedSchemaVersions: [1, 2],
  noticeUrl: 'https://example.test/notice',
  discountPercent: 10,
  requiredDataClasses: ['product_usage', 'diagnostics', 'tool_outcomes'],
} as const;

describe('fresh device consent for expanded diagnostics', () => {
  it('never converts legacy all-class flags into expanded acceptance', () => {
    const storage = memoryStorage();
    const store = createTelemetryConsentStore(storage, () => 1_000);
    store.updateConsent({ productUsage: true, diagnostics: true, toolOutcomes: true });
    expect(store.getSnapshot().appDiagnosticsConsent).toBeNull();
    expect(createTelemetryConsentStore(storage).getSnapshot().appDiagnosticsConsent).toBeNull();
  });
  it('persists only explicit acceptance bound to its account, scope, policy and timestamp', () => {
    const storage = memoryStorage();
    const store = createTelemetryConsentStore(storage, () => 1_000);
    store.updateConsent({ productUsage: true, diagnostics: true, toolOutcomes: true });
    expect(store.acceptAppDiagnostics('a', expandedState)).toBe(true);
    expect(store.getSnapshot().appDiagnosticsConsent).toEqual({
      accountId: 'a',
      policyVersion: expandedState.policyVersion,
      scope: 'app-diagnostics-v1',
      acceptedAt: 1_000,
    });
    expect(createTelemetryConsentStore(storage).getSnapshot().appDiagnosticsConsent).toEqual(
      store.getSnapshot().appDiagnosticsConsent,
    );
    expect(store.exportAudit()).not.toContain('"accountId"');
  });
  it.each([
    { acceptedPolicyVersion: 'old-policy' },
    { acceptedDiagnosticsScope: null },
    { diagnosticsScope: 'future-scope' },
    { supportedSchemaVersions: [1] },
    { enabled: false },
    { eligible: false },
    { withdrawal: { status: 'pending' as const } },
  ])('rejects incomplete or stale server acceptance %j', (patch) => {
    const store = createTelemetryConsentStore(memoryStorage());
    store.updateConsent({ productUsage: true, diagnostics: true, toolOutcomes: true });
    expect(store.acceptAppDiagnostics('a', { ...expandedState, ...patch })).toBe(false);
    expect(store.getSnapshot().appDiagnosticsConsent).toBeNull();
  });
  it('clears expanded acceptance synchronously when any class is disabled, without restoring it on re-enable', () => {
    const store = createTelemetryConsentStore(memoryStorage());
    store.updateConsent({ productUsage: true, diagnostics: true, toolOutcomes: true });
    store.acceptAppDiagnostics('a', expandedState);
    const before = store.getSnapshot().revision;
    store.updateConsent({ diagnostics: false });
    expect(store.getSnapshot().appDiagnosticsConsent).toBeNull();
    expect(store.getSnapshot().revision).toBeGreaterThan(before);
    store.updateConsent({ diagnostics: true });
    expect(store.getSnapshot().appDiagnosticsConsent).toBeNull();
  });
  it('revokes the expanded scope even when storage writes fail', () => {
    const storage = memoryStorage();
    const store = createTelemetryConsentStore(storage);
    store.updateConsent({ productUsage: true, diagnostics: true, toolOutcomes: true });
    store.acceptAppDiagnostics('a', expandedState);
    storage.setItem = () => {
      throw new Error('synthetic quota');
    };
    store.revoke();
    expect(store.getSnapshot().appDiagnosticsConsent).toBeNull();
    expect(store.getSnapshot().storageError).toBe(true);
  });
  it('requires the current account and accepted server scope on every collector admission', () => {
    const store = createTelemetryConsentStore(memoryStorage());
    store.updateConsent({ productUsage: true, diagnostics: true, toolOutcomes: true });
    store.acceptAppDiagnostics('a', expandedState);
    expect(canCollectAppDiagnostics(store.getSnapshot(), 'a', expandedState)).toBe(true);
    expect(canCollectAppDiagnostics(store.getSnapshot(), 'b', expandedState)).toBe(false);
    expect(canCollectAppDiagnostics(store.getSnapshot(), null, expandedState)).toBe(false);
    expect(canCollectAppDiagnostics(store.getSnapshot(), 'a', null)).toBe(false);
    expect(
      canCollectAppDiagnostics(store.getSnapshot(), 'a', {
        ...expandedState,
        acceptedPolicyVersion: 'old-policy',
      }),
    ).toBe(false);
    store.revoke();
    expect(canCollectAppDiagnostics(store.getSnapshot(), 'a', expandedState)).toBe(false);
  });
  it.each([
    '{bad json',
    JSON.stringify({
      accountId: 'a',
      policyVersion: 'old-policy',
      scope: 'app-diagnostics-v1',
      acceptedAt: 1,
    }),
    JSON.stringify({
      accountId: 'a',
      policyVersion: expandedState.policyVersion,
      scope: 'app-diagnostics-v1',
      acceptedAt: 1,
      rawError: 'PRIVATE_SENTINEL',
    }),
  ])('does not trust corrupt or expanded legacy storage %s', (stored) => {
    const storage = memoryStorage();
    const store = createTelemetryConsentStore(storage);
    store.updateConsent({ productUsage: true, diagnostics: true, toolOutcomes: true });
    storage.setItem(APP_DIAGNOSTICS_CONSENT_KEY, stored);
    expect(createTelemetryConsentStore(storage).getSnapshot().appDiagnosticsConsent).toBeNull();
  });
});

it('still persists legacy preferences when clearing the separate expanded record fails', () => {
  const storage = memoryStorage();
  const originalRemove = storage.removeItem;
  storage.removeItem = (key) => {
    if (key === APP_DIAGNOSTICS_CONSENT_KEY) throw new Error('synthetic expanded-key failure');
    originalRemove(key);
  };
  const store = createTelemetryConsentStore(storage);
  store.updateConsent({ productUsage: true });
  expect(JSON.parse(storage.getItem('vibespace-telemetry-consent-v1') ?? '{}')).toMatchObject({
    productUsage: true,
  });
  expect(store.getSnapshot().storageError).toBe(true);
  expect(store.getSnapshot().appDiagnosticsConsent).toBeNull();
});

it.each(['revoke', 'class-off'] as const)(
  'independent review never restores expanded acceptance after %s with failed scope-key cleanup and restart',
  (action) => {
    const storage = memoryStorage();
    const store = createTelemetryConsentStore(storage, () => 1000);
    const all = { productUsage: true, diagnostics: true, toolOutcomes: true };
    store.updateConsent(all);
    expect(store.acceptAppDiagnostics('a', expandedState)).toBe(true);
    const originalRemove = storage.removeItem;
    storage.removeItem = (key) => {
      if (key === APP_DIAGNOSTICS_CONSENT_KEY)
        throw new Error('synthetic scope-key cleanup failure');
      originalRemove(key);
    };
    if (action === 'revoke') store.revoke();
    else store.updateConsent({ diagnostics: false });
    expect(store.getSnapshot().appDiagnosticsConsent).toBeNull();
    expect(canCollectAppDiagnostics(store.getSnapshot(), 'a', expandedState)).toBe(false);
    store.updateConsent(all);
    expect(store.getSnapshot().appDiagnosticsConsent).toBeNull();
    storage.removeItem = originalRemove;
    const reopened = createTelemetryConsentStore(storage, () => 2000);
    expect(canCollectAppDiagnostics(reopened.getSnapshot(), 'a', expandedState)).toBe(false);
    expect(reopened.getSnapshot().appDiagnosticsConsent).toBeNull();
  },
);
it('independent review keeps acceptance revoked when cleanup later succeeds before reenabling', () => {
  const storage = memoryStorage();
  const store = createTelemetryConsentStore(storage, () => 1000);
  const all = { productUsage: true, diagnostics: true, toolOutcomes: true };
  store.updateConsent(all);
  expect(store.acceptAppDiagnostics('a', expandedState)).toBe(true);
  const originalRemove = storage.removeItem;
  storage.removeItem = (key) => {
    if (key === APP_DIAGNOSTICS_CONSENT_KEY) throw new Error('synthetic failure');
    originalRemove(key);
  };
  store.revoke();
  storage.removeItem = originalRemove;
  store.updateConsent(all);
  const reopened = createTelemetryConsentStore(storage, () => 2000);
  expect(canCollectAppDiagnostics(reopened.getSnapshot(), 'a', expandedState)).toBe(false);
  expect(reopened.getSnapshot().appDiagnosticsConsent).toBeNull();
});

it('rejects a stale expanded record restored beside a newer account acceptance even at the same timestamp', () => {
  const storage = memoryStorage();
  const store = createTelemetryConsentStore(storage, () => 1000);
  store.updateConsent({ productUsage: true, diagnostics: true, toolOutcomes: true });
  expect(store.acceptAppDiagnostics('a', expandedState)).toBe(true);
  const oldRecord = storage.getItem(APP_DIAGNOSTICS_CONSENT_KEY)!;
  expect(store.acceptAppDiagnostics('b', expandedState)).toBe(true);
  storage.setItem(APP_DIAGNOSTICS_CONSENT_KEY, oldRecord);
  const reopened = createTelemetryConsentStore(storage, () => 2000);
  expect(reopened.getSnapshot().appDiagnosticsConsent).toBeNull();
  expect(canCollectAppDiagnostics(reopened.getSnapshot(), 'a', expandedState)).toBe(false);
  expect(canCollectAppDiagnostics(reopened.getSnapshot(), 'b', expandedState)).toBe(false);
});
it('permits a new explicit acceptance after durable revocation and storage recovery', () => {
  const storage = memoryStorage();
  const store = createTelemetryConsentStore(storage, () => 1000);
  const all = { productUsage: true, diagnostics: true, toolOutcomes: true };
  store.updateConsent(all);
  store.acceptAppDiagnostics('a', expandedState);
  const originalRemove = storage.removeItem;
  storage.removeItem = (key) => {
    if (key === APP_DIAGNOSTICS_CONSENT_KEY) throw new Error('synthetic cleanup failure');
    originalRemove(key);
  };
  store.revoke();
  store.updateConsent(all);
  storage.removeItem = originalRemove;
  const reopened = createTelemetryConsentStore(storage, () => 1000);
  expect(reopened.acceptAppDiagnostics('a', expandedState)).toBe(true);
  expect(
    canCollectAppDiagnostics(
      createTelemetryConsentStore(storage).getSnapshot(),
      'a',
      expandedState,
    ),
  ).toBe(true);
});
