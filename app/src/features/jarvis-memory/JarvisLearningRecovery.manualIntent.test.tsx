import { useAuthStore } from '@/stores/auth';
import type { ProjectId, WorkspaceId } from '@/types/common';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JarvisLearningControls } from './JarvisLearningControls';
import { useJarvisLearningStore, parseJarvisLearningMarkdown } from './learningStore';
import { startJarvisLearningListener } from './learningListener';
import { loadLearningFile, saveLearningFile, type LearningFileIo } from './learningFile';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
let dispose: (() => Promise<void>) | undefined;
let release: (() => void) | undefined;
beforeEach(() => useJarvisLearningStore.getState().clearForTests());
afterEach(async () => {
  release?.();
  release = undefined;
  cleanup();
  await dispose?.();
  dispose = undefined;
});

async function fixture() {
  const values = new Map<string, string>();
  const recovery = deferred();
  const retry = deferred();
  let holdRetry = false;
  release = () => {
    recovery.resolve();
    retry.resolve();
  };
  let primary = '';
  let holdRead = false;
  let recoveryEntered = false;
  let armed = false;
  let failing = true;
  let alwaysFail = false;
  let writes = 0;
  let account = 'account-a';
  let notifyAccount!: () => void;
  let accountSubscribed = false;
  let accountSubscriptionStops = 0;
  const statuses: string[] = [];
  const recoveryAnnouncements: Array<{ durable: string | null; visible: string }> = [];
  const io: LearningFileIo = {
    resolveRoot: async () => 'C:\\synthetic-recovery-intent',
    createDirectory: async () => undefined,
    readText: async (path) => {
      if (holdRead && path === primary) {
        holdRead = false;
        recoveryEntered = true;
        await recovery.promise;
      }
      return values.get(path) ?? null;
    },
    writeText: async (path, markdown) => {
      if (armed && path === primary) {
        writes += 1;
        if (failing && (writes === 1 || alwaysFail)) {
          holdRead = writes === 1;
          throw new Error('synthetic owned primary failure');
        }
        if (writes === 2 && holdRetry) await retry.promise;
      }
      values.set(path, markdown);
    },
  };
  const store = useJarvisLearningStore.getState();
  store.setAccount('account-b');
  store.remember({
    value: 'Account B stays private',
    category: 'workflow',
    source: { kind: 'explicit' },
  });
  const b = await saveLearningFile('account-b', store.exportMarkdown(), io);
  store.setAccount('account-a');
  const item = store.remember({
    value: 'Last durable A preference',
    category: 'workflow',
    source: { kind: 'explicit' },
  })!;
  const a = await saveLearningFile('account-a', store.exportMarkdown(), io);
  primary = a.path;
  store.clearForTests();
  const onError = vi.fn();
  const onStatus = (event: Event) => {
    const state = (event as CustomEvent<{ state: string }>).detail.state;
    statuses.push(state);
    if (state === 'recovered')
      recoveryAnnouncements.push({
        durable: values.get(primary) ?? null,
        visible: store.exportMarkdown(),
      });
  };
  window.addEventListener('jarvis:memory-status', onStatus);
  const stop = startJarvisLearningListener({
    getAccountId: () => account,
    subscribeAccount: (listener) => {
      notifyAccount = listener;
      accountSubscribed = true;
      return () => {
        accountSubscribed = false;
        accountSubscriptionStops += 1;
      };
    },
    load: (owner) => loadLearningFile(owner, io),
    save: (owner, markdown) => saveLearningFile(owner, markdown, io),
    debounceMs: 0,
    onError,
  });
  dispose = async () => {
    window.removeEventListener('jarvis:memory-status', onStatus);
    await stop();
  };
  await waitFor(() =>
    expect(useJarvisLearningStore.getState().currentProfile().items[0]?.value).toBe(
      'Last durable A preference',
    ),
  );
  render(
    <JarvisLearningControls
      getCheckStatus={() => ({ state: 'idle' })}
      subscribeCheckStatus={() => () => undefined}
    />,
  );
  armed = true;
  const edit = (value: string) => {
    fireEvent.click(screen.getByRole('button', { name: `Edit memory ${item}` }));
    fireEvent.change(screen.getByLabelText('Memory value'), { target: { value } });
    fireEvent.click(screen.getByRole('button', { name: 'Save memory' }));
  };
  return {
    a,
    b,
    item,
    values,
    io,
    statuses,
    recoveryAnnouncements,
    holdRetry: () => {
      holdRetry = true;
    },
    releaseRetry: async () => {
      await act(async () => retry.resolve());
    },
    onError,
    edit,
    writes: () => writes,
    accountSubscriptionStops: () => accountSubscriptionStops,
    failAlways: () => {
      alwaysFail = true;
    },
    allowWrites: () => {
      failing = false;
    },
    enterRecovery: async () => {
      edit('Older failed edit');
      await waitFor(() => expect(recoveryEntered).toBe(true));
    },
    finishRecovery: async () => {
      await act(async () => recovery.resolve());
    },
    switchAccount: (next: string) => {
      account = next;
      if (accountSubscribed) notifyAccount();
    },
    durable: async () =>
      parseJarvisLearningMarkdown((await loadLearningFile('account-a', io)).markdown, 'account-a')!,
  };
}

