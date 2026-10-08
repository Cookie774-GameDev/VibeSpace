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

describe('one-use fresh OpenCode baseline witness', () => {
  it('issues a witness only to the exclusive request that created the session', async () => {
    const h = setup();
    try {
      const session = await h.pool.sessionForChat(scope, 'fresh', 'Fresh chat', undefined, 'request-fresh');
      expect(session.origin).toBe('created');
      expect(h.sdk.session.create).toHaveBeenCalledWith({ body: { title: 'Fresh chat' } });
      expect(h.pool.consumeEmptyBaseline(session, 'request-fresh')).toBe(true);
      expect(h.pool.consumeEmptyBaseline(session, 'request-fresh')).toBe(false);
    } finally { await h.pool.disposeAll(); }
  });

  it('never infers emptiness from a restored session id', async () => {
    const h = setup();
    try {
      const session = await h.pool.sessionForChat(scope, 'chat', undefined, undefined, 'request-restored');
      expect(session.origin).toBe('restored');
      expect(h.pool.consumeEmptyBaseline(session, 'request-restored')).toBe(false);
      expect(h.sdk.session.create).not.toHaveBeenCalled();
    } finally { await h.pool.disposeAll(); }
  });

  it('invalidates an unconsumed fresh witness on a later warm acquisition', async () => {
    const h = setup();
    try {
      const fresh = await h.pool.sessionForChat(scope, 'fresh', undefined, undefined, 'request-first');
      const warm = await h.pool.sessionForChat(scope, 'fresh', undefined, undefined, 'request-next');
      expect(warm.origin).toBe('warm');
      expect(h.pool.consumeEmptyBaseline(fresh, 'request-first')).toBe(false);
      expect(h.pool.consumeEmptyBaseline(warm, 'request-next')).toBe(false);
      expect(h.sdk.session.create).toHaveBeenCalledTimes(1);
    } finally { await h.pool.disposeAll(); }
  });

  it('does not grant a witness to an ownerless or copied binding', async () => {
    const h = setup();
    try {
      const ownerless = await h.pool.sessionForChat(scope, 'ownerless');
      expect(h.pool.consumeEmptyBaseline(ownerless, 'invented-owner')).toBe(false);
      const owned = await h.pool.sessionForChat(scope, 'owned', undefined, undefined, 'request-owned');
      expect(h.pool.consumeEmptyBaseline({ ...owned }, 'request-owned')).toBe(false);
      expect(h.pool.consumeEmptyBaseline(owned, 'wrong-request')).toBe(false);
    } finally { await h.pool.disposeAll(); }
  });

  it('coalesces creation but refuses an exclusive witness after concurrent acquisitions', async () => {
    const h = setup();
    try {
      const [first, other] = await Promise.all([
        h.pool.sessionForChat(scope, 'fresh', undefined, undefined, 'request-first'),
        h.pool.sessionForChat(scope, 'fresh', undefined, undefined, 'request-other'),
      ]);
      expect(first.sessionId).toBe(other.sessionId);
      expect(h.sdk.session.create).toHaveBeenCalledTimes(1);
      expect(h.pool.consumeEmptyBaseline(first, 'request-first')).toBe(false);
      expect(h.pool.consumeEmptyBaseline(other, 'request-other')).toBe(false);
    } finally { await h.pool.disposeAll(); }
  });

  it.each(['cancel', 'forget', 'dispose'] as const)('invalidates creation proof on %s', async (operation) => {
    const h = setup();
    try {
      const session = await h.pool.sessionForChat(scope, 'fresh', undefined, undefined, 'request-fresh');
      if (operation === 'cancel') await h.pool.cancelChat(scope, 'fresh');
      else if (operation === 'forget') await h.pool.forgetChat(scope, 'fresh');
      else await h.pool.disposeScope(scope);
      expect(h.pool.consumeEmptyBaseline(session, 'request-fresh')).toBe(false);
    } finally { await h.pool.disposeAll(); }
  });

  it('invalidates proof if cancellation occurs while native creation is pending', async () => {
    const h = setup();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let created!: () => void;
    const started = new Promise<void>((resolve) => { created = resolve; });
    vi.mocked(h.sdk.session.create).mockImplementation(async () => {
      created();
      await gate;
      return { id: 'late-created' };
    });
    try {
      const pending = h.pool.sessionForChat(scope, 'fresh', undefined, undefined, 'cancelled-request');
      await started;
      const cancelled = h.pool.cancelChat(scope, 'fresh');
      release();
      const session = await pending;
      await cancelled;
      expect(h.sdk.session.abort).toHaveBeenCalledWith({ path: { id: 'late-created' } });
      expect(h.pool.consumeEmptyBaseline(session, 'cancelled-request')).toBe(false);
    } finally { release(); await h.pool.disposeAll(); }
  });

  it('refuses the old witness after a native generation change', async () => {
    let generation = 'generation-1';
    const pool = new OpenCodeSessionPool({
      currentGeneration: () => generation,
      start: async () => ({ generation, dispose: async () => undefined }),
    }, { connect: async () => ({
      createSession: async () => ({ id: 'new-session' }),
      abort: async () => undefined,
    }) });
    try {
      const session = await pool.sessionForChat(scope, 'fresh', undefined, undefined, 'request-fresh');
      generation = 'generation-2';
      expect(pool.consumeEmptyBaseline(session, 'request-fresh')).toBe(false);
    } finally { await pool.disposeAll(); }
  });

  it('does not revive creation proof after failed mapping persistence', async () => {
    let failSave = true;
    const h = setup(async () => null, async () => {
      if (failSave) throw new Error('mapping write failed');
    });
    try {
      await expect(h.pool.sessionForChat(scope, 'fresh', undefined, undefined, 'failed-request'))
        .rejects.toThrow('mapping write failed');
      failSave = false;
      const session = await h.pool.sessionForChat(scope, 'fresh', undefined, undefined, 'next-request');
      expect(session.origin).toBe('warm');
      expect(h.pool.consumeEmptyBaseline(session, 'next-request')).toBe(false);
    } finally { await h.pool.disposeAll(); }
  });
});
