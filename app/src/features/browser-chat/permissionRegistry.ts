export type BrowserChatPermissionPlan =
  | 'off'
  | 'read'
  | 'project_developer'
  | 'full_local_developer'
  | 'custom';

export type BrowserChatApprovalMode = 'deny' | 'auto' | 'ask' | 'always_ask';

export type BrowserChatCapabilityDefinition = {
  readonly id:
    | 'files.list'
    | 'files.read'
    | 'files.search'
    | 'git.status'
    | 'browser.read'
    | 'mcp.list'
    | 'mcp.read'
    | 'project.list'
    | 'project.context'
    | 'project.outputs'
    | 'files.create'
    | 'files.modify'
    | 'files.move'
    | 'files.delete'
    | 'git.checkpoint'
    | 'terminal.execute'
    | 'browser.mutate'
    | 'mcp.invoke';
  readonly label: string;
  readonly family: 'files' | 'git' | 'terminal' | 'browser' | 'mcp' | 'project';
  readonly mutates: boolean;
  readonly criticalApproval: boolean;
};

export type BrowserChatCapabilityId = BrowserChatCapabilityDefinition['id'];

export const BROWSER_CHAT_CAPABILITIES: readonly BrowserChatCapabilityDefinition[] = Object.freeze([
  Object.freeze({
    id: 'files.list',
    label: 'List project files',
    family: 'files',
    mutates: false,
    criticalApproval: false,
  }),
  Object.freeze({
    id: 'files.read',
    label: 'Read project files',
    family: 'files',
    mutates: false,
    criticalApproval: false,
  }),
  Object.freeze({
    id: 'files.search',
    label: 'Search project files',
    family: 'files',
    mutates: false,
    criticalApproval: false,
  }),
  Object.freeze({
    id: 'git.status',
    label: 'Read Git status',
    family: 'git',
    mutates: false,
    criticalApproval: false,
  }),
  Object.freeze({
    id: 'browser.read',
    label: 'Read an approved browser session',
    family: 'browser',
    mutates: false,
    criticalApproval: false,
  }),
  Object.freeze({
    id: 'mcp.list',
    label: 'List approved downstream MCP tools',
    family: 'mcp',
    mutates: false,
    criticalApproval: false,
  }),
  Object.freeze({
    id: 'mcp.read',
    label: 'Invoke an approved read-only downstream MCP tool',
    family: 'mcp',
    mutates: false,
    criticalApproval: false,
  }),
  Object.freeze({
    id: 'project.list',
    label: 'List approved VibeSpace projects',
    family: 'project',
    mutates: false,
    criticalApproval: false,
  }),
  Object.freeze({
    id: 'project.context',
    label: 'Read approved project context',
    family: 'project',
    mutates: false,
    criticalApproval: false,
  }),
  Object.freeze({
    id: 'project.outputs',
    label: 'List approved project outputs',
    family: 'project',
    mutates: false,
    criticalApproval: false,
  }),
  Object.freeze({
    id: 'files.create',
    label: 'Create project files',
    family: 'files',
    mutates: true,
    criticalApproval: false,
  }),
  Object.freeze({
    id: 'files.modify',
    label: 'Modify project files',
    family: 'files',
    mutates: true,
    criticalApproval: false,
  }),
  Object.freeze({
    id: 'files.move',
    label: 'Move or rename project files',
    family: 'files',
    mutates: true,
    criticalApproval: false,
  }),
  Object.freeze({
    id: 'files.delete',
    label: 'Delete project paths',
    family: 'files',
    mutates: true,
    criticalApproval: true,
  }),
  Object.freeze({
    id: 'git.checkpoint',
    label: 'Create a Git checkpoint',
    family: 'git',
    mutates: true,
    criticalApproval: false,
  }),
  Object.freeze({
    id: 'terminal.execute',
    label: 'Run a bounded terminal command',
    family: 'terminal',
    mutates: true,
    criticalApproval: true,
  }),
  Object.freeze({
    id: 'browser.mutate',
    label: 'Control an approved browser session',
    family: 'browser',
    mutates: true,
    criticalApproval: true,
  }),
  Object.freeze({
    id: 'mcp.invoke',
    label: 'Invoke an approved downstream MCP tool',
    family: 'mcp',
    mutates: true,
    criticalApproval: true,
  }),
]);

const CAPABILITY_BY_ID = new Map(
  BROWSER_CHAT_CAPABILITIES.map((capability) => [capability.id, capability] as const),
);

