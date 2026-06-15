/**
 * VibeBench leaderboard data — proprietary vibe-coding scores.
 * Loads from Supabase when cloud sync is on; falls back to bundled sample.
 */
import { getSupabaseClient } from '@/lib/supabase';

export interface VibeBenchModelRow {
  provider: string;
  model: string;
  label: string;
  vibe_score: number;
  category_scores: Record<string, number>;
  cost_usd?: number;
  run_id: string;
  suite_version: string;
  fetched_at: number;
}

export interface VibeBenchFetchResult {
  rows: VibeBenchModelRow[];
  fromSample: boolean;
  runId?: string;
  suiteVersion?: string;
  reason?: string;
}

import samplePayload from './vibeBenchSample.json';

function rowsFromPayload(payload: {
  run_id: string;
  suite_version: string;
  started_at: string;
  models: Array<{
    provider: string;
    model: string;
    label: string;
    vibe_score: number;
    category_scores: Record<string, number>;
    cost_usd?: number;
  }>;
}): VibeBenchModelRow[] {
  const ts = Date.parse(payload.started_at) || Date.now();
  return payload.models.map((m) => ({
    provider: m.provider,
    model: m.model,
    label: m.label,
    vibe_score: m.vibe_score,
    category_scores: m.category_scores,
    cost_usd: m.cost_usd,
    run_id: payload.run_id,
    suite_version: payload.suite_version,
    fetched_at: ts,
  }));
}

export async function fetchVibeBenchScores(): Promise<VibeBenchFetchResult> {
  const client = getSupabaseClient();
  if (client) {
    try {
      const { data: runs } = await client
        .from('vibebench_runs')
        .select('id, suite_version, started_at')
        .eq('status', 'ok')
        .order('started_at', { ascending: false })
        .limit(1);

      const run = runs?.[0];
      if (run) {
        const { data: scores } = await client
          .from('vibebench_scores')
          .select('provider, model, label, vibe_score, category_scores, cost_usd, run_id')
          .eq('run_id', run.id)
          .order('vibe_score', { ascending: false });

        if (scores?.length) {
          const fetchedAt = Date.parse(run.started_at as string) || Date.now();
          return {
            rows: scores.map((s) => ({
              provider: s.provider,
              model: s.model,
              label: s.label ?? s.model,
              vibe_score: Number(s.vibe_score),
              category_scores: (s.category_scores as Record<string, number>) ?? {},
              cost_usd: s.cost_usd != null ? Number(s.cost_usd) : undefined,
              run_id: s.run_id,
              suite_version: run.suite_version as string,
              fetched_at: fetchedAt,
            })),
            fromSample: false,
            runId: run.id as string,
            suiteVersion: run.suite_version as string,
          };
        }
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      return {
        rows: rowsFromPayload(samplePayload),
        fromSample: true,
        reason: `Cloud fetch failed: ${reason}`,
      };
    }
  }

  return {
    rows: rowsFromPayload(samplePayload),
    fromSample: true,
    runId: samplePayload.run_id,
    suiteVersion: samplePayload.suite_version,
    reason: client ? undefined : 'Cloud sync not configured',
  };
}
