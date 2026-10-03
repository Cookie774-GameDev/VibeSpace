import type { ContextScope } from './contextQueryService';
import type { RlmContextLease } from './rlmOpenCodeTool';

export type CanonicalEvidenceBinding = Readonly<{ runId: string; requestId: string; attemptNumber: number }>;
export type EvidenceRevision = Readonly<{
  sourceRevision: string; membershipRevision: string;
  revisionKind: 'map-membership' | 'issued-evidence'; wholeMapDiskFreshness: false;
  sourceCount: number; verifiedBytes: number;
}>;
export interface IssuedEvidencePort {
  currentMapMembershipRevision(scope: ContextScope, mapId: string, signal?: AbortSignal): Promise<string | undefined>;
  currentIssuedEvidenceRevision(scope: ContextScope, mapId: string, captures: readonly object[], signal?: AbortSignal, assertCurrent?: () => boolean): Promise<EvidenceRevision | undefined>;
}
const ID = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,199}$/u;
const SHA = /^sha256:[a-f0-9]{64}$/u;
const validProof = (proof: EvidenceRevision | undefined): proof is EvidenceRevision => !!proof
  && SHA.test(proof.sourceRevision) && SHA.test(proof.membershipRevision)
  && proof.revisionKind === 'issued-evidence' && proof.wholeMapDiskFreshness === false
  && Number.isSafeInteger(proof.sourceCount) && proof.sourceCount >= 0 && proof.sourceCount <= 128
  && Number.isSafeInteger(proof.verifiedBytes) && proof.verifiedBytes >= 0 && proof.verifiedBytes <= 8 * 1024 * 1024;
const key = (scope: ContextScope, chatId: string, mapId: string, binding: CanonicalEvidenceBinding) => {
  if (![scope.accountId, chatId, mapId, binding.runId, binding.requestId].every(value => typeof value === 'string' && ID.test(value))
    || !Number.isSafeInteger(binding.attemptNumber) || binding.attemptNumber < 1 || binding.attemptNumber > 0xffffffff) return undefined;
  return JSON.stringify([scope.accountId, scope.workspaceId ?? null, scope.projectId ?? null,
    scope.worktreeId ?? null, chatId, mapId, binding.runId, binding.requestId, binding.attemptNumber]);
};
const scopeFromLease = (lease: RlmContextLease): ContextScope => ({accountId: lease.accountId,
  workspaceId: lease.workspaceId, projectId: lease.projectId, worktreeId: lease.worktreeId});

/** Private ROOT-only registry. Captures are opaque repository-minted handles,
 * never provider pointers or public DTOs. Expiry/eviction is unavailable. */
