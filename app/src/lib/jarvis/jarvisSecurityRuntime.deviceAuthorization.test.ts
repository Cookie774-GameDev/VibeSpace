import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createJarvisSecurityRuntime, type JarvisSecurityRuntime } from './jarvisSecurityRuntime';
import { createJarvisActionCatalog } from './actions/catalog';
import {
  createJarvisExistingCredentialAuthorization,
  createPluginCredentialAccountGrantRepository,
} from '@/features/plugins/credentialAuthorization';
import type { ExistingPluginCredentialAdapter } from '@/features/plugins/credentials';
import type { PluginConnection } from '@/features/plugins/types';

const boundary = vi.hoisted(() => ({ request: vi.fn(), adapter: vi.fn() }));
vi.mock('@/lib/nativeFetch', () => ({ nativeFetch: boundary.request }));
vi.mock('@/features/plugins/credentials', () => ({
  createExistingPluginCredentialAdapter: boundary.adapter,
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function json(value: unknown) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function settle() {
  // Drain the bounded credential-lock/save/probe promise chain without real timers.
  for (let index = 0; index < 60; index += 1) await Promise.resolve();
}

const runtimes: JarvisSecurityRuntime[] = [];
beforeEach(() => {
  vi.useFakeTimers();
  boundary.request.mockReset();
  boundary.adapter.mockReset();
});
afterEach(() => {
  for (const runtime of runtimes.splice(0)) runtime.invalidateAll();
  vi.clearAllTimers();
  vi.useRealTimers();
});

function fixture(
  options: {
    heldWrite?: ReturnType<typeof deferred<void>>;
    heldGrantCommit?: ReturnType<typeof deferred<void>>;
    heldProbe?: ReturnType<typeof deferred<Response>>;
  } = {},
) {
  let accountId: string | undefined = 'account-a';
  let raw: string | null = null;
  let sequence = 0;
  const values = new Map<string, string>();
  const token = deferred<Response>();
  const tokenQueue = [token];
  const connections: PluginConnection[] = [];
  const rows = new Map<string, PluginConnection>();
  const baseGrants = createPluginCredentialAccountGrantRepository({
    storage: {
      readRaw: () => raw,
      compareAndSetRaw({ expectedRaw, nextRaw }) {
        if (raw !== expectedRaw) throw new Error('fixture CAS conflict');
        raw = nextRaw;
      },
    },
  });
  let holdFirstGrant = true;
  const grants = {
    ...baseGrants,
    async replaceExact(request: Parameters<typeof baseGrants.replaceExact>[0]) {
      await baseGrants.replaceExact(request);
      if (options.heldGrantCommit && holdFirstGrant) {
        holdFirstGrant = false;
        await options.heldGrantCommit.promise;
      }
    },
  };
  const adapter = {
    readExistingCredential: vi.fn(async ({ pluginId, fieldId }) =>
      values.get(`${pluginId}:${fieldId}`),
    ),
    writeExistingCredential: vi.fn(async ({ pluginId, fieldId }, value) => {
      if (options.heldWrite) await options.heldWrite.promise;
      values.set(`${pluginId}:${fieldId}`, value);
    }),
    deleteExistingCredential: vi.fn(async ({ pluginId, fieldId }) => {
      values.delete(`${pluginId}:${fieldId}`);
    }),
  } satisfies ExistingPluginCredentialAdapter;
  boundary.adapter.mockReturnValue(adapter);
  boundary.request.mockImplementation(async (url: string) => {
    if (url.endsWith('/login/device/code'))
      return json({
        device_code: 'synthetic-device-code',
        user_code: 'TEST-CODE',
        verification_uri: 'https://github.com/login/device',
        expires_in: 600,
        interval: 1,
      });
    if (url.endsWith('/login/oauth/access_token')) {
      const next = tokenQueue.shift();
      if (!next) throw new Error('Unexpected injected token poll');
      return next.promise;
    }
    if (url === 'https://api.github.com/user')
      return options.heldProbe?.promise ?? json({ login: 'fixture-user' });
    throw new Error('Unexpected injected request');
  });
  const runtime = createJarvisSecurityRuntime({
    repositories: {
      run: { getById: vi.fn() },
      approval: { getById: vi.fn(), listByRun: vi.fn(async () => []) },
    } as never,
    catalog: createJarvisActionCatalog([]),
    capabilitySnapshots: { getForAccount: vi.fn() },
    entitlementSnapshots: { getForAccount: vi.fn() },
    credentialGrants: grants,
    credentialAuthorization: createJarvisExistingCredentialAuthorization({
      grants,
      getActiveAccountId: () => accountId,
    }),
    pluginConnections: {
      upsertConnection(connection) {
        connections.push(connection);
        rows.set(connection.accountId, connection);
      },
      removeConnection(account) {
        rows.delete(account);
      },
    },
    activeAccountId: () => accountId,
    executeRegisteredAction: vi.fn(),
    bootId: 'device-lifetime-fixture',
    randomUUID: () => `fixture-id-${++sequence}`,
    now: () => 10_000,
  });
  runtimes.push(runtime);
  return {
    runtime,
    token,
    grants,
    adapter,
    values,
    rows,
    connections,
    nextToken() {
      const next = deferred<Response>();
      tokenQueue.push(next);
      return next;
    },
    account(value: string | undefined) {
      accountId = value;
    },
    async start() {
      const previousPolls = boundary.request.mock.calls.filter(([url]) =>
        url.endsWith('/login/oauth/access_token'),
      ).length;
      await expect(
        runtime.pluginManagement.beginAuthorization({ accountId: 'account-a', pluginId: 'github' }),
      ).resolves.toMatchObject({ ok: true, state: 'awaiting_approval' });
      await vi.advanceTimersByTimeAsync(1_000);
      expect(
        boundary.request.mock.calls.filter(([url]) => url.endsWith('/login/oauth/access_token')),
      ).toHaveLength(previousPolls + 1);
    },
  };
}

describe('composed GitHub device authorization lifetime', () => {
  it.each(['account-ABA', 'runtime'] as const)(
    'rejects held successful device polling after %s invalidation',
    async (kind) => {
      const test = fixture();
      await test.start();
      const writes = test.connections.length;
      if (kind === 'runtime') test.runtime.invalidateAll();
      else {
        test.account('account-b');
        test.runtime.invalidateAccount('account-a');
        test.account('account-a');
      }
      test.token.resolve(
        json({ access_token: 'synthetic-only-device-token', token_type: 'bearer' }),
      );
      await settle();
      expect(test.adapter.writeExistingCredential).not.toHaveBeenCalled();
      expect(test.values.size).toBe(0);
      expect(await test.grants.get({ pluginId: 'github', fieldId: 'token' })).toBeUndefined();
      expect(
        boundary.request.mock.calls.filter(([url]) => url === 'https://api.github.com/user'),
      ).toHaveLength(0);
      expect(test.connections).toHaveLength(writes);
    },
  );

  it.each(['account-ABA', 'runtime'] as const)(
    'rejects held device-poll failure after %s invalidation',
    async (kind) => {
      const test = fixture();
      await test.start();
      const writes = test.connections.length;
      if (kind === 'runtime') test.runtime.invalidateAll();
      else {
        test.account('account-b');
        test.runtime.invalidateAccount('account-a');
        test.account('account-a');
      }
      test.token.resolve(json({ error: 'access_denied' }));
      await settle();
      expect(test.connections).toHaveLength(writes);
      expect(test.adapter.writeExistingCredential).not.toHaveBeenCalled();
    },
  );

  it.each(['cancel', 'account-ABA', 'runtime'] as const)(
    'does not retain a revoked device credential after held write and %s',
    async (kind) => {
      const heldWrite = deferred<void>();
      const test = fixture({ heldWrite });
      await test.start();
      test.token.resolve(
        json({ access_token: 'synthetic-only-device-token', token_type: 'bearer' }),
      );
      await settle();
      expect(test.adapter.writeExistingCredential).toHaveBeenCalledTimes(1);
      if (kind === 'cancel')
        await test.runtime.pluginManagement.cancelAuthorization({
          accountId: 'account-a',
          pluginId: 'github',
        });
      else if (kind === 'runtime') test.runtime.invalidateAll();
      else {
        test.account('account-b');
        test.runtime.invalidateAccount('account-a');
        test.account('account-a');
      }
      const writes = test.connections.length;
      heldWrite.resolve();
      await settle();
      expect(test.values.size).toBe(0);
      expect(await test.grants.get({ pluginId: 'github', fieldId: 'token' })).toBeUndefined();
      expect(
        boundary.request.mock.calls.filter(([url]) => url === 'https://api.github.com/user'),
      ).toHaveLength(0);
      expect(test.connections).toHaveLength(writes);
      expect(test.rows.has('account-a')).toBe(false);
    },
  );

  it.each(['cancel', 'account-ABA', 'runtime'] as const)(
    'does not start a profile request after a held credential read and %s revocation',
    async (kind) => {
      const heldRead = deferred<string | undefined>();
      const test = fixture();
      test.adapter.readExistingCredential.mockImplementationOnce(() => heldRead.promise);
      await test.start();
      test.token.resolve(
        json({ access_token: 'synthetic-only-device-token', token_type: 'bearer' }),
      );
      await settle();
      expect(test.adapter.readExistingCredential).toHaveBeenCalledTimes(1);
      expect(
        boundary.request.mock.calls.filter(([url]) => url === 'https://api.github.com/user'),
      ).toHaveLength(0);
      if (kind === 'cancel')
        await test.runtime.pluginManagement.cancelAuthorization({
          accountId: 'account-a',
          pluginId: 'github',
        });
      else if (kind === 'runtime') test.runtime.invalidateAll();
      else {
        test.account('account-b');
        test.runtime.invalidateAccount('account-a');
        test.account('account-a');
      }
      const writes = test.connections.length;
      heldRead.resolve('synthetic-only-device-token');
      await settle();
      expect(
        boundary.request.mock.calls.filter(([url]) => url === 'https://api.github.com/user'),
      ).toHaveLength(0);
      expect(test.values.size).toBe(0);
      expect(await test.grants.get({ pluginId: 'github', fieldId: 'token' })).toBeUndefined();
      expect(test.connections).toHaveLength(writes);
    },
  );

  it.each(['cancel', 'account-ABA', 'runtime'] as const)(
    'does not start a profile request after held final grant validation and %s revocation',
    async (kind) => {
      const heldValidation = deferred<void>();
      const validationStarted = deferred<void>();
      const test = fixture();
      const getLocked = test.grants.getLocked.bind(test.grants);
      let holdFinalRead = true;
      vi.spyOn(test.grants, 'getLocked').mockImplementation(async (request) => {
        const grant = await getLocked(request);
        if (holdFinalRead && test.adapter.readExistingCredential.mock.calls.length === 1) {
          holdFinalRead = false;
          validationStarted.resolve();
          await heldValidation.promise;
        }
        return grant;
      });
      await test.start();
      test.token.resolve(
        json({ access_token: 'synthetic-only-device-token', token_type: 'bearer' }),
      );
      await validationStarted.promise;
      expect(test.adapter.readExistingCredential).toHaveBeenCalledTimes(1);
      expect(
        boundary.request.mock.calls.filter(([url]) => url === 'https://api.github.com/user'),
      ).toHaveLength(0);
      if (kind === 'cancel')
        await test.runtime.pluginManagement.cancelAuthorization({
          accountId: 'account-a',
          pluginId: 'github',
        });
      else if (kind === 'runtime') test.runtime.invalidateAll();
      else {
        test.account('account-b');
        test.runtime.invalidateAccount('account-a');
        test.account('account-a');
      }
      const writes = test.connections.length;
      heldValidation.resolve();
      await settle();
      expect(
        boundary.request.mock.calls.filter(([url]) => url === 'https://api.github.com/user'),
      ).toHaveLength(0);
      expect(test.values.size).toBe(0);
      expect(await test.grants.get({ pluginId: 'github', fieldId: 'token' })).toBeUndefined();
      expect(test.connections).toHaveLength(writes);
    },
  );

  it('removes only its own grant when cancellation happens during grant commit', async () => {
    const heldGrantCommit = deferred<void>();
    const test = fixture({ heldGrantCommit });
    await test.start();
    test.token.resolve(json({ access_token: 'synthetic-old-device-token', token_type: 'bearer' }));
    await settle();
    expect(test.values.size).toBe(1);
    await test.runtime.pluginManagement.cancelAuthorization({
      accountId: 'account-a',
      pluginId: 'github',
    });
    heldGrantCommit.resolve();
    await settle();
    expect(await test.grants.get({ pluginId: 'github', fieldId: 'token' })).toBeUndefined();
    expect(test.values.size).toBe(0);
    expect(test.rows.has('account-a')).toBe(false);
  });

  it('preserves a newer successful credential while an older canceled callback finishes', async () => {
    const heldGrantCommit = deferred<void>();
    const test = fixture({ heldGrantCommit });
    await test.start();
    test.token.resolve(json({ access_token: 'synthetic-old-device-token', token_type: 'bearer' }));
    await settle();
    await test.runtime.pluginManagement.cancelAuthorization({
      accountId: 'account-a',
      pluginId: 'github',
    });
    const fresh = test.nextToken();
    await test.start();
    fresh.resolve(json({ access_token: 'synthetic-new-device-token', token_type: 'bearer' }));
    await settle();
    heldGrantCommit.resolve();
    await settle();
    expect(test.values.get('github:token')).toBe('synthetic-new-device-token');
    const current = await test.grants.get({ pluginId: 'github', fieldId: 'token' });
    expect(current).toMatchObject({ accountId: 'account-a', grantId: 'fixture-id-2' });
    expect(test.rows.get('account-a')).toMatchObject({ state: 'connected', enabled: true });
    test.runtime.invalidateAccount('account-a');
    await settle();
    expect(test.values.get('github:token')).toBe('synthetic-new-device-token');
    expect(await test.grants.get({ pluginId: 'github', fieldId: 'token' })).toEqual(current);
  });

  it('preserves a newer manual credential when an old device probe is canceled', async () => {
    const heldProbe = deferred<Response>();
    const test = fixture({ heldProbe });
    await test.start();
    test.token.resolve(json({ access_token: 'synthetic-old-device-token', token_type: 'bearer' }));
    await settle();
    expect(await test.grants.get({ pluginId: 'github', fieldId: 'token' })).toMatchObject({
      revision: 1,
    });
    await test.runtime.pluginManagement.saveCredential({
      accountId: 'account-a',
      pluginId: 'github',
      fieldId: 'token',
      value: 'synthetic-new-manual-token',
    });
    const replacement = await test.grants.get({ pluginId: 'github', fieldId: 'token' });
    expect(replacement).toMatchObject({ grantId: 'fixture-id-2', revision: 2 });
    await test.runtime.pluginManagement.cancelAuthorization({
      accountId: 'account-a',
      pluginId: 'github',
    });
    heldProbe.resolve(json({ login: 'fixture-user' }));
    await settle();
    expect(await test.grants.get({ pluginId: 'github', fieldId: 'token' })).toEqual(replacement);
    expect(test.values.get('github:token')).toBe('synthetic-new-manual-token');
  });

  it('reports a current credential-write failure rather than leaving approval pending', async () => {
    const test = fixture();
    test.adapter.writeExistingCredential.mockRejectedValueOnce(
      new Error('synthetic storage failure'),
    );
    await test.start();
    test.token.resolve(json({ access_token: 'synthetic-only-device-token', token_type: 'bearer' }));
    await settle();
    expect(test.rows.get('account-a')).toMatchObject({
      state: 'error',
      enabled: false,
      error: 'GitHub authorization failed. Try again.',
    });
    expect(await test.grants.get({ pluginId: 'github', fieldId: 'token' })).toBeUndefined();
  });

  it('reports a current device denial without writing credentials', async () => {
    const test = fixture();
    await test.start();
    test.token.resolve(json({ error: 'access_denied' }));
    await settle();
    expect(test.rows.get('account-a')).toMatchObject({
      state: 'error',
      enabled: false,
      error: 'GitHub authorization was denied.',
    });
    expect(test.adapter.writeExistingCredential).not.toHaveBeenCalled();
  });

  it('persists and verifies a current successful device grant through the production composition', async () => {
    const test = fixture();
    await test.start();
    test.token.resolve(json({ access_token: 'synthetic-only-device-token', token_type: 'bearer' }));
    await settle();
    expect(test.adapter.writeExistingCredential).toHaveBeenCalledTimes(1);
    expect(await test.grants.get({ pluginId: 'github', fieldId: 'token' })).toMatchObject({
      accountId: 'account-a',
    });
    expect(
      boundary.request.mock.calls.filter(([url]) => url === 'https://api.github.com/user'),
    ).toHaveLength(1);
    expect(test.rows.get('account-a')).toMatchObject({
      state: 'connected',
      enabled: true,
      accountLabel: 'fixture-user',
    });
  });
});
