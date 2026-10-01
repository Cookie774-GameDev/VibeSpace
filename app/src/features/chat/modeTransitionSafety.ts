import type { JarvisInteractionMode } from '@/features/jarvis-interaction/types';

const MODE_RESTRICTION: Readonly<Record<JarvisInteractionMode, number>> = Object.freeze({
  agent: 0,
  plan: 1,
  ask: 2,
});

/**
 * A live turn is cancelled only when the user removes authority.
 * Relaxing authority affects the next turn and must never interrupt current work.
 */
export function shouldCancelForLiveModeRestriction(input: {
  previousMode: JarvisInteractionMode;
  nextMode: JarvisInteractionMode;
  running: boolean;
  cancellationKey: string | null;
}): input is {
  previousMode: JarvisInteractionMode;
  nextMode: JarvisInteractionMode;
  running: true;
  cancellationKey: string;
} {
  return (
    input.running &&
    Boolean(input.cancellationKey) &&
    MODE_RESTRICTION[input.nextMode] > MODE_RESTRICTION[input.previousMode]
  );
}
