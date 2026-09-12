import { describe, expect, it, vi } from 'vitest';
import type {
  JarvisCapabilityRef,
  JarvisCapabilitySnapshot,
  JarvisEntitlementSnapshot,
} from '@/lib/jarvis/contracts';
import {
  CapabilityAccountUnavailableError,
  createJarvisCapabilitySnapshot,
  createJarvisCapabilitySnapshotProvider,
  JarvisCapabilitySnapshotError,
  type CapabilitySnapshotInput,
} from '@/lib/jarvis/capabilitySnapshot';
import {
  createJarvisActionCatalog,
  DEFAULT_JARVIS_ACTION_REGISTRATIONS,
} from '@/lib/jarvis/actions/catalog';

const entitlement: JarvisEntitlementSnapshot = {
  source: 'server',
  planId: 'verified-plan',
  capabilities: ['kernel.write', 'kernel.read'],
  verifiedAt: 100,
  expiresAt: 200,
};

function ref(
  id: string,
  state: JarvisCapabilityRef['state'],
  evidence = true,
): JarvisCapabilityRef {
  return {
    id,
    state,
    operations: ['write', 'read'],
    ...(evidence ? { evidenceRef: `evidence:${id}`, lastVerifiedAt: 90 } : {}),
  };
}

function input(overrides: Partial<CapabilitySnapshotInput> = {}): CapabilitySnapshotInput {
  return {
    capturedAt: 101,
    tools: [ref('tool-z', 'authenticated'), ref('tool-a', 'connected')],
    plugins: [ref('plugin', 'available')],
    mcps: [ref('mcp', 'degraded')],
    terminals: [ref('terminal', 'unavailable')],
    agents: [ref('agent', 'planned')],
    entitlements: entitlement,
    ...overrides,
  };
}

