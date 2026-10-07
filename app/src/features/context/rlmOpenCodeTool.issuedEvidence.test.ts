// @vitest-environment node
import { describe, expect, it, vi, beforeEach } from 'vitest';
import * as citationRegistry from '@/lib/harness/toolGatewayCitations';
const register = vi.spyOn(citationRegistry, 'registerToolGatewayFallbackCitations');
import { createRlmOpenCodeTool } from './rlmOpenCodeTool';

const lease = {sessionId: 'session', accountId: 'account', projectId: 'project', chatId: 'chat',
  selectedMapId: 'map', contextRevision: 'root-epoch:1', expiresAt: 2000};
const tuple = {pointerId: 'pointer', recordId: 'record', sourceRevision: 'sha256:' + 'a'.repeat(64), contentHash: 'a'.repeat(64)};
const result = {items: [{record: {id: tuple.recordId}, pointer: {id: tuple.pointerId, recordId: tuple.recordId,
  sourceVersion: tuple.sourceRevision, contentHash: tuple.contentHash, byteStart:0, byteEnd:24}}]};
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
  beforeEach(() => { register.mockClear(); citationRegistry.clearToolGatewayContextCitationItems(); });
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


describe('provider-visible verified fallback provenance (actual registry)', () => {
  beforeEach(() => {
    register.mockClear();
    citationRegistry.clearToolGatewayContextCitationItems();
  });
  it.each(['search', 'open', 'expand'])(
    'returns the registered canonical evidence handle to %s before final generation',
    async (operation) => {
      const f = fixture();
      const opened = {
        record: result.items[0]!.record,
        pointer: result.items[0]!.pointer,
        text: 'synthetic',
      };
      f.queryService.open.mockResolvedValue(opened);
      f.queryService.expand.mockResolvedValue(opened);
      const response = (await f.tool.execute(
        operation === 'search'
          ? { operation, query: 'evidence' }
          : { operation, pointer: opened.pointer },
        lease,
        undefined,
        () => lease.contextRevision,
      )) as any;
      const registered = citationRegistry.consumeToolGatewayContextCitationItems(lease.sessionId);
      expect(registered).toHaveLength(1);
      expect(response.canonicalProvenance).toEqual({
        evidenceUris: [registered[0]!.source.uri],
        truncated: false,
      });
      expect(JSON.stringify(response)).toContain(registered[0]!.source.uri);
      expect(Object.isFrozen(response.canonicalProvenance.evidenceUris)).toBe(true);
      expect(result).not.toHaveProperty('canonicalProvenance');
    },
  );
  it('removes an injected canonical claim when the issuer refuses it', async () => {
    const f = fixture();
    f.issuer.mockResolvedValue([]);
    f.queryService.search.mockResolvedValue({
      ...result,
      canonicalProvenance: {
        evidenceUris: ['vibespace:context/evidence/injected'],
        truncated: false,
      },
    } as typeof result);
    const response = await f.tool.execute(
      { operation: 'search', query: 'evidence' },
      lease,
      undefined,
      () => lease.contextRevision,
    );
    expect(response).not.toHaveProperty('canonicalProvenance');
    expect(citationRegistry.consumeToolGatewayContextCitationItems(lease.sessionId)).toEqual([]);
  });
  it('does not publish malformed or nonjoining issuer tuples as canonical', async () => {
    const f = fixture();
    f.issuer.mockResolvedValue([
      { ...tuple, pointerId: 'another-pointer' },
      { ...tuple, sourceRevision: 'stale' },
      { ...tuple, contentHash: 'bad' },
    ]);
    const response = await f.tool.execute(
      { operation: 'search', query: 'evidence' },
      lease,
      undefined,
      () => lease.contextRevision,
    );
    expect(response).not.toHaveProperty('canonicalProvenance');
    expect(citationRegistry.consumeToolGatewayContextCitationItems(lease.sessionId)).toEqual([]);
  });
  it('caps returned canonical metadata without truncating source results or inventing handles', async () => {
    const f = fixture();
    const items = Array.from({ length: 40 }, (_, i) => ({
      record: { id: 'record-' + i },
      pointer: {
        id: 'pointer-' + i,
        recordId: 'record-' + i,
        sourceVersion: tuple.sourceRevision,
        contentHash: tuple.contentHash,
        byteStart: 0,
        byteEnd: 24,
      },
    }));
    f.queryService.search.mockResolvedValue({ items });
    f.issuer.mockResolvedValue(
      items.map(({ pointer }) => ({
        pointerId: pointer.id,
        recordId: pointer.recordId,
        sourceRevision: pointer.sourceVersion,
        contentHash: pointer.contentHash,
      })),
    );
    const response = (await f.tool.execute(
      { operation: 'search', query: 'evidence' },
      lease,
      undefined,
      () => lease.contextRevision,
    )) as any;
    expect(response.items).toHaveLength(40);
    expect(response.canonicalProvenance.evidenceUris).toHaveLength(32);
    expect(response.canonicalProvenance.truncated).toBe(true);
    const registered = citationRegistry
      .consumeToolGatewayContextCitationItems(lease.sessionId)
      .map((item) => item.source.uri);
    expect(response.canonicalProvenance.evidenceUris).toEqual(registered);
    expect(
      new TextEncoder().encode(JSON.stringify(response.canonicalProvenance)).length,
    ).toBeLessThanOrEqual(16 * 1024);
  });
});

