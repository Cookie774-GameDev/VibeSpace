import { create } from 'zustand';
import { useTerminalTranscriptStore } from './transcriptStore';

export const TERMINAL_SWARM_UPDATE_EVENT = 'jarvis:terminal:swarm-update';

export interface TerminalSwarmActivity {
  agentSlug: string;
  sessionId: string;
  lastWriteAt: number;
  charCount: number;
}

interface TerminalSwarmState {
  /** Most recent activity per agent slug. */
  byAgent: Record<string, TerminalSwarmActivity>;
  setActivity: (activity: TerminalSwarmActivity) => void;
  clearAgent: (agentSlug: string) => void;
}

const FRESHNESS_MS = 10 * 60 * 1000;

export const useTerminalSwarmStore = create<TerminalSwarmState>((set) => ({
  byAgent: {},
  setActivity: (activity) =>
    set((s) => ({
      byAgent: { ...s.byAgent, [activity.agentSlug]: activity },
    })),
  clearAgent: (agentSlug) =>
    set((s) => {
      const { [agentSlug]: _, ...rest } = s.byAgent;
      return { byAgent: rest };
    }),
}));

/** Whether an agent has fresh terminal output worth surfacing in chat. */
export function hasFreshTerminalActivity(agentSlug: string): boolean {
  if (!agentSlug) return false;
  const activity = useTerminalSwarmStore.getState().byAgent[agentSlug];
  if (!activity) return false;
  return Date.now() - activity.lastWriteAt <= FRESHNESS_MS && activity.charCount > 0;
}

/**
 * Subscribe to transcript store writes and publish swarm activity events
 * so chat UI and runtime can react to live pane output.
 */
export function startTerminalSwarmBridge(): () => void {
  let prevSessions = useTerminalTranscriptStore.getState().sessions;

  const unsubscribe = useTerminalTranscriptStore.subscribe((state) => {
    const nextSessions = state.sessions;
    for (const [sessionId, transcript] of Object.entries(nextSessions)) {
      const prev = prevSessions[sessionId];
      if (!transcript.agentSlug) continue;
      if (prev?.lastWriteAt === transcript.lastWriteAt && prev?.text === transcript.text) continue;

      const activity: TerminalSwarmActivity = {
        agentSlug: transcript.agentSlug,
        sessionId,
        lastWriteAt: transcript.lastWriteAt,
        charCount: transcript.text.length,
      };
      useTerminalSwarmStore.getState().setActivity(activity);
      window.dispatchEvent(
        new CustomEvent(TERMINAL_SWARM_UPDATE_EVENT, { detail: activity }),
      );
    }
    prevSessions = nextSessions;
  });

  return unsubscribe;
}
