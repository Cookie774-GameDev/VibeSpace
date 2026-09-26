import { useState, type SetStateAction } from 'react';
import type { CaoControlScope } from './controlCommand';
import type { CaoExecutionIdentity } from './executionProfile';

export type CaoSetupDraft = {
  objective: string;
  step: number;
  targets: string[];
  editing: boolean;
  choice?: CaoExecutionIdentity;
  choiceExplicit?: boolean;
  choiceProfileUpdatedAt?: number | null;
};
const empty = (): CaoSetupDraft => ({ objective: '', step: 0, targets: [], editing: false });
const memory = new Map<string, CaoSetupDraft>();

function normalizeDraft(value: CaoSetupDraft): CaoSetupDraft {
  const hasProfileVersion =
    value.choiceProfileUpdatedAt === null ||
    (typeof value.choiceProfileUpdatedAt === 'number' &&
      Number.isFinite(value.choiceProfileUpdatedAt));
  const choiceExplicit =
    Boolean(value.choice) && value.choiceExplicit === true && hasProfileVersion;
  return {
    ...value,
    editing: value.editing === true,
    choiceExplicit,
    choiceProfileUpdatedAt: choiceExplicit ? value.choiceProfileUpdatedAt! : null,
  };
}

export function caoDraftKey(scope: CaoControlScope): string {
  return `cao-setup-v1:${JSON.stringify([scope.accountId, scope.workspaceId, scope.projectId])}`;
}
export function readCaoDraft(key: string): CaoSetupDraft {
  const cached = memory.get(key);
  if (cached) {
    const normalized = normalizeDraft(cached);
    memory.set(key, normalized);
    return normalized;
  }
  try {
    const value = JSON.parse(sessionStorage.getItem(key) ?? 'null');
    if (
      value &&
      typeof value.objective === 'string' &&
      Number.isInteger(value.step) &&
      value.step >= 0 &&
      value.step <= 4 &&
      Array.isArray(value.targets) &&
      value.targets.every((item: unknown) => typeof item === 'string')
    ) {
      const normalized = normalizeDraft(value);
      memory.set(key, normalized);
      return normalized;
    }
  } catch {
    /* In-memory persistence remains available if storage is disabled. */
  }
  return empty();
}
export function useCaoSetupDraft(scope: CaoControlScope) {
  const key = caoDraftKey(scope);
  const [draft, setDraft] = useState(() => readCaoDraft(key));
  const update = <K extends keyof CaoSetupDraft>(
    field: K,
    action: SetStateAction<CaoSetupDraft[K]>,
  ) => {
    const current = memory.get(key) ?? draft;
    const value =
      typeof action === 'function'
        ? (action as (value: CaoSetupDraft[K]) => CaoSetupDraft[K])(current[field])
        : action;
    const next = { ...current, [field]: value };
    memory.set(key, next);
    try {
      sessionStorage.setItem(key, JSON.stringify(next));
    } catch {
      /* Keep the live draft. */
    }
    setDraft(next);
  };
  return { draft, update };
}
