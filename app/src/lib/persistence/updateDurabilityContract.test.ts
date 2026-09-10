import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { IDBKeyRange, indexedDB } from 'fake-indexeddb';
import { createJarvisDb } from '@/lib/db';
import { DB_NAME, DB_VERSION, STORES } from '@/lib/db/schema';

const TEST_INDEXED_DB = { indexedDB, IDBKeyRange };
const openedNames: string[] = [];

afterEach(async () => {
  for (const name of openedNames.splice(0)) {
    const database = createJarvisDb(name, TEST_INDEXED_DB);
    await database.delete();
  }
  window.localStorage.clear();
});

describe('normal application update durability contract', () => {
  it('freezes the installed WebView authority and database identity', () => {
    const tauriConfig = JSON.parse(
      readFileSync(join(process.cwd(), 'src-tauri', 'tauri.conf.json'), 'utf8'),
    ) as { identifier?: unknown; productName?: unknown };

    expect(tauriConfig).toMatchObject({
      identifier: 'ai.jarvis.desktop',
      productName: 'VibeSpace',
    });
    expect(DB_NAME).toBe('jarvis-v1');
    expect(DB_VERSION).toBe(15);
    expect(Object.keys(STORES)).toHaveLength(55);
  });

  it('reopens the same current database without changing rows or local preferences', async () => {
    const name = `update-durability-${crypto.randomUUID()}`;
    openedNames.push(name);
    const beforeUpdate = createJarvisDb(name, TEST_INDEXED_DB);
    await beforeUpdate.open();
    await beforeUpdate.settings.put({
      key: 'durability-test-setting',
      value: { theme: 'warm', nested: ['preserve', 42] },
      updated_at: 123,
    });
    window.localStorage.setItem(
      'vibespace-update-durability-fixture',
      JSON.stringify({ layout: 'preserve-me' }),
    );
    beforeUpdate.close();

    const afterUpdate = createJarvisDb(name, TEST_INDEXED_DB);
    await afterUpdate.open();
    await expect(afterUpdate.settings.get('durability-test-setting')).resolves.toEqual({
      key: 'durability-test-setting',
      value: { theme: 'warm', nested: ['preserve', 42] },
      updated_at: 123,
    });
    expect(window.localStorage.getItem('vibespace-update-durability-fixture')).toBe(
      '{"layout":"preserve-me"}',
    );
    afterUpdate.close();
  });

  it('keeps the current schema additive and free of destructive upgrade hooks', () => {
    const databaseSource = readFileSync(
      join(process.cwd(), 'src', 'lib', 'db', 'database.ts'),
      'utf8',
    );
    for (let version = 1; version <= DB_VERSION; version++) {
      expect(databaseSource).toContain(`this.version(${version}).stores(STORES_V${version})`);
    }
    expect(databaseSource).not.toMatch(/\.upgrade\s*\(/u);
    expect(databaseSource).not.toMatch(/deleteDatabase|\.delete\s*\(\s*\)/u);
  });
});
