import { create, type StateCreator } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import type {
  ProviderId,
  WorkspaceId,
  ProjectId,
  PersonaPreset,
  VoiceEngine,
  VoicePresetId,
  ComposerSttProvider,
  FasterWhisperModelId,
} from '@/types/common';
import type { PlanId } from '@/lib/entitlements';
import { DEFAULT_CUSTOM_STEPS } from '@/lib/ai/stacks/presets';
import {
  sanitizeModelIdForInput,
  validateProviderModelSelection,
} from '@/lib/ai/providerModelCatalog';
import { defaultModelForProvider } from '@/lib/ai/models';
import type { StackPresetId, StackStepSpec } from '@/lib/ai/stacks/types';
import { safeLocalStorage } from '@/lib/persistence/safeLocalStorage';
import {
  SECRET_API_KEY_PROVIDERS,
  isSecretApiKeyProvider,
  loadSecureApiKeysDetailed,
  saveApiKeySecurely,
  secureDeleteApiKey,
  secureSetApiKey,
  type ApiKeySaveResult,
} from '@/lib/security/secureApiKeys';
import {
  VOICE_SILENCE_DELAY_MS_DEFAULT,
  VOICE_LISTEN_TIMEOUT_MS_DEFAULT,
  VOICE_END_TRIGGER_DEFAULT,
  clampVoiceSilenceDelayMs,
  clampVoiceListenTimeoutMs,
  type VoiceEndTrigger,
} from '@/features/voice/voiceConversation';
import {
  VOICE_COMMIT_PHRASE_DEFAULT,
  VOICE_CANCEL_PHRASE_DEFAULT,
  clampVoiceCommitPhrase,
  clampVoiceCancelPhrase,
} from '@/features/voice/voiceTurnCommit';
import {
  EMPTY_CHAT_MODEL_SELECTION,
  gateChatModelSelection,
  migrateLegacyModelSelection,
  normalizeChatModelSelection,
  selectionFromHive,
  selectionFromOption,
  type ChatModelSelection,
} from '@/lib/ai/modelSelection';
import { isHiveProductEnabled } from '@/lib/features/hiveProductGate';
import { normalizeLocalSttCatalogId } from '@/features/composer-stt/catalog';
import { normalizeAssistantPersonaId } from '@/lib/assistantPersona';

function normalizeLocalSttModelId(raw: string | null | undefined): FasterWhisperModelId {
  return normalizeLocalSttCatalogId(raw) as FasterWhisperModelId;
}

// The secure keychain remains authoritative, but hydration is deliberately
// non-destructive. The snapshot resolves before App's outer five-second boot
// guard and supersedes stale reads whenever the user mutates a provider key.
const credentialHydrationSnapshot = new CredentialHydrationSnapshot(4_500);

import {
  normalizePromptForgeModelSelection,
  type PromptForgeModelSelection,
} from '@/features/prompt-forge/contracts';
import { DEFAULT_PROMPT_FORGE_MODEL_SELECTION } from '@/features/prompt-forge/modelSelection';
import { CredentialHydrationSnapshot } from '@/lib/harness/CredentialHydrationSnapshot';

export type VoiceAgentProvider = 'codex' | 'opencode';
export type VoiceWorkerSessionMode = 'new' | 'resume';

function normalizeVoiceAgentProvider(value: unknown): VoiceAgentProvider {
  return value === 'opencode' ? 'opencode' : 'codex';
}

function normalizeVoiceWorkerSessionMode(value: unknown): VoiceWorkerSessionMode {
  return value === 'resume' ? 'resume' : 'new';
}

function normalizeVoiceAccentIntensity(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 60;
  return Math.round(Math.min(100, Math.max(0, value)));
}

interface AuthState {
  /** Local-only profile (no cloud account) */
  localUserId: string | null;
  displayName: string;
  email?: string;

  /** Active workspace + project */
  workspaceId: WorkspaceId | null;
  projectId: ProjectId | null;

  /** Cloud session info from Supabase, populated when sync is on */
  cloudSession: {
    user_id: string;
    email: string;
    expires_at: number;
  } | null;

  /** BYOK API keys per provider */
  apiKeys: Partial<Record<ProviderId, string>>;
  /** Active provider for chat default */
  defaultProvider: ProviderId;
  /** Selected model id per provider. */
  selectedModels: Partial<Record<ProviderId, string>>;

  /**
   * Offline mode. When true, the router ignores every cloud provider and
   * sends all chat through the local Ollama endpoint instead — no API key,
   * no internet. Configured in Settings → Local Models. Default off so the
   * standard path is the (free) Google Gemini key.
   */
  offlineMode: boolean;
  /** Model name to use in offline mode, e.g. 'llama3.2'. Set in Local Models. */
  defaultLocalModel: string;

