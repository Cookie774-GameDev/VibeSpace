import { describe, expect, it } from 'vitest';

import type { BrowserChatPermissionProfile } from './permissionRegistry';
import { deriveBrowserChatStatusModel } from './browserChatStatusModel';

const profile: BrowserChatPermissionProfile = {
  version: 1,
  accountId: 'account-1',
  workspaceId: 'workspace-1',
  plan: 'project_developer',
  overrides: {},
  updatedAt: 100,
};

describe('Browser Chat independent status model', () => {
  it('does not infer provider sign-in or MCP authorization from a connected relay', () => {
    const status = deriveBrowserChatStatusModel({
      provider: { id: 'chatgpt', label: 'ChatGPT', pageStatus: 'ready' },
      account: { id: 'account-1', label: 'owner@example.test' },
      relayStatus: 'connected',
      mcpSetupState: 'idle',
      permissionProfile: profile,
      workspaceGrant: null,
      providerCapabilityTier: 'unknown',
      availableCapabilities: new Set(['files.list', 'files.read']),
      toolActivity: null,
      project: null,
      contextAvailable: false,
    });

    expect(status).toMatchObject({
      providerPage: { state: 'ready', label: 'ChatGPT · ready' },
      providerSession: {
        state: 'provider_managed',
        label: 'Provider-managed · sign-in state not exposed',
      },
      vibespaceAccount: { state: 'signed_in', label: 'owner@example.test' },
      mcpAuthorization: {
        state: 'unknown',
        label: 'Unknown · no OAuth authorization evidence',
      },
      desktopRelay: { state: 'connected', label: 'Connected' },
      model: { state: 'provider_controlled' },
      chatGptUsage: { state: 'unavailable' },
    });
  });

  it('shows waiting setup separately and accepts only matching OAuth evidence', () => {
    const waiting = deriveBrowserChatStatusModel({
      provider: { id: 'chatgpt', label: 'ChatGPT', pageStatus: 'opening' },
      account: { id: 'account-1', label: 'account-1' },
      relayStatus: 'connecting',
      mcpSetupState: 'waiting',
      permissionProfile: profile,
      workspaceGrant: null,
      providerCapabilityTier: 'read_fetch_only',
      availableCapabilities: new Set(['files.list', 'files.read']),
      toolActivity: null,
      project: null,
      contextAvailable: false,
      mcpAuthorizationEvidence: {
        accountId: 'foreign-account',
        state: 'authorized',
        observedAt: 120,
      },
    });

    expect(waiting.mcpAuthorization).toEqual({
      state: 'waiting_for_user',
      label: 'Waiting for user authorization',
    });
    expect(waiting.toolBridge.providerLimitedCount).toBe(8);

    const authorized = deriveBrowserChatStatusModel({
      provider: { id: 'chatgpt', label: 'ChatGPT', pageStatus: 'ready' },
      account: { id: 'account-1', label: 'account-1' },
      relayStatus: 'connected',
      mcpSetupState: 'idle',
      permissionProfile: profile,
      workspaceGrant: null,
      providerCapabilityTier: 'read_fetch_only',
      availableCapabilities: new Set(['files.list', 'files.read']),
      toolActivity: null,
      project: null,
      contextAvailable: false,
      mcpAuthorizationEvidence: {
        accountId: 'account-1',
        state: 'authorized',
        observedAt: 120,
        lastUsedAt: 125,
      },
    });

    expect(authorized.mcpAuthorization).toEqual({
      state: 'authorized',
      label: 'Authorized · last used 125',
    });
  });

  it('reports executable, advertised, provider-limited, running, and last-result truth independently', () => {
    const status = deriveBrowserChatStatusModel({
      provider: { id: 'chatgpt', label: 'ChatGPT', pageStatus: 'ready' },
      account: { id: 'account-1', label: 'account-1' },
      relayStatus: 'connected',
      mcpSetupState: 'idle',
      permissionProfile: profile,
      workspaceGrant: { displayName: 'Fixture project' },
      providerCapabilityTier: 'read_fetch_only',
      availableCapabilities: new Set(['files.list', 'files.read', 'files.modify']),
      toolActivity: {
        advertisedTools: ['fs.list', 'fs.read'],
        activeCalls: [{ toolName: 'fs.read' }],
        lastResult: { toolName: 'fs.list', ok: false, errorCode: 'LOCAL_READ_DENIED' },
      },
      project: { name: 'Fixture project', linkedProviderProjectId: null },
      contextAvailable: true,
    });

    expect(status.toolBridge).toMatchObject({
      profile: 'project_developer',
      advertisedCount: 2,
      executableCount: 2,
      providerLimitedCount: 8,
      runningCount: 1,
      currentTool: 'fs.read',
      lastResult: 'fs.list · LOCAL_READ_DENIED',
    });
    expect(status.localProject).toEqual({
      state: 'granted',
      label: 'Fixture project · granted · context available · provider project not linked',
    });
  });

  it('keeps signed-out, revoked project, and stale authorization states explicit', () => {
    const status = deriveBrowserChatStatusModel({
      provider: { id: 'chatgpt', label: 'ChatGPT', pageStatus: 'error' },
      account: null,
      relayStatus: 'disabled',
      mcpSetupState: 'error',
      permissionProfile: null,
      workspaceGrant: null,
      providerCapabilityTier: 'unknown',
      availableCapabilities: new Set(),
      toolActivity: null,
      project: { name: 'Fixture project', linkedProviderProjectId: 'remote-1' },
      contextAvailable: false,
      grantRevoked: true,
      mcpAuthorizationEvidence: {
        accountId: 'account-1',
        state: 'stale',
        observedAt: 120,
      },
    });

    expect(status.vibespaceAccount).toEqual({
      state: 'signed_out',
      label: 'Signed out',
    });
    expect(status.mcpAuthorization).toEqual({
      state: 'setup_required',
      label: 'Setup required',
    });
    expect(status.desktopRelay).toEqual({ state: 'offline', label: 'Offline' });
    expect(status.localProject).toEqual({
      state: 'revoked',
      label: 'Fixture project · grant revoked · context unavailable · provider project linked',
    });
  });
});
