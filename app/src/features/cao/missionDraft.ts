import { useState, type SetStateAction } from 'react';
import type { CaoControlScope } from './controlCommand';
import type { CaoExecutionIdentity } from './executionProfile';

export type CaoSetupDraft = {
  objective: string;
  step: number;
  targets: string[];
  editing: boolean;
  choice?: CaoExecutionIdentity;
};
const empty = (): CaoSetupDraft => ({ objective: '', step: 0, targets: [], editing: false });
const memory = new Map<string, CaoSetupDraft>();
export function caoDraftKey(scope: CaoControlScope): string {
  return `cao-setup-v1:${JSON.stringify([scope.accountId, scope.workspaceId, scope.projectId])}`;
}
export function readCaoDraft(key: string): CaoSetupDraft {
  const cached = memory.get(key);
  if (cached) return cached;
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
      return { ...value, editing: value.editing === true };
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
