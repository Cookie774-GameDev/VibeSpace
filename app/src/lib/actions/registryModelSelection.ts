import type { PlanId } from '@/lib/entitlements';
import type { ProviderId } from '@/types';
import { useAuthStore } from '@/stores/auth';
import {
  modelSelectionContextFromAuth,
  type ChatModelSelection,
  selectionFromOption,
  validateChatModelSelection,
  type ModelSelectionValidation,
} from '@/lib/ai/modelSelection';
import { CHAT_MODEL_OPTIONS, getAccessibleModelOptions, type ModelOption } from '@/lib/ai/models';
import { CONNECTION_MODEL_OPTIONS, PROVIDER_CONNECTIONS } from '@/lib/ai/adapters/catalog';
import type { ProviderConnection } from '@/lib/ai/adapters/types';
import {
  isConnectionSessionChecked,
  readConnectionPickerStates,
  readConnectionSessionPickerStates,
  type ConnectionPickerState,
} from '@/lib/ai/connectionState';
import { modelSupportsVision } from '@/lib/ai/vision';
import type { StackStepSpec } from '@/lib/ai/stacks/types';
import { HIVE_BALANCE_PRICING, stepsForPreset } from '@/lib/ai/stacks/presets';
import {
  parseJarvisModelSwitchIntent,
  planJarvisModelSwitch,
  type JarvisHiveBalancedAssessment,
  type JarvisModelCostClass,
  type JarvisModelSwitchCandidate,
} from '@/lib/jarvis/modelSwitchDecision';
import { deepFreezeJarvisCopy } from '@/lib/jarvis/requestEnvelope';
import type { ActionDef, ActionResult, ActionRunContext } from './types';

type SingleModelSelection = Extract<ChatModelSelection, { mode: 'single' }>;

export interface JarvisModelSelectionActionState {
  chatModelSelection: ChatModelSelection;
  previousChatModelSelection: ChatModelSelection;
  jarvisAutoApprove: boolean;
  selectedModels: Partial<Record<ProviderId, string>>;
  apiKeys: Partial<Record<ProviderId, string>>;
  offlineMode: boolean;
  plan: PlanId;
  defaultLocalModel: string;
  stackCustomSteps: readonly StackStepSpec[];
}

export interface JarvisModelSwitchCandidateBuildOptions {
  connections?: readonly Readonly<ProviderConnection>[];
  connectionStates?: Partial<Record<string, ConnectionPickerState>>;
  modelOptions?: readonly ModelOption[];
}

export type JarvisModelSwitchRequirements = Readonly<{
  images?: boolean;
  tools?: boolean;
}>;

export interface ModelSelectionActionDependencies {
  getState: () => JarvisModelSelectionActionState;
  buildCandidates: (
    state: JarvisModelSelectionActionState,
  ) => readonly JarvisModelSwitchCandidate[];
  applySelection: (selection: ChatModelSelection) => void;
  validateSelection?: (
    selection: ChatModelSelection,
    state: JarvisModelSelectionActionState,
    requirements: JarvisModelSwitchRequirements,
  ) => ModelSelectionValidation;
}

function sameSelection(left: ChatModelSelection, right: ChatModelSelection): boolean {
  if (left.mode !== right.mode) return false;
  if (left.mode === 'none' || right.mode === 'none') return true;
  if (left.mode === 'hive' && right.mode === 'hive') return left.hiveId === right.hiveId;
  return (
    left.mode === 'single' &&
    right.mode === 'single' &&
    left.providerId === right.providerId &&
    left.modelId === right.modelId &&
    left.connectionId === right.connectionId
  );
}

type VerifiedModelMetadata = Readonly<{
  contextWindowTokens?: number;
  maximumCostPerMillionUsd?: number;
  costMetadataSource?: 'exact_rate_table' | 'embedded_snapshot' | 'local';
}>;

function exactCatalogMetadata(
  providerId: ProviderId,
  modelId: string,
  connection?: Readonly<ProviderConnection>,
): VerifiedModelMetadata {
  const chatOption = CHAT_MODEL_OPTIONS.find(
    (option) => option.provider === providerId && option.id === modelId,
  );
  const connectionOption = connection
    ? CONNECTION_MODEL_OPTIONS[connection.id]?.find((option) => option.id === modelId)
    : undefined;
  return {
    ...((connectionOption?.contextWindowTokens ?? chatOption?.contextWindowTokens)
      ? {
          contextWindowTokens:
            connectionOption?.contextWindowTokens ?? chatOption?.contextWindowTokens,
        }
      : {}),
    ...(chatOption?.maximumCostPerMillionUsd !== undefined &&
    chatOption.costMetadataSource === 'embedded_snapshot'
      ? {
          maximumCostPerMillionUsd: chatOption.maximumCostPerMillionUsd,
          costMetadataSource: chatOption.costMetadataSource,
        }
      : {}),
  };
}

