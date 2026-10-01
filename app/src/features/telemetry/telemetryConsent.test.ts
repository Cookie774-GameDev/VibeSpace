import { beforeEach, describe, expect, it } from 'vitest';
import {
  createTelemetryConsentStore,
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
