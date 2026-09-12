import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { safeLocalStorage } from '@/lib/persistence/safeLocalStorage';
import {
  DEFAULT_SECOND_BRAIN_CONFIG,
  type SecondBrainConfig,
  type SecondBrainRun,
  type SecondBrainSourceKind,
} from './nightlySecondBrain';

export interface NightlySecondBrainScopeState {
  config: SecondBrainConfig;
  runs: SecondBrainRun[];
}

export interface NightlySecondBrainState {
  scopes: Record<string, NightlySecondBrainScopeState>;
  setEnabled(scopeKey: string, enabled: boolean): void;
  setMode(scopeKey: string, mode: SecondBrainConfig['mode']): void;
  setModel(scopeKey: string, model: SecondBrainConfig['model']): void;
  setCloudPrivatePermission(scopeKey: string, enabled: boolean): void;
  setSourceEnabled(scopeKey: string, kind: SecondBrainSourceKind, enabled: boolean): void;
  recordRun(scopeKey: string, run: SecondBrainRun): void;
}

const EMPTY_SCOPE: NightlySecondBrainScopeState = Object.freeze({
  config: Object.freeze({
    ...DEFAULT_SECOND_BRAIN_CONFIG,
    sources: Object.freeze({ ...DEFAULT_SECOND_BRAIN_CONFIG.sources }),
  }),
  runs: Object.freeze([]) as unknown as SecondBrainRun[],
});

function createScope(): NightlySecondBrainScopeState {
  return {
    config: {
      ...DEFAULT_SECOND_BRAIN_CONFIG,
      sources: { ...DEFAULT_SECOND_BRAIN_CONFIG.sources },
    },
    runs: [],
  };
}

const FORBIDDEN_SCOPE_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const MAX_ID_LENGTH = 512;
const MAX_MODEL_LABEL_LENGTH = 256;
const MAX_MODEL_TEXT_LENGTH = 512;
const MAX_PATH_LENGTH = 4_096;
const MAX_CHANGE_TEXT_LENGTH = 10_000;
const MAX_PROVENANCE_ITEMS = 20;
const MAX_PROVENANCE_TEXT_LENGTH = 512;
const MAX_RUN_SUMMARY_LENGTH = 4_000;
const MAX_SCOPE_COUNT = 100;

function emptyScopes(): Record<string, NightlySecondBrainScopeState> {
  return Object.create(null) as Record<string, NightlySecondBrainScopeState>;
}

