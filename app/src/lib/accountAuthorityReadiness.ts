import {
  getLocalAccountReadyReceipt,
  subscribeLocalAccountReadiness,
  type LocalAccountReadyReceipt,
} from './localAccountReadiness';

/**
 * Frontend lifecycle observations only. `generation` is NOT a native account
 * epoch or authorization receipt. Cloud identity comes from the existing cached
 * SDK lifecycle, not a fresh server getUser verification. A native consumer must
 * independently bind host/engine lifetime and project/process/credential evidence.
 * No session, token, credential or native grant is accepted or exposed here.
 */
export type AccountAuthorityReadinessSnapshot =
  | Readonly<{ state: 'unready'; generation: number }>
  | Readonly<{
      state: 'cloud';
      source: 'supabase-sdk-cache';
      accountId: string;
      generation: number;
    }>
  | Readonly<{
      state: 'local';
      accountId: string;
      generation: number;
      persistenceGeneration: number;
      localReadinessGeneration: number;
    }>;

let generation = 0;
let snapshot: AccountAuthorityReadinessSnapshot = Object.freeze({ state: 'unready', generation });
const listeners = new Set<() => void>();
let activeOwner: { stopLocalObservation: () => void } | undefined;

function publish(next: AccountAuthorityReadinessSnapshot): void {
  snapshot = Object.freeze(next);
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch {
      // Observation must not interrupt auth teardown or prevent another observer.
      console.error('[account-readiness] isolated an observation subscriber failure.');
    }
  }
}

/** Stable read-only facade suitable for useSyncExternalStore. */
export const accountAuthorityReadiness = Object.freeze({
  getSnapshot: (): AccountAuthorityReadinessSnapshot => snapshot,
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
});

/**
 * App boot-owner hook only, not a renderer/native authority setter. Every accepted
 * auth result starts an observation transition even when the account ID matches.
 * A replacement owns the publisher; stale cleanup and completions are inert.
 */
export function createAccountAuthorityPublisher() {
  activeOwner?.stopLocalObservation();
  const owner = { stopLocalObservation: () => {} };
  activeOwner = owner;
  let disposed = false;
  let currentTransition: object | undefined;
  let followingLocal = false;
  let observedLocal: LocalAccountReadyReceipt | null = null;
  const isOwnerCurrent = () => !disposed && activeOwner === owner;

  function observeLocal(): void {
    if (!isOwnerCurrent() || !followingLocal) return;
    const receipt = getLocalAccountReadyReceipt();
    if (receipt === observedLocal) return;
    observedLocal = receipt;
    if (receipt) {
      publish({
        state: 'local',
        accountId: receipt.accountId,
        generation: ++generation,
        persistenceGeneration: receipt.persistenceGeneration,
        localReadinessGeneration: receipt.generation,
      });
    } else {
      publish({ state: 'unready', generation: ++generation });
    }
  }
  owner.stopLocalObservation = subscribeLocalAccountReadiness(observeLocal);

  function beginTransition() {
    const transition = {};
    let used = false;
    let transitionGeneration = generation;
    if (isOwnerCurrent()) {
      currentTransition = transition;
      followingLocal = false;
      observedLocal = null;
      transitionGeneration = ++generation;
      publish({ state: 'unready', generation: transitionGeneration });
    }
    const isCurrent = () => isOwnerCurrent() && currentTransition === transition;
    return Object.freeze({
      async settleCloud(input: {
        accountId: string;
        teardown: Promise<void>;
        isCurrent: () => boolean;
      }): Promise<void> {
        // Consume even a rejected barrier when invalidated before its settlement.
        const eligible = !used && isCurrent();
        used = true;
        try {
          const initiallyCurrent = eligible && input.isCurrent();
          await input.teardown;
          if (
            !initiallyCurrent ||
            !isCurrent() ||
            !input.isCurrent() ||
            !isCurrent() ||
            !input.accountId ||
            input.accountId.trim() !== input.accountId
          )
            return;
          publish({
            state: 'cloud',
            source: 'supabase-sdk-cache',
            accountId: input.accountId,
            generation: transitionGeneration,
          });
        } catch {
          // Failed verification/currentness/teardown cannot establish readiness.
        }
      },
      followLocalReadiness(): void {
        if (used || !isCurrent()) return;
        used = true;
        followingLocal = true;
        observeLocal();
      },
    });
  }

  beginTransition();
  return Object.freeze({
    beginTransition,
    revoke: (): void => {
      beginTransition();
    },
    dispose(): void {
      if (disposed) return;
      owner.stopLocalObservation();
      if (isOwnerCurrent()) {
        activeOwner = undefined;
        publish({ state: 'unready', generation: ++generation });
      }
      disposed = true;
      currentTransition = undefined;
      followingLocal = false;
    },
  });
}
