import type { CanonicalTurnState, TurnPreviewSegment } from './turnTypes';

const KEY_PREFIX = 'vibespace.chat.turn.v1:';
const MAX_TEXT_CHARS = 32_768;
const MAX_SEGMENTS = 128;

export interface TurnCheckpointStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

type PersistedTurnCheckpoint = Readonly<{
  version: 1;
  state: CanonicalTurnState;
}>;

function checkpointKey(accountId: string, chatId: string): string {
  return KEY_PREFIX + accountId.length + ':' + accountId + ':' + chatId;
}

function defaultStorage(): TurnCheckpointStorage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

function boundedSegments(
  segments: readonly TurnPreviewSegment[],
): readonly TurnPreviewSegment[] {
  return Object.freeze(
    segments.slice(-MAX_SEGMENTS).map((segment) =>
      segment.kind === 'text'
        ? Object.freeze({ ...segment, text: segment.text.slice(-MAX_TEXT_CHARS) })
        : Object.freeze({ ...segment }),
    ),
  );
}

export function writeTurnCheckpoint(
  state: CanonicalTurnState,
  storage: TurnCheckpointStorage | null = defaultStorage(),
): void {
  if (!storage) return;
  const safeState: CanonicalTurnState = Object.freeze({
    ...state,
    identity: Object.freeze({ ...state.identity }),
    provider: state.provider ? Object.freeze({ ...state.provider }) : undefined,
    contextPlan: state.contextPlan ? Object.freeze({ ...state.contextPlan }) : undefined,
    error: state.error ? Object.freeze({ ...state.error }) : undefined,
    public: Object.freeze({
      ...state.public,
      text: state.public.text.slice(-MAX_TEXT_CHARS),
      segments: boundedSegments(state.public.segments),
    }),
  });
  try {
    const value: PersistedTurnCheckpoint = Object.freeze({ version: 1, state: safeState });
    storage.setItem(
      checkpointKey(state.identity.accountId, state.identity.chatId),
      JSON.stringify(value),
    );
  } catch {
    // Recovery is best-effort and must never affect the live turn.
  }
}

export function readTurnCheckpoint(
  accountId: string,
  chatId: string,
  storage: TurnCheckpointStorage | null = defaultStorage(),
): CanonicalTurnState | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(checkpointKey(accountId, chatId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PersistedTurnCheckpoint>;
    const state = parsed.version === 1 ? parsed.state : undefined;
    if (
      !state ||
      state.identity?.accountId !== accountId ||
      state.identity?.chatId !== chatId ||
      typeof state.identity.runId !== 'string' ||
      typeof state.identity.requestId !== 'string' ||
      typeof state.revision !== 'number' ||
      !state.public ||
      !Array.isArray(state.public.segments)
    ) {
      return null;
    }
    return Object.freeze({
      ...state,
      identity: Object.freeze({ ...state.identity }),
      provider: state.provider ? Object.freeze({ ...state.provider }) : undefined,
      contextPlan: state.contextPlan ? Object.freeze({ ...state.contextPlan }) : undefined,
      error: state.error ? Object.freeze({ ...state.error }) : undefined,
      public: Object.freeze({
        ...state.public,
        segments: Object.freeze(
          state.public.segments.map((segment) => Object.freeze({ ...segment })),
        ),
      }),
    });
  } catch {
    return null;
  }
}

export function clearTurnCheckpoint(
  accountId: string,
  chatId: string,
  storage: TurnCheckpointStorage | null = defaultStorage(),
): void {
  try {
    storage?.removeItem(checkpointKey(accountId, chatId));
  } catch {
    // Best-effort cleanup.
  }
}
