import {
  isUsableTerminalGeometry,
  sameTerminalGeometry,
  type TerminalContainerGeometry,
} from './terminalGeometry';

export const TERMINAL_REFIT_STABLE_FRAME_COUNT = 2;
export const TERMINAL_REFIT_MAX_FRAMES = 12;

export interface TerminalRefitFrameScheduler {
  requestFrame: (callback: FrameRequestCallback) => number;
  cancelFrame: (id: number) => void;
}

export interface TerminalRefitCoordinatorOptions extends TerminalRefitFrameScheduler {
  readGeometry: () => TerminalContainerGeometry;
  onStableGeometry: (geometry: TerminalContainerGeometry) => void;
  stableFrameCount?: number;
  maxFrames?: number;
  minWidth?: number;
  minHeight?: number;
}

export interface TerminalRefitCoordinator {
  request: () => void;
  cancel: () => void;
  dispose: () => void;
}

export function createTerminalRefitCoordinator(
  options: TerminalRefitCoordinatorOptions,
): TerminalRefitCoordinator {
  const stableFrameTarget = Math.max(
    1,
    Math.floor(options.stableFrameCount ?? TERMINAL_REFIT_STABLE_FRAME_COUNT),
  );
  const maxFrames = Math.max(
    stableFrameTarget,
    Math.floor(options.maxFrames ?? TERMINAL_REFIT_MAX_FRAMES),
  );

  let disposed = false;
  let generation = 0;
  let frameId: number | null = null;
  let framesObserved = 0;
  let stableFrames = 0;
  let previousGeometry: TerminalContainerGeometry | null = null;

  const resetPending = () => {
    generation += 1;
    if (frameId != null) {
      options.cancelFrame(frameId);
      frameId = null;
    }
    framesObserved = 0;
    stableFrames = 0;
    previousGeometry = null;
  };

  const schedule = (activeGeneration: number) => {
    frameId = options.requestFrame(() => {
      frameId = null;
      if (disposed || activeGeneration !== generation) return;

      framesObserved += 1;
      const geometry = options.readGeometry();
      if (
        isUsableTerminalGeometry(
          geometry,
          options.minWidth,
          options.minHeight,
        )
      ) {
        stableFrames =
          previousGeometry && sameTerminalGeometry(previousGeometry, geometry)
            ? stableFrames + 1
            : 1;
        previousGeometry = geometry;
        if (stableFrames >= stableFrameTarget) {
          options.onStableGeometry(geometry);
          return;
        }
      } else {
        stableFrames = 0;
        previousGeometry = null;
      }

      if (framesObserved < maxFrames) schedule(activeGeneration);
    });
  };

  return {
    request: () => {
      if (disposed) return;
      resetPending();
      schedule(generation);
    },
    cancel: resetPending,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      resetPending();
    },
  };
}