export function createIssuedEvidenceRegistry(options: { now?: () => number } = {}) {
  const now = options.now ?? Date.now;
  const entries = new Map<string, { accountId: string; expiresAt: number; scopeRevision: string;
    membershipRevision: string; captures: readonly object[]; port: IssuedEvidencePort }>();
  const writers = new Map<string, {tail: Promise<void>; waiting: number}>();
  const invalidRuns = new Map<string, number>();
  let unavailableUntil = 0;
  const invalid = (id: string) => unavailableUntil > now() || (invalidRuns.get(id) ?? 0) > now();
  const invalidate = (id: string) => {
    entries.delete(id);
    for (const [key, expiry] of invalidRuns) if (expiry <= now()) invalidRuns.delete(key);
    // Queue overload must not leave a partial capture set readable. Bounded
    // poison metadata, never an unbounded map of attacker-controlled keys.
    if (!invalidRuns.has(id) && invalidRuns.size >= 128) {
      unavailableUntil = now() + 10 * 60_000; invalidRuns.clear(); entries.clear();
    } else invalidRuns.set(id, now() + 10 * 60_000);
  };
  const waitForWriter = <T>(work: Promise<T>, signal?: AbortSignal): Promise<T> => {
    if (!signal) return work;
    return new Promise<T>((resolve, reject) => {
      const abort = () => reject(signal.reason ?? new DOMException('aborted', 'AbortError'));
      signal.addEventListener('abort', abort, {once: true});
      if (signal.aborted) abort();
      work.then(value => {signal.removeEventListener('abort', abort); resolve(value);},
        error => {signal.removeEventListener('abort', abort); reject(error);});
    });
  };
  const expire = () => { for (const [id, entry] of entries) if (entry.expiresAt <= now()) entries.delete(id); };
  return Object.freeze({
    /** ROOT-only: a genuinely used source could not produce an issued capture. */
    markUnavailable(lease: RlmContextLease, currentScopeRevision: () => string | undefined, signal?: AbortSignal): boolean {
      if (signal?.aborted || lease.expiresAt <= now() || !lease.contextRevision) return false;
      const id = lease.chatId && lease.selectedMapId && lease.canonicalBinding
        ? key(scopeFromLease(lease), lease.chatId, lease.selectedMapId, lease.canonicalBinding) : undefined;
      if (!id) return false;
      try {if (currentScopeRevision() !== lease.contextRevision) return false;} catch {return false;}
      invalidate(id); return true;
    },
    async publish(lease: RlmContextLease, captures: readonly object[], port: IssuedEvidencePort,
      currentScopeRevision: () => string | undefined, signal?: AbortSignal): Promise<boolean> {
      signal?.throwIfAborted();
      const scope = scopeFromLease(lease);
      const id = lease.chatId && lease.selectedMapId && lease.canonicalBinding
        ? key(scope, lease.chatId, lease.selectedMapId, lease.canonicalBinding) : undefined;
      const scopeRevision = lease.contextRevision;
      if (!id || !scopeRevision || lease.expiresAt <= now() || currentScopeRevision() !== scopeRevision) return false;
      if (captures.length > 128) {invalidate(id); return false;}
      if (invalid(id)) return false;
      let writer = writers.get(id);
      if ((writer?.waiting ?? 0) >= 32 || (!writer && writers.size >= 128)) { invalidate(id); return false; }
      writer ??= {tail: Promise.resolve(), waiting: 0};
      writers.set(id, writer);
      writer.waiting += 1;
      const capturedHandles = Object.freeze([...captures]);
      const serial = writer;
      const work = serial.tail.then(async () => {
      signal?.throwIfAborted();
      if (invalid(id) || lease.expiresAt <= now() || currentScopeRevision() !== lease.contextRevision) return false;
      let membershipRevision: string | undefined;
      try {
        membershipRevision = await port.currentMapMembershipRevision(scope, lease.selectedMapId!, signal);
      } catch (error) {
        if (!signal?.aborted && currentScopeRevision() === lease.contextRevision && lease.expiresAt > now()) invalidate(id);
        throw error;
      }
      signal?.throwIfAborted();
      if (invalid(id) || lease.expiresAt <= now() || currentScopeRevision() !== lease.contextRevision) return false;
      if (!membershipRevision || !SHA.test(membershipRevision)) {invalidate(id); return false;}
      expire();
      const existing = entries.get(id);
      if (existing && (existing.scopeRevision !== lease.contextRevision || existing.membershipRevision !== membershipRevision || existing.port !== port)) {
        invalidate(id); return false;
      }
      const combined = [...new Set([...(existing?.captures ?? []), ...capturedHandles])];
      if (combined.length > 128) { invalidate(id); return false; }
      // Store only a fully verified capture set; unknown/forged handles never
      // become an entry just because a ROOT callback or Boolean says yes.
      let proof: EvidenceRevision | undefined;
      try {
        proof = await port.currentIssuedEvidenceRevision(scope, lease.selectedMapId!, combined, signal,
          () => !invalid(id) && currentScopeRevision() === lease.contextRevision && lease.expiresAt > now());
      } catch (error) {
        if (!signal?.aborted && currentScopeRevision() === lease.contextRevision && lease.expiresAt > now()) invalidate(id);
        throw error;
      }
      signal?.throwIfAborted();
      if (invalid(id) || !validProof(proof) || lease.expiresAt <= now() || proof.membershipRevision !== membershipRevision || proof.revisionKind !== 'issued-evidence'
        || proof.wholeMapDiskFreshness !== false || currentScopeRevision() !== lease.contextRevision) {
        // A failed union cannot leave an earlier, incomplete source set usable.
        if (!signal?.aborted && currentScopeRevision() === lease.contextRevision && lease.expiresAt > now()) invalidate(id);
        return false;
      }
      const accountKeys = [...entries].filter(([, entry]) => entry.accountId === lease.accountId).map(([entryKey]) => entryKey);
      if (!entries.has(id)) {
        while (accountKeys.length >= 32) entries.delete(accountKeys.shift()!);
        while (entries.size >= 128) entries.delete(entries.keys().next().value!);
      }
      entries.set(id, {accountId: lease.accountId, expiresAt: now() + 10 * 60_000,
        scopeRevision, membershipRevision, captures: Object.freeze(combined), port});
      return true;
      });
      const settle = () => {serial.waiting -= 1; if (serial.waiting === 0 && writers.get(id) === serial) writers.delete(id);};
      serial.tail = work.then(settle, settle);
      return waitForWriter(work, signal);
    },
    async read(scope: ContextScope, chatId: string, mapId: string, binding: CanonicalEvidenceBinding,
      expectedScopeRevision: string, currentScopeRevision: () => string | undefined, signal?: AbortSignal) {
      signal?.throwIfAborted(); expire();
      const id = key(scope, chatId, mapId, binding); const entry = id ? entries.get(id) : undefined;
      if (!entry || invalid(id!) || writers.has(id!) || entry.scopeRevision !== expectedScopeRevision || currentScopeRevision() !== expectedScopeRevision) return undefined;
      const proof = await entry.port.currentIssuedEvidenceRevision(scope, mapId, entry.captures, signal,
        () => !invalid(id!) && !writers.has(id!) && currentScopeRevision() === expectedScopeRevision && entries.get(id!) === entry && entry.expiresAt > now());
      signal?.throwIfAborted();
      if (!validProof(proof) || invalid(id!) || writers.has(id!) || proof.membershipRevision !== entry.membershipRevision || currentScopeRevision() !== expectedScopeRevision
        || !id || entries.get(id) !== entry || entry.expiresAt <= now()) return undefined;
      return proof;
    },
  });
}

