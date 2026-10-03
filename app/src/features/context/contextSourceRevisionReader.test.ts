// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { createContextSourceRevisionReader, sourceProofMatchesCurrentTransport } from './contextSourceRevisionReader';
const scope = { accountId: 'account', workspaceId: 'workspace', projectId: 'project', worktreeId: 'worktree', epoch: 1 };
const request = { accountId: 'account', chatId: 'chat', mapId: 'map' };
const revision = 'sha256:' + 'a'.repeat(64);
const run = { accountId: 'account', chatId: 'chat', runId: 'run', requestId: 'request', attemptNumber: 1 };
const observation = (boundRun?: typeof run) => ({sourceRevision: revision, membershipRevision: revision,
  revisionKind: boundRun ? 'issued-evidence' as const : 'map-membership' as const,
  wholeMapDiskFreshness: false as const, sourceCount: 0, verifiedBytes: 0});
function fixture() {
  const deps = { currentAuthority: vi.fn(() => scope), currentScopeRevision: vi.fn((): string | undefined => 'root-epoch:1'), authorizeChat: vi.fn(async () => true), currentMapRevision: vi.fn(async (_authority: unknown, _map: string, _signal?: AbortSignal, boundRun?: typeof run) => observation(boundRun)), readRunIdentity: vi.fn(async (): Promise<typeof run | undefined> => run) };
  return { deps, read: createContextSourceRevisionReader(deps) };
}
describe('trusted source-revision reader (staged unit fixture, not native)', () => {
  it('prepares a cold selected map before capturing its first protected token', async () => {
    const f = fixture(); f.deps.currentScopeRevision.mockReturnValue(undefined);
    const prepareScope = vi.fn(async () => {f.deps.currentScopeRevision.mockReturnValue('root-epoch:1'); return true;});
    const read = createContextSourceRevisionReader({...f.deps, prepareScope});
    expect(await read(request)).toMatchObject({revisionKind: 'map-membership', sourceRevision: revision});
    expect(prepareScope).toHaveBeenCalledExactlyOnceWith(scope, request, undefined);
  });
  it('rejects authority A-B-A during cold preparation before hashing any source', async () => {
    const f = fixture(); f.deps.currentScopeRevision.mockReturnValue(undefined);
    const read = createContextSourceRevisionReader({...f.deps, prepareScope: async () => {
      f.deps.currentAuthority.mockReturnValue({...scope, epoch: 3});
      f.deps.currentScopeRevision.mockReturnValue('root-epoch:3'); return true;
    }});
    expect(await read(request)).toBeUndefined(); expect(f.deps.currentMapRevision).not.toHaveBeenCalled();
  });
  it('keeps a warm pre-await token so preparation cannot conceal selected-map ABA', async () => {
    const f = fixture();
    const read = createContextSourceRevisionReader({...f.deps, prepareScope: async () => {
      f.deps.currentScopeRevision.mockReturnValue('root-epoch:3'); return true;
    }});
    expect(await read(request)).toBeUndefined(); expect(f.deps.currentMapRevision).not.toHaveBeenCalled();
  });
  it('rejects failed or aborted cold initialization without starting hashing', async () => {
    const f = fixture();
    expect(await createContextSourceRevisionReader({...f.deps, prepareScope: async () => false})(request)).toBeUndefined();
    const controller = new AbortController();
    const read = createContextSourceRevisionReader({...f.deps, prepareScope: async () => {controller.abort(); return true;}});
    await expect(read(request, controller.signal)).rejects.toThrow();
    expect(f.deps.currentMapRevision).not.toHaveBeenCalled();
  });
  it('rejects chat release during cold preparation before starting source IO', async () => {
    const f = fixture(); f.deps.currentScopeRevision.mockReturnValue(undefined);
    const read = createContextSourceRevisionReader({...f.deps, prepareScope: async () => {
      f.deps.currentScopeRevision.mockReturnValue('root-epoch:1');
      f.deps.authorizeChat.mockResolvedValue(false); return true;
    }});
    expect(await read(request)).toBeUndefined(); expect(f.deps.currentMapRevision).not.toHaveBeenCalled();
  });
  it('revalidates the exact current attempt after preparation for a bound read', async () => {
    const f = fixture();
    const read = createContextSourceRevisionReader({...f.deps, prepareScope: async () => {
      f.deps.readRunIdentity.mockResolvedValue({...run, attemptNumber: 2}); return true;
    }});
    expect(await read({...request, ...run})).toBeUndefined(); expect(f.deps.currentMapRevision).not.toHaveBeenCalled();
  });
  it('denies source publication when ROOT current-scope callback is unavailable', async () => {
    const f = fixture(); f.deps.currentScopeRevision.mockReturnValue(undefined);
    expect(await f.read(request)).toBeUndefined();
    expect(f.deps.currentMapRevision).not.toHaveBeenCalled();
  });
  it('detects project A-to-B-to-A through monotonic protected token despite identical final scope', async () => {
    const f = fixture(); f.deps.currentMapRevision.mockImplementation(async () => {
      f.deps.currentScopeRevision.mockReturnValue('root-epoch:3'); return observation();
    });
    expect(await f.read(request)).toBeUndefined();
  });
  it('keeps membership-only and issued-evidence labels separate', async () => {
    const f = fixture(); expect(await f.read(request)).toMatchObject({revisionKind: 'map-membership', wholeMapDiskFreshness: false});
    expect(await f.read({...request, ...run})).toMatchObject({revisionKind: 'issued-evidence', wholeMapDiskFreshness: false});
    f.deps.currentMapRevision.mockResolvedValue(observation(run));
    expect(await f.read(request)).toBeUndefined();
  });
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
    const f = fixture(); f.deps.currentMapRevision.mockImplementation(async () => { f.deps.currentAuthority.mockReturnValue({ ...scope, epoch: 2 }); return observation(); });
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
    f.deps.currentMapRevision.mockImplementation(async () => { current = { requestId: 'new-request', attemptNumber: 2 }; return observation(run); });
    expect(await f.read({ ...request, ...run })).toBeUndefined();
    expect(f.deps.readRunIdentity).toHaveBeenCalledTimes(2);
  });
});
