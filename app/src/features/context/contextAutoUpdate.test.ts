import { describe, expect, it, vi } from 'vitest';
import {
  contextAutoDelta,
  contextAutoUpdateKey,
  createContextAutoUpdater,
  type ContextAutoUpdatePorts,
  type ContextAutoUpdateSetting,
} from './contextAutoUpdate';
import type { ContextMapRecord } from './tree';
import type { SiyuanSafeIndex } from './siyuan/siyuanSafeIndex';

function fixture() {
  let map: ContextMapRecord = {
    id: 'map',
    projectId: 'project',
    rootDir: 'C:/source',
    name: 'Map',
    status: 'active',
    createdAt: 1,
    updatedAt: 2,
    tree: {
      version: 1,
      projectId: 'project',
      rootDir: 'C:/source',
      generatedAt: 2,
      model: 'siyuan',
      fileCount: 1,
      totalBytes: 3,
      summary: '',
      nodes: [
        {
          id: 'path:old.txt',
          title: 'old.txt',
          path: 'old.txt',
          kind: 'file',
          summary: '',
          sizeBytes: 3,
          modifiedAt: 2,
        },
      ],
    },
  };
  let setting: ContextAutoUpdateSetting = {
    kind: 'context-auto-update-v1',
    accountId: 'account',
    workspaceId: 'workspace',
    projectId: 'project',
    mapId: 'map',
    enabled: true,
    consentRevision: 1,
    fingerprint: 'allowed',
    indexIdentityVersion: 1,
    baseline: [{ id: 'path:old.txt', path: 'old.txt', kind: 'file', title: 'old.txt', size: 3, modified: 2 }],
  };
  let now = 100;
  let active = true;
  const index: SiyuanSafeIndex = {
    entries: [
      {
        nodeId: 'path:new.txt',
        parentNodeId: null,
        title: 'new.txt',
        kind: 'file',
        relativePath: 'new.txt',
        sourcePointer: 'C:/source/new.txt',
        summary: null,
        sizeBytes: 4,
        modifiedAt: 3,
      },
    ],
    excluded: 0,
    unreadable: 0,
    summarized: 0,
  };
  const transaction = { commit: vi.fn(async () => {}), abort: vi.fn(async () => {}) };
  const ports: ContextAutoUpdatePorts = {
    readSetting: vi.fn(async () => setting),
    readMap: vi.fn(async () => map),
    fingerprint: () => 'allowed',
    active: () => active,
    now: () => now,
    scan: vi.fn(async () => index),
    stage: vi.fn(async () => transaction),
    sync: vi.fn(async (record) => record.tree),
    saveTree: vi.fn(async (record, tree) => {
      if (record.updatedAt !== map.updatedAt) throw new Error('revision changed');
      map = { ...map, tree, updatedAt: map.updatedAt + 1 };
      return map;
    }),
    saveSetting: vi.fn(async (value) => {
      setting = value;
    }),
  };
  const updater = createContextAutoUpdater(ports, setting);
  const controller = new AbortController();
  return {
    ports,
    index,
    transaction,
    controller,
    updater,
    setting,
    map,
    advance: () => {
      now += 2_000;
    },
    disable: () => {
      setting = { ...setting, enabled: false };
    },
    changeAccount: () => {
      active = false;
    },
    changeRevision: () => {
      map = { ...map, updatedAt: map.updatedAt + 1 };
    },
  };
}
describe('opt-in saved-file updates', () => {
  it('keeps persisted scope keys stable across property ordering and separates accounts', () => {
    const scope = { accountId: 'account', workspaceId: 'workspace', projectId: 'project', mapId: 'map' };
    expect(contextAutoUpdateKey(scope)).toBe(contextAutoUpdateKey({ mapId: 'map', projectId: 'project', workspaceId: 'workspace', accountId: 'account' }));
    expect(contextAutoUpdateKey(scope)).not.toBe(contextAutoUpdateKey({ ...scope, accountId: 'foreign' }));
  });
  it('batches observations, stages add/rename/delete together, then commits once', async () => {
    const f = fixture();
    expect(await f.updater.tick(f.controller.signal)).toBe('waiting');
    expect(f.ports.stage).not.toHaveBeenCalled();
    f.advance();
    expect(await f.updater.tick(f.controller.signal)).toBe('updated');
    expect(f.ports.stage).toHaveBeenCalledWith(
      expect.anything(),
      ['map:path:new.txt'],
      ['map:path:old.txt'],
      f.controller.signal,
      undefined,
    );
    expect(f.transaction.commit).toHaveBeenCalledTimes(1);
    expect(f.transaction.abort).not.toHaveBeenCalled();
    expect(f.ports.saveSetting).toHaveBeenCalledWith(
      expect.objectContaining({ lastSuccessAt: 2_100, baselineMapRevision: 3 }),
    );
  });
  it('does no body/index/model work for an unchanged source', async () => {
    const f = fixture();
    f.index.entries[0] = {
      ...f.index.entries[0]!,
      nodeId: 'path:old.txt',
      title: 'old.txt',
      relativePath: 'old.txt',
      sizeBytes: 3,
      modifiedAt: 2,
    };
    expect(await f.updater.tick(f.controller.signal)).toBe('idle');
    expect(f.ports.stage).not.toHaveBeenCalled();
    expect(f.ports.sync).not.toHaveBeenCalled();
  });
  it.each(['disable', 'account', 'revision', 'abort'] as const)(
    'aborts publication on %s while preserving the old search index',
    async (change) => {
      const f = fixture();
      await f.updater.tick(f.controller.signal);
      f.advance();
      f.ports.sync = vi.fn(async (record) => {
        if (change === 'disable') f.disable();
        if (change === 'account') f.changeAccount();
        if (change === 'revision') f.changeRevision();
        if (change === 'abort') f.controller.abort();
        return record.tree;
      });
      await expect(f.updater.tick(f.controller.signal)).rejects.toThrow('scope_changed');
      expect(f.transaction.commit).not.toHaveBeenCalled();
      expect(f.transaction.abort).toHaveBeenCalledOnce();
      expect(f.ports.saveTree).not.toHaveBeenCalled();
    },
  );
  it('never removes documents based on an unreadable partial discovery', async () => {
    const f = fixture();
    f.index.unreadable = 1;
    await expect(f.updater.tick(f.controller.signal)).rejects.toThrow('discovery_incomplete');
    expect(f.ports.stage).not.toHaveBeenCalled();
  });
  it('rolls back only its own guarded tree if the final native commit fails', async () => {
    const f = fixture();
    await f.updater.tick(f.controller.signal);
    f.advance();
    f.transaction.commit.mockRejectedValueOnce(new Error('disk unavailable'));
    await expect(f.updater.tick(f.controller.signal)).rejects.toThrow('disk unavailable');
    expect(f.transaction.abort).toHaveBeenCalledOnce();
    expect(f.ports.saveTree).toHaveBeenCalledTimes(2);
    expect(f.ports.saveSetting).not.toHaveBeenCalled();
  });
  it('coalesces concurrent polls and restores opt-in baseline after restart', async () => {
    const f = fixture();
    const first = f.updater.tick(f.controller.signal);
    expect(f.updater.tick(f.controller.signal)).toBe(first);
    await first;
    f.advance();
    await f.updater.tick(f.controller.signal);
    f.ports.sync = vi.fn(async (_record: ContextMapRecord, index: SiyuanSafeIndex) => ({
      ...f.map.tree,
      nodes: index.entries.map((entry) => ({
        id: entry.nodeId,
        title: entry.title,
        kind: entry.kind,
        path: entry.relativePath!,
        summary: '',
        sizeBytes: entry.sizeBytes!,
        modifiedAt: entry.modifiedAt!,
      })),
    }));
    const resumed = createContextAutoUpdater(f.ports);
    expect(await resumed.tick(f.controller.signal)).toBe('idle');
  });
  it('uses file identity, size and timestamp for edit/add/delete metadata deltas', () => {
    const old = [{ id: 'a', kind: 'file', path: 'a', title: 'a', size: 3, modified: 1 }];
    expect(contextAutoDelta(old, [{ ...old[0]!, modified: 2 }])).toEqual({
      changed: ['a'],
      deleted: [],
    });
    expect(contextAutoDelta(old, [])).toEqual({ changed: [], deleted: ['a'] });
  });
});