function modelCostMetadata(
  providerId: ProviderId,
  modelId: string,
  mode: ProviderConnection['mode'] | undefined,
  catalogMetadata: VerifiedModelMetadata,
): Pick<
  JarvisModelSwitchCandidate,
  'costClass' | 'maximumCostPerMillionUsd' | 'costMetadataSource'
> {
  if (mode === 'external-cli') return { costClass: 'unknown' };
  if (mode === 'local' || providerId === 'ollama' || providerId === 'local') {
    return {
      costClass: 'free',
      maximumCostPerMillionUsd: 0,
      costMetadataSource: 'local',
    };
  }
  if (
    catalogMetadata.maximumCostPerMillionUsd !== undefined &&
    catalogMetadata.costMetadataSource === 'embedded_snapshot'
  ) {
    return {
      costClass: costClassForRate(catalogMetadata.maximumCostPerMillionUsd),
      maximumCostPerMillionUsd: catalogMetadata.maximumCostPerMillionUsd,
      costMetadataSource: catalogMetadata.costMetadataSource,
    };
  }
  return { costClass: 'unknown' };
}

function costClassForRate(maximumRate: number): JarvisModelCostClass {
  if (!Number.isFinite(maximumRate) || maximumRate < 0) return 'unknown';
  if (maximumRate === 0) return 'free';
  if (maximumRate <= 1) return 'low';
  if (maximumRate <= 10) return 'standard';
  return 'premium';
}

function codingRank(modelId: string): number {
  const model = modelId.toLowerCase();
  if (model.includes('codex')) return 100;
  if (model.includes('gpt-5.5-pro')) return 98;
  if (model.includes('claude-opus') || model.includes('claude-fable')) return 96;
  if (model.includes('gemini-3.1-pro')) return 94;
  if (model.includes('grok-4.3')) return 92;
  if (model.includes('deepseek-reasoner')) return 90;
  if (model.includes('gpt-5.5')) return 88;
  if (model.includes('sonnet')) return 85;
  if (model.includes('gpt-4o')) return 80;
  return 50;
}

function connectionSpeedRank(connection?: Readonly<ProviderConnection>): number | undefined {
  if (!connection) return undefined;
  const transportRank =
    connection.mode === 'native-api' ? 70 : connection.mode === 'local' ? 60 : 50;
  return connection.capabilities.streaming ? transportRank : transportRank - 10;
}

function toolReliabilityRank(connection?: Readonly<ProviderConnection>): number {
  if (!connection?.capabilities.tools) return 0;
  if (connection.mode === 'native-api') return 90;
  if (connection.mode === 'local') return 80;
  return 70;
}

