import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectId, WorkspaceId } from '@/types/common';
import {
  activateLocalWorkspaceRecovery,
  getLocalWorkspaceRecoveryRevision,
  readLocalWorkspaceRecoveryStorage,
  useAuthStore,
} from './auth';
const source = {
  localUserId: 'usr_local',
  workspaceId: 'wks_missing' as WorkspaceId,
  projectId: 'prj_orphan' as ProjectId,
};
const target = {
  ...source,
  workspaceId: 'wks_new' as WorkspaceId,
  projectId: 'prj_new' as ProjectId,
};
const options = useAuthStore.persist.getOptions();
const activate = (isCurrent = () => true) =>
  activateLocalWorkspaceRecovery({
    source,
    target,
    revision: getLocalWorkspaceRecoveryRevision(),
    isCurrent,
  });
beforeEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
  useAuthStore.persist.setOptions(options);
  useAuthStore.setState({ ...source, cloudSession: null, displayName: 'Preserved name' });
  localStorage.setItem('jarvis-terminal-transcripts', 'preserve me');
});
afterEach(() => {
  vi.restoreAllMocks();
  useAuthStore.persist.setOptions(options);
});
describe('narrow local workspace auth activation', () => {
  it('atomically writes scope without the generic storage adapter and preserves preferences', () => {
    const generic = vi.spyOn(options.storage!, 'setItem');
    activate();
    expect(useAuthStore.getState()).toMatchObject(target);
    expect(JSON.parse(localStorage.getItem('jarvis-auth')!).state).toMatchObject({
      ...target,
      displayName: 'Preserved name',
    });
    expect(generic).not.toHaveBeenCalled();
    expect(localStorage.getItem('jarvis-terminal-transcripts')).toBe('preserve me');
  });
  it('does not evict or activate memory on quota failure', () => {
    const set = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key, value) {
      if (key === 'jarvis-auth') throw new DOMException('quota', 'QuotaExceededError');
      return set.call(this, key, value);
    });
    expect(() => activate()).toThrow();
    expect(useAuthStore.getState()).toMatchObject(source);
    expect(localStorage.getItem('jarvis-terminal-transcripts')).toBe('preserve me');
  });
  it('allows an exact receipt-bound resume after write succeeds and verification read fails', () => {
    const get = Storage.prototype.getItem;
    let reads = 0;
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(function (this: Storage, key) {
      if (key === 'jarvis-auth' && ++reads === 3) throw new Error('transient read failure');
      return get.call(this, key);
    });
    expect(() => activate()).toThrow('transient read failure');
    expect(useAuthStore.getState()).toMatchObject(source);
    expect(JSON.parse(get.call(localStorage, 'jarvis-auth')!).state).toMatchObject(target);
    vi.restoreAllMocks();
    expect(() => readLocalWorkspaceRecoveryStorage(source)).toThrow();
    expect(() => activate()).not.toThrow();
    expect(useAuthStore.getState()).toMatchObject(target);
  });
  it.each(['version', 'partialize', 'storage', 'name'] as const)(
    'rejects changed persistence %s',
    (field) => {
      const changed = {
        version: 22,
        partialize: (state: unknown) => state,
        storage: { ...options.storage! },
        name: 'other-auth',
      };
      useAuthStore.persist.setOptions({ [field]: changed[field] });
      expect(() => activate()).toThrow('not ready');
    },
  );
  it.each(['missing', 'malformed', 'different-scope', 'wrong-version', 'unknown-field'])(
    'rejects %s saved profile without deleting it',
    (kind) => {
      if (kind === 'missing') localStorage.removeItem('jarvis-auth');
      else if (kind === 'malformed') localStorage.setItem('jarvis-auth', '{broken');
      else {
        const stored = JSON.parse(localStorage.getItem('jarvis-auth')!);
        if (kind === 'different-scope') stored.state.workspaceId = 'wks_someone_else';
        if (kind === 'wrong-version') stored.version = 999;
        if (kind === 'unknown-field') stored.state.unknown = 'preserve';
        localStorage.setItem('jarvis-auth', JSON.stringify(stored));
      }
      const before = localStorage.getItem('jarvis-auth');
      expect(() => activate()).toThrow();
      expect(localStorage.getItem('jarvis-auth')).toBe(before);
      expect(useAuthStore.getState()).toMatchObject(source);
    },
  );
  it.each([1, 2, 3])(
    'detects auth ABA during storage read %s and never restores older bytes',
    (readNumber) => {
      const get = Storage.prototype.getItem;
      let reads = 0;
      let changedBytes: string | null = null;
      vi.spyOn(Storage.prototype, 'getItem').mockImplementation(function (this: Storage, key) {
        const value = get.call(this, key);
        if (key === 'jarvis-auth' && ++reads === readNumber) {
          useAuthStore.setState({ projectId: 'prj_other' as ProjectId });
          useAuthStore.setState({ ...source, displayName: 'Newer preferences' });
          changedBytes = get.call(this, key);
        }
        return value;
      });
      expect(() => activate()).toThrow();
      expect(get.call(localStorage, 'jarvis-auth')).toBe(changedBytes);
      expect(useAuthStore.getState()).toMatchObject({
        ...source,
        displayName: 'Newer preferences',
      });
    },
  );
  it('detects synchronous lost activation without overwriting newer account state', () => {
    let changed = false;
    const stop = useAuthStore.subscribe((state) => {
      if (!changed && state.workspaceId === target.workspaceId) {
        changed = true;
        useAuthStore.setState({ projectId: 'prj_newer' as ProjectId });
      }
    });
    try {
      expect(() => activate()).toThrow('changed during activation');
      expect(useAuthStore.getState().projectId).toBe('prj_newer');
      expect(JSON.parse(localStorage.getItem('jarvis-auth')!).state.projectId).toBe('prj_newer');
    } finally {
      stop();
    }
  });
});

