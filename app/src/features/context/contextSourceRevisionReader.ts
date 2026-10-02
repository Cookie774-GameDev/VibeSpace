import type { ContextScope } from '@/features/context/contextQueryService';

type Authority = Readonly<Required<Pick<ContextScope, 'accountId' | 'workspaceId' | 'projectId' | 'worktreeId'>> & { epoch: number }>;
type RunIdentity = Readonly<{ accountId: string; chatId: string; runId: string; requestId: string; attemptNumber: number }>;
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
  authorizeChat(authority: Authority, chatId: string): Promise<boolean>;
  currentMapRevision(authority: Authority, mapId: string, signal?: AbortSignal): Promise<string | undefined>;
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
    const hasRun = input.runId !== undefined || input.requestId !== undefined || input.attemptNumber !== undefined;
    if (hasRun && (!input.runId || !input.requestId || !ID.test(input.runId) || !ID.test(input.requestId) || !Number.isSafeInteger(input.attemptNumber) || input.attemptNumber! < 1)) return undefined;
    try {
      signal?.throwIfAborted();
      if (!await deps.authorizeChat(authority, input.chatId)) return undefined;
      if (hasRun) {
        const run = await deps.readRunIdentity?.(authority, input.runId!);
        if (!run || run.accountId !== authority.accountId || run.chatId !== input.chatId || run.runId !== input.runId || run.requestId !== input.requestId || run.attemptNumber !== input.attemptNumber) return undefined;
      }
      const revision = await deps.currentMapRevision(authority, input.mapId, signal);
      signal?.throwIfAborted();
      if (!revision || !HASH.test(revision) || !sameAuthority(authority, deps.currentAuthority())) return undefined;
      if (!await deps.authorizeChat(authority, input.chatId) || !sameAuthority(authority, deps.currentAuthority())) return undefined;
      if (hasRun) {
        const run = await deps.readRunIdentity?.(authority, input.runId!);
        if (!run || run.accountId !== authority.accountId || run.chatId !== input.chatId || run.runId !== input.runId || run.requestId !== input.requestId || run.attemptNumber !== input.attemptNumber || !sameAuthority(authority, deps.currentAuthority())) return undefined;
      }
      const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(authority.worktreeId));
      if (!sameAuthority(authority, deps.currentAuthority())) return undefined;
      const worktreeHash = 'sha256:' + [...new Uint8Array(bytes)].map(b => b.toString(16).padStart(2, '0')).join('');
      return Object.freeze({ accountId: authority.accountId, workspaceId: authority.workspaceId, projectId: authority.projectId, worktreeHash, chatId: input.chatId, mapId: input.mapId,
        authorityEpoch: authority.epoch, sourceRevision: revision,
        ...(hasRun ? { runId: input.runId, requestId: input.requestId, attemptNumber: input.attemptNumber } : {}) });
    } catch {
      signal?.throwIfAborted();
      return undefined; // Unsupported kind/read-denied/hash race is the same unavailable outcome.
    }
  };
}
