import type { FsPathStatResult } from '@/lib/fs';

export interface RlmRevisionSource {
  mapId: string;
  nodeId: string;
  sourceKind: string;
  rootDir: string;
  path: string;
  gitCommit?: string;
  inlineContent?: string;
}
export type RlmRevisionStat = (path: string, includeSha256: boolean,
  options: { root?: string | null; strictProjectBoundary?: boolean }) => Promise<FsPathStatResult>;
const MAX_SOURCES = 128;
const MAX_BYTES = 8 * 1024 * 1024;
const MAX_SOURCE_BYTES = 1024 * 1024;
const SHA = /^sha256:[a-f0-9]{64}$/u;
interface Preflight { source: RlmRevisionSource; size?: number; before?: Extract<FsPathStatResult, { ok: true }> }
async function digest(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return 'sha256:' + [...new Uint8Array(bytes)].map(b => b.toString(16).padStart(2, '0')).join('');
}
async function boundedMap<T, R>(items: readonly T[], fn: (item: T) => Promise<R>, signal?: AbortSignal) {
  const result: R[] = [];
  for (let offset = 0; offset < items.length; offset += 8) {
    signal?.throwIfAborted();
    const batch = await Promise.allSettled(items.slice(offset, offset + 8).map(fn));
    signal?.throwIfAborted();
    for (const item of batch) {
      if (item.status === 'rejected') throw item.reason;
      result.push(item.value);
    }
  }
  return result;
}
/** Actual current source hashes only; timestamps guard races but are not revision evidence. */
export async function currentRlmSourceRevision(
  input: readonly RlmRevisionSource[], stat: RlmRevisionStat, signal?: AbortSignal,
): Promise<string | undefined> {
  signal?.throwIfAborted();
  if (input.length > MAX_SOURCES) return undefined;
  // Federated/history/SiYuan kinds lack a current source snapshot on this port.
  // Git sources require the actual selected commit as well as their content hash.
  if (input.some(source => source.sourceKind !== 'file_version' &&
      !(source.sourceKind === 'git' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/iu.test(source.gitCommit ?? '')))) return undefined;
  const sources = input.map(source => ({ ...source }));
  const preflight = await boundedMap(sources, async (source): Promise<Preflight | undefined> => {
    if (source.inlineContent !== undefined) return { source, size: new TextEncoder().encode(source.inlineContent).length };
    const before = await stat(source.path, false, { root: source.rootDir, strictProjectBoundary: true });
    return before.ok && before.kind === 'file' ? { source, size: before.size, before } : undefined;
  }, signal);
  if (preflight.some(item => !item || !Number.isSafeInteger(item.size) || item.size! < 0 || item.size! > MAX_SOURCE_BYTES) ||
      preflight.reduce((sum, item) => sum + (item?.size ?? MAX_BYTES + 1), 0) > MAX_BYTES) return undefined;
  const fingerprints = await boundedMap(preflight, async item => {
    if (!item) return undefined;
    const source = item.source;
    let hash: string;
    if (source.inlineContent !== undefined) hash = await digest(source.inlineContent);
    else {
      const hashed = await stat(source.path, true, { root: source.rootDir, strictProjectBoundary: true });
      if (!hashed.ok || hashed.kind !== 'file' || hashed.size !== item.size || !SHA.test(hashed.sha256 ?? '') ||
          hashed.modifiedMs !== item.before?.modifiedMs || hashed.createdMs !== item.before?.createdMs) return undefined;
      const after = await stat(source.path, false, { root: source.rootDir, strictProjectBoundary: true });
      if (!after.ok || after.kind !== 'file' || after.size !== hashed.size ||
          after.modifiedMs !== hashed.modifiedMs || after.createdMs !== hashed.createdMs) return undefined;
      hash = hashed.sha256!;
    }
    return JSON.stringify([source.mapId, source.nodeId, source.sourceKind, source.rootDir, source.path, source.gitCommit ?? null, hash]);
  }, signal);
  if (fingerprints.some(value => value === undefined)) return undefined;
  signal?.throwIfAborted();
  return digest(JSON.stringify((fingerprints as string[]).sort()));
}