describe('legacy index identity migration guards', () => {
  it.each(['disable', 'account', 'revision', 'abort'] as const)('does not publish a migration marker after %s revocation', async change => {
    const f = fixture();
    delete f.setting.indexIdentityVersion;
    await f.updater.tick(f.controller.signal); f.advance();
    f.ports.sync = vi.fn(async record => {
      if (change === 'disable') f.disable();
      if (change === 'account') f.changeAccount();
      if (change === 'revision') f.changeRevision();
      if (change === 'abort') f.controller.abort();
      return record.tree;
    });
    await expect(f.updater.tick(f.controller.signal)).rejects.toThrow('scope_changed');
    expect(f.transaction.commit).not.toHaveBeenCalled();
    expect(f.transaction.abort).toHaveBeenCalledOnce();
    expect(f.ports.saveSetting).not.toHaveBeenCalled();
  });
  it('cannot authorize retention cleanup from a partial discovery', async () => {
    const f = fixture(); delete f.setting.indexIdentityVersion; f.index.unreadable = 1;
    await expect(f.updater.tick(f.controller.signal)).rejects.toThrow('discovery_incomplete');
    expect(f.ports.stage).not.toHaveBeenCalled();
  });
});


describe('unchanged-source failure status recovery', () => {
  it('requests status recovery only after a complete matching scan without advancing its index baseline', async () => {
    const f = fixture();
    f.setting.status = 'failed';
    f.setting.error = 'context_auto_update_scope_changed';
    f.setting.lastSuccessAt = 50;
    f.index.entries[0] = { ...f.index.entries[0]!, nodeId: 'path:old.txt', title: 'old.txt', relativePath: 'old.txt', sizeBytes: 3, modifiedAt: 2 };
    expect(await f.updater.tick(f.controller.signal)).toBe('idle');
    expect(f.ports.saveSetting).toHaveBeenCalledExactlyOnceWith(
      { ...f.setting, status: 'watching', error: undefined },
      { observed: f.setting, map: f.map, signal: f.controller.signal },
    );
    expect(f.ports.stage).not.toHaveBeenCalled();
  });
  it('does not clear failure after an unreadable discovery', async () => {
    const f = fixture();
    f.setting.status = 'failed';
    f.setting.error = 'context_auto_update_scope_changed';
    f.index.unreadable = 1;
    await expect(f.updater.tick(f.controller.signal)).rejects.toThrow('discovery_incomplete');
    expect(f.ports.saveSetting).not.toHaveBeenCalled();
  });
  it('C08 excludes another updater instance before either can enter a held scan', async () => {
    const f = fixture();
    const other = createContextAutoUpdater(f.ports);
    await f.updater.tick(f.controller.signal);
    await other.tick(f.controller.signal);
    f.advance();
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const scan = f.ports.scan;
    f.ports.scan = vi.fn(async (map: ContextMapRecord, signal: AbortSignal) => { await held; return scan(map, signal); });
    const first = f.updater.tick(f.controller.signal);
    await vi.waitFor(() => expect(f.ports.scan).toHaveBeenCalledTimes(1));
    const second = other.tick(f.controller.signal).then(value => ({ value }), error => ({ error: String(error) }));
    await new Promise(resolve => setTimeout(resolve, 10));
    const admitted = vi.mocked(f.ports.scan).mock.calls.length;
    release();
    await first;
    const result = await second;
    console.log('C08_OWNER_JOIN', JSON.stringify({ admitted, result }));
    expect(admitted).toBe(1);
    expect(result).toEqual({ value: 'idle' });
  });

});