describe('newer manual memory intent during a physical recovery read', () => {
  it('restores last-good content when no newer manual change was made', async () => {
    const h = await fixture();
    await h.enterRecovery();
    await h.finishRecovery();
    await waitFor(() => expect(h.statuses).toContain('recovered'));
    expect(useJarvisLearningStore.getState().currentProfile().items[0]?.value).toBe(
      'Last durable A preference',
    );
    expect((await h.durable()).items[0]?.value).toBe('Last durable A preference');
    expect(h.writes()).toBe(1);
  });

  it('retains and persists a newer UI edit after the older save fails', async () => {
    const h = await fixture();
    await h.enterRecovery();
    h.edit('Newer explicitly edited preference');
    await h.finishRecovery();
    await waitFor(() => expect(h.statuses).toContain('recovered'));
    expect(useJarvisLearningStore.getState().currentProfile().items[0]?.value).toBe(
      'Newer explicitly edited preference',
    );
    expect((await h.durable()).items[0]?.value).toBe('Newer explicitly edited preference');
    expect(h.values.get(h.b.path)).toBe(h.b.markdown);
  });

  it('merges a newer explicit addition while rolling back the older failed item edit', async () => {
    const h = await fixture();
    await h.enterRecovery();
    act(() =>
      useJarvisLearningStore.getState().remember({
        value: 'Newer explicit addition',
        category: 'workflow',
        source: { kind: 'explicit' },
      }),
    );
    await h.finishRecovery();
    await waitFor(() => expect(h.statuses).toContain('recovered'));
    const values = (await h.durable()).items.map((item) => item.value);
    expect(values).toContain('Newer explicit addition');
    expect(values).toContain('Last durable A preference');
    expect(values).not.toContain('Older failed edit');
  });
});

it('retains an explicit Remember command accepted during the recovery read', async () => {
  const h = await fixture();
  await h.enterRecovery();
  act(() =>
    window.dispatchEvent(
      new CustomEvent('jarvis:user-command', {
        detail: {
          chatId: 'synthetic-chat-a',
          text: 'Remember that a newer explicit command must remain visible.',
        },
      }),
    ),
  );
  await waitFor(() =>
    expect(
      useJarvisLearningStore
        .getState()
        .currentProfile()
        .items.some((item) => item.value.includes('newer explicit command')),
    ).toBe(true),
  );
  await h.finishRecovery();
  await waitFor(() => expect(h.statuses).toContain('recovered'));
  expect(
    (await h.durable()).items.some((item) => item.value.includes('newer explicit command')),
  ).toBe(true);
});

it('keeps newer intent visible when retry fails, then permits a later successful edit and reopen', async () => {
  const h = await fixture();
  h.failAlways();
  await h.enterRecovery();
  h.edit('Newer retained despite unavailable storage');
  await h.finishRecovery();
  await waitFor(() => expect(h.onError).toHaveBeenCalledTimes(2));
  expect(h.writes()).toBe(2);
  expect(h.statuses.at(-1)).toBe('error');
  expect(h.statuses).not.toContain('recovered');
  expect(useJarvisLearningStore.getState().currentProfile().items[0]?.value).toBe(
    'Newer retained despite unavailable storage',
  );
  expect((await h.durable()).items[0]?.value).toBe('Last durable A preference');
  h.allowWrites();
  h.edit('Later explicitly saved preference');
  await waitFor(() => expect(h.writes()).toBe(3));
  expect((await h.durable()).items[0]?.value).toBe('Later explicitly saved preference');
  expect(h.values.get(h.b.path)).toBe(h.b.markdown);
});

