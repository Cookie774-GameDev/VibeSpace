import { describe, expect, it, vi } from 'vitest';
import { OpenCodeSessionPool, openCodeScopeKey, type HarnessScope, type PersistedSessionMapping } from './OpenCodeSessionPool';
import { OpenCodeSdkSessionClient, type OpenCodeSdkClientLike } from './OpenCodeSdkSessionClient';

const scope: HarnessScope = { accountId: 'test-account', projectId: 'test-project', workingDirectory: 'C:/fixture' };
function setup(read: () => Promise<unknown> = async () => ({ id: 'persisted' }), saveHook?: () => Promise<void>) {
  const mappings = new Map<string, PersistedSessionMapping>();
  const key = `${openCodeScopeKey(scope)}:chat`;
  mappings.set(key, { sessionId: 'persisted', runtimeGeneration: 'generation' });
  const sdk: OpenCodeSdkClientLike = {
    global: { health: async () => ({ healthy: true, version: 'test' }) },
    config: { providers: async () => ({}) }, command: { list: async () => [] },
    event: { subscribe: async () => ({ stream: (async function* () {})() }) },
    session: { get: vi.fn(read), create: vi.fn(async () => ({ id: 'replacement' })), abort: vi.fn(async () => ({})) },
  };
  const client = new OpenCodeSdkSessionClient(sdk);
  const pool = new OpenCodeSessionPool({ start: async () => ({ generation: 'generation', dispose: async () => {} }) },
    { connect: async () => client }, { registry: {
      load: async (s, c) => mappings.get(`${s}:${c}`) ?? null,
      save: async (s, c, mapping) => { await saveHook?.(); mappings.set(`${s}:${c}`, mapping); },
      remove: async (s, c) => { mappings.delete(`${s}:${c}`); },
    } });
  return { pool, sdk, mappings, key };
}

describe('persisted OpenCode session restoration', () => {
  it('starts a new persisted session when the same chat changes agent instructions', async () => {
    const mappings = new Map<string, PersistedSessionMapping>();
    const registry = {
      load: async (scopeKey: string, chatId: string) => mappings.get(`${scopeKey}:${chatId}`) ?? null,
      save: async (scopeKey: string, chatId: string, mapping: PersistedSessionMapping) => {
        mappings.set(`${scopeKey}:${chatId}`, mapping);
      },
      remove: async (scopeKey: string, chatId: string) => {
        mappings.delete(`${scopeKey}:${chatId}`);
      },
    };
    let created = 0;
    const client = {
      createSession: async () => ({ id: `session-${++created}` }),
      getSession: async (id: string) => ({ id }),
      abort: async () => undefined,
    };
    const makePool = () => new OpenCodeSessionPool(
      { start: async () => ({ generation: 'generation', dispose: async () => undefined }) },
      { connect: async () => client },
      { registry },
    );
    const alpha = `sha256:${'a'.repeat(64)}`;
    const beta = `sha256:${'b'.repeat(64)}`;
    const first = makePool();
    try {
      expect((await first.sessionForChat(scope, 'chat', undefined, alpha)).sessionId).toBe('session-1');
      expect((await first.sessionForChat(scope, 'chat', undefined, alpha)).sessionId).toBe('session-1');
      expect((await first.sessionForChat(scope, 'chat', undefined, beta)).sessionId).toBe('session-2');
      expect(mappings.get(`${openCodeScopeKey(scope)}:chat`)).toMatchObject({
        sessionId: 'session-2', instructionFingerprint: beta,
      });
    } finally { await first.disposeAll(); }
    const restored = makePool();
    try {
      expect((await restored.sessionForChat(scope, 'chat', undefined, beta)).sessionId).toBe('session-2');
      expect((await restored.sessionForChat(scope, 'chat', undefined, alpha)).sessionId).toBe('session-3');
      expect(created).toBe(3);
    } finally { await restored.disposeAll(); }
  });

  it.each([new Error('temporary read outage'), 'native read unavailable'])('does not replace a conversation on uncertain validation: %s', async (error) => {
    const h = setup(async () => { throw error; });
    try {
      await expect(h.pool.sessionForChat(scope, 'chat')).rejects.toBe(error);
      expect(h.sdk.session.create).not.toHaveBeenCalled();
      expect(h.mappings.get(h.key)?.sessionId).toBe('persisted');
    } finally { await h.pool.disposeAll(); }
  });
  it('rejects malformed validation instead of creating a replacement', async () => {
    const h = setup(async () => ({ unexpected: true }));
    try {
      await expect(h.pool.sessionForChat(scope, 'chat')).rejects.toThrow();
      expect(h.sdk.session.create).not.toHaveBeenCalled();
    } finally { await h.pool.disposeAll(); }
  });
  it('allows one replacement when the transport explicitly confirms null', async () => {
    const h = setup(async () => null);
    try {
      expect((await h.pool.sessionForChat(scope, 'chat')).sessionId).toBe('replacement');
      expect(h.sdk.session.create).toHaveBeenCalledTimes(1);
    } finally { await h.pool.disposeAll(); }
  });
  it('recovers the original mapping after a transient read failure', async () => {
    let unavailable = true;
    const h = setup(async () => { if (unavailable) throw new Error('temporary'); return { id: 'persisted' }; });
    try {
      await h.pool.sessionForChat(scope, 'chat').catch(() => undefined);
      unavailable = false;
      expect((await h.pool.sessionForChat(scope, 'chat')).sessionId).toBe('persisted');
      expect(h.sdk.session.create).not.toHaveBeenCalled();
    } finally { await h.pool.disposeAll(); }
  });
  it('does not return a dispatchable session after disposal during registry persistence', async () => {
    let enter!: () => void, release!: () => void;
    const entered = new Promise<void>((resolve) => { enter = resolve; });
    const held = new Promise<void>((resolve) => { release = resolve; });
    const h = setup(async () => null, async () => { enter(); await held; });
    const result = h.pool.sessionForChat(scope, 'chat').then(value => ({ value, error: undefined }), error => ({ value: undefined, error }));
    await entered;
    await h.pool.disposeScope(scope);
    release();
    expect((await result).error?.message).toContain('HARNESS_SCOPE_DISPOSED');
  });
});
