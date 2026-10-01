import { create } from 'zustand';
import { MAX_PANES } from './paneTree';
import { sanitizePersistedTerminalText } from './terminalContentSanitizer';

export const MAX_TERMINAL_FLEET_RECORDS = 100;
export const MAX_TERMINAL_FLEET_ERRORS = 8;
export const MAX_TERMINAL_FLEET_ERROR_LENGTH = 160;

export type TerminalFleetProgressStatus =
  | 'queued'
  | 'planning'
  | 'launching'
  | 'complete'
  | 'partial'
  | 'cancelled'
  | 'failed';

export interface TerminalFleetProgressRecord {
  requestId: string;
  targetTotal: number;
  status: TerminalFleetProgressStatus;
  createdCount: number;
  reusedCount: number;
  launchedCount: number;
  skippedCount: number;
  currentBatch: number;
  errors: string[];
  createdAt: number;
  updatedAt: number;
}

export interface TerminalFleetProgressPatch {
  status?: TerminalFleetProgressStatus;
  createdCount?: number;
  reusedCount?: number;
  launchedCount?: number;
  skippedCount?: number;
  currentBatch?: number;
  errors?: readonly string[];
}

interface TerminalFleetStoreState {
  records: TerminalFleetProgressRecord[];
  begin: (input: { requestId: string; targetTotal: number }) => void;
  update: (requestId: string, patch: TerminalFleetProgressPatch) => void;
  cancel: (requestId: string) => void;
  reset: () => void;
}

function boundedInteger(value: number, max = MAX_PANES): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(max, Math.max(0, Math.floor(value)));
}

function sanitizeFleetError(error: string): string {
  // Progress errors are concise summaries, not terminal history. Keep their
  // leading reason while bounding the input before the shared secret redactor;
  // the terminal snapshot sanitizer intentionally keeps tails instead.
  const conciseInput = error.replace(/[\r\n\t]+/g, ' ').slice(0, 512);
  const persisted = sanitizePersistedTerminalText(conciseInput, {
    maxBytes: 512,
    maxLines: 1,
    truncationMarker: '',
  }).text;
  return persisted
    .replace(/\[REDACTED\]/g, '[REDACTED TOKEN]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_TERMINAL_FLEET_ERROR_LENGTH);
}

function sanitizeErrors(errors: readonly string[]): string[] {
  return errors
    .map(sanitizeFleetError)
    .filter(Boolean)
    .slice(0, MAX_TERMINAL_FLEET_ERRORS);
}

export const useTerminalFleetStore = create<TerminalFleetStoreState>((set) => ({
  records: [],
  begin: ({ requestId, targetTotal }) => {
    const now = Date.now();
    const record: TerminalFleetProgressRecord = {
      requestId: requestId.slice(0, 128),
      targetTotal: boundedInteger(targetTotal),
      status: 'queued',
      createdCount: 0,
      reusedCount: 0,
      launchedCount: 0,
      skippedCount: 0,
      currentBatch: 0,
      errors: [],
      createdAt: now,
      updatedAt: now,
    };
    set((state) => ({
      records: [
        ...state.records.filter((item) => item.requestId !== record.requestId),
        record,
      ].slice(-MAX_TERMINAL_FLEET_RECORDS),
    }));
  },
  update: (requestId, patch) => {
    set((state) => ({
      records: state.records.map((record) => {
        if (record.requestId !== requestId) return record;
        return {
          ...record,
          status: patch.status ?? record.status,
          createdCount:
            patch.createdCount == null
              ? record.createdCount
              : boundedInteger(patch.createdCount),
          reusedCount:
            patch.reusedCount == null
              ? record.reusedCount
              : boundedInteger(patch.reusedCount),
          launchedCount:
            patch.launchedCount == null
              ? record.launchedCount
              : boundedInteger(patch.launchedCount),
          skippedCount:
            patch.skippedCount == null
              ? record.skippedCount
              : boundedInteger(patch.skippedCount),
          currentBatch:
            patch.currentBatch == null
              ? record.currentBatch
              : boundedInteger(patch.currentBatch),
          errors: patch.errors == null ? record.errors : sanitizeErrors(patch.errors),
          updatedAt: Date.now(),
        };
      }),
    }));
  },
  cancel: (requestId) => {
    set((state) => ({
      records: state.records.map((record) =>
        record.requestId === requestId
          ? { ...record, status: 'cancelled', updatedAt: Date.now() }
          : record,
      ),
    }));
  },
  reset: () => set({ records: [] }),
}));
