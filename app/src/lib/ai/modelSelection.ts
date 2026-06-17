import type { ProviderId } from '@/types';
import type { Agent } from '@/types';
import type { PlanId } from '@/lib/entitlements';
import type { StackPresetId } from '@/lib/ai/stacks/types';
import type { ParsedStackSlashCommand } from '@/lib/ai/stacks/classifier';
import { classifyStackTask, parseStackSlashCommand } from '@/lib/ai/stacks/classifier';
import { getProviderDisplayName } from './providerRegistry';
import {
  getAccessibleModelOptions,
  getAccessibleProviders,
  type ModelOption,
} from './models';
import { getModelLabelForProvider } from './providerModelCatalog';
import { stepsForPreset } from './stacks/presets';
import { isProviderConnected, type ProviderConnectionContext } from './providerRegistry';
import { agentUsesDefaultProvider } from './agentProviderOptions';

export type ChatModelSelection =
  | { mode: 'none' }
  | { mode: 'single'; providerId: ProviderId; modelId: string }
  | { mode: 'hive'; hiveId: Exclude<StackPresetId, 'off'> };

export const EMPTY_CHAT_MODEL_SELECTION: ChatModelSelection = { mode: 'none' };

export const CHOOSE_MODEL_LABEL = 'Choose model';

export type ModelSelectionContext = ProviderConnectionContext;

export type ModelSelectionValidation =
  | { ok: true; selection: ChatModelSelection }
  | { ok: false; message: string };

const HIVE_LABELS: Record<Exclude<StackPresetId, 'off'>, string> = {
  fast: 'Hive Fast',
  balanced: 'Hive Balanced',
  quality: 'Hive Quality',
  ultra: 'Hive Ultra',
  custom: 'Hive Custom',
};

export function normalizeChatModelSelection(
  raw: unknown,
): ChatModelSelection {
  if (!raw || typeof raw !== 'object') return EMPTY_CHAT_MODEL_SELECTION;
  const value = raw as Partial<ChatModelSelection>;
  if (value.mode === 'single') {
    const providerId = value.providerId;
    const modelId = typeof value.modelId === 'string' ? value.modelId.trim() : '';
    if (!providerId || !modelId) return EMPTY_CHAT_MODEL_SELECTION;
    return { mode: 'single', providerId, modelId };
  }
  if (value.mode === 'hive') {
    const hiveId = value.hiveId;
    if (hiveId === 'fast' || hiveId === 'balanced' || hiveId === 'quality' || hiveId === 'ultra' || hiveId === 'custom') {
      return { mode: 'hive', hiveId };
    }
    return EMPTY_CHAT_MODEL_SELECTION;
  }
  return EMPTY_CHAT_MODEL_SELECTION;
}

export function migrateLegacyModelSelection(args: {
  stackPreset: StackPresetId;
  defaultProvider: ProviderId;
  selectedModels: Partial<Record<ProviderId, string>>;
}): ChatModelSelection {
  if (args.stackPreset && args.stackPreset !== 'off') {
    return { mode: 'hive', hiveId: args.stackPreset };
  }
  const modelId = args.selectedModels[args.defaultProvider]?.trim();
  if (modelId && args.defaultProvider !== 'mock') {
    return { mode: 'single', providerId: args.defaultProvider, modelId };
  }
  return EMPTY_CHAT_MODEL_SELECTION;
}

export function resolveActiveStackPreset(
  selection: ChatModelSelection,
  stackSlash: ParsedStackSlashCommand,
): StackPresetId {
  if (stackSlash.preset) return stackSlash.preset;
  if (selection.mode === 'hive') return selection.hiveId;
  return 'off';
}

function findAccessibleModel(
  providerId: ProviderId,
  modelId: string,
  ctx: ModelSelectionContext,
): ModelOption | null {
  const options = getAccessibleModelOptions(
    providerId,
    ctx.apiKeys,
    ctx.offlineMode,
    ctx.defaultLocalModel,
    ctx.plan,
  );
  return options.find((option) => option.id === modelId) ?? null;
}

export function isSingleModelAvailable(
  selection: Extract<ChatModelSelection, { mode: 'single' }>,
  ctx: ModelSelectionContext,
): boolean {
  if (!getAccessibleProviders(ctx.apiKeys, ctx.offlineMode, ctx.plan, ctx.defaultLocalModel).includes(selection.providerId)) {
    return false;
  }
  return findAccessibleModel(selection.providerId, selection.modelId, ctx) !== null;
}

