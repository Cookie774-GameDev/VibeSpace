import { describe, expect, it } from 'vitest';
import { RunScopedApprovalLeaseStore } from '../RunScopedApprovalLease';

describe('RunScopedApprovalLeaseStore', () => {
  it('authorizes only the exact run, grant and scope', () => {
    const store = new RunScopedApprovalLeaseStore();
    store.start({ runId: 'run-1', grantId: 'grant-1', scopeKey: 'scope-1', issuedAt: 100 });
    expect(store.allows({ runId: 'run-1', grantId: 'grant-1', scopeKey: 'scope-1', now: 101 })).toBe(true);
    expect(store.allows({ runId: 'run-2', grantId: 'grant-1', scopeKey: 'scope-1', now: 101 })).toBe(false);
    expect(store.allows({ runId: 'run-1', grantId: 'grant-2', scopeKey: 'scope-1', now: 101 })).toBe(false);
  });

  it('expires and never survives an explicit permission boundary', () => {
    const store = new RunScopedApprovalLeaseStore();
    store.start({
      runId: 'run', grantId: 'grant', scopeKey: 'scope', issuedAt: 100, expiresAt: 200,
    });
    expect(store.current(199)).not.toBeNull();
    expect(store.current(200)).toBeNull();
    expect(store.lastEndReason).toBe('expired');

    store.start({ runId: 'next', grantId: 'grant', scopeKey: 'scope', issuedAt: 300 });
    store.end('permission-changed');
    expect(store.current(301)).toBeNull();
    expect(store.lastEndReason).toBe('permission-changed');
  });
});
