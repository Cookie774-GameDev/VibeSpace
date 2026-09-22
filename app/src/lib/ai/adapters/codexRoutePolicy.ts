import type { ProviderConnection } from './types';

export type CodexRouteKind = 'official-codex' | 'direct-responses' | 'opencodex-translation';
export type CodexTranslationAdapter = 'openai-chat' | 'openai-responses' | 'anthropic' | 'google' | 'azure-openai';

/** Non-secret native evidence. The native launcher must revalidate its opaque
 * handle; constructing this object in JavaScript never grants credentials. */
export interface CodexRouteCapability {
  readonly authority: 'native-owned';
  readonly accountId: string;
  readonly connectionId: string;
  readonly modelId: string;
  readonly providerId: string;
  readonly upstreamModelId: string;
  readonly routeHandle: string;
  readonly configurationGeneration: string;
  readonly expiresAt: number;
  readonly authenticated: boolean;
  readonly route: 'direct-responses' | 'opencodex-translation';
  readonly wireProtocol: 'responses' | 'chat-completions' | 'anthropic' | 'google' | 'azure-openai';
  readonly contract: 'codex-responses-v1' | 'reviewed-opencodex-v1';
  readonly adapter?: CodexTranslationAdapter;
  readonly translatorVerified?: boolean;
  readonly supportedEfforts: readonly string[];
  readonly supportedServiceTiers: readonly string[];
  readonly supports: Readonly<{ tools: boolean; cancellation: boolean; streaming: boolean;
    usage: boolean; reasoning: boolean }>;
}
export interface CodexRouteInput {
  readonly runtime: 'codex' | 'opencode';
  readonly accountId?: string;
  readonly connection: Readonly<ProviderConnection>;
  readonly providerId: string;
  readonly modelId: string;
  readonly reasoningEffort?: string;
  readonly serviceTier?: string;
  readonly affinity?: Readonly<{ runtime: 'codex' | 'opencode'; locked: boolean }>;
  readonly capability?: Readonly<CodexRouteCapability>;
  readonly now: number;
}
export type CodexRouteUnavailableCode = 'invalid_selection' | 'connection_unavailable' |
  'backend_locked' | 'route_unverified' | 'capability_mismatch' |
  'unsupported_semantics' | 'unsupported_effort' | 'unsupported_service_tier';
export type CodexRouteDecision =
  | Readonly<{ kind: 'unavailable'; code: CodexRouteUnavailableCode; reason: string; requiresNewChat?: true }>
  | Readonly<{ kind: 'opencode-native'; runtime: 'opencode'; connectionId: string;
      providerId: string; modelId: string; authSource: string }>
  | Readonly<{ kind: 'official-codex'; runtime: 'codex'; connectionId: 'openai-codex';
      providerId: 'openai'; modelId: string; authSource: 'codex-cli-session';
      requiresNativeCatalog: true; reasoningEffort?: string; serviceTier?: string }>
  | Readonly<{ kind: 'direct-responses' | 'opencodex-translation'; runtime: 'codex';
      connectionId: string; providerId: string; modelId: string; upstreamModelId: string;
      authSource: string; routeHandle: string; configurationGeneration: string;
      adapter?: CodexTranslationAdapter; reasoningEffort?: string; serviceTier?: string }>;

const ID = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,255}$/u;
function identifier(value: unknown): value is string {
  return typeof value === 'string' && ID.test(value) &&
    !/^(?:sk-|gh[pousr]_|github_pat_|AIza|Bearer)/i.test(value);
}
function unavailable(code: CodexRouteUnavailableCode, reason: string, requiresNewChat = false): CodexRouteDecision {
  return Object.freeze({ kind: 'unavailable', code, reason, ...(requiresNewChat ? { requiresNewChat: true as const } : {}) });
}