describe('C08 explicit manual refresh', () => {
  it.each(['absent', 'disabled'] as const)('refreshes with %s automatic consent without reading or writing that setting', async consent => {
    const f = fixture();
    if (consent === 'disabled') f.disable();
    f.ports.readSetting = vi.fn(async () => consent === 'absent' ? null : { ...f.setting, enabled: false });
    expect(await f.updater.refresh(f.controller.signal)).toBe('updated');
    expect(f.ports.readSetting).not.toHaveBeenCalled();
    expect(f.ports.saveSetting).not.toHaveBeenCalled();
    expect(f.ports.stage).toHaveBeenCalledWith(expect.anything(), ['map:path:new.txt'], [], f.controller.signal, { reconcileMembership: true });
    expect(f.transaction.commit).toHaveBeenCalledOnce();
    expect(f.ports.saveTree).toHaveBeenCalledWith(f.map, expect.anything(), f.controller.signal, expect.any(Function));
  });

  it.each(['abort', 'account', 'revision', 'root', 'missing', 'wrong-map', 'wrong-project'] as const)('refuses %s drift while a manual scan is held', async change => {
    const f = fixture();
    f.ports.scan = vi.fn(async () => {
      if (change === 'abort') f.controller.abort();
      if (change === 'account') f.changeAccount();
      if (change === 'revision') f.changeRevision();
      if (change === 'root') f.ports.fingerprint = () => 'changed';
      if (change === 'missing') f.ports.readMap = async () => null;
      if (change === 'wrong-map') f.ports.readMap = async () => ({ ...f.map, id: 'foreign' });
      if (change === 'wrong-project') f.ports.readMap = async () => ({ ...f.map, projectId: 'foreign' });
      return f.index;
    });
    await expect(f.updater.refresh(f.controller.signal)).rejects.toThrow('scope_changed');
    expect(f.ports.stage).not.toHaveBeenCalled();
    expect(f.ports.saveTree).not.toHaveBeenCalled();
    expect(f.ports.saveSetting).not.toHaveBeenCalled();
  });

  it.each(['scan', 'sync', 'commit'] as const)('reports a manual %s failure and does not publish success', async failure => {
    const f = fixture();
    if (failure === 'scan') f.index.unreadable = 1;
    if (failure === 'sync') f.ports.sync = vi.fn(async () => { throw new Error('sync failed'); });
    if (failure === 'commit') f.transaction.commit.mockRejectedValueOnce(new Error('commit failed'));
    await expect(f.updater.refresh(f.controller.signal)).rejects.toThrow();
    expect(f.ports.saveSetting).not.toHaveBeenCalled();
    if (failure !== 'scan') expect(f.transaction.abort).toHaveBeenCalledOnce();
  });

  it.each(['manual', 'automatic'] as const)('excludes a %s instance until the manual owner finishes compensation', async mode => {
    const f = fixture();
    const other = createContextAutoUpdater(f.ports, f.setting);
    let release!: () => void;
    const hold = new Promise<void>(resolve => { release = resolve; });
    f.transaction.abort.mockImplementationOnce(async () => { await hold; });
    f.ports.sync = vi.fn(async () => { throw new Error('held compensation'); });
    const first = f.updater.refresh(f.controller.signal).catch(error => error);
    await vi.waitFor(() => expect(f.transaction.abort).toHaveBeenCalledOnce());
    if (mode === 'manual') await expect(other.refresh(f.controller.signal)).rejects.toThrow('busy');
    else expect(await other.tick(f.controller.signal)).toBe('idle');
    expect(f.ports.scan).toHaveBeenCalledOnce();
    release();
    expect(await first).toBeInstanceOf(Error);
    f.ports.sync = vi.fn(async map => map.tree);
    expect(await other.refresh(f.controller.signal)).toBe('updated');
  });
});
