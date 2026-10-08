import { describe, expect, it } from 'vitest';
import { JARVIS_ALL_ABOUT_ME_SOURCE_ID, compileJarvisPrompt } from './promptCompiler';
import { createHash } from 'node:crypto';
import { buildJarvisContextPack } from './contextPack';
import { createJarvisRequestEnvelope, type JarvisRequestInput } from './requestEnvelope';
import { OpenCodeSessionPool } from '@/lib/harness/OpenCodeSessionPool';
import { processJarvisResponse } from './response/pipeline';
import { projectJarvisEnvelopeToMessageParts } from './kernelMessageProjection';
import {
  buildJarvisRuntimeContextCandidates,
  type JarvisRuntimeContextBlockKey,
} from './runtimeContextCandidates';

const EXPECTED = {
  project: ['project', 'app_verified', 'user_authored', 'answer', false],
  project_tree: ['context_node', 'app_verified', 'app_observed', 'answer', false],
  repository_context: ['project_file', 'app_verified', 'user_authored', 'citation', false],
  local_knowledge: ['project_file', 'app_verified', 'user_authored', 'citation', false],
  user_identity: ['memory', 'user_direct', 'user_authored', 'preference', false],
  default_write_folder: ['project', 'app_verified', 'app_observed', 'execution', false],
  all_about_me: ['memory', 'app_verified', 'mixed', 'preference', false],
  plugin_context: ['plugin', 'external_untrusted', 'external_retrieved', 'answer', false],
  plugin_status: ['plugin', 'app_verified', 'app_observed', 'capability', false],
  mcp_tool_schemas: ['mcp', 'external_untrusted', 'external_retrieved', 'capability', false],
  model_skill_inventory: ['tool_result', 'app_verified', 'mixed', 'capability', false],
  selected_skills: ['tool_result', 'user_direct', 'user_authored', 'execution', false],
  resolved_context: ['context_node', 'app_verified', 'app_observed', 'answer', false],
  intent_policy: ['tool_result', 'app_verified', 'app_observed', 'execution', false],
  interaction_mode: ['tool_result', 'app_verified', 'app_observed', 'execution', false],
  structured_context: ['user_message', 'user_direct', 'user_authored', 'answer', true],
  mentioned_agents: ['agent_output', 'external_untrusted', 'external_retrieved', 'answer', false],
  explicit_context: ['context_node', 'user_direct', 'user_authored', 'answer', true],
  explicit_files: ['project_file', 'user_direct', 'user_authored', 'answer', true],
  explicit_terminal: ['terminal', 'external_untrusted', 'external_retrieved', 'answer', true],
  coordination: ['agent_output', 'app_verified', 'app_observed', 'execution', false],
  terminal_operating: ['terminal', 'app_verified', 'app_observed', 'execution', false],
  connected_files: ['project_file', 'user_direct', 'user_authored', 'answer', true],
  terminal_transcript: ['terminal', 'external_untrusted', 'external_retrieved', 'answer', false],
  completion_instruction: ['tool_result', 'app_verified', 'app_observed', 'execution', false],
} as const satisfies Record<
  JarvisRuntimeContextBlockKey,
  readonly [string, string, string, string, boolean]
>;