  /** Persona preset and custom prompt overrides */
  personaPreset: PersonaPreset;
  /** Spoken voice profile used everywhere Jarvis speaks. */
  voicePreset: VoicePresetId;
  /** Restrict speech to installed voices when local mode is selected. */
  voiceEngine: VoiceEngine;
  /** Provider for the Main Agent that handles voice requests. */
  voiceMainAgentProvider: VoiceAgentProvider;
  /** Provider for the worker session started by a voice request. */
  voiceWorkerProvider: VoiceAgentProvider;
  /** Whether voice worker requests create a new worker session or resume the existing one. */
  voiceWorkerSessionMode: VoiceWorkerSessionMode;
  /** Tint Jarvis voice visuals with colors for the provider receiving the current request. */
  voiceProviderAccentsEnabled: boolean;
  /** Provider accent mix, from 0 (theme colors) to 100 (full provider colors). */
  voiceAccentIntensity: number;
  /** Show a small text entry surface while Jarvis voice is open. */
  voiceMiniBarEnabled: boolean;
  /** Create a provider-scoped Jarvis chat on each opening instead of resuming it. */
  voiceStartFreshChat: boolean;
  /** Speak completed Jarvis replies, including normal typed conversations. */
  speakReplies: boolean;
  /**
   * Hands-free voice: when true, the panel listens on open and keeps the mic
   * ready between turns. When false, tap the symbiote orb each time you speak.
   */
  voiceAutoListenOnOpen: boolean;
  /** Milliseconds of silence after speech before Jarvis sends your message. */
  voiceSilenceDelayMs: number;
  /**
   * Hands-free listen cap (ms). After this much time without speech, Jarvis stops
   * listening. Ignored in click-to-talk mode.
   */
  voiceListenTimeoutMs: number;
  /**
   * Hands-free: how a user turn ends — say a commit phrase, or pause (silence).
   * Click-to-talk always uses silence.
   */
  voiceEndTrigger: VoiceEndTrigger;
  /** Phrase spoken to send a hands-free message (e.g. "send it"). */
  voiceCommitPhrase: string;
  /** Phrase spoken to discard the current draft without sending. */
  voiceCancelPhrase: string;
  /**
   * Chat auto-approve: when true, Jarvis action proposals run without
   * clicking Approve. Toggle with Shift+Tab on the chat route.
   */
  jarvisAutoApprove: boolean;
  /**
   * Voice auto-approve: when true, action proposals from voice turns
   * run immediately (open terminals, navigate, etc.).
   */
  voiceAutoApproveActions: boolean;

  /** Composer toolbar mic STT provider (chat dictation only). */
  composerSttProvider: ComposerSttProvider;
  /** Selected faster-whisper model when composerSttProvider is faster-whisper. */
  fasterWhisperModel: FasterWhisperModelId;

  /**
   * Subscription tier. Defaults to `free` for every install. The Stripe
   * billing webhook will flip this once paid plans ship; today no code
   * path mutates it. Lives in the auth store so a future logout can
   * reset it cleanly. See `lib/entitlements.ts` for what each tier
   * unlocks.
   */
  plan: PlanId;
  /** Active Hive preset for chat-only multi-model stacks. */
  stackPreset: StackPresetId;
  /** User-defined Custom Hive steps. Contains model IDs/prompts, never API keys. */
  stackCustomSteps: StackStepSpec[];
  /** Explicit chat model / Hive workflow selection (single source of truth). */
  chatModelSelection: ChatModelSelection;
  /** Exact selection immediately preceding the current chat model selection. */
  previousChatModelSelection: ChatModelSelection;
  /** Explicit opt-in for turn-local automatic model routing. */
  automaticModelRoutingEnabled: boolean;
  /** Prompt Forge's independent default; changing it never changes the chat model. */
  promptForgeModelSelection: PromptForgeModelSelection;
  /** Whether Prompt Forge may retrieve project evidence through Shared Context/RLM. */
  promptForgeUseRlmContext: boolean;
  /**
   * When true, Composer upgrades the draft with Prompt Forge before each Send
   * (falls back to the original text if upgrade fails). Manual Upgrade button remains.
   */
  promptForgeAutoUpgradeOnSend: boolean;

  /** Telemetry opt-in */
  telemetryOptIn: boolean;
  credentialVaultState: 'idle' | 'hydrating' | 'ready' | 'degraded';
  credentialVaultFailedProviders: ProviderId[];
  preferredConnectionIdByProviderFamily: Partial<Record<string, string>>;

