import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Agent } from '@/types';

const { foundryRun, nativeInvoke } = vi.hoisted(() => ({ foundryRun: vi.fn(), nativeInvoke: vi.fn() }));

vi.mock('@tauri-apps/api/core', () => ({ invoke: nativeInvoke }));
vi.mock('@/lib/utils', async (original) => ({
  ...await original<typeof import('@/lib/utils')>(), isTauri: true,
}));

vi.mock('./providers/foundry', () => ({
  foundryProvider: {
    isAvailable: () => true,
    run: foundryRun,
  },
}));

import { runAgent } from './router';

const agent: Agent = {
  id: 'agent_foundry_contract' as Agent['id'],
  slug: 'foundry-contract',
  name: 'Foundry contract',
  description: '',
  system_prompt: 'LEGACY SYSTEM PROMPT',
  model: { provider: 'foundry', model: 'artifact--verified' },
  tools_allowed: [],
  memory_scope: 'workspace',
  capabilities: [],
  builtin: false,
  created_at: 1,
  updated_at: 1,
};

describe('Foundry compiled prompt transport', () => {
  beforeEach(() => {
    foundryRun.mockReset();
    foundryRun.mockResolvedValue({
      text: 'done',
      usage: { input_tokens: 1, output_tokens: 1, cost_usd: 0 },
      provider: 'foundry',
      model: agent.model.model,
      finish_reason: 'stop',
    });
  });

  it.each(['codex', 'opencode'] as const)(
    'uses Foundry native inference while the chat engine is %s',
    async (backend) => {
      const response = await runAgent({
        agent,
        connectionId: 'foundry-local',
        backend,
        messages: [{ role: 'user', content: 'A public local test.' }],
      });
      expect(foundryRun).toHaveBeenCalledOnce();
      expect(response.provider).toBe('foundry');
      expect(response.model).toBe('artifact--verified');
    },
  );

  it('sends the compiled system text to the local provider for protected dispatch', async () => {
    await runAgent({
      agent,
      connectionId: 'foundry-local',
      messages: [{ role: 'user', content: 'Summarize the fixture.' }],
      compiledPrompt: {
        schemaVersion: 1,
        layers: [],
        systemText: 'EXACT COMPILED SYSTEM CONTRACT',
        promptHash: 'a'.repeat(64),
        identityVersion: 1,
        profileRevisionId: 'revision-1',
        diagnostics: { totalChars: 30, omittedSourceRefs: [], warnings: [] },
      },
    });

    expect(foundryRun).toHaveBeenCalledOnce();
    expect(foundryRun).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: expect.objectContaining({ system_prompt: 'EXACT COMPILED SYSTEM CONTRACT' }),
      }),
    );
  });

  it('keeps the agent prompt for ordinary uncompiled requests', async () => {
    await runAgent({
      agent,
      connectionId: 'foundry-local',
      messages: [{ role: 'user', content: 'Hello' }],
    });
    expect(foundryRun).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: expect.objectContaining({ system_prompt: 'LEGACY SYSTEM PROMPT' }),
      }),
    );
  });
});

describe('Foundry rejects mismatched connection authority', () => {
  it.each([undefined, 'openai-api', 'missing-local-connection'])(
    'never invokes the local provider with connection %s',
    async (connectionId) => {
      foundryRun.mockClear();
      await expect(
        runAgent({ agent, connectionId, messages: [{ role: 'user', content: 'Local fixture.' }] }),
      ).rejects.toThrow(/Foundry.*connection/i);
      expect(foundryRun).not.toHaveBeenCalled();
    },
  );
});

it('rejects an unsupported tool capability before invoking Foundry', async () => {
  foundryRun.mockClear();
  await expect(
    runAgent({
      agent,
      connectionId: 'foundry-local',
      connectionRequirements: { tools: true },
      messages: [{ role: 'user', content: 'Local fixture.' }],
    }),
  ).rejects.toThrow(/tool/i);
  expect(foundryRun).not.toHaveBeenCalled();
});

