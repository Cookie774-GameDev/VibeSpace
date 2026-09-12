export type ApprovalLeaseEndReason =
  | 'run-complete'
  | 'chat-closed'
  | 'permission-changed'
  | 'user-disabled'
  | 'expired'
  | 'replaced';

export interface RunScopedApprovalLease {
  runId: string;
  grantId: string;
  scopeKey: string;
  issuedAt: number;
  expiresAt?: number;
}

function cleanId(value: string, field: string): string {
  const clean = value.trim();
  if (!clean || clean.length > 512 || /[\u0000-\u001f\u007f]/u.test(clean)) {
    throw new Error(`invalid_${field}`);
  }
  return clean;
}

function normalizeLease(
  input: Readonly<RunScopedApprovalLease>,
): RunScopedApprovalLease {
  const issuedAt = Number.isFinite(input.issuedAt) ? Math.max(0, input.issuedAt) : 0;
  const expiresAt = input.expiresAt;
  if (expiresAt !== undefined && (!Number.isFinite(expiresAt) || expiresAt <= issuedAt)) {
    throw new Error('invalid_approval_lease_expiration');
  }
  return Object.freeze({
    runId: cleanId(input.runId, 'approval_run_id'),
    grantId: cleanId(input.grantId, 'approval_grant_id'),
    scopeKey: cleanId(input.scopeKey, 'approval_scope_key'),
    issuedAt,
    ...(expiresAt === undefined ? {} : { expiresAt }),
  });
}

/**
 * In-memory by design: "Approve All" must not silently survive an app restart,
 * chat close, access change, or a different run/workspace grant.
 */
export class RunScopedApprovalLeaseStore {
  #current: RunScopedApprovalLease | null = null;
  #lastEndReason: ApprovalLeaseEndReason | null = null;

  start(input: Readonly<RunScopedApprovalLease>): RunScopedApprovalLease {
    if (this.#current) this.#lastEndReason = 'replaced';
    this.#current = normalizeLease(input);
    return this.#current;
  }

  current(now = Date.now()): RunScopedApprovalLease | null {
    if (this.#current?.expiresAt !== undefined && now >= this.#current.expiresAt) {
      this.end('expired');
    }
    return this.#current;
  }

  allows(input: {
    runId: string;
    grantId: string;
    scopeKey: string;
    now?: number;
  }): boolean {
    const current = this.current(input.now);
    if (!current) return false;
    return (
      current.runId === input.runId.trim()
      && current.grantId === input.grantId.trim()
      && current.scopeKey === input.scopeKey.trim()
    );
  }

  end(reason: ApprovalLeaseEndReason): void {
    this.#current = null;
    this.#lastEndReason = reason;
  }

  get lastEndReason(): ApprovalLeaseEndReason | null {
    return this.#lastEndReason;
  }
}
