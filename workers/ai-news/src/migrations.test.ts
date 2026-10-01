import fs from 'node:fs';

import { describe, expect, it } from 'vitest';

const migrationSql = (name: string): string =>
  fs.readFileSync(new URL(`../migrations/${name}`, import.meta.url), 'utf8');

async function applyMigrationSequence(): Promise<{ after0001: string[]; after0002: string[] }> {
  const init = migrationSql('0001_init.sql');
  const lease = migrationSql('0002_ingestion_lease.sql');
  try {
    const { DatabaseSync } = await import('node:sqlite');
    const database = new DatabaseSync(':memory:');
    try {
      database.exec(init);
      const after0001 = database
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
        .all()
        .map((row) => String(row.name));
      database.exec(lease);
      const after0002 = database
        .prepare("SELECT name FROM pragma_table_info('ingestion_leases') ORDER BY cid")
        .all()
        .map((row) => String(row.name));
      return { after0001, after0002 };
    } finally {
      database.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ERR_UNKNOWN_BUILTIN_MODULE') throw error;
    // Node 20 has no built-in SQLite. Keep the schema assertion runnable on
    // the repository's minimum Node version while newer runtimes execute DDL.
    const table = lease.match(
      /CREATE TABLE IF NOT EXISTS ingestion_leases\s*\(([\s\S]*?)\);/u,
    )?.[1];
    const after0002 = (table ?? '')
      .split(/\r?\n/u)
      .map((line) => line.trim().match(/^([a-z_][a-z0-9_]*)\s+/iu)?.[1])
      .filter((column): column is string => Boolean(column));
    return {
      after0001: /CREATE TABLE IF NOT EXISTS ingestion_leases/u.test(init)
        ? ['ingestion_leases']
        : [],
      after0002,
    };
  }
}

describe('AI News D1 migrations', () => {
  it('upgrades the deployed 0001 schema through 0002 without rewriting migration history', async () => {
    const sequence = await applyMigrationSequence();

    expect(sequence.after0001).not.toContain('ingestion_leases');
    expect(sequence.after0002).toEqual([
      'lock_key',
      'run_key',
      'fencing_token',
      'acquired_at',
      'lease_until',
      'last_completed_at',
      'last_completed_run_key',
      'last_status',
      'last_skipped_at',
      'skip_count',
    ]);
  });
});
