import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CODEX_CLI_CONNECTION } from './adapters/catalog';
import { OPENAI_API_CONNECTION } from './adapters/nativeCatalog';
import {
  AI_CONNECTION_METADATA_KEY,
  AI_CONNECTION_STATE_EVENT,
  deriveAiConnectionHealth,
  isConnectionSessionChecked,
  markConnectionSessionChecked,
  readConnectionMetadata,
  readConnectionMetadataRevision,
  readConnectionPickerStates,
  readConnectionSessionPickerStates,
  resetConnectionSessionChecksForTests,
  writeConnectionMetadata,
  writeConnectionPickerStates,
} from './connectionState';

describe('AI connection state persistence', () => {
  beforeEach(() => {
    window.localStorage.clear();
    resetConnectionSessionChecksForTests();
  });

  it('persists only bounded canonical metadata and derives picker availability', () => {
    const changed = vi.fn();
    window.addEventListener(AI_CONNECTION_STATE_EVENT, changed);

    const stored = writeConnectionMetadata({
      'openai-codex': {
        installation: 'installed',
        auth: 'authenticated',
        executablePath: 'C:\\Tools\\codex.exe',
        version: 'codex-cli 1.2.3',
        lastCheckedAt: 42,
      },
      'bad id': {
        installation: 'installed',
        auth: 'authenticated',
      },
      malformed: {
        installation: 'installed',
        auth: 'authenticated',
        executablePath: `C:\\Tools\\${'x'.repeat(2_000)}`,
      },
    });

    expect(stored).toEqual({
      'openai-codex': {
        installation: 'installed',
        auth: 'authenticated',
        executablePath: 'C:\\Tools\\codex.exe',
        version: 'codex-cli 1.2.3',
        lastCheckedAt: 42,
      },
      malformed: {
        installation: 'installed',
        auth: 'authenticated',
      },
    });
    expect(readConnectionPickerStates()).toEqual({
      'openai-codex': { available: true, auth: 'authenticated' },
      malformed: { available: true, auth: 'authenticated' },
    });
    expect(changed).toHaveBeenCalledOnce();

    window.removeEventListener(AI_CONNECTION_STATE_EVENT, changed);
  });

  it('preserves independently probed native API health when external metadata changes', () => {
    writeConnectionPickerStates({
      'qwen-api': { available: false, auth: 'unauthenticated' },
    });

    writeConnectionMetadata({
      'openai-codex': {
        installation: 'installed',
        auth: 'authenticated',
      },
    });

    expect(readConnectionPickerStates()).toEqual({
      'qwen-api': { available: false, auth: 'unauthenticated' },
      'openai-codex': { available: true, auth: 'authenticated' },
    });
  });

  it('fails closed over malformed storage and keeps disabled connections unavailable', () => {
    window.localStorage.setItem(
      AI_CONNECTION_METADATA_KEY,
      JSON.stringify({
        'openai-codex': {
          installation: 'installed',
          auth: 'authenticated',
          disabled: true,
          executablePath: 'C:\\Tools\\codex.exe\u0000secret',
          version: { not: 'text' },
          lastCheckedAt: -1,
          extra: 'discard-me',
        },
        invalid: {
          installation: 'definitely-installed',
          auth: 'root',
        },
      }),
    );

    expect(readConnectionMetadata()).toEqual({
      'openai-codex': {
        installation: 'installed',
        auth: 'authenticated',
        disabled: true,
      },
    });

    writeConnectionMetadata(readConnectionMetadata());
    expect(readConnectionPickerStates()['openai-codex']).toEqual({
      available: false,
      auth: 'authenticated',
    });
  });

  it('keeps current-session scan authority in memory and never persists it', () => {
    writeConnectionMetadata({
      'openai-codex': {
        installation: 'installed',
        auth: 'authenticated',
      },
    });
    markConnectionSessionChecked(['openai-codex', 'bad id']);

    expect(isConnectionSessionChecked('openai-codex')).toBe(true);
    expect(isConnectionSessionChecked('bad id')).toBe(false);
    expect(readConnectionSessionPickerStates()).toEqual({
      'openai-codex': { available: true, auth: 'authenticated' },
    });
    expect(window.localStorage.getItem('vibespace.ai-connection-session-checks')).toBeNull();

    resetConnectionSessionChecksForTests();
    expect(isConnectionSessionChecked('openai-codex')).toBe(false);
    expect(readConnectionSessionPickerStates()).toEqual({});
  });

  it('notifies mounted consumers even when localStorage persistence fails', () => {
    writeConnectionMetadata({
      'openai-codex': {
        installation: 'installed',
        auth: 'authenticated',
      },
    });
    markConnectionSessionChecked(['openai-codex']);
    const changed = vi.fn();
    window.addEventListener(AI_CONNECTION_STATE_EVENT, changed);
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('Storage unavailable', 'QuotaExceededError');
    });

    try {
      writeConnectionMetadata({
        'openai-codex': {
          installation: 'installed',
          auth: 'unauthenticated',
        },
      });
      expect(readConnectionSessionPickerStates()).toEqual({
        'openai-codex': { available: true, auth: 'unauthenticated' },
      });
      expect(changed).toHaveBeenCalledOnce();
    } finally {
      setItem.mockRestore();
      window.removeEventListener(AI_CONNECTION_STATE_EVENT, changed);
    }
  });

  it('retains an in-memory mutation revision across an ABA metadata change', () => {
    const baselineRevision = readConnectionMetadataRevision('openai-codex');

    writeConnectionMetadata({
      'openai-codex': {
        installation: 'unknown',
        auth: 'unknown',
        disabled: true,
      },
    });
    writeConnectionMetadata({});

    expect(readConnectionMetadata()).toEqual({});
    expect(readConnectionMetadataRevision('openai-codex')).toBeGreaterThan(baselineRevision);
  });

  it('keeps a failed metadata write authoritative in memory until persistence recovers', () => {
    writeConnectionMetadata({
      'openai-codex': {
        installation: 'installed',
        auth: 'authenticated',
      },
    });
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('Storage unavailable', 'QuotaExceededError');
    });

    try {
      writeConnectionMetadata({
        'openai-codex': {
          installation: 'installed',
          auth: 'authenticated',
          disabled: true,
        },
      });

      expect(readConnectionMetadata()).toEqual({
        'openai-codex': {
          installation: 'installed',
          auth: 'authenticated',
          disabled: true,
        },
      });
      expect(readConnectionSessionPickerStates()['openai-codex']).toEqual({
        available: false,
        auth: 'authenticated',
      });
    } finally {
      setItem.mockRestore();
    }

    writeConnectionMetadata(readConnectionMetadata());
    expect(readConnectionMetadata()['openai-codex']?.disabled).toBe(true);
    expect(
      JSON.parse(window.localStorage.getItem(AI_CONNECTION_METADATA_KEY) ?? '{}'),
    ).toMatchObject({
      'openai-codex': { disabled: true },
    });
  });
});