  // Actions
  setDisplayName: (n: string) => void;
  setPreferredConnectionId: (provider: string, connectionId: string) => void;
  setApiKey: (provider: ProviderId, key: string) => Promise<ApiKeySaveResult>;
  clearApiKey: (provider: ProviderId) => void;
  hydrateApiKeysFromVault: () => Promise<'ready' | 'degraded'>;
  setDefaultProvider: (p: ProviderId) => void;
  setSelectedModel: (provider: ProviderId, model: string) => void;
  setPersona: (p: AuthState['personaPreset']) => void;
  setVoicePreset: (p: VoicePresetId) => void;
  setVoiceEngine: (engine: VoiceEngine) => void;
  setVoiceMainAgentProvider: (provider: VoiceAgentProvider) => void;
  setVoiceWorkerProvider: (provider: VoiceAgentProvider) => void;
  setVoiceWorkerSessionMode: (mode: VoiceWorkerSessionMode) => void;
  setVoiceProviderAccentsEnabled: (enabled: boolean) => void;
  setVoiceAccentIntensity: (intensity: number) => void;
  setVoiceMiniBarEnabled: (enabled: boolean) => void;
  setVoiceStartFreshChat: (enabled: boolean) => void;
  setSpeakReplies: (enabled: boolean) => void;
  setVoiceAutoListenOnOpen: (enabled: boolean) => void;
  setVoiceSilenceDelayMs: (ms: number) => void;
  setVoiceListenTimeoutMs: (ms: number) => void;
  setVoiceEndTrigger: (trigger: VoiceEndTrigger) => void;
  setVoiceCommitPhrase: (phrase: string) => void;
  setVoiceCancelPhrase: (phrase: string) => void;
  setJarvisAutoApprove: (enabled: boolean) => void;
  setVoiceAutoApproveActions: (enabled: boolean) => void;
  setComposerSttProvider: (provider: ComposerSttProvider) => void;
  setFasterWhisperModel: (model: FasterWhisperModelId) => void;
  setWorkspaceId: (id: WorkspaceId | null) => void;
  setProjectId: (id: ProjectId | null) => void;
  setCloudSession: (s: AuthState['cloudSession']) => void;
  setTelemetryOptIn: (v: boolean) => void;
  setLocalUser: (id: string) => void;
  /** Toggle offline (local-model-only) mode. */
  setOfflineMode: (v: boolean) => void;
  /** Set the model name used in offline mode. */
  setDefaultLocalModel: (m: string) => void;
  /** Set the active plan id. Will be called by the Stripe webhook handler when billing ships. */
  setPlan: (p: PlanId) => void;
  setStackPreset: (preset: StackPresetId) => void;
  setChatModelSelection: (selection: ChatModelSelection) => void;
  setAutomaticModelRoutingEnabled: (enabled: boolean) => void;
  setPromptForgeModelSelection: (selection: PromptForgeModelSelection) => void;
  setPromptForgeUseRlmContext: (enabled: boolean) => void;
  setPromptForgeAutoUpgradeOnSend: (enabled: boolean) => void;
  setStackCustomSteps: (steps: StackStepSpec[]) => void;
}

function persistedLocalApiKeys(
  keys: Partial<Record<ProviderId, string>>,
): Partial<Record<ProviderId, string>> {
  return {
    ...(keys.mock ? { mock: keys.mock } : {}),
    ...(keys.ollama ? { ollama: keys.ollama } : {}),
  };
}

function legacySecretApiKeys(
  keys: Partial<Record<ProviderId, string>>,
): Partial<Record<ProviderId, string>> {
  const out: Partial<Record<ProviderId, string>> = {};
  for (const provider of SECRET_API_KEY_PROVIDERS) {
    const value = keys[provider]?.trim();
    if (value) out[provider] = value;
  }
  return out;
}

function migrateLegacySecretsToVault(keys: Partial<Record<ProviderId, string>>): void {
  for (const provider of SECRET_API_KEY_PROVIDERS) {
    const value = keys[provider]?.trim();
    if (!value) continue;
    void secureSetApiKey(provider, value).catch((err) => {
      console.warn(`[credentials] Could not migrate ${provider} API key`, err);
    });
  }
}

