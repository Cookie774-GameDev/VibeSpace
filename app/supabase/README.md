# Jarvis Supabase

Cloud sync for Jarvis is **optional**. The desktop app is local-first and runs
fine with no Supabase project configured. Set the env vars below only when
you want cross-device sync.

## Env vars

Put these in `app/.env.local` (or whatever Vite env file you use):

```
VITE_SUPABASE_URL=https://<project-ref>.supabase.co
VITE_SUPABASE_ANON_KEY=eyJhbGciOi...
```

When either is missing, `getSupabaseClient()` returns `null` and the app
silently degrades to local-only mode.

## Apply the schema

The single migration file is `migrations/0001_initial.sql`. It mirrors the
Dexie schema in `app/src/lib/db/schema.ts` and turns on row-level security so
each user only sees their own rows.

### Option 1 - Supabase dashboard (easiest)

1. Open your project at https://supabase.com/dashboard.
2. Go to **SQL Editor** -> **New query**.
3. Paste the contents of `migrations/0001_initial.sql`.
4. Run.

The script is idempotent: re-running it on an already-migrated project is a
no-op.

### Option 2 - Supabase CLI

From the `app/` directory:

```sh
# one-time setup
npm i -g supabase
supabase login
supabase link --project-ref <your-project-ref>

# apply the migration
supabase db push
```

The CLI picks up migrations from `supabase/migrations/` automatically.

## Schema notes

- Primary keys are `text` and provided by the client. The desktop app
  generates prefixed nanoid strings (`tsk_*`, `cht_*`, `agt_*`, ...) and
  upserts them straight into Postgres. No `uuid` translation in either
  direction.
- `owner_id` defaults to `auth.uid()` on insert. Clients shouldn't set it
  manually unless they have a good reason.
- All timestamps are unix milliseconds stored as `bigint`. The optional
  `touch_updated_at` trigger backstops `updated_at` for direct SQL edits.
- Complex fields (`parts`, `reminders`, `source_refs`, `external_ids`,
  `capabilities`, `embedding`) are `jsonb`. Embeddings are `jsonb` for now
  so the schema works on a vanilla Supabase project; a follow-up migration
  will swap them for `vector` once pgvector is enabled.
- Foreign keys cascade on delete from workspace down (workspaces ->
  projects -> chats -> messages, plus tasks and memory_items hung off
  workspaces).

## RLS

Every table has a single `for all` policy:

```sql
using (owner_id = auth.uid())
with check (owner_id = auth.uid())
```

That covers select, insert, update, delete. Unauthenticated requests get
`null` from `auth.uid()` and see zero rows.

## Local sync queue

The desktop app writes outbound mutations to a Dexie-only `sync_queue`
table - it is **not** mirrored in Postgres. The sync loop in
`app/src/lib/sync.ts` drains the queue and `upsert`s into the tables above
when a Supabase client is configured.
