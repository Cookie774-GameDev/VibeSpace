import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const migrationUrl = new URL('../migrations/0041_desktop_presence.sql', import.meta.url);

test('desktop presence is owner-readable and never directly client-writable', async () => {
  const sql = await readFile(migrationUrl, 'utf8');

  assert.match(sql, /alter table public\.desktop_presence enable row level security/iu);
  assert.match(sql, /revoke all on table public\.desktop_presence from anon, authenticated/iu);
  assert.match(sql, /grant select on table public\.desktop_presence to authenticated/iu);
  assert.match(
    sql,
    /create policy desktop_presence_owner_select[\s\S]*?to authenticated[\s\S]*?auth\.uid\(\)\) = user_id/iu,
  );
  assert.doesNotMatch(sql, /grant (?:insert|update|delete|all).*desktop_presence.*authenticated/iu);
});

test('presence publishing derives ownership from auth and rejects revoked devices', async () => {
  const sql = await readFile(migrationUrl, 'utf8');

  assert.match(
    sql,
    /create or replace function public\.publish_desktop_presence[\s\S]*?security definer[\s\S]*?set search_path = ''/iu,
  );
  assert.match(sql, /v_user_id uuid := \(select auth\.uid\(\)\)/iu);
  assert.match(sql, /if v_user_id is null then[\s\S]*?raise exception 'authentication required'/iu);
  assert.match(sql, /p_expected_user_id uuid/iu);
  assert.match(
    sql,
    /if p_expected_user_id is null or v_user_id <> p_expected_user_id then[\s\S]*?raise exception 'account changed'/iu,
  );
  assert.ok(
    sql.indexOf('v_user_id <> p_expected_user_id') <
      sql.indexOf('insert into public.desktop_presence'),
    'expected-user validation must happen before presence writes',
  );
  assert.match(
    sql,
    /on conflict \(user_id, device_id\)[\s\S]*?where desktop_presence\.revoked_at is null/iu,
  );
  assert.match(sql, /revoke all on function public\.publish_desktop_presence[\s\S]*?from public/iu);
  assert.match(
    sql,
    /grant execute on function public\.publish_desktop_presence[\s\S]*?to authenticated/iu,
  );
});

test('offline cleanup rejects a changed account before updating presence', async () => {
  const sql = await readFile(migrationUrl, 'utf8');
  const functionStart = sql.indexOf(
    'create or replace function public.mark_desktop_presence_offline',
  );
  const functionEnd = sql.indexOf('$$;', functionStart);
  const body = sql.slice(functionStart, functionEnd);

  assert.match(body, /p_expected_user_id uuid/iu);
  assert.match(
    body,
    /if p_expected_user_id is null or v_user_id <> p_expected_user_id then[\s\S]*?raise exception 'account changed'/iu,
  );
  assert.ok(
    body.indexOf('v_user_id <> p_expected_user_id') <
      body.indexOf('update public.desktop_presence'),
    'expected-user validation must happen before offline updates',
  );
});

test('device revocation rejects a changed account before updating presence', async () => {
  const sql = await readFile(migrationUrl, 'utf8');
  const functionStart = sql.indexOf('create or replace function public.revoke_desktop_device');
  const functionEnd = sql.indexOf('$$;', functionStart);
  const body = sql.slice(functionStart, functionEnd);

  assert.match(body, /p_expected_user_id uuid/iu);
  assert.match(
    body,
    /if p_expected_user_id is null or v_user_id <> p_expected_user_id then[\s\S]*?raise exception 'account changed'/iu,
  );
  assert.ok(
    body.indexOf('v_user_id <> p_expected_user_id') <
      body.indexOf('update public.desktop_presence'),
    'expected-user validation must happen before revocation updates',
  );
  assert.match(
    sql,
    /grant execute on function public\.revoke_desktop_device\(uuid, text\) to authenticated/iu,
  );
});

test('presence metadata is bounded and has no raw content fields', async () => {
  const sql = await readFile(migrationUrl, 'utf8');

  for (const column of [
    'active_terminals',
    'active_chats',
    'active_agent_jobs',
    'provider_usage',
  ]) {
    assert.match(sql, new RegExp(`octet_length\\(\\(${column}::text\\)`, 'iu'));
  }
  assert.match(sql, /jsonb_array_length\(active_terminals\) <= 50/iu);
  assert.match(sql, /jsonb_array_length\(active_chats\) <= 50/iu);
  assert.match(sql, /jsonb_object_keys\(v_item\)/iu);
  assert.match(sql, /jsonb_each\(p_provider_usage\)/iu);
  assert.match(sql, /not \(v_item \? 'id'\)/iu);
  assert.match(sql, /not \(v_item \? 'name'\)/iu);
  assert.match(sql, /not \(v_item \? 'status'\)/iu);
  assert.match(sql, /v_key not in \('id', 'name', 'status'\)/iu);
  assert.doesNotMatch(
    sql,
    /\b(?:terminal_output|terminal_content|raw_command|chat_content|prompt_body|filesystem_path|api_key|secret)\b/iu,
  );
});
