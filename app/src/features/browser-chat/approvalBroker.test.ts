import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BrowserChatApprovalBroker, BrowserChatApprovalError } from './approvalBroker';
import { BROWSER_CHAT_CAPABILITIES, type BrowserChatPermissionProfile } from './permissionRegistry';

function profile(plan: BrowserChatPermissionProfile['plan']): BrowserChatPermissionProfile {
  return {
    version: 1,
    accountId: 'account-a',
    workspaceId: 'project-a',
    plan,
    overrides: {},
    updatedAt: 1,
  };
}

function createBroker(plan: BrowserChatPermissionProfile['plan']) {
  let token = 0;
  return new BrowserChatApprovalBroker({
    profile: profile(plan),
    grantedCapabilities: new Set(BROWSER_CHAT_CAPABILITIES.map((entry) => entry.id)),
    availableCapabilities: new Set(BROWSER_CHAT_CAPABILITIES.map((entry) => entry.id)),
    providerCapabilities: new Set(BROWSER_CHAT_CAPABILITIES.map((entry) => entry.id)),
    providerBridgeAvailable: true,
    leaseIdFactory: () => `lease-approval-${++token}`,
    requestIdFactory: () => `approval-request-${++token}`,
  });
}

describe('Browser Chat approval broker', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('grants auto capabilities immediately and returns structured denials', () => {
    const read = createBroker('read');
    expect(read.authorize('files.read', { now: 100, ttlMs: 1_000 })).toMatchObject({
      kind: 'granted',
      lease: { capabilityId: 'files.read', accountId: 'account-a', workspaceId: 'project-a' },
    });
    expect(read.authorize('files.modify', { now: 100, ttlMs: 1_000 })).toEqual({
      kind: 'denied',
      denial: { source: 'permission_plan', code: 'capability_disabled' },
    });

    const providerLimited = new BrowserChatApprovalBroker({
      profile: profile('project_developer'),
      grantedCapabilities: new Set(BROWSER_CHAT_CAPABILITIES.map((entry) => entry.id)),
      availableCapabilities: new Set(BROWSER_CHAT_CAPABILITIES.map((entry) => entry.id)),
      providerCapabilities: new Set(['files.read']),
      providerBridgeAvailable: true,
    });
    expect(providerLimited.authorize('files.modify', { now: 100, ttlMs: 1_000 })).toEqual({
      kind: 'denied',
      denial: { source: 'provider', code: 'provider_capability_unsupported' },
    });
  });

  it('asks once per session for ordinary mutations and consumes every lease once', () => {
    const broker = createBroker('project_developer');
    const pending = broker.authorize('files.modify', { now: 100, ttlMs: 1_000 });
    expect(pending).toMatchObject({
      kind: 'approval_required',
      request: { capabilityId: 'files.modify', approvalMode: 'ask' },
    });
    if (pending.kind !== 'approval_required') throw new Error('expected pending approval');

    const lease = broker.approve(pending.request.id, { now: 200, ttlMs: 1_000 });
    const operation = broker.begin(lease, { now: 200 });
    expect(operation.signal.aborted).toBe(false);
    operation.finish();
    expect(() => broker.begin(lease, { now: 200 })).toThrowError(
      expect.objectContaining({ code: 'lease_replayed' }),
    );

    expect(broker.authorize('files.modify', { now: 300, ttlMs: 1_000 })).toMatchObject({
      kind: 'granted',
    });
  });

  it('asks every time for destructive actions and expires unanswered approvals', () => {
    const broker = createBroker('project_developer');
    const first = broker.authorize('files.delete', {
      now: 100,
      ttlMs: 1_000,
      approvalTimeoutMs: 500,
    });
    if (first.kind !== 'approval_required') throw new Error('expected pending approval');
    broker.approve(first.request.id, { now: 200, ttlMs: 1_000 });
    expect(broker.authorize('files.delete', { now: 300, ttlMs: 1_000 })).toMatchObject({
      kind: 'approval_required',
    });

    const expiring = broker.authorize('terminal.execute', {
      now: 1_000,
      ttlMs: 1_000,
      approvalTimeoutMs: 500,
    });
    if (expiring.kind !== 'approval_required') throw new Error('expected pending approval');
    vi.advanceTimersByTime(500);
    expect(broker.getSnapshot().some((request) => request.id === expiring.request.id)).toBe(false);
    expect(() => broker.approve(expiring.request.id, { now: 1_500, ttlMs: 1_000 })).toThrow(
      BrowserChatApprovalError,
    );
  });

  it('revokes active and pending work immediately on profile change or sign-out', () => {
    const broker = createBroker('project_developer');
    const read = broker.authorize('files.read', { now: 100, ttlMs: 1_000 });
    if (read.kind !== 'granted') throw new Error('expected granted read');
    const operation = broker.begin(read.lease, { now: 100 });
    broker.authorize('files.modify', { now: 100, ttlMs: 1_000 });

    broker.updateProfile(profile('off'));
    expect(operation.signal.aborted).toBe(true);
    expect(broker.getSnapshot()).toEqual([]);
    expect(broker.authorize('files.read', { now: 200, ttlMs: 1_000 })).toMatchObject({
      kind: 'denied',
    });

    broker.signOut();
    expect(() => broker.authorize('files.read', { now: 300, ttlMs: 1_000 })).toThrowError(
      expect.objectContaining({ code: 'runtime_signed_out' }),
    );
  });

  it('rejects malformed replacement profiles before revoking valid authority', () => {
    const broker = createBroker('read');
    const read = broker.authorize('files.read', { now: 100, ttlMs: 1_000 });
    if (read.kind !== 'granted') throw new Error('expected granted read');

    expect(() =>
      broker.updateProfile({
        ...profile('custom'),
        overrides: { 'files.delete': 'auto' },
      } as BrowserChatPermissionProfile),
    ).toThrowError('browser_chat_permission_profile_critical_override_invalid');

    expect(broker.begin(read.lease, { now: 200 }).signal.aborted).toBe(false);
  });
});
