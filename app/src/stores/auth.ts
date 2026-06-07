import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import type {
  ProviderId,
  WorkspaceId,
  ProjectId,
  VoiceEngine,
  VoicePresetId,
} from '@/types/common';
import type { PlanId } from '@/lib/entitlements';
import { safeLocalStorage } from '@/lib/persistence/safeLocalStorage';
import {
  SECRET_API_KEY_PROVIDERS,
  isSecretApiKeyProvider,
  loadSecureApiKeys,
  secureDeleteApiKey,
  secureSetApiKey,
} from '@/lib/security/secureApiKeys';

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
  personaPreset: 'jarvis' | 'athena' | 'edge' | 'watson' | 'hal';
  /** Spoken voice profile used everywhere Jarvis speaks. */
  voicePreset: VoicePresetId;
  /** Restrict speech to installed voices when local mode is selected. */
  voiceEngine: VoiceEngine;
  /** Speak completed Jarvis replies, including normal typed conversations. */
  speakReplies: boolean;

  /**
   * Subscription tier. Defaults to `free` for every install. The Stripe
   * billing webhook will flip this once paid plans ship; today no code
   * path mutates it. Lives in the auth store so a future logout can
   * reset it cleanly. See `lib/entitlements.ts` for what each tier
   * unlocks.
   */
  plan: PlanId;

  /** Telemetry opt-in */
  telemetryOptIn: boolean;

  // Actions
  setDisplayName: (n: string) => void;
  setApiKey: (provider: ProviderId, key: string) => void;
  clearApiKey: (provider: ProviderId) => void;
  hydrateApiKeysFromVault: () => Promise<void>;
  setDefaultProvider: (p: ProviderId) => void;
  setSelectedModel: (provider: ProviderId, model: string) => void;
  setPersona: (p: AuthState['personaPreset']) => void;
  setVoicePreset: (p: VoicePresetId) => void;
  setVoiceEngine: (engine: VoiceEngine) => void;
  setSpeakReplies: (enabled: boolean) => void;
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

export const useAuthStore = create<AuthState>()(
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
      voiceEngine: 'system',
      speakReplies: true,
      plan: 'free',
      telemetryOptIn: false,

      setDisplayName: (n) => set({ displayName: n }),
      setApiKey: (provider, key) =>
        set((s) => {
          const trimmed = key.trim();
          if (isSecretApiKeyProvider(provider)) {
            void secureSetApiKey(provider, trimmed).catch((err) => {
              console.warn(`[credentials] Could not save ${provider} API key`, err);
            });
          }
          return { apiKeys: { ...s.apiKeys, [provider]: trimmed } };
        }),
      clearApiKey: (provider) =>
        set((s) => {
          if (isSecretApiKeyProvider(provider)) {
            void secureDeleteApiKey(provider).catch((err) => {
              console.warn(`[credentials] Could not delete ${provider} API key`, err);
            });
          }
          const { [provider]: _, ...rest } = s.apiKeys;
          return { apiKeys: rest };
        }),
      hydrateApiKeysFromVault: async () => {
        const secureKeys = await loadSecureApiKeys();
        set((s) => ({ apiKeys: { ...s.apiKeys, ...secureKeys } }));
      },
      setDefaultProvider: (p) => set({ defaultProvider: p }),
      setSelectedModel: (provider, model) =>
        set((s) => ({
          selectedModels: { ...s.selectedModels, [provider]: model.trim() },
        })),
      setPersona: (p) => set({ personaPreset: p }),
      setVoicePreset: (p) => set({ voicePreset: p }),
      setVoiceEngine: (engine) => set({ voiceEngine: engine }),
      setSpeakReplies: (enabled) => set({ speakReplies: enabled }),
      setWorkspaceId: (id) => set({ workspaceId: id }),
      setProjectId: (id) => set({ projectId: id }),
      setCloudSession: (s) => set({ cloudSession: s }),
      setTelemetryOptIn: (v) => set({ telemetryOptIn: v }),
      setLocalUser: (id) => set({ localUserId: id }),
      setOfflineMode: (v) => set({ offlineMode: v }),
      setDefaultLocalModel: (m) => set({ defaultLocalModel: m.trim() || 'llama3.2' }),
      setPlan: (p) => set({ plan: p }),
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
        speakReplies: s.speakReplies,
        plan: s.plan,
        telemetryOptIn: s.telemetryOptIn,
      }),
      version: 2,
      migrate: (persisted) => {
        if (!persisted || typeof persisted !== 'object') return persisted;
        const state = persisted as Partial<AuthState>;
        const keys = state.apiKeys ?? {};
        const legacySecrets = legacySecretApiKeys(keys);
        migrateLegacySecretsToVault(legacySecrets);
        state.apiKeys = {
          ...persistedLocalApiKeys(keys),
          ...legacySecrets,
        };
        return state;
      },
    },
  ),
);
