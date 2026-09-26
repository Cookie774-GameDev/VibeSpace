import { applySecretPolicy } from '@/lib/security/secretDetector';
import type { CaoMission, CaoMissionLookup, CaoMissionStatus, CaoMissionStore } from './types';

const TRANSITIONS: Readonly<Record<CaoMissionStatus, readonly CaoMissionStatus[]>> = {
  planning: ['running', 'cancelled'],
  running: ['verifying', 'failed', 'cancelled'],
  verifying: ['completed', 'failed', 'running', 'cancelled'],
  completed: [],
  failed: ['running', 'cancelled'],
  cancelled: [],
};
const MAX_CANCEL_ATTEMPTS = 3;
const MAX_FAILURE_REASON_LENGTH = 512;

export function sanitizeCaoMissionFailureReason(value: unknown): string {
  const source = value instanceof Error ? value.message : String(value ?? '');
  const bounded = source
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, 2048);
  const redacted = (applySecretPolicy(bounded, 'redact').text ?? '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, MAX_FAILURE_REASON_LENGTH);
  return redacted || 'cao_mission_start_failed';
}

export function createCaoMissionRuntime(input: { store: CaoMissionStore; now?: () => number }) {
  const now = input.now ?? Date.now;
  const transitionMission = async (
    mission: CaoMission,
    status: CaoMissionStatus,
  ): Promise<CaoMission> => {
    if (!TRANSITIONS[mission.status].includes(status)) {
      throw new Error('cao_mission_transition_invalid');
    }
    const next = Object.freeze({ ...mission, status, updatedAt: now() });
    if (!(await input.store.compareAndSave({ expected: mission, next }))) {
      throw new Error('cao_mission_conflict');
    }
    return next;
  };
  const transition = async (
    scope: CaoMissionLookup,
    status: CaoMissionStatus,
  ): Promise<CaoMission> => {
    const mission = await input.store.get(scope);
    if (!mission) throw new Error('cao_mission_unavailable');
    return transitionMission(mission, status);
  };
  return Object.freeze({
    async start(mission: CaoMission): Promise<CaoMission> {
      await input.store.save(mission);
      return transitionMission(mission, 'running');
    },
    transition,
    async cancel(scope: CaoMissionLookup, failureReason?: string): Promise<CaoMission> {
      for (let attempt = 0; attempt < MAX_CANCEL_ATTEMPTS; attempt += 1) {
        const mission = await input.store.get(scope);
        if (!mission) throw new Error('cao_mission_unavailable');
        if (mission.status === 'cancelled') return mission;
        if (!TRANSITIONS[mission.status].includes('cancelled')) {
          throw new Error('cao_mission_transition_invalid');
        }
        const next = Object.freeze({
          ...mission,
          status: 'cancelled' as const,
          ...(failureReason
            ? { failureReason: sanitizeCaoMissionFailureReason(failureReason) }
            : {}),
          updatedAt: now(),
        });
        if (await input.store.compareAndSave({ expected: mission, next })) return next;
      }
      throw new Error('cao_mission_conflict');
    },
    async recover(scope: CaoMissionLookup): Promise<CaoMission | undefined> {
      const mission = await input.store.get(scope);
      if (!mission || mission.status !== 'running') return mission;
      const recovered = Object.freeze({ ...mission, updatedAt: now() });
      if (!(await input.store.compareAndSave({ expected: mission, next: recovered }))) {
        throw new Error('cao_mission_conflict');
      }
      return recovered;
    },
  });
}