describe('independent persistence boundary negatives', () => {
  it.each([1, 2, 3])(
    'fails closed if persistence version changes during storage read %s',
    (read) => {
      const get = Storage.prototype.getItem;
      let count = 0;
      vi.spyOn(Storage.prototype, 'getItem').mockImplementation(function (this: Storage, key) {
        const raw = get.call(this, key);
        if (key === 'jarvis-auth' && ++count === read)
          useAuthStore.persist.setOptions({ version: 999 });
        return raw;
      });
      expect(() => activate()).toThrow();
      expect(useAuthStore.getState()).toMatchObject(source);
    },
  );
  it.each(['version', 'partialize', 'storage'] as const)(
    'invalidates %s ABA inside the final storage read',
    (field) => {
      const get = Storage.prototype.getItem;
      let count = 0;
      vi.spyOn(Storage.prototype, 'getItem').mockImplementation(function (this: Storage, key) {
        const raw = get.call(this, key);
        if (key === 'jarvis-auth' && ++count === 3) {
          if (field === 'version') useAuthStore.persist.setOptions({ version: 999 });
          if (field === 'partialize') useAuthStore.persist.setOptions({ partialize: (s) => s });
          if (field === 'storage')
            useAuthStore.persist.setOptions({ storage: { ...options.storage! } });
          useAuthStore.persist.setOptions(options);
        }
        return raw;
      });
      expect(() => activate()).toThrow();
      expect(useAuthStore.getState()).toMatchObject(source);
    },
  );
  it('never overwrites changed persisted bytes observed during its final pre-write read', () => {
    const get = Storage.prototype.getItem;
    let count = 0;
    let newer: string | undefined;
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(function (this: Storage, key) {
      if (key === 'jarvis-auth' && ++count === 2) {
        const changed = JSON.parse(get.call(this, key)!);
        changed.state.displayName = 'Newer concurrent disk state';
        newer = JSON.stringify(changed);
        this.setItem(key, newer!);
      }
      return get.call(this, key);
    });
    expect(() => activate()).toThrow();
    expect(get.call(localStorage, 'jarvis-auth')).toBe(newer);
    expect(useAuthStore.getState()).toMatchObject(source);
  });
});
