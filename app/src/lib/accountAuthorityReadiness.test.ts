import * as React from 'react';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  accountAuthorityReadiness,
  createAccountAuthorityPublisher,
} from './accountAuthorityReadiness';
import { revokeLocalAccountReadiness, settleLocalAccountReadiness } from './localAccountReadiness';

const deferred = () => {
  let resolve!: () => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<void>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
};
const owners: ReturnType<typeof createAccountAuthorityPublisher>[] = [];
const owner = () => {
  const value = createAccountAuthorityPublisher();
  owners.push(value);
  return value;
};
const cloud = (publisher: ReturnType<typeof owner>, accountId = 'cloud-a') =>
  publisher
    .beginTransition()
    .settleCloud({ accountId, teardown: Promise.resolve(), isCurrent: () => true });
const local = () =>
  settleLocalAccountReadiness({
    accountId: 'local-a',
    persistenceGeneration: 7,
    teardown: Promise.resolve(),
    isCurrent: () => true,
  });

beforeEach(() => {
  revokeLocalAccountReadiness();
});
afterEach(() => {
  cleanup();
  owners.splice(0).forEach((item) => item.dispose());
});

describe('account lifecycle observations, never native authorization', () => {
  it('provides a stable frozen readonly snapshot without a consumer setter', async () => {
    const publisher = owner();
    const pending = accountAuthorityReadiness.getSnapshot();
    expect(pending.state).toBe('unready');
    expect(accountAuthorityReadiness.getSnapshot()).toBe(pending);
    expect(Object.isFrozen(pending)).toBe(true);
    await cloud(publisher);
    const ready = accountAuthorityReadiness.getSnapshot();
    expect(ready).toEqual({
      state: 'cloud',
      source: 'supabase-sdk-cache',
      accountId: 'cloud-a',
      generation: expect.any(Number),
    });
    expect(accountAuthorityReadiness.getSnapshot()).toBe(ready);
    expect(Object.isFrozen(ready)).toBe(true);
    expect(Object.keys(accountAuthorityReadiness).sort()).toEqual(['getSnapshot', 'subscribe']);
  });

  it('notifies real useSyncExternalStore consumers and remains stable across ordinary rerenders', async () => {
    const publisher = owner();
    function View() {
      const snapshot = React.useSyncExternalStore(
        accountAuthorityReadiness.subscribe,
        accountAuthorityReadiness.getSnapshot,
      );
      return React.createElement('output', null, snapshot.state);
    }
    const view = render(React.createElement(View));
    expect(view.container.textContent).toBe('unready');
    await act(async () => {
      await cloud(publisher);
    });
    const ready = accountAuthorityReadiness.getSnapshot();
    view.rerender(React.createElement(View));
    expect(view.container.textContent).toBe('cloud');
    expect(accountAuthorityReadiness.getSnapshot()).toBe(ready);
    act(() => {
      publisher.revoke();
    });
    expect(view.container.textContent).toBe('unready');
  });

  it('advances lifecycle for the same account and account ABA instead of deduplicating strings', async () => {
    const publisher = owner();
    const generations: number[] = [];
    for (const id of ['cloud-a', 'cloud-a', 'cloud-b', 'cloud-a']) {
      await cloud(publisher, id);
      generations.push(accountAuthorityReadiness.getSnapshot().generation);
    }
    expect(generations.every((value, index) => index === 0 || value > generations[index - 1])).toBe(
      true,
    );
  });

  it('revokes synchronously and waits for teardown before publishing cloud metadata', async () => {
    const publisher = owner();
    await cloud(publisher);
    const teardown = deferred();
    const transition = publisher.beginTransition();
    expect(accountAuthorityReadiness.getSnapshot().state).toBe('unready');
    const pending = transition.settleCloud({
      accountId: 'cloud-b',
      teardown: teardown.promise,
      isCurrent: () => true,
    });
    await Promise.resolve();
    expect(accountAuthorityReadiness.getSnapshot().state).toBe('unready');
    teardown.resolve();
    await pending;
    expect(accountAuthorityReadiness.getSnapshot()).toMatchObject({
      state: 'cloud',
      accountId: 'cloud-b',
    });
  });

  it.each(['rejection', 'invalid-after-await', 'invalid-before-await', 'blank-id'] as const)(
    'fails closed on %s',
    async (reason) => {
      const publisher = owner();
      const teardown = deferred();
      let current = reason !== 'invalid-before-await';
      const pending = publisher.beginTransition().settleCloud({
        accountId: reason === 'blank-id' ? ' ' : 'cloud-a',
        teardown: teardown.promise,
        isCurrent: () => current,
      });
      current = reason !== 'invalid-after-await';
      if (reason === 'rejection') teardown.reject(new Error('synthetic teardown error'));
      else teardown.resolve();
      await pending;
      expect(accountAuthorityReadiness.getSnapshot().state).toBe('unready');
    },
  );

  it('rejects old completion after same-account revoke and reauthentication', async () => {
    const publisher = owner();
    const teardown = deferred();
    const pending = publisher
      .beginTransition()
      .settleCloud({ accountId: 'cloud-a', teardown: teardown.promise, isCurrent: () => true });
    publisher.revoke();
    await cloud(publisher);
    const ready = accountAuthorityReadiness.getSnapshot();
    teardown.resolve();
    await pending;
    expect(accountAuthorityReadiness.getSnapshot()).toBe(ready);
  });

  it('stale owner cleanup, transitions and pending completion cannot revoke its replacement', async () => {
    const old = owner();
    const teardown = deferred();
    const pending = old
      .beginTransition()
      .settleCloud({ accountId: 'cloud-a', teardown: teardown.promise, isCurrent: () => true });
    const current = owner();
    await cloud(current, 'cloud-b');
    const ready = accountAuthorityReadiness.getSnapshot();
    old.dispose();
    old.revoke();
    await cloud(old, 'cloud-a');
    teardown.resolve();
    await pending;
    expect(accountAuthorityReadiness.getSnapshot()).toBe(ready);
  });

  it('only mirrors actual local persistence receipts after accepted signed-out lifecycle', async () => {
    const publisher = owner();
    await local();
    expect(accountAuthorityReadiness.getSnapshot().state).toBe('unready');
    publisher.beginTransition().followLocalReadiness();
    expect(accountAuthorityReadiness.getSnapshot()).toMatchObject({
      state: 'local',
      accountId: 'local-a',
      persistenceGeneration: 7,
    });
    const ready = accountAuthorityReadiness.getSnapshot();
    revokeLocalAccountReadiness();
    expect(accountAuthorityReadiness.getSnapshot().state).toBe('unready');
    expect(accountAuthorityReadiness.getSnapshot().generation).toBeGreaterThan(ready.generation);
    await local();
    expect(accountAuthorityReadiness.getSnapshot().state).toBe('local');
    await cloud(publisher);
    revokeLocalAccountReadiness();
    await local();
    expect(accountAuthorityReadiness.getSnapshot().state).toBe('cloud');
  });

  it('unsubscribes and isolates a throwing observer from later observers and the boot owner', async () => {
    const publisher = owner();
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const bad = accountAuthorityReadiness.subscribe(() => {
      throw new Error('synthetic observer error');
    });
    const listener = vi.fn();
    const stop = accountAuthorityReadiness.subscribe(listener);
    try {
      await cloud(publisher);
      expect(listener).toHaveBeenCalled();
      stop();
      listener.mockClear();
      publisher.revoke();
      expect(listener).not.toHaveBeenCalled();
    } finally {
      bad();
      stop();
      errors.mockRestore();
    }
  });
});
