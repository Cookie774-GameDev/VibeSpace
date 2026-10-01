import {
  BrowserChatPermissionRuntime,
  PermissionRuntimeError,
  calculateCapabilityCatalog,
  deserializePermissionProfile,
  type BrowserChatApprovalMode,
  type BrowserChatCapabilityDenial,
  type BrowserChatCapabilityId,
  type BrowserChatCapabilityLease,
  type BrowserChatOperation,
  type BrowserChatPermissionProfile,
} from './permissionRegistry';

export type BrowserChatApprovalRequest = Readonly<{
  id: string;
  capabilityId: BrowserChatCapabilityId;
  approvalMode: Extract<BrowserChatApprovalMode, 'ask' | 'always_ask'>;
  accountId: string;
  workspaceId: string;
  requestedAt: number;
  expiresAt: number;
}>;

export type BrowserChatAuthorizationDecision =
  | Readonly<{ kind: 'granted'; lease: BrowserChatCapabilityLease }>
  | Readonly<{ kind: 'approval_required'; request: BrowserChatApprovalRequest }>
  | Readonly<{ kind: 'denied'; denial: BrowserChatCapabilityDenial }>;

export class BrowserChatApprovalError extends Error {
  constructor(readonly code: 'request_invalid' | 'request_expired' | 'scope_mismatch') {
    super(`Browser Chat approval rejected: ${code}.`);
    this.name = 'BrowserChatApprovalError';
  }
}

type BrokerOptions = {
  readonly profile: BrowserChatPermissionProfile;
  readonly grantedCapabilities: ReadonlySet<BrowserChatCapabilityId>;
  readonly availableCapabilities: ReadonlySet<BrowserChatCapabilityId>;
  readonly providerCapabilities: ReadonlySet<BrowserChatCapabilityId>;
  readonly providerBridgeAvailable: boolean;
  readonly leaseIdFactory?: () => string;
  readonly requestIdFactory?: () => string;
};

type PendingRequest = {
  readonly request: BrowserChatApprovalRequest;
  readonly timer: ReturnType<typeof setTimeout>;
};

const SAFE_REQUEST_ID = /^[A-Za-z0-9_-]{12,96}$/u;

export class BrowserChatApprovalBroker {
  readonly #grantedCapabilities: ReadonlySet<BrowserChatCapabilityId>;
  readonly #availableCapabilities: ReadonlySet<BrowserChatCapabilityId>;
  readonly #providerCapabilities: ReadonlySet<BrowserChatCapabilityId>;
  readonly #providerBridgeAvailable: boolean;
  readonly #requestIdFactory: () => string;
  readonly #runtime: BrowserChatPermissionRuntime;
  readonly #pending = new Map<string, PendingRequest>();
  readonly #sessionApprovals = new Set<BrowserChatCapabilityId>();
  readonly #listeners = new Set<() => void>();
  #profile: BrowserChatPermissionProfile;
  #signedOut = false;

