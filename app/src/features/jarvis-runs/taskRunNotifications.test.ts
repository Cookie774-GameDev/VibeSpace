import { describe, expect, it, vi } from 'vitest';

import type { JarvisEvent } from '@/lib/jarvis/contracts/execution';

import { notificationVariant, startJarvisTaskRunNotifications } from './taskRunNotifications';
import { useJarvisTaskRunStore } from './taskRunStore';
import { chatRepo, workspaceRepo } from '@/lib/db/repositories';
import { jarvisRunRepo } from '@/lib/db/jarvisRepositories';
import { useUIStore } from '@/stores/ui';
import * as tauriBridge from '@/lib/tauri';

const NOW = 1_784_435_200_000;

function event(seq: number, overrides: Partial<JarvisEvent> = {}): JarvisEvent {
  return {
    runId: 'jrun-alpha',
    seq,
    idempotencyKey: `event-${seq}`,
    type: 'run_state',
    status: 'running',
    title: 'PRIVATE EVENT TITLE',
    safeSummary: 'PRIVATE SAFE SUMMARY MUST NOT ENTER NOTIFICATION',
    sourceRefs: [],
    artifactIds: [],
    createdAt: NOW + seq,
    ...overrides,
  };
}

describe('canonical Jarvis task notifications', () => {
  it('uses distinct artwork for completion, failure, stopped, and input-needed states', () => {
    expect(notificationVariant('completed')).toBe('task_completed');
    expect(notificationVariant('failed')).toBe('task_failed');
    expect(notificationVariant('timed_out')).toBe('task_failed');
    expect(notificationVariant('cancelled')).toBe('task_stopped');
    expect(notificationVariant('awaiting_approval')).toBe('task_attention');
    expect(notificationVariant('partial')).toBe('task_attention');
  });

  it('delivers failed and stopped outcomes with their artwork and sound preference', async () => {
    const previous = useUIStore.getState();
    useUIStore.setState({
      notificationMaster: true,
      doneNotifications: { ...previous.doneNotifications, tasks: true },
      notificationSound: false,
    });
    const native = vi.spyOn(tauriBridge, 'notify').mockResolvedValue({
      channel: 'none',
      permission: 'unavailable',
      message: 'test',
    });
    let listener: (event: JarvisEvent) => void = () => undefined;
    const stop = startJarvisTaskRunNotifications({
      subscribe: (next) => {
        listener = next;
        return () => undefined;
      },
    });
    try {
      listener(event(1, { status: 'failed' }));
      listener(event(2, { status: 'cancelled' }));
      await vi.waitFor(() => expect(native).toHaveBeenCalledTimes(2));
      expect(native).toHaveBeenNthCalledWith(1, 'Jarvis task failed', expect.any(String), {
        fallbackToast: true,
        silent: true,
        variant: 'task_failed',
      });
      expect(native).toHaveBeenNthCalledWith(2, 'Jarvis task stopped', expect.any(String), {
        fallbackToast: true,
        silent: true,
        variant: 'task_stopped',
      });
    } finally {
      stop();
      native.mockRestore();
      useUIStore.setState({
        notificationMaster: previous.notificationMaster,
        doneNotifications: previous.doneNotifications,
        notificationSound: previous.notificationSound,
      });
    }
  });
  it('includes the visible task and chat names without copying event text', async () => {
    const store = useJarvisTaskRunStore.getState();
    store.setAccountScope('account-alpha');
    store.replaceCanonicalForAccount(
      'account-alpha',
      [
        {
          canonical: true,
          runId: 'jrun-alpha',
          chatId: 'chat-alpha',
          status: 'completed',
          goal: 'Polish the Workbench UI',
          userVisibleSummary: 'Done',
          progress: 100,
          activeAgents: [],
          activeTerminals: [],
          updatedAt: new Date(NOW).toISOString(),
          cancellable: false,
          transportRetryAvailable: false,
        },
      ],
      {},
    );
    const runLookup = vi.spyOn(jarvisRunRepo, 'getById').mockResolvedValue({
      accountId: 'account-alpha',
      chatId: 'chat-alpha',
      workspaceId: 'workspace-alpha',
    } as Awaited<ReturnType<typeof jarvisRunRepo.getById>>);
    const lookup = vi
      .spyOn(chatRepo, 'getById')
      .mockResolvedValue({ title: 'Design review', workspace_id: 'workspace-alpha' } as Awaited<
        ReturnType<typeof chatRepo.getById>
      >);
    const workspaceLookup = vi
      .spyOn(workspaceRepo, 'getById')
      .mockResolvedValue({ owner_id: 'account-alpha' } as Awaited<
        ReturnType<typeof workspaceRepo.getById>
      >);
    let listener: (event: JarvisEvent) => void = () => undefined;
    const notify = vi.fn(async () => undefined);
    const stop = startJarvisTaskRunNotifications({
      accountId: 'account-alpha',
      subscribe: (next) => {
        listener = next;
        return () => undefined;
      },
      notify,
    });
    listener(event(1, { status: 'completed' }));
    await vi.waitFor(() => expect(notify).toHaveBeenCalledOnce());
    expect(notify).toHaveBeenCalledWith(
      'Completed: Polish the Workbench UI',
      'Chat: Design review. Open VibeSpace to view the verified result.',
      'completed',
      'jarvis-run:jrun-alpha',
    );
    expect(JSON.stringify(notify.mock.calls)).not.toMatch(
      /PRIVATE EVENT TITLE|PRIVATE SAFE SUMMARY/,
    );
    workspaceLookup.mockResolvedValue({ owner_id: 'account-beta' } as Awaited<
      ReturnType<typeof workspaceRepo.getById>
    >);
    listener(event(2, { status: 'failed' }));
    await vi.waitFor(() => expect(notify).toHaveBeenCalledTimes(2));
    expect(notify).toHaveBeenNthCalledWith(
      2,
      'Failed: Polish the Workbench UI',
      'Open VibeSpace to review the failure and next step.',
      'failed',
      undefined,
    );
    stop();
    runLookup.mockRestore();
    lookup.mockRestore();
    workspaceLookup.mockRestore();
    useJarvisTaskRunStore.getState().clearForTests();
  });

  it('emits generic copy once per canonical run/sequence transition', async () => {
    let listener: (event: JarvisEvent) => void = () => undefined;
    const unsubscribe = vi.fn();
    const notify = vi.fn(
      async (_title: string, _body: string, _status: string, _completionIdentity?: string) =>
        undefined,
    );
    const stop = startJarvisTaskRunNotifications({
      subscribe: (next) => {
        listener = next;
        return unsubscribe;
      },
      notify,
    });

    listener(event(1, { status: 'awaiting_approval' }));
    listener(event(1, { status: 'awaiting_approval' }));
    listener(event(2, { status: 'partial' }));
    listener(event(3, { status: 'completed' }));
    listener(event(4, { status: 'failed' }));
    listener(event(5, { status: 'timed_out' }));
    listener(event(6, { status: 'cancelled' }));

    await vi.waitFor(() => expect(notify).toHaveBeenCalledTimes(6));
    expect(notify.mock.calls.map((call) => call[0])).toEqual([
      'Jarvis task needs approval',
      'Jarvis task needs input',
      'Jarvis task completed',
      'Jarvis task failed',
      'Jarvis task timed out',
      'Jarvis task stopped',
    ]);
    expect(JSON.stringify(notify.mock.calls)).not.toMatch(
      /PRIVATE EVENT TITLE|PRIVATE SAFE SUMMARY/,
    );
    expect(notify.mock.calls[2]?.[3]).toBe('jarvis-run:jrun-alpha');
    expect(notify.mock.calls[3]?.[3]).toBeUndefined();
    expect(notify.mock.calls[5]?.[3]).toBeUndefined();

    stop();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it('does not notify for cancellation intent, signal delivery, handoff, or legacy hydration', async () => {
    let listener: (event: JarvisEvent) => void = () => undefined;
    const notify = vi.fn(async () => undefined);
    const stop = startJarvisTaskRunNotifications({
      subscribe: (next) => {
        listener = next;
        return () => undefined;
      },
      notify,
    });

    listener(event(1, { type: 'warning', status: 'cancellation_requested' }));
    listener(event(2, { type: 'warning', status: 'signal_delivered' }));
    listener(event(3, { type: 'warning', status: 'handoff_pending' }));
    listener(event(4, { type: 'run_state', status: 'running' }));

    await Promise.resolve();
    expect(notify).not.toHaveBeenCalled();
    stop();
  });

  it('never replays an immutable run/sequence transition after later journal traffic', async () => {
    let listener: (event: JarvisEvent) => void = () => undefined;
    const notify = vi.fn();
    const stop = startJarvisTaskRunNotifications({
      subscribe: (next) => {
        listener = next;
        return () => undefined;
      },
      notify,
    });

    for (let seq = 1; seq <= 5_001; seq += 1) {
      listener(event(seq, { status: 'completed' }));
    }
    listener(event(1, { status: 'completed' }));

    expect(notify).toHaveBeenCalledTimes(5_001);
    stop();
  });

  it('reports notification failures without breaking later canonical events', async () => {
    let listener: (event: JarvisEvent) => void = () => undefined;
    const onError = vi.fn();
    const notify = vi
      .fn<(title: string) => Promise<void>>()
      .mockRejectedValueOnce(new Error('native notification unavailable'))
      .mockResolvedValue(undefined);
    const stop = startJarvisTaskRunNotifications({
      subscribe: (next) => {
        listener = next;
        return () => undefined;
      },
      notify,
      onError,
    });

    listener(event(1, { status: 'completed' }));
    listener(event(2, { status: 'failed' }));

    await vi.waitFor(() => expect(onError).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(notify).toHaveBeenCalledTimes(2));
    stop();
  });
});
