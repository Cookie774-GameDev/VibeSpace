import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatModelSelection } from '@/lib/ai/modelSelection';
import { GEMINI_API_CONNECTION, OPENAI_API_CONNECTION } from '@/lib/ai/adapters/nativeCatalog';
import { CODEX_CLI_CONNECTION } from '@/lib/ai/adapters/catalog';
import {
  markConnectionSessionChecked,
  resetConnectionSessionChecksForTests,
  writeConnectionMetadata,
  writeConnectionPickerStates,
} from '@/lib/ai/connectionState';
import {
  buildJarvisModelSwitchCandidates,
  createModelSelectionActions,
  type JarvisModelSelectionActionState,
} from './registryModelSelection';
import type { JarvisModelSwitchCandidate } from '@/lib/jarvis/modelSwitchDecision';
import { DEFAULT_CUSTOM_STEPS, stepsForPreset } from '@/lib/ai/stacks/presets';

function selection(
  providerId: Extract<ChatModelSelection, { mode: 'single' }>['providerId'],
  modelId: string,
): Extract<ChatModelSelection, { mode: 'single' }> {
  return { mode: 'single', providerId, modelId };
}

function state(
  overrides: Partial<JarvisModelSelectionActionState> = {},
): JarvisModelSelectionActionState {
  return {
    chatModelSelection: selection('openai', 'gpt-4o-mini'),
    previousChatModelSelection: { mode: 'none' },
    jarvisAutoApprove: true,
    selectedModels: { openai: 'gpt-4o-mini' },
    apiKeys: {},
    offlineMode: false,
    plan: 'free',
    defaultLocalModel: 'llama3.2',
    stackCustomSteps: DEFAULT_CUSTOM_STEPS,
    ...overrides,
  };
}

function candidate(
  providerId: Extract<ChatModelSelection, { mode: 'single' }>['providerId'],
  modelId: string,
  overrides: Partial<JarvisModelSwitchCandidate> = {},
): JarvisModelSwitchCandidate {
  return {
    selection: selection(providerId, modelId),
    connected: true,
    available: true,
    supportsImages: true,
    supportsTools: true,
    codingRank: 50,
    speedRank: 50,
    costClass: 'standard',
    ...overrides,
  };
}

function hiveCandidates(): readonly JarvisModelSwitchCandidate[] {
  return stepsForPreset('balanced', 'general', DEFAULT_CUSTOM_STEPS).map((step) =>
    candidate(step.provider, step.model, { costClass: 'premium' }),
  );
}