describe('canonical metadata refusal and byte bounds', () => {
  beforeEach(() => {
    register.mockClear();
    citationRegistry.clearToolGatewayContextCitationItems();
  });
  it.each(['missing-current', 'missing-project', 'empty-proof'])(
    'does not forward injected canonical metadata with %s',
    async (mode) => {
      const f = fixture();
      const injected = {
        ...result,
        canonicalProvenance: {
          evidenceUris: ['vibespace:context/evidence/forged'],
          truncated: false,
        },
      };
      f.queryService.search.mockResolvedValue(injected);
      if (mode === 'empty-proof') f.issuer.mockResolvedValue([]);
      const scoped = mode === 'missing-project' ? { ...lease, projectId: undefined } : lease;
      const response = await f.tool.execute(
        { operation: 'search', query: 'evidence' },
        scoped,
        undefined,
        mode === 'missing-current' ? undefined : () => lease.contextRevision,
      );
      expect(response).not.toHaveProperty('canonicalProvenance');
      expect(citationRegistry.consumeToolGatewayContextCitationItems(lease.sessionId)).toEqual([]);
    },
  );
  it('refuses a source-version change during awaited proof even if the scope token stays unchanged', async () => {
    const f = fixture();
    const changed = {
      items: [{ record: result.items[0]!.record, pointer: { ...result.items[0]!.pointer } }],
    };
    f.queryService.search.mockResolvedValue(changed);
    f.issuer.mockImplementation(async () => {
      changed.items[0]!.pointer.sourceVersion = 'sha256:' + 'b'.repeat(64);
      return [tuple];
    });
    const response = await f.tool.execute(
      { operation: 'search', query: 'evidence' },
      lease,
      undefined,
      () => lease.contextRevision,
    );
    expect(response).not.toHaveProperty('canonicalProvenance');
    expect(register).not.toHaveBeenCalled();
  });
  it('refuses two different source authorities that reuse one pointer ID', async () => {
    const f = fixture();
    const items = [
      result.items[0]!,
      {
        record: { id: 'another-record' },
        pointer: { ...result.items[0]!.pointer, recordId: 'another-record' },
      },
    ];
    f.queryService.search.mockResolvedValue({ items });
    f.issuer.mockResolvedValue(
      items.map(({ pointer }) => ({
        pointerId: pointer.id,
        recordId: pointer.recordId,
        sourceRevision: pointer.sourceVersion,
        contentHash: pointer.contentHash,
      })),
    );
    const response = await f.tool.execute(
      { operation: 'search', query: 'evidence' },
      lease,
      undefined,
      () => lease.contextRevision,
    );
    expect(response).not.toHaveProperty('canonicalProvenance');
    expect(register).not.toHaveBeenCalled();
  });
  it('bounds UTF-8 canonical metadata and leaves the original returned source collection complete', async () => {
    const f = fixture();
    const items = Array.from({ length: 32 }, (_, i) => ({
      record: { id: 'record-' + i },
      pointer: {
        ...result.items[0]!.pointer,
        id: 'p' + i + '中'.repeat(180),
        recordId: 'record-' + i,
      },
    }));
    f.queryService.search.mockResolvedValue({ items });
    f.issuer.mockResolvedValue(
      items.map(({ pointer }) => ({
        pointerId: pointer.id,
        recordId: pointer.recordId,
        sourceRevision: pointer.sourceVersion,
        contentHash: pointer.contentHash,
      })),
    );
    const response = (await f.tool.execute(
      { operation: 'search', query: 'evidence' },
      lease,
      undefined,
      () => lease.contextRevision,
    )) as any;
    expect(response.items).toHaveLength(32);
    expect(response.canonicalProvenance.truncated).toBe(true);
    expect(response.canonicalProvenance.evidenceUris.length).toBeGreaterThan(0);
    expect(response.canonicalProvenance.evidenceUris.length).toBeLessThan(32);
    expect(
      new TextEncoder().encode(JSON.stringify(response.canonicalProvenance)).length,
    ).toBeLessThanOrEqual(16 * 1024);
    expect(
      citationRegistry
        .consumeToolGatewayContextCitationItems(lease.sessionId)
        .map((item) => item.source.uri),
    ).toEqual(response.canonicalProvenance.evidenceUris);
  });
  it('refuses unencodable proof IDs without publishing partial canonical handles', async () => {
    const f = fixture();
    const bad = {
      record: { id: 'bad-record' },
      pointer: {
        ...result.items[0]!.pointer,
        id: 'bad-' + String.fromCharCode(0xd800),
        recordId: 'bad-record',
      },
    };
    const items = [result.items[0]!, bad];
    f.queryService.search.mockResolvedValue({ items });
    f.issuer.mockResolvedValue(
      items.map(({ pointer }) => ({
        pointerId: pointer.id,
        recordId: pointer.recordId,
        sourceRevision: pointer.sourceVersion,
        contentHash: pointer.contentHash,
      })),
    );
    const response = await f.tool.execute(
      { operation: 'search', query: 'evidence' },
      lease,
      undefined,
      () => lease.contextRevision,
    );
    expect(response).not.toHaveProperty('canonicalProvenance');
    expect(register).not.toHaveBeenCalled();
  });
});

