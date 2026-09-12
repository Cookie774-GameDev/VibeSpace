import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChatModelSelection } from '@/lib/ai/modelSelection';
import {
  parseJarvisModelSwitchIntent,
  planJarvisModelSwitch,
  type JarvisModelSwitchCandidate,
} from './modelSwitchDecision';

function selection(
  providerId: Extract<ChatModelSelection, { mode: 'single' }>['providerId'],
  modelId: string,
): Extract<ChatModelSelection, { mode: 'single' }> {
  return { mode: 'single', providerId, modelId };
}

function connectedSelection(
  providerId: Extract<ChatModelSelection, { mode: 'single' }>['providerId'],
  modelId: string,
  connectionId: string,
): Extract<ChatModelSelection, { mode: 'single' }> {
  return {
    mode: 'single',
    providerId,
    modelId,
    connectionId,
    connectionMode: 'native-api',
    authSource: 'api-key',
    capabilities: {
      text: true,
      images: true,
      files: true,
      tools: true,
      modelSelection: true,
      structuredOutput: true,
      streaming: true,
      cancellation: true,
      resumeSession: false,
      systemPrompt: true,
      workingDirectory: false,
      usage: true,
      subscriptionQuota: false,
      localOnly: false,
    },
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
    costClass: 'standard',
    ...overrides,
  };
}

describe('parseJarvisModelSwitchIntent', () => {
  it.each([
    ['Switch to Gemini.', { kind: 'provider', providerId: 'google' }],
    ['Use Grok for this.', { kind: 'provider', providerId: 'xai' }],
    ['Switch to Claude for this task.', { kind: 'provider', providerId: 'anthropic' }],
    ['Use Grok for the next answer.', { kind: 'provider', providerId: 'xai' }],
    ['Use a local model.', { kind: 'local' }],
    ['Use my local model.', { kind: 'local' }],
    ['Use the fastest connected model.', { kind: 'fastest_connected' }],
    ['Use Hive Balanced.', { kind: 'hive_balanced' }],
    ['Use the strongest coding model.', { kind: 'strongest_coding' }],
    ['Use the cheapest model that can handle this.', { kind: 'cheapest_capable' }],
    ['Switch back.', { kind: 'switch_back' }],
    ['Go back to the default model.', { kind: 'switch_back' }],
  ] as const)('parses %s without inventing a target', (text, expected) => {
    const intent = parseJarvisModelSwitchIntent(text);
    expect(intent).toEqual(expected);
    expect(Object.isFrozen(intent)).toBe(true);
  });

  it('does not classify advice or status questions as switch intents', () => {
    expect(parseJarvisModelSwitchIntent('Which model should I use?')).toBeNull();
    expect(parseJarvisModelSwitchIntent('Which model are you using?')).toBeNull();
    expect(parseJarvisModelSwitchIntent('Tell me about Gemini.')).toBeNull();
  });
});

