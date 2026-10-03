import type { ContextScope } from '@/features/context/contextQueryService';

type Authority = Readonly<Required<Pick<ContextScope, 'accountId' | 'workspaceId' | 'projectId' | 'worktreeId'>> & { epoch: number }>;
type RunIdentity = Readonly<{ accountId: string; chatId: string; runId: string; requestId: string; attemptNumber: number }>;
export type ContextRevisionObservation = Readonly<{
  sourceRevision: string;
  membershipRevision: string;
  revisionKind: 'map-membership' | 'issued-evidence';
  wholeMapDiskFreshness: false;
  sourceCount: number;
  verifiedBytes: number;
}>;
export type SourceRevisionRead = Readonly<{ accountId: string; chatId: string; mapId: string }> &
  (Readonly<{ runId?: undefined; requestId?: undefined; attemptNumber?: undefined }> | Readonly<{ runId: string; requestId: string; attemptNumber: number }>);
const ID = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,199}$/u;
const HASH = /^sha256:[a-f0-9]{64}$/u;
const sameAuthority = (a: Authority, b: Authority | undefined) =>
  ['accountId', 'workspaceId', 'projectId', 'worktreeId', 'epoch'].every(key => a[key as keyof Authority] === b?.[key as keyof Authority]);

/** A durable journal proof cannot authorize a superseded transport attempt. */
export function sourceProofMatchesCurrentTransport(
  proof: Readonly<{ requestId: string; attemptNumber: number }> | undefined,
  current: Readonly<{ requestId: string; attemptNumber: number }> | undefined,
): boolean {
  if (!proof || !ID.test(proof.requestId) || !Number.isSafeInteger(proof.attemptNumber) || proof.attemptNumber < 1) return false;
  return current === undefined || (current.requestId === proof.requestId && current.attemptNumber === proof.attemptNumber);
}
/** Installed only in the already-attested kernel host. No caller paths/scope overrides/model tools. */
export function createContextSourceRevisionReader(deps: {
  currentAuthority(): Authority | undefined;
  /** ROOT supplies the same protected scope token captured by the gateway. */
  currentScopeRevision?(authority: Authority, input: SourceRevisionRead): string | undefined;
  /** Host-only lazy preparation. It never accepts a caller-selected authority. */
  prepareScope?(authority: Authority, input: SourceRevisionRead, signal?: AbortSignal): Promise<boolean>;
  authorizeChat(authority: Authority, chatId: string): Promise<boolean>;
  currentMapRevision(authority: Authority, mapId: string, signal?: AbortSignal,
    run?: RunIdentity, scopeRevision?: string,
    currentScopeRevision?: () => string | undefined): Promise<ContextRevisionObservation | undefined>;
  // Host derives identity from existing durable protected run/request/attempt evidence; caller cannot supply authority.
  readRunIdentity?(authority: Authority, runId: string): Promise<RunIdentity | undefined>;
}) {
  return async (input: SourceRevisionRead, signal?: AbortSignal) => {
    const before = deps.currentAuthority();
    if (!before || !Number.isSafeInteger(before.epoch) || before.epoch <= 0 ||
      Object.keys(input).some(k => !['accountId', 'chatId', 'mapId', 'runId', 'requestId', 'attemptNumber'].includes(k)) ||
      ![before.accountId, before.workspaceId, before.projectId, input.accountId, input.chatId, input.mapId].every(v => typeof v === 'string' && ID.test(v)) ||
      typeof before.worktreeId !== 'string' || !/^[^\u0000-\u001f\u007f]{1,4096}$/u.test(before.worktreeId) ||
      input.accountId !== before.accountId) return undefined;
    const authority = Object.freeze({ ...before });
    let protectedScopeRevision = deps.currentScopeRevision?.(authority, input);
    const currentScopeRevision = () => sameAuthority(authority, deps.currentAuthority())
      ? deps.currentScopeRevision?.(authority, input) : undefined;
    const hasRun = input.runId !== undefined || input.requestId !== undefined || input.attemptNumber !== undefined;
    if (hasRun && (!input.runId || !input.requestId || !ID.test(input.runId) || !ID.test(input.requestId) || !Number.isSafeInteger(input.attemptNumber) || input.attemptNumber! < 1 || input.attemptNumber! > 0xffffffff)) return undefined;
    try {
      signal?.throwIfAborted();
      if (!await deps.authorizeChat(authority, input.chatId)) return undefined;
      if (!sameAuthority(authority, deps.currentAuthority())) return undefined;
      if (deps.prepareScope) {
        if (!await deps.prepareScope(authority, input, signal)) return undefined;
        signal?.throwIfAborted();
        if (!sameAuthority(authority, deps.currentAuthority()) || !await deps.authorizeChat(authority, input.chatId)) return undefined;
      }
      signal?.throwIfAborted();
      if (!sameAuthority(authority, deps.currentAuthority())) return undefined;
      // Warm reads retain the pre-await token. Cold reads bind the first loaded
      // authenticated selection only after preparation/authority rechecks.
      protectedScopeRevision ??= currentScopeRevision();
      if (!protectedScopeRevision) return undefined;
      if (currentScopeRevision() !== protectedScopeRevision) return undefined;
      let boundRun: RunIdentity | undefined;
      if (hasRun) {
        const run = await deps.readRunIdentity?.(authority, input.runId!);
        if (currentScopeRevision() !== protectedScopeRevision) return undefined;
        if (!run || run.accountId !== authority.accountId || run.chatId !== input.chatId || run.runId !== input.runId || run.requestId !== input.requestId || run.attemptNumber !== input.attemptNumber) return undefined;
        boundRun = Object.freeze({ ...run });
      }
      if (currentScopeRevision() !== protectedScopeRevision) return undefined;
      const observation = await deps.currentMapRevision(authority, input.mapId, signal, boundRun,
        protectedScopeRevision, currentScopeRevision);
      if (!observation) return undefined;
      const revision = observation.sourceRevision;
      {
        if (Object.keys(observation).some(key => !['sourceRevision', 'membershipRevision', 'revisionKind', 'wholeMapDiskFreshness', 'sourceCount', 'verifiedBytes'].includes(key))
          || !HASH.test(observation.membershipRevision) || observation.wholeMapDiskFreshness !== false
          || observation.revisionKind !== (hasRun ? 'issued-evidence' : 'map-membership')
          || !Number.isSafeInteger(observation.sourceCount) || observation.sourceCount < 0 || observation.sourceCount > 128
          || !Number.isSafeInteger(observation.verifiedBytes) || observation.verifiedBytes < 0 || observation.verifiedBytes > 8 * 1024 * 1024
          || (!hasRun && (observation.sourceRevision !== observation.membershipRevision || observation.sourceCount !== 0 || observation.verifiedBytes !== 0))) return undefined;
      }
      signal?.throwIfAborted();
      if (!revision || !HASH.test(revision) || !sameAuthority(authority, deps.currentAuthority())
        || currentScopeRevision() !== protectedScopeRevision) return undefined;
      if (!await deps.authorizeChat(authority, input.chatId) || !sameAuthority(authority, deps.currentAuthority())) return undefined;
      if (hasRun) {
        const run = await deps.readRunIdentity?.(authority, input.runId!);
        if (!run || run.accountId !== authority.accountId || run.chatId !== input.chatId || run.runId !== input.runId || run.requestId !== input.requestId || run.attemptNumber !== input.attemptNumber || !sameAuthority(authority, deps.currentAuthority())) return undefined;
      }
      const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(authority.worktreeId));
      if (!sameAuthority(authority, deps.currentAuthority()) || currentScopeRevision() !== protectedScopeRevision) return undefined;
      const worktreeHash = 'sha256:' + [...new Uint8Array(bytes)].map(b => b.toString(16).padStart(2, '0')).join('');
      return Object.freeze({ accountId: authority.accountId, workspaceId: authority.workspaceId, projectId: authority.projectId, worktreeHash, chatId: input.chatId, mapId: input.mapId,
        authorityEpoch: authority.epoch, sourceRevision: revision,
        membershipRevision: observation.membershipRevision, revisionKind: observation.revisionKind,
        wholeMapDiskFreshness: false as const, sourceCount: observation.sourceCount, verifiedBytes: observation.verifiedBytes,
        ...(hasRun ? { runId: input.runId, requestId: input.requestId, attemptNumber: input.attemptNumber } : {}) });
    } catch {
      signal?.throwIfAborted();
      return undefined; // Unsupported kind/read-denied/hash race is the same unavailable outcome.
    }
  };
}