describe('buildJarvisRuntimeContextCandidates', () => {
  it('projects every runtime block into distinct honest source metadata', () => {
    const keys = (Object.keys(EXPECTED) as JarvisRuntimeContextBlockKey[]).filter(
      (key) => key !== 'local_knowledge' && key !== 'repository_context',
    );
    const candidates = buildJarvisRuntimeContextCandidates({
      accountId: 'account-1',
      requestId: 'request-1',
      projectId: 'project-1',
      observedAt: 100,
      blocks: keys.map((key) => ({ key, text: `body:${key}` })),
    });

    expect(candidates).toHaveLength(keys.length);
    candidates.forEach((candidate, index) => {
      const key = keys[index]!;
      const expected = EXPECTED[key];
      expect([
        candidate.source.kind,
        candidate.source.trust,
        candidate.source.origin,
        candidate.purpose,
        candidate.explicitlyAttached,
      ]).toEqual(expected);
      expect(candidate.source.accountId).toBe('account-1');
      expect(candidate.source.projectId).toBe('project-1');
      expect(candidate.source.observedAt).toBe(100);
      expect(candidate.freshness).toBe('current');
      expect(candidate.authorizedBody).toBe(true);
      expect(candidate.excerpt).toBe(`body:${key}`);
    });
    expect(
      candidates.find((candidate) => candidate.source.label === 'AllAboutMe profile')?.source.id,
    ).toBe(JARVIS_ALL_ABOUT_ME_SOURCE_ID);
    expect(
      candidates.find(
        (candidate) => candidate.source.label === 'Task-relevant external MCP tool schemas',
      )?.atomicBody,
    ).toBe(true);
    expect(
      candidates.find((candidate) => candidate.source.label === 'Project context')?.atomicBody,
    ).toBeUndefined();
  });

  it('omits blank blocks and returns detached deeply frozen candidates', () => {
    const input = {
      accountId: 'account-1',
      requestId: 'request-1',
      observedAt: 100,
      blocks: [
        { key: 'project' as const, text: 'project body' },
        { key: 'plugin_context' as const, text: '   ' },
      ],
    };
    const candidates = buildJarvisRuntimeContextCandidates(input);
    input.blocks[0]!.text = 'mutated';

    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.excerpt).toBe('project body');
    expect(JSON.stringify(candidates)).not.toContain('mutated');
    expect(Object.isFrozen(candidates)).toBe(true);
    expect(Object.isFrozen(candidates[0])).toBe(true);
    expect(Object.isFrozen(candidates[0]?.source)).toBe(true);
  });

  it('uses stable unique source ids without placing context bodies in metadata', () => {
    const candidates = buildJarvisRuntimeContextCandidates({
      accountId: 'account-1',
      requestId: 'request-1',
      observedAt: 100,
      blocks: [
        { key: 'project', text: 'private project body' },
        { key: 'explicit_files', text: 'private attached body' },
      ],
    });

    expect(new Set(candidates.map((candidate) => candidate.source.id)).size).toBe(2);
    expect(JSON.stringify(candidates.map((candidate) => candidate.source))).not.toMatch(
      /private project body|private attached body/,
    );
  });

  it('preserves exact bounded local-knowledge provenance without collapsing separate chunks', () => {
    const candidates = buildJarvisRuntimeContextCandidates({
      accountId: 'account-1',
      requestId: 'request-1',
      projectId: 'project-1',
      observedAt: 100,
      blocks: [
        {
          key: 'local_knowledge',
          text: 'Acme renewal is in October.',
          source: {
            id: 'jlocal_1111111111111111',
            label: 'Clients — Renewal',
            uri: 'notes/Clients.md#Renewal',
            observedAt: 90,
            contentHash: 'a'.repeat(64),
          },
          score: 42,
        },
        {
          key: 'local_knowledge',
          text: 'Billing owner is Jamie.',
          source: {
            id: 'jlocal_2222222222222222',
            label: 'Finance — Billing',
            uri: 'notes/Finance.md#Billing',
            observedAt: 91,
            contentHash: 'b'.repeat(64),
          },
          score: 40,
        },
      ],
    });

    expect(candidates).toHaveLength(2);
    expect(candidates.map((candidate) => candidate.source)).toEqual([
      {
        id: 'jlocal_1111111111111111',
        kind: 'project_file',
        label: 'Clients — Renewal',
        uri: 'notes/Clients.md#Renewal',
        accountId: 'account-1',
        projectId: 'project-1',
        trust: 'app_verified',
        origin: 'user_authored',
        sensitivity: 'private',
        observedAt: 90,
        contentHash: 'a'.repeat(64),
      },
      {
        id: 'jlocal_2222222222222222',
        kind: 'project_file',
        label: 'Finance — Billing',
        uri: 'notes/Finance.md#Billing',
        accountId: 'account-1',
        projectId: 'project-1',
        trust: 'app_verified',
        origin: 'user_authored',
        sensitivity: 'private',
        observedAt: 91,
        contentHash: 'b'.repeat(64),
      },
    ]);
    expect(candidates.map((candidate) => candidate.score)).toEqual([42, 40]);
    expect(candidates.every((candidate) => candidate.purpose === 'citation')).toBe(true);
    expect(candidates.every((candidate) => candidate.explicitlyAttached === false)).toBe(true);
  });

  it('preserves separate repository files with verified portable provenance', () => {
    const candidates = buildJarvisRuntimeContextCandidates({
      accountId: 'account-1',
      requestId: 'request-1',
      projectId: 'project-1',
      observedAt: 100,
      blocks: [
        {
          key: 'repository_context',
          text: 'export function authenticate() {}',
          source: {
            id: 'jrepo_1111111111111111',
            label: 'src/auth.ts',
            uri: 'src/auth.ts',
            observedAt: 90,
            contentHash: 'a'.repeat(64),
          },
          score: 0.9,
        },
        {
          key: 'repository_context',
          text: 'export function authorize() {}',
          source: {
            id: 'jrepo_2222222222222222',
            label: 'src/permissions.ts',
            uri: 'src/permissions.ts',
            observedAt: 91,
            contentHash: 'b'.repeat(64),
          },
          score: 0.8,
        },
      ],
    });

    expect(candidates).toHaveLength(2);
    expect(candidates.map(({ source }) => source.id)).toEqual([
      'jrepo_1111111111111111',
      'jrepo_2222222222222222',
    ]);
    expect(candidates.every(({ source }) => source.kind === 'project_file')).toBe(true);
    expect(candidates.every(({ purpose }) => purpose === 'citation')).toBe(true);
  });

  it('drops retrieved local knowledge unless its exact bounded provenance is valid', () => {
    const candidates = buildJarvisRuntimeContextCandidates({
      accountId: 'account-1',
      requestId: 'request-1',
      projectId: 'project-1',
      observedAt: 100,
      blocks: [
        { key: 'local_knowledge', text: 'missing provenance' },
        {
          key: 'local_knowledge',
          text: 'traversal provenance',
          source: {
            id: 'jlocal_3333333333333333',
            label: 'Outside',
            uri: '../outside.md',
            observedAt: 90,
            contentHash: 'c'.repeat(64),
          },
        },
        {
          key: 'local_knowledge',
          text: 'absolute provenance',
          source: {
            id: 'jlocal_4444444444444444',
            label: 'Absolute',
            uri: 'C:\\Users\\person\\secret.md',
            observedAt: 90,
            contentHash: 'd'.repeat(64),
          },
        },
      ],
    });

    expect(candidates).toEqual([]);
  });
});