const READ_MODES: Readonly<Record<BrowserChatCapabilityId, BrowserChatApprovalMode>> =
  Object.freeze(
    Object.fromEntries(
      BROWSER_CHAT_CAPABILITIES.map((capability) => [
        capability.id,
        capability.mutates ? 'deny' : 'auto',
      ]),
    ) as Record<BrowserChatCapabilityId, BrowserChatApprovalMode>,
  );

const PROJECT_DEVELOPER_MODES: Readonly<Record<BrowserChatCapabilityId, BrowserChatApprovalMode>> =
  Object.freeze(
    Object.fromEntries(
      BROWSER_CHAT_CAPABILITIES.map((capability) => [
        capability.id,
        capability.mutates ? (capability.criticalApproval ? 'always_ask' : 'ask') : 'auto',
      ]),
    ) as Record<BrowserChatCapabilityId, BrowserChatApprovalMode>,
  );

const FULL_LOCAL_DEVELOPER_MODES: Readonly<
  Record<BrowserChatCapabilityId, BrowserChatApprovalMode>
> = Object.freeze(
  Object.fromEntries(
    BROWSER_CHAT_CAPABILITIES.map((capability) => [
      capability.id,
      capability.criticalApproval ? 'always_ask' : 'auto',
    ]),
  ) as Record<BrowserChatCapabilityId, BrowserChatApprovalMode>,
);

export type BrowserChatPermissionProfile = {
  readonly version: 1;
  readonly accountId: string;
  readonly workspaceId: string;
  readonly plan: BrowserChatPermissionPlan;
  readonly overrides: Readonly<Partial<Record<BrowserChatCapabilityId, BrowserChatApprovalMode>>>;
  readonly updatedAt: number;
};

export type BrowserChatCapabilityDenial = {
  readonly source: 'permission_plan' | 'workspace_grant' | 'provider' | 'runtime';
  readonly code:
    | 'capability_disabled'
    | 'workspace_grant_missing'
    | 'provider_bridge_unavailable'
    | 'provider_capability_unsupported'
    | 'capability_unavailable';
};

export type BrowserChatCapabilityCatalogEntry = BrowserChatCapabilityDefinition & {
  readonly approvalMode: BrowserChatApprovalMode;
  readonly approvalRequired: boolean;
  readonly available: boolean;
  readonly denial?: BrowserChatCapabilityDenial;
};

function isCapabilityId(value: unknown): value is BrowserChatCapabilityId {
  return typeof value === 'string' && CAPABILITY_BY_ID.has(value as BrowserChatCapabilityId);
}

function isApprovalMode(value: unknown): value is BrowserChatApprovalMode {
  return value === 'deny' || value === 'auto' || value === 'ask' || value === 'always_ask';
}

function isPermissionPlan(value: unknown): value is BrowserChatPermissionPlan {
  return (
    value === 'off' ||
    value === 'read' ||
    value === 'project_developer' ||
    value === 'full_local_developer' ||
    value === 'custom'
  );
}

function validScope(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 256 &&
    value.trim() === value &&
    !/[\u0000-\u001f\u007f]/u.test(value)
  );
}

function invalidProfile(): never {
  throw new Error('browser_chat_permission_profile_invalid');
}

export function permissionModeFor(
  profile: BrowserChatPermissionProfile,
  capabilityId: BrowserChatCapabilityId,
): BrowserChatApprovalMode {
  const override = profile.overrides[capabilityId];
  if (profile.plan === 'custom') return override ?? 'deny';
  if (profile.plan === 'off') return 'deny';
  if (profile.plan === 'read') return READ_MODES[capabilityId];
  if (profile.plan === 'project_developer') return PROJECT_DEVELOPER_MODES[capabilityId];
  return FULL_LOCAL_DEVELOPER_MODES[capabilityId];
}

export function serializePermissionProfile(profile: BrowserChatPermissionProfile): string {
  return JSON.stringify(deserializePermissionProfile(JSON.stringify(profile)));
}

