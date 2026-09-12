import { describe, expect, it } from 'vitest';
import { JARVIS_ALL_ABOUT_ME_SOURCE_ID } from './promptCompiler';
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
