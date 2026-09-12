import { describe, expect, it, vi } from 'vitest';
import {
  buildTokenBudgetPlan,
  createTokenizerRegistry,
  isProtectedContext,
  optimizationModePolicy,
  type ContextBudgetCandidate,
  type ProviderTokenizer,
} from './index';

const candidate = (
  id: string,
  estimatedTokens: number,
  overrides: Partial<ContextBudgetCandidate> = {},
): ContextBudgetCandidate => ({
  id,
  kind: 'repository_symbol',
  estimatedTokens,
  relevance: 0.5,
  protected: false,
  reason: 'Relevant repository symbol',
  ...overrides,
});

describe('Token Optimize foundations', () => {
  it('keeps off mode behaviorally unchanged and preserves the requested output limit', () => {
    const candidates = [candidate('a', 800), candidate('b', 900)];
    const plan = buildTokenBudgetPlan({
      mode: 'off',
      modelContextLimit: 1_000,
      requestedOutputTokens: 600,
      fixedInputTokens: 700,
      candidates,
    });

    expect(plan.selected.map(({ id }) => id)).toEqual(['a', 'b']);
    expect(plan.excluded).toEqual([]);
    expect(plan.outputTokenLimit).toBe(600);
    expect(plan.optimizationApplied).toBe(false);
  });

  it('never drops protected content and records a reason for every other exclusion', () => {
    const plan = buildTokenBudgetPlan({
      mode: 'saver',
      modelContextLimit: 2_000,
      requestedOutputTokens: 900,
      fixedInputTokens: 300,
      candidates: [
        candidate('system', 500, {
          kind: 'system_instruction',
          protected: true,
          relevance: 0,
          reason: 'System authority',
        }),
        candidate('best', 500, { relevance: 0.9 }),
        candidate('duplicate', 400, {
          relevance: 0.8,
          duplicateOf: 'best',
        }),
        candidate('low', 500, { relevance: 0.1 }),
      ],
    });

    expect(plan.selected.map(({ id }) => id)).toContain('system');
    expect(plan.excluded).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'duplicate', exclusionReason: 'duplicate' }),
        expect.objectContaining({ id: 'low', exclusionReason: 'irrelevant' }),
      ]),
    );
    expect(plan.estimatedTokensSaved).toBe(900);
    expect(plan.optimizationApplied).toBe(true);
  });

  it('recognizes every mandatory protected-content category', () => {
    expect(isProtectedContext('system_instruction')).toBe(true);
    expect(isProtectedContext('latest_user_message')).toBe(true);
    expect(isProtectedContext('explicit_attachment')).toBe(true);
    expect(isProtectedContext('pinned_context_node')).toBe(true);
    expect(isProtectedContext('tool_schema')).toBe(true);
    expect(isProtectedContext('approval_requirement')).toBe(true);
    expect(isProtectedContext('quoted_preserved_text')).toBe(true);
    expect(isProtectedContext('exact_patch')).toBe(true);
    expect(isProtectedContext('structured_tool_data')).toBe(true);
    expect(isProtectedContext('secret_detection_warning')).toBe(true);
    expect(isProtectedContext('repository_symbol')).toBe(false);
  });

  it('defines distinct bounded policies without changing the selected model', () => {
    expect(optimizationModePolicy('saver').reasoning).toBe('lower_when_supported');
    expect(optimizationModePolicy('normal').reasoning).toBe('provider_default');
    expect(optimizationModePolicy('final_boss').reasoning).toBe('highest_appropriate');
    expect(optimizationModePolicy('final_boss').allowModelSwitch).toBe(false);
  });

  it('uses an exact model tokenizer before provider-native and conservative fallbacks', async () => {
    const exact: ProviderTokenizer = {
      id: 'openai:gpt-5',
      providerId: 'openai',
      modelPattern: /^gpt-5(?:$|[.-])/,
      source: 'exact_local',
      transmitsContent: false,
      estimateText: vi.fn(async () => 11),
    };
    const native: ProviderTokenizer = {
      id: 'openai:native',
      providerId: 'openai',
      modelPattern: /.*/,
      source: 'provider_native',
      transmitsContent: true,
      estimateText: vi.fn(async () => 22),
    };
    const registry = createTokenizerRegistry([native, exact]);

    await expect(registry.estimateText('openai', 'gpt-5.6-sol', 'hello')).resolves.toEqual({
      tokens: 11,
      source: 'exact_local',
      tokenizerId: 'openai:gpt-5',
    });
    await expect(registry.estimateText('unknown', 'model', 'abcdefgh')).resolves.toEqual({
      tokens: 8,
      source: 'conservative_estimate',
      tokenizerId: 'builtin:utf8-conservative-estimate',
    });
  });

  it('uses a conservative UTF-8 estimate and keeps stateful tokenizer matching deterministic', async () => {
    const stateful: ProviderTokenizer = {
      id: 'local:qwen',
      providerId: 'local',
      modelPattern: /qwen/g,
      source: 'exact_local',
      transmitsContent: false,
      estimateText: async () => 3,
    };
    const registry = createTokenizerRegistry([stateful]);

    await expect(registry.estimateText('unknown', 'model', '😀')).resolves.toMatchObject({
      tokens: 4,
      source: 'conservative_estimate',
    });
    await expect(registry.estimateText('local', 'qwen3', 'same')).resolves.toMatchObject({
      tokens: 3,
    });
    await expect(registry.estimateText('local', 'qwen3', 'same')).resolves.toMatchObject({
      tokens: 3,
    });
  });

  it('preserves original prompt order and reports impossible protected overflow', () => {
    const ordered = buildTokenBudgetPlan({
      mode: 'normal',
      modelContextLimit: 2_000,
      requestedOutputTokens: 500,
      fixedInputTokens: 100,
      candidates: [
        candidate('first', 300, { relevance: 0.4 }),
        candidate('protected', 300, {
          kind: 'latest_user_message',
          protected: true,
          relevance: 0,
        }),
        candidate('last', 300, { relevance: 0.9 }),
      ],
    });
    expect(ordered.selected.map(({ id }) => id)).toEqual(['first', 'protected', 'last']);

    const impossible = buildTokenBudgetPlan({
      mode: 'saver',
      modelContextLimit: 500,
      requestedOutputTokens: 200,
      fixedInputTokens: 300,
      candidates: [
        candidate('protected', 400, {
          kind: 'system_instruction',
          protected: true,
        }),
      ],
    });
    expect(impossible).toMatchObject({
      outputTokenLimit: 0,
      fitsContext: false,
      overflowTokens: 200,
    });
  });

  it('packs higher relevance first and uses lower token cost as the deterministic tie-break', () => {
    const plan = buildTokenBudgetPlan({
      mode: 'normal',
      modelContextLimit: 1_000,
      requestedOutputTokens: 500,
      fixedInputTokens: 0,
      candidates: [
        candidate('lower-relevance', 350, { relevance: 0.7 }),
        candidate('expensive-tie', 450, { relevance: 0.9 }),
        candidate('cheap-tie', 200, { relevance: 0.9 }),
      ],
    });

    expect(plan.selected.map(({ id }) => id)).toEqual(['cheap-tie']);
    expect(plan.excluded).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'lower-relevance', exclusionReason: 'over_budget' }),
        expect.objectContaining({ id: 'expensive-tie', exclusionReason: 'over_budget' }),
      ]),
    );
  });

  it('keeps mode policies immutable', () => {
    const policy = optimizationModePolicy('final_boss');
    expect(Object.isFrozen(policy)).toBe(true);
    expect(() => {
      (policy as { allowModelSwitch: boolean }).allowModelSwitch = true;
    }).toThrow();
    expect(optimizationModePolicy('final_boss').allowModelSwitch).toBe(false);
  });

  it('rejects duplicate candidate IDs before budgeting', () => {
    expect(() =>
      buildTokenBudgetPlan({
        mode: 'normal',
        modelContextLimit: 1_000,
        requestedOutputTokens: 200,
        fixedInputTokens: 0,
        candidates: [
          candidate('same', 100, { relevance: 1 }),
          candidate('same', 900, { relevance: 0 }),
        ],
      }),
    ).toThrow(/duplicate candidate id/i);
  });

  it('rejects invalid duplicate and superseded references before budgeting', () => {
    const request = {
      mode: 'normal' as const,
      modelContextLimit: 1_000,
      requestedOutputTokens: 200,
      fixedInputTokens: 0,
    };

    expect(() =>
      buildTokenBudgetPlan({
        ...request,
        candidates: [candidate('self', 100, { duplicateOf: 'self' })],
      }),
    ).toThrow(/invalid duplicate reference/i);
    expect(() =>
      buildTokenBudgetPlan({
        ...request,
        candidates: [candidate('orphan', 100, { supersededBy: 'missing' })],
      }),
    ).toThrow(/invalid superseded reference/i);
    expect(() =>
      buildTokenBudgetPlan({
        ...request,
        candidates: [
          candidate('a', 100, { duplicateOf: 'b' }),
          candidate('b', 100, { supersededBy: 'a' }),
        ],
      }),
    ).toThrow(/cyclic context reference/i);
  });

  it('rejects token totals that overflow safe integer accounting', () => {
    expect(() =>
      buildTokenBudgetPlan({
        mode: 'normal',
        modelContextLimit: Number.MAX_SAFE_INTEGER,
        requestedOutputTokens: 0,
        fixedInputTokens: Number.MAX_SAFE_INTEGER,
        candidates: [candidate('overflow', 1)],
      }),
    ).toThrow(/token total exceeds safe integer range/i);
  });
});