it('keeps another account isolated and restores the newer item only when its owner returns', async () => {
  const h = await fixture();
  await h.enterRecovery();
  h.edit('Newer A intent before navigation');
  act(() => h.switchAccount('account-b'));
  await h.finishRecovery();
  await waitFor(() =>
    expect(useJarvisLearningStore.getState().currentProfile().items[0]?.value).toBe(
      'Account B stays private',
    ),
  );
  expect(h.values.get(h.b.path)).toBe(h.b.markdown);
  expect(h.statuses).not.toContain('recovered');
  act(() => h.switchAccount('account-a'));
  await waitFor(() =>
    expect(useJarvisLearningStore.getState().currentProfile().items[0]?.value).toBe(
      'Newer A intent before navigation',
    ),
  );
  await waitFor(() => expect(h.writes()).toBe(2));
  expect((await h.durable()).items[0]?.value).toBe('Newer A intent before navigation');
});

it('keeps a newer Remember command after Clear during the same recovery', async () => {
  const h = await fixture();
  await h.enterRecovery();
  fireEvent.click(screen.getByRole('button', { name: 'Clear all learning' }));
  fireEvent.click(screen.getByRole('button', { name: 'Confirm clear learning' }));
  act(() =>
    window.dispatchEvent(
      new CustomEvent('jarvis:user-command', {
        detail: {
          chatId: 'synthetic-chat-a',
          text: 'Remember that the new preference follows my Clear.',
        },
      }),
    ),
  );
  await waitFor(() =>
    expect(useJarvisLearningStore.getState().currentProfile().items).toHaveLength(1),
  );
  await h.finishRecovery();
  await waitFor(() => expect(h.statuses).toContain('recovered'));
  const durable = await h.durable();
  expect(durable.items).toHaveLength(1);
  expect(durable.items[0]?.value).toContain('new preference follows my Clear');
  expect(durable.items[0]?.value).not.toBe('Last durable A preference');
});

it('preserves account-level manual intent across workspace and project navigation', async () => {
  const h = await fixture();
  await h.enterRecovery();
  h.edit('Account-wide preference after navigation');
  const { workspaceId, projectId } = useAuthStore.getState();
  try {
    act(() => {
      useAuthStore.getState().setWorkspaceId('synthetic-recovery-workspace' as WorkspaceId);
      useAuthStore.getState().setProjectId('synthetic-recovery-project' as ProjectId);
    });
    await h.finishRecovery();
    await waitFor(() => expect(h.statuses).toContain('recovered'));
    expect((await h.durable()).items[0]?.value).toBe('Account-wide preference after navigation');
    expect(h.values.get(h.b.path)).toBe(h.b.markdown);
  } finally {
    act(() => useAuthStore.setState({ workspaceId, projectId }));
  }
});

it('does not announce stale recovered content while a newer manual edit is still unsaved', async () => {
  const h = await fixture();
  h.holdRetry();
  await h.enterRecovery();
  h.edit('First newer manual edit');
  await h.finishRecovery();
  await waitFor(() => expect(h.writes()).toBe(2));
  h.edit('Latest edit while retry is pending');
  await h.releaseRetry();
  await waitFor(() => expect(h.writes()).toBe(3));
  expect((await h.durable()).items[0]?.value).toBe('Latest edit while retry is pending');
  const misleading = h.recoveryAnnouncements.filter((event) => {
    const durable = event.durable && parseJarvisLearningMarkdown(event.durable, 'account-a');
    const visible = parseJarvisLearningMarkdown(event.visible, 'account-a');
    return durable && durable.items[0]?.value !== visible?.items[0]?.value;
  });
  expect(misleading).toEqual([]);
  await waitFor(() => expect(h.statuses.at(-1)).toBe('updated'));
});

it('reviewer a removed newer item cannot be revived by the pending recovery merge', async () => {
  const h = await fixture();
  await h.enterRecovery();
  h.edit('Newer item later removed');
  act(() => useJarvisLearningStore.getState().remove(h.item));
  await h.finishRecovery();
  await waitFor(() => expect(h.statuses).toContain('recovered'));
  expect((await h.durable()).items).toHaveLength(0);
  expect(useJarvisLearningStore.getState().currentProfile().items).toHaveLength(0);
  expect(h.values.get(h.b.path)).toBe(h.b.markdown);
});
it('reviewer account ABA cannot discard a newer retained manual item or alter B', async () => {
  const h = await fixture();
  await h.enterRecovery();
  h.edit('Newest retained A value');
  act(() => {
    h.switchAccount('account-b');
    h.switchAccount('account-a');
  });
  await h.finishRecovery();
  await waitFor(() => expect(h.writes()).toBeGreaterThanOrEqual(2));
  await waitFor(() =>
    expect(useJarvisLearningStore.getState().currentProfile().items[0]?.value).toBe(
      'Newest retained A value',
    ),
  );
  expect((await h.durable()).items[0]?.value).toBe('Newest retained A value');
  expect(h.values.get(h.b.path)).toBe(h.b.markdown);
});