describe('deriveAiConnectionHealth', () => {
  it('makes an authenticated installed CLI usable', () => {
    expect(
      deriveAiConnectionHealth({
        connection: CODEX_CLI_CONNECTION,
        metadata: {
          installation: 'installed',
          auth: 'authenticated',
          lastCheckedAt: 42,
        },
      }),
    ).toMatchObject({
      installation: 'installed',
      auth: 'authenticated',
      credentialPersistence: 'not_applicable',
      usable: true,
      lastCheckedAt: 42,
    });
  });

  it('keeps a signed-out CLI unusable', () => {
    expect(
      deriveAiConnectionHealth({
        connection: CODEX_CLI_CONNECTION,
        metadata: { installation: 'installed', auth: 'unauthenticated' },
      }).usable,
    ).toBe(false);
  });

  it('requires verified secure persistence for API usability', () => {
    expect(
      deriveAiConnectionHealth({
        connection: OPENAI_API_CONNECTION,
        credentialSaved: true,
      }),
    ).toMatchObject({
      installation: 'not_applicable',
      auth: 'authenticated',
      credentialPersistence: 'saved',
      usable: true,
    });
    expect(
      deriveAiConnectionHealth({
        connection: OPENAI_API_CONNECTION,
        credentialSaved: true,
        credentialVaultError: true,
      }).usable,
    ).toBe(false);
  });
});
