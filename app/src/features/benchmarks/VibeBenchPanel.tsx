import * as React from 'react';
import { AlertTriangle } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { cn, formatCost, formatRelative } from '@/lib/utils';
import { fetchVibeBenchScores, type VibeBenchModelRow } from './vibeBenchData';

const CATEGORIES = [
  'HiveQuality',
  'TerminalAware',
  'ToolActions',
  'CodeCorrect',
  'Security',
  'Latency',
  'CostEfficiency',
] as const;

export function VibeBenchPanel() {
  const [rows, setRows] = React.useState<VibeBenchModelRow[]>([]);
  const [fromSample, setFromSample] = React.useState(true);
  const [suiteVersion, setSuiteVersion] = React.useState<string | null>(null);
  const [fetchedAt, setFetchedAt] = React.useState<number | null>(null);
  const [reason, setReason] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(true);

  React.useEffect(() => {
    let cancelled = false;
    void fetchVibeBenchScores().then((result) => {
      if (cancelled) return;
      setRows(result.rows);
      setFromSample(result.fromSample);
      setSuiteVersion(result.suiteVersion ?? null);
      setFetchedAt(result.rows[0]?.fetched_at ?? null);
      setReason(result.reason ?? null);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  if (loading) {
    return <p className="text-secondary text-muted-foreground">Loading VibeBench…</p>;
  }

  return (
    <div className="flex flex-col gap-4">
      {fromSample && (
        <div className="cozy-card !py-3 !px-4 flex items-start gap-3 border-warning/40">
          <AlertTriangle className="h-4 w-4 text-warning shrink-0 mt-0.5" />
          <div className="text-secondary text-foreground text-sm">
            Showing sample VibeBench data{suiteVersion ? ` (${suiteVersion})` : ''}.
            {reason && (
              <span className="text-muted-foreground block mt-1">{reason}</span>
            )}
            Run <code className="text-metadata">node scripts/vibebench-run.mjs</code> locally or deploy the cloud batch for live scores.
          </div>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2 text-metadata text-muted-foreground">
        {suiteVersion && <Badge variant="outline">{suiteVersion}</Badge>}
        {fetchedAt && <span>Run {formatRelative(fetchedAt)}</span>}
        {!fromSample && <span className="text-success">Live from cloud</span>}
      </div>

      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full text-body">
          <thead>
            <tr className="border-b border-border bg-elevated text-metadata text-muted-foreground uppercase tracking-wide">
              <th className="text-left px-3 py-2 font-medium">Model</th>
              <th className="text-right px-3 py-2 font-medium">VibeScore</th>
              {CATEGORIES.map((c) => (
                <th key={c} className="text-right px-2 py-2 font-medium hidden lg:table-cell">
                  {c.replace(/([A-Z])/g, ' $1').trim()}
                </th>
              ))}
              <th className="text-right px-3 py-2 font-medium">Cost</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={`${row.provider}-${row.model}`} className="border-b border-border/60 hover:bg-muted/30">
                <td className="px-3 py-2.5">
                  <div className="font-medium text-foreground">{row.label}</div>
                  <div className="text-metadata text-muted-foreground">{row.provider}</div>
                </td>
                <td className="px-3 py-2.5 text-right font-semibold tabular-nums text-accent">
                  {row.vibe_score.toFixed(1)}
                </td>
                {CATEGORIES.map((c) => (
                  <td key={c} className="px-2 py-2.5 text-right tabular-nums text-muted-foreground hidden lg:table-cell">
                    {row.category_scores[c] != null ? Math.round(row.category_scores[c]) : '—'}
                  </td>
                ))}
                <td className="px-3 py-2.5 text-right tabular-nums text-muted-foreground">
                  {row.cost_usd != null ? formatCost(row.cost_usd) : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="text-metadata text-muted-foreground max-w-2xl">
        VibeBench scores vibe-coding workflows — Vibe Hive quality, terminal awareness, tool actions, and code correctness — not generic chat ELO.
        Methodology: <code className="text-metadata">benchmarks/vibebench/README.md</code>
      </p>
    </div>
  );
}
