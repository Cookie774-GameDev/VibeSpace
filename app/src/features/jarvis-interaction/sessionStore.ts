import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import type { ChatId } from '@/types/common';
import { safeLocalStorage } from '@/lib/persistence/safeLocalStorage';
import { normalizeChatModelSelection } from '@/lib/ai/modelSelection';
import type { JarvisChatAgent, JarvisInteractionMode } from './types';
import { normalizeInteractionMode } from './modes';

interface JarvisInteractionState {
  modesByChat: Record<string, JarvisInteractionMode>;
  planSafeApprovalsByChat: Record<string, boolean>;
  agentsByChat: Record<string, JarvisChatAgent[]>;
  modeForChat: (chatId: ChatId | string) => JarvisInteractionMode;
  setChatMode: (chatId: ChatId | string, mode: JarvisInteractionMode) => void;
  setPlanSafeApproval: (chatId: ChatId | string, approved: boolean) => void;
  hasPlanSafeApproval: (chatId: ChatId | string) => boolean;
  upsertAgent: (chatId: ChatId | string, agent: JarvisChatAgent) => void;
  updateAgent: (chatId: ChatId | string, agentId: string, patch: Partial<JarvisChatAgent>) => void;
  agentsForChat: (chatId: ChatId | string) => JarvisChatAgent[];
}

type JarvisInteractionPersistedState = Pick<
  JarvisInteractionState,
  'modesByChat' | 'planSafeApprovalsByChat' | 'agentsByChat'
>;

const ACTIVE_AGENT_STATUSES = new Set<JarvisChatAgent['status']>([
  'queued',
  'thinking',
  'planning',
  'asking_question',
  'waiting_permission',
  'editing',
  'testing',
]);
const ALL_AGENT_STATUSES = new Set<JarvisChatAgent['status']>([
  ...ACTIVE_AGENT_STATUSES,
  'blocked',
  'done',
  'failed',
  'cancelled',
]);

function reconcileRestartedAgents(
  agentsByChat: Record<string, JarvisChatAgent[]>,
): Record<string, JarvisChatAgent[]> {
  return Object.fromEntries(
    Object.entries(agentsByChat).map(([chatId, agents]) => [
      chatId,
      agents.map((agent) =>
        ACTIVE_AGENT_STATUSES.has(agent.status)
          ? {
              ...agent,
              status: 'failed' as const,
              currentStep: 'Interrupted by app restart',
              summary:
                'This child run did not report a terminal result before VibeSpace restarted.',
              error: 'Interrupted by app restart.',
            }
          : agent,
      ),
    ]),
  );
}

function asRecord<T>(value: unknown): Record<string, T> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, T>)
    : {};
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function optionalHarnessSessionId(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const id = value.trim();
  return id && id.length <= 512 && !/[\u0000-\u001f\u007f]/.test(id) ? id : undefined;
}

function sanitizeModelSelection(value: unknown): JarvisChatAgent['modelSelection'] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const mode = record.mode;
  if (mode !== 'none' && mode !== 'single' && mode !== 'hive') return undefined;
  const providerId = typeof record.providerId === 'string' ? record.providerId.trim() : '';
  if (mode === 'single' && (!providerId || typeof record.modelId !== 'string')) {
    return undefined;
  }
  const normalized = normalizeChatModelSelection(
    mode === 'single' ? { ...record, providerId } : value,
  );
  // The canonical normalizer fails closed to { mode: 'none' }. Preserve that
  // only when it was the persisted selection, not when malformed input caused it.
  if (mode !== 'none' && normalized.mode === 'none') return undefined;
  return normalized;
}

function sanitizeJarvisChatAgent(value: unknown): JarvisChatAgent | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const agent = value as Partial<JarvisChatAgent>;
  if (
    typeof agent.agentId !== 'string' ||
    typeof agent.name !== 'string' ||
    typeof agent.parentChatId !== 'string' ||
    typeof agent.childChatId !== 'string' ||
    typeof agent.task !== 'string' ||
    typeof agent.modelLabel !== 'string' ||
    typeof agent.status !== 'string' ||
    !ALL_AGENT_STATUSES.has(agent.status as JarvisChatAgent['status']) ||
    !Array.isArray(agent.filesTouched) ||
    !Array.isArray(agent.lockedFiles) ||
    typeof agent.createdAt !== 'string' ||
    typeof agent.updatedAt !== 'string'
  ) {
    return null;
  }

  const sanitized: JarvisChatAgent = {
    agentId: agent.agentId,
    name: agent.name,
    parentChatId: agent.parentChatId,
    childChatId: agent.childChatId,
    task: agent.task,
    modelLabel: agent.modelLabel,
    status: agent.status as JarvisChatAgent['status'],
    filesTouched: asStringArray(agent.filesTouched),
    lockedFiles: asStringArray(agent.lockedFiles),
    createdAt: agent.createdAt,
    updatedAt: agent.updatedAt,
  };
  const currentStep = optionalString(agent.currentStep);
  const summary = optionalString(agent.summary);
  const error = optionalString(agent.error);
  const harnessSessionId = optionalHarnessSessionId(agent.harnessSessionId);
  const harnessParentSessionId = optionalHarnessSessionId(agent.harnessParentSessionId);
  const modelSelection = sanitizeModelSelection(agent.modelSelection);
  if (modelSelection !== undefined) sanitized.modelSelection = modelSelection;
  if (harnessSessionId !== undefined) sanitized.harnessSessionId = harnessSessionId;
  if (harnessParentSessionId !== undefined) {
    sanitized.harnessParentSessionId = harnessParentSessionId;
  }
  if (currentStep !== undefined) sanitized.currentStep = currentStep;
  if (Array.isArray(agent.filesRead)) sanitized.filesRead = asStringArray(agent.filesRead);
  if (Array.isArray(agent.filesEditing)) sanitized.filesEditing = asStringArray(agent.filesEditing);
  if (
    agent.diffSummary &&
    typeof agent.diffSummary === 'object' &&
    typeof agent.diffSummary.addedLines === 'number' &&
    Number.isFinite(agent.diffSummary.addedLines) &&
    agent.diffSummary.addedLines >= 0 &&
    typeof agent.diffSummary.removedLines === 'number' &&
    Number.isFinite(agent.diffSummary.removedLines) &&
    agent.diffSummary.removedLines >= 0
  ) {
    sanitized.diffSummary = {
      addedLines: agent.diffSummary.addedLines,
      removedLines: agent.diffSummary.removedLines,
    };
  }
  if (summary !== undefined) sanitized.summary = summary;
  if (error !== undefined) sanitized.error = error;
  return sanitized;
}

