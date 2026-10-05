import { StrictMode } from 'react';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  RelayProjectParticipationHost,
  type RelayVerifiedSubjectSource,
} from './RelayProjectParticipationHost';
import type {
  RelayLeaseView,
  RelayParticipationInput,
  RelayProjectParticipationPort,
} from './relayProjectParticipation';

afterEach(cleanup);
const value: RelayLeaseView = {
  id: '9007199254740993',
  accountEpoch: '1',
  bindingEpoch: '0',
  access: 'ReadOnly',
  status: 'Pending',
  scope: { accountId: 'account-a', projectId: 'original-project', workspaceId: null },
  subject: {
    kind: 'AdeRun',
    run: { runId: 'run-a', providerSessionId: 'session-a', generation: '9007199254740997' },
  },
};
function fixture() {
  let current: RelayParticipationInput = {
    accountId: 'account-a',
    accountEpoch: '1',
    revision: '1',
    authorizationRevision: '1',
    policyRevision: '1',
    leases: [value],
    policy: {
      scope: 'Project',
      excludedProjects: [],
      excludedSessions: [],
      automaticMessages: false,
    },
  };
  const listeners = new Set<() => void>();
  const unsubscribe = vi.fn();
  const source: RelayVerifiedSubjectSource = {
    getSnapshot: () => current,
    subscribe: vi.fn((listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
        unsubscribe();
      };
    }),
  };
  const native = {
    ensureExistingParticipant: vi.fn<RelayProjectParticipationPort['ensureExistingParticipant']>(
      async () => ({
        ok: true,
        lease: { ...value, bindingEpoch: '1', status: 'Joined' },
      }),
    ),
    cancelPending: vi.fn<RelayProjectParticipationPort['cancelPending']>(async () => undefined),
  };
  const authorizeProject = vi.fn(async () => true);
  return {
    source,
    native,
    authorizeProject,
    unsubscribe,
    listeners,
    emit(next: RelayParticipationInput) {
      current = next;
      listeners.forEach((listener) => listener());
    },
    current: () => current,
  };
}
const flush = async () => {
  await act(async () => {
    for (let i = 0; i < 12; i++) await Promise.resolve();
  });
};