describe('buildJarvisModelSwitchCandidates', () => {
  beforeEach(() => {
    window.localStorage.clear();
    resetConnectionSessionChecksForTests();
  });

  it('derives connection, capability, preference, and cost truth without copying keys', () => {
    const auth = state({
      chatModelSelection: selection('google', 'gemini-2.5-flash'),
      selectedModels: { google: 'gemini-2.5-flash' },
      apiKeys: { google: 'must-not-escape' },
    });
    const candidates = buildJarvisModelSwitchCandidates(auth, {
      connections: [GEMINI_API_CONNECTION],
      connectionStates: {
        'google-gemini-api': { available: true, auth: 'authenticated' },
      },
      modelOptions: [
        {
          provider: 'google',
          id: 'gemini-2.5-flash',
          label: 'Gemini 2.5 Flash',
        },
      ],
    });

    expect(candidates).toEqual([
      expect.objectContaining({
        selection: expect.objectContaining({
          providerId: 'google',
          modelId: 'gemini-2.5-flash',
          connectionId: 'google-gemini-api',
        }),
        preferred: true,
        connected: true,
        available: true,
        supportsImages: true,
        toolReliabilityRank: 0,
      }),
    ]);
    expect(JSON.stringify(candidates)).not.toMatch(/must-not-escape|apiKeys|accountLabel|error/);
    expect(Object.isFrozen(candidates)).toBe(true);
  });

  it('does not promote an observed unauthenticated connection', () => {
    const candidates = buildJarvisModelSwitchCandidates(state(), {
      connections: [GEMINI_API_CONNECTION],
      connectionStates: {
        'google-gemini-api': { available: true, auth: 'unauthenticated' },
      },
      modelOptions: [
        {
          provider: 'google',
          id: 'gemini-2.5-flash',
          label: 'Gemini 2.5 Flash',
        },
      ],
    });

    expect(candidates[0]).toMatchObject({ connected: false, available: false });
  });

  it('fails a native cloud connection closed when no observed auth state exists', () => {
    const candidates = buildJarvisModelSwitchCandidates(
      state({ apiKeys: { google: 'present-but-unverified' } }),
      {
        connections: [GEMINI_API_CONNECTION],
        connectionStates: {},
        modelOptions: [
          {
            provider: 'google',
            id: 'gemini-2.5-flash',
            label: 'Gemini 2.5 Flash',
          },
        ],
      },
    );

    expect(candidates[0]).toMatchObject({ connected: false, available: false });
  });

  it('never projects an external provider CLI as a Chat model-switch candidate', () => {
    writeConnectionPickerStates({
      'openai-codex': { available: true, auth: 'authenticated' },
    });

    const stale = buildJarvisModelSwitchCandidates(state(), {
      connections: [CODEX_CLI_CONNECTION],
    }).filter((candidate) => candidate.selection.connectionId === 'openai-codex');
    expect(stale).toEqual([]);

    writeConnectionMetadata({
      'openai-codex': {
        installation: 'installed',
        auth: 'authenticated',
      },
    });
    markConnectionSessionChecked(['openai-codex']);
    const current = buildJarvisModelSwitchCandidates(state(), {
      connections: [CODEX_CLI_CONNECTION],
    }).filter((candidate) => candidate.selection.connectionId === 'openai-codex');
    expect(current).toEqual([]);
  });

  it('projects exact embedded metadata only onto an active catalog model', () => {
    const [candidate] = buildJarvisModelSwitchCandidates(
      state({
        apiKeys: { google: 'present-for-accessibility-only' },
        chatModelSelection: selection('google', 'gemini-3.5-flash'),
      }),
      {
        connections: [GEMINI_API_CONNECTION],
        connectionStates: {
          'google-gemini-api': { available: true, auth: 'authenticated' },
        },
        modelOptions: [
          {
            provider: 'google',
            id: 'gemini-3.5-flash',
            label: 'Gemini 3.5 Flash',
          },
        ],
      },
    );

    expect(candidate).toMatchObject({
      contextWindowTokens: 1_048_576,
      maximumCostPerMillionUsd: 9,
      costMetadataSource: 'embedded_snapshot',
    });
  });

  it('does not inherit provider-default pricing for an unknown exact model', () => {
    const [candidate] = buildJarvisModelSwitchCandidates(
      state({
        apiKeys: { openai: 'present-for-accessibility-only' },
        chatModelSelection: selection('openai', 'gpt-5.5-pro'),
      }),
      {
        connections: [OPENAI_API_CONNECTION],
        connectionStates: {
          'openai-api': { available: true, auth: 'authenticated' },
        },
        modelOptions: [{ provider: 'openai', id: 'gpt-5.5-pro', label: 'GPT-5.5 Pro' }],
      },
    );

    expect(candidate).toMatchObject({
      connected: true,
      available: true,
      costClass: 'unknown',
    });
    expect(candidate).not.toHaveProperty('maximumCostPerMillionUsd');
    expect(candidate).not.toHaveProperty('costMetadataSource');
  });

  it('does not promote rough awareness-meter rates into routing cost authority', () => {
    const [candidate] = buildJarvisModelSwitchCandidates(
      state({
        apiKeys: { openai: 'present-for-accessibility-only' },
        chatModelSelection: selection('openai', 'gpt-4o-mini'),
      }),
      {
        connections: [OPENAI_API_CONNECTION],
        connectionStates: {
          'openai-api': { available: true, auth: 'authenticated' },
        },
        modelOptions: [{ provider: 'openai', id: 'gpt-4o-mini', label: 'GPT-4o Mini' }],
      },
    );

    expect(candidate).toMatchObject({ costClass: 'unknown' });
    expect(candidate).not.toHaveProperty('maximumCostPerMillionUsd');
    expect(candidate).not.toHaveProperty('costMetadataSource');
  });

  it('never injects a Hive workflow model absent from the active picker catalog', () => {
    const candidates = buildJarvisModelSwitchCandidates(
      state({ apiKeys: { google: 'present-for-accessibility-only' } }),
      {
        connections: [GEMINI_API_CONNECTION],
        connectionStates: {
          'google-gemini-api': { available: true, auth: 'authenticated' },
        },
      },
    );

    expect(
      candidates.some(
        (candidate) =>
          candidate.selection.providerId === 'google' &&
          candidate.selection.modelId === 'gemini-3.5-flash-high',
      ),
    ).toBe(false);
  });
});

