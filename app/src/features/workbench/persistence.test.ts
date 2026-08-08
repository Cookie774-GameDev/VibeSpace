import { beforeEach, describe, expect, it } from 'vitest';
import {
  LAST_KNOWN_GOOD_KEY,
  WORKBENCH_STORAGE_KEY,
  loadWorkbenchDocument,
  saveWorkbenchDocument,
  serializeContentFingerprint,
} from './persistence';
import { createDefaultWorkbenchDocument } from './store';

describe('Workbench persistence', () => {
  beforeEach(() => window.localStorage.clear());

  it('writes a versioned document with name/revision and keeps LKG', () => {
    const document = createDefaultWorkbenchDocument();
    document.name = 'Desk One';
    document.panels[0]!.title = 'Terminal — no transcript is stored';

    const result = saveWorkbenchDocument(document, window.localStorage);
    expect(result.ok).toBe(true);
    expect(result.document?.revision).toBeGreaterThan(0);
    expect(window.localStorage.getItem(WORKBENCH_STORAGE_KEY)).toContain('"version":1');
    expect(window.localStorage.getItem(WORKBENCH_STORAGE_KEY)).toContain('Desk One');
    expect(window.localStorage.getItem(LAST_KNOWN_GOOD_KEY)).toBe(
      window.localStorage.getItem(WORKBENCH_STORAGE_KEY),
    );
  });

  it('recovers from a corrupt primary document without persisting terminal output', () => {
    const document = createDefaultWorkbenchDocument();
    saveWorkbenchDocument(document, window.localStorage);
    window.localStorage.setItem(WORKBENCH_STORAGE_KEY, '{broken');

    const recovered = loadWorkbenchDocument(window.localStorage);
    expect(recovered.source).toBe('last-known-good');
    expect(recovered.document.panels.length).toBeGreaterThan(0);
    expect(JSON.stringify(recovered.document)).not.toContain('transcript');
  });

  it('redacts secret-like terminal startup values before writing layout state', () => {
    const document = createDefaultWorkbenchDocument();
    document.panels[0]!.settings.command = 'deploy --api-key=sk-super-secret-value';

    saveWorkbenchDocument(document, window.localStorage);
    const serialized = window.localStorage.getItem(WORKBENCH_STORAGE_KEY) ?? '';
    expect(serialized).not.toContain('sk-super-secret-value');
    expect(serialized).toContain('[redacted]');
  });

  it('drops unsafe persisted wallpaper assets', () => {
    const document = createDefaultWorkbenchDocument();
    document.wallpaper = {
      ...document.wallpaper,
      id: 'custom-image',
      assetUrl: 'javascript:alert(document.cookie)',
    };

    saveWorkbenchDocument(document, window.localStorage);
    const loaded = loadWorkbenchDocument(window.localStorage);
    expect(loaded.document.wallpaper.assetUrl).toBeUndefined();
    expect(window.localStorage.getItem(WORKBENCH_STORAGE_KEY)).not.toContain('javascript:');
  });

  it('defaults wallpaper brightness to 50 percent and clamps persisted values', () => {
    const document = createDefaultWorkbenchDocument();
    expect(document.wallpaper.brightness).toBe(0.5);
    const serialized = JSON.parse(JSON.stringify(document)) as {
      wallpaper: { brightness: number };
    };
    serialized.wallpaper.brightness = 4;
    window.localStorage.setItem(WORKBENCH_STORAGE_KEY, JSON.stringify(serialized));

    expect(loadWorkbenchDocument(window.localStorage).document.wallpaper.brightness).toBe(1);
  });

  it('rejects stale multi-window writes when storage revision is newer', () => {
    const first = createDefaultWorkbenchDocument();
    first.name = 'Window A';
    const saved = saveWorkbenchDocument(first, window.localStorage);
    expect(saved.ok).toBe(true);
    const revision = saved.document!.revision;

    const stale = createDefaultWorkbenchDocument();
    stale.name = 'Stale window';
    stale.revision = 0;
    const rejected = saveWorkbenchDocument(stale, window.localStorage, {
      lastKnownRevision: 0,
    });
    expect(rejected.ok).toBe(false);
    expect(rejected.reason).toBe('stale');
    expect(rejected.document?.name).toBe('Window A');
    expect(rejected.document?.revision).toBe(revision);

    const okWrite = saveWorkbenchDocument(
      { ...stale, name: 'Window B', revision },
      window.localStorage,
      { lastKnownRevision: revision },
    );
    expect(okWrite.ok).toBe(true);
    expect(okWrite.document?.name).toBe('Window B');
  });

  it('fingerprints content without revision noise', () => {
    const a = createDefaultWorkbenchDocument();
    const b = { ...a, revision: 99, updatedAt: Date.now() + 999 };
    expect(serializeContentFingerprint(a)).toBe(serializeContentFingerprint(b));
    b.name = 'Different';
    expect(serializeContentFingerprint(a)).not.toBe(serializeContentFingerprint(b));
  });
});