it('does not route another provider through the Foundry connection', async () => {
  foundryRun.mockClear();
  await expect(
    runAgent({
      agent: { ...agent, model: { provider: 'openai', model: 'arbitrary-model' } },
      backend: 'opencode',
      connectionId: 'foundry-local',
      messages: [{ role: 'user', content: 'Local fixture.' }],
    }),
  ).rejects.toThrow(/match provider connection/i);
  expect(foundryRun).not.toHaveBeenCalled();
});


import { appActivityLog } from '@/lib/diagnostics/appActivityLog';
import { toPersistedActivity } from '@/lib/diagnostics/activityLogPersistence';

describe('joined Foundry router provider and native bridge correlation', () => {
  beforeEach(async () => {
    const actual = await vi.importActual<typeof import('./providers/foundry')>('./providers/foundry');
    foundryRun.mockReset(); foundryRun.mockImplementation(actual.foundryProvider.run);
    nativeInvoke.mockReset();
    nativeInvoke.mockImplementation(async (command: string) => {
      if (command === 'model_foundry_chat') return { artifactId: 'verified', modelName: 'Public fixture',
        version: 1, method: 'full', text: 'READY', inputTokens: 2, outputTokens: 1 };
      if (command === 'model_foundry_list_jobs') return [{ id: 'verified', name: 'Public fixture',
        version: 1, method: 'full', status: 'completed', artifactVerified: true, artifactSha256: 'a'.repeat(64) }];
      throw new Error('Unexpected synthetic native command');
    });
  });

  it.each(['codex', 'opencode'] as const)('retains exact deep attempt identity across the real %s-affinity local route', async (backend) => {
    const protectedAttempt = { accountId: 'private-account-not-for-diagnostics',
      runId: 'jrun_55555555-5555-4555-8555-555555555555',
      requestId: 'jreq_66666666-6666-4666-8666-666666666666', attemptNumber: 3 };
    const before = appActivityLog.snapshot().sequence;
    const response = await runAgent({ agent, backend, connectionId: 'foundry-local',
      requestId: protectedAttempt.requestId, protectedAttempt,
      messages: [{ role: 'user', content: 'Public joined boundary fixture.' }] });
    expect(response.text).toBe('READY');
    expect(foundryRun.mock.calls[0]?.[0].protectedAttempt).toEqual(protectedAttempt);
    const native = nativeInvoke.mock.calls.find(([command]) => command === 'model_foundry_chat')?.[1];
    const events = appActivityLog.snapshot(before).events.filter((event) => event.kind === 'foundry.inference.native');
    expect(events.map((event) => event.phase)).toEqual(['started', 'completed']);
    for (const event of events) {
      expect(event.data).toMatchObject({ runId: protectedAttempt.runId,
        requestId: protectedAttempt.requestId, attemptNumber: 3, callId: native.requestId });
      expect(toPersistedActivity(event)).toMatchObject({ runId: protectedAttempt.runId,
        requestId: protectedAttempt.requestId, callId: native.requestId });
      expect(event.data).not.toHaveProperty('accountId');
    }
  });

  it('retains ordinary absent-attempt compatibility without inventing durable identities', async () => {
    const before = appActivityLog.snapshot().sequence;
    const response = await runAgent({ agent, connectionId: 'foundry-local',
      messages: [{ role: 'user', content: 'Public unprotected fixture.' }] });
    expect(response.text).toBe('READY');
    expect(foundryRun.mock.calls[0]?.[0]).not.toHaveProperty('protectedAttempt');
    const events = appActivityLog.snapshot(before).events.filter((event) => event.kind === 'foundry.inference.native');
    expect(events.map((event) => event.phase)).toEqual(['started', 'completed']);
    for (const event of events) {
      expect(event.data).not.toHaveProperty('requestId');
      expect(event.data).not.toHaveProperty('runId');
      expect(event.data).not.toHaveProperty('attemptNumber');
    }
  });
});
