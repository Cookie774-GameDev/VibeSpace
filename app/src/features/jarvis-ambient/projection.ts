import type { VoiceState } from '@/features/voice/store';
import type { JarvisTaskRunProjection } from '@/lib/jarvis/executionJournal/legacyTaskRunAdapter';
import type { JarvisAmbientSnapshot, JarvisAmbientSource, JarvisAmbientState } from './types';

export const JARVIS_AMBIENT_DONE_MS = 1_700;

export type JarvisAmbientProjectionInput = Readonly<{
  revision: number;
  observedAt: number;
  voiceOpen?: boolean;
  sessionId?: string;
  voiceState: VoiceState;
  runs: readonly JarvisTaskRunProjection[];
  energy: number;
}>;

function latestRun(
  runs: readonly JarvisTaskRunProjection[],
  statuses: ReadonlySet<JarvisTaskRunProjection['status']>,
): JarvisTaskRunProjection | undefined {
  return runs
    .filter((run) => statuses.has(run.status))
    .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))[0];
}

function voiceProjection(state: VoiceState): [JarvisAmbientState, JarvisAmbientSource] | undefined {
  if (state === 'speaking') return ['speaking', 'voice'];
  if (state === 'listening') return ['listening', 'voice'];
  if (state === 'thinking') return ['working', 'voice'];
  if (state === 'error') return ['error', 'voice'];
  return undefined;
}

function clampEnergy(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round(Math.min(1, Math.max(0, value)) * 100) / 100;
}

export function projectJarvisAmbientSnapshot(
  input: JarvisAmbientProjectionInput,
): JarvisAmbientSnapshot {
  const waiting = latestRun(input.runs, new Set(['waiting-for-approval', 'waiting-for-input']));
  const failed = latestRun(input.runs, new Set(['failed', 'blocked']));
  const voice = voiceProjection(input.voiceState);
  const activeRun = latestRun(input.runs, new Set(['planning', 'running']));
  const completed = latestRun(input.runs, new Set(['completed']));
  let state: JarvisAmbientState = 'idle';
  let source: JarvisAmbientSource = 'voice';
  let transientUntil: number | undefined;

  if (waiting) {
    state = 'needs';
    source = waiting.status === 'waiting-for-approval' ? 'approval' : 'question';
  } else if (failed || voice?.[0] === 'error') {
    state = 'error';
    source = failed ? 'task' : 'voice';
  } else if (voice) {
    [state, source] = voice;
  } else if (activeRun) {
    state = 'working';
    source = 'task';
  } else if (completed) {
    const completedAt = Date.parse(completed.updatedAt);
    transientUntil = completedAt + JARVIS_AMBIENT_DONE_MS;
    if (Number.isFinite(completedAt) && input.observedAt <= transientUntil) {
      state = 'done';
      source = 'task';
    } else {
      transientUntil = undefined;
    }
  }

  const active = state !== 'idle' && (input.voiceOpen ?? true);
  // A closed HUD is authoritative even when a delayed task or audio callback arrives.
  if (!active) {
    state = 'idle';
    source = 'voice';
    transientUntil = undefined;
  }
  return Object.freeze({
    active,
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    revision: Math.max(0, Math.trunc(input.revision)),
    state,
    source,
    observedAt: Math.max(0, Math.trunc(input.observedAt)),
    energy: state === 'listening' || state === 'speaking' ? clampEnergy(input.energy) : 0,
    ...(transientUntil === undefined ? {} : { transientUntil }),
  });
}
