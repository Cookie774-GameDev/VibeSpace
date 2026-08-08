import { describe, expect, it } from 'vitest';
import { PLUGIN_CATALOG } from './catalog';
import { PLUGIN_COMPATIBILITY_BY_ID, PLUGIN_COMPATIBILITY_MATRIX } from './compatibilityMatrix';

describe('112-plugin compatibility matrix', () => {
  it('covers every catalog entry exactly once with official documentation and lifecycle rules', () => {
    expect(PLUGIN_COMPATIBILITY_MATRIX).toHaveLength(112);
    expect(new Set(PLUGIN_COMPATIBILITY_MATRIX.map((entry) => entry.id)).size).toBe(112);
    expect(PLUGIN_COMPATIBILITY_MATRIX.map((entry) => entry.id)).toEqual(
      PLUGIN_CATALOG.map((plugin) => plugin.id),
    );
    expect(
      PLUGIN_COMPATIBILITY_MATRIX.filter((entry) =>
        entry.officialDocumentation.includes('Cookie774-GameDev/VibeSpace'),
      ).map((entry) => entry.id),
    ).toEqual(['mock-connector']);
    for (const entry of PLUGIN_COMPATIBILITY_MATRIX) {
      expect(entry.officialDocumentation).toMatch(/^https:\/\//);
      expect(entry.disconnect).toContain('secure');
      expect(entry.verifiedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(entry.capabilities.officialApi).not.toBeUndefined();
      expect(entry.communityImplementation.selected).toBe(false);
      expect(entry.externalPrerequisites).toBeInstanceOf(Array);
      expect(PLUGIN_COMPATIBILITY_BY_ID[entry.id]).toBe(entry);
    }
  });

  it('does not claim one-click support for manual or backend-only connections', () => {
    for (const entry of PLUGIN_COMPATIBILITY_MATRIX) {
      if (
        entry.connectionClass === 'manual_credential' ||
        entry.connectionClass === 'official_backend'
      ) {
        expect(entry.oneClickReady).toBe(false);
      }
    }
  });

  it('never confuses protocol research with a configured production one-click flow', () => {
    for (const entry of PLUGIN_COMPATIBILITY_MATRIX) {
      if (entry.oneClickReady) {
        expect(entry.implementationPath).not.toBe('credential_form');
        expect(entry.externalPrerequisites).toHaveLength(0);
      }
      if (entry.coverageDisposition === 'shipped_manual') {
        expect(entry.implementationPath).toBe('credential_form');
        expect(entry.tokenStorage).toBe('os_secure_store');
      }
    }
  });
});
