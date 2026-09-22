import { resolveAccountIdentity } from '@/lib/accountIdentity';
import { useAuthStore } from '@/stores/auth';
import type { PerformanceProfile } from '@/features/chat/runtime/performanceProfile';
import type { ExecutionIdentity } from '@/features/context/gateway/contextGatewayContracts';
import {
  MUTATING_TOOL_GATEWAY_TOOLS,
  type ToolGatewayRequest,
} from './toolGatewayProtocol';

type AuthorityScope = Readonly<{
  accountId: string;
  accountSource: 'supabase' | 'local';
  workspaceId: string;
  projectId: string | null;
}>;

export type ToolGatewayAuthorityClaim = Readonly<{
  scope: AuthorityScope;
  generation: number;
}>;

const sessionAuthorities = new Map<string, ToolGatewayAuthorityClaim>();
const sessionSignals = new Map<string, AbortSignal>();
const capturedAuthorityClaims = new WeakSet<object>();
export type ToolGatewayObservedExecutionAuthority = Readonly<{
  executionIdentity: Readonly<ExecutionIdentity>;
  performance: PerformanceProfile;
  scopeRevision: string;
}>;
const observedExecutionAuthorities = new Map<
  string,
  Readonly<{
    authority: ToolGatewayAuthorityClaim;
    value: ToolGatewayObservedExecutionAuthority;
  }>
>();
type MutationGrant = {
  mode: 'once' | 'always';
  expiresAt: number;
  authority: ToolGatewayAuthorityClaim;
  binding?: Readonly<{
    requestId: string;
    messageId: string;
    fingerprint: string;
  }>;
};
const grants = new Map<string, Map<string, MutationGrant>>();
const ONCE_GRANT_TTL_MS = 2 * 60_000;
const ALWAYS_GRANT_TTL_MS = 30 * 60_000;
const MAX_GRANT_SESSIONS = 128;
const MAX_GRANTS_PER_SESSION = 32;
let generation = 0;

function canonicalMutationValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalMutationValue);
  if (!value || typeof value !== 'object') return value;
  const record = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(record)
      .sort()
      .map((key) => [key, canonicalMutationValue(record[key])]),
  );
}

function mutationRequestFingerprint(request: ToolGatewayRequest): string | null {
  try {
    const serialized = JSON.stringify([
      request.tool,
      request.requestId,
      request.messageId,
      request.directory ?? null,
      request.worktree ?? null,
      canonicalMutationValue(request.args),
    ]);
    return typeof serialized === 'string' ? serialized : null;
  } catch {
    return null;
  }
}

function requestGrantKey(request: Pick<ToolGatewayRequest, 'tool' | 'requestId'>): string {
  return `request:${request.tool}:${request.requestId}`;
}

function activeScope(): AuthorityScope | null {
  const auth = useAuthStore.getState();
  const identity = resolveAccountIdentity(auth);
  if (!identity || !auth.workspaceId) return null;
  return {
    accountId: identity.accountId,
    accountSource: identity.source,
    workspaceId: String(auth.workspaceId),
    projectId: auth.projectId ? String(auth.projectId) : null,
  };
}

function sameScope(
  left: AuthorityScope,
  right: AuthorityScope,
): boolean {
  return (
    left.accountId === right.accountId &&
    left.accountSource === right.accountSource &&
    left.workspaceId === right.workspaceId &&
    left.projectId === right.projectId
  );
}

let observerInstalled = false;
let observedScope: AuthorityScope | null = null;

function ensureScopeObserver(): void {
  if (observerInstalled) return;
  observerInstalled = true;
  observedScope = activeScope();
  useAuthStore.subscribe(() => {
    const next = activeScope();
    if (
      (observedScope === null) !== (next === null) ||
      (observedScope !== null &&
        next !== null &&
        (observedScope.accountId !== next.accountId ||
          observedScope.accountSource !== next.accountSource ||
          observedScope.workspaceId !== next.workspaceId))
    ) {
      generation += 1;
    }
    observedScope = next;
  });
}