describe('createJarvisCapabilitySnapshot', () => {
  it('projects exposed action registrations into detached model-safe schemas', () => {
    const catalog = createJarvisActionCatalog(DEFAULT_JARVIS_ACTION_REGISTRATIONS);
    const snapshot = createJarvisCapabilitySnapshot({
      ...input(),
      actionSchemas: catalog.listExposed(),
    } as CapabilitySnapshotInput);
    const schemas = (
      snapshot as JarvisCapabilitySnapshot & {
        actionSchemas: readonly Record<string, unknown>[];
      }
    ).actionSchemas;
    const byId = new Map(schemas.map((schema) => [String(schema.id), schema] as const));

    expect(schemas.map(({ id }) => id)).toEqual([
      'agent.run',
      'canva.autofill_job.read',
      'canva.brand_template.dataset.read',
      'canva.brand_templates.search',
      'canva.design.autofill',
      'canva.design.create',
      'canva.design.read',
      'canva.designs.search',
      'chat.model.switch',
      'creator.start',
      'file.search',
      'files.create',
      'files.edit',
      'files.read',
      'github.commits.recent',
      'github.identity',
      'github.issue.read',
      'github.pull_request.read',
      'github.release.latest',
      'github.repository.read',
      'github.workflows.list',
      'gmail.draft.create',
      'gmail.draft.send',
      'gmail.message.read',
      'gmail.messages.search',
      'gmail.reply_draft.create',
      'gmail.thread.read',
      'google-drive.document.create',
      'google-drive.document.read',
      'google-drive.files.search',
      'mcp.invoke',
      'schedule.create',
      'task.cancel',
      'terminal.create',
      'terminal.run',
      'zapier.action.invoke',
      'zapier.actions.discover',
    ]);
    expect(byId.get('file.search')).toMatchObject({
      id: 'file.search',
      version: 1,
      inputSchema: {
        type: 'object',
        required: ['query'],
        additionalProperties: false,
      },
      risk: 'read-only',
      approval: 'never',
    });
    expect(byId.get('chat.model.switch')).toMatchObject({
      id: 'chat.model.switch',
      inputSchema: {
        required: ['request'],
        additionalProperties: false,
      },
      risk: 'external-side-effect',
      approval: 'always',
    });
    expect(byId.has('terminal.start_cli')).toBe(false);
    expect(byId.has('terminal.send_input')).toBe(false);
    expect(byId.has('terminal.wait_for_output')).toBe(false);
    expect(byId.has('terminal.collect_output')).toBe(false);
    expect(byId.get('github.commits.recent')).toMatchObject({
      id: 'github.commits.recent',
      inputSchema: {
        required: ['owner', 'repository'],
        additionalProperties: false,
      },
      risk: 'read-only',
      approval: 'never',
    });
    expect(byId.get('github.identity')).toMatchObject({
      id: 'github.identity',
      inputSchema: { required: [], additionalProperties: false },
      risk: 'read-only',
      approval: 'never',
    });
    expect(byId.get('github.issue.read')).toMatchObject({
      id: 'github.issue.read',
      inputSchema: {
        required: ['owner', 'repository', 'number'],
        additionalProperties: false,
      },
      risk: 'read-only',
      approval: 'never',
    });
    expect(byId.get('github.pull_request.read')).toMatchObject({
      id: 'github.pull_request.read',
      inputSchema: {
        required: ['owner', 'repository', 'number'],
        additionalProperties: false,
      },
      risk: 'read-only',
      approval: 'never',
    });
    expect(byId.get('github.release.latest')).toMatchObject({
      id: 'github.release.latest',
      inputSchema: {
        required: ['owner', 'repository'],
        additionalProperties: false,
      },
      risk: 'read-only',
      approval: 'never',
    });
    expect(byId.get('github.repository.read')).toMatchObject({
      id: 'github.repository.read',
      inputSchema: {
        required: ['owner', 'repository'],
        additionalProperties: false,
      },
      risk: 'read-only',
      approval: 'never',
    });
    expect(byId.get('github.workflows.list')).toMatchObject({
      id: 'github.workflows.list',
      inputSchema: {
        required: ['owner', 'repository'],
        additionalProperties: false,
      },
      risk: 'read-only',
      approval: 'never',
    });
    expect(
      JSON.stringify(
        [...byId.entries()].filter(([id]) => id.startsWith('github.')).map(([, schema]) => schema),
      ),
    ).not.toMatch(/token|credential|secret/i);
    expect(byId.get('mcp.invoke')).toMatchObject({
      id: 'mcp.invoke',
      inputSchema: {
        required: ['serverId', 'toolName'],
        additionalProperties: false,
      },
      risk: 'external-side-effect',
      approval: 'always',
    });
    for (const schema of schemas) {
      expect(schema).not.toHaveProperty('executor');
      expect(schema).not.toHaveProperty('credentialBindings');
      expect(schema).not.toHaveProperty('validateParameters');
      expect(schema).not.toHaveProperty('deriveTarget');
    }
    expect(Object.isFrozen(schemas)).toBe(true);
    expect(schemas.every(Object.isFrozen)).toBe(true);
  });

  it('rejects secret-bearing catalog text before it can enter the model snapshot', () => {
    const source = createJarvisActionCatalog(DEFAULT_JARVIS_ACTION_REGISTRATIONS).listExposed()[0]!;
    const secretText = `${['CLIENT', 'SECRET'].join('_')}="${['synthetic', 'private', 'value'].join(
      '-',
    )}"`;

    expect(() =>
      createJarvisCapabilitySnapshot({
        ...input(),
        actionSchemas: [{ ...source, description: secretText }],
      }),
    ).toThrow(JarvisCapabilitySnapshotError);
  });

  it('preserves every valid state, exact evidence, and stable id ordering', () => {
    const allStates: JarvisCapabilityRef['state'][] = [
      'available',
      'connected',
      'authenticated',
      'degraded',
      'unavailable',
      'planned',
    ];
    const snapshot = createJarvisCapabilitySnapshot(
      input({
        tools: allStates.map((state, index) => ref(`tool-${5 - index}`, state)).reverse(),
      }),
    );

    expect(snapshot.tools.map((item) => item.id)).toEqual([
      'tool-0',
      'tool-1',
      'tool-2',
      'tool-3',
      'tool-4',
      'tool-5',
    ]);
    expect(new Set(snapshot.tools.map((item) => item.state))).toEqual(new Set(allStates));
    expect(snapshot.tools[0]?.evidenceRef).toBe('evidence:tool-0');
  });

  it('does not promote catalog-only entries to connected or authenticated', () => {
    const snapshot = createJarvisCapabilitySnapshot(
      input({
        tools: [
          ref('catalog-auth', 'authenticated', false),
          ref('catalog-connected', 'connected', false),
          ref('catalog-available', 'available', false),
          ref('catalog-planned', 'planned', false),
        ],
      }),
    );

    expect(snapshot.tools.map(({ id, state }) => ({ id, state }))).toEqual([
      { id: 'catalog-auth', state: 'available' },
      { id: 'catalog-available', state: 'available' },
      { id: 'catalog-connected', state: 'available' },
      { id: 'catalog-planned', state: 'planned' },
    ]);
  });

  it('copies verified entitlements without inference and freezes detached data', () => {
    const caller = input();
    const original = structuredClone(caller);
    const snapshot = createJarvisCapabilitySnapshot(caller);

    expect(caller).toEqual(original);
    expect(snapshot.entitlements).toEqual(entitlement);
    expect(snapshot.entitlements).not.toBe(entitlement);
    expect(snapshot.tools).not.toBe(caller.tools);
    expect(snapshot.tools[0]).not.toBe(caller.tools[0]);
    expect(Object.isFrozen(caller)).toBe(false);
    expect(Object.isFrozen(caller.tools)).toBe(false);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.tools)).toBe(true);
    expect(Object.isFrozen(snapshot.tools[0])).toBe(true);
    expect(Object.isFrozen(snapshot.tools[0]!.operations)).toBe(true);
    expect(Object.isFrozen(snapshot.entitlements)).toBe(true);
    expect(Object.isFrozen(snapshot.entitlements.capabilities)).toBe(true);
  });
});