/** Pure bounded route selection: no model-name heuristics, network, SDK or auth mutation. */
export function resolveCodexRoute(input: Readonly<CodexRouteInput>): CodexRouteDecision {
  const { connection, modelId, providerId, capability } = input;
  if (!connection?.enabled) return unavailable('connection_unavailable', 'The exact selected connection is unavailable.');
  if (!identifier(connection.id) || !identifier(modelId) || !identifier(providerId) ||
      !Number.isFinite(input.now) || input.now < 0) {
    return unavailable('invalid_selection', 'Select an exact provider, connection, and model.');
  }
  if (input.affinity?.locked && input.affinity.runtime !== input.runtime) {
    return unavailable('backend_locked', 'This conversation has started on another runtime. Start a new chat to switch.', true);
  }
  if (input.runtime === 'opencode') {
    return Object.freeze({ kind: 'opencode-native', runtime: 'opencode',
      connectionId: connection.id, providerId, modelId, authSource: connection.authSource });
  }
  if (input.runtime !== 'codex') return unavailable('invalid_selection', 'The selected runtime is unsupported.');
  const controls = {
    ...(input.reasoningEffort && input.reasoningEffort !== 'auto' ? { reasoningEffort: input.reasoningEffort } : {}),
    ...(input.serviceTier ? { serviceTier: input.serviceTier } : {}),
  };
  if (connection.id === 'openai-codex') {
    if (connection.providerId !== 'openai' || connection.authSource !== 'codex-cli-session' || connection.mode !== 'external-cli') {
      return unavailable('capability_mismatch', 'The selected connection cannot use official Codex authentication.');
    }
    const model = modelId.startsWith('openai/') && (providerId === 'openai' || providerId === 'opencode')
      ? modelId.slice('openai/'.length) : providerId === 'openai' ? modelId : '';
    if (!identifier(model) || model.includes('/')) {
      return unavailable('invalid_selection', 'Official Codex requires an exact model from its OpenAI catalog.');
    }
    // A route decision is not entitlement evidence. The app-server must finish
    // its paginated model/list validation before thread/start or prompt dispatch.
    return Object.freeze({ kind: 'official-codex', runtime: 'codex', connectionId: 'openai-codex',
      providerId: 'openai', modelId: model, authSource: 'codex-cli-session',
      requiresNativeCatalog: true, ...controls });
  }
  if (!capability) return unavailable('route_unverified',
    'This provider has no verified Codex route. Keep it on its native runtime or verify a supported connection.');
  if (capability.authority !== 'native-owned' || !input.accountId ||
      capability.accountId !== input.accountId || capability.connectionId !== connection.id ||
      capability.modelId !== modelId || !capability.authenticated ||
      !identifier(capability.routeHandle) || !identifier(capability.configurationGeneration) ||
      !identifier(capability.providerId) || !identifier(capability.upstreamModelId) ||
      !Number.isFinite(capability.expiresAt) || capability.expiresAt <= input.now) {
    return unavailable('capability_mismatch', 'The native route is expired or does not match this account, connection, and model.');
  }
  const supports = capability.supports;
  if (!supports?.tools || !supports.cancellation || !supports.streaming || !supports.usage ||
      (controls.reasoningEffort && !supports.reasoning)) {
    return unavailable('unsupported_semantics', 'This connection does not preserve the required Codex tool, stream, usage, or cancellation contract.');
  }
  if (controls.reasoningEffort && (!Array.isArray(capability.supportedEfforts) ||
      capability.supportedEfforts.length > 16 || !capability.supportedEfforts.includes(controls.reasoningEffort))) {
    return unavailable('unsupported_effort', 'The selected reasoning effort is not supported by this exact route.');
  }
  if (controls.serviceTier && (!Array.isArray(capability.supportedServiceTiers) ||
      capability.supportedServiceTiers.length > 16 || !capability.supportedServiceTiers.includes(controls.serviceTier))) {
    return unavailable('unsupported_service_tier', 'The selected service tier is not supported by this exact route.');
  }
  const direct = capability.route === 'direct-responses' && capability.wireProtocol === 'responses'
    && capability.contract === 'codex-responses-v1';
  const translated = capability.route === 'opencodex-translation'
    && capability.contract === 'reviewed-opencodex-v1' && capability.translatorVerified === true
    && (capability.adapter === 'openai-chat' && capability.wireProtocol === 'chat-completions'
      || capability.adapter === 'openai-responses' && capability.wireProtocol === 'responses'
      || capability.adapter === 'anthropic' && capability.wireProtocol === 'anthropic'
      || capability.adapter === 'google' && capability.wireProtocol === 'google'
      || capability.adapter === 'azure-openai' && capability.wireProtocol === 'azure-openai');
  if (!direct && !translated) return unavailable('route_unverified', 'Native semantic verification is missing for this route.');
  return Object.freeze({ kind: direct ? 'direct-responses' : 'opencodex-translation', runtime: 'codex',
    connectionId: connection.id, providerId: capability.providerId, modelId,
    upstreamModelId: capability.upstreamModelId, authSource: connection.authSource,
    routeHandle: capability.routeHandle, configurationGeneration: capability.configurationGeneration,
    ...(translated ? { adapter: capability.adapter } : {}), ...controls });
}
