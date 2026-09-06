import { create } from 'zustand';

import type { ChatActivityEvent } from '@/features/chat/activity/types';
import type { JarvisTaskRunProjection } from '@/lib/jarvis/executionJournal/legacyTaskRunAdapter';

export type JarvisTaskRunStatus =
  | 'planning'
  | 'waiting-for-approval'
  | 'running'
  | 'waiting-for-input'
  | 'blocked'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type JarvisTaskStepStatus =
  | 'pending'
  | 'running'
  | 'waiting'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface JarvisTaskStep {
  id: string;
  action: string;
  label: string;
  input: Record<string, unknown>;
  recoverable: boolean;
  status: JarvisTaskStepStatus;
  summary?: string;
  error?: string;
  startedAt?: string;
  completedAt?: string;
}

/** Detached shape of the pre-journal task history retained for read-only compatibility. */
export interface JarvisTaskRun {
  id: string;
  chatId?: string;
  goal: string;
  status: JarvisTaskRunStatus;
  steps: JarvisTaskStep[];
  progress: number;
  activeAgents: string[];
  activeTerminals: string[];
  userVisibleSummary: string;
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
}

const REDACTED = '[redacted]';
const SENSITIVE_INPUT_KEY_RE =
  /(?:authorization|cookie|token|jwt|api[_-]?key|apikey|password|secret|credential|private[_-]?key|signing[_-]?key|service[_-]?role)/i;
const SECRET_VALUE_PATTERNS: RegExp[] = [
  /\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9_]{8,}\b/g,
  /\bsk-[A-Za-z0-9_-]{12,}\b/g,
  /\bwhsec_[A-Za-z0-9_]{8,}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
  /\bAIza[0-9A-Za-z_-]{20,}\b/g,
  /\b(?:api[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token|token|password|client[-_ ]?secret|private[-_ ]?key|secret)\s*(?:[:=]|\bis\b)\s*(?:"[^"]*"|'[^']*'|[^\s,;}]+)/gi,
];

function redactTaskString(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
    (trimmed.startsWith('[') && trimmed.endsWith(']'))
  ) {
    try {
      return JSON.stringify(sanitizeTaskValue(JSON.parse(trimmed), 0));
    } catch {
      // Non-JSON strings are still scanned below.
    }
  }
  return SECRET_VALUE_PATTERNS.reduce(
    (current, pattern) => current.replace(pattern, REDACTED),
    value,
  );
}

function sanitizeTaskValue(value: unknown, depth: number): unknown {
  if (value == null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') return redactTaskString(value);
  if (depth >= 8) return '[truncated]';
  if (Array.isArray(value)) {
    return value.slice(0, 100).map((item) => sanitizeTaskValue(item, depth + 1));
  }
  if (typeof value !== 'object') return String(value);
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .slice(0, 100)
      .map(([key, child]) => [
        key,
        SENSITIVE_INPUT_KEY_RE.test(key) ? REDACTED : sanitizeTaskValue(child, depth + 1),
      ]),
  );
}

function sanitizeStep(step: JarvisTaskStep): JarvisTaskStep {
  return {
    ...step,
    label: redactTaskString(step.label),
    input: sanitizeTaskValue(step.input ?? {}, 0) as Record<string, unknown>,
    ...(step.summary === undefined ? {} : { summary: redactTaskString(step.summary) }),
    ...(step.error === undefined ? {} : { error: redactTaskString(step.error) }),
  };
}

export function sanitizeLegacyJarvisTaskRun(run: Readonly<JarvisTaskRun>): JarvisTaskRun {
  return {
    ...run,
    goal: redactTaskString(run.goal),
    userVisibleSummary: redactTaskString(run.userVisibleSummary),
    activeAgents: [...run.activeAgents],
    activeTerminals: [...run.activeTerminals],
    steps: run.steps.map(sanitizeStep),
  };
}

function validIso(value: string, fallback: string): string {
  const timestamp = Date.parse(value);
  if (Number.isFinite(timestamp)) return new Date(timestamp).toISOString();
  const fallbackTimestamp = Date.parse(fallback);
  return new Date(Number.isFinite(fallbackTimestamp) ? fallbackTimestamp : 0).toISOString();
}