function uniqueModelOptions(
  state: JarvisModelSelectionActionState,
  supplied?: readonly ModelOption[],
  connections: readonly Readonly<ProviderConnection>[] = PROVIDER_CONNECTIONS,
): readonly ModelOption[] {
  if (supplied) return supplied;
  const options: ModelOption[] = [...CHAT_MODEL_OPTIONS];
  for (const connection of connections) {
    const exactModels = CONNECTION_MODEL_OPTIONS[connection.id] ?? [];
    options.push(
      ...exactModels.map((model) => ({
        provider: connection.providerId as ProviderId,
        id: model.id,
        label: model.label,
        contextWindowTokens: model.contextWindowTokens,
      })),
    );
  }
  for (const provider of ['ollama', 'local'] as const) {
    options.push(
      ...getAccessibleModelOptions(
        provider,
        state.apiKeys,
        state.offlineMode,
        state.defaultLocalModel,
        state.plan,
      ),
    );
  }
  const seen = new Set<string>();
  return options.filter((option) => {
    const key = `${option.provider}\u0000${option.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function preferredConnectionId(
  state: JarvisModelSelectionActionState,
  option: ModelOption,
  connections: readonly Readonly<ProviderConnection>[],
): string | undefined {
  const current = state.chatModelSelection;
  if (
    current.mode === 'single' &&
    current.providerId === option.provider &&
    current.modelId === option.id &&
    current.connectionId
  ) {
    return current.connectionId;
  }
  return (
    connections.find((connection) => connection.mode !== 'external-cli')?.id ?? connections[0]?.id
  );
}

function isPreferredCandidate(
  state: JarvisModelSelectionActionState,
  option: ModelOption,
  connectionId: string | undefined,
  providerConnections: readonly Readonly<ProviderConnection>[],
): boolean {
  const current = state.chatModelSelection;
  const currentMatch =
    current.mode === 'single' &&
    current.providerId === option.provider &&
    current.modelId === option.id;
  const configuredMatch = state.selectedModels[option.provider] === option.id;
  if (!currentMatch && !configuredMatch) return false;
  return connectionId === preferredConnectionId(state, option, providerConnections);
}

function observedConnectionState(
  connection: Readonly<ProviderConnection>,
  states: Partial<Record<string, ConnectionPickerState>>,
): Readonly<{ connected: boolean; available: boolean }> {
  const observed = states[connection.id];
  if (observed) {
    const connected = observed.available && observed.auth === 'authenticated';
    return { connected, available: connected };
  }
  if (connection.mode === 'external-cli') {
    return { connected: false, available: false };
  }
  return { connected: false, available: false };
}

/**
 * Project model-picker and authenticated connection truth into the small,
 * immutable decision contract used by JARVIS. No credentials or probe details
 * are copied into the result.
 */
export function buildJarvisModelSwitchCandidates(
  state: JarvisModelSelectionActionState,
  options: JarvisModelSwitchCandidateBuildOptions = {},
): readonly JarvisModelSwitchCandidate[] {
  const connections = (options.connections ?? PROVIDER_CONNECTIONS).filter(
    (connection) => connection.enabled && connection.mode !== 'external-cli',
  );
  const connectionStates =
    options.connectionStates ??
    (() => {
      const persisted = readConnectionPickerStates();
      const session = readConnectionSessionPickerStates();
      return Object.fromEntries(
        connections.flatMap((connection) => {
          if (connection.mode === 'external-cli') {
            const state = isConnectionSessionChecked(connection.id)
              ? session[connection.id]
              : undefined;
            return state ? [[connection.id, state]] : [];
          }
          const state = persisted[connection.id];
          return state ? [[connection.id, state]] : [];
        }),
      );
    })();
  const candidates: JarvisModelSwitchCandidate[] = [];
  const hiveModelKeys = new Set(
    stepsForPreset('balanced', 'general', state.stackCustomSteps).map(
      (step) => `${step.provider}\u0000${step.model}`,
    ),
  );

  for (const option of uniqueModelOptions(state, options.modelOptions, connections)) {
    const providerConnections = connections.filter(
      (connection) => connection.providerId === option.provider,
    );
    const accessible = new Set(
      getAccessibleModelOptions(
        option.provider,
        state.apiKeys,
        state.offlineMode,
        state.defaultLocalModel,
        state.plan,
      ).map((model) => model.id),
    );

    if (providerConnections.length === 0) {
      const catalogMetadata = exactCatalogMetadata(option.provider, option.id);
      candidates.push({
        selection: selectionFromOption(option.provider, option.id) as SingleModelSelection,
        preferred:
          (state.chatModelSelection.mode === 'single' &&
            state.chatModelSelection.providerId === option.provider &&
            state.chatModelSelection.modelId === option.id) ||
          state.selectedModels[option.provider] === option.id,
        connected: false,
        available: false,
        supportsImages: modelSupportsVision(option.provider, option.id),
        supportsTools: false,
        toolReliabilityRank: 0,
        speedRank: undefined,
        contextWindowTokens: catalogMetadata.contextWindowTokens,
        codingRank: codingRank(option.id),
        ...modelCostMetadata(option.provider, option.id, undefined, catalogMetadata),
      });
      continue;
    }

    for (const connection of providerConnections) {
      const exactModels = CONNECTION_MODEL_OPTIONS[connection.id];
      if (exactModels && !exactModels.some((model) => model.id === option.id)) continue;
      if (!connection.capabilities.modelSelection && !exactModels && !connection.modelId) continue;
      const connectionTruth = observedConnectionState(connection, connectionStates);
      const isHiveModel = hiveModelKeys.has(`${option.provider}\u0000${option.id}`);
      const catalogMetadata = exactCatalogMetadata(option.provider, option.id, connection);
      candidates.push({
        selection: selectionFromOption(
          option.provider,
          option.id,
          connection,
        ) as SingleModelSelection,
        preferred: isPreferredCandidate(state, option, connection.id, providerConnections),
        connected: connectionTruth.connected,
        available:
          connectionTruth.available &&
          (connection.mode === 'external-cli' || accessible.has(option.id) || isHiveModel),
        supportsImages:
          connection.capabilities.images && modelSupportsVision(option.provider, option.id),
        supportsTools: connection.capabilities.tools,
        toolReliabilityRank: toolReliabilityRank(connection),
        speedRank: connectionSpeedRank(connection),
        contextWindowTokens: catalogMetadata.contextWindowTokens,
        codingRank: codingRank(option.id),
        ...modelCostMetadata(option.provider, option.id, connection.mode, catalogMetadata),
      });
    }
  }

  return deepFreezeJarvisCopy(candidates) as readonly JarvisModelSwitchCandidate[];
}

function assessHiveBalanced(
  state: JarvisModelSelectionActionState,
  candidates: readonly JarvisModelSwitchCandidate[],
): Readonly<JarvisHiveBalancedAssessment> {
  const steps = stepsForPreset('balanced', 'general', state.stackCustomSteps);
  const candidatesFor = (providerId: ProviderId, modelId: string) =>
    candidates.filter(
      (candidate) =>
        candidate.selection.providerId === providerId && candidate.selection.modelId === modelId,
    );
  const configured =
    steps.length > 0 && steps.every((step) => candidatesFor(step.provider, step.model).length > 0);
  const connected =
    configured &&
    steps.every((step) =>
      candidatesFor(step.provider, step.model).some((candidate) => candidate.connected),
    );
  const available =
    connected &&
    steps.every((step) =>
      candidatesFor(step.provider, step.model).some(
        (candidate) => candidate.connected && candidate.available,
      ),
    );
  const supportsImages =
    available &&
    steps.every(
      (step) =>
        modelSupportsVision(step.provider, step.model) &&
        candidatesFor(step.provider, step.model).some(
          (candidate) => candidate.connected && candidate.available && candidate.supportsImages,
        ),
    );
  const supportsTools =
    available &&
    steps.every((step) =>
      candidatesFor(step.provider, step.model).some(
        (candidate) => candidate.connected && candidate.available && candidate.supportsTools,
      ),
    );
  return deepFreezeJarvisCopy({
    configured,
    connected,
    available,
    supportsImages,
    supportsTools,
    allLocal:
      steps.length > 0 &&
      steps.every((step) => step.provider === 'ollama' || step.provider === 'local'),
    costClass: costClassForRate(
      Math.max(HIVE_BALANCE_PRICING.inputPer1M, HIVE_BALANCE_PRICING.outputPer1M),
    ),
  });
}

function fail(error: string): ActionResult {
  return { ok: false, error };
}

function selectionLabel(selection: ChatModelSelection): string {
  if (selection.mode === 'hive') return 'Hive Balanced';
  if (selection.mode === 'none') return 'the default model';
  return `${selection.providerId}/${selection.modelId}`;
}

function hasCanonicalModelSwitchApproval(context: ActionRunContext): boolean {
  return (
    context.source === 'ai' &&
    typeof context.accountId === 'string' &&
    context.accountId.trim().length > 0 &&
    typeof context.runId === 'string' &&
    context.runId.trim().length > 0 &&
    typeof context.approvalId === 'string' &&
    context.approvalId.trim().length > 0 &&
    typeof context.requestId === 'string' &&
    context.requestId.trim().length > 0 &&
    Number.isSafeInteger(context.attemptNumber) &&
    Number(context.attemptNumber) > 0 &&
    context.signal instanceof AbortSignal &&
    !context.signal.aborted
  );
}

function decisionFailureMessage(
  reason:
    | 'target_not_configured'
    | 'no_previous_selection'
    | 'provider_not_connected'
    | 'model_unavailable'
    | 'required_capability_unavailable'
    | 'offline_mode',
): string {
  switch (reason) {
    case 'target_not_configured':
      return 'No configured model matches this switch request.';
    case 'no_previous_selection':
      return 'There is no previous model selection to restore.';
    case 'provider_not_connected':
      return 'The requested model provider is not connected and authenticated.';
    case 'model_unavailable':
      return 'The requested model is not currently available.';
    case 'required_capability_unavailable':
      return 'No available candidate supports the capabilities required by this request.';
    case 'offline_mode':
      return 'Offline mode prevents switching to a cloud model.';
  }
}

const DEFAULT_DEPENDENCIES: ModelSelectionActionDependencies = {
  getState: () => useAuthStore.getState(),
  buildCandidates: (state) => buildJarvisModelSwitchCandidates(state),
  applySelection: (selection) => useAuthStore.getState().setChatModelSelection(selection),
  validateSelection: (selection, state, requirements) =>
    validateChatModelSelection(
      selection,
      modelSelectionContextFromAuth(state),
      state.stackCustomSteps,
      {
        attachments: { hasImages: requirements.images === true },
        tools: requirements.tools === true,
      },
    ),
};

/** Approval-gated, post-verified JARVIS chat-model selection action. */
export function createModelSelectionActions(
  dependencies: ModelSelectionActionDependencies = DEFAULT_DEPENDENCIES,
): ActionDef[] {
  return [
    {
      id: 'chat.model.switch',
      category: 'chat',
      label: 'Switch chat model',
      description:
        'Review and switch the active chat model; privacy, cost, capability, and connection gates can refuse the change.',
      destructive: true,
      params: [
        {
          key: 'request',
          label: 'Model switch request',
          type: 'string',
          required: true,
          help: 'Use an exact supported request such as “Switch to Gemini” or “Switch back”.',
        },
        {
          key: 'needsImages',
          label: 'Requires image input',
          type: 'boolean',
          default: false,
        },
        {
          key: 'needsTools',
          label: 'Requires tool use',
          type: 'boolean',
          default: false,
        },
      ],
      run: async (params, context) => {
        const request = typeof params.request === 'string' ? params.request.trim() : '';
        if (!request) return fail('A model switch request is required.');
        if (request.length > 300) return fail('The model switch request is too long.');
        const intent = parseJarvisModelSwitchIntent(request);
        if (!intent) return fail('The model switch request is not recognized.');

        const before = dependencies.getState();
        const candidates = dependencies.buildCandidates(before);
        const requirements: JarvisModelSwitchRequirements = {
          images: params.needsImages === true,
          tools: params.needsTools === true,
        };
        const decision = planJarvisModelSwitch({
          intent,
          current: before.chatModelSelection,
          previous: before.previousChatModelSelection,
          candidates,
          hiveBalanced: assessHiveBalanced(before, candidates),
          offlineMode: before.offlineMode,
          requirements,
          policyRequiresApproval: context.source === 'ai' && !before.jarvisAutoApprove,
        });

        if (
          decision.status === 'not_configured' ||
          decision.status === 'not_connected' ||
          decision.status === 'unavailable'
        ) {
          return fail(decisionFailureMessage(decision.reason));
        }
        if (decision.status === 'approval_required') {
          if (!hasCanonicalModelSwitchApproval(context)) {
            return fail(
              `Additional approval required before this switch: ${decision.reasons.join(', ')}. No model change was made.`,
            );
          }
        }
        if (decision.status === 'already_selected') {
          return {
            ok: true,
            summary: `${selectionLabel(decision.target)} is already selected. No model change was needed.`,
          };
        }
        if (decision.status !== 'ready' && decision.status !== 'approval_required') {
          return fail('The model switch decision could not be applied safely.');
        }

        const target = decision.target;
        const validation =
          dependencies.validateSelection?.(target, before, requirements) ??
          DEFAULT_DEPENDENCIES.validateSelection!(target, before, requirements);
        if (!validation.ok) {
          return fail(validation.message);
        }
        dependencies.applySelection(target);
        const after = dependencies.getState();
        if (!sameSelection(after.chatModelSelection, target)) {
          return fail('Model switch verification failed; no completion claim can be made.');
        }
        return {
          ok: true,
          summary: `Model switched to ${selectionLabel(target)} for the next turn. The current response keeps its captured model; JARVIS identity and workspace context remain unchanged.`,
          data: {
            ...(target.mode === 'single'
              ? {
                  providerId: target.providerId,
                  modelId: target.modelId,
                  connectionId: target.connectionId,
                }
              : target.mode === 'hive'
                ? { hiveId: target.hiveId }
                : {}),
          },
        };
      },
    },
  ];
}
