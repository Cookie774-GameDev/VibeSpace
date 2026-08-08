import type { ProviderId } from '@/types';
import type { Agent } from '@/types';
import type { PlanId } from '@/lib/entitlements';
import type { StackPresetId } from '@/lib/ai/stacks/types';
import type { ParsedStackSlashCommand } from '@/lib/ai/stacks/classifier';
import { classifyStackTask, parseStackSlashCommand } from '@/lib/ai/stacks/classifier';
import { isHiveProductEnabled } from '@/lib/features/hiveProductGate';
import { getProviderDisplayName } from './providerRegistry';
import {
  getAccessibleModelOptions,
  getAccessibleProviders,
  type ModelOption,
} from './models';
import { getModelLabelForProvider } from './providerModelCatalog';
import { coerceToExposedPreset, stepsForPreset } from './stacks/presets';
import { isProviderConnected, type ProviderConnectionContext } from './providerRegistry';
import { agentUsesDefaultProvider } from './agentProviderOptions';
import { describeVisionRequirement, selectionSupportsVision } from './vision';
import type {
  ConnectionMode,
  ProviderCapabilities,
  ProviderConnection,
} from './adapters/types';
import { getProviderConnectionDescriptor } from './adapters/catalog';
import {
  isKernelSmokeBindingActive,
  KERNEL_SMOKE_PROVIDER_ID,
} from './providers/kernelSmoke';
import { isProtectedJarvisAgent } from '@/lib/jarvis/identity';

type ConnectedSingleSelection = {
  connectionId: string;
  connectionMode: ConnectionMode;
  authSource: string;
  capabilities: ProviderCapabilities;
};

type LegacySingleSelection = {
  connectionId?: never;
  connectionMode?: never;
  authSource?: never;
  capabilities?: never;
};

export type ChatModelSelection =
  | { mode: 'none' }
  | ({ mode: 'single'; providerId: ProviderId; modelId: string } & (
      | ConnectedSingleSelection
      | LegacySingleSelection
    ))
  | { mode: 'hive'; hiveId: Exclude<StackPresetId, 'off'> };

export const EMPTY_CHAT_MODEL_SELECTION: ChatModelSelection = { mode: 'none' };

export const CHOOSE_MODEL_LABEL = 'Choose model';

export type ModelSelectionContext = ProviderConnectionContext;

export type ModelSelectionValidation =
  | { ok: true; selection: ChatModelSelection }
  | { ok: false; message: string };

const HIVE_LABELS: Record<Exclude<StackPresetId, 'off'>, string> = {
  fast: 'Hive Balanced',
  balanced: 'Hive Balanced',
  quality: 'Hive Balanced',
  ultra: 'Hive Balanced',
  custom: 'Hive Balanced',
};

const CAPABILITY_KEYS = [
  'text',
  'images',
  'files',
  'tools',
  'modelSelection',
  'structuredOutput',
  'streaming',
  'cancellation',
  'resumeSession',
  'systemPrompt',
  'workingDirectory',
  'usage',
  'subscriptionQuota',
  'localOnly',
] as const satisfies readonly (keyof ProviderCapabilities)[];

const CONNECTION_METADATA_KEYS = [
  'connectionId',
  'connectionMode',
  'authSource',
  'capabilities',
] as const;

function normalizeCapabilities(raw: unknown): ProviderCapabilities | null {
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as Record<string, unknown>;
  if (!CAPABILITY_KEYS.every((key) => typeof record[key] === 'boolean')) return null;
  return Object.fromEntries(
    CAPABILITY_KEYS.map((key) => [key, record[key]]),
  ) as unknown as ProviderCapabilities;
}

function normalizeSingleConnection(raw: Record<string, unknown>): ConnectedSingleSelection | null {
  const connectionId = typeof raw.connectionId === 'string' ? raw.connectionId.trim() : '';
  const authSource = typeof raw.authSource === 'string' ? raw.authSource.trim() : '';
  const connectionMode = raw.connectionMode;
  const capabilities = normalizeCapabilities(raw.capabilities);
  if (
    !connectionId ||
    !authSource ||
    (connectionMode !== 'external-cli' && connectionMode !== 'native-api' && connectionMode !== 'local') ||
    !capabilities
  ) {
    return null;
  }
  return { connectionId, connectionMode, authSource, capabilities };
}

