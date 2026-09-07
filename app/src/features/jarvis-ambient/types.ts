export const JARVIS_AMBIENT_STATES = [
  'idle',
  'listening',
  'speaking',
  'working',
  'needs',
  'done',
  'error',
] as const;

export type JarvisAmbientState = (typeof JARVIS_AMBIENT_STATES)[number];

export type JarvisAmbientSource =
  'voice' | 'approval' | 'question' | 'plan' | 'task' | 'agent' | 'command';

export type JarvisAmbientSnapshot = Readonly<{
  revision: number;
  state: JarvisAmbientState;
  source: JarvisAmbientSource;
  observedAt: number;
  energy: number;
  transientUntil?: number;
  /** Explicit visibility intent; absent only for older snapshot producers. */
  active?: boolean;
  /** Opaque Voice-session identity, never transcript or account data. */
  sessionId?: string;
}>;

export function isJarvisAmbientSnapshot(value: unknown): value is JarvisAmbientSnapshot {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Partial<JarvisAmbientSnapshot>;
  return (
    (candidate.active === undefined || typeof candidate.active === 'boolean') &&
    (candidate.sessionId === undefined ||
      (typeof candidate.sessionId === 'string' &&
        candidate.sessionId.length > 0 &&
        candidate.sessionId.length <= 160)) &&
    Number.isSafeInteger(candidate.revision) &&
    (candidate.revision ?? -1) >= 0 &&
    JARVIS_AMBIENT_STATES.includes(candidate.state as JarvisAmbientState) &&
    ['voice', 'approval', 'question', 'plan', 'task', 'agent', 'command'].includes(
      candidate.source ?? '',
    ) &&
    Number.isFinite(candidate.observedAt) &&
    (candidate.observedAt ?? -1) >= 0 &&
    Number.isFinite(candidate.energy) &&
    (candidate.energy ?? -1) >= 0 &&
    (candidate.energy ?? 2) <= 1 &&
    (candidate.transientUntil === undefined ||
      (Number.isFinite(candidate.transientUntil) && candidate.transientUntil >= 0))
  );
}