function validScopeKey(scopeKey: string): boolean {
  return (
    scopeKey.length > 0 &&
    scopeKey.length <= 512 &&
    !FORBIDDEN_SCOPE_KEYS.has(scopeKey) &&
    !/[\u0000-\u001f\u007f]/u.test(scopeKey)
  );
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function boundedString(value: unknown, maximum: number, allowEmpty = false): value is string {
  return typeof value === 'string' && value.length <= maximum && (allowEmpty || value.length > 0);
}

function recoverModel(value: unknown): (SecondBrainConfig['model'] & {}) | null {
  const model = record(value);
  if (
    !model ||
    !boundedString(model.id, MAX_ID_LENGTH) ||
    !boundedString(model.label, MAX_MODEL_LABEL_LENGTH) ||
    typeof model.local !== 'boolean' ||
    !boundedString(model.provider, MAX_MODEL_TEXT_LENGTH) ||
    !boundedString(model.modelId, MAX_MODEL_TEXT_LENGTH) ||
    (model.connectionId !== undefined && !boundedString(model.connectionId, MAX_MODEL_TEXT_LENGTH))
  ) {
    return null;
  }
  return {
    id: model.id,
    label: model.label,
    local: model.local,
    provider: model.provider,
    modelId: model.modelId,
    ...(model.connectionId === undefined ? {} : { connectionId: model.connectionId }),
  };
}

function recoverChange(value: unknown): SecondBrainRun['changes'][number] | null {
  const change = record(value);
  const target =
    change?.target === 'context_map' ||
    change?.target === 'user_md' ||
    change?.target === 'related_markdown'
      ? change.target
      : null;
  if (
    !change ||
    !boundedString(change.id, MAX_ID_LENGTH) ||
    !boundedString(change.path, MAX_PATH_LENGTH) ||
    !boundedString(change.before, MAX_CHANGE_TEXT_LENGTH, true) ||
    !boundedString(change.after, MAX_CHANGE_TEXT_LENGTH, true) ||
    (change.targetMapId !== undefined && !boundedString(change.targetMapId, MAX_ID_LENGTH)) ||
    !target ||
    !Array.isArray(change.provenance) ||
    change.provenance.length > MAX_PROVENANCE_ITEMS ||
    !change.provenance.every((item) => boundedString(item, MAX_PROVENANCE_TEXT_LENGTH)) ||
    typeof change.confidence !== 'number' ||
    !Number.isFinite(change.confidence) ||
    change.confidence < 0 ||
    change.confidence > 1
  ) {
    return null;
  }
  return {
    id: change.id,
    target,
    ...(change.targetMapId === undefined ? {} : { targetMapId: change.targetMapId }),
    path: change.path,
    before: change.before,
    after: change.after,
    provenance: [...change.provenance],
    confidence: change.confidence,
  };
}

function recoverRun(value: unknown): SecondBrainRun | null {
  const run = record(value);
  const model = recoverModel(run?.model);
  const rawChanges = Array.isArray(run?.changes) ? run.changes : null;
  const changes = rawChanges?.map(recoverChange) ?? null;
  const status =
    run?.status === 'pending_approval' ||
    run?.status === 'applied' ||
    run?.status === 'rejected' ||
    run?.status === 'rolled_back' ||
    run?.status === 'failed'
      ? run.status
      : null;
  const mode = run?.mode === 'approve_only' || run?.mode === 'auto' ? run.mode : null;
  if (
    !run ||
    !boundedString(run.id, MAX_ID_LENGTH) ||
    typeof run.scheduledFor !== 'number' ||
    !Number.isSafeInteger(run.scheduledFor) ||
    typeof run.startedAt !== 'number' ||
    !Number.isSafeInteger(run.startedAt) ||
    typeof run.completedAt !== 'number' ||
    !Number.isSafeInteger(run.completedAt) ||
    !status ||
    !mode ||
    !model ||
    !changes ||
    rawChanges === null ||
    rawChanges.length > 50 ||
    changes.some((change) => change === null) ||
    !boundedString(run.summary, MAX_RUN_SUMMARY_LENGTH, true) ||
    (run.error !== undefined && !boundedString(run.error, MAX_RUN_SUMMARY_LENGTH, true)) ||
    (run.retryOf !== undefined && !boundedString(run.retryOf, MAX_ID_LENGTH))
  ) {
    return null;
  }
  return {
    id: run.id,
    scheduledFor: run.scheduledFor,
    startedAt: run.startedAt,
    completedAt: run.completedAt,
    status,
    mode,
    model,
    changes: changes as SecondBrainRun['changes'],
    summary: run.summary,
    ...(run.error === undefined ? {} : { error: run.error }),
    ...(run.retryOf === undefined ? {} : { retryOf: run.retryOf }),
  };
}

function recoverScope(value: unknown): NightlySecondBrainScopeState | null {
  const scope = record(value);
  const config = record(scope?.config);
  const sources = record(config?.sources);
  const model = config?.model === null ? null : recoverModel(config?.model);
  if (
    !scope ||
    !config ||
    typeof config.enabled !== 'boolean' ||
    config.scheduleHour !== 2 ||
    (config.mode !== 'approve_only' && config.mode !== 'auto') ||
    (config.model !== null && !model) ||
    typeof config.allowPrivateDataToCloud !== 'boolean' ||
    !sources ||
    typeof sources.chat !== 'boolean' ||
    typeof sources.terminal !== 'boolean' ||
    typeof sources.project !== 'boolean' ||
    typeof sources.context !== 'boolean' ||
    !Array.isArray(scope.runs)
  ) {
    return null;
  }
  return {
    config: {
      enabled: config.enabled,
      scheduleHour: 2,
      mode: config.mode,
      model,
      allowPrivateDataToCloud: config.allowPrivateDataToCloud,
      sources: {
        chat: sources.chat,
        terminal: sources.terminal,
        project: sources.project,
        context: sources.context,
      },
    },
    runs: scope.runs
      .slice(0, 30)
      .map(recoverRun)
      .filter((run): run is SecondBrainRun => run !== null)
      .slice(0, 30),
  };
}

function updateScope(
  state: NightlySecondBrainState,
  scopeKey: string,
  update: (scope: NightlySecondBrainScopeState) => NightlySecondBrainScopeState,
): Pick<NightlySecondBrainState, 'scopes'> {
  if (!validScopeKey(scopeKey)) return { scopes: state.scopes };
  const current = state.scopes[scopeKey] ?? createScope();
  const scopes = emptyScopes();
  for (const [key, value] of Object.entries(state.scopes).slice(0, MAX_SCOPE_COUNT - 1)) {
    if (validScopeKey(key)) scopes[key] = value;
  }
  scopes[scopeKey] = update(current);
  return { scopes };
}

export const useNightlySecondBrainStore = create<NightlySecondBrainState>()(
  persist(
    (set) => ({
      scopes: emptyScopes(),
      setEnabled: (scopeKey, enabled) =>
        set((state) =>
          updateScope(state, scopeKey, (scope) => ({
            ...scope,
            config: { ...scope.config, enabled, scheduleHour: 2 },
          })),
        ),
      setMode: (scopeKey, mode) =>
        set((state) =>
          updateScope(state, scopeKey, (scope) => ({
            ...scope,
            config: { ...scope.config, mode },
          })),
        ),
      setModel: (scopeKey, model) =>
        set((state) =>
          updateScope(state, scopeKey, (scope) => ({
            ...scope,
            config: { ...scope.config, model },
          })),
        ),
      setCloudPrivatePermission: (scopeKey, allowPrivateDataToCloud) =>
        set((state) =>
          updateScope(state, scopeKey, (scope) => ({
            ...scope,
            config: { ...scope.config, allowPrivateDataToCloud },
          })),
        ),
      setSourceEnabled: (scopeKey, kind, enabled) =>
        set((state) =>
          updateScope(state, scopeKey, (scope) => ({
            ...scope,
            config: {
              ...scope.config,
              sources: { ...scope.config.sources, [kind]: enabled },
            },
          })),
        ),
      recordRun: (scopeKey, run) =>
        set((state) =>
          updateScope(state, scopeKey, (scope) => ({
            ...scope,
            runs: [run, ...scope.runs.filter((item) => item.id !== run.id)].slice(0, 30),
          })),
        ),
    }),
    {
      name: 'vibespace-nightly-second-brain-v1',
      storage: createJSONStorage(() => safeLocalStorage),
      version: 3,
      partialize: (state) => ({ scopes: state.scopes }),
      migrate: (persisted, version) => {
        if (version < 3) {
          // The former schema held one global private run list. It cannot be
          // attributed safely after an account switch, so it is quarantined
          // instead of being projected into the next signed-in account.
          return { scopes: emptyScopes() };
        }
        return persisted as Pick<NightlySecondBrainState, 'scopes'>;
      },
      merge: (persisted, current) => {
        const value = persisted as Partial<Pick<NightlySecondBrainState, 'scopes'>> | undefined;
        const scopes = emptyScopes();
        if (value?.scopes && typeof value.scopes === 'object' && !Array.isArray(value.scopes)) {
          const persistedScopes = value.scopes as Record<string, unknown>;
          for (const scopeKey of Object.keys(persistedScopes).slice(0, MAX_SCOPE_COUNT)) {
            const candidate = persistedScopes[scopeKey];
            const recovered = validScopeKey(scopeKey) ? recoverScope(candidate) : null;
            if (recovered) scopes[scopeKey] = recovered;
          }
        }
        return { ...current, scopes };
      },
    },
  ),
);

export function getNightlySecondBrainScope(scopeKey: string): NightlySecondBrainScopeState {
  if (!validScopeKey(scopeKey)) return EMPTY_SCOPE;
  return useNightlySecondBrainStore.getState().scopes[scopeKey] ?? EMPTY_SCOPE;
}

export function selectNightlySecondBrainScope(
  state: NightlySecondBrainState,
  scopeKey: string,
): NightlySecondBrainScopeState {
  return validScopeKey(scopeKey) ? (state.scopes[scopeKey] ?? EMPTY_SCOPE) : EMPTY_SCOPE;
}

export function nightlySecondBrainScopeKey(input: {
  accountId: string;
  workspaceId: string;
  projectId: string | null;
}): string {
  const values = [input.accountId, input.workspaceId, input.projectId ?? '__no_project__'];
  if (values.some((value) => !value.trim() || value.length > 200)) return '';
  return JSON.stringify(values);
}

export function resetNightlySecondBrainStoreForTests(): void {
  useNightlySecondBrainStore.setState({ scopes: emptyScopes() });
}
