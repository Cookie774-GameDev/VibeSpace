import type { Agent, AgentId } from '@/types';
import type { ProviderId } from '@/types/common';
import { useAuthStore } from '@/stores/auth';
import { runAgent } from '@/lib/ai/router';
import { applyChatModelSelectionToAgent } from '@/lib/ai/modelSelection';
import {
  defaultModelForProvider,
  getAccessibleModelOptions,
  getAccessibleProviders,
  getDiscoveredOllamaModels,
} from '@/lib/ai/models';
import { catalogDisplayName } from '@/lib/ai/localModelCatalog';

export interface AllAboutMeModelOption {
  id: string;
  label: string;
  provider: Exclude<ProviderId, 'mock'>;
  model: string;
  /** Local Ollama-style models vs cloud API / hosted. Optional for test fixtures. */
  kind?: 'local' | 'cloud';
}

function normalizeModelKey(provider: string, model: string): string {
  const p = provider === 'local' ? 'ollama' : provider;
  return `${p}\u0000${model.trim().toLowerCase().replace(/:latest$/, '')}`;
}

function friendlyLocalLabel(modelId: string): string {
  const display = catalogDisplayName(modelId);
  // Never surface catalog marketing labels like "Recommended".
  return display || modelId;
}

/**
 * Real, currently usable models for All About Me generation.
 * - Cloud: only providers the user can access (keys / hosted plan).
 * - Local: only models discovered as installed on Ollama (no phantom defaults).
 * - Dedupes ollama/local duplicates (same model listed twice).
 * - Exactly one selectable option per unique model; no "Recommended" labels.
 */
export function getAllAboutMeModelOptions(): AllAboutMeModelOption[] {
  const auth = useAuthStore.getState();
  const providers = getAccessibleProviders(
    auth.apiKeys,
    auth.offlineMode,
    auth.plan,
    auth.defaultLocalModel,
  ).filter((provider): provider is Exclude<ProviderId, 'mock'> => provider !== 'mock');

  const seen = new Set<string>();
  const options: AllAboutMeModelOption[] = [];
  let localHandled = false;

  for (const provider of providers) {
    const isLocalProvider = provider === 'ollama' || provider === 'local';
    if (isLocalProvider) {
      if (localHandled) continue;
      localHandled = true;
      // Only installed local models — do not invent options from defaultLocalModel alone.
      const installed = getDiscoveredOllamaModels();
      for (const name of installed) {
        const model = name.trim();
        if (!model) continue;
        const key = normalizeModelKey('ollama', model);
        if (seen.has(key)) continue;
        seen.add(key);
        options.push({
          id: `ollama:${model}`,
          label: friendlyLocalLabel(model),
          provider: 'ollama',
          model,
          kind: 'local',
        });
      }
      continue;
    }

    const accessible = getAccessibleModelOptions(
      provider,
      auth.apiKeys,
      auth.offlineMode,
      auth.defaultLocalModel,
      auth.plan,
    );
    for (const option of accessible) {
      if (option.provider === 'mock') continue;
      const model = option.id.trim();
      if (!model) continue;
      const key = normalizeModelKey(option.provider, model);
      if (seen.has(key)) continue;
      seen.add(key);
      const label = option.label.trim() || model;
      options.push({
        id: `${option.provider}:${model}`,
        label: /recommended/i.test(label) ? model : label,
        provider: option.provider as Exclude<ProviderId, 'mock'>,
        model,
        kind: 'cloud',
      });
    }
  }

  return options;
}

function makeProfileAgent(selection?: AllAboutMeModelOption): Agent {
  const auth = useAuthStore.getState();
  const provider = selection?.provider ?? auth.defaultProvider;
  const base: Agent = {
    id: 'agent_all_about_me_generator' as AgentId,
    slug: 'all-about-me-generator',
    name: 'All About Me Generator',
    description: 'Creates and revises the user personality profile for Jarvis.',
    system_prompt: [
      'You create `AllAboutMe.md` for VibeSpace.',
      'Return only markdown.',
      'Keep it detailed, useful, and grounded in the user-provided evidence.',
      'Never include credentials, secrets, or unsupported private facts.',
    ].join('\n'),
    model: {
      provider,
      model:
        selection?.model ||
        auth.selectedModels[provider] ||
        defaultModelForProvider(provider, auth.defaultLocalModel),
    },
    tools_allowed: [],
    memory_scope: 'agent',
    capabilities: ['writing'],
    temperature: 0.45,
    max_output_tokens: 2200,
    created_at: Date.now(),
    updated_at: Date.now(),
  };
  return selection ? base : applyChatModelSelectionToAgent(base, auth.chatModelSelection);
}

function actionableGenerationError(error: unknown, selection?: AllAboutMeModelOption): Error {
  const raw =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : 'Generation failed.';
  const lower = raw.toLowerCase();
  const isLocal = selection?.kind === 'local' || selection?.provider === 'ollama' || selection?.provider === 'local';

  if (
    isLocal &&
    (/fetch failed|failed to fetch|networkerror|econnrefused|connection refused|timeout|timed out|not reachable|unreachable|503|502|500|ollama/i.test(
      lower,
    ) ||
      lower.includes('11434'))
  ) {
    return new Error(
      'Local model runtime is unavailable. Start Ollama, confirm the model is installed under Settings → Local Models, then try Generate again.',
    );
  }
  if (isLocal && (/model .*not found|not found|pull/i.test(lower))) {
    return new Error(
      `Local model “${selection?.model ?? 'selected'}” is not installed. Download it in Settings → Local Models, then try again.`,
    );
  }
  if (/api key|unauthorized|401|403|invalid key/i.test(lower)) {
    return new Error(
      'This cloud model is not accessible right now. Check Settings → Providers for a valid key, or pick a connected local model.',
    );
  }
  return error instanceof Error ? error : new Error(raw);
}

export async function completeAllAboutMePrompt(
  prompt: string,
  selection?: AllAboutMeModelOption,
): Promise<string> {
  try {
    const response = await runAgent({
      agent: makeProfileAgent(selection),
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.45,
      max_output_tokens: 2200,
    });
    const text = response.text?.trim() ?? '';
    if (!text) {
      throw new Error('The model returned an empty response. Try another model or retry.');
    }
    return text;
  } catch (error) {
    throw actionableGenerationError(error, selection);
  }
}
