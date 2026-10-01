import { afterEach, describe, expect, it } from 'vitest';
import {
  formatRlmStatus,
  markRlmIndexRefreshed,
  parseRlmSlashArgument,
  recordRlmRoute,
  resolveRlmEnabled,
  setChatRlmEnabled,
} from './rlmPreferenceStore';

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

describe('RLM preference store', () => {
  const storage = new MemoryStorage();

  afterEach(() => storage.clear());

  it('defaults ON at the user layer and lets a chat override win', () => {
    expect(resolveRlmEnabled({ chatId: 'chat-1', storage })).toMatchObject({
      enabled: true,
      source: 'user',
    });
    expect(setChatRlmEnabled('chat-1', false, storage)).toMatchObject({
      enabled: false,
      source: 'chat',
    });
    expect(resolveRlmEnabled({ chatId: 'chat-1', workspaceId: 'ws-1', storage })).toMatchObject({
      enabled: false,
      source: 'chat',
    });
    expect(resolveRlmEnabled({ chatId: 'chat-2', storage }).enabled).toBe(true);
  });

  it('parses /rlm arguments and formats status without inventing a route', () => {
    expect(parseRlmSlashArgument('')).toBeUndefined();
    expect(parseRlmSlashArgument('on')).toBe('on');
    expect(parseRlmSlashArgument('OFF')).toBe('off');
    expect(parseRlmSlashArgument('status')).toBe('status');
    expect(parseRlmSlashArgument('refresh')).toBe('refresh');
    expect(parseRlmSlashArgument('trace')).toBe('trace');
    expect(parseRlmSlashArgument('nope')).toBeUndefined();
    const refreshed = markRlmIndexRefreshed(storage);
    recordRlmRoute('retrieval', 'ok', storage);
    const status = formatRlmStatus(resolveRlmEnabled({ storage }), { projectId: 'proj-1' });
    expect(status).toContain('RLM ON (user default)');
    expect(status).toContain('Scope: proj-1');
    expect(status).toContain('Route: retrieval');
    expect(status).toContain(new Date(refreshed).toISOString());
    expect(status).toContain('Last run: ok');
  });
});
