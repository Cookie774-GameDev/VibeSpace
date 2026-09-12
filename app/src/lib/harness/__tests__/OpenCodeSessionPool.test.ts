import { describe, expect, it } from 'vitest';
import { OpenCodeSessionPool, type OpenCodeSessionRegistry } from '../OpenCodeSessionPool';

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('OpenCodeSessionPool', () => {
  it('starts one runtime and creates one session under concurrent calls', async () => {
    let starts = 0;
    let sessions = 0;
    const pool = new OpenCodeSessionPool(
      { start: async () => ({ generation: `g${++starts}`, dispose: async () => undefined }) },
      { connect: async () => ({
        createSession: async () => { await delay(5); return { id: `s${++sessions}` }; },
        abort: async () => undefined,
      }) },
    );
    const scope = { accountId: 'a', projectId: 'p' };
    const [one, two] = await Promise.all([
      pool.sessionForChat(scope, 'chat'),
      pool.sessionForChat(scope, 'chat'),
    ]);
    expect(starts).toBe(1);
    expect(sessions).toBe(1);
    expect(one.sessionId).toBe(two.sessionId);
  });

  it('restores a persisted session only for the exact runtime generation', async () => {
    const values = new Map<string, { sessionId: string; runtimeGeneration: string }>();
    const registry: OpenCodeSessionRegistry = {
      load: async (scope, chat) => values.get(`${scope}:${chat}`) ?? null,
      save: async (scope, chat, value) => { values.set(`${scope}:${chat}`, value); },
      remove: async (scope, chat) => { values.delete(`${scope}:${chat}`); },
    };
    let creates = 0;
    const pool = new OpenCodeSessionPool(
      { start: async () => ({ generation: 'g1', dispose: async () => undefined }) },
      { connect: async () => ({
        createSession: async () => ({ id: `created-${++creates}` }),
        getSession: async (id) => id === 'persisted' ? { id } : null,
        abort: async () => undefined,
      }) },
      { registry },
    );
    const scope = { accountId: 'a', projectId: 'p' };
    const scopeKey = JSON.stringify(['a', 'p', '']);
    values.set(`${scopeKey}:chat`, { sessionId: 'persisted', runtimeGeneration: 'g1' });
    expect((await pool.sessionForChat(scope, 'chat')).sessionId).toBe('persisted');
    expect(creates).toBe(0);
  });

  it('does not leak a runtime that finishes starting after scope disposal', async () => {
    let disposed = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const pool = new OpenCodeSessionPool(
      { start: async () => {
        await gate;
        return { generation: 'g1', dispose: async () => { disposed += 1; } };
      } },
      { connect: async () => ({ createSession: async () => ({ id: 's' }), abort: async () => undefined }) },
    );
    const scope = { accountId: 'a', projectId: 'p' };
    const pending = pool.ensureReady(scope);
    const disposing = pool.disposeScope(scope);
    release();
    await expect(pending).rejects.toThrow('HARNESS_SCOPE_DISPOSED_DURING_START');
    await disposing;
    expect(disposed).toBe(1);
    expect(pool.warmScopeCount).toBe(0);
  });

  it('evicts the least recently used runtime and cascades cancellation', async () => {
    const disposed: string[] = [];
    let generation = 0;
    let aborted = '';
    const pool = new OpenCodeSessionPool(
      { start: async () => {
        const id = `g${++generation}`;
        return { generation: id, dispose: async () => { disposed.push(id); } };
      } },
      { connect: async () => ({
        createSession: async () => ({ id: `s${generation}` }),
        abort: async (id) => { aborted = id; },
      }) },
      { maxWarmScopes: 1 },
    );
    const first = { accountId: 'a', projectId: 'one' };
    const second = { accountId: 'a', projectId: 'two' };
    const firstSession = await pool.sessionForChat(first, 'chat');
    await pool.cancelChat(first, 'chat');
    expect(aborted).toBe(firstSession.sessionId);
    await pool.sessionForChat(second, 'chat');
    expect(disposed).toEqual(['g1']);
    expect(pool.warmScopeCount).toBe(1);
  });


  it('cancels a session that is still being created', async () => {
    let release!: (value: { id: string }) => void;
    const created = new Promise<{ id: string }>((resolve) => { release = resolve; });
    const abort = vi.fn(async () => undefined);
    const pool = new OpenCodeSessionPool(
      { start: async () => ({ generation: 'g', dispose: async () => undefined }) },
      { connect: async () => ({ createSession: async () => created, abort }) },
    );
    const scope = { accountId: 'a' };
    const pending = pool.sessionForChat(scope, 'chat');
    await Promise.resolve();
    const cancelling = pool.cancelChat(scope, 'chat');
    release({ id: 's' });
    await pending;
    await cancelling;
    expect(abort).toHaveBeenCalledWith('s');
  });
});
