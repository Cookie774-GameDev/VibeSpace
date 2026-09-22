import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));

vi.mock('@/lib/utils', () => ({ isTauri: true }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));

import {
  getJevCredentialStatus,
  requestJevModels,
  requestJevSystemOne,
  saveJevCredential,
} from './jevCredentialStore';

describe('Jev native credential bridge', () => {
  beforeEach(() => mocks.invoke.mockReset());

  it('saves through the native vault and returns no credential readback', async () => {
    mocks.invoke.mockResolvedValue(undefined);

    await expect(saveJevCredential('  jev-private-key  ')).resolves.toEqual({ ok: true });
    expect(mocks.invoke).toHaveBeenCalledWith('jev_credential_set', { key: 'jev-private-key' });
    const serialized = JSON.stringify(await getJevCredentialStatus());
    expect(serialized).not.toContain('jev-private-key');
    expect(serialized).not.toContain('key');
  });

  it('reports stable storage errors without exposing native details', async () => {
    mocks.invoke.mockResolvedValue({});

    expect(await saveJevCredential('')).toEqual({ ok: false, code: 'key_required' });
    expect(await saveJevCredential('x'.repeat(32 * 1024 + 1))).toEqual({
      ok: false,
      code: 'credential_too_large',
    });
    expect(await getJevCredentialStatus()).toEqual({
      available: true,
      configured: false,
      error: 'storage_unavailable',
    });
    expect(JSON.stringify(await getJevCredentialStatus())).not.toMatch(/secret|keychain|path/i);
  });

  it('keeps the native HTTP surface fixed and passes no credential material', async () => {
    mocks.invoke
      .mockResolvedValueOnce({
        kind: 'connected',
        status: 200,
        models: [{ id: 'jev-1', label: 'Jev' }],
      })
      .mockResolvedValueOnce({ kind: 'ok', status: 200, body: { decision: 'noop' } });

    await expect(requestJevModels()).resolves.toMatchObject({ kind: 'connected' });
    await expect(
      requestJevSystemOne({
        model: 'jev-1',
        state: { bounded: 'snapshot' },
        questions: {
          action: {
            type: 'choice',
            instructions: 'Choose one',
            criteria: { noop: 'No action', wake: null },
          },
        },
      }),
    ).resolves.toMatchObject({ kind: 'ok' });
    expect(mocks.invoke).toHaveBeenNthCalledWith(1, 'jev_http_models');
    expect(mocks.invoke).toHaveBeenNthCalledWith(2, 'jev_http_systemone', {
      request: {
        model: 'jev-1',
        state: { bounded: 'snapshot' },
        questions: {
          action: {
            type: 'choice',
            instructions: 'Choose one',
            criteria: { noop: 'No action', wake: null },
          },
        },
      },
    });
    expect(JSON.stringify(mocks.invoke.mock.calls)).not.toContain('authorization');
    expect(JSON.stringify(mocks.invoke.mock.calls)).not.toContain('jev-private-key');
  });
});
