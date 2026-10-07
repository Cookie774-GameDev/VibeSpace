import { StrictMode, type ComponentProps } from 'react';
import { useAuthStore } from '@/stores/auth';
import type { ProjectId, WorkspaceId } from '@/types/common';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JarvisLearningControls } from './JarvisLearningControls';
import { useJarvisLearningStore } from './learningStore';
import { loadLearningFile, saveLearningFile, type LearningFileIo } from './learningFile';
import { startJarvisLearningListener } from './learningListener';
import type { CaoScheduledLearningRuntimeStatus } from './caoScheduledLearningRuntime';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const idle = () => ({ state: 'idle' as const });
const subscribe = () => () => undefined;
function controls(props: Partial<ComponentProps<typeof JarvisLearningControls>> = {}) {
  return render(
    <JarvisLearningControls getCheckStatus={idle} subscribeCheckStatus={subscribe} {...props} />,
  );
}
function seed(account: string, value: string) {
  const store = useJarvisLearningStore.getState();
  store.setAccount(account);
  return store.remember({ value, category: 'workflow', source: { kind: 'explicit' } })!;
}
let stop: (() => Promise<void>) | undefined;
let release: (() => void) | undefined;
beforeEach(() => {
  useJarvisLearningStore.getState().clearForTests();
  seed('account-b', 'Keep account B memory');
  seed('account-a', 'Keep account A memory');
});
afterEach(async () => {
  release?.();
  release = undefined;
  cleanup();
  await stop?.();
  stop = undefined;
});

