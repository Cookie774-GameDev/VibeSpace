import { describe, expect, it } from 'vitest';
import {
  accessAllowsTool,
  expireApproveAllForRun,
  formatPermissionPolicy,
  parsePermissionSlashArg,
  readPermissionAccess,
  setApproveAllForRun,
  setPermissionAccess,
} from './permissionAccessStore';

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();
  get length() {
    return this.values.size;
  }
  clear() {
    this.values.clear();
  }
  getItem(key: string) {
    return this.values.get(key) ?? null;
  }
  key(index: number) {
    return [...this.values.keys()][index] ?? null;
  }
  removeItem(key: string) {
    this.values.delete(key);
  }
  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
}

describe('permission access store', () => {
  it('defaults to Read Only and keeps access orthogonal to Approve All', () => {
    const storage = new MemoryStorage();
    expect(readPermissionAccess('chat-1', storage)).toEqual({ access: 'full', approveAll: false });
    expect(setPermissionAccess('chat-1', 'full', storage)).toEqual({
      access: 'full',
      approveAll: false,
    });
    expect(setApproveAllForRun('chat-1', true, storage)).toEqual({
      access: 'full',
      approveAll: true,
    });
    expect(expireApproveAllForRun('chat-1', storage).approveAll).toBe(false);
    expect(readPermissionAccess('chat-1', storage).access).toBe('full');
  });

  it('parses extra /permissions options without collapsing them into Ask/Plan/Agent', () => {
    expect(parsePermissionSlashArg('agent')).toEqual({ kind: 'mode', value: 'agent' });
    expect(parsePermissionSlashArg('read only')).toEqual({ kind: 'access', value: 'read' });
    expect(parsePermissionSlashArg('write')).toEqual({ kind: 'access', value: 'write' });
    expect(parsePermissionSlashArg('full')).toEqual({ kind: 'access', value: 'full' });
    expect(parsePermissionSlashArg('approve-all')).toEqual({ kind: 'approve-all', value: true });
    expect(parsePermissionSlashArg('approve-all off')).toEqual({ kind: 'approve-all', value: false });
    expect(parsePermissionSlashArg('status')).toEqual({ kind: 'status' });
    expect(parsePermissionSlashArg('nope')).toBeUndefined();
  });

  it('lets Write create/edit but not shell or browser mutation', () => {
    expect(accessAllowsTool('read', 'context.read', false)).toBe(true);
    expect(accessAllowsTool('read', 'profile.allAboutMe.update', true)).toBe(false);
    expect(accessAllowsTool('write', 'profile.allAboutMe.update', true)).toBe(true);
    expect(accessAllowsTool('write', 'terminal.write', true)).toBe(false);
    expect(accessAllowsTool('full', 'terminal.write', true)).toBe(true);
    expect(
      formatPermissionPolicy({ mode: 'agent', access: 'full', approveAll: true }),
    ).toContain('Approve All for This Run: ON');
  });
});