export function deserializePermissionProfile(serialized: string): BrowserChatPermissionProfile {
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch {
    return invalidProfile();
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalidProfile();
  const record = value as Record<string, unknown>;
  if (
    record.version !== 1 ||
    !validScope(record.accountId) ||
    !validScope(record.workspaceId) ||
    !isPermissionPlan(record.plan) ||
    typeof record.updatedAt !== 'number' ||
    !Number.isSafeInteger(record.updatedAt) ||
    record.updatedAt < 0 ||
    !record.overrides ||
    typeof record.overrides !== 'object' ||
    Array.isArray(record.overrides)
  ) {
    return invalidProfile();
  }
  const overrides: Partial<Record<BrowserChatCapabilityId, BrowserChatApprovalMode>> = {};
  for (const [id, mode] of Object.entries(record.overrides as Record<string, unknown>)) {
    if (record.plan !== 'custom') return invalidProfile();
    if (!isCapabilityId(id) || !isApprovalMode(mode)) return invalidProfile();
    const capability = CAPABILITY_BY_ID.get(id)!;
    if (capability.criticalApproval && (mode === 'auto' || mode === 'ask')) {
      throw new Error('browser_chat_permission_profile_critical_override_invalid');
    }
    overrides[id] = mode;
  }
  return {
    version: 1,
    accountId: record.accountId,
    workspaceId: record.workspaceId,
    plan: record.plan,
    overrides,
    updatedAt: record.updatedAt,
  };
}

export function calculateCapabilityCatalog(input: {
  readonly profile: BrowserChatPermissionProfile;
  readonly grantedCapabilities: ReadonlySet<BrowserChatCapabilityId>;
  readonly availableCapabilities: ReadonlySet<BrowserChatCapabilityId>;
  readonly providerCapabilities?: ReadonlySet<BrowserChatCapabilityId>;
  readonly providerBridgeAvailable: boolean;
}): BrowserChatCapabilityCatalogEntry[] {
  return BROWSER_CHAT_CAPABILITIES.map((capability) => {
    const approvalMode = permissionModeFor(input.profile, capability.id);
    let denial: BrowserChatCapabilityDenial | undefined;
    if (approvalMode === 'deny') {
      denial = { source: 'permission_plan', code: 'capability_disabled' };
    } else if (!input.grantedCapabilities.has(capability.id)) {
      denial = { source: 'workspace_grant', code: 'workspace_grant_missing' };
    } else if (!input.providerBridgeAvailable) {
      denial = { source: 'provider', code: 'provider_bridge_unavailable' };
    } else if (input.providerCapabilities && !input.providerCapabilities.has(capability.id)) {
      denial = { source: 'provider', code: 'provider_capability_unsupported' };
    } else if (!input.availableCapabilities.has(capability.id)) {
      denial = { source: 'runtime', code: 'capability_unavailable' };
    }
    return {
      ...capability,
      approvalMode,
      approvalRequired: approvalMode === 'ask' || approvalMode === 'always_ask',
      available: denial === undefined,
      ...(denial ? { denial } : {}),
    };
  });
}

export function diffCapabilityCatalog(
  before: readonly BrowserChatCapabilityCatalogEntry[],
  after: readonly BrowserChatCapabilityCatalogEntry[],
): { added: string[]; removed: string[]; changed: string[] } {
  const beforeMap = new Map(before.map((entry) => [entry.id, entry] as const));
  const afterMap = new Map(after.map((entry) => [entry.id, entry] as const));
  const added = [...afterMap.keys()].filter((id) => !beforeMap.has(id)).sort();
  const removed = [...beforeMap.keys()].filter((id) => !afterMap.has(id)).sort();
  const changed = [...afterMap.keys()]
    .filter((id) => {
      const prior = beforeMap.get(id);
      const next = afterMap.get(id)!;
      return prior !== undefined && JSON.stringify(prior) !== JSON.stringify(next);
    })
    .sort();
  return { added, removed, changed };
}

export type BrowserChatCapabilityLease = Readonly<{
  id: string;
  capabilityId: BrowserChatCapabilityId;
  accountId: string;
  workspaceId: string;
  generation: number;
  issuedAt: number;
  expiresAt: number;
}>;

export type BrowserChatOperation = {
  readonly signal: AbortSignal;
  finish(): void;
};

export type PermissionRuntimeErrorCode =
  | 'runtime_signed_out'
  | 'lease_invalid'
  | 'lease_revoked'
  | 'lease_expired'
  | 'lease_replayed'
  | 'wrong_account'
  | 'wrong_workspace'
  | 'capability_unavailable';

export class PermissionRuntimeError extends Error {
  constructor(readonly code: PermissionRuntimeErrorCode) {
    super(`Browser Chat permission runtime rejected: ${code}.`);
    this.name = 'PermissionRuntimeError';
  }
}

export class BrowserChatPermissionRuntime {
  readonly #availableCapabilities: ReadonlySet<BrowserChatCapabilityId>;
  readonly #tokenFactory: () => string;
  readonly #issuedIds = new Set<string>();
  readonly #usedIds = new Set<string>();
  readonly #active = new Map<
    string,
    { controller: AbortController; timer: ReturnType<typeof setTimeout> }
  >();
  #accountId: string;
  #workspaceId: string;
  #generation = 1;
  #signedOut = false;

  constructor(input: {
    readonly accountId: string;
    readonly workspaceId: string;
    readonly availableCapabilities: ReadonlySet<BrowserChatCapabilityId>;
    readonly tokenFactory?: () => string;
  }) {
    if (!validScope(input.accountId) || !validScope(input.workspaceId)) {
      throw new PermissionRuntimeError('lease_invalid');
    }
    this.#accountId = input.accountId;
    this.#workspaceId = input.workspaceId;
    this.#availableCapabilities = new Set(input.availableCapabilities);
    this.#tokenFactory = input.tokenFactory ?? (() => crypto.randomUUID());
  }

  issueLease(
    capabilityId: BrowserChatCapabilityId,
    ttlMs: number,
    now = Date.now(),
  ): BrowserChatCapabilityLease {
    if (this.#signedOut) throw new PermissionRuntimeError('runtime_signed_out');
    if (
      !isCapabilityId(capabilityId) ||
      !Number.isSafeInteger(ttlMs) ||
      ttlMs < 100 ||
      ttlMs > 30_000 ||
      !Number.isSafeInteger(now) ||
      now < 0
    ) {
      throw new PermissionRuntimeError('lease_invalid');
    }
    const id = this.#tokenFactory();
    if (!validScope(id) || id.length < 12 || this.#issuedIds.has(id)) {
      throw new PermissionRuntimeError('lease_invalid');
    }
    this.#issuedIds.add(id);
    return Object.freeze({
      id,
      capabilityId,
      accountId: this.#accountId,
      workspaceId: this.#workspaceId,
      generation: this.#generation,
      issuedAt: now,
      expiresAt: now + ttlMs,
    });
  }

  begin(
    lease: BrowserChatCapabilityLease,
    context: { readonly accountId: string; readonly workspaceId: string; readonly now?: number },
  ): BrowserChatOperation {
    if (this.#signedOut) throw new PermissionRuntimeError('runtime_signed_out');
    const now = context.now ?? Date.now();
    if (lease.accountId !== context.accountId || context.accountId !== this.#accountId) {
      throw new PermissionRuntimeError('wrong_account');
    }
    if (lease.workspaceId !== context.workspaceId || context.workspaceId !== this.#workspaceId) {
      throw new PermissionRuntimeError('wrong_workspace');
    }
    if (lease.generation !== this.#generation) throw new PermissionRuntimeError('lease_revoked');
    if (lease.expiresAt <= now) throw new PermissionRuntimeError('lease_expired');
    if (!this.#issuedIds.has(lease.id) || !isCapabilityId(lease.capabilityId)) {
      throw new PermissionRuntimeError('lease_invalid');
    }
    if (this.#usedIds.has(lease.id)) throw new PermissionRuntimeError('lease_replayed');
    if (!this.#availableCapabilities.has(lease.capabilityId)) {
      throw new PermissionRuntimeError('capability_unavailable');
    }
    this.#usedIds.add(lease.id);
    const controller = new AbortController();
    const timer = setTimeout(
      () => {
        controller.abort('permission_timeout');
        this.#active.delete(lease.id);
      },
      Math.max(0, lease.expiresAt - now),
    );
    this.#active.set(lease.id, { controller, timer });
    return {
      signal: controller.signal,
      finish: () => {
        const active = this.#active.get(lease.id);
        if (!active) return;
        clearTimeout(active.timer);
        this.#active.delete(lease.id);
      },
    };
  }

  revoke(reason = 'permission_revoked') {
    this.#generation += 1;
    for (const { controller, timer } of this.#active.values()) {
      clearTimeout(timer);
      controller.abort(reason);
    }
    this.#active.clear();
  }

  signOut() {
    this.revoke('account_signed_out');
    this.#signedOut = true;
    this.#accountId = '';
    this.#workspaceId = '';
  }
}
