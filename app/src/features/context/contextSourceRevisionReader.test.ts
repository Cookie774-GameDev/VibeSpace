// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { createContextSourceRevisionReader, sourceProofMatchesCurrentTransport } from './contextSourceRevisionReader';
const scope = { accountId: 'account', workspaceId: 'workspace', projectId: 'project', worktreeId: 'worktree', epoch: 1 };
const request = { accountId: 'account', chatId: 'chat', mapId: 'map' };
const revision = 'sha256:' + 'a'.repeat(64);
const run = { accountId: 'account', chatId: 'chat', runId: 'run', requestId: 'request', attemptNumber: 1 };
function fixture() {
  const deps = { currentAuthority: vi.fn(() => scope), authorizeChat: vi.fn(async () => true), currentMapRevision: vi.fn(async () => revision), readRunIdentity: vi.fn(async (): Promise<typeof run | undefined> => run) };
  return { deps, read: createContextSourceRevisionReader(deps) };
}
describe('trusted source-revision reader (staged unit fixture, not native)', () => {
  it('pre-send read never invents a run and returns digest only', async () => {
    const f = fixture(); const result = await f.read(request);
    expect(result).toMatchObject({ ...request, workspaceId: scope.workspaceId, projectId: scope.projectId, authorityEpoch: 1, sourceRevision: revision });
    expect(result?.worktreeHash).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(JSON.stringify(result)).not.toContain('worktree"');
    expect(f.deps.readRunIdentity).not.toHaveBeenCalled();
  });
  it('wrong account or denied chat performs no content hashing', async () => {
    const f = fixture(); expect(await f.read({ ...request, accountId: 'other' })).toBeUndefined();
    f.deps.authorizeChat.mockResolvedValue(false); expect(await f.read(request)).toBeUndefined();
    expect(f.deps.currentMapRevision).not.toHaveBeenCalled();
  });
  it('authority epoch change during hashing fails closed', async () => {
    const f = fixture(); f.deps.currentMapRevision.mockImplementation(async () => { f.deps.currentAuthority.mockReturnValue({ ...scope, epoch: 2 }); return revision; });
    expect(await f.read(request)).toBeUndefined();
  });
  it('source read denial does not export raw errors or paths', async () => {
    const f = fixture(); f.deps.currentMapRevision.mockRejectedValue(new Error('private path/body'));
    expect(await f.read(request)).toBeUndefined();
  });
  it('post-send exact run/request/attempt required and rechecked', async () => {
    const f = fixture(); expect(await f.read({ ...request, ...run })).toMatchObject(run);
    f.deps.readRunIdentity.mockResolvedValue({ ...run, requestId: 'other' });
    expect(await f.read({ ...request, ...run })).toBeUndefined();
    f.deps.readRunIdentity.mockResolvedValueOnce(run).mockResolvedValueOnce({ ...run, attemptNumber: 2 });
    expect(await f.read({ ...request, ...run })).toBeUndefined();
  });
});

describe('durable proof versus actual current transport attempt', () => {
  const proof = { requestId: 'request', attemptNumber: 1 };
  it('allows the exact latest transport identity', () => {
    expect(sourceProofMatchesCurrentTransport(proof, { ...proof })).toBe(true);
  });
  it('allows validated native provider proof when no transport attempt exists', () => {
    expect(sourceProofMatchesCurrentTransport(proof, undefined)).toBe(true);
  });
  it('rejects missing durable proof even if transport exists', () => {
    expect(sourceProofMatchesCurrentTransport(undefined, proof)).toBe(false);
  });
  it('rejects old proof when a newer transport is already in flight', () => {
    expect(sourceProofMatchesCurrentTransport(proof, { requestId: 'new-request', attemptNumber: 2 })).toBe(false);
  });
  it('rejects another request at the same attempt', () => {
    expect(sourceProofMatchesCurrentTransport(proof, { ...proof, requestId: 'other' })).toBe(false);
  });
  it('rejects transport advance during the source hash', async () => {
    let current = { ...proof };
    const f = fixture();
    f.deps.readRunIdentity.mockImplementation(async () => sourceProofMatchesCurrentTransport(proof, current) ? run : undefined);
    f.deps.currentMapRevision.mockImplementation(async () => { current = { requestId: 'new-request', attemptNumber: 2 }; return revision; });
    expect(await f.read({ ...request, ...run })).toBeUndefined();
    expect(f.deps.readRunIdentity).toHaveBeenCalledTimes(2);
  });
});