describe('planJarvisModelSwitch', () => {
  it('selects a configured connected available provider target deterministically', () => {
    const result = planJarvisModelSwitch({
      intent: { kind: 'provider', providerId: 'google' },
      current: selection('openai', 'gpt-4o-mini'),
      candidates: [
        candidate('google', 'gemini-flash', { codingRank: 40, costClass: 'free' }),
        candidate('google', 'gemini-pro', { codingRank: 80, costClass: 'standard' }),
      ],
      offlineMode: false,
      requirements: {},
      policyRequiresApproval: false,
    });

    expect(result).toMatchObject({
      status: 'ready',
      target: { mode: 'single', providerId: 'google', modelId: 'gemini-pro' },
    });
  });

  it('honors the configured provider preference before generic ranking', () => {
    const result = planJarvisModelSwitch({
      intent: { kind: 'provider', providerId: 'google' },
      current: selection('openai', 'gpt-4o-mini'),
      candidates: [
        candidate('google', 'configured-default', {
          preferred: true,
          codingRank: 30,
        }),
        candidate('google', 'stronger-but-not-selected', { codingRank: 90 }),
      ],
      offlineMode: false,
      requirements: {},
      policyRequiresApproval: false,
    });

    expect(result).toMatchObject({
      status: 'ready',
      target: { providerId: 'google', modelId: 'configured-default' },
    });
  });

  it.each([
    [
      'not_configured',
      [],
      { kind: 'provider', providerId: 'xai' } as const,
      { status: 'not_configured', reason: 'target_not_configured' },
    ],
    [
      'not_connected',
      [candidate('xai', 'grok', { connected: false })],
      { kind: 'provider', providerId: 'xai' } as const,
      { status: 'not_connected', reason: 'provider_not_connected' },
    ],
    [
      'unavailable',
      [candidate('xai', 'grok', { available: false })],
      { kind: 'provider', providerId: 'xai' } as const,
      { status: 'unavailable', reason: 'model_unavailable' },
    ],
  ])('returns %s without preparing a mutation', (_label, candidates, intent, expected) => {
    expect(
      planJarvisModelSwitch({
        intent,
        current: selection('openai', 'gpt-4o-mini'),
        candidates,
        offlineMode: false,
        requirements: {},
        policyRequiresApproval: false,
      }),
    ).toMatchObject(expected);
  });

  it('blocks cloud targets while offline but permits an available local target', () => {
    const candidates = [
      candidate('google', 'gemini-flash'),
      candidate('ollama', 'llama3.2', { costClass: 'free' }),
    ];

    expect(
      planJarvisModelSwitch({
        intent: { kind: 'provider', providerId: 'google' },
        current: selection('ollama', 'llama3.2'),
        candidates,
        offlineMode: true,
        requirements: {},
        policyRequiresApproval: false,
      }),
    ).toMatchObject({ status: 'unavailable', reason: 'offline_mode' });
    expect(
      planJarvisModelSwitch({
        intent: { kind: 'local' },
        current: selection('google', 'gemini-flash'),
        candidates,
        offlineMode: true,
        requirements: {},
        policyRequiresApproval: false,
      }),
    ).toMatchObject({
      status: 'ready',
      target: { providerId: 'ollama', modelId: 'llama3.2' },
    });
  });

  it('filters cloud candidates out of broad routing intents while offline', () => {
    expect(
      planJarvisModelSwitch({
        intent: { kind: 'fastest_connected' },
        current: selection('ollama', 'current-local'),
        candidates: [
          candidate('google', 'cloud-fast', { speedRank: 100 }),
          candidate('ollama', 'local-safe', { speedRank: 30, costClass: 'free' }),
        ],
        offlineMode: true,
        requirements: {},
        policyRequiresApproval: false,
      }),
    ).toMatchObject({
      status: 'ready',
      target: { providerId: 'ollama', modelId: 'local-safe' },
    });
  });

  it('chooses the strongest coding model only from capable usable candidates', () => {
    const result = planJarvisModelSwitch({
      intent: { kind: 'strongest_coding' },
      current: selection('openai', 'current'),
      candidates: [
        candidate('xai', 'highest-but-no-tools', {
          codingRank: 100,
          supportsTools: false,
        }),
        candidate('anthropic', 'best-capable', { codingRank: 90 }),
        candidate('openai', 'weaker-capable', { codingRank: 70 }),
      ],
      offlineMode: false,
      requirements: { tools: true },
      policyRequiresApproval: false,
    });

    expect(result).toMatchObject({
      status: 'ready',
      target: { providerId: 'anthropic', modelId: 'best-capable' },
    });
  });

  it('chooses the cheapest capable model and uses coding rank as the tie-breaker', () => {
    const result = planJarvisModelSwitch({
      intent: { kind: 'cheapest_capable' },
      current: selection('openai', 'premium-current'),
      candidates: [
        candidate('google', 'free-basic', { codingRank: 30, costClass: 'free' }),
        candidate('groq', 'free-strong', { codingRank: 70, costClass: 'free' }),
        candidate('anthropic', 'premium-strongest', {
          codingRank: 100,
          costClass: 'premium',
        }),
      ],
      offlineMode: false,
      requirements: { images: true },
      policyRequiresApproval: false,
    });

    expect(result).toMatchObject({
      status: 'ready',
      target: { providerId: 'groq', modelId: 'free-strong' },
    });
  });

  it('chooses the fastest connected model only after capability and availability filtering', () => {
    const result = planJarvisModelSwitch({
      intent: { kind: 'fastest_connected' },
      current: selection('openai', 'current'),
      candidates: [
        candidate('groq', 'fast-without-tools', {
          speedRank: 100,
          supportsTools: false,
        }),
        candidate('google', 'fast-capable', { speedRank: 90 }),
        candidate('anthropic', 'slower-capable', { speedRank: 60 }),
        candidate('xai', 'unavailable-fastest', { speedRank: 110, available: false }),
      ],
      offlineMode: false,
      requirements: { tools: true },
      policyRequiresApproval: false,
    });

    expect(result).toMatchObject({
      status: 'ready',
      target: { providerId: 'google', modelId: 'fast-capable' },
    });
  });

  it('prepares Hive Balanced only from verified online readiness', () => {
    vi.stubEnv('VITE_HIVE_ENABLED', 'true');
    const input = {
      intent: { kind: 'hive_balanced' } as const,
      current: selection('openai', 'current'),
      candidates: [candidate('openai', 'current')],
      hiveBalanced: {
        configured: true,
        connected: true,
        available: true,
        supportsImages: true,
        supportsTools: true,
        allLocal: false,
        costClass: 'standard' as const,
      },
      requirements: {},
      policyRequiresApproval: false,
    };

    expect(planJarvisModelSwitch({ ...input, offlineMode: false })).toMatchObject({
      status: 'ready',
      target: { mode: 'hive', hiveId: 'balanced' },
    });
    expect(planJarvisModelSwitch({ ...input, offlineMode: true })).toMatchObject({
      status: 'unavailable',
      reason: 'offline_mode',
    });
    vi.unstubAllEnvs();
  });

  it('fails Hive Balanced closed when the product is gated', () => {
    expect(
      planJarvisModelSwitch({
        intent: { kind: 'hive_balanced' },
        current: selection('openai', 'current'),
        candidates: [candidate('openai', 'current')],
        hiveBalanced: {
          configured: true,
          connected: true,
          available: true,
          supportsImages: true,
          supportsTools: true,
          allLocal: false,
          costClass: 'standard',
        },
        offlineMode: false,
        requirements: {},
        policyRequiresApproval: false,
      }),
    ).toMatchObject({
      status: 'not_configured',
      reason: 'target_not_configured',
    });
  });

  it('fails Hive Balanced closed on missing readiness or required capabilities', () => {
    vi.stubEnv('VITE_HIVE_ENABLED', 'true');
    const base = {
      intent: { kind: 'hive_balanced' } as const,
      current: selection('openai', 'current'),
      candidates: [candidate('openai', 'current')],
      offlineMode: false,
      policyRequiresApproval: false,
    };

    expect(planJarvisModelSwitch({ ...base, requirements: {} })).toMatchObject({
      status: 'not_configured',
      reason: 'target_not_configured',
    });
    expect(
      planJarvisModelSwitch({
        ...base,
        hiveBalanced: {
          configured: true,
          connected: true,
          available: true,
          supportsImages: false,
          supportsTools: true,
          allLocal: false,
          costClass: 'premium',
        },
        requirements: { images: true },
      }),
    ).toMatchObject({
      status: 'unavailable',
      reason: 'required_capability_unavailable',
    });
    vi.unstubAllEnvs();
  });

  it('derives Hive privacy, cost, and policy approval from verified readiness', () => {
    vi.stubEnv('VITE_HIVE_ENABLED', 'true');
    const result = planJarvisModelSwitch({
      intent: { kind: 'hive_balanced' },
      current: selection('ollama', 'llama3.2'),
      candidates: [candidate('ollama', 'llama3.2', { costClass: 'free' })],
      hiveBalanced: {
        configured: true,
        connected: true,
        available: true,
        supportsImages: true,
        supportsTools: true,
        allLocal: false,
        costClass: 'premium',
      },
      offlineMode: false,
      requirements: { tools: true },
      policyRequiresApproval: true,
    });

    expect(result).toMatchObject({
      status: 'approval_required',
      target: { mode: 'hive', hiveId: 'balanced' },
      reasons: ['local_to_cloud', 'cost_increase', 'policy'],
    });
    vi.unstubAllEnvs();
  });

  it('requires approval for privacy, cost, and policy changes before mutation', () => {
    const result = planJarvisModelSwitch({
      intent: { kind: 'provider', providerId: 'anthropic' },
      current: selection('ollama', 'llama3.2'),
      candidates: [
        candidate('ollama', 'llama3.2', { costClass: 'free' }),
        candidate('anthropic', 'claude-premium', { costClass: 'premium' }),
      ],
      offlineMode: false,
      requirements: {},
      policyRequiresApproval: true,
    });

    expect(result).toMatchObject({
      status: 'approval_required',
      reasons: ['local_to_cloud', 'cost_increase', 'policy'],
      target: { providerId: 'anthropic', modelId: 'claude-premium' },
    });
  });

  it('requires approval when target cost is unknown', () => {
    const result = planJarvisModelSwitch({
      intent: { kind: 'provider', providerId: 'google' },
      current: selection('openai', 'known'),
      candidates: [
        candidate('openai', 'known', { costClass: 'low' }),
        candidate('google', 'unknown-price', { costClass: 'unknown' }),
      ],
      offlineMode: false,
      requirements: {},
      policyRequiresApproval: false,
    });

    expect(result).toMatchObject({
      status: 'approval_required',
      reasons: ['cost_unknown'],
    });
  });

  it('uses the preferred current connection as cost authority', () => {
    const result = planJarvisModelSwitch({
      intent: { kind: 'provider', providerId: 'google' },
      current: selection('openai', 'shared-model'),
      candidates: [
        candidate('openai', 'shared-model', {
          preferred: false,
          costClass: 'premium',
        }),
        candidate('openai', 'shared-model', {
          preferred: true,
          costClass: 'free',
        }),
        candidate('google', 'target', { costClass: 'standard' }),
      ],
      offlineMode: false,
      requirements: {},
      policyRequiresApproval: false,
    });

    expect(result).toMatchObject({
      status: 'approval_required',
      reasons: ['cost_increase'],
    });
  });

  it('reports an already-selected target without mutation', () => {
    expect(
      planJarvisModelSwitch({
        intent: { kind: 'provider', providerId: 'google' },
        current: selection('google', 'gemini-pro'),
        candidates: [candidate('google', 'gemini-pro')],
        offlineMode: false,
        requirements: {},
        policyRequiresApproval: false,
      }),
    ).toMatchObject({ status: 'already_selected' });
  });

  it('uses exact previous-selection history for switch back and fails closed when absent', () => {
    const base = {
      intent: { kind: 'switch_back' } as const,
      current: selection('google', 'gemini-pro'),
      candidates: [
        candidate('google', 'gemini-pro'),
        candidate('openai', 'gpt-4o-mini', { costClass: 'low' }),
      ],
      offlineMode: false,
      requirements: {},
      policyRequiresApproval: false,
    };

    expect(
      planJarvisModelSwitch({
        ...base,
        previous: selection('openai', 'gpt-4o-mini'),
      }),
    ).toMatchObject({
      status: 'ready',
      target: { providerId: 'openai', modelId: 'gpt-4o-mini' },
    });
    expect(planJarvisModelSwitch(base)).toMatchObject({
      status: 'not_configured',
      reason: 'no_previous_selection',
    });
  });

  it('restores the exact previous connection instead of another connection for the same model', () => {
    const previous = connectedSelection('google', 'shared-model', 'google-account-b');
    const result = planJarvisModelSwitch({
      intent: { kind: 'switch_back' },
      current: selection('openai', 'current'),
      previous,
      candidates: [
        candidate('google', 'shared-model', {
          preferred: true,
          selection: connectedSelection('google', 'shared-model', 'google-account-a'),
        }),
        candidate('google', 'shared-model', {
          selection: previous,
        }),
      ],
      offlineMode: false,
      requirements: {},
      policyRequiresApproval: false,
    });

    expect(result).toMatchObject({
      status: 'ready',
      target: { connectionId: 'google-account-b' },
    });
  });

  it('returns detached frozen output and drops undeclared credential-like fields', () => {
    const source = candidate('google', 'gemini-pro') as JarvisModelSwitchCandidate & {
      apiKey?: string;
      error?: string;
    };
    source.apiKey = 'must-not-escape';
    source.error = 'private provider error';
    const result = planJarvisModelSwitch({
      intent: { kind: 'provider', providerId: 'google' },
      current: selection('openai', 'gpt-4o-mini'),
      candidates: [source],
      offlineMode: false,
      requirements: {},
      policyRequiresApproval: false,
    });

    source.selection.modelId = 'mutated';
    expect(result).toMatchObject({
      status: 'ready',
      target: { providerId: 'google', modelId: 'gemini-pro' },
    });
    expect(JSON.stringify(result)).not.toMatch(/must-not-escape|private provider error|apiKey/);
    expect(Object.isFrozen(result)).toBe(true);
    if ('target' in result) expect(Object.isFrozen(result.target)).toBe(true);
  });
});
