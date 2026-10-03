import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { getActiveAccountIdentity } from '@/lib/accountIdentity';
import {
  createActiveStatusClock,
  loadStatusSummary,
  startStatusAnalyticsRuntime,
  STATUS_ANALYTICS_CHANGED_EVENT,
} from '@/features/account/statusAnalytics';
import { useMilestonesStore } from './milestonesStore';
import { milestoneBelongsToScope } from './milestoneScope';
import { captureMilestoneScopeRead, currentMilestoneOwnerScope, milestoneOwnerScopeKey, verifyMilestoneOwnerScope } from './useScopedMilestones';
import { useToolRunsStore } from './toolRunsStore';
import { useAgentStore } from '@/stores/agents';
import type { AgentRunState } from '@/types/agent';

export type ModelUsageRow = {
  providerName: string;
  modelName: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  recordedCostUsd: number;
};

export type WorkspaceUsageAnalytics = {
  totalInputTokens: number;
  totalOutputTokens: number;
  totalReasoningTokens: number;
  totalCachedTokens: number;
  totalTokens: number;
  actualTotalCostUsd: number;
  estimatedTotalCostUsd: number;
  recordedTotalCostUsd: number;
  requestCount: number;
  completedRunCount: number;
  failedRunCount: number;
  cancelledRunCount: number;
  linesAdded: number;
  linesRemoved: number;
  byModel: ModelUsageRow[];
  foregroundActiveMs: number;
  backgroundRunningMs: number;
  completedMilestones: number;
  toolRunCount: number;
  lastForegroundAt: number | null;
  sessionStartedAt: number;
};

interface AnalyticsState extends WorkspaceUsageAnalytics {
  completedMilestoneScopeKey: string | null;
  tickForeground: () => void;
  tickBackground: () => void;
  refreshTokenRollup: () => Promise<void>;
  snapshot: () => WorkspaceUsageAnalytics;
}