function sameChatModelSelection(left: ChatModelSelection, right: ChatModelSelection): boolean {
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

function previousSelectionForTransition(
  current: ChatModelSelection,
  previous: ChatModelSelection,
  next: ChatModelSelection,
): ChatModelSelection {
  return sameChatModelSelection(current, next) ? previous : current;
}

// Capture Zustand's setter before persist wraps it. Recovery writes only its own
// validated storage entry, then publishes memory without invoking cache eviction.
let setRecoveryState!: (state: Partial<AuthState>) => void;
const captureRecoverySetter =
  <Persisted>(
    initializer: StateCreator<AuthState, [], [['zustand/persist', Persisted]]>,
  ): StateCreator<AuthState, [], [['zustand/persist', Persisted]]> =>
  (set, get, api) => {
    setRecoveryState = set;
    return initializer(set, get, api);
  };

export const useAuthStore = create<AuthState>()(
  captureRecoverySetter(
    persist(
      (set) => ({
        localUserId: null,
        displayName: '',
        email: undefined,
        workspaceId: null,
        projectId: null,
        cloudSession: null,
        apiKeys: {},
        defaultProvider: 'google',
        selectedModels: {},
        offlineMode: false,
        defaultLocalModel: 'llama3.2',
        personaPreset: 'jarvis',
        voicePreset: 'jarvis-prime',
        voiceEngine: 'jarvis',
        voiceMainAgentProvider: 'codex',
        voiceWorkerProvider: 'codex',
        voiceWorkerSessionMode: 'new',
        voiceProviderAccentsEnabled: false,
        voiceAccentIntensity: 60,
        voiceMiniBarEnabled: false,
        voiceStartFreshChat: false,
        speakReplies: false,
        voiceAutoListenOnOpen: true,
        voiceSilenceDelayMs: VOICE_SILENCE_DELAY_MS_DEFAULT,
        voiceListenTimeoutMs: VOICE_LISTEN_TIMEOUT_MS_DEFAULT,
        voiceEndTrigger: VOICE_END_TRIGGER_DEFAULT,
        voiceCommitPhrase: VOICE_COMMIT_PHRASE_DEFAULT,
        voiceCancelPhrase: VOICE_CANCEL_PHRASE_DEFAULT,
        jarvisAutoApprove: false,
        voiceAutoApproveActions: true,
        composerSttProvider: 'system',
        fasterWhisperModel: 'whisper-small-en-q8',
        plan: 'free',
        stackPreset: 'off',
        stackCustomSteps: DEFAULT_CUSTOM_STEPS,
        chatModelSelection: EMPTY_CHAT_MODEL_SELECTION,
        previousChatModelSelection: EMPTY_CHAT_MODEL_SELECTION,
        automaticModelRoutingEnabled: false,
        promptForgeModelSelection: DEFAULT_PROMPT_FORGE_MODEL_SELECTION,
        promptForgeUseRlmContext: true,
        promptForgeAutoUpgradeOnSend: false,
        telemetryOptIn: false,
        credentialVaultState: 'idle',
        credentialVaultFailedProviders: [],
        preferredConnectionIdByProviderFamily: {},

        setDisplayName: (n) => set({ displayName: n }),
        setPreferredConnectionId: (provider, connectionId) =>
          set((s) => ({
            preferredConnectionIdByProviderFamily: {
              ...s.preferredConnectionIdByProviderFamily,
              [provider]: connectionId,
            },
          })),
        setApiKey: async (provider, key) => {
          const trimmed = key.trim();
          if (isSecretApiKeyProvider(provider)) {
            const result = await saveApiKeySecurely(provider, trimmed);
            if (!result.ok) return result;
            if (trimmed) credentialHydrationSnapshot.mergeVerified({ [provider]: trimmed });
            else credentialHydrationSnapshot.removeProviders([provider]);
          }
          set((s) => ({ apiKeys: { ...s.apiKeys, [provider]: trimmed } }));
          return { ok: true };
        },
        clearApiKey: (provider) =>
          set((s) => {
            if (isSecretApiKeyProvider(provider)) {
              credentialHydrationSnapshot.removeProviders([provider]);
              void secureDeleteApiKey(provider).catch((err) => {
                console.warn(`[credentials] Could not delete ${provider} API key`, err);
              });
            }
            const { [provider]: _, ...rest } = s.apiKeys;
            return { apiKeys: rest };
          }),
        hydrateApiKeysFromVault: async () => {
          set({ credentialVaultState: 'hydrating', credentialVaultFailedProviders: [] });
          const current = useAuthStore.getState().apiKeys;
          credentialHydrationSnapshot.mergeVerified(
            Object.fromEntries(
              SECRET_API_KEY_PROVIDERS.flatMap((provider) => {
                const value = current[provider]?.trim();
                return value ? [[provider, value] as const] : [];
              }),
            ),
          );
          let status: 'ready' | 'degraded' = 'ready';
          let failedProviders: ProviderId[] = [];
          const hydrated = await credentialHydrationSnapshot.hydrate(
            async () => {
              const result = await loadSecureApiKeysDetailed();
              status = result.status;
              failedProviders = result.failedProviders;
              return result.keys;
            },
            { mode: 'merge' },
          );
          if (hydrated.warning) status = 'degraded';
          set((s) => ({
            apiKeys: { ...s.apiKeys, ...hydrated.values },
            credentialVaultState: status,
            credentialVaultFailedProviders: failedProviders,
          }));
          return status;
        },
        setDefaultProvider: (p) => set({ defaultProvider: p }),
        setSelectedModel: (provider, model) =>
          set((s) => ({
            selectedModels: { ...s.selectedModels, [provider]: model.trim() },
          })),
        setPersona: (p) => set({ personaPreset: normalizeAssistantPersonaId(p) }),
        setVoicePreset: (p) => set({ voicePreset: p }),
        setVoiceEngine: (engine) => set({ voiceEngine: engine }),
        setVoiceMainAgentProvider: (provider) =>
          set({ voiceMainAgentProvider: normalizeVoiceAgentProvider(provider) }),
        setVoiceWorkerProvider: (provider) =>
          set({ voiceWorkerProvider: normalizeVoiceAgentProvider(provider) }),
        setVoiceWorkerSessionMode: (mode) =>
          set({ voiceWorkerSessionMode: normalizeVoiceWorkerSessionMode(mode) }),
        setVoiceProviderAccentsEnabled: (enabled) => set({ voiceProviderAccentsEnabled: enabled }),
        setVoiceAccentIntensity: (intensity) =>
          set({ voiceAccentIntensity: normalizeVoiceAccentIntensity(intensity) }),
        setVoiceMiniBarEnabled: (enabled) => set({ voiceMiniBarEnabled: enabled }),
        setVoiceStartFreshChat: (enabled) => set({ voiceStartFreshChat: enabled }),
        setSpeakReplies: (enabled) => set({ speakReplies: enabled }),
        setVoiceAutoListenOnOpen: (enabled) => set({ voiceAutoListenOnOpen: enabled }),
        setVoiceSilenceDelayMs: (ms) => set({ voiceSilenceDelayMs: clampVoiceSilenceDelayMs(ms) }),
        setVoiceListenTimeoutMs: (ms) =>
          set({ voiceListenTimeoutMs: clampVoiceListenTimeoutMs(ms) }),
        setVoiceEndTrigger: (trigger) =>
          set({ voiceEndTrigger: trigger === 'silence' ? 'silence' : 'phrase' }),
        setVoiceCommitPhrase: (phrase) =>
          set({ voiceCommitPhrase: clampVoiceCommitPhrase(phrase) }),
        setVoiceCancelPhrase: (phrase) =>
          set({ voiceCancelPhrase: clampVoiceCancelPhrase(phrase) }),
        setJarvisAutoApprove: (enabled) => set({ jarvisAutoApprove: enabled }),
        setVoiceAutoApproveActions: (enabled) => set({ voiceAutoApproveActions: enabled }),
        setComposerSttProvider: (provider) =>
          set({
            composerSttProvider:
              provider === 'faster-whisper' || provider === 'deepgram' || provider === 'system'
                ? provider
                : 'system',
          }),
        setFasterWhisperModel: (model) =>
          set({
            fasterWhisperModel: normalizeLocalSttModelId(model),
          }),
        setWorkspaceId: (id) => set({ workspaceId: id }),
        setProjectId: (id) => set({ projectId: id }),
        setCloudSession: (s) => set({ cloudSession: s }),
        setTelemetryOptIn: (v) => set({ telemetryOptIn: v }),
        setLocalUser: (id) => set({ localUserId: id }),
        setOfflineMode: (v) => set({ offlineMode: v }),
        setDefaultLocalModel: (m) => set({ defaultLocalModel: m.trim() || 'llama3.2' }),
        setPlan: (p) => set({ plan: p }),
        setStackPreset: (preset) =>
          set((s) => {
            // Product gate: refuse Hive stack activation while scrapped.
            const effectivePreset =
              !isHiveProductEnabled() && preset !== 'off' ? ('off' as StackPresetId) : preset;
            const next =
              effectivePreset === 'off'
                ? s.chatModelSelection.mode === 'hive'
                  ? EMPTY_CHAT_MODEL_SELECTION
                  : s.chatModelSelection
                : selectionFromHive(effectivePreset);
            const gated = gateChatModelSelection(next);
            return {
              stackPreset: gated.mode === 'hive' ? gated.hiveId : 'off',
              chatModelSelection: gated,
              previousChatModelSelection: previousSelectionForTransition(
                s.chatModelSelection,
                s.previousChatModelSelection,
                gated,
              ),
            };
          }),
        setChatModelSelection: (selection) =>
          set((s) => {
            const normalized = gateChatModelSelection(normalizeChatModelSelection(selection));
            const previousChatModelSelection = previousSelectionForTransition(
              s.chatModelSelection,
              s.previousChatModelSelection,
              normalized,
            );
            if (normalized.mode === 'single') {
              return {
                chatModelSelection: normalized,
                previousChatModelSelection,
                defaultProvider: normalized.providerId,
                selectedModels: {
                  ...s.selectedModels,
                  [normalized.providerId]: normalized.modelId,
                },
                stackPreset: 'off' as StackPresetId,
              };
            }
            if (normalized.mode === 'hive') {
              return {
                chatModelSelection: normalized,
                previousChatModelSelection,
                stackPreset: normalized.hiveId,
              };
            }
            return {
              chatModelSelection: EMPTY_CHAT_MODEL_SELECTION,
              previousChatModelSelection,
              stackPreset: 'off' as StackPresetId,
            };
          }),
        setAutomaticModelRoutingEnabled: (enabled) =>
          set({ automaticModelRoutingEnabled: enabled }),
        setPromptForgeModelSelection: (selection) =>
          set({ promptForgeModelSelection: normalizePromptForgeModelSelection(selection) }),
        setPromptForgeUseRlmContext: (enabled) =>
          set({ promptForgeUseRlmContext: Boolean(enabled) }),
        setPromptForgeAutoUpgradeOnSend: (enabled) =>
          set({ promptForgeAutoUpgradeOnSend: Boolean(enabled) }),
        setStackCustomSteps: (steps) =>
          set((s) => ({
            stackCustomSteps: steps.slice(0, 5).map((step) => {
              const ctx = {
                apiKeys: s.apiKeys,
                offlineMode: s.offlineMode,
                plan: s.plan,
                defaultLocalModel: s.defaultLocalModel,
              };
              const model = sanitizeModelIdForInput(step.model);
              const validation = validateProviderModelSelection(step.provider, model, ctx, {
                allowCustom: true,
              });
              const resolvedModel =
                model && (validation.ok || validation.isCustomModel)
                  ? model
                  : defaultModelForProvider(step.provider, s.defaultLocalModel);
              return {
                ...step,
                id: step.id.trim() || crypto.randomUUID(),
                label: step.label.trim() || 'Hive step',
                model: resolvedModel,
                systemAppend: step.systemAppend.trim(),
                provider_options: step.provider_options ? { ...step.provider_options } : undefined,
              };
            }),
          })),
      }),
      {
        name: 'jarvis-auth',
        storage: createJSONStorage(() => safeLocalStorage),
        partialize: (s) => ({
          localUserId: s.localUserId,
          displayName: s.displayName,
          email: s.email,
          workspaceId: s.workspaceId,
          projectId: s.projectId,
          apiKeys: persistedLocalApiKeys(s.apiKeys),
          defaultProvider: s.defaultProvider,
          selectedModels: s.selectedModels,
          offlineMode: s.offlineMode,
          defaultLocalModel: s.defaultLocalModel,
          personaPreset: s.personaPreset,
          voicePreset: s.voicePreset,
          voiceEngine: s.voiceEngine,
          voiceMainAgentProvider: s.voiceMainAgentProvider,
          voiceWorkerProvider: s.voiceWorkerProvider,
          voiceWorkerSessionMode: s.voiceWorkerSessionMode,
          voiceProviderAccentsEnabled: s.voiceProviderAccentsEnabled,
          voiceAccentIntensity: s.voiceAccentIntensity,
          voiceMiniBarEnabled: s.voiceMiniBarEnabled,
          voiceStartFreshChat: s.voiceStartFreshChat,
          speakReplies: s.speakReplies,
          voiceAutoListenOnOpen: s.voiceAutoListenOnOpen,
          voiceSilenceDelayMs: s.voiceSilenceDelayMs,
          voiceListenTimeoutMs: s.voiceListenTimeoutMs,
          voiceEndTrigger: s.voiceEndTrigger,
          voiceCommitPhrase: s.voiceCommitPhrase,
          voiceCancelPhrase: s.voiceCancelPhrase,
          jarvisAutoApprove: s.jarvisAutoApprove,
          voiceAutoApproveActions: s.voiceAutoApproveActions,
          composerSttProvider: s.composerSttProvider,
          fasterWhisperModel: s.fasterWhisperModel,
          plan: s.plan,
          stackPreset: s.stackPreset,
          stackCustomSteps: s.stackCustomSteps,
          chatModelSelection: s.chatModelSelection,
          previousChatModelSelection: s.previousChatModelSelection,
          automaticModelRoutingEnabled: s.automaticModelRoutingEnabled,
          promptForgeModelSelection: s.promptForgeModelSelection,
          promptForgeUseRlmContext: s.promptForgeUseRlmContext,
          promptForgeAutoUpgradeOnSend: s.promptForgeAutoUpgradeOnSend,
          telemetryOptIn: s.telemetryOptIn,
          preferredConnectionIdByProviderFamily: s.preferredConnectionIdByProviderFamily,
        }),
        version: 21,
        migrate: (persisted, fromVersion) => {
          if (!persisted || typeof persisted !== 'object') return persisted;
          const state = persisted as Partial<AuthState>;
          const keys = state.apiKeys ?? {};
          const legacySecrets = legacySecretApiKeys(keys);
          migrateLegacySecretsToVault(legacySecrets);
          state.apiKeys = {
            ...persistedLocalApiKeys(keys),
            ...legacySecrets,
          };
          if (fromVersion < 3) {
            if (typeof state.voiceSilenceDelayMs !== 'number') {
              state.voiceSilenceDelayMs = VOICE_SILENCE_DELAY_MS_DEFAULT;
            }
          }
          if (fromVersion < 4) {
            // Typed chat used to speak by default; voice panel is the primary speech surface now.
            state.speakReplies = false;
          }
          if (fromVersion < 5) {
            if (typeof state.jarvisAutoApprove !== 'boolean') state.jarvisAutoApprove = false;
            if (typeof state.voiceAutoApproveActions !== 'boolean')
              state.voiceAutoApproveActions = true;
          }
          if (fromVersion < 7) {
            if (typeof state.voiceListenTimeoutMs !== 'number') {
              state.voiceListenTimeoutMs = VOICE_LISTEN_TIMEOUT_MS_DEFAULT;
            }
          }
          if (fromVersion < 8 && state.voiceEngine === 'system') {
            state.voiceEngine = 'jarvis';
          }
          if (fromVersion < 9) {
            if (
              state.composerSttProvider !== 'system' &&
              state.composerSttProvider !== 'faster-whisper' &&
              state.composerSttProvider !== 'deepgram'
            ) {
              state.composerSttProvider = 'system';
            }
            if (!state.fasterWhisperModel) state.fasterWhisperModel = 'whisper-small-en-q8';
          }
          // Always normalize STT model ids onto the expanded catalog (aliases + new labels).
          if (state.fasterWhisperModel) {
            state.fasterWhisperModel = normalizeLocalSttModelId(String(state.fasterWhisperModel));
          }
          if (
            state.composerSttProvider !== 'system' &&
            state.composerSttProvider !== 'faster-whisper' &&
            state.composerSttProvider !== 'deepgram'
          ) {
            state.composerSttProvider = 'system';
          }
          if (fromVersion < 15) {
            if ((state.voiceEngine as string | undefined) === 'kokoro') {
              state.voiceEngine = 'jarvis';
            }
          }
          // Always normalize persona onto Jarvis | Friday (migrates legacy "sage", etc.).
          state.personaPreset = normalizeAssistantPersonaId(state.personaPreset);
          if (fromVersion < 10) {
            if (state.voiceEndTrigger !== 'phrase' && state.voiceEndTrigger !== 'silence') {
              state.voiceEndTrigger = VOICE_END_TRIGGER_DEFAULT;
            }
            if (typeof state.voiceCommitPhrase !== 'string' || !state.voiceCommitPhrase.trim()) {
              state.voiceCommitPhrase = VOICE_COMMIT_PHRASE_DEFAULT;
            } else {
              state.voiceCommitPhrase = clampVoiceCommitPhrase(state.voiceCommitPhrase);
            }
            if (typeof state.voiceCancelPhrase !== 'string' || !state.voiceCancelPhrase.trim()) {
              state.voiceCancelPhrase = VOICE_CANCEL_PHRASE_DEFAULT;
            } else {
              state.voiceCancelPhrase = clampVoiceCancelPhrase(state.voiceCancelPhrase);
            }
          }
          if (fromVersion < 11) {
            state.chatModelSelection = gateChatModelSelection(
              normalizeChatModelSelection(state.chatModelSelection),
            );
            if (state.chatModelSelection.mode === 'none') {
              state.chatModelSelection = gateChatModelSelection(
                migrateLegacyModelSelection({
                  stackPreset: state.stackPreset ?? 'off',
                  defaultProvider: state.defaultProvider ?? 'google',
                  selectedModels: state.selectedModels ?? {},
                }),
              );
            }
            if (state.chatModelSelection.mode === 'single') {
              state.defaultProvider = state.chatModelSelection.providerId;
              state.selectedModels = {
                ...(state.selectedModels ?? {}),
                [state.chatModelSelection.providerId]: state.chatModelSelection.modelId,
              };
              state.stackPreset = 'off';
            } else if (state.chatModelSelection.mode === 'hive') {
              state.stackPreset = state.chatModelSelection.hiveId;
            } else {
              state.stackPreset = 'off';
            }
          }
          if (fromVersion < 12) {
            state.previousChatModelSelection = gateChatModelSelection(
              normalizeChatModelSelection(state.previousChatModelSelection),
            );
          }
          // Always neutralize stale Hive selections while the product is gated.
          if (state.chatModelSelection) {
            state.chatModelSelection = gateChatModelSelection(
              normalizeChatModelSelection(state.chatModelSelection),
            );
            if (state.chatModelSelection.mode !== 'hive') {
              state.stackPreset = 'off';
            }
          }
          if (state.previousChatModelSelection) {
            state.previousChatModelSelection = gateChatModelSelection(
              normalizeChatModelSelection(state.previousChatModelSelection),
            );
          }
          if (fromVersion < 13) {
            state.automaticModelRoutingEnabled = false;
          }
          if (fromVersion < 14) {
            state.promptForgeModelSelection = DEFAULT_PROMPT_FORGE_MODEL_SELECTION;
          } else {
            try {
              state.promptForgeModelSelection = normalizePromptForgeModelSelection(
                state.promptForgeModelSelection,
              );
            } catch {
              state.promptForgeModelSelection = DEFAULT_PROMPT_FORGE_MODEL_SELECTION;
            }
          }
          if (fromVersion < 16 || typeof state.promptForgeAutoUpgradeOnSend !== 'boolean') {
            state.promptForgeAutoUpgradeOnSend = false;
          }
          if (
            fromVersion < 17 ||
            !state.preferredConnectionIdByProviderFamily ||
            typeof state.preferredConnectionIdByProviderFamily !== 'object'
          ) {
            state.preferredConnectionIdByProviderFamily = {};
          }
          if (fromVersion < 18 || typeof state.promptForgeUseRlmContext !== 'boolean') {
            state.promptForgeUseRlmContext = true;
          }
          if (fromVersion < 19) {
            state.voiceMainAgentProvider = normalizeVoiceAgentProvider(
              state.voiceMainAgentProvider,
            );
            state.voiceWorkerProvider = normalizeVoiceAgentProvider(state.voiceWorkerProvider);
          }
          if (fromVersion < 20) {
            state.voiceMiniBarEnabled = false;
            state.voiceStartFreshChat = false;
          }
          state.voiceWorkerSessionMode = normalizeVoiceWorkerSessionMode(
            state.voiceWorkerSessionMode,
          );
          state.voiceProviderAccentsEnabled =
            typeof state.voiceProviderAccentsEnabled === 'boolean'
              ? state.voiceProviderAccentsEnabled
              : false;
          state.voiceAccentIntensity = normalizeVoiceAccentIntensity(state.voiceAccentIntensity);
          return state;
        },
      },
    ),
  ),
);

export type LocalWorkspaceRecoveryScope = {
  localUserId: string;
  workspaceId: WorkspaceId;
  projectId: ProjectId;
};

let localWorkspaceRecoveryRevision = 0;
useAuthStore.subscribe((next, previous) => {
  if (
    next.localUserId !== previous.localUserId ||
    next.workspaceId !== previous.workspaceId ||
    next.projectId !== previous.projectId ||
    next.cloudSession !== previous.cloudSession
  )
    localWorkspaceRecoveryRevision += 1;
});
const recoveryPersistOptions = useAuthStore.persist.getOptions();
const recoveryPartialize = recoveryPersistOptions.partialize;
const recoveryStorage = recoveryPersistOptions.storage;
// Observe the public persistence configuration API, including change-and-restore
// sequences inside synchronous storage callbacks. Never swap persistence options
// during recovery or treat the final option values alone as an authority receipt.
const setRecoveryPersistOptions = useAuthStore.persist.setOptions;
useAuthStore.persist.setOptions = (...args) => {
  localWorkspaceRecoveryRevision += 1;
  return setRecoveryPersistOptions(...args);
};

function recoveryPersistenceIsCurrent(): boolean {
  const options = useAuthStore.persist.getOptions();
  return (
    options.name === 'jarvis-auth' &&
    options.version === 21 &&
    options.partialize === recoveryPartialize &&
    options.storage === recoveryStorage &&
    !!recoveryPartialize &&
    useAuthStore.persist.hasHydrated()
  );
}

export function getLocalWorkspaceRecoveryRevision(): number {
  return localWorkspaceRecoveryRevision;
}

function matchesRecoveryScope(
  value: Partial<LocalWorkspaceRecoveryScope>,
  scope: LocalWorkspaceRecoveryScope,
): boolean {
  return (
    value.localUserId === scope.localUserId &&
    value.workspaceId === scope.workspaceId &&
    value.projectId === scope.projectId
  );
}

/** Read directly: the generic storage adapter can erase/evict data on failure. */
export function readLocalWorkspaceRecoveryStorage(
  source: LocalWorkspaceRecoveryScope,
  target?: LocalWorkspaceRecoveryScope,
): string {
  const revision = localWorkspaceRecoveryRevision;
  if (!recoveryPersistenceIsCurrent() || !recoveryPartialize) {
    throw new Error('Local profile persistence is not ready.');
  }
  const raw = window.localStorage.getItem('jarvis-auth');
  if (!raw) throw new Error('The saved local profile is missing.');
  const parsed = JSON.parse(raw);
  if (
    parsed?.version !== 21 ||
    !parsed.state ||
    typeof parsed.state !== 'object' ||
    Array.isArray(parsed.state) ||
    parsed.state.cloudSession != null ||
    (!matchesRecoveryScope(parsed.state, source) &&
      (!target || !matchesRecoveryScope(parsed.state, target)))
  ) {
    throw new Error('The saved local profile changed. Check recovery again.');
  }
  // Refuse unsupported persistence shapes instead of silently dropping fields.
  const projected = recoveryPartialize(useAuthStore.getState());
  if (!projected || typeof projected !== 'object' || Array.isArray(projected)) {
    throw new Error('Local profile persistence is not ready.');
  }
  const allowed = new Set(Object.keys(projected));
  if (Object.keys(parsed.state).some((key) => !allowed.has(key))) {
    throw new Error('The saved local profile format is not supported.');
  }
  if (localWorkspaceRecoveryRevision !== revision || !recoveryPersistenceIsCurrent()) {
    throw new Error('Local profile persistence changed. Check recovery again.');
  }
  return raw;
}

/** Only the durable, receipt-bound recovery path may call this narrow activator. */
export function activateLocalWorkspaceRecovery(input: {
  source: LocalWorkspaceRecoveryScope;
  target: LocalWorkspaceRecoveryScope;
  revision: number;
  isCurrent: () => boolean;
}): void {
  if (!recoveryPersistenceIsCurrent()) {
    throw new Error('Local profile persistence is not ready.');
  }
  const state = useAuthStore.getState();
  const current = () =>
    useAuthStore.getState() === state &&
    localWorkspaceRecoveryRevision === input.revision &&
    recoveryPersistenceIsCurrent() &&
    state.cloudSession === null &&
    matchesRecoveryScope(state as LocalWorkspaceRecoveryScope, input.source) &&
    input.isCurrent();
  if (!current() || input.source.localUserId !== input.target.localUserId) {
    throw new Error('Local account changed. Check recovery again.');
  }
  const raw = readLocalWorkspaceRecoveryStorage(input.source, input.target);
  if (!current()) throw new Error('Local account changed. Check recovery again.');
  const parsed = JSON.parse(raw);
  const next = JSON.stringify({ ...parsed, state: { ...parsed.state, ...input.target } });
  // No await, temporary options swap, quota fallback, cache eviction or old-byte restore.
  // A successful write followed by a failed read is resumable from the durable receipt.
  if (window.localStorage.getItem('jarvis-auth') !== raw || !current()) {
    throw new Error('The saved local profile changed. Check recovery again.');
  }
  window.localStorage.setItem('jarvis-auth', next);
  if (window.localStorage.getItem('jarvis-auth') !== next || !current()) {
    throw new Error('Local profile activation needs another recovery check.');
  }
  setRecoveryState({ workspaceId: input.target.workspaceId, projectId: input.target.projectId });
  const activated = useAuthStore.getState();
  if (
    activated.cloudSession !== null ||
    !matchesRecoveryScope(activated as LocalWorkspaceRecoveryScope, input.target) ||
    localWorkspaceRecoveryRevision !==
      input.revision + (matchesRecoveryScope(input.source, input.target) ? 0 : 1)
  ) {
    throw new Error('Local account changed during activation. The recovery remains saved.');
  }
}