describe('learning controls retain their initiating account authority', () => {
  it('discards A clear confirmation when switching to B', () => {
    controls();
    fireEvent.click(screen.getByRole('button', { name: 'Clear all learning' }));
    act(() => useJarvisLearningStore.getState().setAccount('account-b'));
    const staleConfirm = screen.queryByRole('button', { name: 'Confirm clear learning' });
    if (staleConfirm) fireEvent.click(staleConfirm);
    expect(
      useJarvisLearningStore
        .getState()
        .currentProfile()
        .items.map((item) => item.value),
    ).toEqual(['Keep account B memory']);
    expect(staleConfirm).toBeNull();
  });

  it('discards an edit draft across an A to B to A transition', () => {
    controls();
    const id = useJarvisLearningStore.getState().currentProfile().items[0]!.id;
    fireEvent.click(screen.getByRole('button', { name: `Edit memory ${id}` }));
    fireEvent.change(screen.getByLabelText('Memory value'), { target: { value: 'Stale A draft' } });
    act(() => {
      useJarvisLearningStore.getState().setAccount('account-b');
      useJarvisLearningStore.getState().setAccount('account-a');
    });
    expect(screen.queryByLabelText('Memory value')).toBeNull();
    expect(useJarvisLearningStore.getState().currentProfile().items[0]!.value).toBe(
      'Keep account A memory',
    );
  });

  it.each(['completed', 'failed'] as const)(
    'ignores late %s from A after B becomes current',
    async (status) => {
      const pending = deferred<{ status: typeof status }>();
      controls({ onRunCheckNow: () => pending.promise });
      fireEvent.click(screen.getByRole('button', { name: 'Run learning check now' }));
      act(() => useJarvisLearningStore.getState().setAccount('account-b'));
      await act(async () => pending.resolve({ status }));
      expect(screen.getByRole('status').textContent).toBe('Learning check idle');
    },
  );

  it('accepts a fresh manual check after an idle batched account ABA', () => {
    const run = vi.fn(async () => ({ status: 'completed' as const }));
    controls({ onRunCheckNow: run });
    act(() => {
      useJarvisLearningStore.getState().setAccount('account-b');
      useJarvisLearningStore.getState().setAccount('account-a');
    });
    fireEvent.click(screen.getByRole('button', { name: 'Run learning check now' }));
    expect(run).toHaveBeenCalledOnce();
  });

  it('rejects a retired status subscription after batched account ABA', () => {
    const listeners: Array<(status: CaoScheduledLearningRuntimeStatus) => void> = [];
    const subscribeStatus = (listener: (status: CaoScheduledLearningRuntimeStatus) => void) => {
      listeners.push(listener);
      return () => undefined;
    };
    controls({ subscribeCheckStatus: subscribeStatus });
    const retired = listeners[0]!;
    act(() => {
      useJarvisLearningStore.getState().setAccount('account-b');
      useJarvisLearningStore.getState().setAccount('account-a');
    });
    const completed: CaoScheduledLearningRuntimeStatus = {
      state: 'completed',
      scope: {
        accountId: 'account-a',
        workspaceId: 'workspace-a',
        projectId: 'project-a',
        scheduleId: 'schedule-a',
        targetId: 'learning-md',
        scheduleAnchorAt: 1000,
      },
    };
    act(() => retired(completed));
    expect(screen.getByRole('status').textContent).toBe('Learning check idle');
    act(() => listeners.at(-1)!(completed));
    expect(screen.getByRole('status').textContent).toBe('Learning check completed');
  });

  it('keeps a UI disable authoritative when an earlier physical save fails and recovers', async () => {
    const files = new Map<string, string>();
    const held = deferred<void>();
    let holdNextPrimary = false;
    let heldPrimary = false;
    const io: LearningFileIo = {
      resolveRoot: async () => 'C:\\synthetic-private',
      createDirectory: async () => undefined,
      readText: async (path) => files.get(path) ?? null,
      writeText: async (path, value) => {
        if (holdNextPrimary && path.endsWith('learning.md')) {
          holdNextPrimary = false;
          heldPrimary = true;
          await held.promise;
          throw new Error('synthetic primary write refused');
        }
        files.set(path, value);
      },
    };
    const original = await saveLearningFile(
      'account-a',
      useJarvisLearningStore.getState().exportMarkdown(),
      io,
    );
    useJarvisLearningStore.getState().clearForTests();
    const onError = vi.fn();
    stop = startJarvisLearningListener({
      getAccountId: () => 'account-a',
      save: (account, markdown) => saveLearningFile(account, markdown, io),
      load: (account) => loadLearningFile(account, io),
      debounceMs: 0,
      onError,
    });
    await waitFor(() =>
      expect(useJarvisLearningStore.getState().currentProfile().items).toHaveLength(1),
    );
    controls();
    const id = useJarvisLearningStore.getState().currentProfile().items[0]!.id;
    holdNextPrimary = true;
    fireEvent.click(screen.getByRole('button', { name: `Edit memory ${id}` }));
    fireEvent.change(screen.getByLabelText('Memory value'), {
      target: { value: 'Optimistic pending edit' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save memory' }));
    await waitFor(() => expect(heldPrimary).toBe(true));
    fireEvent.click(screen.getByRole('switch', { name: 'Jarvis learning enabled' }));
    expect(useJarvisLearningStore.getState().currentProfile().enabled).toBe(false);
    release = () => held.resolve();
    await act(async () => {
      release!();
    });
    await waitFor(() => expect(onError).toHaveBeenCalled());
    await waitFor(() =>
      expect(useJarvisLearningStore.getState().currentProfile().items[0]?.value).toBe(
        'Keep account A memory',
      ),
    );
    expect(useJarvisLearningStore.getState().currentProfile().enabled).toBe(false);
    expect(files.get(original.path)).toContain('Enabled: no');
  });
});

async function persistedControls(seedMessages = 0) {
  const files = new Map<string, string>();
  let beforePrimary: ((markdown: string) => Promise<void>) | undefined;
  const primaryWrites: string[] = [];
  const loads: string[] = [];
  const completedLoads: string[] = [];
  const pendingLoads: Array<ReturnType<typeof loadLearningFile>> = [];
  const statuses: string[] = [];
  const io: LearningFileIo = {
    resolveRoot: async () => 'C:\\synthetic-private',
    createDirectory: async () => undefined,
    readText: async (path) => files.get(path) ?? null,
    writeText: async (path, markdown) => {
      if (path.endsWith('learning.md')) {
        if (beforePrimary) {
          primaryWrites.push(markdown);
          await beforePrimary(markdown);
        }
      }
      files.set(path, markdown);
    },
  };
  const store = useJarvisLearningStore.getState();
  store.setAccount('account-b');
  const b = await saveLearningFile('account-b', store.exportMarkdown(), io);
  store.setAccount('account-a');
  for (let index = 0; index < seedMessages; index += 1) {
    store.recordUserMessage({ text: `A meaningful synthetic prior message number ${index}` });
  }
  const a = await saveLearningFile('account-a', store.exportMarkdown(), io);
  store.clearForTests();
  let account = 'account-a';
  let notifyAccount!: () => void;
  const onError = vi.fn();
  const onStatus = (event: Event) =>
    statuses.push((event as CustomEvent<{ state: string }>).detail.state);
  window.addEventListener('jarvis:memory-status', onStatus);
  const dispose = startJarvisLearningListener({
    getAccountId: () => account,
    subscribeAccount: (listener) => {
      notifyAccount = listener;
      return () => undefined;
    },
    save: (owner, markdown) => saveLearningFile(owner, markdown, io),
    load: async (owner) => {
      loads.push(owner);
      const result = loadLearningFile(owner, io);
      pendingLoads.push(result);
      const loaded = await result;
      completedLoads.push(owner);
      return loaded;
    },
    debounceMs: 0,
    onError,
  });
  stop = async () => {
    window.removeEventListener('jarvis:memory-status', onStatus);
    await dispose();
  };
  await waitFor(() =>
    expect(useJarvisLearningStore.getState().currentProfile().items).toHaveLength(1),
  );
  controls();
  return {
    files,
    a,
    b,
    io,
    primaryWrites,
    loads,
    completedLoads,
    pendingLoads,
    statuses,
    onError,
    beforePrimary: (hook: (markdown: string) => Promise<void>) => {
      beforePrimary = hook;
    },
    switchAccount: (next: string) => {
      account = next;
      notifyAccount();
    },
    edit: () => {
      const id = useJarvisLearningStore.getState().currentProfile().items[0]!.id;
      fireEvent.click(screen.getByRole('button', { name: `Edit memory ${id}` }));
      fireEvent.change(screen.getByLabelText('Memory value'), {
        target: { value: 'Pending edited preference' },
      });
      fireEvent.click(screen.getByRole('button', { name: 'Save memory' }));
    },
    toggle: () => fireEvent.click(screen.getByRole('switch', { name: 'Jarvis learning enabled' })),
  };
}

it('keeps disable in memory and reports unavailable after a failed bounded recovery retry', async () => {
  const h = await persistedControls();
  const gate = deferred<void>();
  release = () => gate.resolve();
  h.beforePrimary(async () => {
    await gate.promise;
    throw new Error('synthetic unavailable file');
  });
  h.edit();
  await waitFor(() => expect(h.primaryWrites).toHaveLength(1));
  h.toggle();
  await act(async () => release!());
  await waitFor(() => expect(h.onError).toHaveBeenCalledTimes(2));
  await act(async () => {
    await stop!();
    stop = undefined;
  });
  expect(h.primaryWrites).toHaveLength(2);
  expect(useJarvisLearningStore.getState().currentProfile().enabled).toBe(false);
  expect(h.statuses.at(-1)).toBe('error');
  expect(h.files.get(h.a.path)).toContain('Enabled: yes'); // Failure is not claimed durable.
});

it('persists a newer re-enable issued while the consent recovery retry is pending', async () => {
  const h = await persistedControls();
  const first = deferred<void>();
  const retry = deferred<void>();
  release = () => {
    first.resolve();
    retry.resolve();
  };
  h.beforePrimary(async () => {
    if (h.primaryWrites.length === 1) {
      await first.promise;
      throw new Error('first write failed');
    }
    if (h.primaryWrites.length === 2) await retry.promise;
  });
  h.edit();
  await waitFor(() => expect(h.primaryWrites).toHaveLength(1));
  h.toggle();
  await act(async () => first.resolve());
  await waitFor(() => expect(h.primaryWrites).toHaveLength(2));
  h.toggle();
  await act(async () => retry.resolve());
  await waitFor(() => expect(h.primaryWrites).toHaveLength(3));
  await act(async () => {
    await stop!();
    stop = undefined;
  });
  expect(useJarvisLearningStore.getState().currentProfile().enabled).toBe(true);
  const reopened = await loadLearningFile('account-a', h.io);
  expect(reopened.markdown).toContain('Enabled: yes');
  expect(reopened.markdown).toContain('Keep account A memory');
  expect(reopened.markdown).not.toContain('Pending edited preference');
  expect(h.files.get(h.b.path)).toContain('Keep account B memory');
});

it.each([false, true])(
  'does not apply a late failed save across account switch (ABA=%s)',
  async (aba) => {
    const h = await persistedControls();
    const gate = deferred<void>();
    release = () => gate.resolve();
    h.beforePrimary(async () => {
      await gate.promise;
      throw new Error('old account save failed');
    });
    h.edit();
    await waitFor(() => expect(h.primaryWrites).toHaveLength(1));
    act(() => {
      h.switchAccount('account-b');
      if (aba) h.switchAccount('account-a');
    });
    await act(async () => release!());
    await waitFor(() => expect(h.loads).toHaveLength(2));
    await waitFor(() =>
      expect(useJarvisLearningStore.getState().currentProfile().items[0]?.value).toBe(
        aba ? 'Keep account A memory' : 'Keep account B memory',
      ),
    );
    expect(h.onError).not.toHaveBeenCalled();
    expect(h.statuses).not.toContain('error');
    expect(h.statuses).not.toContain('recovered');
    expect(h.files.get(h.b.path)).toContain('Keep account B memory');
  },
);

it('retains an authorized account preference save across workspace and project navigation', async () => {
  const h = await persistedControls();
  const gate = deferred<void>();
  release = () => gate.resolve();
  h.beforePrimary(() => gate.promise);
  h.edit();
  await waitFor(() => expect(h.primaryWrites).toHaveLength(1));
  const { workspaceId, projectId } = useAuthStore.getState();
  try {
    act(() => {
      useAuthStore.getState().setWorkspaceId('synthetic-workspace-b' as WorkspaceId);
      useAuthStore.getState().setProjectId('synthetic-project-b' as ProjectId);
    });
    await act(async () => {
      release!();
      await stop!();
      stop = undefined;
    });
    expect((await loadLearningFile('account-a', h.io)).markdown).toContain(
      'Pending edited preference',
    );
    expect((await loadLearningFile('account-b', h.io)).markdown).toContain('Keep account B memory');
  } finally {
    act(() => useAuthStore.setState({ workspaceId, projectId }));
  }
});

it('does not resurrect a UI-cleared memory when an earlier pending save fails', async () => {
  const h = await persistedControls();
  const gate = deferred<void>();
  release = () => gate.resolve();
  h.beforePrimary(async () => {
    if (h.primaryWrites.length === 1) {
      await gate.promise;
      throw new Error('old edit failed');
    }
  });
  h.edit();
  await waitFor(() => expect(h.primaryWrites).toHaveLength(1));
  fireEvent.click(screen.getByRole('button', { name: 'Clear all learning' }));
  fireEvent.click(screen.getByRole('button', { name: 'Confirm clear learning' }));
  await act(async () => release!());
  await waitFor(() => expect(h.onError).toHaveBeenCalled());
  await act(async () => {
    await stop!();
    stop = undefined;
  });
  expect(useJarvisLearningStore.getState().currentProfile().items).toEqual([]);
  expect((await loadLearningFile('account-a', h.io)).markdown).not.toContain(
    'Keep account A memory',
  );
});

it.each(['remove', 'clear'] as const)(
  'preserves newer UI undo after %s during a failed pending save',
  async (operation) => {
    const h = await persistedControls();
    const gate = deferred<void>();
    release = () => gate.resolve();
    h.beforePrimary(async () => {
      if (h.primaryWrites.length === 1) {
        await gate.promise;
        throw new Error('old edit failed');
      }
    });
    h.edit();
    await waitFor(() => expect(h.primaryWrites).toHaveLength(1));
    if (operation === 'remove') {
      const id = useJarvisLearningStore.getState().currentProfile().items[0]!.id;
      fireEvent.click(screen.getByRole('button', { name: `Remove memory ${id}` }));
    } else {
      fireEvent.click(screen.getByRole('button', { name: 'Clear all learning' }));
      fireEvent.click(screen.getByRole('button', { name: 'Confirm clear learning' }));
    }
    fireEvent.click(screen.getByRole('button', { name: 'Undo memory change' }));
    expect(useJarvisLearningStore.getState().currentProfile().items[0]?.value).toBe(
      'Pending edited preference',
    );
    await act(async () => release!());
    await waitFor(() => expect(h.statuses).toContain('recovered'));
    expect(useJarvisLearningStore.getState().currentProfile().items[0]?.value).toBe(
      'Pending edited preference',
    );
    expect((await loadLearningFile('account-a', h.io)).markdown).toContain(
      'Pending edited preference',
    );
  },
);

it('keeps a removed item deleted through recovery and reopen', async () => {
  const h = await persistedControls();
  const gate = deferred<void>();
  release = () => gate.resolve();
  h.beforePrimary(async () => {
    if (h.primaryWrites.length === 1) {
      await gate.promise;
      throw new Error('old edit failed');
    }
  });
  h.edit();
  await waitFor(() => expect(h.primaryWrites).toHaveLength(1));
  const id = useJarvisLearningStore.getState().currentProfile().items[0]!.id;
  fireEvent.click(screen.getByRole('button', { name: `Remove memory ${id}` }));
  await act(async () => release!());
  await waitFor(() => expect(h.statuses).toContain('recovered'));
  expect(useJarvisLearningStore.getState().currentProfile().items).toEqual([]);
  expect((await loadLearningFile('account-a', h.io)).markdown).not.toContain(
    'Keep account A memory',
  );
});

it.each(['disable', 'clear'] as const)(
  'ignores an old manual result after UI %s revokes learning',
  async (action) => {
    const pending = deferred<{ status: 'completed' }>();
    controls({ onRunCheckNow: () => pending.promise });
    fireEvent.click(screen.getByRole('button', { name: 'Run learning check now' }));
    if (action === 'disable') {
      fireEvent.click(screen.getByRole('switch', { name: 'Jarvis learning enabled' }));
    } else {
      fireEvent.click(screen.getByRole('button', { name: 'Clear all learning' }));
      fireEvent.click(screen.getByRole('button', { name: 'Confirm clear learning' }));
    }
    await act(async () => pending.resolve({ status: 'completed' }));
    expect(screen.getByRole('status').textContent).not.toBe('Learning check completed');
  },
);

it('keeps freshly mounted controls usable under React StrictMode effect replay', async () => {
  const run = vi.fn(async () => ({ status: 'completed' as const }));
  render(
    <StrictMode>
      <JarvisLearningControls
        getCheckStatus={idle}
        subscribeCheckStatus={subscribe}
        onRunCheckNow={run}
      />
    </StrictMode>,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Run learning check now' }));
  await waitFor(() => expect(run).toHaveBeenCalledOnce());
});

it('reviewer retains failed explicit disable after account re-entry', async () => {
  const h = await persistedControls();
  h.beforePrimary(async () => {
    throw new Error('Synthetic control storage unavailable');
  });
  h.toggle();
  await waitFor(() => expect(h.onError).toHaveBeenCalledTimes(2));
  expect(useJarvisLearningStore.getState().currentProfile().enabled).toBe(false);
  expect(h.files.get(h.a.path)).toContain('Enabled: yes');
  act(() => h.switchAccount('account-b'));
  await waitFor(() =>
    expect(useJarvisLearningStore.getState().currentProfile().items[0]?.value).toBe(
      'Keep account B memory',
    ),
  );
  act(() => h.switchAccount('account-a'));
  await waitFor(() => expect(h.loads.filter((account) => account === 'account-a')).toHaveLength(3));
  await act(async () => {
    await Promise.all(h.pendingLoads);
  });
  expect(useJarvisLearningStore.getState().activeAccountId).toBe('account-a');
  expect(useJarvisLearningStore.getState().currentProfile().enabled).toBe(false);
});

it('reviewer retains an in-flight failed disable across account re-entry', async () => {
  const h = await persistedControls();
  const pending = deferred<void>();
  release = () => pending.resolve();
  h.beforePrimary(async () => {
    await pending.promise;
    throw new Error('Synthetic control write failed after scope change');
  });
  h.toggle();
  await waitFor(() => expect(h.primaryWrites).toHaveLength(1));
  expect(useJarvisLearningStore.getState().currentProfile().enabled).toBe(false);
  act(() => h.switchAccount('account-b'));
  await act(async () => release!());
  await waitFor(() =>
    expect(useJarvisLearningStore.getState().currentProfile().items[0]?.value).toBe(
      'Keep account B memory',
    ),
  );
  act(() => h.switchAccount('account-a'));
  await waitFor(() => expect(h.loads.filter((account) => account === 'account-a')).toHaveLength(2));
  await act(async () => {
    release!();
    await Promise.all(h.pendingLoads);
  });
  expect(useJarvisLearningStore.getState().activeAccountId).toBe('account-a');
  expect(useJarvisLearningStore.getState().currentProfile().enabled).toBe(false);
});

it.each(['disable', 'remove', 'clear'] as const)(
  'hydrates and durably retries pending %s after account re-entry',
  async (action) => {
    const h = await persistedControls();
    const gate = deferred<void>();
    release = () => gate.resolve();
    h.beforePrimary(async () => {
      if (h.primaryWrites.length === 1) {
        await gate.promise;
        throw new Error('control write failed after switch');
      }
    });
    if (action === 'disable') h.toggle();
    else if (action === 'remove') {
      const id = useJarvisLearningStore.getState().currentProfile().items[0]!.id;
      fireEvent.click(screen.getByRole('button', { name: `Remove memory ${id}` }));
    } else {
      fireEvent.click(screen.getByRole('button', { name: 'Clear all learning' }));
      fireEvent.click(screen.getByRole('button', { name: 'Confirm clear learning' }));
    }
    await waitFor(() => expect(h.primaryWrites).toHaveLength(1));
    act(() => h.switchAccount('account-b'));
    await act(async () => release!());
    await waitFor(() =>
      expect(useJarvisLearningStore.getState().currentProfile().items[0]?.value).toBe(
        'Keep account B memory',
      ),
    );
    act(() => h.switchAccount('account-a'));
    await waitFor(() =>
      expect(h.completedLoads.filter((account) => account === 'account-a')).toHaveLength(2),
    );
    await act(async () => {
      await Promise.resolve();
    });
    if (action === 'disable')
      expect(useJarvisLearningStore.getState().currentProfile().enabled).toBe(false);
    else expect(useJarvisLearningStore.getState().currentProfile().items).toEqual([]);
    await waitFor(() => expect(h.primaryWrites).toHaveLength(2));
    const reopened = await loadLearningFile('account-a', h.io);
    if (action === 'disable') expect(reopened.markdown).toContain('Enabled: no');
    else expect(reopened.markdown).not.toContain('Keep account A memory');
    expect(h.files.get(h.b.path)).toBe(h.b.markdown);
  },
);

it('accepts newer consent while the re-entry durability retry is pending', async () => {
  const h = await persistedControls();
  const original = deferred<void>();
  const retry = deferred<void>();
  release = () => {
    original.resolve();
    retry.resolve();
  };
  h.beforePrimary(async () => {
    if (h.primaryWrites.length === 1) {
      await original.promise;
      throw new Error('old disable failed');
    }
    if (h.primaryWrites.length === 2) await retry.promise;
  });
  h.toggle();
  await waitFor(() => expect(h.primaryWrites).toHaveLength(1));
  act(() => h.switchAccount('account-b'));
  await act(async () => original.resolve());
  await waitFor(() =>
    expect(useJarvisLearningStore.getState().currentProfile().items[0]?.value).toBe(
      'Keep account B memory',
    ),
  );
  act(() => h.switchAccount('account-a'));
  await waitFor(() => expect(h.primaryWrites).toHaveLength(2));
  expect(useJarvisLearningStore.getState().currentProfile().enabled).toBe(false);
  h.toggle();
  await act(async () => retry.resolve());
  await waitFor(() => expect(h.primaryWrites).toHaveLength(3));
  expect((await loadLearningFile('account-a', h.io)).markdown).toContain('Enabled: yes');
  expect(h.files.get(h.b.path)).toBe(h.b.markdown);
});

it('retains Clear across logout without restoring old learning progress', async () => {
  const h = await persistedControls(2);
  const gate = deferred<void>();
  release = () => gate.resolve();
  h.beforePrimary(async () => {
    if (h.primaryWrites.length === 1) {
      await gate.promise;
      throw new Error('clear write failed after logout');
    }
  });
  fireEvent.click(screen.getByRole('button', { name: 'Clear all learning' }));
  fireEvent.click(screen.getByRole('button', { name: 'Confirm clear learning' }));
  await waitFor(() => expect(h.primaryWrites).toHaveLength(1));
  act(() => h.switchAccount(''));
  expect(useJarvisLearningStore.getState().activeAccountId).toBe('');
  await act(async () => release!());
  act(() => h.switchAccount('account-a'));
  await waitFor(() =>
    expect(h.completedLoads.filter((account) => account === 'account-a')).toHaveLength(2),
  );
  await act(async () => {
    await Promise.resolve();
  });
  expect(useJarvisLearningStore.getState().currentProfile().items).toEqual([]);
  expect(useJarvisLearningStore.getState().currentProfile().meaningfulMessageCount).toBe(0);
  await waitFor(() => expect(h.primaryWrites).toHaveLength(2));
  expect((await loadLearningFile('account-a', h.io)).markdown).not.toContain(
    'Keep account A memory',
  );
});
