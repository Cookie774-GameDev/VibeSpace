import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { getMonthlyAllProviderUsage } from '@/lib/usage/usageSummary';
import type { ProviderId } from '@/types/common';
import { useMilestonesStore } from './milestonesStore';
import { useToolRunsStore } from './toolRunsStore';

export type ModelUsageRow = {
  providerName: string;
  modelName: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  estimatedCostUsd: number;
};

export type WorkspaceUsageAnalytics = {
  totalInputTokens: number;
  totalOutputTokens: number;
  totalTokens: number;
  estimatedTotalCostUsd: number;
  byModel: ModelUsageRow[];
  foregroundActiveMs: number;
  backgroundRunningMs: number;
  completedMilestones: number;
  toolRunCount: number;
  lastForegroundAt: number | null;
  sessionStartedAt: number;
};

interface AnalyticsState extends WorkspaceUsageAnalytics {
  tickForeground: () => void;
  tickBackground: () => void;
  refreshTokenRollup: () => Promise<void>;
  snapshot: () => WorkspaceUsageAnalytics;
}

const defaults: WorkspaceUsageAnalytics = {
  totalInputTokens: 0,
  totalOutputTokens: 0,
  totalTokens: 0,
  estimatedTotalCostUsd: 0,
  byModel: [],
  foregroundActiveMs: 0,
  backgroundRunningMs: 0,
  completedMilestones: 0,
  toolRunCount: 0,
  lastForegroundAt: null,
  sessionStartedAt: Date.now(),
};

let lastTickAt = Date.now();
let ticking = false;

const TRACKED_PROVIDERS: ProviderId[] = [
  'openai',
  'google',
  'anthropic',
  'groq',
  'openrouter',
  'mock',
  'ollama',
  'local',
];

async function loadRollupByModel(): Promise<ModelUsageRow[]> {
  const usage = await getMonthlyAllProviderUsage(TRACKED_PROVIDERS);
  const rows: ModelUsageRow[] = [];
  for (const [provider, bucket] of Object.entries(usage)) {
    if (!bucket || (bucket.inputTokens === 0 && bucket.outputTokens === 0)) continue;
    rows.push({
      providerName: provider,
      modelName: provider,
      inputTokens: bucket.inputTokens,
      outputTokens: bucket.outputTokens,
      totalTokens: bucket.inputTokens + bucket.outputTokens,
      estimatedCostUsd: bucket.costUsd,
    });
  }
  rows.sort((a, b) => b.totalTokens - a.totalTokens);
  return rows;
}

export const useWorkspaceAnalyticsStore = create<AnalyticsState>()(
  persist(
    (set, get) => ({
      ...defaults,
      tickForeground: () => {
        const now = Date.now();
        const delta = now - lastTickAt;
        lastTickAt = now;
        if (delta <= 0 || delta > 60_000) return;
        set((s) => ({
          foregroundActiveMs: s.foregroundActiveMs + delta,
          lastForegroundAt: now,
        }));
      },
      tickBackground: () => {
        const now = Date.now();
        const delta = now - lastTickAt;
        lastTickAt = now;
        if (delta <= 0 || delta > 60_000) return;
        set((s) => ({ backgroundRunningMs: s.backgroundRunningMs + delta }));
      },
      refreshTokenRollup: async () => {
        const byModel = await loadRollupByModel();
        const totalInputTokens = byModel.reduce((n, r) => n + r.inputTokens, 0);
        const totalOutputTokens = byModel.reduce((n, r) => n + r.outputTokens, 0);
        const estimatedTotalCostUsd = byModel.reduce((n, r) => n + r.estimatedCostUsd, 0);
        set({
          byModel,
          totalInputTokens,
          totalOutputTokens,
          totalTokens: totalInputTokens + totalOutputTokens,
          estimatedTotalCostUsd,
          completedMilestones: useMilestonesStore.getState().items.filter((i) => i.status === 'done').length,
          toolRunCount: useToolRunsStore.getState().runs.length,
        });
      },
      snapshot: () => {
        const s = get();
        return {
          totalInputTokens: s.totalInputTokens,
          totalOutputTokens: s.totalOutputTokens,
          totalTokens: s.totalTokens,
          estimatedTotalCostUsd: s.estimatedTotalCostUsd,
          byModel: s.byModel,
          foregroundActiveMs: s.foregroundActiveMs,
          backgroundRunningMs: s.backgroundRunningMs,
          completedMilestones: s.completedMilestones,
          toolRunCount: s.toolRunCount,
          lastForegroundAt: s.lastForegroundAt,
          sessionStartedAt: s.sessionStartedAt,
        };
      },
    }),
    {
      name: 'jarvis-workspace-analytics-v1',
      partialize: (s) => ({
        foregroundActiveMs: s.foregroundActiveMs,
        backgroundRunningMs: s.backgroundRunningMs,
        sessionStartedAt: s.sessionStartedAt,
        lastForegroundAt: s.lastForegroundAt,
      }),
    },
  ),
);

/** Mount once at app root — tracks foreground vs background time. */
export function startWorkspaceAnalyticsClock(): () => void {
  if (ticking || typeof window === 'undefined') return () => {};
  ticking = true;
  lastTickAt = Date.now();

  const onVisible = () => {
    lastTickAt = Date.now();
    if (document.visibilityState === 'visible') {
      useWorkspaceAnalyticsStore.getState().tickForeground();
    }
  };

  const interval = window.setInterval(() => {
    if (document.visibilityState === 'visible') {
      useWorkspaceAnalyticsStore.getState().tickForeground();
    } else {
      useWorkspaceAnalyticsStore.getState().tickBackground();
    }
    void useWorkspaceAnalyticsStore.getState().refreshTokenRollup();
  }, 15_000);

  document.addEventListener('visibilitychange', onVisible);
  window.addEventListener('focus', onVisible);
  const onBlur = () => {
    useWorkspaceAnalyticsStore.getState().tickBackground();
    lastTickAt = Date.now();
  };
  window.addEventListener('blur', onBlur);

  void useWorkspaceAnalyticsStore.getState().refreshTokenRollup();

  return () => {
    ticking = false;
    window.clearInterval(interval);
    document.removeEventListener('visibilitychange', onVisible);
    window.removeEventListener('focus', onVisible);
    window.removeEventListener('blur', onBlur);
  };
}

export function formatDurationMs(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  const mins = Math.floor(ms / 60_000);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  const rem = mins % 60;
  return rem > 0 ? `${hrs}h ${rem}m` : `${hrs}h`;
}
