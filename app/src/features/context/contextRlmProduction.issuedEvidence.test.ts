// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { createContextMapRlmRepository } from './contextRlmProduction';
import { createContextQueryService } from './contextQueryService';

const scope = {accountId: 'account', projectId: 'project'};
async function fixture() {
  const content = 'S61 disposable target evidence';
  const bytes = new TextEncoder().encode(content);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const sha = [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
  let currentSha = sha;
  const map = {id: 'map', projectId: 'project', rootDir: 'D:/disposable', status: 'active' as const,
    sourceType: 'local_folder' as const, updatedAt: 1, tree: {nodes: Array.from({length: 2021}, (_, i) => ({
      id: 'file-' + i, kind: 'file' as const, title: 'file-' + i + '.txt', summary: '',
      path: 'D:/disposable/file-' + i + '.txt', sizeBytes: bytes.length, modifiedAt: 1,
    }))}};
  const stat = vi.fn(async (path: string, includeSha: boolean) => ({ok: true as const, path, kind: 'file' as const,
    size: bytes.length, modifiedMs: 1, createdMs: 1, ...(includeSha ? {sha256: `sha256:${currentSha}` as const} : {})}));
  const repository = createContextMapRlmRepository({loadMaps: async () => [map], stat,
    read: async path => ({ok: true, path, content}),
    lexicalSearch: async () => [{documentId: 'file-0', score: 1, excerpt: 'untrusted index excerpt'}],
  });
  const service = createContextQueryService({repository});
  const search = await service.search({scope, query: 'S61 disposable target evidence'});
  expect(search.items).toHaveLength(1);
  const capture = await repository.captureIssuedEvidence(scope, 'map', search.items.map(item => item.pointer));
  expect(capture).toBeDefined(); stat.mockClear();
  return {repository, service, map, stat, capture: capture!, pointer: search.items[0]!.pointer,
    changeBytes: () => {currentSha = 'f'.repeat(64);}};
}
describe('real repository issued-evidence revision with synthetic filesystem/index IO edges', () => {
  it('revalidates only the issued target of 2021 selected files', async () => {
    const f = await fixture(); const proof = await f.repository.currentIssuedEvidenceRevision(scope, 'map', [f.capture]);
    expect(proof).toMatchObject({revisionKind: 'issued-evidence', wholeMapDiskFreshness: false, sourceCount: 1});
    expect(f.stat).toHaveBeenCalledTimes(3);
    expect(f.stat.mock.calls.every(([path]) => path === 'D:/disposable/file-0.txt')).toBe(true);
  });
  it('rejects changed bytes even with restored size and timestamps', async () => {
    const f = await fixture(); f.changeBytes();
    expect(await f.repository.currentIssuedEvidenceRevision(scope, 'map', [f.capture])).toBeUndefined();
  });
  it('rejects foreign scope, forged tokens and changed selected-map membership without disk IO', async () => {
    const f = await fixture();
    expect(await f.repository.currentIssuedEvidenceRevision({...scope, accountId: 'foreign'}, 'map', [f.capture])).toBeUndefined();
    expect(await f.repository.currentIssuedEvidenceRevision(scope, 'map', [{}])).toBeUndefined();
    f.map.tree.nodes.reverse();
    expect(await f.repository.currentIssuedEvidenceRevision(scope, 'map', [f.capture])).toBeUndefined();
    expect(f.stat).not.toHaveBeenCalled();
  });
  it('rejects an abort before starting any new disk work', async () => {
    const f = await fixture(); const controller = new AbortController(); controller.abort();
    await expect(f.repository.currentIssuedEvidenceRevision(scope, 'map', [f.capture], controller.signal)).rejects.toThrow();
    expect(f.stat).not.toHaveBeenCalled();
  });
  it('preflights an oversized issued target before any SHA request', async () => {
    const f = await fixture(); f.stat.mockImplementation(async (path) => ({ok: true, path, kind: 'file',
      size: 1024 * 1024 + 1, modifiedMs: 1, createdMs: 1}));
    expect(await f.repository.currentIssuedEvidenceRevision(scope, 'map', [f.capture])).toBeUndefined();
    expect(f.stat.mock.calls).toEqual([['D:/disposable/file-0.txt', false, {root: 'D:/disposable', strictProjectBoundary: true}]]);
  });
  it('stops scheduling hashes when protected authority is released during preflight', async () => {
    const f = await fixture(); let current = true;
    f.stat.mockImplementation(async (path) => { current = false; return {ok: true, path, kind: 'file', size: 12, modifiedMs: 1, createdMs: 1}; });
    expect(await f.repository.currentIssuedEvidenceRevision(scope, 'map', [f.capture], undefined, () => current)).toBeUndefined();
    expect(f.stat.mock.calls.every(([, includeSha]) => includeSha === false)).toBe(true);
    expect(f.stat).toHaveBeenCalledTimes(1);
  });
});