describe('chat.model.switch action', () => {
  function setup(input: {
    initial?: JarvisModelSelectionActionState;
    candidates: readonly JarvisModelSwitchCandidate[];
    apply?: (selection: ChatModelSelection) => void;
    validate?: (
      selection: ChatModelSelection,
      state: JarvisModelSelectionActionState,
      requirements: Readonly<{ images?: boolean; tools?: boolean }>,
    ) => { ok: true; selection: ChatModelSelection } | { ok: false; message: string };
  }) {
    let current = input.initial ?? state();
    const apply =
      input.apply ??
      vi.fn((next: ChatModelSelection) => {
        current = {
          ...current,
          previousChatModelSelection: current.chatModelSelection,
          chatModelSelection: next,
        };
      });
    const action = createModelSelectionActions({
      getState: () => current,
      buildCandidates: () => input.candidates,
      applySelection: apply,
      validateSelection: input.validate ?? ((selection) => ({ ok: true, selection })),
    })[0]!;
    return { action, apply, getState: () => current };
  }

  it('applies and verifies only a ready decision', async () => {
    const test = setup({
      candidates: [candidate('openai', 'gpt-4o-mini'), candidate('google', 'gemini-2.5-flash')],
    });

    const result = await test.action.run({ request: 'Switch to Gemini.' }, { source: 'ai' });

    expect(result).toMatchObject({
      ok: true,
      summary: expect.stringMatching(
        /Model switched.*google\/gemini-2.5-flash.*next turn.*current response keeps its captured model/i,
      ),
    });
    expect(test.apply).toHaveBeenCalledOnce();
    expect(test.getState().chatModelSelection).toEqual(selection('google', 'gemini-2.5-flash'));
  });

  it('applies a verified Hive Balanced request and refuses it when readiness validation fails', async () => {
    vi.stubEnv('VITE_HIVE_ENABLED', 'true');
    const ready = setup({
      initial: state({
        chatModelSelection: selection('openai', 'current-premium'),
        selectedModels: { openai: 'current-premium' },
      }),
      candidates: [
        candidate('openai', 'current-premium', { costClass: 'premium' }),
        ...hiveCandidates(),
      ],
    });
    await expect(
      ready.action.run({ request: 'Use Hive Balanced.' }, { source: 'user' }),
    ).resolves.toMatchObject({
      ok: true,
      data: { hiveId: 'balanced' },
    });
    expect(ready.getState().chatModelSelection).toEqual({
      mode: 'hive',
      hiveId: 'balanced',
    });

    const blocked = setup({
      candidates: hiveCandidates(),
      validate: () => ({ ok: false, message: 'Hive providers are not connected.' }),
      apply: vi.fn(),
    });
    await expect(
      blocked.action.run({ request: 'Use Hive Balanced.' }, { source: 'user' }),
    ).resolves.toEqual({
      ok: false,
      error: 'Hive providers are not connected.',
    });
    expect(blocked.apply).not.toHaveBeenCalled();
    vi.unstubAllEnvs();
  });

  it('passes requested capabilities through the final Hive readiness gate', async () => {
    vi.stubEnv('VITE_HIVE_ENABLED', 'true');
    const apply = vi.fn();
    const validate = vi.fn(
      (
        selection: ChatModelSelection,
        _state: JarvisModelSelectionActionState,
        requirements: Readonly<{ images?: boolean; tools?: boolean }>,
      ) =>
        requirements.tools
          ? ({ ok: false, message: 'Hive Balanced cannot use these tools.' } as const)
          : ({ ok: true, selection } as const),
    );
    const test = setup({
      initial: state({
        chatModelSelection: selection('openai', 'current-premium'),
        selectedModels: { openai: 'current-premium' },
      }),
      candidates: [
        candidate('openai', 'current-premium', { costClass: 'premium' }),
        ...hiveCandidates(),
      ],
      validate,
      apply,
    });

    await expect(
      test.action.run({ request: 'Use Hive Balanced.', needsTools: true }, { source: 'user' }),
    ).resolves.toEqual({
      ok: false,
      error: 'Hive Balanced cannot use these tools.',
    });
    expect(validate).toHaveBeenCalledWith(
      { mode: 'hive', hiveId: 'balanced' },
      expect.any(Object),
      { images: false, tools: true },
    );
    expect(apply).not.toHaveBeenCalled();
    vi.unstubAllEnvs();
  });

  it('refuses Hive when candidates do not prove every exact workflow model', async () => {
    vi.stubEnv('VITE_HIVE_ENABLED', 'true');
    const apply = vi.fn();
    const test = setup({
      candidates: [
        candidate('google', 'wrong-google-model', { costClass: 'premium' }),
        candidate('openrouter', 'wrong-openrouter-model', { costClass: 'premium' }),
        candidate('deepseek', 'wrong-deepseek-model', { costClass: 'premium' }),
        candidate('openai', 'wrong-openai-model', { costClass: 'premium' }),
      ],
      apply,
    });

    await expect(
      test.action.run({ request: 'Use Hive Balanced.' }, { source: 'user' }),
    ).resolves.toMatchObject({
      ok: false,
      error: expect.stringMatching(/no configured model/i),
    });
    vi.unstubAllEnvs();
    expect(apply).not.toHaveBeenCalled();
  });

  it.each([
    [
      'not connected',
      state(),
      [candidate('google', 'gemini', { connected: false, available: false })],
      'Switch to Gemini.',
    ],
    [
      'additional privacy and cost approval',
      state({
        chatModelSelection: selection('ollama', 'llama3.2'),
        selectedModels: { ollama: 'llama3.2' },
      }),
      [
        candidate('ollama', 'llama3.2', { costClass: 'free' }),
        candidate('google', 'gemini', { costClass: 'premium' }),
      ],
      'Switch to Gemini.',
    ],
  ])('refuses %s with zero mutation', async (_label, initial, candidates, request) => {
    const apply = vi.fn();
    const test = setup({ initial, candidates, apply });

    const result = await test.action.run({ request }, { source: 'ai' });

    expect(result.ok).toBe(false);
    expect(apply).not.toHaveBeenCalled();
  });

  it('consumes privacy and cost approval only from a complete canonical execution context', async () => {
    const initial = state({
      chatModelSelection: selection('ollama', 'llama3.2'),
      selectedModels: { ollama: 'llama3.2' },
    });
    const candidates = [
      candidate('ollama', 'llama3.2', { costClass: 'free' }),
      candidate('google', 'gemini', { costClass: 'premium' }),
    ];
    const legacy = setup({ initial, candidates });

    await expect(
      legacy.action.run(
        { request: 'Switch to Gemini.' },
        { source: 'ai', approvalId: 'approval-shaped-but-incomplete' },
      ),
    ).resolves.toMatchObject({
      ok: false,
      error: expect.stringMatching(/additional approval required/i),
    });
    expect(legacy.apply).not.toHaveBeenCalled();

    const correlationOnly = setup({ initial, candidates });
    await expect(
      correlationOnly.action.run(
        { request: 'Switch to Gemini.' },
        {
          source: 'ai',
          accountId: 'account-kernel',
          runId: 'run-kernel',
          approvalId: 'approval-kernel',
          requestId: 'request-kernel',
          attemptNumber: 1,
        },
      ),
    ).resolves.toMatchObject({
      ok: false,
      error: expect.stringMatching(/additional approval required/i),
    });
    expect(correlationOnly.apply).not.toHaveBeenCalled();

    const canonical = setup({ initial, candidates });
    await expect(
      canonical.action.run(
        { request: 'Switch to Gemini.' },
        {
          source: 'ai',
          accountId: 'account-kernel',
          runId: 'run-kernel',
          approvalId: 'approval-kernel',
          requestId: 'request-kernel',
          attemptNumber: 1,
          signal: new AbortController().signal,
        },
      ),
    ).resolves.toMatchObject({
      ok: true,
      summary: expect.stringMatching(/Model switched.*google\/gemini/i),
    });
    expect(canonical.apply).toHaveBeenCalledOnce();
    expect(canonical.getState().chatModelSelection).toEqual(selection('google', 'gemini'));
  });

  it('requires canonical approval for an AI switch when automatic approvals are disabled', async () => {
    const apply = vi.fn();
    const test = setup({
      initial: state({ jarvisAutoApprove: false }),
      candidates: [
        candidate('openai', 'gpt-4o-mini'),
        candidate('google', 'gemini', { costClass: 'low' }),
      ],
      apply,
    });

    await expect(
      test.action.run({ request: 'Switch to Gemini.' }, { source: 'ai' }),
    ).resolves.toMatchObject({
      ok: false,
      error: expect.stringMatching(/additional approval required/i),
    });
    expect(apply).not.toHaveBeenCalled();
  });

  it('returns a verified no-op when the requested model is already selected', async () => {
    const apply = vi.fn();
    const test = setup({
      initial: state({
        chatModelSelection: selection('google', 'gemini'),
        selectedModels: { google: 'gemini' },
      }),
      candidates: [candidate('google', 'gemini')],
      apply,
    });

    const result = await test.action.run({ request: 'Switch to Gemini.' }, { source: 'ai' });

    expect(result).toMatchObject({ ok: true, summary: expect.stringMatching(/already selected/i) });
    expect(apply).not.toHaveBeenCalled();
  });

  it('fails closed when the post-write selection cannot be verified', async () => {
    const test = setup({
      candidates: [candidate('openai', 'gpt-4o-mini'), candidate('google', 'gemini')],
      apply: vi.fn(),
    });

    const result = await test.action.run({ request: 'Switch to Gemini.' }, { source: 'ai' });

    expect(result).toMatchObject({
      ok: false,
      error: expect.stringMatching(/verification failed/i),
    });
  });
});
