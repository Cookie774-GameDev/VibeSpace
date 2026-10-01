import { isTauri } from '@/lib/utils';
import { findCliExecutable } from './cliBridge';

export interface CodexRateLimitWindow {
  label: string;
  usedPercent: number;
  remainingPercent: number;
  windowDurationMins: number | null;
  resetsAt: number | null;
}

export interface CodexAccountUsageSnapshot {
  windows: CodexRateLimitWindow[];
  creditsRemaining: number | null;
  planType: string | null;
  tokens: number | null;
  updatedAt: number;
  source: 'codex-app-server';
  freshness: 'live';
}

interface NativeCodexSnapshot {
  rateLimits: unknown;
  tokenUsage: unknown;
  updatedAt: number;
  source: string;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function number(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function windowLabel(duration: number | null, fallback: string): string {
  if (duration === null) return fallback;
  if (duration >= 6 * 24 * 60 && duration <= 8 * 24 * 60) return 'Weekly';
  if (duration >= 23 * 60 && duration <= 25 * 60) return 'Daily';
  if (duration % 60 === 0) return `${duration / 60}h`;
  return `${duration}m`;
}

export function normalizeCodexAccountUsage(
  value: NativeCodexSnapshot,
): CodexAccountUsageSnapshot {
  const result = record(value.rateLimits) ?? {};
  const snapshot = record(result.rateLimits) ?? result;
  const windows: CodexRateLimitWindow[] = [];
  for (const [fallback, candidate] of [
    ['Primary', snapshot.primary],
    ['Secondary', snapshot.secondary],
  ] as const) {
    const item = record(candidate);
    if (!item) continue;
    const usedPercent = number(item.usedPercent);
    if (usedPercent === null) continue;
    const duration = number(item.windowDurationMins);
    windows.push({
      label: windowLabel(duration, fallback),
      usedPercent: Math.min(100, usedPercent),
      remainingPercent: Math.max(0, 100 - usedPercent),
      windowDurationMins: duration,
      resetsAt: number(item.resetsAt),
    });
  }
  const credits = record(snapshot.credits);
  const usage = record(value.tokenUsage);
  const summary = record(usage?.summary);
  return {
    windows,
    creditsRemaining: number(credits?.balance),
    planType: typeof snapshot.planType === 'string' ? snapshot.planType.slice(0, 80) : null,
    tokens: number(summary?.tokens),
    updatedAt: value.updatedAt,
    source: 'codex-app-server',
    freshness: 'live',
  };
}

export async function readCodexAccountUsage(): Promise<CodexAccountUsageSnapshot> {
  if (!isTauri) throw new Error('CODEX_USAGE_NATIVE_REQUIRED');
  const executable = await findCliExecutable('codex');
  if (!executable) throw new Error('CODEX_EXECUTABLE_NOT_FOUND');
  const { invoke } = await import('@tauri-apps/api/core');
  const raw = await invoke<NativeCodexSnapshot>('cli_bridge_codex_account_snapshot', {
    request: { executableId: executable.executableId, timeoutMs: 10_000 },
  });
  return normalizeCodexAccountUsage(raw);
}