const defaults: WorkspaceUsageAnalytics = {
  totalInputTokens: 0,
  totalOutputTokens: 0,
  totalReasoningTokens: 0,
  totalCachedTokens: 0,
  totalTokens: 0,
  actualTotalCostUsd: 0,
  estimatedTotalCostUsd: 0,
  recordedTotalCostUsd: 0,
  requestCount: 0,
  completedRunCount: 0,
  failedRunCount: 0,
  cancelledRunCount: 0,
  linesAdded: 0,
  linesRemoved: 0,
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
let rollupInFlight: Promise<void> | null = null;

async function loadLocalStatusRollup() {
  const identity = getActiveAccountIdentity();
  return identity ? loadStatusSummary(identity.accountId, '30d') : null;
}

type StatusUsageSource = Readonly<{
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  cachedTokens?: number;
  totalTokens?: number;
  actualCostUsd?: number;
  estimatedCostUsd?: number;
  costUsd?: number;
  requests?: number;
  completed?: number;
  failed?: number;
  cancelled?: number;
  linesAdded?: number;
  linesRemoved?: number;
  models?: readonly unknown[];
}> | null;

function nonNegative(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

export function projectStatusUsage(summary: StatusUsageSource) {
  const totalInputTokens = nonNegative(summary?.inputTokens);
  const totalOutputTokens = nonNegative(summary?.outputTokens);
  const totalReasoningTokens = nonNegative(summary?.reasoningTokens);
  const totalCachedTokens = nonNegative(summary?.cachedTokens);
  return {
    totalInputTokens,
    totalOutputTokens,
    totalReasoningTokens,
    totalCachedTokens,
    totalTokens:
      nonNegative(summary?.totalTokens) ||
      totalInputTokens + totalOutputTokens + totalReasoningTokens + totalCachedTokens,
    actualTotalCostUsd: nonNegative(summary?.actualCostUsd),
    estimatedTotalCostUsd: nonNegative(summary?.estimatedCostUsd),
    recordedTotalCostUsd: nonNegative(summary?.costUsd),
    requestCount: nonNegative(summary?.requests),
    completedRunCount: nonNegative(summary?.completed),
    failedRunCount: nonNegative(summary?.failed),
    cancelledRunCount: nonNegative(summary?.cancelled),
    linesAdded: nonNegative(summary?.linesAdded),
    linesRemoved: nonNegative(summary?.linesRemoved),
  };
}

function busyRunState(state: string | undefined): boolean {
  return (
    state === 'queued' ||
    state === 'thinking' ||
    state === 'reading' ||
    state === 'tool_calling' ||
    state === 'streaming'
  );
}

export function shouldCountBackgroundTime(
  runStates: Partial<Record<string, AgentRunState | string | undefined>>,
  activeToolRunId: string | null,
): boolean {
  return Boolean(activeToolRunId) || Object.values(runStates).some(busyRunState);
}

export const useWorkspaceAnalyticsStore = create<AnalyticsState>()(
  persist(
    (set, get) => ({
      ...defaults,
      completedMilestoneScopeKey: null,
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
        if (
          !shouldCountBackgroundTime(
            useAgentStore.getState().runStates,
            useToolRunsStore.getState().activeRunId,
          )
        )
          return;
        set((s) => ({ backgroundRunningMs: s.backgroundRunningMs + delta }));
      },
      refreshTokenRollup: () => {
        if (rollupInFlight) return rollupInFlight;
        const run = (async () => {
          const milestoneRead = captureMilestoneScopeRead();
          try {
            const milestoneScope = milestoneRead.scope;
            const milestoneScopeKey = milestoneRead.key;
            const summary = await loadLocalStatusRollup();
            const milestoneAllowed = await verifyMilestoneOwnerScope(milestoneScope);
            const sameMilestoneScope = milestoneAllowed && milestoneRead.isCurrent() &&
              milestoneOwnerScopeKey(currentMilestoneOwnerScope()) === milestoneScopeKey;
            const byModel: ModelUsageRow[] = (summary?.models ?? []).map((model) => {
              const separator = model.id.indexOf('::');
              return {
                providerName: separator >= 0 ? model.id.slice(0, separator) : 'unknown',
                modelName: model.label,
                inputTokens: model.inputTokens,
                outputTokens: model.outputTokens,
                totalTokens: model.totalTokens,
                recordedCostUsd: model.costUsd,
              };
            });
            const usage = projectStatusUsage(summary);
            set({
              byModel,
              ...usage,
              completedMilestoneScopeKey: sameMilestoneScope ? milestoneScopeKey : null,
              completedMilestones: sameMilestoneScope ? useMilestonesStore
                .getState().items.filter((i) => milestoneBelongsToScope(i, milestoneScope) &&
                  i.status === 'done').length : 0,
              toolRunCount: useToolRunsStore.getState().runs.length,
            });
          } finally { milestoneRead.dispose(); }
        })();
        const tracked = run.finally(() => {
          if (rollupInFlight === tracked) rollupInFlight = null;
        });
        rollupInFlight = tracked;
        return tracked;
      },
      snapshot: () => {
        const s = get();
        return {
          totalInputTokens: s.totalInputTokens,
          totalOutputTokens: s.totalOutputTokens,
          totalReasoningTokens: s.totalReasoningTokens,
          totalCachedTokens: s.totalCachedTokens,
          totalTokens: s.totalTokens,
          actualTotalCostUsd: s.actualTotalCostUsd,
          estimatedTotalCostUsd: s.estimatedTotalCostUsd,
          recordedTotalCostUsd: s.recordedTotalCostUsd,
          requestCount: s.requestCount,
          completedRunCount: s.completedRunCount,
          failedRunCount: s.failedRunCount,
          cancelledRunCount: s.cancelledRunCount,
          linesAdded: s.linesAdded,
          linesRemoved: s.linesRemoved,
          byModel: s.byModel,
          foregroundActiveMs: s.foregroundActiveMs,
          backgroundRunningMs: s.backgroundRunningMs,
          completedMilestones: s.completedMilestoneScopeKey === milestoneOwnerScopeKey(currentMilestoneOwnerScope())
            ? s.completedMilestones : 0,
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
  let stopStatusRuntime: () => void = () => undefined;
  const stopActiveClock = createActiveStatusClock();
  void startStatusAnalyticsRuntime().then((stop) => {
    stopStatusRuntime = stop;
  });

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
  }, 60_000);

  const onStatusChanged = () => {
    void useWorkspaceAnalyticsStore.getState().refreshTokenRollup();
  };

  document.addEventListener('visibilitychange', onVisible);
  window.addEventListener('focus', onVisible);
  const onBlur = () => {
    useWorkspaceAnalyticsStore.getState().tickBackground();
    lastTickAt = Date.now();
  };
  window.addEventListener('blur', onBlur);
  window.addEventListener(STATUS_ANALYTICS_CHANGED_EVENT, onStatusChanged);

  void useWorkspaceAnalyticsStore.getState().refreshTokenRollup();

  return () => {
    ticking = false;
    window.clearInterval(interval);
    document.removeEventListener('visibilitychange', onVisible);
    window.removeEventListener('focus', onVisible);
    window.removeEventListener('blur', onBlur);
    window.removeEventListener(STATUS_ANALYTICS_CHANGED_EVENT, onStatusChanged);
    stopActiveClock();
    stopStatusRuntime();
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
