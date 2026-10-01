export interface UsageRefreshPolicy {
  ttlMs: number;
  force?: boolean;
}

export interface UsageRefreshState {
  failures: number;
  lastSuccessAt: number | null;
  nextRetryAt: number | null;
}

interface CoordinatorOptions {
  now?: () => number;
  random?: () => number;
  maxConcurrent?: number;
}

const BACKOFF_MS = [5_000, 15_000, 30_000, 60_000, 120_000, 300_000] as const;

export function createUsageRefreshCoordinator(options: CoordinatorOptions = {}) {
  const now = options.now ?? Date.now;
  const random = options.random ?? Math.random;
  const maxConcurrent = Math.min(5, Math.max(1, Math.floor(options.maxConcurrent ?? 4)));
  const flights = new Map<string, Promise<unknown>>();
  const states = new Map<string, UsageRefreshState>();
  const queue: Array<() => void> = [];
  let active = 0;
  let online = true;

  const getState = (key: string): UsageRefreshState =>
    states.get(key) ?? {
      failures: 0,
      lastSuccessAt: null,
      nextRetryAt: null,
    };

  const drain = (): void => {
    while (active < maxConcurrent && queue.length > 0) {
      queue.shift()?.();
    }
  };

  return {
    setOnline(value: boolean): void {
      online = value;
    },
    getState,
    run<T>(
      key: string,
      operation: () => Promise<T>,
      policy: UsageRefreshPolicy,
    ): Promise<T | undefined> {
      const existing = flights.get(key) as Promise<T> | undefined;
      if (existing) return existing;
      const current = getState(key);
      const currentTime = now();
      if (!online) return Promise.resolve(undefined);
      if (
        !policy.force &&
        ((current.nextRetryAt !== null && currentTime < current.nextRetryAt) ||
          (current.lastSuccessAt !== null && currentTime - current.lastSuccessAt < policy.ttlMs))
      ) {
        return Promise.resolve(undefined);
      }

      const flight = new Promise<T | undefined>((resolve, reject) => {
        queue.push(() => {
          if (!online) {
            flights.delete(key);
            resolve(undefined);
            return;
          }
          active += 1;
          let operationResult: Promise<T>;
          try {
            operationResult = operation();
          } catch (error) {
            operationResult = Promise.reject(error);
          }
          operationResult
            .then((value) => {
              states.set(key, {
                failures: 0,
                lastSuccessAt: now(),
                nextRetryAt: null,
              });
              resolve(value);
            })
            .catch((error: unknown) => {
              const failures = current.failures + 1;
              const base = BACKOFF_MS[Math.min(failures - 1, BACKOFF_MS.length - 1)];
              const jitter = Math.round(base * ((random() - 0.5) * 0.2));
              states.set(key, {
                failures,
                lastSuccessAt: current.lastSuccessAt,
                nextRetryAt: now() + base + jitter,
              });
              reject(error);
            })
            .finally(() => {
              active -= 1;
              flights.delete(key);
              drain();
            });
        });
      });
      flights.set(key, flight);
      drain();
      return flight;
    },
  };
}
