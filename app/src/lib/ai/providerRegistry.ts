import type { ProviderId } from '@/types';
import type { PlanId } from '@/lib/entitlements';
import { getAccessibleProviders, localModelsAvailable } from './models';
import { planIncludesHostedChat } from './agentProviderOptions';

/** User-facing provider label. Internal IDs (e.g. `google`) stay in persisted config. */
export const PROVIDER_DISPLAY_NAMES: Partial<Record<ProviderId, string>> = {
  anthropic: 'Claude / Anthropic',
  openai: 'OpenAI',
  google: 'Gemini',
  groq: 'Groq',
  deepseek: 'DeepSeek',
  ollama: 'Local Models',
  local: 'Local Models',
  openrouter: 'OpenRouter',
  mistral: 'Mistral',
  together: 'Together AI',
  xai: 'xAI',
  mock: 'Mock (demo)',
  cohere: 'Cohere',
  perplexity: 'Perplexity',
  fireworks: 'Fireworks',
  cerebras: 'Cerebras',
};

export type ProviderConnectionStatus =
  | 'connected'
  | 'hosted'
  | 'local'
  | 'missing_key'
  | 'offline';

export interface ProviderRegistryEntry {
  id: ProviderId;
  displayName: string;
  requiresApiKey: boolean;
  supportsDynamicListing: boolean;
  /** Providers eligible for Hive custom steps. */
  hiveEligible: boolean;
}

const HOSTED_WITHOUT_BYOK: readonly ProviderId[] = ['google', 'deepseek'];

export const PROVIDER_REGISTRY: readonly ProviderRegistryEntry[] = [
  { id: 'google', displayName: 'Gemini', requiresApiKey: true, supportsDynamicListing: true, hiveEligible: true },
  { id: 'anthropic', displayName: 'Claude / Anthropic', requiresApiKey: true, supportsDynamicListing: true, hiveEligible: true },
  { id: 'openai', displayName: 'OpenAI', requiresApiKey: true, supportsDynamicListing: true, hiveEligible: true },
  { id: 'groq', displayName: 'Groq', requiresApiKey: true, supportsDynamicListing: true, hiveEligible: true },
  { id: 'deepseek', displayName: 'DeepSeek', requiresApiKey: true, supportsDynamicListing: false, hiveEligible: true },
  { id: 'xai', displayName: 'xAI', requiresApiKey: true, supportsDynamicListing: false, hiveEligible: true },
  { id: 'openrouter', displayName: 'OpenRouter', requiresApiKey: true, supportsDynamicListing: true, hiveEligible: true },
  { id: 'mistral', displayName: 'Mistral', requiresApiKey: true, supportsDynamicListing: false, hiveEligible: true },
  { id: 'together', displayName: 'Together AI', requiresApiKey: true, supportsDynamicListing: false, hiveEligible: true },
  { id: 'ollama', displayName: 'Local Models', requiresApiKey: false, supportsDynamicListing: true, hiveEligible: true },
  { id: 'local', displayName: 'Local Models', requiresApiKey: false, supportsDynamicListing: true, hiveEligible: false },
  { id: 'mock', displayName: 'Mock (demo)', requiresApiKey: true, supportsDynamicListing: false, hiveEligible: false },
];

export const HIVE_STACK_PROVIDERS: ProviderId[] = PROVIDER_REGISTRY.filter((entry) => entry.hiveEligible).map(
  (entry) => entry.id,
);

export function getProviderDisplayName(providerId: ProviderId): string {
  return PROVIDER_DISPLAY_NAMES[providerId] ?? providerId;
}

export function getProviderRegistryEntry(providerId: ProviderId): ProviderRegistryEntry | undefined {
  return PROVIDER_REGISTRY.find((entry) => entry.id === providerId);
}

export function requiresApiKey(providerId: ProviderId): boolean {
  return getProviderRegistryEntry(providerId)?.requiresApiKey ?? true;
}

export function isLocalProvider(providerId: ProviderId): boolean {
  return providerId === 'ollama' || providerId === 'local';
}

export interface ProviderConnectionContext {
  apiKeys: Partial<Record<ProviderId, string>>;
  offlineMode: boolean;
  plan: PlanId;
  defaultLocalModel?: string;
}

export function getProviderConnectionStatus(
  providerId: ProviderId,
  ctx: ProviderConnectionContext,
): ProviderConnectionStatus {
  if (ctx.offlineMode) {
    return isLocalProvider(providerId) && localModelsAvailable(ctx.defaultLocalModel ?? '')
      ? 'local'
      : 'offline';
  }
  if (isLocalProvider(providerId)) {
    return localModelsAvailable(ctx.defaultLocalModel ?? '') ? 'local' : 'missing_key';
  }
  if (providerId === 'mock') {
    return ctx.apiKeys.mock?.trim() ? 'connected' : 'missing_key';
  }
  if (ctx.apiKeys[providerId]?.trim()) return 'connected';
  if (planIncludesHostedChat(ctx.plan) && HOSTED_WITHOUT_BYOK.includes(providerId)) {
    return 'hosted';
  }
  return 'missing_key';
}

export function isProviderConnected(providerId: ProviderId, ctx: ProviderConnectionContext): boolean {
  const status = getProviderConnectionStatus(providerId, ctx);
  return status === 'connected' || status === 'hosted' || status === 'local';
}

/** Providers the user can run right now (BYOK, hosted plan, or local). */
export function getConnectedProviders(ctx: ProviderConnectionContext): ProviderId[] {
  return getAccessibleProviders(
    ctx.apiKeys,
    ctx.offlineMode,
    ctx.plan,
    ctx.defaultLocalModel ?? '',
  );
}

export function formatProviderOptionLabel(
  providerId: ProviderId,
  ctx: ProviderConnectionContext,
): string {
  const name = getProviderDisplayName(providerId);
  const status = getProviderConnectionStatus(providerId, ctx);
  switch (status) {
    case 'connected':
      return `${name} — Connected`;
    case 'hosted':
      return `${name} — Included on your plan`;
    case 'local':
      return `${name} — No API key required`;
    case 'offline':
      return `${name} — Offline mode`;
    case 'missing_key':
      return `${name} — API key required`;
    default:
      return name;
  }
}