const scope = { accountId: 'synthetic-account', workspaceId: 'synthetic-workspace',
  projectId: 'synthetic-project', workingDirectory: 'C:/synthetic-project' };
const firstRequest = 'jreq_11111111-1111-4111-8111-111111111111';
const nextRequest = 'jreq_22222222-2222-4222-8222-222222222222';

async function compile(requestId: string, change: { body?: string; instruction?: string; model?: string; mode?: 'ask' | 'plan' } = {}) {
  const candidates = buildJarvisRuntimeContextCandidates({
    accountId: scope.accountId, projectId: scope.projectId, requestId, observedAt: 100,
    blocks: [{ key: 'project', text: change.body ?? 'Synthetic project keeps its approved read-only scope.' }],
  });
  const context = await buildJarvisContextPack({ accountId: scope.accountId, candidates, maxChars: 16384 });
  expect(context.items).toHaveLength(1);
  expect(context.exclusions).toHaveLength(0);
  const input: JarvisRequestInput = {
    attempt: { kind: 'initial', requestId, runId: 'synthetic-run', attemptNumber: 1 },
    accountId: scope.accountId, workspaceId: scope.workspaceId, projectId: scope.projectId,
    chatId: 'synthetic-chat', agent: { id: 'synthetic-jarvis', slug: 'jarvis', builtin: true },
    surface: 'typed_chat', interactionMode: change.mode ?? 'ask', responseModeHint: 'direct_answer',
    identity: { identityVersion: 1, coreHash: 'synthetic-core', responseContractHash: 'synthetic-contract' },
    profile: { profileId: 'synthetic-profile', revisionId: 'synthetic-revision',
      customInstructions: change.instruction ?? 'Explain using the admitted evidence.', memoryScope: 'profile' },
    model: { connectionId: 'synthetic-connection', providerId: 'synthetic-provider',
      modelId: change.model ?? 'synthetic-model', connectionMode: 'native-api',
      capabilities: { tools: true, vision: false }, effectiveTemperature: 0.2, capturedAt: 101 },
    capabilities: { capturedAt: 100, tools: [], plugins: [], mcps: [], terminals: [], agents: [],
      entitlements: { source: 'server', planId: 'synthetic-plan', capabilities: [], verifiedAt: 98, expiresAt: 198 } },
    context, outputContract: { preserveStructuredBlocks: true, allowActionBlocks: true,
      allowPlanBlocks: true, allowQuestionBlocks: true, allowPermissionBlocks: true,
      voiceDelivery: 'validated_stream' },
    userText: 'Explain the current admitted project context.', messageHistory: [], createdAt: 102,
  };
  const envelope = await createJarvisRequestEnvelope(input);
  const compiled = compileJarvisPrompt(envelope);
  const fingerprint = `sha256:${createHash('sha256').update(compiled.systemText.trim(), 'utf8').digest('hex')}`;
  expect(fingerprint).toBe(`sha256:${compiled.promptHash}`);
  return { compiled, fingerprint, context, envelope };
}