function currentAuthority(): ToolGatewayAuthorityClaim | null {
  ensureScopeObserver();
  const scope = activeScope();
  return scope ? { scope, generation } : null;
}

function sameAuthority(left: ToolGatewayAuthorityClaim, right: ToolGatewayAuthorityClaim): boolean {
  return left.generation === right.generation && sameScope(left.scope, right.scope);
}

function sameStableAuthority(
  left: ToolGatewayAuthorityClaim,
  right: ToolGatewayAuthorityClaim,
): boolean {
  return (
    left.generation === right.generation &&
    left.scope.accountId === right.scope.accountId &&
    left.scope.accountSource === right.scope.accountSource &&
    left.scope.workspaceId === right.scope.workspaceId
  );
}

const EXECUTION_IDENTITY_REQUIRED_FIELDS = Object.freeze([
  'transportConnectionId',
  'transportAdapterId',
  'upstreamProviderId',
  'upstreamModelId',
  'providerQualifiedModelId',
  'authBillingRoute',
  'effort',
  'fastVariant',
  'catalogRevision',
] as const);
const EXECUTION_IDENTITY_ALLOWED_FIELDS = new Set<string>([
  ...EXECUTION_IDENTITY_REQUIRED_FIELDS,
  'observedProviderIdentity',
]);
const SAFE_EXECUTION_IDENTITY_VALUE = /^[^\u0000-\u001f\u007f]{1,512}$/u;

function immutableExecutionIdentity(value: unknown): Readonly<ExecutionIdentity> | null {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).some((key) => !EXECUTION_IDENTITY_ALLOWED_FIELDS.has(key)) ||
    EXECUTION_IDENTITY_REQUIRED_FIELDS.some((key) => {
      const candidate = record[key];
      return (
        typeof candidate !== 'string' ||
        candidate.trim() !== candidate ||
        !SAFE_EXECUTION_IDENTITY_VALUE.test(candidate)
      );
    }) ||
    (record.observedProviderIdentity !== undefined &&
      (typeof record.observedProviderIdentity !== 'string' ||
        record.observedProviderIdentity.trim() !== record.observedProviderIdentity ||
        !SAFE_EXECUTION_IDENTITY_VALUE.test(record.observedProviderIdentity)))
  ) {
    return null;
  }
  return Object.freeze({ ...(record as unknown as ExecutionIdentity) });
}

function sameExecutionIdentity(
  left: Readonly<ExecutionIdentity>,
  right: Readonly<ExecutionIdentity>,
): boolean {
  return [...EXECUTION_IDENTITY_REQUIRED_FIELDS, 'observedProviderIdentity' as const].every(
    (field) => left[field] === right[field],
  );
}

export function captureToolGatewayAuthorityClaim(): ToolGatewayAuthorityClaim | null {
  const current = currentAuthority();
  if (!current) return null;
  const claim = Object.freeze({
    scope: Object.freeze({ ...current.scope }),
    generation: current.generation,
  });
  capturedAuthorityClaims.add(claim);
  return claim;
}

export function bindToolGatewaySessionAuthority(
  sessionId: string,
  expected: ToolGatewayAuthorityClaim,
  signal?: AbortSignal,
): boolean {
  const current = currentAuthority();
  if (
    !current ||
    !capturedAuthorityClaims.has(expected) ||
    !sameStableAuthority(expected, current) ||
    signal?.aborted
  ) {
    return false;
  }
  const existing = sessionAuthorities.get(sessionId);
  if (existing) {
    return sameAuthority(existing, expected) && sessionSignals.get(sessionId) === signal;
  }
  sessionAuthorities.set(sessionId, expected);
  if (signal) sessionSignals.set(sessionId, signal);
  return true;
}

export function readToolGatewayRequestSignal(request: ToolGatewayRequest): AbortSignal | undefined {
  return authorizeToolGatewayRequest(request) ? sessionSignals.get(request.sessionId) : undefined;
}

