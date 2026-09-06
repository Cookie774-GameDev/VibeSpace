import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderCapabilities, ProviderConnection } from '@/lib/ai/adapters/types';
import {
  activateSyncQueueCloudAuthority,
  cloudSyncQueueClaimKey,
  cloudSyncQueueOwnerKey,
  legacyCloudSyncQueueAuthorityKey,
  parseSyncQueueOwner,
  releaseSyncQueueCloudAuthority,
  type SyncQueueCloudAuthorityLease,
  type SyncQueueOwnerRecordV2,
} from '@/lib/cloudSyncQueueOwner';
import type { Agent } from '@/types/agent';
import type { Chat, Message } from '@/types/chat';
import type { QuickLink, QuickLinkGroup } from '@/types/quick-link';
import type { SyncQueueRow } from './schema';

const state = vi.hoisted(() => ({
  agents: new Map<string, Record<string, unknown>>(),
  chats: new Map<string, Record<string, unknown>>(),
  messages: new Map<string, Record<string, unknown>>(),
  quickLinks: new Map<string, Record<string, unknown>>(),
  quickLinkGroups: new Map<string, Record<string, unknown>>(),
  syncRows: [] as Array<Record<string, unknown>>,
  settings: new Map<string, { key: string; value: unknown; updated_at: number }>(),
  chatUpdateGate: null as Promise<void> | null,
  chatUpdateStarted: false,
  chatReadGate: null as Promise<void> | null,
  chatReadStarted: false,
  messageAddGate: null as Promise<void> | null,
  messageAddStarted: false,
  messageQueueAddGate: null as Promise<void> | null,
  messageQueueAddStarted: false,
  localTransactionCompletionGate: null as Promise<void> | null,
  localTransactionCompletionStarted: false,
  failSettingsPut: false,
  settingsMutationStarted: false,
}));

vi.mock('./database', () => ({
  db: {
    agents: {
      async add(row: Record<string, unknown>) {
        state.agents.set(row.id as string, { ...row });
      },
      async get(id: string) {
        return state.agents.get(id);
      },
      async put(row: Record<string, unknown>) {
        state.agents.set(row.id as string, { ...row });
      },
      async delete(id: string) {
        state.agents.delete(id);
      },
      async toArray() {
        return [...state.agents.values()].map((row) => ({ ...row }));
      },
      where(index: string) {
        return {
          equals(value: unknown) {
            return {
              async first() {
                return [...state.agents.values()].find((row) => row[index] === value);
              },
            };
          },
        };
      },
    },
    chats: {
      async add(row: Record<string, unknown>) {
        state.chats.set(row.id as string, { ...row });
      },
      async get(id: string) {
        const row = state.chats.get(id);
        const gate = state.chatReadGate;
        if (gate) {
          state.chatReadGate = null;
          state.chatReadStarted = true;
          await gate;
        }
        return row;
      },
      async update(id: string, patch: Record<string, unknown>) {
        if (state.chatUpdateGate) {
          state.chatUpdateStarted = true;
          await state.chatUpdateGate;
        }
        const row = state.chats.get(id);
        if (!row) return 0;
        state.chats.set(id, { ...row, ...patch });
        return 1;
      },
    },
    messages: {
      async add(row: Record<string, unknown>) {
        if (state.messageAddGate) {
          state.messageAddStarted = true;
          await state.messageAddGate;
        }
        state.messages.set(row.id as string, { ...row });
      },
    },
    quick_links: {
      async get(id: string) {
        return state.quickLinks.get(id);
      },
      async add(row: Record<string, unknown>) {
        state.quickLinks.set(row.id as string, { ...row });
      },
      async update(id: string, patch: Record<string, unknown>) {
        const row = state.quickLinks.get(id);
        if (!row) return 0;
        state.quickLinks.set(id, { ...row, ...patch });
        return 1;
      },
      where(index: string) {
        return {
          equals(value: unknown) {
            const matching = () =>
              [...state.quickLinks.values()].filter((row) => row[index] === value);
            return {
              async toArray() {
                return matching().map((row) => ({ ...row }));
              },
              async modify(patch: Record<string, unknown>) {
                for (const row of matching()) {
                  state.quickLinks.set(row.id as string, { ...row, ...patch });
                }
              },
            };
          },
        };
      },
    },
    quick_link_groups: {
      async get(id: string) {
        return state.quickLinkGroups.get(id);
      },
      async add(row: Record<string, unknown>) {
        state.quickLinkGroups.set(row.id as string, { ...row });
      },
      async update(id: string, patch: Record<string, unknown>) {
        const row = state.quickLinkGroups.get(id);
        if (!row) return 0;
        state.quickLinkGroups.set(id, { ...row, ...patch });
        return 1;
      },
      async delete(id: string) {
        state.quickLinkGroups.delete(id);
      },
    },
    sync_queue: {
      where() {
        return {
          equals(status: string) {
            return {
              filter(predicate: (row: Record<string, unknown>) => boolean) {
                return {
                  async toArray() {
                    return state.syncRows.filter((row) => row.status === status && predicate(row));
                  },
                };
              },
            };
          },
        };
      },
      async add(row: Record<string, unknown>) {
        const gate = row.table === 'messages' ? state.messageQueueAddGate : null;
        if (gate) {
          state.messageQueueAddGate = null;
          state.messageQueueAddStarted = true;
          await gate;
        }
        state.syncRows.push({ ...row });
      },
      async update(id: string, patch: Record<string, unknown>) {
        const row = state.syncRows.find((candidate) => candidate.id === id);
        if (row) Object.assign(row, patch);
      },
      async delete(id: string) {
        const index = state.syncRows.findIndex((candidate) => candidate.id === id);
        if (index >= 0) state.syncRows.splice(index, 1);
      },
    },
    settings: {
      async get(key: string) {
        state.settingsMutationStarted = true;
        return state.settings.get(key);
      },
      async put(row: { key: string; value: unknown; updated_at: number }) {
        state.settingsMutationStarted = true;
        if (state.failSettingsPut) throw new Error('owner sidecar write failed');
        state.settings.set(row.key, { ...row });
      },
      async delete(key: string) {
        state.settingsMutationStarted = true;
        state.settings.delete(key);
      },
    },
    async transaction(...args: unknown[]) {
      const body = args.at(-1);
      if (typeof body !== 'function') throw new Error('missing transaction body');
      const agentsBefore = structuredClone([...state.agents.entries()]);
      const chatsBefore = structuredClone([...state.chats.entries()]);
      const messagesBefore = structuredClone([...state.messages.entries()]);
      const quickLinksBefore = structuredClone([...state.quickLinks.entries()]);
      const quickLinkGroupsBefore = structuredClone([...state.quickLinkGroups.entries()]);
      const syncRowsBefore = structuredClone(state.syncRows);
      const settingsBefore = structuredClone([...state.settings.entries()]);
      try {
        const result = await body();
        const gate = args.length === 4 ? state.localTransactionCompletionGate : null;
        if (gate) {
          state.localTransactionCompletionGate = null;
          state.localTransactionCompletionStarted = true;
          await gate;
        }
        return result;
      } catch (error) {
        state.agents.clear();
        for (const [key, row] of agentsBefore) state.agents.set(key, row);
        state.chats.clear();
        for (const [key, row] of chatsBefore) state.chats.set(key, row);
        state.messages.clear();
        for (const [key, row] of messagesBefore) state.messages.set(key, row);
        state.quickLinks.clear();
        for (const [key, row] of quickLinksBefore) state.quickLinks.set(key, row);
        state.quickLinkGroups.clear();
        for (const [key, row] of quickLinkGroupsBefore) state.quickLinkGroups.set(key, row);
        state.syncRows.splice(0, state.syncRows.length, ...syncRowsBefore);
        state.settings.clear();
        for (const [key, row] of settingsBefore) state.settings.set(key, row);
        throw error;
      }
    },
  },
}));