// Exact independent reviewer collision probes.
describe('independent Context C05 existing registry authority', () => {
  beforeEach(() => {
    register.mockClear();
    citationRegistry.clearToolGatewayContextCitationItems();
  });

  it('does not advertise a handle retained under a different registered account/project', async () => {
    citationRegistry.registerToolGatewayFallbackCitations(lease.sessionId, [tuple], {
      accountId: 'different-account',
      projectId: 'different-project',
    });
    const f = fixture();
    const response = (await f.tool.execute(
      { operation: 'search', query: 'evidence' },
      lease,
      undefined,
      () => lease.contextRevision,
    )) as { canonicalProvenance?: { evidenceUris: readonly string[] } };
    const registered = citationRegistry.consumeToolGatewayContextCitationItems(lease.sessionId);
    for (const uri of response.canonicalProvenance?.evidenceUris ?? []) {
      expect(
        registered.some(
          (item) =>
            item.source.uri === uri &&
            item.source.accountId === lease.accountId &&
            item.source.projectId === lease.projectId,
        ),
      ).toBe(true);
    }
  });

  it('does not advertise an evidence URI when an existing different-kind ID suppresses registration', async () => {
    citationRegistry.replaceToolGatewayContextCitationItems(lease.sessionId, [
      citationRegistry.contextCitationItem({
        id: tuple.pointerId,
        kind: 'source',
        label: 'Existing source handle',
        accountId: lease.accountId,
        projectId: lease.projectId,
        observedAt: 1000,
      }),
    ]);
    const f = fixture();
    const response = (await f.tool.execute(
      { operation: 'search', query: 'evidence' },
      lease,
      undefined,
      () => lease.contextRevision,
    )) as { canonicalProvenance?: { evidenceUris: readonly string[] } };
    const registered = citationRegistry.consumeToolGatewayContextCitationItems(lease.sessionId);
    for (const uri of response.canonicalProvenance?.evidenceUris ?? []) {
      expect(registered.some((item) => item.source.uri === uri)).toBe(true);
    }
  });
});

it('advertises only the acknowledged subset without replacing a foreign registry entry', async () => {
  citationRegistry.clearToolGatewayContextCitationItems();
  citationRegistry.registerToolGatewayFallbackCitations(lease.sessionId, [tuple], {
    accountId: 'foreign',
    projectId: 'foreign',
  });
  const f = fixture();
  const extra = {
    record: { id: 'second-record' },
    pointer: { ...result.items[0]!.pointer, id: 'second-pointer', recordId: 'second-record' },
  };
  const items = [result.items[0]!, extra];
  f.queryService.search.mockResolvedValue({ items });
  f.issuer.mockResolvedValue(
    items.map(({ pointer }) => ({
      pointerId: pointer.id,
      recordId: pointer.recordId,
      sourceRevision: pointer.sourceVersion,
      contentHash: pointer.contentHash,
    })),
  );
  const response = (await f.tool.execute(
    { operation: 'search', query: 'evidence' },
    lease,
    undefined,
    () => lease.contextRevision,
  )) as any;
  expect(response.canonicalProvenance).toEqual({
    evidenceUris: [citationRegistry.canonicalContextUri('evidence', 'second-pointer')],
    truncated: true,
  });
  const registered = citationRegistry.consumeToolGatewayContextCitationItems(lease.sessionId);
  expect(registered.find((item) => item.source.id === tuple.pointerId)?.source.accountId).toBe(
    'foreign',
  );
  expect(registered.find((item) => item.source.id === 'second-pointer')?.source.accountId).toBe(
    lease.accountId,
  );
});