function poolHarness() {
  let created = 0;
  const client = { createSession: async () => ({ id: `synthetic-session-${++created}` }),
    abort: async () => undefined };
  const pool = new OpenCodeSessionPool({ currentGeneration: () => 'synthetic-generation',
    start: async () => ({ generation: 'synthetic-generation', dispose: async () => undefined }) },
    { connect: async () => client });
  return { pool, created: () => created };
}

describe('request-only context identity versus OpenCode session continuity', () => {
  it('control: equal envelopes keep their fingerprint and one warm session', async () => {
    const a = await compile(firstRequest), b = await compile(firstRequest);
    expect(a.fingerprint).toBe(b.fingerprint);
    const { pool, created } = poolHarness();
    try {
      const first = await pool.sessionForChat(scope, 'synthetic-chat', undefined, a.fingerprint);
      const next = await pool.sessionForChat(scope, 'synthetic-chat', undefined, b.fingerprint);
      expect(next.sessionId).toBe(first.sessionId);
      expect(next.origin).toBe('warm');
      expect(created()).toBe(1);
    } finally { await pool.disposeAll(); }
  });

  it('keeps rendered source identity stable across request IDs while request envelopes remain distinct', async () => {
    const a = await compile(firstRequest), b = await compile(nextRequest);
    expect(a.envelope.requestId).not.toBe(b.envelope.requestId);
    expect(a.context.items[0]!.excerpt).toBe(b.context.items[0]!.excerpt);
    expect(a.context.items[0]!.source.id).toBe(b.context.items[0]!.source.id);
    expect(a.compiled.systemText).toBe(b.compiled.systemText);
    expect(a.compiled.layers.map(layer => layer.contentHash)).toEqual(b.compiled.layers.map(layer => layer.contentHash));
  });

  it('unchanged authorized context with a new request identity reuses its session', async () => {
    const a = await compile(firstRequest), b = await compile(nextRequest);
    const { pool, created } = poolHarness();
    try {
      const first = await pool.sessionForChat(scope, 'synthetic-chat', undefined, a.fingerprint);
      const next = await pool.sessionForChat(scope, 'synthetic-chat', undefined, b.fingerprint);
      expect(next.sessionId).toBe(first.sessionId);
      expect(next.origin).toBe('warm');
      expect(created()).toBe(1);
    } finally { await pool.disposeAll(); }
  });

  it.each([
    ['context body', { body: 'The synthetic authorized context has actually changed.' }],
    ['instructions', { instruction: 'Use a different genuine approved instruction.' }],
    ['selected model', { model: 'synthetic-model-two' }],
    ['authority mode', { mode: 'plan' }],
  ] as const)('control: genuine %s change still rotates', async (_name, change) => {
    const a = await compile(firstRequest), b = await compile(firstRequest, change);
    expect(a.fingerprint).not.toBe(b.fingerprint);
    const { pool, created } = poolHarness();
    try {
      const first = await pool.sessionForChat(scope, 'synthetic-chat', undefined, a.fingerprint);
      const next = await pool.sessionForChat(scope, 'synthetic-chat', undefined, b.fingerprint);
      expect(next.sessionId).not.toBe(first.sessionId);
      expect(created()).toBe(2);
    } finally { await pool.disposeAll(); }
  });
});


