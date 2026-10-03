// @vitest-environment node
import { describe, expect, it, vi, beforeEach } from 'vitest';
const register = vi.hoisted(() => vi.fn());
vi.mock('@/lib/harness/toolGatewayCitations', () => ({registerToolGatewayFallbackCitations: register}));
import { createRlmOpenCodeTool } from './rlmOpenCodeTool';

const lease = {sessionId: 'session', accountId: 'account', projectId: 'project', chatId: 'chat',
  selectedMapId: 'map', contextRevision: 'root-epoch:1', expiresAt: 2000};
const tuple = {pointerId: 'pointer', recordId: 'record', sourceRevision: 'sha256:' + 'a'.repeat(64), contentHash: 'a'.repeat(64)};
const result = {items: [{record: {id: tuple.recordId}, pointer: {id: tuple.pointerId, recordId: tuple.recordId,
  sourceVersion: tuple.sourceRevision, contentHash: tuple.contentHash}}]};
function fixture() {
  let now = 1000;
  const queryService = {search: vi.fn(async () => result), describe: vi.fn(), open: vi.fn(), expand: vi.fn(),
    related: vi.fn(), timeline: vi.fn(), sources: vi.fn(), checkpoint: vi.fn()};
  const issuer = vi.fn(async () => [tuple]);
  const tool = createRlmOpenCodeTool({queryService, verifiedFallbackCitations: issuer,
    rlmRuntime: {investigate: vi.fn()}, now: () => now});
  return {tool, queryService, issuer, expire: () => {now = 2001;}};
}
describe('fallback citation publication boundary (synthetic authority fixtures, not native)', () => {
  beforeEach(() => register.mockClear());
  it('returns raw retrieval without canonical claim when ROOT callback is absent', async () => {
    const f = fixture(); expect(await f.tool.execute({operation: 'search', query: 'evidence'}, lease)).toBe(result);
    expect(f.issuer).not.toHaveBeenCalled(); expect(register).not.toHaveBeenCalled();
  });
  it('requires issuer callback rather than result pointer syntax', async () => {
    const f = fixture(); f.issuer.mockResolvedValue([]);
    await f.tool.execute({operation: 'search', query: 'evidence'}, lease, undefined, () => lease.contextRevision);
    expect(register).not.toHaveBeenCalled();
  });
  it('registers only issuer tuples with the exact still-current captured lease', async () => {
    const f = fixture();
    await f.tool.execute({operation: 'search', query: 'evidence'}, lease, undefined, current => {
      expect(Object.isFrozen(current)).toBe(true); return current.contextRevision;
    });
    expect(register).toHaveBeenCalledExactlyOnceWith('session', [tuple], {accountId: 'account', projectId: 'project'});
  });
  it('rejects A-to-B-to-A epoch change while awaiting the issuer before registry mutation', async () => {
    const f = fixture(); let epoch = lease.contextRevision;
    f.issuer.mockImplementation(async () => {epoch = 'root-epoch:3'; return [tuple];});
    await expect(f.tool.execute({operation: 'search', query: 'evidence'}, lease, undefined, () => epoch)).rejects.toMatchObject({code: 'lease_not_current'});
    expect(register).not.toHaveBeenCalled();
  });
  it('rejects expired or cancelled issuer results before registry mutation', async () => {
    const f = fixture(); f.issuer.mockImplementation(async () => {f.expire(); return [tuple];});
    await expect(f.tool.execute({operation: 'search', query: 'evidence'}, lease, undefined, () => lease.contextRevision)).rejects.toMatchObject({code: 'lease_expired'});
    expect(register).not.toHaveBeenCalled();
    const g = fixture(); const controller = new AbortController();
    g.issuer.mockImplementation(async () => {controller.abort(); return [tuple];});
    await expect(g.tool.execute({operation: 'search', query: 'evidence'}, lease, controller.signal, () => lease.contextRevision)).rejects.toThrow();
    expect(register).not.toHaveBeenCalled();
  });
  it('rejects a released protected lease while issuer verification awaits', async () => {
    const f = fixture(); let current: string | undefined = lease.contextRevision;
    f.issuer.mockImplementation(async () => {current = undefined; return [tuple];});
    await expect(f.tool.execute({operation: 'search', query: 'evidence'}, lease, undefined, () => current)).rejects.toMatchObject({code: 'lease_not_current'});
    expect(register).not.toHaveBeenCalled();
  });
});
