import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

const migrationPath = join(
  import.meta.dirname,
  '..',
  'migrations',
  '0038_backend_advisor_hardening.sql',
);

test('0038 removes the advisor findings without weakening client write isolation', () => {
  const sql = readFileSync(migrationPath, 'utf8');

  assert.match(
    sql,
    /alter function public\.set_phone_pin\(uuid, text\)\s+security invoker/i,
    'the PIN RPC must execute with the authenticated caller permissions and RLS',
  );
  assert.match(
    sql,
    /create policy deepgram_promo_plan_limits_read[\s\S]*to authenticated[\s\S]*using \(true\)/i,
    'the public plan catalog must scope access by role instead of evaluating auth.role per row',
  );

  for (const table of [
    'deepgram_promo_pool',
    'deepgram_promo_usage',
    'hive_credit_usage',
    'hive_usage_events',
    'sms_usage',
  ]) {
    assert.match(
      sql,
      new RegExp(
        `revoke insert, update, delete, truncate on table public\\.${table}\\s+from anon, authenticated`,
        'i',
      ),
      `${table} must remain server-write-only after redundant policies are removed`,
    );
  }

  for (const policy of [
    'deepgram_promo_pool_no_client_write',
    'deepgram_promo_usage_no_client_write',
    'hive_credit_usage_no_client_write',
    'hive_usage_events_no_client_write',
    'sms_usage_no_client_write',
  ]) {
    assert.match(
      sql,
      new RegExp(`drop policy if exists ${policy}`, 'i'),
      `${policy} must stop participating in SELECT policy evaluation`,
    );
  }

  assert.match(
    sql,
    /create index if not exists admin_credit_grants_admin_idx\s+on public\.admin_credit_grants \(admin_user_id, created_at desc\)/i,
    'admin grant attribution needs a covering foreign-key index',
  );
  assert.doesNotMatch(sql, /\bar_/i, 'VibeSpace migration must never touch AccessRevamp objects');
  assert.doesNotMatch(
    sql,
    /(?:^|;)\s*(?:truncate|drop table|delete from)\b/im,
    'advisor hardening must not delete application data or tables',
  );
});