describe('unmounted-by-default injected Relay project host', () => {
  it('renders no UI and wires only its injected subject lifetime, not selected chat navigation', async () => {
    const f = fixture();
    const onState = vi.fn();
    const view = render(<RelayProjectParticipationHost {...f} onState={onState} />);
    await flush();
    expect(view.container.innerHTML).toBe('');
    expect(f.native.ensureExistingParticipant).toHaveBeenCalledTimes(1);
    expect(onState.mock.lastCall?.[0].entries[0]).toMatchObject({
      phase: 'joined',
      lease: {
        scope: { projectId: 'original-project', workspaceId: null },
        access: 'ReadOnly',
      },
    });
    act(() => f.emit({ ...f.current(), revision: '2' }));
    await flush();
    expect(f.native.ensureExistingParticipant).toHaveBeenCalledTimes(1);
    view.unmount();
    await flush();
    expect(f.unsubscribe).toHaveBeenCalledTimes(1);
    expect(f.native.cancelPending).toHaveBeenCalledWith(
      expect.objectContaining({
        id: value.id,
        accountEpoch: '1',
        observerId: expect.any(String),
        enrollmentRequestId: expect.any(String),
      }),
    );
  });

  it('does not reuse a disposed coordinator across StrictMode effect replay', async () => {
    const f = fixture();
    const onState = vi.fn();
    const view = render(
      <StrictMode>
        <RelayProjectParticipationHost {...f} onState={onState} />
      </StrictMode>,
    );
    await flush();
    expect(f.source.subscribe).toHaveBeenCalledTimes(2);
    expect(f.listeners.size).toBe(1);
    expect(f.native.ensureExistingParticipant).toHaveBeenCalledTimes(1);
    expect(onState.mock.lastCall?.[0].entries[0]?.phase).toBe('joined');
    view.unmount();
    await flush();
    expect(f.listeners.size).toBe(0);
  });

  it('unsubscribes an asynchronously established listener after disposal and ignores late events', async () => {
    const f = fixture();
    let finish!: (stop: () => void) => void;
    const lateStop = vi.fn();
    let listener!: () => void;
    f.source.subscribe = vi.fn((notify: () => void) => {
      listener = notify;
      return new Promise<() => void>((resolve) => {
        finish = resolve;
      });
    });
    const view = render(<RelayProjectParticipationHost {...f} />);
    view.unmount();
    await act(async () => {
      finish(lateStop);
      listener();
    });
    expect(lateStop).toHaveBeenCalledTimes(1);
    expect(f.native.ensureExistingParticipant).not.toHaveBeenCalled();
  });

  it('replaces injected source/native ownership without allowing the old async authorization to join', async () => {
    const old = fixture();
    const next = fixture();
    let allowOld!: (allowed: boolean) => void;
    old.authorizeProject.mockImplementation(
      () =>
        new Promise((resolve) => {
          allowOld = resolve;
        }),
    );
    const view = render(<RelayProjectParticipationHost {...old} />);
    view.rerender(<RelayProjectParticipationHost {...next} />);
    await act(async () => {
      allowOld(true);
    });
    await flush();
    expect(old.native.ensureExistingParticipant).not.toHaveBeenCalled();
    expect(next.native.ensureExistingParticipant).toHaveBeenCalledTimes(1);
    expect(old.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('releases subscription ownership when the trusted source fails during a later read', async () => {
    const f = fixture();
    render(<RelayProjectParticipationHost {...f} />);
    await flush();
    f.source.getSnapshot = () => {
      throw new Error('synthetic private source detail');
    };
    act(() => f.listeners.forEach((listener) => listener()));
    await flush();
    expect(f.listeners.size).toBe(0);
    expect(f.unsubscribe).toHaveBeenCalledTimes(1);
    expect(f.native.cancelPending).toHaveBeenCalledWith(
      expect.objectContaining({
        id: value.id,
        accountEpoch: '1',
        observerId: expect.any(String),
        enrollmentRequestId: expect.any(String),
      }),
    );
  });

  it('still cancels its pending request when an injected unsubscribe throws', async () => {
    const f = fixture();
    f.unsubscribe.mockImplementation(() => {
      throw new Error('synthetic private cleanup detail');
    });
    const view = render(<RelayProjectParticipationHost {...f} />);
    await flush();
    expect(() => view.unmount()).not.toThrow();
    await flush();
    expect(f.native.cancelPending).toHaveBeenCalledWith(
      expect.objectContaining({
        id: value.id,
        accountEpoch: '1',
        observerId: expect.any(String),
        enrollmentRequestId: expect.any(String),
      }),
    );
  });
  it.each(['joining', 'joined'] as const)(
    'detaches a mounted %s observer and remounts without retiring native membership',
    async (phase) => {
      const f = fixture();
      let admitted = true;
      let committed = phase === 'joined';
      let finishOld!: (
        result: Awaited<ReturnType<RelayProjectParticipationPort['ensureExistingParticipant']>>,
      ) => void;
      let deliverCancel!: () => void;
      const pending = new Promise<
        Awaited<ReturnType<RelayProjectParticipationPort['ensureExistingParticipant']>>
      >((resolve) => {
        finishOld = resolve;
      });
      const delayedCancel = new Promise<void>((resolve) => {
        deliverCancel = resolve;
      });
      const revoke = vi.fn(() => {
        admitted = false;
        committed = false;
      });
      f.native.ensureExistingParticipant.mockImplementation(async () => {
        expect(admitted).toBe(true);
        return { ok: true, lease: { ...value, status: 'Joined', bindingEpoch: '1' } };
      });
      if (phase === 'joining') f.native.ensureExistingParticipant.mockReturnValueOnce(pending);
      f.native.cancelPending.mockImplementation(async () => {
        await delayedCancel;
      });
      const native = { ...f.native, revoke };
      const oldState = vi.fn();
      const first = render(
        <RelayProjectParticipationHost {...f} native={native} onState={oldState} />,
      );
      await flush();
      const firstRequest = f.native.ensureExistingParticipant.mock.calls[0]![0];
      expect(oldState.mock.lastCall?.[0].entries[0]?.phase).toBe(phase);
      first.unmount();
      await flush();
      const oldNotifications = oldState.mock.calls.length;
      committed = true;
      f.emit({
        ...f.current(),
        revision: '2',
        leases: [{ ...value, status: 'Joined', bindingEpoch: '1' }],
      });
      const newState = vi.fn();
      const second = render(
        <RelayProjectParticipationHost {...f} native={native} onState={newState} />,
      );
      await flush();
      const secondRequest = f.native.ensureExistingParticipant.mock.calls[1]![0];
      await act(async () => {
        deliverCancel();
        finishOld({ ok: true, lease: { ...value, status: 'Joined', bindingEpoch: '1' } });
      });
      await flush();
      expect(admitted).toBe(true);
      expect(committed).toBe(true);
      expect(revoke).not.toHaveBeenCalled();
      expect(oldState).toHaveBeenCalledTimes(oldNotifications);
      expect(newState.mock.lastCall?.[0].entries[0]?.phase).toBe('joined');
      expect(firstRequest.observerId).not.toBe(secondRequest.observerId);
      expect(f.native.cancelPending).toHaveBeenCalledExactlyOnceWith({
        id: value.id,
        accountEpoch: '1',
        observerId: firstRequest.observerId,
        enrollmentRequestId: firstRequest.enrollmentRequestId,
      });
      second.unmount();
    },
  );
  it.each(['joining', 'joined'] as const)(
    'replaces a mounted %s observer while keeping cancellation scoped to its old request',
    async (phase) => {
      const f = fixture();
      let complete!: (
        result: Awaited<ReturnType<RelayProjectParticipationPort['ensureExistingParticipant']>>,
      ) => void;
      const pending = new Promise<
        Awaited<ReturnType<RelayProjectParticipationPort['ensureExistingParticipant']>>
      >((resolve) => {
        complete = resolve;
      });
      if (phase === 'joining') f.native.ensureExistingParticipant.mockReturnValueOnce(pending);
      const view = render(<RelayProjectParticipationHost {...f} />);
      await flush();
      const old = f.native.ensureExistingParticipant.mock.calls[0]![0];
      const onState = vi.fn();
      view.rerender(
        <RelayProjectParticipationHost
          {...f}
          authorizeProject={async () => true}
          onState={onState}
        />,
      );
      await flush();
      const next = f.native.ensureExistingParticipant.mock.calls[1]![0];
      await act(async () => {
        complete({ ok: true, lease: { ...value, status: 'Joined', bindingEpoch: '1' } });
      });
      await flush();
      expect(onState.mock.lastCall?.[0].entries[0]?.phase).toBe('joined');
      expect(old.observerId).not.toBe(next.observerId);
      expect(f.native.cancelPending).toHaveBeenCalledExactlyOnceWith({
        id: old.id,
        accountEpoch: old.accountEpoch,
        observerId: old.observerId,
        enrollmentRequestId: old.enrollmentRequestId,
      });
      view.unmount();
    },
  );
});
