import { create } from 'zustand';
import type { ToolRunRecord, ToolRunStatus } from './types';

function newId(): string {
  return `tr_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

interface ToolRunsState {
  runs: ToolRunRecord[];
  activeRunId: string | null;
  startRun: (toolId: string, toolName: string) => string;
  finishRun: (id: string, status: Exclude<ToolRunStatus, 'queued' | 'running'>, error?: string) => void;
  clearOld: () => void;
}

export const useToolRunsStore = create<ToolRunsState>((set, get) => ({
  runs: [],
  activeRunId: null,
  startRun: (toolId, toolName) => {
    const id = newId();
    const run: ToolRunRecord = {
      id,
      toolId,
      toolName,
      status: 'running',
      startedAt: Date.now(),
    };
    set({ runs: [run, ...get().runs].slice(0, 40), activeRunId: id });
    return id;
  },
  finishRun: (id, status, error) => {
    set({
      activeRunId: get().activeRunId === id ? null : get().activeRunId,
      runs: get().runs.map((r) =>
        r.id === id ? { ...r, status, error, completedAt: Date.now() } : r,
      ),
    });
  },
  clearOld: () => {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    set({ runs: get().runs.filter((r) => r.startedAt >= cutoff) });
  },
}));

export function activeToolRunCount(): number {
  return useToolRunsStore.getState().runs.filter((r) => r.status === 'running').length;
}