function legacyProjection(run: Readonly<JarvisTaskRun>): JarvisTaskRunProjection {
  const safe = sanitizeLegacyJarvisTaskRun(run);
  return Object.freeze({
    canonical: false,
    runId: safe.id,
    ...(safe.chatId ? { chatId: safe.chatId } : {}),
    status: safe.status,
    goal: safe.goal,
    userVisibleSummary: safe.userVisibleSummary,
    progress: Math.max(0, Math.min(100, Number.isFinite(safe.progress) ? safe.progress : 0)),
    activeAgents: Object.freeze([]),
    activeTerminals: Object.freeze([]),
    updatedAt: validIso(safe.updatedAt, safe.startedAt),
    cancellable: false,
    transportRetryAvailable: false,
  });
}

function cloneCanonicalProjection(
  projection: Readonly<JarvisTaskRunProjection>,
): JarvisTaskRunProjection {
  return Object.freeze({
    ...projection,
    activeAgents: Object.freeze([...projection.activeAgents]),
    activeTerminals: Object.freeze([...projection.activeTerminals]),
  });
}

function cloneActivityByChat(
  input: Readonly<Record<string, readonly ChatActivityEvent[]>>,
): Record<string, readonly ChatActivityEvent[]> {
  return Object.fromEntries(
    Object.entries(input).map(([chatId, events]) => [
      chatId,
      Object.freeze(events.slice(-500).map((event) => Object.freeze({ ...event }))),
    ]),
  );
}

interface JarvisTaskRunViewStore {
  accountScope: string;
  manualRecoveryByRun: Record<string, { accountId: string; runId: string }>;
  recordManualRecovery: (scope: string, accountId: string, runId: string) => void;
  runs: Record<string, JarvisTaskRunProjection>;
  activityByChat: Record<string, readonly ChatActivityEvent[]>;
  setAccountScope: (scope: string) => void;
  replaceLegacyForAccount: (scope: string, runs: readonly JarvisTaskRun[]) => void;
  replaceCanonicalForAccount: (
    scope: string,
    runs: readonly JarvisTaskRunProjection[],
    activityByChat: Readonly<Record<string, readonly ChatActivityEvent[]>>,
  ) => void;
  clearForTests: () => void;
}

let legacyRows: Record<string, JarvisTaskRunProjection> = {};
let canonicalRows: Record<string, JarvisTaskRunProjection> = {};

function mergedRows(): Record<string, JarvisTaskRunProjection> {
  return { ...legacyRows, ...canonicalRows };
}

export const useJarvisTaskRunStore = create<JarvisTaskRunViewStore>()((set, get) => ({
  accountScope: '',
  manualRecoveryByRun: {},
  runs: {},
  activityByChat: {},
  setAccountScope: (scope) => {
    if (scope === get().accountScope) return;
    legacyRows = {};
    canonicalRows = {};
    set({ accountScope: scope, runs: {}, activityByChat: {}, manualRecoveryByRun: {} });
  },
  recordManualRecovery: (scope, accountId, runId) => {
    if (!scope || scope !== get().accountScope || !accountId.trim() || !runId.trim()) return;
    // Presentation only: canonical lifecycle writes remain with the bound kernel.
    const retained = Object.entries(get().manualRecoveryByRun).filter(([id]) => id !== runId).slice(-499);
    set({ manualRecoveryByRun: { ...Object.fromEntries(retained), [runId]: { accountId, runId } } });
  },
  replaceLegacyForAccount: (scope, runs) => {
    if (!scope || scope !== get().accountScope) return;
    legacyRows = Object.fromEntries(
      runs.slice(0, 100).map((run) => {
        const projection = legacyProjection(run);
        return [projection.runId, projection];
      }),
    );
    set({ runs: mergedRows() });
  },
  replaceCanonicalForAccount: (scope, runs, activityByChat) => {
    if (!scope || scope !== get().accountScope) return;
    canonicalRows = Object.fromEntries(
      runs.slice(-500).map((run) => {
        const projection = cloneCanonicalProjection(run);
        return [projection.runId, projection];
      }),
    );
    set({ runs: mergedRows(), activityByChat: cloneActivityByChat(activityByChat) });
  },
  clearForTests: () => {
    legacyRows = {};
    canonicalRows = {};
    set({ accountScope: '', runs: {}, activityByChat: {}, manualRecoveryByRun: {} });
  },
}));
