import { create } from 'zustand';
import type { Agent, AgentId, AgentRunState } from '@/types';

/**
 * Runtime state for agents - which are loaded, which are currently running, status.
 * Definitions live in the database; this is the in-memory roster the UI binds to.
 */

interface AgentRuntimeState {
  /** All registered agents keyed by id */
  agents: Record<AgentId, Agent>;
  /** Per-agent current run state (streamed by the runtime) */
  runStates: Partial<Record<AgentId, AgentRunState>>;
  /** Per-agent current verb shown in the activity strip */
  verbs: Partial<Record<AgentId, string>>;
  /** Per-agent live token counter (running totals for current task) */
  tokens: Partial<Record<AgentId, { input: number; output: number; cost_usd: number }>>;

  // Actions
  registerAgent: (a: Agent) => void;
  registerMany: (a: Agent[]) => void;
  unregisterAgent: (id: AgentId) => void;
  updateAgent: (id: AgentId, patch: Partial<Agent>) => void;
  setRunState: (id: AgentId, state: AgentRunState | undefined) => void;
  setVerb: (id: AgentId, verb: string | undefined) => void;
  addTokens: (id: AgentId, input: number, output: number, cost_usd: number) => void;
  resetTokens: (id?: AgentId) => void;
  getActiveAgents: () => Agent[];
}

export const useAgentStore = create<AgentRuntimeState>((set, get) => ({
  agents: {},
  runStates: {},
  verbs: {},
  tokens: {},

  registerAgent: (a) =>
    set((s) => ({ agents: { ...s.agents, [a.id]: a } })),
  registerMany: (arr) =>
    set((s) => {
      const next = { ...s.agents };
      for (const a of arr) next[a.id] = a;
      return { agents: next };
    }),
  unregisterAgent: (id) =>
    set((s) => {
      const { [id]: _, ...rest } = s.agents;
      return { agents: rest };
    }),
  updateAgent: (id, patch) =>
    set((s) => {
      const cur = s.agents[id];
      if (!cur) return {};
      return { agents: { ...s.agents, [id]: { ...cur, ...patch, updated_at: Date.now() } } };
    }),
  setRunState: (id, state) =>
    set((s) => ({ runStates: { ...s.runStates, [id]: state } })),
  setVerb: (id, verb) => set((s) => ({ verbs: { ...s.verbs, [id]: verb } })),
  addTokens: (id, input, output, cost_usd) =>
    set((s) => {
      const cur = s.tokens[id] ?? { input: 0, output: 0, cost_usd: 0 };
      return {
        tokens: {
          ...s.tokens,
          [id]: {
            input: cur.input + input,
            output: cur.output + output,
            cost_usd: cur.cost_usd + cost_usd,
          },
        },
      };
    }),
  resetTokens: (id) =>
    set((s) => {
      if (!id) return { tokens: {} };
      const { [id]: _, ...rest } = s.tokens;
      return { tokens: rest };
    }),
  getActiveAgents: () => {
    const s = get();
    return Object.values(s.agents).filter(
      (a) => s.runStates[a.id] && s.runStates[a.id] !== 'idle' && s.runStates[a.id] !== 'done',
    );
  },
}));