export function isHiveWorkflowReady(
  hiveId: Exclude<StackPresetId, 'off'>,
  ctx: ModelSelectionContext,
  customSteps: Parameters<typeof stepsForPreset>[2],
): boolean {
  const steps = stepsForPreset(hiveId, 'general', customSteps);
  if (steps.length === 0) return false;
  return steps.every((step) => {
    if (!getAccessibleProviders(ctx.apiKeys, ctx.offlineMode, ctx.plan, ctx.defaultLocalModel).includes(step.provider)) {
      return false;
    }
    if (!isProviderConnected(step.provider, ctx)) return false;
    return findAccessibleModel(step.provider, step.model, ctx) !== null;
  });
}

export function validateChatModelSelection(
  selection: ChatModelSelection,
  ctx: ModelSelectionContext,
  customSteps: Parameters<typeof stepsForPreset>[2],
  options?: { voice?: boolean },
): ModelSelectionValidation {
  if (selection.mode === 'none') {
    return {
      ok: false,
      message: options?.voice
        ? 'No model chosen. Choose a model before using JARVIS voice.'
        : 'No model chosen. Please choose a model before sending.',
    };
  }

  if (selection.mode === 'single') {
    if (!isSingleModelAvailable(selection, ctx)) {
      const needsKey = !isProviderConnected(selection.providerId, ctx);
      if (needsKey) {
        return {
          ok: false,
          message: 'This provider needs an API key before it can be used.',
        };
      }
      return {
        ok: false,
        message: 'Your selected model is unavailable. Choose another model before sending.',
      };
    }
    return { ok: true, selection };
  }

  if (!isHiveWorkflowReady(selection.hiveId, ctx, customSteps)) {
    return {
      ok: false,
      message: 'This Hive workflow is not ready. Check its models and providers before sending.',
    };
  }
  return { ok: true, selection };
}

export function canSendModelRequest(
  selection: ChatModelSelection,
  ctx: ModelSelectionContext,
  customSteps: Parameters<typeof stepsForPreset>[2],
  options?: { voice?: boolean },
): boolean {
  return validateChatModelSelection(selection, ctx, customSteps, options).ok;
}

export function formatChatModelSelectionLabel(
  selection: ChatModelSelection,
  ctx: ModelSelectionContext,
): string {
  if (selection.mode === 'none') return CHOOSE_MODEL_LABEL;
  if (selection.mode === 'hive') {
    return `Hive · ${HIVE_LABELS[selection.hiveId]}`;
  }
  const label = getModelLabelForProvider(selection.providerId, selection.modelId, ctx);
  const providerName = getProviderDisplayName(selection.providerId);
  if (label && label !== selection.modelId) return label;
  return `${providerName} · ${selection.modelId}`;
}

export function selectionOptionId(selection: ChatModelSelection): string | null {
  if (selection.mode !== 'single') return null;
  return `${selection.providerId}:${selection.modelId}`;
}

export function selectionFromOption(providerId: ProviderId, modelId: string): ChatModelSelection {
  return { mode: 'single', providerId, modelId: modelId.trim() };
}

export function selectionFromHive(hiveId: Exclude<StackPresetId, 'off'>): ChatModelSelection {
  return { mode: 'hive', hiveId };
}

/** Apply the composer’s explicit single-model choice to Jarvis / default-provider agents. */
export function applyChatModelSelectionToAgent(
  agent: Agent,
  selection: ChatModelSelection,
): Agent {
  if (selection.mode !== 'single') return agent;
  if (agent.slug !== 'jarvis' && !agentUsesDefaultProvider(agent.model.provider, agent.model.model)) {
    return agent;
  }
  return {
    ...agent,
    model: { provider: selection.providerId, model: selection.modelId },
  };
}

export function modelSelectionContextFromAuth(auth: {
  apiKeys: Partial<Record<ProviderId, string>>;
  offlineMode: boolean;
  plan: PlanId;
  defaultLocalModel: string;
}): ModelSelectionContext {
  return {
    apiKeys: auth.apiKeys,
    offlineMode: auth.offlineMode,
    plan: auth.plan,
    defaultLocalModel: auth.defaultLocalModel,
  };
}

/** Shared gate for typed chat, voice, and runtime before any model/Hive request. */
export function validateSendModelAccess(
  text: string,
  selection: ChatModelSelection,
  ctx: ModelSelectionContext,
  customSteps: Parameters<typeof stepsForPreset>[2],
  options?: { voice?: boolean },
): ModelSelectionValidation {
  const stackSlash = parseStackSlashCommand(text);
  const stackPreset = resolveActiveStackPreset(selection, stackSlash);
  const stackText = stackSlash.matched ? stackSlash.text : text;
  const taskType = stackSlash.taskType ?? classifyStackTask(stackText);
  const steps = stepsForPreset(stackPreset, taskType, customSteps);
  if (steps.length > 0 && stackPreset !== 'off') {
    return validateChatModelSelection(
      selectionFromHive(stackPreset as Exclude<StackPresetId, 'off'>),
      ctx,
      customSteps,
      options,
    );
  }
  return validateChatModelSelection(selection, ctx, customSteps, options);
}
