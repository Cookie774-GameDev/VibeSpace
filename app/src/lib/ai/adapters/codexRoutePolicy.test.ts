import { describe, expect, it } from 'vitest';
import { CODEX_CLI_CONNECTION, OPENCODE_CLI_CONNECTION } from './catalog';
import { resolveCodexRoute, type CodexRouteCapability, type CodexRouteInput } from './codexRoutePolicy';

const official: CodexRouteInput = {
  runtime: 'codex', accountId: 'account-route-test', connection: CODEX_CLI_CONNECTION,
  providerId: 'openai', modelId: 'gpt-selected', now: 100,
};
const connected: CodexRouteInput = {
  ...official, connection: OPENCODE_CLI_CONNECTION,
  providerId: 'opencode', modelId: 'provider/model-selected',
};
const capability: CodexRouteCapability = {
  authority: 'native-owned', accountId: 'account-route-test', connectionId: 'opencode-cli',
  modelId: 'provider/model-selected', providerId: 'provider', upstreamModelId: 'model-selected',
  routeHandle: 'codex-route-12345678', configurationGeneration: 'generation-1',
  expiresAt: 1000, authenticated: true, wireProtocol: 'responses',
  contract: 'codex-responses-v1', route: 'direct-responses',
  supportedEfforts: ['low', 'high'], supportedServiceTiers: ['default'],
  supports: { tools: true, cancellation: true, streaming: true, usage: true, reasoning: true },
};

describe('explicit Codex routing policy', () => {
  it('keeps the exact ChatGPT connection direct and requires native model capability validation', () => {
    expect(resolveCodexRoute(official)).toMatchObject({ kind: 'official-codex', runtime: 'codex',
      connectionId: 'openai-codex', modelId: 'gpt-selected', providerId: 'openai',
      authSource: 'codex-cli-session', requiresNativeCatalog: true });
  });

  it('canonicalizes only an explicit OpenAI catalog alias for the exact Codex connection', () => {
    expect(resolveCodexRoute({ ...official, providerId: 'opencode', modelId: 'openai/gpt-selected' }))
      .toMatchObject({ kind: 'official-codex', modelId: 'gpt-selected' });
    expect(resolveCodexRoute({ ...official, providerId: 'opencode', modelId: 'gpt-selected' }).kind)
      .toBe('unavailable');
  });

  it.each(['provider/gpt-selected', 'openai/provider/model', 'gpt-selected/other'])(
    'does not turn a slash in %s into permission to start a translator', (modelId) => {
      expect(resolveCodexRoute({ ...official, modelId }).kind).toBe('unavailable');
      expect(resolveCodexRoute({ ...connected, modelId }).kind).toBe('unavailable');
    },
  );

  it('never sends an explicit OpenCode-native selection through Codex or a translator', () => {
    expect(resolveCodexRoute({ ...connected, runtime: 'opencode' }))
      .toMatchObject({ kind: 'opencode-native', runtime: 'opencode', connectionId: 'opencode-cli',
        modelId: 'provider/model-selected', providerId: 'opencode' });
  });

  it('does not infer Responses compatibility from an SDK name, URL, model name or login', () => {
    expect(resolveCodexRoute(connected)).toMatchObject({ kind: 'unavailable', code: 'route_unverified' });
    expect(resolveCodexRoute({ ...connected, capability: { ...capability, contract: 'http-200' } as unknown as CodexRouteCapability }))
      .toMatchObject({ kind: 'unavailable', code: 'route_unverified' });
  });

  it('selects verified direct Responses without translation and retains source identity', () => {
    const result = resolveCodexRoute({ ...connected, capability, reasoningEffort: 'high' });
    expect(result).toMatchObject({ kind: 'direct-responses', runtime: 'codex', providerId: 'provider',
      modelId: 'provider/model-selected', upstreamModelId: 'model-selected',
      connectionId: 'opencode-cli', routeHandle: capability.routeHandle,
      configurationGeneration: 'generation-1', reasoningEffort: 'high' });
    expect(JSON.stringify(result)).not.toMatch(/https?:|apiKey|bearer|password/i);
    expect(Object.isFrozen(result)).toBe(true);
  });

  it('uses translation only for an exact native-owned reviewed adapter capability', () => {
    const translated: CodexRouteCapability = { ...capability, route: 'opencodex-translation',
      wireProtocol: 'chat-completions', contract: 'reviewed-opencodex-v1',
      adapter: 'openai-chat', translatorVerified: true };
    expect(resolveCodexRoute({ ...connected, capability: translated })).toMatchObject({
      kind: 'opencodex-translation', providerId: 'provider', modelId: 'provider/model-selected',
      adapter: 'openai-chat', routeHandle: capability.routeHandle });
    const responsesTranslated: CodexRouteCapability = {
      ...translated,
      wireProtocol: 'responses',
      adapter: 'openai-responses',
    };
    expect(resolveCodexRoute({ ...connected, capability: responsesTranslated })).toMatchObject({
      kind: 'opencodex-translation', adapter: 'openai-responses',
      routeHandle: capability.routeHandle,
    });
    expect(resolveCodexRoute({ ...connected, capability: { ...translated, translatorVerified: false } }).kind)
      .toBe('unavailable');
  });

  it.each([
    ['account', { accountId: 'other-account' }], ['connection', { connectionId: 'other-connection' }],
    ['model', { modelId: 'provider/other-model' }], ['expired', { expiresAt: 100 }],
    ['unauthenticated', { authenticated: false }], ['missing handle', { routeHandle: '' }],
    ['renderer authority', { authority: 'renderer' }], ['invalid generation', { configurationGeneration: '' }],
  ] as const)('rejects a mismatched %s capability before prompt dispatch', (_name, replacement) => {
    expect(resolveCodexRoute({ ...connected, capability: { ...capability, ...replacement } as CodexRouteCapability }).kind)
      .toBe('unavailable');
  });

  it('does not silently replace unsupported reasoning, service tier, or tool semantics', () => {
    expect(resolveCodexRoute({ ...connected, capability, reasoningEffort: 'max' }))
      .toMatchObject({ kind: 'unavailable', code: 'unsupported_effort' });
    expect(resolveCodexRoute({ ...connected, capability, serviceTier: 'fast' }))
      .toMatchObject({ kind: 'unavailable', code: 'unsupported_service_tier' });
    expect(resolveCodexRoute({ ...connected, capability: { ...capability,
      supports: { ...capability.supports, tools: false } } }))
      .toMatchObject({ kind: 'unavailable', code: 'unsupported_semantics' });
  });

  it('requires a new chat rather than changing a started conversation backend', () => {
    expect(resolveCodexRoute({ ...official, affinity: { runtime: 'opencode', locked: true } }))
      .toMatchObject({ kind: 'unavailable', code: 'backend_locked', requiresNewChat: true });
    expect(resolveCodexRoute({ ...official, affinity: { runtime: 'opencode', locked: false } }).kind)
      .toBe('official-codex');
  });

  it('does not allow a renamed or disabled connection to borrow official Codex authentication', () => {
    for (const connection of [
      { ...CODEX_CLI_CONNECTION, enabled: false },
      { ...CODEX_CLI_CONNECTION, id: 'unrelated-connection' },
      { ...CODEX_CLI_CONNECTION, authSource: 'unrelated-login' },
      { ...CODEX_CLI_CONNECTION, providerId: 'unrelated-provider' },
    ]) expect(resolveCodexRoute({ ...official, connection }).kind).toBe('unavailable');
  });
});
