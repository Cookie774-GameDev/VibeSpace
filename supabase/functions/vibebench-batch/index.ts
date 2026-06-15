// @ts-nocheck
// vibebench-batch: enqueue a funded top-model VibeBench sweep (admin/cron).
// Reads suite manifest shape; records run + scores in vibebench_* tables.
// Full prompt execution reuses stack-complete keys — lightweight v1 records
// placeholder scores until the runner worker ships.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.46.2';
import { json } from '../_shared/voice.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const SUITE_VERSION = 'vibebench-2026.06';

const FRONTIER_TARGETS = [
  { provider: 'anthropic', model: 'claude-opus-4-8', label: 'Claude Opus 4.8' },
  { provider: 'openai', model: 'gpt-5.5', label: 'GPT-5.5' },
  { provider: 'openai', model: 'gpt-5.5-codex', label: 'GPT-5.5 Codex' },
  { provider: 'google', model: 'gemini-3.5-flash', label: 'Gemini 3.5 Flash' },
  { provider: 'google', model: 'gemini-3.1-pro', label: 'Gemini 3.1 Pro' },
  { provider: 'deepseek', model: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro' },
  { provider: 'xai', model: 'grok-4.3', label: 'Grok 4.3' },
  { provider: 'openrouter', model: 'qwen/qwen-3.7-max', label: 'Qwen 3.7 Max' },
  { provider: 'openrouter', model: 'moonshotai/kimi-k2.6', label: 'Kimi K2.6' },
  { provider: 'openrouter', model: 'perplexity/sonar', label: 'Perplexity Sonar' },
];

Deno.serve(async (req: Request): Promise<Response> => {
  const origin = req.headers.get('origin');
  if (req.method === 'OPTIONS') return new Response(null, { headers: json({}, 200, origin).headers });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405, origin);

  const cronSecret = Deno.env.get('VIBEBENCH_CRON_SECRET');
  const authHeader = req.headers.get('authorization') ?? '';
  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return json({ error: 'unauthorized' }, 401, origin);
  }

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: run, error: runErr } = await admin
    .from('vibebench_runs')
    .insert({ suite_version: SUITE_VERSION, status: 'running', git_commit: Deno.env.get('GIT_COMMIT') ?? null })
    .select('id')
    .single();

  if (runErr || !run) return json({ error: 'run_create_failed', detail: runErr?.message }, 500, origin);

  const runId = run.id as string;
  const scoreRows = FRONTIER_TARGETS.map((t, i) => ({
    run_id: runId,
    provider: t.provider,
    model: t.model,
    label: t.label,
    vibe_score: 0,
    category_scores: { pending: true, rank: i + 1 },
    cost_usd: 0,
  }));

  const { error: scoreErr } = await admin.from('vibebench_scores').insert(scoreRows);
  if (scoreErr) {
    await admin.from('vibebench_runs').update({ status: 'error', error_message: scoreErr.message }).eq('id', runId);
    return json({ error: 'scores_insert_failed' }, 500, origin);
  }

  await admin.from('vibebench_runs').update({ status: 'ok', finished_at: new Date().toISOString() }).eq('id', runId);

  return json({
    ok: true,
    run_id: runId,
    suite_version: SUITE_VERSION,
    models_queued: FRONTIER_TARGETS.length,
    note: 'v1 batch seeds leaderboard rows; wire full runner to populate scores.',
  }, 200, origin);
});
