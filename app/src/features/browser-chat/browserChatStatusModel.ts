import type { BrowserChatRelayStatus } from '@/lib/bridge';

import {
  BROWSER_CHAT_CAPABILITIES,
  calculateCapabilityCatalog,
  permissionModeFor,
  type BrowserChatCapabilityId,
  type BrowserChatPermissionProfile,
} from './permissionRegistry';
import {
  providerCapabilitiesForTier,
  type ChatGptProviderCapabilityTier,
} from './providerCapability';

export type BrowserChatMcpSetupState = 'idle' | 'checking' | 'opening' | 'waiting' | 'error';

export type BrowserChatMcpAuthorizationEvidence = Readonly<{
  accountId: string;
  state: 'authorized' | 'stale';
  observedAt: number;
  lastUsedAt?: number;
}>;

type StatusValue<State extends string> = Readonly<{
  state: State;
  label: string;
}>;

type ToolActivityInput = Readonly<{
  advertisedTools: readonly string[];
  activeCalls: readonly Readonly<{ toolName: string }>[];
  lastResult: Readonly<{
    toolName: string;
    ok: boolean;
    errorCode?: string;
  }> | null;
}>;

export type BrowserChatStatusModel = Readonly<{
  providerPage: StatusValue<string>;
  providerSession: StatusValue<'provider_managed'>;
  vibespaceAccount: StatusValue<'signed_in' | 'signed_out'>;
  mcpAuthorization: StatusValue<
    'setup_required' | 'waiting_for_user' | 'authorized' | 'stale' | 'unknown'
  >;
  desktopRelay: StatusValue<'connecting' | 'connected' | 'reconnecting' | 'error' | 'offline'>;
  toolBridge: Readonly<{
    profile: BrowserChatPermissionProfile['plan'] | 'unavailable';
    advertisedCount: number;
    executableCount: number;
    providerLimitedCount: number;
    runningCount: number;
    currentTool: string | null;
    lastResult: string | null;
  }>;
  localProject: StatusValue<'unavailable' | 'available' | 'granted' | 'revoked'>;
  model: StatusValue<'provider_controlled'>;
  chatGptUsage: StatusValue<'unavailable'>;
}>;

type StatusModelInput = Readonly<{
  provider: Readonly<{ id: string; label: string; pageStatus: string }>;
  account: Readonly<{ id: string; label: string }> | null;
  relayStatus: BrowserChatRelayStatus;
  mcpSetupState: BrowserChatMcpSetupState;
  mcpAuthorizationEvidence?: BrowserChatMcpAuthorizationEvidence;
  permissionProfile: BrowserChatPermissionProfile | null;
  workspaceGrant: Readonly<{ displayName: string }> | null;
  providerCapabilityTier: ChatGptProviderCapabilityTier;
  availableCapabilities: ReadonlySet<BrowserChatCapabilityId>;
  toolActivity: ToolActivityInput | null;
  project: Readonly<{ name: string; linkedProviderProjectId: string | null }> | null;
  contextAvailable: boolean;
  grantRevoked?: boolean;
}>;

function relayStatus(status: BrowserChatRelayStatus): BrowserChatStatusModel['desktopRelay'] {
  if (status === 'connected') return { state: 'connected', label: 'Connected' };
  if (status === 'connecting') return { state: 'connecting', label: 'Connecting' };
  if (status === 'reconnecting') return { state: 'reconnecting', label: 'Reconnecting' };
  if (status === 'error') return { state: 'error', label: 'Error' };
  return { state: 'offline', label: 'Offline' };
}

function authorizationStatus(input: StatusModelInput): BrowserChatStatusModel['mcpAuthorization'] {
  if (!input.account) return { state: 'setup_required', label: 'Setup required' };
  const evidence =
    input.mcpAuthorizationEvidence?.accountId === input.account.id
      ? input.mcpAuthorizationEvidence
      : undefined;
  if (evidence?.state === 'authorized') {
    return {
      state: 'authorized',
      label:
        evidence.lastUsedAt === undefined
          ? `Authorized · observed ${evidence.observedAt}`
          : `Authorized · last used ${evidence.lastUsedAt}`,
    };
  }
  if (evidence?.state === 'stale') {
    return { state: 'stale', label: 'Re-auth required' };
  }
  if (
    input.mcpSetupState === 'checking' ||
    input.mcpSetupState === 'opening' ||
    input.mcpSetupState === 'waiting'
  ) {
    return { state: 'waiting_for_user', label: 'Waiting for user authorization' };
  }
  if (input.mcpSetupState === 'error') {
    return { state: 'setup_required', label: 'Setup required' };
  }
  return { state: 'unknown', label: 'Unknown · no OAuth authorization evidence' };
}