it('reviewer disposing while Clear recovery is loading still durably flushes explicit Clear', async () => {
  const h = await fixture();
  await h.enterRecovery();
  fireEvent.click(screen.getByRole('button', { name: 'Clear all learning' }));
  fireEvent.click(screen.getByRole('button', { name: 'Confirm clear learning' }));
  expect(useJarvisLearningStore.getState().currentProfile().items).toEqual([]);
  const stopping = dispose!();
  dispose = undefined;
  await h.finishRecovery();
  await stopping;
  expect((await h.durable()).items).toEqual([]);
  expect(h.values.get(h.b.path)).toBe(h.b.markdown);
});

it('flushes captured newer intent without rehydrating quarantined state during shutdown', async () => {
  const h = await fixture();
  await h.enterRecovery();
  act(() =>
    useJarvisLearningStore.getState().remember({
      value: 'Newer captured item before graceful shutdown',
      category: 'workflow',
      source: { kind: 'explicit' },
    }),
  );
  const stop = dispose!;
  const first = stop();
  const repeated = stop();
  dispose = undefined;
  act(() => useJarvisLearningStore.getState().clearAccountScope());
  expect(h.accountSubscriptionStops()).toBe(0);
  await h.finishRecovery();
  await first;
  await repeated;
  expect(useJarvisLearningStore.getState().activeAccountId).toBe('');
  expect(useJarvisLearningStore.getState().profiles).toEqual({});
  const values = (await h.durable()).items.map((item) => item.value);
  expect(values).toContain('Newer captured item before graceful shutdown');
  expect(values).toContain('Last durable A preference');
  expect(values).not.toContain('Older failed edit');
  expect(h.writes()).toBe(2);
  expect(h.accountSubscriptionStops()).toBe(1);
  expect(h.values.get(h.b.path)).toBe(h.b.markdown);
});

it('revokes a pending shutdown drain on an observed account ABA transition', async () => {
  const h = await fixture();
  await h.enterRecovery();
  h.edit('Newer intent from the revoked account generation');
  const stopping = dispose!();
  dispose = undefined;
  act(() => {
    h.switchAccount('account-b');
    h.switchAccount('account-a');
  });
  await h.finishRecovery();
  await stopping;
  expect((await h.durable()).items[0]?.value).toBe('Last durable A preference');
  expect(h.writes()).toBe(1);
  expect(h.accountSubscriptionStops()).toBe(1);
  expect(h.values.get(h.b.path)).toBe(h.b.markdown);
});

it('reports a permanently failed shutdown drain once and releases its account observer', async () => {
  const h = await fixture();
  h.failAlways();
  await h.enterRecovery();
  h.edit('Newer intent whose shutdown write is unavailable');
  const stopping = dispose!();
  dispose = undefined;
  await h.finishRecovery();
  await stopping;
  expect(h.writes()).toBe(2);
  expect(h.onError).toHaveBeenCalledTimes(2);
  expect(h.statuses).not.toContain('recovered');
  expect((await h.durable()).items[0]?.value).toBe('Last durable A preference');
  expect(h.accountSubscriptionStops()).toBe(1);
});

it('does not repeat an already-started recovery write when shutdown begins', async () => {
  const h = await fixture();
  h.holdRetry();
  await h.enterRecovery();
  h.edit('Newer intent already being written');
  await h.finishRecovery();
  await waitFor(() => expect(h.writes()).toBe(2));
  const stopping = dispose!();
  dispose = undefined;
  await h.releaseRetry();
  await stopping;
  expect((await h.durable()).items[0]?.value).toBe('Newer intent already being written');
  expect(h.writes()).toBe(2);
  expect(h.accountSubscriptionStops()).toBe(1);
});

it('does not create a shutdown write without newer explicit intent', async () => {
  const h = await fixture();
  await h.enterRecovery();
  const stopping = dispose!();
  dispose = undefined;
  await h.finishRecovery();
  await stopping;
  expect((await h.durable()).items[0]?.value).toBe('Last durable A preference');
  expect(h.writes()).toBe(1);
  expect(h.accountSubscriptionStops()).toBe(1);
});