describe('ordinary context source identity scope and consumers', () => {
  const input = { accountId: 'owner-a', projectId: 'project-a', requestId: 'first-request',
    observedAt: 100, blocks: [{ key: 'project' as const, text: 'Exact synthetic project body.' }] };

  it('retains current observation metadata while semantic IDs ignore request/time changes', () => {
    const a = buildJarvisRuntimeContextCandidates(input)[0]!;
    const b = buildJarvisRuntimeContextCandidates({ ...input, requestId: 'next-request', observedAt: 200 })[0]!;
    expect(a.source.id).toBe(b.source.id);
    expect(a.source.observedAt).toBe(100);
    expect(b.source.observedAt).toBe(200);
    expect(b.excerpt).toBe(input.blocks[0]!.text);
    expect(b.source.id).toMatch(/^jsource_runtime_project_[a-f0-9]{64}$/u);
    expect(b.source.id).not.toContain(input.accountId);
    expect(b.source.id).not.toContain(input.projectId);
    expect(b.source.id).not.toContain(input.blocks[0]!.text);
    expect(b.source.uri).toBeUndefined();
  });

  it('binds IDs to exact account, project, block semantics and body, including whitespace', () => {
    const id = (value: Parameters<typeof buildJarvisRuntimeContextCandidates>[0]) =>
      buildJarvisRuntimeContextCandidates(value)[0]!.source.id;
    const ids = [id(input), id({ ...input, accountId: 'owner-b' }),
      id({ ...input, projectId: 'project-b' }), id({ ...input, projectId: undefined }),
      id({ ...input, blocks: [{ key: 'project', text: input.blocks[0]!.text + ' ' }] }),
      id({ ...input, blocks: [{ key: 'plugin_context', text: input.blocks[0]!.text }] })];
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('retains distinct same-key bodies in conflicts and message source projection', async () => {
    const candidates = buildJarvisRuntimeContextCandidates({ ...input, blocks: [
      { key: 'project', text: 'Synthetic body A.' }, { key: 'project', text: 'Synthetic body B.' },
    ] });
    expect(candidates[0]!.source.id).not.toBe(candidates[1]!.source.id);
    const pack = await buildJarvisContextPack({ accountId: input.accountId, maxChars: 1000,
      candidates: candidates.map(candidate => ({ ...candidate, conflict: { groupId: 'synthetic-conflict' } })) });
    expect(pack.items).toHaveLength(2);
    for (const item of pack.items) {
      expect(item.conflict).toMatchObject({ status: 'unresolved', groupId: 'synthetic-conflict' });
      expect(new Set(item.conflict!.sourceIds)).toEqual(new Set(candidates.map(candidate => candidate.source.id)));
    }
    const current = await compile(nextRequest);
    const envelope = await createJarvisRequestEnvelope({ ...current.envelope,
      attempt: { kind: 'initial', requestId: nextRequest, runId: 'consumer-run', attemptNumber: 1 },
      context: pack, accountId: input.accountId, projectId: input.projectId });
    const response = await processJarvisResponse({ text: 'The supplied project descriptions differ.',
      provider: envelope.model, completedAt: 103,
      verifiedFacts: { modelState: 'authenticated', plugins: [], mcps: [] } }, envelope,
      { repair: async () => { throw new Error('Synthetic response must not need repair'); } });
    expect(response.sourceRefs).toEqual(pack.items.map(item => item.source));
    expect(response.sourceRefs.every(source => source.accountId === envelope.accountId &&
      source.projectId === envelope.projectId)).toBe(true);
    const projected = projectJarvisEnvelopeToMessageParts({ response, artifacts: [] });
    const refs = projected.filter(part => part.kind === 'jarvis_source_ref');
    expect(refs).toHaveLength(2);
    expect(new Set(refs.map(part => part.source.id))).toEqual(new Set(candidates.map(candidate => candidate.source.id)));
  });

  it('does not admit a foreign account just because content is identical', async () => {
    const foreign = buildJarvisRuntimeContextCandidates({ ...input, accountId: 'foreign-owner' });
    const pack = await buildJarvisContextPack({ accountId: input.accountId, candidates: foreign, maxChars: 1000 });
    expect(pack.items).toEqual([]);
    expect(pack.exclusions).toEqual([{ source: foreign[0]!.source, reason: 'account_mismatch' }]);
  });

  it('keeps the All About Me special ID and exact bounded retrieved references unchanged', () => {
    const pointer = { id: 'jrepo_0123456789abcdef', label: 'Fixture source', uri: 'src/fixture.ts',
      observedAt: 90, contentHash: 'a'.repeat(64) };
    const blocks = [{ key: 'all_about_me' as const, text: 'Synthetic approved profile.' },
      { key: 'repository_context' as const, text: 'const fixture = true;', source: pointer }];
    const a = buildJarvisRuntimeContextCandidates({ ...input, blocks });
    const b = buildJarvisRuntimeContextCandidates({ ...input, requestId: 'different-request', observedAt: 999, blocks });
    expect(a[0]!.source.id).toBe(JARVIS_ALL_ABOUT_ME_SOURCE_ID);
    expect(b[0]!.source.id).toBe(JARVIS_ALL_ABOUT_ME_SOURCE_ID);
    expect(a[1]!.source).toEqual(b[1]!.source);
    expect(a[1]!.source).toMatchObject(pointer);
    expect(a[1]!.purpose).toBe('citation');
  });

  it.each(['accountId', 'workspaceId', 'projectId', 'worktreeId', 'workingDirectory'] as const)(
    'retains OpenCode %s scope isolation with identical semantic prompt', async key => {
      const a = await compile(firstRequest);
      const { pool, created } = poolHarness();
      try {
        const first = await pool.sessionForChat(scope, 'synthetic-chat', undefined, a.fingerprint);
        const next = await pool.sessionForChat({ ...scope, [key]: 'different-synthetic-scope' },
          'synthetic-chat', undefined, a.fingerprint);
        expect(next.sessionId).not.toBe(first.sessionId);
        expect(created()).toBe(2);
      } finally { await pool.disposeAll(); }
    });
});