export function bindToolGatewayObservedExecutionAuthority(
  sessionId: string,
  expected: ToolGatewayAuthorityClaim,
  input: Readonly<{
    executionIdentity: Readonly<ExecutionIdentity>;
    performance: PerformanceProfile;
  }>,
): boolean {
  const current = currentAuthority();
  const bound = sessionAuthorities.get(sessionId);
  const identity = immutableExecutionIdentity(input.executionIdentity);
  if (
    !current ||
    !bound ||
    !sameAuthority(bound, expected) ||
    !sameStableAuthority(current, bound) ||
    !identity ||
    !['responsive', 'balanced', 'quality'].includes(input.performance)
  ) {
    return false;
  }
  const value = Object.freeze({
    executionIdentity: identity,
    performance: input.performance,
    scopeRevision: `${sessionId}:${expected.generation}`,
  });
  const existing = observedExecutionAuthorities.get(sessionId);
  if (existing) {
    return (
      sameAuthority(existing.authority, expected) &&
      existing.value.performance === value.performance &&
      sameExecutionIdentity(existing.value.executionIdentity, value.executionIdentity)
    );
  }
  observedExecutionAuthorities.set(
    sessionId,
    Object.freeze({ authority: expected, value }),
  );
  return true;
}

export function readToolGatewayObservedExecutionAuthority(
  sessionId: string,
): ToolGatewayObservedExecutionAuthority | null {
  const current = currentAuthority();
  const bound = sessionAuthorities.get(sessionId);
  const observed = observedExecutionAuthorities.get(sessionId);
  return current &&
    bound &&
    observed &&
    sameStableAuthority(current, bound) &&
    sameAuthority(bound, observed.authority)
    ? observed.value
    : null;
}

export function readToolGatewaySessionAuthority(
  sessionId: string,
): ToolGatewayAuthorityClaim | null {
  const current = currentAuthority();
  const bound = sessionAuthorities.get(sessionId);
  return current && bound && sameStableAuthority(current, bound) ? bound : null;
}

export function releaseToolGatewaySessionAuthority(sessionId: string): void {
  sessionAuthorities.delete(sessionId);
  sessionSignals.delete(sessionId);
  observedExecutionAuthorities.delete(sessionId);
  grants.delete(sessionId);
}

export function authorizeToolGatewayRequest(request: ToolGatewayRequest): boolean {
  const current = currentAuthority();
  const bound = sessionAuthorities.get(request.sessionId);
  return Boolean(current && bound && sameStableAuthority(current, bound));
}

export function grantToolGatewayMutation(
  sessionId: string,
  capability: string,
  mode: 'once' | 'always',
): () => void {
  const current = currentAuthority();
  const bound = sessionAuthorities.get(sessionId);
  if (!current || !bound || !sameStableAuthority(bound, current)) {
    throw new Error('tool_gateway_authority_unavailable');
  }
  let session = grants.get(sessionId);
  if (!session) {
    session = new Map();
    grants.set(sessionId, session);
  }
  session.set(capability, {
    mode,
    expiresAt: Date.now() + (mode === 'always' ? ALWAYS_GRANT_TTL_MS : ONCE_GRANT_TTL_MS),
    authority: bound,
  });
  while (session.size > MAX_GRANTS_PER_SESSION) {
    const oldest = session.keys().next().value as string | undefined;
    if (!oldest) break;
    session.delete(oldest);
  }
  while (grants.size > MAX_GRANT_SESSIONS) {
    const oldest = grants.keys().next().value as string | undefined;
    if (!oldest || oldest === sessionId) break;
    grants.delete(oldest);
  }
  return () => {
    const currentSession = grants.get(sessionId);
    currentSession?.delete(capability);
    if (currentSession?.size === 0) grants.delete(sessionId);
  };
}

