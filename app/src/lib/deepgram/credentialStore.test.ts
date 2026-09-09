import { describe, expect, it, vi } from 'vitest';
import {
  createDeepgramCredentialService,
  type DeepgramCredentialAdapter,
  type DeepgramCredentialSnapshot,
} from './credentialStore';

function memoryAdapter(seed: Record<string, string> = {}) {
  const values = new Map(Object.entries(seed));
  const adapter: DeepgramCredentialAdapter = {
    read: vi.fn(async (id) => values.get(id)),
    write: vi.fn(async (id, value) => {
      values.set(id, value);
    }),
    remove: vi.fn(async (id) => {
      values.delete(id);
    }),
  };
  return { adapter, values };
}

function validProjectsResponse() {
  return new Response(
    JSON.stringify({
      projects: [{ project_id: 'project-safe-id', name: 'VibeSpace Voice' }],
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

describe('central Deepgram credential service', () => {
  it('migrates a legacy voice key into the canonical vault and removes the legacy copy', async () => {
    const { adapter, values } = memoryAdapter({ deepgram_voice: 'legacy-key' });
    const publish = vi.fn();
    const service = createDeepgramCredentialService({
      adapter,
      fetcher: vi.fn(async () => validProjectsResponse()),
      publish,
      now: () => new Date('2026-08-02T19:00:00Z'),
    });

    const snapshot = await service.load();

    expect(snapshot.configured).toBe(true);
    expect(values.get('deepgram')).toBe('legacy-key');
    expect(values.has('deepgram_voice')).toBe(false);
    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({ configured: true, source: 'migration' }),
    );
    expect(JSON.stringify(publish.mock.calls)).not.toContain('legacy-key');
  });

  it('authenticates before loading optional project metadata and publishes no secret', async () => {
    const { adapter, values } = memoryAdapter();
    const fetcher = vi.fn(async (_url: string) => validProjectsResponse());
    const publish = vi.fn();
    const service = createDeepgramCredentialService({
      adapter,
      fetcher,
      publish,
      now: () => new Date('2026-08-02T19:00:00Z'),
    });

    const snapshot = await service.save('  dg-secret-value  ');

    expect(fetcher.mock.calls[0]?.[0]).toBe('https://api.deepgram.com/v1/auth/token');

    expect(fetcher).toHaveBeenCalledWith(
      'https://api.deepgram.com/v1/projects',
      expect.objectContaining({
        method: 'GET',
        headers: { Authorization: 'Token dg-secret-value' },
      }),
    );
    expect(values.get('deepgram')).toBe('dg-secret-value');
    expect(snapshot).toEqual(
      expect.objectContaining({
        configured: true,
        health: 'connected',
        projectName: 'VibeSpace Voice',
        projectId: 'project-safe-id',
      }),
    );
    expect(JSON.stringify(publish.mock.calls)).not.toContain('dg-secret-value');
  });

  it('reports a valid speech key connected when project listing is forbidden', async () => {
    const { adapter, values } = memoryAdapter();
    const fetcher = vi.fn(async (url: string) => url.endsWith('/auth/token')
      ? new Response('{}', { status: 200 })
      : new Response('', { status: 403 }));
    const service = createDeepgramCredentialService({ adapter, fetcher, publish: vi.fn() });
    expect(await service.save('speech-only')).toMatchObject({ configured: true, health: 'connected' });
    expect(values.get('deepgram')).toBe('speech-only');
  });

  it('does not persist an invalid key and returns a recoverable invalid state', async () => {
    const { adapter, values } = memoryAdapter();
    const service = createDeepgramCredentialService({
      adapter,
      fetcher: vi.fn(async () => new Response('unauthorized', { status: 401 })),
      publish: vi.fn(),
    });

    const snapshot = await service.save('bad-secret');

    expect(snapshot).toEqual(
      expect.objectContaining({
        configured: false,
        health: 'invalid',
        errorCode: 'invalid_key',
      }),
    );
    expect(values.has('deepgram')).toBe(false);
  });

  it('persists a service-scoped key when the optional project metadata probe is forbidden', async () => {
    const { adapter, values } = memoryAdapter();
    const publish = vi.fn();
    const service = createDeepgramCredentialService({
      adapter,
      fetcher: vi.fn(async () => new Response('forbidden', { status: 403 })),
      publish,
      now: () => new Date('2026-08-29T22:23:00Z'),
    });

    const snapshot = await service.save('service-scoped-key');

    expect(values.get('deepgram')).toBe('service-scoped-key');
    expect(snapshot).toEqual({
      configured: true,
      health: 'unreachable',
      source: 'saved',
      checkedAt: '2026-08-29T22:23:00.000Z',
      errorCode: 'permission',
    });
    expect(JSON.stringify(publish.mock.calls)).not.toContain('service-scoped-key');
  });

  it('keeps a stored key on a temporary network failure but labels the state unreachable', async () => {
    const { adapter } = memoryAdapter({ deepgram: 'stored-secret' });
    const service = createDeepgramCredentialService({
      adapter,
      fetcher: vi.fn(async () => {
        throw new TypeError('network details must not escape');
      }),
      publish: vi.fn(),
    });

    const snapshot = await service.test();

    expect(snapshot).toEqual(
      expect.objectContaining({
        configured: true,
        health: 'unreachable',
        errorCode: 'network',
      }),
    );
    expect(JSON.stringify(snapshot)).not.toContain('network details');
    expect(JSON.stringify(snapshot)).not.toContain('stored-secret');
  });

  it('saves a new key in the vault when validation is temporarily unreachable', async () => {
    const { adapter, values } = memoryAdapter();
    const publish = vi.fn();
    const service = createDeepgramCredentialService({
      adapter,
      fetcher: vi.fn(async () => {
        throw new TypeError('offline');
      }),
      publish,
      now: () => new Date('2026-08-09T20:00:00Z'),
    });

    const snapshot = await service.save('new-private-key');

    expect(values.get('deepgram')).toBe('new-private-key');
    expect(snapshot).toEqual({
      configured: true,
      health: 'unreachable',
      source: 'saved',
      checkedAt: '2026-08-09T20:00:00.000Z',
      errorCode: 'network',
    });
    expect(JSON.stringify(publish.mock.calls)).not.toContain('new-private-key');
  });

  it('removes canonical and every known legacy vault entry', async () => {
    const { adapter, values } = memoryAdapter({
      deepgram: 'one',
      deepgram_voice: 'two',
      'plugin-deepgram-api_key': 'three',
    });
    const publish = vi.fn<(snapshot: DeepgramCredentialSnapshot) => void>();
    const service = createDeepgramCredentialService({ adapter, publish });

    const snapshot = await service.remove();

    expect(snapshot).toEqual(expect.objectContaining({ configured: false, health: 'missing' }));
    expect([...values.keys()]).toEqual([]);
    expect(JSON.stringify(publish.mock.calls)).not.toMatch(/one|two|three/);
  });
});
