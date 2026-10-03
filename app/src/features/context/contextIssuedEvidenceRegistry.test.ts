// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { createIssuedEvidenceRegistry, currentMembershipDigest, type EvidenceRevision, type IssuedEvidencePort } from './contextIssuedEvidenceRegistry';

const scope = {accountId: 'account', workspaceId: 'workspace', projectId: 'project', worktreeId: 'worktree'};
const lease = {...scope, sessionId: 'session', chatId: 'chat', selectedMapId: 'map', contextRevision: 'root-epoch:1',
  canonicalBinding: {runId: 'run', requestId: 'request', attemptNumber: 1}, expiresAt: 999999};
const membershipRevision = 'sha256:' + 'a'.repeat(64);
const proof: EvidenceRevision = {membershipRevision, sourceRevision: 'sha256:' + 'b'.repeat(64),
  revisionKind: 'issued-evidence', wholeMapDiskFreshness: false, sourceCount: 1, verifiedBytes: 12};
function fixture() {
  let at = 1; let epoch = lease.contextRevision;
  const handle = Object.freeze({});
  const port: IssuedEvidencePort = {
    currentMapMembershipRevision: vi.fn(async () => membershipRevision),
    currentIssuedEvidenceRevision: vi.fn(async (_scope: unknown, _map: string, handles: readonly object[]) => handles.every(value => value === handle) ? proof : undefined),
  };
  return {handle, port, registry: createIssuedEvidenceRegistry({now: () => at}), current: () => epoch,
    advance: () => {at += 600001;}, change: () => {epoch = 'root-epoch:3';}};
}
describe('issued registry synthetic authority boundaries (not native proof)', () => {
  it('serializes distinct simultaneous captures for one canonical run and retains their union', async () => {
    const f = fixture(); const secondHandle = Object.freeze({});
    let started!: () => void; let release!: () => void;
    const begun = new Promise<void>(resolve => {started = resolve;});
    const gate = new Promise<void>(resolve => {release = resolve;});
    const seen: object[][] = [];
    let calls = 0;
    f.port.currentIssuedEvidenceRevision = async (_scope, _map, handles) => {
      seen.push([...handles]);
      if (++calls === 1) {started(); await gate;}
      return {...proof, sourceCount: handles.length};
    };
    const first = f.registry.publish(lease, [f.handle], f.port, f.current);
    await begun;
    const second = f.registry.publish(lease, [secondHandle], f.port, f.current);
    release(); expect(await Promise.all([first, second])).toEqual([true, true]);
    expect(seen).toEqual([[f.handle], [f.handle, secondHandle]]);
    expect(await f.registry.read(scope, 'chat', 'map', lease.canonicalBinding, lease.contextRevision, f.current)).toMatchObject({sourceCount: 2});
  });
  it('does not expose an earlier partial proof while another capture publication is in flight', async () => {
    const f = fixture(); await f.registry.publish(lease, [f.handle], f.port, f.current);
    let started!: () => void; let release!: () => void;
    const begun = new Promise<void>(resolve => {started = resolve;});
    const gate = new Promise<void>(resolve => {release = resolve;});
    let first = true;
    f.port.currentIssuedEvidenceRevision = async () => {if (first) {first = false; started(); await gate;} return proof;};
    const pending = f.registry.publish(lease, [f.handle], f.port, f.current);
    await begun;
    const observed = await f.registry.read(scope, 'chat', 'map', lease.canonicalBinding, lease.contextRevision, f.current);
    release(); await pending;
    expect(observed).toBeUndefined();
  });
  it('aborts a queued waiter without cancelling the publisher ahead of it or starting its IO', async () => {
    const f = fixture();
    let started!: () => void; let release!: () => void; let calls = 0;
    const begun = new Promise<void>(resolve => {started = resolve;});
    const gate = new Promise<void>(resolve => {release = resolve;});
    f.port.currentIssuedEvidenceRevision = async () => {calls++; started(); await gate; return proof;};
    const first = f.registry.publish(lease, [f.handle], f.port, f.current); await begun;
    const controller = new AbortController();
    const second = f.registry.publish(lease, [f.handle], f.port, f.current, controller.signal);
    controller.abort();
    await expect(second).rejects.toThrow();
    release(); expect(await first).toBe(true);
    // Let the queued aborted task settle; it must not invoke the source port.
    await Promise.resolve(); await Promise.resolve();
    expect(calls).toBe(1);
  });
  it('keeps a different canonical request independent of a blocked writer', async () => {
    const f = fixture(); let started!: () => void; let release!: () => void; let calls = 0;
    const begun = new Promise<void>(resolve => {started = resolve;});
    const gate = new Promise<void>(resolve => {release = resolve;});
    f.port.currentIssuedEvidenceRevision = async () => {if (++calls === 1) {started(); await gate;} return proof;};
    const first = f.registry.publish(lease, [f.handle], f.port, f.current); await begun;
    const other = {...lease, canonicalBinding: {...lease.canonicalBinding, requestId: 'request-other', attemptNumber: 2}};
    const independent = await f.registry.publish(other, [f.handle], f.port, f.current);
    release(); await first;
    expect(independent).toBe(true); expect(calls).toBe(2);
  });
  it('keeps a failed same-run source union unavailable rather than resurrecting prior A', async () => {
    const f = fixture(); const secondHandle = Object.freeze({});
    expect(await f.registry.publish(lease, [f.handle], f.port, f.current)).toBe(true);
    f.port.currentIssuedEvidenceRevision = async (_scope, _map, handles) => handles.includes(secondHandle) ? undefined : proof;
    expect(await f.registry.publish(lease, [secondHandle], f.port, f.current)).toBe(false);
    expect(await f.registry.read(scope, 'chat', 'map', lease.canonicalBinding, lease.contextRevision, f.current)).toBeUndefined();
  });
  it('does not resurrect prior A after a transient membership refusal for used B', async () => {
    const f = fixture(); expect(await f.registry.publish(lease, [f.handle], f.port, f.current)).toBe(true);
    const original = f.port.currentMapMembershipRevision;
    f.port.currentMapMembershipRevision = async () => undefined;
    expect(await f.registry.publish(lease, [Object.freeze({})], f.port, f.current)).toBe(false);
    f.port.currentMapMembershipRevision = original;
    expect(await f.registry.read(scope, 'chat', 'map', lease.canonicalBinding, lease.contextRevision, f.current)).toBeUndefined();
  });
  it('does not resurrect prior A after same-run source verification throws', async () => {
    const f = fixture(); expect(await f.registry.publish(lease, [f.handle], f.port, f.current)).toBe(true);
    const original = f.port.currentIssuedEvidenceRevision;
    f.port.currentIssuedEvidenceRevision = async () => {throw new Error('synthetic read denial');};
    await expect(f.registry.publish(lease, [Object.freeze({})], f.port, f.current)).rejects.toThrow('synthetic read denial');
    f.port.currentIssuedEvidenceRevision = original;
    expect(await f.registry.read(scope, 'chat', 'map', lease.canonicalBinding, lease.contextRevision, f.current)).toBeUndefined();
  });
  it('poisons initial capture overflow without preserving earlier A or permitting later C', async () => {
    const f = fixture(); expect(await f.registry.publish(lease, [f.handle], f.port, f.current)).toBe(true);
    expect(await f.registry.publish(lease, Array.from({length: 129}, () => f.handle), f.port, f.current)).toBe(false);
    expect(await f.registry.publish(lease, [f.handle], f.port, f.current)).toBe(false);
    expect(await f.registry.read(scope, 'chat', 'map', lease.canonicalBinding, lease.contextRevision, f.current)).toBeUndefined();
  });
  it('poisons mismatched source membership so queued C cannot rebuild a subset', async () => {
    const f = fixture(); expect(await f.registry.publish(lease, [f.handle], f.port, f.current)).toBe(true);
    f.port.currentMapMembershipRevision = async () => 'sha256:' + 'b'.repeat(64);
    const b = f.registry.publish(lease, [Object.freeze({})], f.port, f.current);
    const c = f.registry.publish(lease, [f.handle], f.port, f.current);
    expect(await Promise.all([b, c])).toEqual([false, false]);
    expect(await f.registry.read(scope, 'chat', 'map', lease.canonicalBinding, lease.contextRevision, f.current)).toBeUndefined();
  });
  it('poisons overflow so an already queued C cannot recreate a partial same-run proof', async () => {
    const f = fixture(); const handles = Array.from({length: 128}, () => Object.freeze({}));
    f.port.currentIssuedEvidenceRevision = async (_scope, _map, captures) => ({...proof, sourceCount: captures.length});
    expect(await f.registry.publish(lease, handles, f.port, f.current)).toBe(true);
    const b = f.registry.publish(lease, [Object.freeze({})], f.port, f.current);
    const c = f.registry.publish(lease, [Object.freeze({})], f.port, f.current);
    expect(await Promise.all([b, c])).toEqual([false, false]);
    expect(await f.registry.read(scope, 'chat', 'map', lease.canonicalBinding, lease.contextRevision, f.current)).toBeUndefined();
  });
  it('marks a failed genuine capture unavailable for the exact current canonical run', async () => {
    const f = fixture(); expect(await f.registry.publish(lease, [f.handle], f.port, f.current)).toBe(true);
    expect(f.registry.markUnavailable(lease, f.current)).toBe(true);
    expect(await f.registry.read(scope, 'chat', 'map', lease.canonicalBinding, lease.contextRevision, f.current)).toBeUndefined();
    expect(await f.registry.publish(lease, [f.handle], f.port, f.current)).toBe(false);
  });
  it('does not poison a peer on cancelled, expired, or stale invalidation admission', async () => {
    const f = fixture(); await f.registry.publish(lease, [f.handle], f.port, f.current);
    const controller = new AbortController(); controller.abort();
    expect(f.registry.markUnavailable(lease, f.current, controller.signal)).toBe(false);
    expect(f.registry.markUnavailable({...lease, expiresAt: 0}, f.current)).toBe(false);
    expect(f.registry.markUnavailable(lease, () => 'rlm:foreign')).toBe(false);
    expect(await f.registry.read(scope, 'chat', 'map', lease.canonicalBinding, lease.contextRevision, f.current)).toEqual(proof);
  });
  it('does not invalidate another canonical run when the exact binding differs', async () => {
    const f = fixture(); await f.registry.publish(lease, [f.handle], f.port, f.current);
    expect(f.registry.markUnavailable({...lease, canonicalBinding: {...lease.canonicalBinding, runId: 'other-run'}}, f.current)).toBe(true);
    expect(await f.registry.read(scope, 'chat', 'map', lease.canonicalBinding, lease.contextRevision, f.current)).toEqual(proof);
  });
  it('requires actual private capture validation and exact canonical binding', async () => {
    const f = fixture();
    expect(await f.registry.publish(lease, [f.handle], f.port, f.current)).toBe(true);
    expect(await f.registry.read(scope, 'chat', 'map', lease.canonicalBinding, lease.contextRevision, f.current)).toEqual(proof);
    expect(await f.registry.read(scope, 'chat', 'map', {...lease.canonicalBinding, attemptNumber: 2}, lease.contextRevision, f.current)).toBeUndefined();
    expect(await f.registry.read({...scope, accountId: 'foreign'}, 'chat', 'map', lease.canonicalBinding, lease.contextRevision, f.current)).toBeUndefined();
  });
  it('rejects deserialized/forged capture tokens', async () => {
    const f = fixture(); expect(await f.registry.publish(lease, [{}], f.port, f.current)).toBe(false);
    expect(await f.registry.read(scope, 'chat', 'map', lease.canonicalBinding, lease.contextRevision, f.current)).toBeUndefined();
  });
  it('rejects protected scope ABA during current-source await before publication', async () => {
    const f = fixture(); f.port.currentIssuedEvidenceRevision = async () => { f.change(); return proof; };
    expect(await f.registry.publish(lease, [f.handle], f.port, f.current)).toBe(false);
  });
  it('rejects expired captures and post-lookup scope changes', async () => {
    const f = fixture(); await f.registry.publish(lease, [f.handle], f.port, f.current);
    f.port.currentIssuedEvidenceRevision = async () => { f.change(); return proof; };
    expect(await f.registry.read(scope, 'chat', 'map', lease.canonicalBinding, lease.contextRevision, f.current)).toBeUndefined();
    const g = fixture(); await g.registry.publish(lease, [g.handle], g.port, g.current); g.advance();
    expect(await g.registry.read(scope, 'chat', 'map', lease.canonicalBinding, lease.contextRevision, g.current)).toBeUndefined();
  });
  it('does not admit whole-map freshness claims or source-budget overflow', async () => {
    const f = fixture(); f.port.currentIssuedEvidenceRevision = async () => ({...proof, sourceCount: 129});
    expect(await f.registry.publish(lease, [f.handle], f.port, f.current)).toBe(false);
    expect(await f.registry.publish(lease, Array.from({length: 129}, () => f.handle), f.port, f.current)).toBe(false);
  });
});
describe('complete bounded topology metadata', () => {
  const node = (id: string) => ({id, kind: 'file', title: id, summary: ''});
  const map = {id: 'map', rootDir: 'D:/disposable', sourceType: 'local_folder', updatedAt: 1,
    tree: {nodes: Array.from({length: 2021}, (_, i) => node('n' + i))}};
  it('accepts 2021 membership records without claiming any disk source freshness', async () => {
    expect(await currentMembershipDigest(scope, map)).toMatch(/^sha256:[a-f0-9]{64}$/);
  });
  it('distinguishes parent topology and sibling order, not just flattened IDs', async () => {
    const a = {...map, tree: {nodes: [node('a'), node('b')]}};
    const b = {...map, tree: {nodes: [{...node('a'), children: [node('b')]}]}};
    const c = {...map, tree: {nodes: [node('b'), node('a')]}};
    expect(await currentMembershipDigest(scope, a)).not.toBe(await currentMembershipDigest(scope, b));
    expect(await currentMembershipDigest(scope, a)).not.toBe(await currentMembershipDigest(scope, c));
  });
  it('rejects duplicates, descriptor overflow, huge metadata and abort', async () => {
    expect(await currentMembershipDigest(scope, {...map, tree: {nodes: [node('a'), node('a')]}})).toBeUndefined();
    expect(await currentMembershipDigest(scope, {...map, tree: {nodes: Array.from({length: 4097}, (_, i) => node('n' + i))}})).toBeUndefined();
    expect(await currentMembershipDigest(scope, {...map, tree: {nodes: [{...node('a'), summary: 'x'.repeat(8 * 1024 * 1024)}]}})).toBeUndefined();
    const controller = new AbortController(); controller.abort();
    await expect(currentMembershipDigest(scope, map, controller.signal)).rejects.toThrow();
  });
});
