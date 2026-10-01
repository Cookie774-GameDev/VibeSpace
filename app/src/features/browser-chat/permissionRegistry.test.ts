import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  BROWSER_CHAT_CAPABILITIES,
  BrowserChatPermissionRuntime,
  PermissionRuntimeError,
  calculateCapabilityCatalog,
  deserializePermissionProfile,
  diffCapabilityCatalog,
  permissionModeFor,
  serializePermissionProfile,
  type BrowserChatPermissionProfile,
} from './permissionRegistry';

function profile(
  plan: BrowserChatPermissionProfile['plan'],
  overrides: BrowserChatPermissionProfile['overrides'] = {},
): BrowserChatPermissionProfile {
  return {
    version: 1,
    accountId: 'account-a',
    workspaceId: 'workspace-a',
    plan,
    overrides,
    updatedAt: 10,
  };
}

describe('Browser Chat permission registry', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('defines stable fail-closed presets without weakening critical approvals', () => {
    expect(BROWSER_CHAT_CAPABILITIES.map((capability) => capability.id)).toEqual([
      'files.list',
      'files.read',
      'files.search',
      'git.status',
      'browser.read',
      'mcp.list',
      'mcp.read',
      'project.list',
      'project.context',
      'project.outputs',
      'files.create',
      'files.modify',
      'files.move',
      'files.delete',
      'git.checkpoint',
      'terminal.execute',
      'browser.mutate',
      'mcp.invoke',
    ]);
    expect(permissionModeFor(profile('off'), 'files.read')).toBe('deny');
    expect(permissionModeFor(profile('read'), 'files.read')).toBe('auto');
    expect(permissionModeFor(profile('read'), 'mcp.read')).toBe('auto');
    expect(permissionModeFor(profile('read'), 'mcp.invoke')).toBe('deny');
    expect(permissionModeFor(profile('read'), 'files.modify')).toBe('deny');
    expect(permissionModeFor(profile('project_developer'), 'files.modify')).toBe('ask');
    expect(permissionModeFor(profile('full_local_developer'), 'files.modify')).toBe('auto');
    expect(permissionModeFor(profile('full_local_developer'), 'files.delete')).toBe('always_ask');
    expect(permissionModeFor(profile('full_local_developer'), 'terminal.execute')).toBe(
      'always_ask',
    );
    expect(permissionModeFor(profile('custom'), 'files.read')).toBe('deny');
    expect(permissionModeFor(profile('custom', { 'files.read': 'auto' }), 'files.read')).toBe(
      'auto',
    );
  });

  it('round-trips versioned custom profiles and rejects unknown or unsafe serialized values', () => {
    const input = profile('custom', {
      'files.read': 'auto',
      'files.modify': 'ask',
      'files.delete': 'always_ask',
    });
    expect(deserializePermissionProfile(serializePermissionProfile(input))).toEqual(input);

    expect(() =>
      deserializePermissionProfile(JSON.stringify({ ...input, plan: 'everything_everywhere' })),
    ).toThrow('browser_chat_permission_profile_invalid');
    expect(() =>
      deserializePermissionProfile(
        JSON.stringify({ ...input, overrides: { 'unknown.capability': 'auto' } }),
      ),
    ).toThrow('browser_chat_permission_profile_invalid');
    expect(() =>
      deserializePermissionProfile(
        JSON.stringify({ ...input, overrides: { 'files.delete': 'auto' } }),
      ),
    ).toThrow('browser_chat_permission_profile_critical_override_invalid');
    expect(() =>
      deserializePermissionProfile(
        JSON.stringify({
          ...profile('read'),
          overrides: { 'files.modify': 'auto' },
        }),
      ),
    ).toThrow('browser_chat_permission_profile_invalid');
  });

  it('calculates a dynamic catalog with distinct denial sources and stable diffs', () => {
    const readCatalog = calculateCapabilityCatalog({
      profile: profile('read'),
      grantedCapabilities: new Set(['files.list', 'files.read', 'files.search', 'git.status']),
      availableCapabilities: new Set(['files.list', 'files.read', 'git.status']),
      providerBridgeAvailable: true,
    });
    expect(readCatalog.find((entry) => entry.id === 'files.read')).toMatchObject({
      available: true,
      approvalMode: 'auto',
    });
    expect(readCatalog.find((entry) => entry.id === 'files.search')).toMatchObject({
      available: false,
      denial: { source: 'runtime', code: 'capability_unavailable' },
    });
    expect(readCatalog.find((entry) => entry.id === 'files.modify')).toMatchObject({
      available: false,
      denial: { source: 'permission_plan', code: 'capability_disabled' },
    });

    const disconnected = calculateCapabilityCatalog({
      profile: profile('read'),
      grantedCapabilities: new Set(['files.read']),
      availableCapabilities: new Set(['files.read']),
      providerBridgeAvailable: false,
    });
    expect(disconnected.find((entry) => entry.id === 'files.read')).toMatchObject({
      denial: { source: 'provider', code: 'provider_bridge_unavailable' },
    });

    const developerCatalog = calculateCapabilityCatalog({
      profile: profile('project_developer'),
      grantedCapabilities: new Set(BROWSER_CHAT_CAPABILITIES.map((entry) => entry.id)),
      availableCapabilities: new Set(BROWSER_CHAT_CAPABILITIES.map((entry) => entry.id)),
      providerBridgeAvailable: true,
    });
    const diff = diffCapabilityCatalog(readCatalog, developerCatalog);
    expect(diff.changed).toContain('files.modify');
    expect(diff.changed).toContain('terminal.execute');
    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual([]);
  });

  it('reports a missing workspace grant separately from provider-plan limitations', () => {
    const catalog = calculateCapabilityCatalog({
      profile: profile('project_developer'),
      grantedCapabilities: new Set(),
      availableCapabilities: new Set(['files.read']),
      providerBridgeAvailable: true,
    });
    expect(catalog.find((entry) => entry.id === 'files.read')).toMatchObject({
      denial: { source: 'workspace_grant', code: 'workspace_grant_missing' },
    });
  });

  it('reports a provider-plan limit separately from local runtime availability', () => {
    const catalog = calculateCapabilityCatalog({
      profile: profile('project_developer'),
      grantedCapabilities: new Set(BROWSER_CHAT_CAPABILITIES.map((entry) => entry.id)),
      providerCapabilities: new Set(['files.list', 'files.read', 'files.search']),
      availableCapabilities: new Set(BROWSER_CHAT_CAPABILITIES.map((entry) => entry.id)),
      providerBridgeAvailable: true,
    });
    expect(catalog.find((entry) => entry.id === 'files.modify')).toMatchObject({
      denial: { source: 'provider', code: 'provider_capability_unsupported' },
    });
    expect(catalog.find((entry) => entry.id === 'files.read')).toMatchObject({
      available: true,
    });
  });

  it('revokes active work immediately and rejects stale, wrong-account, replayed, and unavailable leases', () => {
    let nextLease = 0;
    const runtime = new BrowserChatPermissionRuntime({
      accountId: 'account-a',
      workspaceId: 'workspace-a',
      availableCapabilities: new Set(['files.read']),
      tokenFactory: () => `lease-12345678901${nextLease++}`,
    });
    const lease = runtime.issueLease('files.read', 1_000, 100);
    expect(() =>
      runtime.begin(lease, {
        accountId: 'account-b',
        workspaceId: 'workspace-a',
        now: 100,
      }),
    ).toThrowError(expect.objectContaining({ code: 'wrong_account' }));

    const operation = runtime.begin(lease, {
      accountId: 'account-a',
      workspaceId: 'workspace-a',
      now: 100,
    });
    expect(operation.signal.aborted).toBe(false);
    expect(() =>
      runtime.begin(lease, {
        accountId: 'account-a',
        workspaceId: 'workspace-a',
        now: 100,
      }),
    ).toThrowError(expect.objectContaining({ code: 'lease_replayed' }));

    runtime.revoke();
    expect(operation.signal.aborted).toBe(true);
    expect(operation.signal.reason).toBe('permission_revoked');
    const stale = runtime.issueLease('files.read', 1_000, 100);
    runtime.revoke();
    expect(() =>
      runtime.begin(stale, {
        accountId: 'account-a',
        workspaceId: 'workspace-a',
        now: 100,
      }),
    ).toThrowError(expect.objectContaining({ code: 'lease_revoked' }));

    const unavailableRuntime = new BrowserChatPermissionRuntime({
      accountId: 'account-a',
      workspaceId: 'workspace-a',
      availableCapabilities: new Set(),
      tokenFactory: () => 'lease-unavailable1',
    });
    const unavailable = unavailableRuntime.issueLease('files.read', 1_000, 100);
    expect(() =>
      unavailableRuntime.begin(unavailable, {
        accountId: 'account-a',
        workspaceId: 'workspace-a',
        now: 100,
      }),
    ).toThrowError(expect.objectContaining({ code: 'capability_unavailable' }));
  });

  it('cancels active work on sign-out and timeout', () => {
    let nextLease = 0;
    const runtime = new BrowserChatPermissionRuntime({
      accountId: 'account-a',
      workspaceId: 'workspace-a',
      availableCapabilities: new Set(['files.read']),
      tokenFactory: () => `lease-timeout1234${nextLease++}`,
    });
    const timed = runtime.begin(runtime.issueLease('files.read', 500, 1_000), {
      accountId: 'account-a',
      workspaceId: 'workspace-a',
      now: 1_000,
    });
    vi.advanceTimersByTime(500);
    expect(timed.signal.aborted).toBe(true);
    expect(timed.signal.reason).toBe('permission_timeout');

    const signedOut = runtime.begin(runtime.issueLease('files.read', 500, 2_000), {
      accountId: 'account-a',
      workspaceId: 'workspace-a',
      now: 2_000,
    });
    runtime.signOut();
    expect(signedOut.signal.aborted).toBe(true);
    expect(signedOut.signal.reason).toBe('account_signed_out');
    expect(() => runtime.issueLease('files.read', 500, 2_000)).toThrow(PermissionRuntimeError);
  });
});