import {
  agentRepo,
  chatRepo,
  messageRepo,
  quickLinkGroupRepo,
  quickLinkRepo,
  settingsRepo,
} from './repositories';

const activeLeases: SyncQueueCloudAuthorityLease[] = [];

function activate(userId: string): SyncQueueCloudAuthorityLease {
  const lease = activateSyncQueueCloudAuthority(userId);
  activeLeases.push(lease);
  return lease;
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function ownerFor(row: Record<string, unknown>): SyncQueueOwnerRecordV2 | null {
  const rowId = String(row.id);
  return parseSyncQueueOwner(rowId, state.settings.get(cloudSyncQueueOwnerKey(rowId))?.value);
}

function seedChat(id: Chat['id'], title = 'Seeded chat'): void {
  state.chats.set(id, {
    id,
    workspace_id: 'wsp_test' as Chat['workspace_id'],
    title,
    mode: 'chat',
    active_agent_ids: [],
    connection: codexConnection,
    created_at: 1,
    updated_at: 1,
  } satisfies Chat);
}

function agentInput(
  id: Agent['id'],
  overrides: Partial<Pick<Agent, 'builtin' | 'name' | 'slug' | 'system_prompt'>> = {},
): Parameters<typeof agentRepo.create>[0] {
  return {
    id,
    slug: 'assistant',
    name: 'Assistant',
    description: 'Test agent',
    system_prompt: 'ordinary prompt',
    model: { provider: 'openai', model: 'gpt-test' },
    tools_allowed: ['*'],
    memory_scope: 'workspace',
    capabilities: ['planning'],
    builtin: false,
    ...overrides,
  };
}

function seedAgent(
  id: Agent['id'],
  overrides: Partial<Pick<Agent, 'builtin' | 'name' | 'slug' | 'system_prompt'>> = {},
): Agent {
  const row = {
    ...agentInput(id, overrides),
    created_at: 1,
    updated_at: 1,
  } as Agent;
  state.agents.set(id, { ...row });
  return row;
}

function seedQuickLinkGroup(id: QuickLinkGroup['id']): QuickLinkGroup {
  const row = {
    id,
    workspace_id: 'wsp_test' as QuickLinkGroup['workspace_id'],
    name: 'Group',
    position: 0,
    created_at: 1,
    updated_at: 1,
  } satisfies QuickLinkGroup;
  state.quickLinkGroups.set(id, { ...row });
  return row;
}

function seedQuickLink(id: QuickLink['id'], groupId: QuickLinkGroup['id']): QuickLink {
  const row = {
    id,
    workspace_id: 'wsp_test' as QuickLink['workspace_id'],
    group_id: groupId,
    label: 'Older link',
    url: 'https://example.com',
    kind: 'web',
    behavior: 'external_browser',
    position: 0,
    tags: [],
    created_at: 1,
    updated_at: 1,
  } satisfies QuickLink;
  state.quickLinks.set(id, { ...row });
  return row;
}

const capabilities: ProviderCapabilities = {
  text: true,
  images: false,
  files: false,
  tools: true,
  modelSelection: true,
  structuredOutput: true,
  streaming: true,
  cancellation: true,
  resumeSession: true,
  systemPrompt: true,
  workingDirectory: true,
  usage: true,
  subscriptionQuota: true,
  localOnly: true,
};

const codexConnection: ProviderConnection = {
  id: 'openai-codex',
  adapterId: 'codex-cli',
  providerId: 'openai',
  displayName: 'OpenAI Codex subscription',
  mode: 'external-cli',
  authSource: 'codex-cli-login',
  modelId: 'gpt-5.2-codex',
  capabilities,
  promptTransport: 'prefixed-preamble',
  enabled: true,
};

const localConnection: ProviderConnection = {
  ...codexConnection,
  id: 'ollama-local',
  adapterId: 'ollama',
  providerId: 'ollama',
  displayName: 'Ollama local',
  mode: 'local',
  authSource: 'none',
  modelId: 'llama3.2',
  promptTransport: 'native-system',
};

describe('chat repository connections and queue ownership', () => {
  beforeEach(() => {
    state.agents.clear();
    state.chats.clear();
    state.messages.clear();
    state.quickLinks.clear();
    state.quickLinkGroups.clear();
    state.syncRows.length = 0;
    state.settings.clear();
    state.chatUpdateGate = null;
    state.chatUpdateStarted = false;
    state.chatReadGate = null;
    state.chatReadStarted = false;
    state.messageAddGate = null;
    state.messageAddStarted = false;
    state.messageQueueAddGate = null;
    state.messageQueueAddStarted = false;
    state.localTransactionCompletionGate = null;
    state.localTransactionCompletionStarted = false;
    state.failSettingsPut = false;
    state.settingsMutationStarted = false;
  });

  afterEach(() => {
    state.chatUpdateGate = null;
    state.chatReadGate = null;
    state.messageAddGate = null;
    state.messageQueueAddGate = null;
    state.localTransactionCompletionGate = null;
    for (const lease of activeLeases.splice(0).reverse()) {
      releaseSyncQueueCloudAuthority(lease);
    }
    vi.restoreAllMocks();
  });

  it('round-trips the exact selected connection through local create and update', async () => {
    const created = await chatRepo.create({
      id: 'cht_connection' as Chat['id'],
      workspace_id: 'wsp_test' as Chat['workspace_id'],
      title: 'CLI chat',
      mode: 'chat',
      active_agent_ids: [],
      connection: codexConnection,
      backend_affinity: { version: 1, backend: 'codex', locked: false, selectedAt: 1 },
    });

    expect(created.connection).toEqual(codexConnection);
    expect(created.backend_affinity?.backend).toBe('codex');
    expect((await chatRepo.getById(created.id))?.connection).toEqual(codexConnection);

    const updated = await chatRepo.update(created.id, { connection: localConnection });
    expect(updated.connection).toEqual(localConnection);
    expect((await chatRepo.getById(created.id))?.connection).toEqual(localConnection);
    expect((await chatRepo.getById(created.id))?.backend_affinity?.backend).toBe('codex');
  });

  it('omits the local connection from cloud sync payload serialization', async () => {
    await chatRepo.create({
      id: 'cht_sync' as Chat['id'],
      workspace_id: 'wsp_test' as Chat['workspace_id'],
      title: 'Local-only connection',
      mode: 'chat',
      active_agent_ids: [],
      connection: codexConnection,
    });

    expect(state.syncRows).toHaveLength(1);
    const queued = state.syncRows[0] as unknown as SyncQueueRow;
    expect(queued.table).toBe('chats');
    expect(queued.payload).not.toHaveProperty('connection');
  });

  it('omits the protected built-in JARVIS prompt when queueing agent creation', async () => {
    const id = 'agt_builtin_jarvis' as Agent['id'];
    const systemPrompt = 'protected local identity prompt';

    const created = await agentRepo.create(
      agentInput(id, {
        slug: 'jarvis',
        name: 'JARVIS',
        builtin: true,
        system_prompt: systemPrompt,
      }),
    );

    expect(created.system_prompt).toBe(systemPrompt);
    expect(state.agents.get(id)?.system_prompt).toBe(systemPrompt);
    expect(state.syncRows).toHaveLength(1);
    expect(state.syncRows[0]).toMatchObject({ table: 'agents', row_id: id });
    expect(state.syncRows[0]!.payload).not.toHaveProperty('system_prompt');
  });

  it('omits the protected built-in JARVIS prompt when queueing agent updates', async () => {
    const id = 'agt_builtin_jarvis' as Agent['id'];
    seedAgent(id, {
      slug: 'jarvis',
      name: 'JARVIS',
      builtin: true,
      system_prompt: 'old protected prompt',
    });

    const updated = await agentRepo.update(id, {
      system_prompt: 'new protected prompt',
    });

    expect(updated.system_prompt).toBe('new protected prompt');
    expect(state.agents.get(id)?.system_prompt).toBe('new protected prompt');
    expect(state.syncRows).toHaveLength(1);
    expect(state.syncRows[0]!.payload).not.toHaveProperty('system_prompt');
  });

  it('keeps protected builtin immutable and omits its prompt from later updates', async () => {
    const id = 'agt_builtin_jarvis' as Agent['id'];
    seedAgent(id, {
      slug: 'jarvis',
      name: 'JARVIS',
      builtin: true,
      system_prompt: 'protected prompt before builtin downgrade',
    });

    const downgraded = await agentRepo.update(id, { builtin: false });
    expect(state.syncRows).toHaveLength(1);
    expect(state.syncRows[0]!.payload).not.toHaveProperty('system_prompt');
    const updated = await agentRepo.update(id, { name: 'JARVIS after builtin downgrade attempt' });

    expect(downgraded).toMatchObject({ builtin: true, slug: 'jarvis' });
    expect(updated).toMatchObject({
      builtin: true,
      slug: 'jarvis',
      name: 'JARVIS after builtin downgrade attempt',
    });
    expect(state.agents.get(id)).toMatchObject({ builtin: true, slug: 'jarvis' });
    expect(state.syncRows).toHaveLength(1);
    for (const row of state.syncRows) {
      expect(row.payload).not.toHaveProperty('system_prompt');
    }
  });

  it('keeps protected slug immutable and omits its prompt from later updates', async () => {
    const id = 'agt_builtin_jarvis' as Agent['id'];
    seedAgent(id, {
      slug: 'jarvis',
      name: 'JARVIS',
      builtin: true,
      system_prompt: 'protected prompt before slug downgrade',
    });

    const downgraded = await agentRepo.update(id, { slug: 'former-jarvis' });
    expect(state.syncRows).toHaveLength(1);
    expect(state.syncRows[0]!.payload).not.toHaveProperty('system_prompt');
    const updated = await agentRepo.update(id, { name: 'JARVIS after slug downgrade attempt' });

    expect(downgraded).toMatchObject({ builtin: true, slug: 'jarvis' });
    expect(updated).toMatchObject({
      builtin: true,
      slug: 'jarvis',
      name: 'JARVIS after slug downgrade attempt',
    });
    expect(state.agents.get(id)).toMatchObject({ builtin: true, slug: 'jarvis' });
    expect(state.syncRows).toHaveLength(1);
    for (const row of state.syncRows) {
      expect(row.payload).not.toHaveProperty('system_prompt');
    }
  });

  it('retains the prompt for a user-created agent whose slug collides with jarvis', async () => {
    const id = 'agt_user_jarvis' as Agent['id'];

    await agentRepo.create(
      agentInput(id, {
        slug: 'jarvis',
        name: 'User JARVIS',
        builtin: false,
        system_prompt: 'ordinary user-authored prompt',
      }),
    );

    expect(state.syncRows).toHaveLength(1);
    expect(state.syncRows[0]!.payload).toMatchObject({
      slug: 'jarvis',
      builtin: false,
      system_prompt: 'ordinary user-authored prompt',
    });

    state.syncRows.length = 0;
    const updated = await agentRepo.update(id, {
      name: 'Updated User JARVIS',
      slug: 'renamed-user-jarvis',
    });
    expect(updated.slug).toBe('renamed-user-jarvis');
    expect(state.syncRows).toHaveLength(1);
    expect(state.syncRows[0]!.payload).toMatchObject({
      slug: 'renamed-user-jarvis',
      builtin: false,
      system_prompt: 'ordinary user-authored prompt',
    });
  });

  it('captures user A before a deferred public update and keeps that owner after switching to B', async () => {
    const id = 'cht_deferred_owner' as Chat['id'];
    seedChat(id);
    activate('user-a');
    const gate = deferred();
    state.chatUpdateGate = gate.promise;

    const update = chatRepo.update(id, { title: 'Updated by A' });
    await vi.waitFor(() => expect(state.chatUpdateStarted).toBe(true));
    activate('user-b');
    gate.resolve();
    await update;

    expect(state.syncRows).toHaveLength(1);
    expect(ownerFor(state.syncRows[0]!)).toMatchObject({
      state: 'cloud',
      userId: 'user-a',
    });
  });

  it('coalesces consecutive mutations from the same cloud owner', async () => {
    activate('user-a');
    const created = await chatRepo.create({
      id: 'cht_same_owner' as Chat['id'],
      workspace_id: 'wsp_test' as Chat['workspace_id'],
      title: 'First title',
      mode: 'chat',
      active_agent_ids: [],
      connection: codexConnection,
    });

    await chatRepo.update(created.id, { title: 'Second title' });

    expect(state.syncRows).toHaveLength(1);
    expect(state.syncRows[0]).toMatchObject({ op: 'insert', status: 'pending' });
    expect(state.syncRows[0]!.payload).toMatchObject({ title: 'Second title' });
    expect(ownerFor(state.syncRows[0]!)).toMatchObject({
      state: 'cloud',
      userId: 'user-a',
    });
  });

  it('preserves every pending claim candidate while clean same-owner rows coalesce', async () => {
    const id = 'cht_claim_boundary' as Chat['id'];
    const claimedId = 'syq_claimed_pending';
    const cleanId = 'syq_clean_pending';
    seedChat(id, 'Before');
    state.syncRows.push(
      {
        id: claimedId,
        op: 'update',
        table: 'chats',
        row_id: id,
        payload: {
          id,
          title: 'Claimed payload must never be adopted',
          updated_at: Number.MAX_SAFE_INTEGER,
        },
        status: 'pending',
        created_at: 20,
      },
      {
        id: cleanId,
        op: 'update',
        table: 'chats',
        row_id: id,
        payload: { id, title: 'Clean prior payload', updated_at: 2 },
        status: 'pending',
        created_at: 10,
      },
    );
    for (const rowId of [claimedId, cleanId]) {
      state.settings.set(cloudSyncQueueOwnerKey(rowId), {
        key: cloudSyncQueueOwnerKey(rowId),
        value: {
          schemaVersion: 2,
          rowId,
          state: 'cloud',
          userId: 'user-a',
          capturedAt: 1,
        },
        updated_at: 1,
      });
    }
    state.settings.set(cloudSyncQueueClaimKey(claimedId), {
      key: cloudSyncQueueClaimKey(claimedId),
      value: { forensic: 'any claim metadata excludes this pending row' },
      updated_at: 20,
    });
    const claimedRowBefore = structuredClone(state.syncRows[0]);
    const claimedOwnerBefore = structuredClone(
      state.settings.get(cloudSyncQueueOwnerKey(claimedId)),
    );
    const claimBefore = structuredClone(state.settings.get(cloudSyncQueueClaimKey(claimedId)));
    activate('user-a');

    await chatRepo.update(id, { title: 'Incoming trusted payload' });

    expect(state.syncRows).toHaveLength(2);
    expect(state.syncRows.find((row) => row.id === claimedId)).toEqual(claimedRowBefore);
    expect(state.settings.get(cloudSyncQueueOwnerKey(claimedId))).toEqual(claimedOwnerBefore);
    expect(state.settings.get(cloudSyncQueueClaimKey(claimedId))).toEqual(claimBefore);
    expect(state.syncRows.find((row) => row.id === cleanId)).toMatchObject({
      op: 'update',
      status: 'pending',
      payload: expect.objectContaining({ title: 'Incoming trusted payload' }),
    });
    expect(
      state.syncRows.some(
        (row) =>
          row.id !== claimedId &&
          (row.payload as Record<string, unknown>).title ===
            'Claimed payload must never be adopted',
      ),
    ).toBe(false);
  });

  it('preserves pending legacy V1 evidence even when the V2 owner is coalescible', async () => {
    const id = 'cht_legacy_evidence_boundary' as Chat['id'];
    const legacyId = 'syq_legacy_evidence_pending';
    const cleanId = 'syq_clean_legacy_neighbor';
    seedChat(id, 'Before');
    state.syncRows.push(
      {
        id: legacyId,
        op: 'update',
        table: 'chats',
        row_id: id,
        payload: {
          id,
          title: 'Legacy payload must never be adopted',
          updated_at: Number.MAX_SAFE_INTEGER,
        },
        status: 'pending',
        created_at: 20,
      },
      {
        id: cleanId,
        op: 'update',
        table: 'chats',
        row_id: id,
        payload: { id, title: 'Clean prior payload', updated_at: 2 },
        status: 'pending',
        created_at: 10,
      },
    );
    for (const rowId of [legacyId, cleanId]) {
      state.settings.set(cloudSyncQueueOwnerKey(rowId), {
        key: cloudSyncQueueOwnerKey(rowId),
        value: {
          schemaVersion: 2,
          rowId,
          state: 'cloud',
          userId: 'user-a',
          capturedAt: 1,
        },
        updated_at: 1,
      });
    }
    state.settings.set(legacyCloudSyncQueueAuthorityKey(legacyId), {
      key: legacyCloudSyncQueueAuthorityKey(legacyId),
      value: { schemaVersion: 1, accountId: 'user-a' },
      updated_at: 20,
    });
    const legacyRowBefore = structuredClone(state.syncRows[0]);
    const ownerBefore = structuredClone(state.settings.get(cloudSyncQueueOwnerKey(legacyId)));
    const legacyEvidenceBefore = structuredClone(
      state.settings.get(legacyCloudSyncQueueAuthorityKey(legacyId)),
    );
    activate('user-a');

    await chatRepo.update(id, { title: 'Incoming trusted payload' });

    expect(state.syncRows).toHaveLength(2);
    expect(state.syncRows.find((row) => row.id === legacyId)).toEqual(legacyRowBefore);
    expect(state.settings.get(cloudSyncQueueOwnerKey(legacyId))).toEqual(ownerBefore);
    expect(state.settings.get(legacyCloudSyncQueueAuthorityKey(legacyId))).toEqual(
      legacyEvidenceBefore,
    );
    expect(state.syncRows.find((row) => row.id === cleanId)).toMatchObject({
      op: 'update',
      status: 'pending',
      payload: expect.objectContaining({ title: 'Incoming trusted payload' }),
    });
    expect(
      state.syncRows.some(
        (row) =>
          row.id !== legacyId &&
          (row.payload as Record<string, unknown>).title === 'Legacy payload must never be adopted',
      ),
    ).toBe(false);
  });

  it('keeps separate pending rows when user B mutates a row already queued by user A', async () => {
    activate('user-a');
    const created = await chatRepo.create({
      id: 'cht_owner_boundary' as Chat['id'],
      workspace_id: 'wsp_test' as Chat['workspace_id'],
      title: 'User A title',
      mode: 'chat',
      active_agent_ids: [],
      connection: codexConnection,
    });

    activate('user-b');
    await chatRepo.update(created.id, { title: 'User B title' });

    expect(state.syncRows).toHaveLength(2);
    expect((state.syncRows[0]!.payload as Record<string, unknown>).title).toBe('User A title');
    expect((state.syncRows[1]!.payload as Record<string, unknown>).title).toBe('User B title');
    expect(ownerFor(state.syncRows[0]!)).toMatchObject({ state: 'cloud', userId: 'user-a' });
    expect(ownerFor(state.syncRows[1]!)).toMatchObject({ state: 'cloud', userId: 'user-b' });
  });

  it('does not coalesce an explicit unbound mutation into a later cloud mutation', async () => {
    const created = await chatRepo.create({
      id: 'cht_unbound_boundary' as Chat['id'],
      workspace_id: 'wsp_test' as Chat['workspace_id'],
      title: 'Unbound title',
      mode: 'chat',
      active_agent_ids: [],
      connection: codexConnection,
    });

    activate('user-a');
    await chatRepo.update(created.id, { title: 'Cloud title' });

    expect(state.syncRows).toHaveLength(2);
    expect(ownerFor(state.syncRows[0]!)).toMatchObject({ state: 'unbound' });
    expect(ownerFor(state.syncRows[1]!)).toMatchObject({ state: 'cloud', userId: 'user-a' });
  });

  it.each([
    ['legacy v1 only', 'legacy'],
    ['malformed v2', 'malformed'],
  ] as const)('never coalesces with a %s pending owner sidecar', async (_label, kind) => {
    const id = 'cht_untrusted_owner' as Chat['id'];
    const pendingId = `syq_${kind}`;
    seedChat(id, 'Before');
    state.syncRows.push({
      id: pendingId,
      op: 'update',
      table: 'chats',
      row_id: id,
      payload: { id, title: 'Untrusted payload' },
      status: 'pending',
      created_at: 1,
    });
    if (kind === 'legacy') {
      state.settings.set(legacyCloudSyncQueueAuthorityKey(pendingId), {
        key: legacyCloudSyncQueueAuthorityKey(pendingId),
        value: { accountId: 'user-a' },
        updated_at: 1,
      });
    } else {
      state.settings.set(cloudSyncQueueOwnerKey(pendingId), {
        key: cloudSyncQueueOwnerKey(pendingId),
        value: { schemaVersion: 2, rowId: pendingId, state: 'cloud' },
        updated_at: 1,
      });
    }
    activate('user-a');

    await chatRepo.update(id, { title: 'Trusted payload' });

    expect(state.syncRows).toHaveLength(2);
    expect(state.syncRows[0]!.payload).toMatchObject({ title: 'Untrusted payload' });
    expect(ownerFor(state.syncRows[1]!)).toMatchObject({ state: 'cloud', userId: 'user-a' });
  });

  it('rolls back a queue row when its owner sidecar fails while preserving the local mutation', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    activate('user-a');
    state.failSettingsPut = true;

    const created = await chatRepo.create({
      id: 'cht_atomic_queue' as Chat['id'],
      workspace_id: 'wsp_test' as Chat['workspace_id'],
      title: 'Local mutation survives',
      mode: 'chat',
      active_agent_ids: [],
      connection: codexConnection,
    });

    expect(await chatRepo.getById(created.id)).toMatchObject({ title: 'Local mutation survives' });
    expect(state.syncRows).toHaveLength(0);
    expect(state.settings).toHaveLength(0);
    expect(warning).toHaveBeenCalledWith(
      '[sync] failed to enqueue local mutation',
      expect.objectContaining({
        table: 'chats',
        rowId: created.id,
        op: 'insert',
        err: expect.objectContaining({ message: 'owner sidecar write failed' }),
      }),
    );
  });

  it('uses one entry ownership snapshot for a message-create cascade', async () => {
    const chatId = 'cht_message_parent' as Chat['id'];
    seedChat(chatId);
    activate('user-a');
    let clock = 100;
    vi.spyOn(Date, 'now').mockImplementation(() => ++clock);
    const gate = deferred();
    state.messageAddGate = gate.promise;

    const create = messageRepo.create({
      id: 'msg_cascade' as Message['id'],
      chat_id: chatId,
      role: 'user',
      parts: [{ kind: 'text', text: 'Hello' }],
    });
    await vi.waitFor(() => expect(state.messageAddStarted).toBe(true));
    activate('user-b');
    gate.resolve();
    await create;

    expect(state.syncRows).toHaveLength(2);
    const messageOwner = ownerFor(state.syncRows.find((row) => row.table === 'messages')!);
    const chatOwner = ownerFor(state.syncRows.find((row) => row.table === 'chats')!);
    expect(messageOwner).toMatchObject({ state: 'cloud', userId: 'user-a' });
    expect(chatOwner).toMatchObject({ state: 'cloud', userId: 'user-a' });
    expect(messageOwner?.state === 'cloud' ? messageOwner.capturedAt : null).toBe(
      chatOwner?.state === 'cloud' ? chatOwner.capturedAt : null,
    );
  });

  it('keeps a newer same-owner entity payload when an older update reaches coalescing later', async () => {
    const chatId = 'cht_out_of_order' as Chat['id'];
    seedChat(chatId);
    activate('user-a');
    let clockCalls = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => (++clockCalls <= 2 ? 100 : 200));
    const gate = deferred();
    state.chatReadGate = gate.promise;

    const older = chatRepo.update(chatId, { title: 'Older update' });
    await vi.waitFor(() => expect(state.chatReadStarted).toBe(true));
    await chatRepo.update(chatId, { title: 'Newer update' });
    gate.resolve();
    await older;

    expect(state.chats.get(chatId)).toMatchObject({ title: 'Newer update', updated_at: 200 });
    expect(state.syncRows).toHaveLength(1);
    expect(state.syncRows[0]).toMatchObject({
      op: 'update',
      table: 'chats',
      row_id: chatId,
      payload: expect.objectContaining({ title: 'Newer update', updated_at: 200 }),
    });
  });

  it('re-reads the parent chat after message enqueue before cascading an equal-time payload', async () => {
    const chatId = 'cht_stale_message_cascade' as Chat['id'];
    seedChat(chatId);
    activate('user-a');
    vi.spyOn(Date, 'now').mockReturnValue(200);
    const gate = deferred();
    state.messageQueueAddGate = gate.promise;

    const create = messageRepo.create({
      id: 'msg_stale_cascade' as Message['id'],
      chat_id: chatId,
      role: 'user',
      parts: [{ kind: 'text', text: 'Hello' }],
      created_at: 200,
    });
    await vi.waitFor(() => expect(state.messageQueueAddStarted).toBe(true));
    await chatRepo.update(chatId, { title: 'Newer chat title' });
    gate.resolve();
    await create;

    const queuedChat = state.syncRows.find((row) => row.table === 'chats');
    expect(state.chats.get(chatId)).toMatchObject({ title: 'Newer chat title', updated_at: 200 });
    expect(queuedChat).toMatchObject({
      op: 'update',
      payload: expect.objectContaining({ title: 'Newer chat title', updated_at: 200 }),
    });
  });

  it('re-reads detached links after the group transaction before cascading equal-time payloads', async () => {
    const group = seedQuickLinkGroup('qlg_stale_cascade' as QuickLinkGroup['id']);
    const link = seedQuickLink('qln_stale_cascade' as QuickLink['id'], group.id);
    activate('user-a');
    vi.spyOn(Date, 'now').mockReturnValue(200);
    const gate = deferred();
    state.localTransactionCompletionGate = gate.promise;

    const removeGroup = quickLinkGroupRepo.delete(group.id);
    await vi.waitFor(() => expect(state.localTransactionCompletionStarted).toBe(true));
    await quickLinkRepo.update(link.id, { label: 'Newer link' });
    gate.resolve();
    await removeGroup;

    const queuedLink = state.syncRows.find((row) => row.table === 'quick_links');
    expect(state.quickLinks.get(link.id)).toMatchObject({
      label: 'Newer link',
      group_id: undefined,
      updated_at: 200,
    });
    expect(queuedLink).toMatchObject({
      op: 'update',
      payload: expect.objectContaining({
        label: 'Newer link',
        group_id: undefined,
        updated_at: 200,
      }),
    });
  });

  it('keeps an existing same-owner delete terminal when a later stale update arrives', async () => {
    const chatId = 'cht_deleted_terminal' as Chat['id'];
    const pendingId = 'syq_deleted_terminal';
    seedChat(chatId);
    activate('user-a');
    state.syncRows.push({
      id: pendingId,
      op: 'delete',
      table: 'chats',
      row_id: chatId,
      payload: null,
      status: 'pending',
      created_at: 10,
    });
    state.settings.set(cloudSyncQueueOwnerKey(pendingId), {
      key: cloudSyncQueueOwnerKey(pendingId),
      value: {
        schemaVersion: 2,
        rowId: pendingId,
        state: 'cloud',
        userId: 'user-a',
        capturedAt: 10,
      },
      updated_at: 10,
    });

    await chatRepo.update(chatId, { title: 'Stale resurrection' });

    expect(state.syncRows).toHaveLength(1);
    expect(state.syncRows[0]).toMatchObject({ op: 'delete', payload: null });
  });

  it.each([
    ['retried update first', false],
    ['pending delete first', true],
  ] as const)(
    'collapses claim-overlap candidates with the delete terminal when %s',
    async (_order, reverseCandidates) => {
      const key = 'claim-overlap-setting';
      activate('user-a');
      let clock = 0;
      vi.spyOn(Date, 'now').mockImplementation(() => ++clock);

      await settingsRepo.set(key, 'before claim');
      const retriedUpdate = state.syncRows[0]!;
      retriedUpdate.status = 'in_progress';

      await settingsRepo.delete(key);
      const pendingDelete = state.syncRows.find((row) => row.id !== retriedUpdate.id)!;
      retriedUpdate.status = 'pending';
      if (reverseCandidates) state.syncRows.reverse();

      await settingsRepo.set(key, 'later local value');

      const entityRows = state.syncRows.filter(
        (row) => row.table === 'settings' && row.row_id === key,
      );
      expect(state.settings.get(key)?.value).toBe('later local value');
      expect(entityRows).toHaveLength(1);
      expect(entityRows[0]).toMatchObject({ op: 'delete', payload: null, status: 'pending' });
      expect(ownerFor(entityRows[0]!)).toMatchObject({ state: 'cloud', userId: 'user-a' });
      expect(
        [retriedUpdate.id, pendingDelete.id].filter((id) =>
          state.settings.has(cloudSyncQueueOwnerKey(String(id))),
        ),
      ).toHaveLength(1);
    },
  );

  it.each([
    ['older candidate first', false],
    ['newer candidate first', true],
  ] as const)(
    'collapses multiple same-owner updates to the freshest entity payload when %s',
    async (_order, reverseCandidates) => {
      const key = 'freshness-overlap-setting';
      activate('user-a');
      const times = [10, 100, 110, 20, 300, 310, 30, 200, 400];
      vi.spyOn(Date, 'now').mockImplementation(() => times.shift() ?? 500);

      await settingsRepo.set(key, 'oldest');
      const older = state.syncRows[0]!;
      older.status = 'in_progress';

      await settingsRepo.set(key, 'freshest');
      const fresher = state.syncRows.find((row) => row.id !== older.id)!;
      older.status = 'pending';
      if (reverseCandidates) state.syncRows.reverse();

      await settingsRepo.set(key, 'later but stale');

      const entityRows = state.syncRows.filter(
        (row) => row.table === 'settings' && row.row_id === key,
      );
      expect(state.settings.get(key)).toMatchObject({ value: 'later but stale', updated_at: 200 });
      expect(entityRows).toHaveLength(1);
      expect(entityRows[0]).toMatchObject({
        op: 'update',
        status: 'pending',
        payload: expect.objectContaining({ value: 'freshest', updated_at: 300 }),
      });
      expect(ownerFor(entityRows[0]!)).toMatchObject({ state: 'cloud', userId: 'user-a' });
      expect(
        [older.id, fresher.id].filter((id) =>
          state.settings.has(cloudSyncQueueOwnerKey(String(id))),
        ),
      ).toHaveLength(1);
    },
  );

  it.each([
    ['create', (reservedKey: string) => settingsRepo.create({ key: reservedKey, value: 'attack' })],
    ['set', (reservedKey: string) => settingsRepo.set(reservedKey, 'attack')],
    [
      'update source key',
      (reservedKey: string) => settingsRepo.update(reservedKey, { value: 'attack' }),
    ],
    [
      'update destination key',
      (reservedKey: string) =>
        settingsRepo.update('ordinary', { key: reservedKey, value: 'attack' }),
    ],
    ['delete', (reservedKey: string) => settingsRepo.delete(reservedKey)],
  ] as const)(
    'rejects %s for every reserved cloud-sync metadata family before database work',
    async (_operation, mutate) => {
      const reservedKeyFamilies = [
        cloudSyncQueueOwnerKey,
        legacyCloudSyncQueueAuthorityKey,
        cloudSyncQueueClaimKey,
      ] as const;
      for (const reservedKey of reservedKeyFamilies.flatMap((keyFor) => [
        keyFor('syq_protected'),
        keyFor('').slice(0, -1),
      ])) {
        state.settings.clear();
        state.syncRows.length = 0;
        state.settingsMutationStarted = false;
        state.settings.set(reservedKey, {
          key: reservedKey,
          value: { protected: true },
          updated_at: 10,
        });
        state.settings.set('ordinary', {
          key: 'ordinary',
          value: 'before',
          updated_at: 10,
        });
        const before = structuredClone([...state.settings.entries()]);

        const mutation = mutate(reservedKey);
        const enteredDatabaseBeforeAwait = state.settingsMutationStarted;
        const result = await mutation.then(
          () => null,
          (error: unknown) => error,
        );

        expect(enteredDatabaseBeforeAwait).toBe(false);
        expect(result).toEqual(
          expect.objectContaining({ message: 'SETTINGS_RESERVED_CLOUD_SYNC_METADATA_KEY' }),
        );
        expect([...state.settings.entries()]).toEqual(before);
        expect(state.syncRows).toEqual([]);
      }
    },
  );

  it('preserves ordinary settings CRUD and queue behavior', async () => {
    const key = 'ui:theme';

    await settingsRepo.create({ key, value: 'light' });
    await settingsRepo.set(key, 'dark');
    const updated = await settingsRepo.update(key, { value: 'system' });

    expect(updated).toMatchObject({ key, value: 'system' });
    expect(await settingsRepo.get(key)).toBe('system');

    await settingsRepo.delete(key);

    expect(await settingsRepo.get(key)).toBeUndefined();
    expect(state.syncRows).toHaveLength(1);
    expect(state.syncRows[0]).toMatchObject({
      op: 'delete',
      table: 'settings',
      row_id: key,
      payload: null,
    });
  });
});
