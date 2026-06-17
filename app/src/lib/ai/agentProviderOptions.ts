import type { ProviderId } from '@/types';
import type { PlanId } from '@/lib/entitlements';
import {
  defaultModelForProvider,
  getAccessibleModelOptions,
  getAccessibleProviders,
} from './models';
import { getProviderDisplayName } from './providerRegistry';

/** Stored on mock agents that should follow Settings → Default provider at runtime. */
export const AGENT_DEFAULT_PROVIDER_MODEL = 'default-provider';

export type AgentEditorProviderChoice = ProviderId | 'default';

const PROVIDER_LABELS: Partial<Record<ProviderId, string>> = {
  mock: 'Mock (demo)',
};

export function describeProviderLabel(provider: ProviderId): string {
  return PROVIDER_LABELS[provider] ?? getProviderDisplayName(provider);
}

/** Providers included in paid hosted chat (BYOK not required). */
const SUBSCRIPTION_HOSTED_PROVIDERS: readonly ProviderId[] = ['google', 'deepseek'];

export function agentUsesDefaultProvider(provider: ProviderId, model: string): boolean {
  return provider === 'mock' && model === AGENT_DEFAULT_PROVIDER_MODEL;
}

export function planIncludesHostedChat(plan: PlanId): boolean {
  return plan !== 'free';
}

export function isDefaultProviderSelectable(
  provider: ProviderId,
  apiKeys: Partial<Record<ProviderId, string>>,
  offlineMode: boolean,
  plan: PlanId,
  localDefault = '',
): boolean {
  const accessible = getAccessibleProviders(apiKeys, offlineMode, plan, localDefault);
  if (accessible.includes(provider)) return true;
  if (provider === 'mock') return Boolean(apiKeys.mock?.trim());
  if (planIncludesHostedChat(plan) && SUBSCRIPTION_HOSTED_PROVIDERS.includes(provider)) {
    return true;
  }
  return false;
}

export function describeDefaultProviderLabel(defaultProvider: ProviderId): string {
  if (defaultProvider === 'mock') return 'Mock (demo)';
  return describeProviderLabel(defaultProvider);
}

export interface AgentEditorProviderOption {
  id: AgentEditorProviderChoice;
  label: string;
}

export function getAgentEditorProviderOptions(args: {
  apiKeys: Partial<Record<ProviderId, string>>;
  offlineMode: boolean;
  plan: PlanId;
  defaultProvider: ProviderId;
  defaultLocalModel?: string;
}): AgentEditorProviderOption[] {
  const accessible = getAccessibleProviders(
    args.apiKeys,
    args.offlineMode,
    args.plan,
    args.defaultLocalModel ?? '',
  );
  const options: AgentEditorProviderOption[] = [
    {
      id: 'default',
      label: `Default provider (${describeDefaultProviderLabel(args.defaultProvider)})`,
    },
  ];

  for (const provider of accessible) {
    if (provider === 'local') continue;
    options.push({
      id: provider,
      label: describeProviderLabel(provider),
    });
  }

  return options;
}

export function agentEditorProviderFromAgent(
  provider: ProviderId,
  model: string,
): AgentEditorProviderChoice {
  if (agentUsesDefaultProvider(provider, model)) return 'default';
  return provider;
}

export function agentModelFromEditorChoice(
  choice: AgentEditorProviderChoice,
  currentProvider: ProviderId,
  currentModel: string,
  apiKeys: Partial<Record<ProviderId, string>>,
  offlineMode: boolean,
  plan: PlanId,
  defaultLocalModel: string,
): { provider: ProviderId; model: string } {
  if (choice === 'default') {
    return { provider: 'mock', model: AGENT_DEFAULT_PROVIDER_MODEL };
  }

  const models = getAccessibleModelOptions(
    choice,
    apiKeys,
    offlineMode,
    defaultLocalModel,
    plan,
  );
  const keepCurrent =
    choice === currentProvider && models.some((option) => option.id === currentModel);
  return {
    provider: choice,
    model: keepCurrent ? currentModel : (models[0]?.id ?? defaultModelForProvider(choice)),
  };
}
