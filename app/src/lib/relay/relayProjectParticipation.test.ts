import { describe, expect, it, vi } from 'vitest';
import {
  createRelayProjectParticipationCoordinator,
  type RelayLeaseView,
  type RelayEnrollmentRequest,
  type RelayParticipationInput,
  type RelayProjectParticipationPort,
} from './relayProjectParticipation';

const lease = (overrides: Partial<RelayLeaseView> = {}): RelayLeaseView => ({
  id: '9007199254740993',
  accountEpoch: '1',
  bindingEpoch: '0',
  status: 'Pending',
  access: 'ApprovedTools',
  scope: { accountId: 'account-a', workspaceId: null, projectId: 'project-a' },
  subject: {
    kind: 'ChatRun',
    run: {
      runId: 'run-a',
      providerSessionId: 'provider-a',
      generation: '9007199254740995',
    },
  },
  ...overrides,
});
const input = (
  leases: readonly RelayLeaseView[],
  overrides: Partial<RelayParticipationInput> = {},
): RelayParticipationInput => ({
  accountId: 'account-a',
  accountEpoch: '1',
  revision: '1',
  authorizationRevision: '1',
  policyRevision: '1',
  policy: {
    scope: 'Project',
    excludedProjects: [],
    excludedSessions: [],
    automaticMessages: false,
  },
  leases,
  ...overrides,
});
const joined = (value: RelayLeaseView): RelayLeaseView => ({
  ...value,
  bindingEpoch: (BigInt(value.bindingEpoch) + 1n).toString(),
  status: 'Joined',
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function fixture() {
  let current: RelayParticipationInput;
  const authorizeProject = vi.fn(async () => true);
  const native = {
    ensureExistingParticipant: vi.fn<RelayProjectParticipationPort['ensureExistingParticipant']>(
      async (ref) => ({
        ok: true,
        lease: joined(current.leases.find((value) => value.id === ref.id)!),
      }),
    ),
    cancelPending: vi.fn<RelayProjectParticipationPort['cancelPending']>(async () => undefined),
  };
  const coordinator = createRelayProjectParticipationCoordinator({ native, authorizeProject });
  const update = (value: RelayParticipationInput) => {
    current = value;
    return coordinator.update(value);
  };
  return { native, authorizeProject, coordinator, update };
}
const cancellation = (request: RelayEnrollmentRequest) => ({
  id: request.id,
  accountEpoch: request.accountEpoch,
  observerId: request.observerId,
  enrollmentRequestId: request.enrollmentRequestId,
});
const tick = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

describe('project Relay participation coordinator (injected ports only)', () => {
  it('automatically joins an admitted own-project run using existing identity and lossless native IDs', async () => {
    const f = fixture();
    const value = lease();
    f.update(input([value]));
    await f.coordinator.whenIdle();
    expect(f.native.ensureExistingParticipant).toHaveBeenCalledExactlyOnceWith(
      {
        id: value.id,
        accountEpoch: '1',
        bindingEpoch: '0',
        policyRevision: '1',
        observerId: expect.any(String),
        enrollmentRequestId: expect.any(String),
      },
      expect.any(AbortSignal),
    );
    expect(f.authorizeProject).toHaveBeenCalledWith(value.scope, '1', expect.any(AbortSignal));
    expect(f.coordinator.getSnapshot().entries[0]).toMatchObject({
      phase: 'joined',
      automaticMessages: 'disabled',
      lease: { id: value.id, subject: value.subject },
    });
    // This port exposes membership only, never a prompt, message, tool, or credential operation.
    expect(Object.keys(f.native).sort()).toEqual(['cancelPending', 'ensureExistingParticipant']);
  });

  it('deduplicates identical run/process snapshots and does not rejoin on selected-view navigation', async () => {
    const f = fixture();
    const value = lease();
    f.update(input([value, value]));
    await f.coordinator.whenIdle();
    f.update(input([{ ...value }], { revision: '2' }));
    await f.coordinator.whenIdle();
    expect(f.native.ensureExistingParticipant).toHaveBeenCalledTimes(1);
    expect(f.coordinator.getSnapshot().entries).toHaveLength(1);
    expect(f.coordinator.getSnapshot().entries[0]?.lease.scope.projectId).toBe('project-a');
  });

  it('joins each original project independently even under EntireApp policy', async () => {
    const f = fixture();
    const a = lease();
    const b = lease({
      id: '9007199254740994',
      scope: { ...a.scope, projectId: 'project-b' },
      subject: {
        kind: 'ChatRun',
        run: { runId: 'run-b', providerSessionId: 'provider-b', generation: '2' },
      },
    });
    f.update(
      input([a, b], {
        policy: {
          scope: 'EntireApp',
          excludedProjects: [],
          excludedSessions: [],
          automaticMessages: true,
        },
      }),
    );
    await f.coordinator.whenIdle();
    expect(f.native.ensureExistingParticipant).toHaveBeenCalledTimes(2);
    expect(f.coordinator.getSnapshot().entries.map((entry) => entry.lease.scope.projectId)).toEqual(
      ['project-a', 'project-b'],
    );
    expect(
      f.coordinator
        .getSnapshot()
        .entries.every((entry) => entry.automaticMessages === 'requires-native-authorization'),
    ).toBe(true);
  });

  it.each(['off', 'project', 'session'] as const)(
    'does not enroll when %s policy excludes the admitted subject',
    async (mode) => {
      const f = fixture();
      f.update(
        input([lease()], {
          policy: {
            scope: mode === 'off' ? 'Off' : 'Project',
            excludedProjects: mode === 'project' ? ['project-a'] : [],
            excludedSessions: mode === 'session' ? ['provider-a'] : [],
            automaticMessages: false,
          },
        }),
      );
      await f.coordinator.whenIdle();
      expect(f.native.ensureExistingParticipant).not.toHaveBeenCalled();
      expect(f.authorizeProject).not.toHaveBeenCalled();
      expect(f.coordinator.getSnapshot().entries[0]?.phase).toBe(
        mode === 'off' ? 'off' : 'excluded',
      );
    },
  );

  it('invalidates a pending join synchronously on Off and never publishes its late Joined response', async () => {
    const f = fixture();
    const value = lease();
    const pending =
      deferred<Awaited<ReturnType<RelayProjectParticipationPort['ensureExistingParticipant']>>>();
    f.native.ensureExistingParticipant.mockReturnValueOnce(pending.promise);
    f.update(input([value]));
    await tick();
    const signal = f.native.ensureExistingParticipant.mock.calls[0]![1];
    f.update(
      input([value], {
        revision: '2',
        policyRevision: '2',
        policy: {
          scope: 'Off',
          excludedProjects: [],
          excludedSessions: [],
          automaticMessages: false,
        },
      }),
    );
    expect(signal.aborted).toBe(true);
    expect(f.coordinator.getSnapshot().entries[0]?.phase).toBe('off');
    pending.resolve({ ok: true, lease: joined(value) });
    await f.coordinator.whenIdle();
    expect(f.coordinator.getSnapshot().entries[0]?.phase).toBe('off');
    // Native applied policy invalidates tickets but retains admission for a valid re-enable.
    expect(f.native.cancelPending).toHaveBeenCalledExactlyOnceWith(
      cancellation(f.native.ensureExistingParticipant.mock.calls[0]![0]),
    );
    f.update(input([value], { revision: '3', policyRevision: '3' }));
    await f.coordinator.whenIdle();
    expect(f.native.ensureExistingParticipant).toHaveBeenCalledTimes(2);
    expect(f.coordinator.getSnapshot().entries[0]?.phase).toBe('joined');
  });

  it('denies unauthorized projects and rechecks project authorization after native join', async () => {
    const f = fixture();
    f.authorizeProject.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    f.update(input([lease()]));
    await f.coordinator.whenIdle();
    expect(f.coordinator.getSnapshot().entries[0]?.phase).toBe('denied');
    expect(f.native.cancelPending).toHaveBeenCalledWith(
      cancellation(f.native.ensureExistingParticipant.mock.calls[0]![0]),
    );
    const rejected = fixture();
    rejected.authorizeProject.mockResolvedValue(false);
    rejected.update(input([lease()]));
    await rejected.coordinator.whenIdle();
    expect(rejected.native.ensureExistingParticipant).not.toHaveBeenCalled();
  });

  it('does not revive slow project authorization after account A-B-A or an older epoch replay', async () => {
    const f = fixture();
    const pending = deferred<boolean>();
    f.authorizeProject.mockReturnValueOnce(pending.promise);
    f.update(input([lease()]));
    f.update(input([], { accountId: 'account-b', accountEpoch: '2' }));
    const fresh = lease({ id: '3', accountEpoch: '3' });
    f.update(input([fresh], { accountEpoch: '3' }));
    pending.resolve(true);
    await f.coordinator.whenIdle();
    expect(f.native.ensureExistingParticipant).toHaveBeenCalledTimes(1);
    expect(f.native.ensureExistingParticipant.mock.calls[0]![0]).toMatchObject({
      id: '3',
      accountEpoch: '3',
    });
    expect(f.update(input([lease()], { revision: '9' }))).toBe(false);
    expect(f.coordinator.getSnapshot().accountEpoch).toBe('3');
  });

  it('cancels only removed/replaced process requests and ignores their late native response', async () => {
    const f = fixture();
    const old = lease({
      subject: {
        kind: 'Terminal',
        process: {
          terminalSessionId: 'pty-a',
          paneId: 'pane-a',
          processInstanceId: 'instance-a',
          runtimeGeneration: 'runtime-a',
          pid: 42,
          processStartedAt: '9007199254740997',
        },
      },
    });
    const pending =
      deferred<Awaited<ReturnType<RelayProjectParticipationPort['ensureExistingParticipant']>>>();
    f.native.ensureExistingParticipant.mockReturnValueOnce(pending.promise);
    f.update(input([old]));
    await tick();
    const replacement = lease({
      id: '7',
      subject: {
        kind: 'Terminal',
        process: {
          terminalSessionId: 'pty-a',
          paneId: 'pane-a',
          processInstanceId: 'instance-b',
          runtimeGeneration: 'runtime-b',
          pid: 42,
          processStartedAt: '9007199254740998',
        },
      },
    });
    f.update(input([replacement], { revision: '2' }));
    pending.resolve({ ok: true, lease: joined(old) });
    await f.coordinator.whenIdle();
    expect(f.native.cancelPending).toHaveBeenCalledWith(
      cancellation(f.native.ensureExistingParticipant.mock.calls[0]![0]),
    );
    expect(f.coordinator.getSnapshot().entries).toHaveLength(1);
    expect(f.coordinator.getSnapshot().entries[0]).toMatchObject({
      phase: 'joined',
      lease: { id: '7' },
    });
  });

  it('admits ADE read-only presence and never promotes its automatic-message permission', async () => {
    const f = fixture();
    const value = lease({
      access: 'ReadOnly',
      subject: {
        kind: 'AdeRun',
        run: { runId: 'ade-a', providerSessionId: 'ade-session', generation: '1' },
      },
    });
    f.update(
      input([value], {
        policy: {
          scope: 'Project',
          excludedProjects: [],
          excludedSessions: [],
          automaticMessages: true,
        },
      }),
    );
    await f.coordinator.whenIdle();
    expect(f.coordinator.getSnapshot().entries[0]).toMatchObject({
      phase: 'joined',
      automaticMessages: 'disabled',
      lease: { access: 'ReadOnly' },
    });
    const wrong = fixture();
    wrong.update(input([{ ...value, access: 'ApprovedTools' }]));
    await wrong.coordinator.whenIdle();
    expect(wrong.native.ensureExistingParticipant).not.toHaveBeenCalled();
  });

  it('keeps missing credentials and busy enrollment explicit without a retry/provisioning loop', async () => {
    const f = fixture();
    f.native.ensureExistingParticipant.mockResolvedValueOnce({ ok: false, code: 'SetupRequired' });
    f.update(input([lease()]));
    await f.coordinator.whenIdle();
    expect(f.coordinator.getSnapshot().entries[0]?.phase).toBe('setup-required');
    f.update(input([lease()], { revision: '2' }));
    await f.coordinator.whenIdle();
    expect(f.native.ensureExistingParticipant).toHaveBeenCalledTimes(1);
    const busy = fixture();
    busy.native.ensureExistingParticipant.mockResolvedValueOnce({ ok: false, code: 'Busy' });
    busy.update(input([lease()]));
    await busy.coordinator.whenIdle();
    expect(busy.coordinator.getSnapshot().entries[0]).toMatchObject({
      phase: 'pending',
      error: 'Busy',
    });
  });

  it('rejects foreign or promoted native result metadata instead of publishing it', async () => {
    const f = fixture();
    f.native.ensureExistingParticipant.mockResolvedValueOnce({
      ok: true,
      lease: joined(
        lease({ scope: { accountId: 'account-a', workspaceId: null, projectId: 'foreign' } }),
      ),
    });
    f.update(input([lease()]));
    await f.coordinator.whenIdle();
    expect(f.coordinator.getSnapshot().entries[0]).toMatchObject({
      phase: 'failed',
      error: 'InvalidInput',
    });
    expect(f.native.cancelPending).toHaveBeenCalledWith(
      cancellation(f.native.ensureExistingParticipant.mock.calls[0]![0]),
    );
  });

  it.each([9_007_199_254_740_992, '01', '-1', '18446744073709551616'])(
    'rejects noncanonical/out-of-range native u64 identity %s',
    async (id) => {
      const f = fixture();
      expect(f.update(input([lease({ id: id as string })]))).toBe(false);
      await f.coordinator.whenIdle();
      expect(f.native.ensureExistingParticipant).not.toHaveBeenCalled();
      expect(f.coordinator.getSnapshot().error).toBe('InvalidInput');
    },
  );

  it('rejects stale policy and subject snapshots without undoing a later Off decision', async () => {
    const f = fixture();
    const value = lease();
    f.update(
      input([value], {
        revision: '9007199254740994',
        policyRevision: '2',
        policy: {
          scope: 'Off',
          excludedProjects: [],
          excludedSessions: [],
          automaticMessages: false,
        },
      }),
    );
    expect(f.update(input([value], { revision: '9007199254740993' }))).toBe(false);
    expect(f.update(input([value], { revision: '9007199254740995' }))).toBe(false);
    await f.coordinator.whenIdle();
    expect(f.native.ensureExistingParticipant).not.toHaveBeenCalled();
    expect(f.coordinator.getSnapshot().entries[0]?.phase).toBe('off');
  });

  it('fails closed on duplicate lease IDs with contradictory scopes and never borrows selected chat metadata', async () => {
    const f = fixture();
    expect(
      f.update(
        input([
          lease(),
          lease({ scope: { accountId: 'account-a', workspaceId: null, projectId: 'other' } }),
        ]),
      ),
    ).toBe(false);
    expect(f.native.ensureExistingParticipant).not.toHaveBeenCalled();
    const extra = fixture();
    expect(
      extra.update({ ...input([lease()]), selectedChatId: 'borrowed' } as RelayParticipationInput),
    ).toBe(false);
    expect(extra.native.ensureExistingParticipant).not.toHaveBeenCalled();
  });

  it('disposes without late Joined publication and cancels only its exact pending request', async () => {
    const f = fixture();
    const value = lease();
    const pending =
      deferred<Awaited<ReturnType<RelayProjectParticipationPort['ensureExistingParticipant']>>>();
    f.native.ensureExistingParticipant.mockReturnValueOnce(pending.promise);
    f.update(input([value]));
    await tick();
    f.coordinator.dispose();
    pending.resolve({ ok: true, lease: joined(value) });
    await f.coordinator.whenIdle();
    expect(f.coordinator.getSnapshot().entries).toEqual([]);
    expect(f.native.cancelPending).toHaveBeenCalledWith(
      cancellation(f.native.ensureExistingParticipant.mock.calls[0]![0]),
    );
    expect(f.update(input([value], { revision: '2' }))).toBe(false);
  });

  it('deduplicates semantically identical run fields independent of object key order', async () => {
    const f = fixture();
    const value = lease();
    f.update(input([value]));
    await f.coordinator.whenIdle();
    f.update(
      input(
        [
          lease({
            subject: {
              kind: 'ChatRun',
              run: {
                generation: '9007199254740995',
                providerSessionId: 'provider-a',
                runId: 'run-a',
              },
            },
          }),
        ],
        { revision: '2' },
      ),
    );
    await f.coordinator.whenIdle();
    expect(f.native.ensureExistingParticipant).toHaveBeenCalledTimes(1);
    expect(f.coordinator.getSnapshot().entries[0]?.phase).toBe('joined');
  });

  it('rejects symbol-keyed or extra private metadata at the public lease boundary', () => {
    const privateField = Symbol('native-private-field');
    for (const value of [
      { ...lease(), [privateField]: 'synthetic-not-a-capability' },
      { ...lease(), launchCapability: 'synthetic-not-a-capability' },
    ]) {
      const f = fixture();
      expect(f.update(input([value]))).toBe(false);
      expect(f.native.ensureExistingParticipant).not.toHaveBeenCalled();
    }
  });

  it('rejects a promoted ADE result and never treats membership as write authority', async () => {
    const f = fixture();
    const ade = lease({
      access: 'ReadOnly',
      subject: {
        kind: 'AdeRun',
        run: { runId: 'ade', providerSessionId: 'ade-session', generation: '1' },
      },
    });
    f.native.ensureExistingParticipant.mockResolvedValueOnce({
      ok: true,
      lease: { ...joined(ade), access: 'ApprovedTools' },
    });
    f.update(input([ade]));
    await f.coordinator.whenIdle();
    expect(f.coordinator.getSnapshot().entries[0]).toMatchObject({
      phase: 'failed',
      automaticMessages: 'disabled',
    });
  });

  it('invalidates slow authorization when trusted project access revision changes', async () => {
    const f = fixture();
    const pending = deferred<boolean>();
    f.authorizeProject.mockReturnValueOnce(pending.promise).mockResolvedValue(false);
    f.update(input([lease()]));
    f.update(input([lease()], { revision: '2', authorizationRevision: '2' }));
    pending.resolve(true);
    await f.coordinator.whenIdle();
    expect(f.native.ensureExistingParticipant).not.toHaveBeenCalled();
    expect(f.coordinator.getSnapshot().entries[0]?.phase).toBe('denied');
  });

  it('allows a fresh native expiry observation to retry Busy without inventing cancellation', async () => {
    const f = fixture();
    f.native.ensureExistingParticipant.mockResolvedValueOnce({ ok: false, code: 'Busy' });
    f.update(input([lease()]));
    await f.coordinator.whenIdle();
    f.update(input([lease({ bindingEpoch: '1' })], { revision: '2' }));
    await f.coordinator.whenIdle();
    expect(f.native.ensureExistingParticipant).toHaveBeenCalledTimes(2);
    expect(f.native.cancelPending).toHaveBeenCalledExactlyOnceWith(
      cancellation(f.native.ensureExistingParticipant.mock.calls[0]![0]),
    );
    expect(f.coordinator.getSnapshot().entries[0]).toMatchObject({
      phase: 'joined',
      lease: { bindingEpoch: '2' },
    });
  });

  it('does not cancel a newer re-enabled join when an old Off-invalidated join finally completes', async () => {
    const f = fixture();
    const pending =
      deferred<Awaited<ReturnType<RelayProjectParticipationPort['ensureExistingParticipant']>>>();
    f.native.ensureExistingParticipant.mockReturnValueOnce(pending.promise);
    f.update(input([lease()]));
    await tick();
    f.update(
      input([lease()], {
        revision: '2',
        policyRevision: '2',
        policy: {
          scope: 'Off',
          excludedProjects: [],
          excludedSessions: [],
          automaticMessages: false,
        },
      }),
    );
    f.update(input([lease()], { revision: '3', policyRevision: '3' }));
    await tick();
    await tick();
    pending.resolve({ ok: true, lease: joined(lease()) });
    await f.coordinator.whenIdle();
    expect(f.native.ensureExistingParticipant).toHaveBeenCalledTimes(2);
    expect(f.coordinator.getSnapshot().entries[0]?.phase).toBe('joined');
    expect(f.native.cancelPending).toHaveBeenCalledExactlyOnceWith(
      cancellation(f.native.ensureExistingParticipant.mock.calls[0]![0]),
    );
  });

  it('copies public inputs before awaits and excludes private exception text from observable state', async () => {
    const f = fixture();
    const pending = deferred<boolean>();
    const mutable = lease();
    f.authorizeProject.mockReturnValueOnce(pending.promise);
    f.native.ensureExistingParticipant.mockRejectedValueOnce(
      new Error('synthetic private transport detail'),
    );
    f.update(input([mutable]));
    (mutable.scope as { projectId: string }).projectId = 'mutated-project';
    pending.resolve(true);
    await f.coordinator.whenIdle();
    expect(f.coordinator.getSnapshot().entries[0]).toMatchObject({
      phase: 'failed',
      error: 'PermissionDenied',
      lease: { scope: { projectId: 'project-a' } },
    });
    expect(JSON.stringify(f.coordinator.getSnapshot())).not.toContain(
      'synthetic private transport detail',
    );
  });

  it('surfaces failed pending cancellation without retaining raw errors or blocking local removal', async () => {
    const f = fixture();
    f.update(input([lease()]));
    await f.coordinator.whenIdle();
    f.native.cancelPending.mockRejectedValueOnce(
      new Error('synthetic private cancellation detail'),
    );
    f.update(input([], { revision: '2' }));
    await f.coordinator.whenIdle();
    expect(f.coordinator.getSnapshot()).toMatchObject({
      entries: [],
      error: 'CancelPendingFailed',
    });
    expect(JSON.stringify(f.coordinator.getSnapshot())).not.toContain(
      'synthetic private cancellation detail',
    );
  });

  it.each(['Joining', 'Joined'] as const)(
    'does not cancel/rejoin when its own native %s observation arrives before the request settles',
    async (status) => {
      const f = fixture();
      const value = lease();
      const pending =
        deferred<Awaited<ReturnType<RelayProjectParticipationPort['ensureExistingParticipant']>>>();
      f.native.ensureExistingParticipant.mockReturnValueOnce(pending.promise);
      f.update(input([value]));
      await tick();
      const signal = f.native.ensureExistingParticipant.mock.calls[0]![1];
      f.update(input([{ ...value, bindingEpoch: '1', status }], { revision: '2' }));
      expect(signal.aborted).toBe(false);
      expect(f.native.ensureExistingParticipant).toHaveBeenCalledTimes(1);
      pending.resolve({ ok: true, lease: joined(value) });
      await f.coordinator.whenIdle();
      expect(f.native.ensureExistingParticipant).toHaveBeenCalledTimes(1);
      expect(f.coordinator.getSnapshot().entries[0]).toMatchObject({
        phase: 'joined',
        lease: { bindingEpoch: '1' },
      });
    },
  );

  it('preserves a pending enrollment across a newer identical native policy revision', async () => {
    const f = fixture();
    const pending =
      deferred<Awaited<ReturnType<RelayProjectParticipationPort['ensureExistingParticipant']>>>();
    f.native.ensureExistingParticipant.mockReturnValueOnce(pending.promise);
    f.update(input([lease()]));
    await tick();
    f.update(input([lease()], { revision: '2', policyRevision: '2' }));
    pending.resolve({ ok: true, lease: joined(lease()) });
    await f.coordinator.whenIdle();
    expect(f.native.ensureExistingParticipant).toHaveBeenCalledTimes(1);
    expect(f.coordinator.getSnapshot().entries[0]?.phase).toBe('joined');
  });

  it('rechecks existing-identity setup when the trusted authority readiness revision advances', async () => {
    const f = fixture();
    f.native.ensureExistingParticipant.mockResolvedValueOnce({ ok: false, code: 'SetupRequired' });
    f.update(input([lease()]));
    await f.coordinator.whenIdle();
    expect(f.coordinator.getSnapshot().entries[0]?.phase).toBe('setup-required');
    f.update(input([lease()], { revision: '2', authorizationRevision: '2' }));
    await f.coordinator.whenIdle();
    expect(f.native.ensureExistingParticipant).toHaveBeenCalledTimes(2);
    expect(f.coordinator.getSnapshot().entries[0]?.phase).toBe('joined');
  });
  it('dispatches the latest compatible policy revision after held project authorization', async () => {
    const f = fixture();
    const held = deferred<boolean>();
    f.authorizeProject.mockReturnValueOnce(held.promise);
    f.native.ensureExistingParticipant.mockImplementation(async (request) =>
      request.policyRevision === '2'
        ? { ok: true, lease: joined(lease()) }
        : { ok: false, code: 'StalePolicy' },
    );
    f.update(input([lease()]));
    f.update(input([lease()], { revision: '2', policyRevision: '2' }));
    held.resolve(true);
    await f.coordinator.whenIdle();
    expect(f.native.ensureExistingParticipant).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ policyRevision: '2' }),
      expect.any(AbortSignal),
    );
    expect(f.coordinator.getSnapshot().entries[0]?.phase).toBe('joined');
  });

  it('rejects nonprimitive enums without coercing or exposing private fields', async () => {
    const coerce = vi.fn(() => 'Joined');
    const bad = { toString: coerce, launchCapability: 'synthetic-private-proof-marker' };
    for (const value of [
      input([lease({ status: bad as never, bindingEpoch: '1' })]),
      input([lease()], { policy: { ...input([]).policy, scope: new String('Off') as never } }),
    ]) {
      const f = fixture();
      expect(f.update(value)).toBe(false);
      await f.coordinator.whenIdle();
      expect(f.native.ensureExistingParticipant).not.toHaveBeenCalled();
      expect(JSON.stringify(f.coordinator.getSnapshot())).not.toContain(
        'synthetic-private-proof-marker',
      );
    }
    expect(coerce).not.toHaveBeenCalled();
  });

  it.each(['p\u0081', 'p\u0085', 'é'.repeat(129), '\ud800'])(
    'rejects native-invalid UTF8/control identifier %j',
    async (projectId) => {
      const f = fixture();
      expect(f.update(input([lease({ scope: { ...lease().scope, projectId } })]))).toBe(false);
      await f.coordinator.whenIdle();
      expect(f.authorizeProject).not.toHaveBeenCalled();
      expect(f.native.ensureExistingParticipant).not.toHaveBeenCalled();
    },
  );

  it.each(['é'.repeat(128), 'p\ufeff'])(
    'preserves native-valid identity %j without normalization',
    async (projectId) => {
      const f = fixture();
      expect(f.update(input([lease({ scope: { ...lease().scope, projectId } })]))).toBe(true);
      await f.coordinator.whenIdle();
      expect(f.coordinator.getSnapshot().entries[0]?.lease.scope.projectId).toBe(projectId);
    },
  );

  it.each(['joining', 'joined'] as const)(
    'detaches during %s without retiring a live admission, and a remount adopts native membership',
    async (phase) => {
      const original = lease();
      let admitted = true;
      let membership = phase === 'joined';
      const held =
        deferred<Awaited<ReturnType<RelayProjectParticipationPort['ensureExistingParticipant']>>>();
      const native = {
        ensureExistingParticipant: vi.fn<
          RelayProjectParticipationPort['ensureExistingParticipant']
        >(async () => {
          expect(admitted).toBe(true);
          return membership ? { ok: true, lease: joined(original) } : held.promise;
        }),
        cancelPending: vi.fn<RelayProjectParticipationPort['cancelPending']>(async () => undefined),
        revoke: vi.fn(async () => {
          admitted = false;
          membership = false;
        }),
      };
      const first = createRelayProjectParticipationCoordinator({
        native,
        authorizeProject: async () => true,
      });
      first.update(input([original]));
      await tick();
      const firstRequest = native.ensureExistingParticipant.mock.calls[0]![0];
      first.dispose();
      await tick();
      membership = true;
      const second = createRelayProjectParticipationCoordinator({
        native,
        authorizeProject: async () => true,
      });
      second.update(input([joined(original)]));
      await second.whenIdle();
      const secondRequest = native.ensureExistingParticipant.mock.calls[1]![0];
      held.resolve({ ok: true, lease: joined(original) });
      await first.whenIdle();
      expect(admitted).toBe(true);
      expect(membership).toBe(true);
      expect(native.revoke).not.toHaveBeenCalled();
      expect(native.cancelPending).toHaveBeenCalledExactlyOnceWith(cancellation(firstRequest));
      expect(firstRequest.observerId).not.toBe(secondRequest.observerId);
      expect(firstRequest.enrollmentRequestId).not.toBe(secondRequest.enrollmentRequestId);
      expect(second.getSnapshot().entries[0]?.phase).toBe('joined');
    },
  );

  it('a delayed old cancellation cannot target a newer observer request or committed membership', async () => {
    const heldCancel = deferred<void>();
    const cancellations: RelayEnrollmentRequest[] = [];
    let currentRequest: RelayEnrollmentRequest | undefined;
    let joinedNative = false;
    const native: RelayProjectParticipationPort = {
      ensureExistingParticipant: vi.fn<RelayProjectParticipationPort['ensureExistingParticipant']>(
        async (request) => {
          currentRequest = request;
          joinedNative = true;
          return { ok: true, lease: joined(lease()) };
        },
      ),
      cancelPending: vi.fn(async (reference) => {
        await heldCancel.promise;
        if (
          !joinedNative &&
          currentRequest &&
          currentRequest.observerId === reference.observerId &&
          currentRequest.enrollmentRequestId === reference.enrollmentRequestId
        )
          cancellations.push(currentRequest);
      }),
    };
    const first = createRelayProjectParticipationCoordinator({
      native,
      authorizeProject: async () => true,
    });
    first.update(input([lease()]));
    await first.whenIdle();
    first.dispose();
    const second = createRelayProjectParticipationCoordinator({
      native,
      authorizeProject: async () => true,
    });
    second.update(input([joined(lease())]));
    await second.whenIdle();
    heldCancel.resolve();
    await first.whenIdle();
    expect(cancellations).toEqual([]);
    expect(joinedNative).toBe(true);
    expect(second.getSnapshot().entries[0]?.phase).toBe('joined');
  });
});
