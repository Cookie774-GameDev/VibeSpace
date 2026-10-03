import { describe, expect, it, vi } from 'vitest';
const live = vi.hoisted(() => ({
  auth: { workspaceId: 'workspace-a', projectId: 'project-a' },
  identity: { accountId: 'account-a' },
  chat: vi.fn(),
  create: vi.fn(),
}));
vi.mock('@/stores/auth', () => ({ useAuthStore: { getState: () => live.auth } }));
vi.mock('@/lib/accountIdentity', () => ({ getActiveAccountIdentity: () => live.identity }));
vi.mock('@/lib/db/repositories', () => ({ chatRepo: { getById: live.chat } }));
vi.mock('@/features/inspector/milestonesStore', () => ({
  useMilestonesStore: { getState: () => ({ items: [], addMilestone: live.create }) },
}));
import {
  createMilestoneActions,
  validateMilestoneCreateParameters,
  type MilestoneActionScope,
} from './registryMilestones';
const { useMilestonesStore: candidateStore } = await vi.importActual<
  typeof import('@/features/inspector/milestonesStore')
>('@/features/inspector/milestonesStore');
import { createJarvisCapabilitySnapshot } from '@/lib/jarvis/capabilitySnapshot';
import {
  createJarvisActionCatalog,
  DEFAULT_JARVIS_ACTION_REGISTRATIONS,
  isJarvisAutoApprovableRegistration,
} from '@/lib/jarvis/actions/catalog';

const scope: MilestoneActionScope = {
  accountId: 'account-a',
  workspaceId: 'workspace-a',
  projectId: 'project-a',
  requestId: 'request-a',
};
const context = {
  source: 'ai' as const,
  accountId: 'account-a',
  chatId: 'chat-a',
  requestId: 'request-a',
};
function fixture() {
  const rows: {
    id: string;
    title: string;
    description?: string;
    deadlineAt?: number;
    scope: MilestoneActionScope;
  }[] = [];
  const create = vi.fn((title, description, deadlineAt, boundScope) => {
    rows.push({ id: 'milestone-a', title, description, deadlineAt, scope: boundScope });
    return 'milestone-a';
  });
  const deps = {
    resolveScope: vi.fn(async () => scope as MilestoneActionScope | null),
    isScopeCurrent: vi.fn(() => true),
    list: () => rows,
    create,
  };
  return { deps, rows, action: createMilestoneActions(deps)[0]!, create };
}