function toolBridgeStatus(input: StatusModelInput): BrowserChatStatusModel['toolBridge'] {
  const profile = input.permissionProfile;
  const providerCapabilities = new Set(providerCapabilitiesForTier(input.providerCapabilityTier));
  const catalog = profile
    ? calculateCapabilityCatalog({
        profile,
        grantedCapabilities: input.workspaceGrant
          ? new Set(BROWSER_CHAT_CAPABILITIES.map((capability) => capability.id))
          : new Set<BrowserChatCapabilityId>(),
        availableCapabilities: input.availableCapabilities,
        providerCapabilities,
        providerBridgeAvailable: input.relayStatus === 'connected',
      })
    : [];
  const currentTool = input.toolActivity?.activeCalls[0]?.toolName ?? null;
  const lastResult = input.toolActivity?.lastResult;
  return {
    profile: profile?.plan ?? 'unavailable',
    advertisedCount: input.toolActivity?.advertisedTools.length ?? 0,
    executableCount: catalog.filter((entry) => entry.available).length,
    providerLimitedCount: profile
      ? BROWSER_CHAT_CAPABILITIES.filter(
          (capability) =>
            permissionModeFor(profile, capability.id) !== 'deny' &&
            !providerCapabilities.has(capability.id),
        ).length
      : 0,
    runningCount: input.toolActivity?.activeCalls.length ?? 0,
    currentTool,
    lastResult: lastResult
      ? `${lastResult.toolName} · ${lastResult.ok ? 'completed' : (lastResult.errorCode ?? 'failed')}`
      : null,
  };
}

function projectStatus(input: StatusModelInput): BrowserChatStatusModel['localProject'] {
  if (!input.project) return { state: 'unavailable', label: 'No active project' };
  const grantState = input.grantRevoked
    ? 'grant revoked'
    : input.workspaceGrant
      ? 'granted'
      : 'not granted';
  const contextState = input.contextAvailable ? 'context available' : 'context unavailable';
  const providerProjectState = input.project.linkedProviderProjectId
    ? 'provider project linked'
    : 'provider project not linked';
  return {
    state: input.grantRevoked ? 'revoked' : input.workspaceGrant ? 'granted' : 'available',
    label: `${input.project.name} · ${grantState} · ${contextState} · ${providerProjectState}`,
  };
}

export function deriveBrowserChatStatusModel(input: StatusModelInput): BrowserChatStatusModel {
  return Object.freeze({
    providerPage: Object.freeze({
      state: input.provider.pageStatus,
      label: `${input.provider.label} · ${input.provider.pageStatus.replaceAll('_', ' ')}`,
    }),
    providerSession: Object.freeze({
      state: 'provider_managed' as const,
      label: 'Provider-managed · sign-in state not exposed',
    }),
    vibespaceAccount: Object.freeze(
      input.account
        ? { state: 'signed_in' as const, label: input.account.label }
        : { state: 'signed_out' as const, label: 'Signed out' },
    ),
    mcpAuthorization: Object.freeze(authorizationStatus(input)),
    desktopRelay: Object.freeze(relayStatus(input.relayStatus)),
    toolBridge: Object.freeze(toolBridgeStatus(input)),
    localProject: Object.freeze(projectStatus(input)),
    model: Object.freeze({
      state: 'provider_controlled' as const,
      label: 'Provider-controlled · not exposed to VibeSpace',
    }),
    chatGptUsage: Object.freeze({
      state: 'unavailable' as const,
      label: 'ChatGPT web quota is not exposed to VibeSpace',
    }),
  });
}
