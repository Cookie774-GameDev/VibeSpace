import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import type { Agent, AgentId } from '@/types';
import {
  KNOWN_SHIPPED_JARVIS_PROMPT_HASHES,
  hashJarvisText,
  isProtectedJarvisAgent,
} from './identity';
import {
  BUILTIN_AGENT_ROSTER_VERSION,
  LEGACY_JARVIS_AGENT_COMPATIBILITY_PROMPT,
  createBuiltinAgentRoster,
  getBuiltinAgentDefinition,
  mergePersistedAndBuiltinAgents,
} from './builtinAgents';

const CURRENT_CODER_PROMPT = `You are the Coder agent. You write, refactor, debug, and explain code. Your output is precise, runnable, and matches the conventions of the project you're working in.

Before you change code:
- Read the relevant files. Match the project's style, language version, libraries, and patterns. Do not introduce new dependencies unless asked or necessary.
- For non-trivial changes, sketch the approach in two or three sentences before writing code. Confirm with the user if the scope is unclear.

When you write code:
- Prefer the smallest change that satisfies the requirement. A bug fix should not include tangentially related cleanup unless asked.
- Use full names, not single-letter variables, except in tight numerical loops.
- Handle errors at the boundary they occur - don't swallow them, don't paper over them with broad try/catch.
- Use parameterised queries, validate untrusted inputs, and avoid string concatenation for SQL or shell commands.
- Add minimal but useful comments only where intent isn't obvious from the code.

When you explain code:
- Lead with the one-sentence summary of what it does. Then describe inputs, outputs, and any side effects.
- Quote line numbers using the project's existing format (file:line) when pointing at specific code.

When you debug:
- Reproduce first. Confirm the failure mode before guessing.
- Form a hypothesis, state it, then test it. Don't shotgun fixes.

If the user asks for something you cannot deliver safely (malicious code, credential exfiltration, bypassing licensing), refuse briefly and offer a constructive alternative.`;

