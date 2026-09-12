import { describe, expect, it, vi } from 'vitest';
import type { ProviderId } from '@/types/common';
import {
  SECRET_API_KEY_PROVIDERS,
  deleteApiKeySecurely,
  isSecretApiKeyProvider,
  refreshOpenCodeCredentialRuntime,
  saveApiKeySecurely,
} from './secureApiKeys';

describe('secure API key providers', () => {
  it('stores Qwen Model Studio credentials in the existing secure vault boundary', () => {
    expect(isSecretApiKeyProvider('qwen')).toBe(true);
    expect(SECRET_API_KEY_PROVIDERS.filter((provider) => provider === 'qwen')).toHaveLength(1);
  });
});

describe('verified secure API key save', () => {
  it('does not report success until secure storage reads back the same credential', async () => {
    const calls: string[] = [];
    await expect(
      saveApiKeySecurely('openai', '  sk-test  ', {
        set: async (_provider, key) => {
          calls.push(`set:${key}`);
        },
        get: async () => {
          calls.push('get');
          return 'sk-test';
        },
      }),
    ).resolves.toEqual({ ok: true });
    expect(calls).toEqual(['set:sk-test', 'get']);
  });

  it('returns a stable redacted code when the credential write fails', async () => {
    await expect(
      saveApiKeySecurely('openai', 'sk-test', {
        set: async () => {
          throw new Error('raw keychain details');
        },
        get: async () => 'sk-test',
      }),
    ).resolves.toEqual({ ok: false, code: 'credential-write-failed' });
  });

  it('rejects a mismatched readback instead of creating a fake connected state', async () => {
    await expect(
      saveApiKeySecurely('openai', 'sk-new', {
        set: async () => undefined,
        get: async () => 'sk-old',
      }),
    ).resolves.toEqual({ ok: false, code: 'credential-verification-failed' });
  });

  it('refreshes the owned OpenCode process only after verified add and update', async () => {
    let stored: string | undefined;
    const calls: string[] = [];
    const dependencies = {
      set: async (_provider: ProviderId, key: string) => {
        calls.push(`set:${key}`);
        stored = key;
      },
      get: async () => {
        calls.push('get');
        return stored;
      },
      refresh: async () => {
        calls.push('refresh');
      },
    };

    await expect(saveApiKeySecurely('openai', 'first', dependencies)).resolves.toEqual({
      ok: true,
    });
    await expect(saveApiKeySecurely('openai', 'second', dependencies)).resolves.toEqual({
      ok: true,
    });
    expect(calls).toEqual(['set:first', 'get', 'refresh', 'set:second', 'get', 'refresh']);
  });

  it('returns a stable redacted code when the owned runtime cannot refresh', async () => {
    await expect(
      saveApiKeySecurely('openai', 'sk-test', {
        set: async () => undefined,
        get: async () => 'sk-test',
        refresh: async () => {
          throw new Error('raw process failure');
        },
      }),
    ).resolves.toEqual({ ok: false, code: 'harness-refresh-failed' });
  });

  it('deletes from the vault before refreshing the owned process', async () => {
    const calls: string[] = [];

    await deleteApiKeySecurely('openai', {
      delete: async () => {
        calls.push('delete');
      },
      refresh: async () => {
        calls.push('refresh');
      },
    });

    expect(calls).toEqual(['delete', 'refresh']);
  });

  it('does not start OpenCode solely for a key change when no server was running', async () => {
    const refresh = vi.fn(async () => undefined);
    await refreshOpenCodeCredentialRuntime({
      available: () => true,
      stop: async () => false,
      refresh,
    });
    expect(refresh).not.toHaveBeenCalled();
  });

  it('stops the owned server before refreshing a running generation', async () => {
    const calls: string[] = [];
    await refreshOpenCodeCredentialRuntime({
      available: () => true,
      stop: async () => {
        calls.push('stop');
        return true;
      },
      refresh: async () => {
        calls.push('refresh');
      },
    });
    expect(calls).toEqual(['stop', 'refresh']);
  });
});
