import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { ProviderId, WorkspaceId, ProjectId } from '@/types/common';

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

  /** Persona preset and custom prompt overrides */
  personaPreset: 'jarvis' | 'athena' | 'edge' | 'watson' | 'hal';

  /** Telemetry opt-in */
  telemetryOptIn: boolean;

  // Actions
  setDisplayName: (n: string) => void;
  setApiKey: (provider: ProviderId, key: string) => void;
  clearApiKey: (provider: ProviderId) => void;
  setDefaultProvider: (p: ProviderId) => void;
  setPersona: (p: AuthState['personaPreset']) => void;
  setWorkspaceId: (id: WorkspaceId | null) => void;
  setProjectId: (id: ProjectId | null) => void;
  setCloudSession: (s: AuthState['cloudSession']) => void;
  setTelemetryOptIn: (v: boolean) => void;
  setLocalUser: (id: string) => void;
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
      defaultProvider: 'mock',
      personaPreset: 'jarvis',
      telemetryOptIn: false,

      setDisplayName: (n) => set({ displayName: n }),
      setApiKey: (provider, key) =>
        set((s) => ({ apiKeys: { ...s.apiKeys, [provider]: key.trim() } })),
      clearApiKey: (provider) =>
        set((s) => {
          const { [provider]: _, ...rest } = s.apiKeys;
          return { apiKeys: rest };
        }),
      setDefaultProvider: (p) => set({ defaultProvider: p }),
      setPersona: (p) => set({ personaPreset: p }),
      setWorkspaceId: (id) => set({ workspaceId: id }),
      setProjectId: (id) => set({ projectId: id }),
      setCloudSession: (s) => set({ cloudSession: s }),
      setTelemetryOptIn: (v) => set({ telemetryOptIn: v }),
      setLocalUser: (id) => set({ localUserId: id }),
    }),
    {
      name: 'jarvis-auth',
      partialize: (s) => ({
        localUserId: s.localUserId,
        displayName: s.displayName,
        email: s.email,
        workspaceId: s.workspaceId,
        projectId: s.projectId,
        apiKeys: s.apiKeys,
        defaultProvider: s.defaultProvider,
        personaPreset: s.personaPreset,
        telemetryOptIn: s.telemetryOptIn,
      }),
    },
  ),
);