describe('canonical built-in agent roster', () => {
  it('exposes the approved version and exact public API signatures', () => {
    expect(BUILTIN_AGENT_ROSTER_VERSION).toBe(2);
    expectTypeOf(createBuiltinAgentRoster).toEqualTypeOf<
      (input?: { now?: number; newId?: () => AgentId }) => Agent[]
    >();
    expectTypeOf(getBuiltinAgentDefinition).toEqualTypeOf<
      (slug: 'jarvis' | 'coder') => Omit<Agent, 'id' | 'created_at' | 'updated_at'>
    >();
  });

  it('preserves the exact currently shipped Jarvis and Coder definitions', () => {
    expect(getBuiltinAgentDefinition('jarvis')).toStrictEqual({
      slug: 'jarvis',
      name: 'Jarvis',
      description: 'Voice supervisor. Routes intents and decomposes tasks.',
      system_prompt: LEGACY_JARVIS_AGENT_COMPATIBILITY_PROMPT,
      model: { provider: 'google', model: 'gemini-2.5-flash-lite' },
      tools_allowed: ['*'],
      memory_scope: 'project',
      temperature: 0.3,
      max_output_tokens: 4096,
      color_hue: 195,
      capabilities: ['voice_supervision', 'planning'],
      skills: undefined,
      builtin: true,
    });
    expect(getBuiltinAgentDefinition('coder')).toStrictEqual({
      slug: 'coder',
      name: 'Coder',
      description: 'Writes, refactors, debugs, and explains code.',
      system_prompt: CURRENT_CODER_PROMPT,
      model: { provider: 'mock', model: 'mock-default' },
      tools_allowed: ['*'],
      memory_scope: 'project',
      temperature: 0.2,
      max_output_tokens: 8192,
      color_hue: 158,
      capabilities: ['code'],
      skills: undefined,
      builtin: true,
    });
  });

  it('keeps the compatibility Jarvis prompt pinned to the frozen shipped hash', async () => {
    await expect(hashJarvisText(LEGACY_JARVIS_AGENT_COMPATIBILITY_PROMPT)).resolves.toBe(
      KNOWN_SHIPPED_JARVIS_PROMPT_HASHES.registry_ed91635_current,
    );
  });

  it('creates only Jarvis and Coder with injected IDs and one injected timestamp', () => {
    const newId = vi
      .fn<() => AgentId>()
      .mockReturnValueOnce('agt_jarvis_test' as AgentId)
      .mockReturnValueOnce('agt_coder_test' as AgentId);

    const roster = createBuiltinAgentRoster({ now: 1_786_000_000_123, newId });

    expect(
      roster.map(({ id, slug, created_at, updated_at }) => ({
        id,
        slug,
        created_at,
        updated_at,
      })),
    ).toStrictEqual([
      {
        id: 'agt_jarvis_test',
        slug: 'jarvis',
        created_at: 1_786_000_000_123,
        updated_at: 1_786_000_000_123,
      },
      {
        id: 'agt_coder_test',
        slug: 'coder',
        created_at: 1_786_000_000_123,
        updated_at: 1_786_000_000_123,
      },
    ]);
    expect(newId).toHaveBeenCalledTimes(2);
  });

  it('returns deeply detached definitions and roster entries', () => {
    const firstDefinition = getBuiltinAgentDefinition('jarvis');
    firstDefinition.model.model = 'mutated-model';
    firstDefinition.tools_allowed.push('*');
    firstDefinition.capabilities.push('code');

    const firstRoster = createBuiltinAgentRoster({
      now: 10,
      newId: () => 'agt_first' as AgentId,
    });
    firstRoster[0]!.model.model = 'mutated-roster-model';
    firstRoster[0]!.capabilities.push('code');

    expect(getBuiltinAgentDefinition('jarvis')).toMatchObject({
      model: { provider: 'google', model: 'gemini-2.5-flash-lite' },
      tools_allowed: ['*'],
      capabilities: ['voice_supervision', 'planning'],
    });
    expect(
      createBuiltinAgentRoster({ now: 20, newId: () => 'agt_second' as AgentId })[0],
    ).toMatchObject({
      model: { provider: 'google', model: 'gemini-2.5-flash-lite' },
      capabilities: ['voice_supervision', 'planning'],
    });
  });

  it('restores missing built-ins beside persisted custom agents without replacing saved built-in edits', () => {
    const defaults = createBuiltinAgentRoster({
      now: 10,
      newId: vi
        .fn<() => AgentId>()
        .mockReturnValueOnce('agt_default_jarvis' as AgentId)
        .mockReturnValueOnce('agt_default_coder' as AgentId),
    });
    const custom = {
      ...defaults[1]!,
      id: 'agt_custom' as AgentId,
      slug: 'custom',
      builtin: false,
    };
    const [jarvis, coder] = defaults;
    expect(mergePersistedAndBuiltinAgents([custom], defaults)).toEqual([jarvis, coder, custom]);
    const savedJarvis = { ...jarvis!, id: 'agt_saved_jarvis' as AgentId, system_prompt: 'Saved edit' };
    expect(mergePersistedAndBuiltinAgents([savedJarvis, custom], defaults)).toEqual([
      coder,
      savedJarvis,
      custom,
    ]);
    expect(mergePersistedAndBuiltinAgents([custom, { ...jarvis!, builtin: false }], defaults)).toEqual([
      jarvis,
      coder,
      custom,
      { ...jarvis!, builtin: false },
    ]);
  });

  it('uses the shared protected predicate without protecting slug or display-name collisions', () => {
    expect(isProtectedJarvisAgent({ slug: 'jarvis', builtin: true })).toBe(true);
    expect(isProtectedJarvisAgent({ slug: 'jarvis', builtin: false })).toBe(false);
    expect(isProtectedJarvisAgent({ slug: 'jarvis', builtin: undefined })).toBe(false);
    expect(isProtectedJarvisAgent({ slug: 'other', builtin: true })).toBe(false);
  });
});