describe('approved milestone action', () => {
  it('projects the registry-backed capability into the protected snapshot using the production rule', async () => {
    const { getBuiltinAction: candidateBuiltin } = await import('./registry');
    const catalog = createJarvisActionCatalog(DEFAULT_JARVIS_ACTION_REGISTRATIONS);
    const tools = catalog
      .listExposed()
      .filter(
        (registration) =>
          registration.executor.kind === 'builtin' &&
          candidateBuiltin(registration.executor.registryActionId) !== undefined,
      )
      .map((registration) => ({
        id: registration.requiredCapabilities[0],
        state: 'available' as const,
        operations: ['execute'],
        evidenceRef: `registered:${registration.id}:1:boot-fixture`,
        lastVerifiedAt: 100,
      }));
    const snapshot = createJarvisCapabilitySnapshot({
      capturedAt: 101,
      tools,
      plugins: [],
      mcps: [],
      terminals: [],
      agents: [],
      entitlements: { source: 'server', capabilities: [], verifiedAt: 100, expiresAt: 200 },
      actionSchemas: catalog.listExposed(),
    });
    expect(snapshot.tools).toContainEqual(
      expect.objectContaining({
        id: 'milestone.write',
        operations: ['execute'],
        state: 'available',
      }),
    );
    expect(snapshot.actionSchemas).toContainEqual(
      expect.objectContaining({
        id: 'milestone.create',
        requiredCapabilities: ['milestone.write'],
      }),
    );
    expect(candidateBuiltin('milestone.create')?.destructive).toBe(true);
  });
  it('binds production execution to the authenticated chat and rejects account changes', async () => {
    live.auth = { workspaceId: 'workspace-a', projectId: 'project-a' };
    live.identity = { accountId: 'account-a' };
    live.chat.mockResolvedValue({ workspace_id: 'workspace-a', project_id: 'project-a' });
    live.create.mockReset().mockReturnValue('real-ms-id');
    const action = createMilestoneActions()[0]!;
    expect(await action.run({ title: 'Real scope' }, context)).toMatchObject({
      ok: true,
      data: { milestoneId: 'real-ms-id' },
    });
    expect(live.create).toHaveBeenCalledWith(
      'Real scope',
      'milestone',
      undefined,
      undefined,
      scope,
    );
    live.create.mockClear();
    live.chat.mockImplementationOnce(async () => {
      live.identity = { accountId: 'account-b' };
      return { workspace_id: 'workspace-a', project_id: 'project-a' };
    });
    expect(await action.run({ title: 'Wrong account' }, context)).toMatchObject({ ok: false });
    expect(live.create).not.toHaveBeenCalled();
    live.identity = { accountId: 'account-a' };
    live.chat.mockResolvedValueOnce({ workspace_id: 'workspace-a', project_id: 'project-b' });
    expect(await action.run({ title: 'Wrong project' }, context)).toMatchObject({ ok: false });
    expect(live.create).not.toHaveBeenCalled();
  });
  it('exposes the canonical approved action with matching bounded parameters', () => {
    const registration = createJarvisActionCatalog(DEFAULT_JARVIS_ACTION_REGISTRATIONS).resolve(
      'milestone.create',
    )!;
    expect(registration).toMatchObject({
      risk: 'safe-write',
      approval: 'always',
      requiredCapabilities: ['milestone.write'],
      executor: { kind: 'builtin', registryActionId: 'milestone.create' },
      exposeToAI: true,
    });
    const params = { title: ' Milestone ', description: ' Details ', deadlineAt: 1893456000000 };
    expect(registration.validateParameters(params)).toEqual(
      validateMilestoneCreateParameters(params),
    );
    expect(registration.deriveTarget({ accountId: 'account-a', params })).toMatchObject({
      namespace: 'milestone',
    });
    expect(isJarvisAutoApprovableRegistration(registration)).toBe(false);
    expect(() =>
      registration.validateParameters({ title: 'Okay', accountId: 'foreign' }),
    ).toThrow();
    expect(() => registration.validateParameters({ title: 'Okay', deadlineAt: -1 })).toThrow();
  });
  it('persists and reloads actual scoped fields without changing legacy callers', async () => {
    candidateStore.setState({ items: [] });
    const id = candidateStore
      .getState()
      .addMilestone('Scoped', 'milestone', 'Details', 1893456000000, scope);
    const persisted = JSON.parse(localStorage.getItem('jarvis-inspector-milestones-v1') ?? '{}');
    expect(persisted.state.items[0]).toMatchObject({
      id,
      title: 'Scoped',
      scope,
      deadlineAt: 1893456000000,
    });
    candidateStore.setState({ items: [] });
    localStorage.setItem('jarvis-inspector-milestones-v1', JSON.stringify(persisted));
    await candidateStore.persist.rehydrate();
    expect(candidateStore.getState().items[0]).toMatchObject({ id, scope });
    candidateStore.getState().addMilestone('Legacy', 'todo');
    expect(candidateStore.getState().items[0].scope).toBeUndefined();
  });
  it('persists real fields once for the same approved request', async () => {
    const f = fixture();
    const params = {
      title: '  S61 milestone  ',
      description: 'Native fixture',
      deadlineAt: 1893456000000,
    };
    expect(await f.action.run(params, context)).toMatchObject({
      ok: true,
      data: { milestoneId: 'milestone-a' },
    });
    expect(await f.action.run(params, context)).toMatchObject({ ok: true });
    expect(f.create).toHaveBeenCalledTimes(1);
    expect(f.rows[0]).toMatchObject({
      title: 'S61 milestone',
      description: 'Native fixture',
      deadlineAt: 1893456000000,
      scope,
    });
    expect(await f.action.run({ title: 'Changed request' }, context)).toMatchObject({ ok: false });
    expect(f.create).toHaveBeenCalledTimes(1);
  });

  it('refuses missing and changed account/project scope', async () => {
    const f = fixture();
    f.deps.resolveScope.mockResolvedValueOnce(null);
    expect(await f.action.run({ title: 'Milestone' }, context)).toMatchObject({ ok: false });
    f.deps.isScopeCurrent.mockReturnValue(false);
    expect(await f.action.run({ title: 'Milestone' }, context)).toMatchObject({ ok: false });
    expect(f.create).not.toHaveBeenCalled();
  });

  it('does not reuse a milestone from another account or project', async () => {
    const f = fixture();
    f.rows.push({ id: 'other', title: 'Other', scope: { ...scope, accountId: 'account-b' } });
    expect(await f.action.run({ title: 'New' }, context)).toMatchObject({
      ok: true,
      data: { milestoneId: 'milestone-a' },
    });
    expect(f.create).toHaveBeenCalledTimes(1);
  });

  it.each(['before', 'during-scope', 'during-final-probe'] as const)(
    'refuses cancellation %s without mutation',
    async (stage) => {
      const f = fixture();
      const request = new AbortController();
      if (stage === 'before') request.abort();
      if (stage === 'during-scope')
        f.deps.resolveScope.mockImplementationOnce(async () => {
          request.abort();
          return scope;
        });
      let probes = 0;
      await expect(
        f.action.run(
          { title: 'Milestone' },
          {
            ...context,
            signal: request.signal,
            isRequestLive: async () => {
              if (stage === 'during-final-probe' && ++probes === 2) request.abort();
              return true;
            },
          },
        ),
      ).rejects.toMatchObject({ name: 'AbortError' });
      expect(f.create).not.toHaveBeenCalled();
    },
  );

  it.each([
    { title: '' },
    { title: 'x'.repeat(241) },
    { title: 'x\u0000' },
    { title: 'Okay', deadlineAt: NaN },
    { title: 'Okay', deadlineAt: -1 },
    { title: 'Okay', projectId: 'foreign' },
  ])('rejects invalid parameters before scope or mutation', async (params) => {
    const f = fixture();
    expect(await f.action.run(params, context)).toMatchObject({ ok: false });
    expect(f.deps.resolveScope).not.toHaveBeenCalled();
    expect(f.create).not.toHaveBeenCalled();
    expect(() => validateMilestoneCreateParameters(params)).toThrow();
  });
});