/**
 * Create a one-shot mutation grant bound to one already-parsed gateway call.
 * The session authority supplies account/workspace/project binding; the request
 * binding additionally prevents replay against another action or terminal.
 */
export function grantToolGatewayMutationForRequest(
  request: ToolGatewayRequest,
  mode: 'once' | 'always' = 'once',
): () => void {
  if (!MUTATING_TOOL_GATEWAY_TOOLS.has(request.tool)) {
    throw new Error('tool_gateway_mutation_not_required');
  }
  const current = currentAuthority();
  const bound = sessionAuthorities.get(request.sessionId);
  const fingerprint = mutationRequestFingerprint(request);
  if (
    !fingerprint ||
    !current ||
    !bound ||
    !authorizeToolGatewayRequest(request) ||
    !sameStableAuthority(bound, current)
  ) {
    throw new Error('tool_gateway_authority_unavailable');
  }
  const key = requestGrantKey(request);
  let session = grants.get(request.sessionId);
  if (!session) {
    session = new Map();
    grants.set(request.sessionId, session);
  }
  session.set(key, {
    mode,
    expiresAt: Date.now() + (mode === 'always' ? ALWAYS_GRANT_TTL_MS : ONCE_GRANT_TTL_MS),
    authority: bound,
    binding: Object.freeze({
      requestId: request.requestId,
      messageId: request.messageId,
      fingerprint,
    }),
  });
  while (session.size > MAX_GRANTS_PER_SESSION) {
    const oldest = session.keys().next().value as string | undefined;
    if (!oldest) break;
    session.delete(oldest);
  }
  while (grants.size > MAX_GRANT_SESSIONS) {
    const oldest = grants.keys().next().value as string | undefined;
    if (!oldest || oldest === request.sessionId) break;
    grants.delete(oldest);
  }
  return () => {
    const currentSession = grants.get(request.sessionId);
    currentSession?.delete(key);
    if (currentSession?.size === 0) grants.delete(request.sessionId);
  };
}

export function authorizeToolGatewayMutation(request: ToolGatewayRequest): boolean {
  if (!authorizeToolGatewayRequest(request)) return false;
  const session = grants.get(request.sessionId);
  const exactKey = requestGrantKey(request);
  const exactGrant = session?.get(exactKey);
  const capability = session?.has(request.tool) ? request.tool : '*';
  const grantKey = exactGrant ? exactKey : capability;
  const grant = exactGrant ?? session?.get(capability);
  const current = currentAuthority();
  const bound = sessionAuthorities.get(request.sessionId);
  const fingerprint = grant?.binding ? mutationRequestFingerprint(request) : null;
  const grantAuthorityMatchesCurrent = Boolean(
    current &&
      grant &&
      (grant.binding
        ? sameAuthority(grant.authority, current)
        : sameStableAuthority(grant.authority, current)),
  );
  const bindingMatches =
    !grant?.binding ||
    (grant.binding.requestId === request.requestId &&
      grant.binding.messageId === request.messageId &&
      fingerprint !== null &&
      grant.binding.fingerprint === fingerprint);
  if (
    !session ||
    !grant ||
    !current ||
    !bound ||
    !grantAuthorityMatchesCurrent ||
    !sameAuthority(grant.authority, bound) ||
    !bindingMatches ||
    grant.expiresAt < Date.now()
  ) {
    session?.delete(grantKey);
    if (session?.size === 0) grants.delete(request.sessionId);
    return false;
  }
  if (grant.mode === 'once') {
    session.delete(grantKey);
    if (session.size === 0) grants.delete(request.sessionId);
  } else {
    grant.expiresAt = Date.now() + ALWAYS_GRANT_TTL_MS;
  }
  return true;
}

export function clearToolGatewayAuthorityForTests(): void {
  ensureScopeObserver();
  sessionAuthorities.clear();
  sessionSignals.clear();
  observedExecutionAuthorities.clear();
  grants.clear();
  generation = 0;
  observedScope = activeScope();
}