describe('createJarvisCapabilitySnapshotProvider', () => {
  it('resolves and rechecks the exact active account', async () => {
    const getActiveAccountId = vi.fn(() => 'account-1');
    const resolveInputForActiveAccount = vi.fn(async () => input());
    const provider = createJarvisCapabilitySnapshotProvider({
      getActiveAccountId,
      resolveInputForActiveAccount,
    });

    const snapshot = await provider.getForAccount('account-1');

    expect(resolveInputForActiveAccount).toHaveBeenCalledWith('account-1');
    expect(getActiveAccountId).toHaveBeenCalledTimes(2);
    expect(Object.isFrozen(snapshot)).toBe(true);
  });

  it.each([
    ['signed out', undefined, 'account-1'],
    ['different active account', 'account-2', 'account-1'],
  ])('fails safely when %s before resolution', async (_name, active, requested) => {
    const resolveInputForActiveAccount = vi.fn(async () => input());
    const provider = createJarvisCapabilitySnapshotProvider({
      getActiveAccountId: () => active,
      resolveInputForActiveAccount,
    });

    await expect(provider.getForAccount(requested)).rejects.toMatchObject({
      code: 'capability_account_unavailable',
    });
    expect(resolveInputForActiveAccount).not.toHaveBeenCalled();
  });

  it('fails if the active account changes while capability state resolves', async () => {
    const accounts = ['account-1', 'account-2'];
    const provider = createJarvisCapabilitySnapshotProvider({
      getActiveAccountId: () => accounts.shift(),
      resolveInputForActiveAccount: async () => input(),
    });

    await expect(provider.getForAccount('account-1')).rejects.toBeInstanceOf(
      CapabilityAccountUnavailableError,
    );
  });

  it('never serves one account snapshot to another account', async () => {
    let active = 'account-1';
    const resolveInputForActiveAccount = vi.fn(async (accountId: string) =>
      input({ capturedAt: accountId === 'account-1' ? 1 : 2 }),
    );
    const provider = createJarvisCapabilitySnapshotProvider({
      getActiveAccountId: () => active,
      resolveInputForActiveAccount,
    });

    expect((await provider.getForAccount('account-1')).capturedAt).toBe(1);
    active = 'account-2';
    expect((await provider.getForAccount('account-2')).capturedAt).toBe(2);
    expect(resolveInputForActiveAccount).toHaveBeenCalledTimes(2);
  });
});