export const productionIssuedEvidenceRegistry = createIssuedEvidenceRegistry();

export interface MembershipNode { id: string; kind: string; title: string; summary: string;
  path?: string; modifiedAt?: number; children?: readonly MembershipNode[] }
export interface MembershipMap { id: string; rootDir: string; sourceType?: string; updatedAt: number;
  github?: {resolvedCommitSha: string}; tree: {nodes: readonly MembershipNode[]} }

/** Exact JSON string byte census before allocating serialized strings. */
function jsonStringBytes(value: string, remaining: number, signal?: AbortSignal): number | undefined {
  let bytes = 2; let offset = 0;
  for (const character of value) {
    if ((offset++ & 4095) === 0) signal?.throwIfAborted();
    const point = character.codePointAt(0)!;
    bytes += point === 34 || point === 92 ? 2 : point < 32
      ? [8, 9, 10, 12, 13].includes(point) ? 2 : 6
      : point >= 0xd800 && point <= 0xdfff ? 6 : point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;
    if (bytes > remaining) return undefined;
  }
  return bytes;
}
/** Topology/order preserving complete membership; no physical freshness claim. */
export async function currentMembershipDigest(scope: ContextScope, map: MembershipMap, signal?: AbortSignal): Promise<string | undefined> {
  const maximum = 8 * 1024 * 1024; let budget = maximum; let count = 0;
  const ids = new Set<string>(); const rows: unknown[][] = [];
  const charge = (value: string) => { const size = jsonStringBytes(value, budget, signal);
    if (size === undefined) return false; budget -= size + 32; return budget >= 0; };
  const header = [scope.accountId, scope.workspaceId ?? null, scope.projectId ?? null, scope.worktreeId ?? null,
    map.id, map.rootDir, map.sourceType ?? null, map.updatedAt, map.github?.resolvedCommitSha ?? null];
  for (const field of header) if (typeof field === 'string' && !charge(field)) return undefined;
  if (map.tree.nodes.length > 4096) return undefined;
  const stack = map.tree.nodes.map((node, order) => ({node, parent: null as string | null, order})).reverse();
  while (stack.length) {
    signal?.throwIfAborted();
    const {node, parent, order} = stack.pop()!;
    if (++count > 4096 || !node.id || ids.has(node.id)) return undefined;
    ids.add(node.id);
    const fields = [node.id, node.kind, node.path ?? null, node.title, node.summary, parent];
    for (const field of fields) if (typeof field === 'string' && !charge(field)) return undefined;
    budget -= 64; if (budget < 0) return undefined;
    rows.push([...fields, order, node.modifiedAt ?? null]);
    const children = node.children ?? [];
    if (children.length > 4096 - count || stack.length + children.length > 4096 - count) return undefined;
    for (let index = children.length - 1; index >= 0; index--) stack.push({node: children[index]!, parent: node.id, order: index});
  }
  signal?.throwIfAborted();
  const manifest = JSON.stringify([header, rows]);
  const bytes = new TextEncoder().encode(manifest);
  if (bytes.length > maximum) return undefined;
  const result = await crypto.subtle.digest('SHA-256', bytes);
  signal?.throwIfAborted();
  return 'sha256:' + [...new Uint8Array(result)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}