export function normalizeChatModelSelection(
  raw: unknown,
): ChatModelSelection {
  if (!raw || typeof raw !== 'object') return EMPTY_CHAT_MODEL_SELECTION;
  const value = raw as Partial<ChatModelSelection> & Record<string, unknown>;
  if (value.mode === 'single') {
    const providerId = value.providerId;
    const modelId = typeof value.modelId === 'string' ? value.modelId.trim() : '';
    if (!providerId || !modelId) return EMPTY_CHAT_MODEL_SELECTION;
    const connection = normalizeSingleConnection(value);
    if (connection) return { mode: 'single', providerId, modelId, ...connection };
    if (CONNECTION_METADATA_KEYS.some((key) => key in value)) {
      return EMPTY_CHAT_MODEL_SELECTION;
    }
    return { mode: 'single', providerId, modelId };
  }
  if (value.mode === 'hive') {
    const hiveId = value.hiveId;
    if (hiveId === 'fast' || hiveId === 'balanced' || hiveId === 'quality' || hiveId === 'ultra' || hiveId === 'custom') {
      const exposed = coerceToExposedPreset(hiveId);
      return exposed === 'off' ? EMPTY_CHAT_MODEL_SELECTION : { mode: 'hive', hiveId: exposed };
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
    const exposed = coerceToExposedPreset(args.stackPreset);
    return exposed === 'off' ? EMPTY_CHAT_MODEL_SELECTION : { mode: 'hive', hiveId: exposed };
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
  // Product gate: never start multi-model Hive stacks while scrapped.
  // Kernel smoke may still exercise custom stacks when its binding is active.
  if (!isHiveProductEnabled()) {
    if (
      isKernelSmokeBindingActive() &&
      selection.mode === 'hive' &&
      selection.hiveId === 'custom'
    ) {
      return 'custom';
    }
    return 'off';
  }
  if (stackSlash.preset) return coerceToExposedPreset(stackSlash.preset);
  if (
    selection.mode === 'hive' &&
    selection.hiveId === 'custom' &&
    isKernelSmokeBindingActive()
  ) {
    return 'custom';
  }
  if (selection.mode === 'hive') return coerceToExposedPreset(selection.hiveId);
  return 'off';
}

/**
 * Neutralize Hive selection when the product surface is gated so stale
 * persistence and deep-link state cannot keep multi-model mode active.
 */
export function gateChatModelSelection(selection: ChatModelSelection): ChatModelSelection {
  if (selection.mode === 'hive' && !isHiveProductEnabled()) {
    // Preserve kernel-smoke custom hive only while the smoke binding is live.
    if (selection.hiveId === 'custom' && isKernelSmokeBindingActive()) {
      return selection;
    }
    return EMPTY_CHAT_MODEL_SELECTION;
  }
  return selection;
}

function localModelIdsMatch(left: string, right: string): boolean {
  const a = left.trim().toLowerCase();
  const b = right.trim().toLowerCase();
  if (!a || !b) return false;
  return a === b || a.startsWith(`${b}:`) || b.startsWith(`${a}:`);
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
  const exact = options.find((option) => option.id === modelId);
  if (exact) return exact;
  // Ollama tags often differ by `:latest` vs explicit tag — accept either side.
  if (providerId === 'ollama' || providerId === 'local') {
    return options.find((option) => localModelIdsMatch(option.id, modelId)) ?? null;
  }
  return null;
}

function isAttestedKernelSmokeNativeSelection(
  selection: Extract<ChatModelSelection, { mode: 'single' }>,
  connection: Readonly<ProviderConnection> | undefined,
  ctx: ModelSelectionContext,
): boolean {
  return (
    selection.providerId === KERNEL_SMOKE_PROVIDER_ID &&
    selection.modelId === 'kernel-smoke-v1' &&
    connection?.id === 'vibespace-kernel-smoke-native' &&
    connection.mode === 'native-api' &&
    connection.authSource === 'debug-native-attestation' &&
    connection.capabilities.localOnly === true &&
    isProviderConnected(selection.providerId, ctx)
  );
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
  if (
    hiveId === 'custom' &&
    isKernelSmokeBindingActive() &&
    steps.every(
      (step) =>
        step.provider === KERNEL_SMOKE_PROVIDER_ID && step.model === 'kernel-smoke-v1',
    )
  ) {
    return true;
  }
  return steps.every((step) => {
    if (!getAccessibleProviders(ctx.apiKeys, ctx.offlineMode, ctx.plan, ctx.defaultLocalModel).includes(step.provider)) {
      return false;
    }
    if (!isProviderConnected(step.provider, ctx)) return false;
    if (hiveId === 'balanced') return true;
    return findAccessibleModel(step.provider, step.model, ctx) !== null;
  });
}

export function validateChatModelSelection(
  selection: ChatModelSelection,
  ctx: ModelSelectionContext,
  customSteps: Parameters<typeof stepsForPreset>[2],
  options?: { voice?: boolean; attachments?: { hasImages?: boolean; hasFiles?: boolean }; tools?: boolean },
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
    let exactConnection: Readonly<ProviderConnection> | undefined;
    if (selection.connectionId) {
      try {
        exactConnection = getProviderConnectionDescriptor(selection.connectionId);
      } catch {
        return { ok: false, message: `Unknown provider connection: ${selection.connectionId}` };
      }
      if (!exactConnection.enabled) {
        return { ok: false, message: `Provider connection is disabled: ${selection.connectionId}` };
      }
      if (exactConnection.providerId !== selection.providerId) {
        return { ok: false, message: 'The selected connection does not match this model provider.' };
      }
    }
    if (
      exactConnection?.mode !== 'external-cli' &&
      !isAttestedKernelSmokeNativeSelection(selection, exactConnection, ctx) &&
      !isSingleModelAvailable(selection, ctx)
    ) {
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
    const capabilities = exactConnection?.capabilities ?? selection.capabilities;
    if (options?.attachments?.hasImages && capabilities && !capabilities.images) {
      return { ok: false, message: 'The selected connection does not support image attachments.' };
    }
    if (options?.attachments?.hasFiles && capabilities && !capabilities.files) {
      return { ok: false, message: 'The selected connection does not support file attachments.' };
    }
    if (options?.tools && capabilities && !capabilities.tools) {
      return { ok: false, message: 'The selected connection does not support tools.' };
    }
    if (options?.attachments?.hasImages && !selectionSupportsVision(selection, customSteps)) {
      return {
        ok: false,
        message: describeVisionRequirement(selection),
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
  if (options?.attachments?.hasImages && !selectionSupportsVision(selection, customSteps)) {
    return {
      ok: false,
      message: describeVisionRequirement(selection),
    };
  }
  return { ok: true, selection };
}

export function canSendModelRequest(
  selection: ChatModelSelection,
  ctx: ModelSelectionContext,
  customSteps: Parameters<typeof stepsForPreset>[2],
  options?: { voice?: boolean; attachments?: { hasImages?: boolean; hasFiles?: boolean }; tools?: boolean },
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
  return `${selection.connectionId ?? selection.providerId}:${selection.modelId}`;
}

export function selectionFromOption(
  providerId: ProviderId,
  modelId: string,
  connection?: ProviderConnection,
): ChatModelSelection {
  const base = { mode: 'single' as const, providerId, modelId: modelId.trim() };
  if (!connection) return base;
  return {
    ...base,
    connectionId: connection.id,
    connectionMode: connection.mode,
    authSource: connection.authSource,
    capabilities: connection.capabilities,
  };
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
  if (
    !isProtectedJarvisAgent(agent) &&
    !agentUsesDefaultProvider(agent.model.provider, agent.model.model)
  ) {
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
  options?: { voice?: boolean; attachments?: { hasImages?: boolean; hasFiles?: boolean }; tools?: boolean },
): ModelSelectionValidation {
  const gatedSelection = gateChatModelSelection(selection);
  // Ignore /hive|/stack slash overrides while the product is gated.
  const stackSlash = isHiveProductEnabled()
    ? parseStackSlashCommand(text)
    : { matched: false as const, text };
  const stackPreset = resolveActiveStackPreset(gatedSelection, stackSlash);
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
  return validateChatModelSelection(gatedSelection, ctx, customSteps, options);
}