  constructor(options: BrokerOptions) {
    this.#profile = deserializePermissionProfile(JSON.stringify(options.profile));
    this.#grantedCapabilities = new Set(options.grantedCapabilities);
    this.#availableCapabilities = new Set(options.availableCapabilities);
    this.#providerCapabilities = new Set(options.providerCapabilities);
    this.#providerBridgeAvailable = options.providerBridgeAvailable;
    this.#requestIdFactory = options.requestIdFactory ?? (() => crypto.randomUUID());
    this.#runtime = new BrowserChatPermissionRuntime({
      accountId: options.profile.accountId,
      workspaceId: options.profile.workspaceId,
      availableCapabilities: options.availableCapabilities,
      tokenFactory: options.leaseIdFactory,
    });
  }

  getSnapshot = (): readonly BrowserChatApprovalRequest[] =>
    [...this.#pending.values()]
      .map(({ request }) => request)
      .sort(
        (left, right) => left.requestedAt - right.requestedAt || left.id.localeCompare(right.id),
      );

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  authorize(
    capabilityId: BrowserChatCapabilityId,
    options: {
      readonly now?: number;
      readonly ttlMs: number;
      readonly approvalTimeoutMs?: number;
    },
  ): BrowserChatAuthorizationDecision {
    if (this.#signedOut) throw new PermissionRuntimeError('runtime_signed_out');
    const now = options.now ?? Date.now();
    const entry = calculateCapabilityCatalog({
      profile: this.#profile,
      grantedCapabilities: this.#grantedCapabilities,
      availableCapabilities: this.#availableCapabilities,
      providerCapabilities: this.#providerCapabilities,
      providerBridgeAvailable: this.#providerBridgeAvailable,
    }).find((candidate) => candidate.id === capabilityId);
    if (!entry || entry.denial) {
      return {
        kind: 'denied',
        denial: entry?.denial ?? {
          source: 'runtime',
          code: 'capability_unavailable',
        },
      };
    }
    if (entry.approvalMode === 'auto' || this.#sessionApprovals.has(capabilityId)) {
      return {
        kind: 'granted',
        lease: this.#runtime.issueLease(capabilityId, options.ttlMs, now),
      };
    }
    if (entry.approvalMode !== 'ask' && entry.approvalMode !== 'always_ask') {
      return {
        kind: 'denied',
        denial: { source: 'permission_plan', code: 'capability_disabled' },
      };
    }
    const approvalTimeoutMs = options.approvalTimeoutMs ?? 30_000;
    if (
      !Number.isSafeInteger(now) ||
      now < 0 ||
      !Number.isSafeInteger(approvalTimeoutMs) ||
      approvalTimeoutMs < 100 ||
      approvalTimeoutMs > 60_000
    ) {
      throw new BrowserChatApprovalError('request_invalid');
    }
    const id = this.#requestIdFactory();
    if (!SAFE_REQUEST_ID.test(id) || this.#pending.has(id)) {
      throw new BrowserChatApprovalError('request_invalid');
    }
    const request = Object.freeze({
      id,
      capabilityId,
      approvalMode: entry.approvalMode,
      accountId: this.#profile.accountId,
      workspaceId: this.#profile.workspaceId,
      requestedAt: now,
      expiresAt: now + approvalTimeoutMs,
    });
    const timer = setTimeout(() => {
      if (!this.#pending.delete(id)) return;
      this.#publish();
    }, approvalTimeoutMs);
    this.#pending.set(id, { request, timer });
    this.#publish();
    return { kind: 'approval_required', request };
  }

  approve(
    requestId: string,
    options: { readonly now?: number; readonly ttlMs: number },
  ): BrowserChatCapabilityLease {
    if (this.#signedOut) throw new PermissionRuntimeError('runtime_signed_out');
    const pending = this.#pending.get(requestId);
    if (!pending) throw new BrowserChatApprovalError('request_invalid');
    const now = options.now ?? Date.now();
    this.#removePending(requestId);
    if (pending.request.expiresAt <= now) {
      throw new BrowserChatApprovalError('request_expired');
    }
    if (
      pending.request.accountId !== this.#profile.accountId ||
      pending.request.workspaceId !== this.#profile.workspaceId
    ) {
      throw new BrowserChatApprovalError('scope_mismatch');
    }
    if (pending.request.approvalMode === 'ask') {
      this.#sessionApprovals.add(pending.request.capabilityId);
    }
    return this.#runtime.issueLease(pending.request.capabilityId, options.ttlMs, now);
  }

  deny(requestId: string): boolean {
    return this.#removePending(requestId);
  }

  begin(
    lease: BrowserChatCapabilityLease,
    options: { readonly now?: number } = {},
  ): BrowserChatOperation {
    return this.#runtime.begin(lease, {
      accountId: this.#profile.accountId,
      workspaceId: this.#profile.workspaceId,
      ...(options.now === undefined ? {} : { now: options.now }),
    });
  }

  updateProfile(profile: BrowserChatPermissionProfile): void {
    const validatedProfile = deserializePermissionProfile(JSON.stringify(profile));
    if (
      validatedProfile.accountId !== this.#profile.accountId ||
      validatedProfile.workspaceId !== this.#profile.workspaceId
    ) {
      throw new BrowserChatApprovalError('scope_mismatch');
    }
    this.#runtime.revoke('permission_profile_changed');
    this.#clearPending();
    this.#sessionApprovals.clear();
    this.#profile = validatedProfile;
  }

  revoke(): void {
    this.#runtime.revoke();
    this.#clearPending();
    this.#sessionApprovals.clear();
  }

  signOut(): void {
    this.#runtime.signOut();
    this.#signedOut = true;
    this.#clearPending();
    this.#sessionApprovals.clear();
  }

  #removePending(requestId: string): boolean {
    const pending = this.#pending.get(requestId);
    if (!pending) return false;
    clearTimeout(pending.timer);
    this.#pending.delete(requestId);
    this.#publish();
    return true;
  }

  #clearPending(): void {
    if (!this.#pending.size) return;
    for (const { timer } of this.#pending.values()) clearTimeout(timer);
    this.#pending.clear();
    this.#publish();
  }

  #publish(): void {
    for (const listener of this.#listeners) listener();
  }
}