function asAgentLists(value: unknown): Record<string, JarvisChatAgent[]> {
  return Object.fromEntries(
    Object.entries(asRecord<unknown>(value))
      .filter((entry): entry is [string, unknown[]] => Array.isArray(entry[1]))
      .map(([chatId, agents]) => [
        chatId,
        agents
          .map(sanitizeJarvisChatAgent)
          .filter((agent): agent is JarvisChatAgent => agent !== null),
      ])
      .filter(([, agents]) => agents.length > 0),
  );
}

function asModes(value: unknown): Record<string, JarvisInteractionMode> {
  return Object.fromEntries(
    Object.entries(asRecord<unknown>(value)).filter(
      (entry): entry is [string, JarvisInteractionMode] =>
        entry[1] === 'ask' || entry[1] === 'plan' || entry[1] === 'agent',
    ),
  );
}

export function serializeJarvisInteractionState(
  state: JarvisInteractionPersistedState,
): JarvisInteractionPersistedState {
  return {
    modesByChat: state.modesByChat,
    // Plan-safe approval is authority for the current renderer session only.
    // A restart must require the user to approve again.
    planSafeApprovalsByChat: {},
    // Child runtimes do not survive a renderer restart. Persist terminal truth
    // instead of resurrecting an orphan as queued/thinking/editing.
    agentsByChat: reconcileRestartedAgents(state.agentsByChat),
  };
}

export function migrateJarvisInteractionState(
  persisted: unknown,
  _fromVersion: number,
): JarvisInteractionPersistedState {
  const state = asRecord<unknown>(persisted);
  return serializeJarvisInteractionState({
    modesByChat: asModes(state.modesByChat),
    planSafeApprovalsByChat: asRecord<boolean>(state.planSafeApprovalsByChat),
    agentsByChat: asAgentLists(state.agentsByChat),
  });
}

export function mergeJarvisInteractionState(
  persisted: unknown,
  current: JarvisInteractionState,
): JarvisInteractionState {
  const sanitized = migrateJarvisInteractionState(persisted, 2);
  return {
    ...current,
    ...sanitized,
  };
}

function key(chatId: ChatId | string): string {
  return String(chatId);
}

export const useJarvisInteractionStore = create<JarvisInteractionState>()(
  persist<JarvisInteractionState, [], [], JarvisInteractionPersistedState>(
    (set, get) => ({
      modesByChat: {},
      planSafeApprovalsByChat: {},
      agentsByChat: {},
      modeForChat(chatId) {
        return normalizeInteractionMode(get().modesByChat[key(chatId)]);
      },
      setChatMode(chatId, mode) {
        set((state) => ({
          modesByChat: {
            ...state.modesByChat,
            [key(chatId)]: mode,
          },
        }));
      },
      setPlanSafeApproval(chatId, approved) {
        set((state) => ({
          planSafeApprovalsByChat: {
            ...state.planSafeApprovalsByChat,
            [key(chatId)]: approved,
          },
        }));
      },
      hasPlanSafeApproval(chatId) {
        return Boolean(get().planSafeApprovalsByChat[key(chatId)]);
      },
      upsertAgent(chatId, agent) {
        set((state) => {
          const chatKey = key(chatId);
          const existing = state.agentsByChat[chatKey] ?? [];
          const next = [
            ...existing.filter((item) => String(item.agentId) !== String(agent.agentId)),
            agent,
          ].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
          return {
            agentsByChat: {
              ...state.agentsByChat,
              [chatKey]: next,
            },
          };
        });
      },
      updateAgent(chatId, agentId, patch) {
        set((state) => {
          const chatKey = key(chatId);
          const existing = state.agentsByChat[chatKey] ?? [];
          return {
            agentsByChat: {
              ...state.agentsByChat,
              [chatKey]: existing.map((agent) =>
                String(agent.agentId) === agentId ? { ...agent, ...patch } : agent,
              ),
            },
          };
        });
      },
      agentsForChat(chatId) {
        return get().agentsByChat[key(chatId)] ?? [];
      },
    }),
    {
      name: 'jarvis-interaction-session',
      storage: createJSONStorage(() => safeLocalStorage),
      version: 2,
      migrate: migrateJarvisInteractionState,
      merge: mergeJarvisInteractionState,
      partialize: serializeJarvisInteractionState,
    },
  ),
);
