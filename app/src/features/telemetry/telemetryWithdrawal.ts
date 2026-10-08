import {
  getAccountTelemetryConsent,
  updateAccountTelemetryConsent,
} from './accountTelemetryConsent';
import type { AccountTelemetryResult } from './accountTelemetryConsent';
import type { TelemetryStorage } from './telemetryConsent';

const KEY = 'vibespace-telemetry-withdrawals-v1';
type Pending = Readonly<{ accountId: string; revision: string }>;
type Snapshot = Readonly<{
  pending: readonly Pending[];
  storageError: boolean;
  error: string | null;
}>;
type Transport = (accountId: string) => Promise<AccountTelemetryResult>;

/** Only withdrawal is retried. Enrollment always requires a fresh explicit action. */
export function createTelemetryWithdrawalQueue(storage: TelemetryStorage, transport: Transport) {
  let pending: Pending[] = [];
  try {
    const raw: unknown = JSON.parse(storage.getItem(KEY) ?? '[]');
    if (Array.isArray(raw))
      pending = raw
        .filter(
          (entry): entry is Pending =>
            entry &&
            typeof entry.accountId === 'string' &&
            entry.accountId.length <= 256 &&
            typeof entry.revision === 'string' &&
            entry.revision.length <= 100,
        )
        .slice(0, 32);
  } catch {
    /* An unreadable queue never enables collection. */
  }
  let snapshot: Snapshot = { pending, storageError: false, error: null };
  let inFlight: Promise<AccountTelemetryResult | undefined> | undefined;
  let inFlightAccount: string | null = null;
  const listeners = new Set<() => void>();
  const publish = (error: string | null = null) => {
    let storageError = false;
    try {
      storage.setItem(KEY, JSON.stringify(pending));
    } catch {
      storageError = true;
    }
    snapshot = { pending: [...pending], storageError, error };
    listeners.forEach((listener) => listener());
  };
  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    enqueue(accountId: string) {
      if (!accountId || accountId.length > 256) return false;
      if (!pending.some((entry) => entry.accountId === accountId) && pending.length >= 32)
        return false;
      pending = [
        ...pending.filter((entry) => entry.accountId !== accountId),
        { accountId, revision: crypto.randomUUID() },
      ];
      publish();
      return true;
    },
    flush(
      accountId: string | null,
      canDispatch: () => boolean = () => true,
    ): Promise<AccountTelemetryResult | undefined> {
      // A different account's transport may keep this request waiting past its
      // caller's lifetime. Recheck admission after that wait, before any I/O.
      if (!canDispatch()) return Promise.resolve(undefined);
      if (inFlight)
        return inFlightAccount === accountId
          ? inFlight
          : inFlight.then(() => this.flush(accountId, canDispatch));
      const entry = pending.find((candidate) => candidate.accountId === accountId);
      if (!entry) return Promise.resolve(undefined);
      inFlightAccount = entry.accountId;
      inFlight = (async () => {
        let result: AccountTelemetryResult;
        try {
          result = await transport(entry.accountId);
        } catch {
          result = { ok: false, error: 'request_failed' };
        }
        if (
          result.ok &&
          !result.state.enabled &&
          result.state.withdrawal?.status === 'reconciled'
        ) {
          pending = pending.filter((candidate) => candidate.revision !== entry.revision);
          publish();
        } else publish(result.ok ? 'withdrawal_not_confirmed' : result.error);
        return result;
      })().finally(() => {
        inFlight = undefined;
        inFlightAccount = null;
      });
      return inFlight;
    },
  };
}

const memory = new Map<string, string>();
const fallbackStorage: TelemetryStorage = {
  getItem: (key) => memory.get(key) ?? null,
  setItem: (key, value) => {
    memory.set(key, value);
    throw new Error('Persistent storage unavailable');
  },
  removeItem: (key) => {
    memory.delete(key);
  },
};
let storage: TelemetryStorage = fallbackStorage;
try {
  if (typeof window !== 'undefined') storage = window.localStorage;
} catch {
  /* memory retry */
}
export const telemetryWithdrawalQueue = createTelemetryWithdrawalQueue(
  storage,
  async (accountId) => {
    const current = await getAccountTelemetryConsent(accountId);
    if (!current.ok) return current;
    if (
      !current.state.enabled &&
      (current.state.withdrawal?.status === 'reconciled' ||
        (current.state.withdrawal?.requestRevision &&
          ['pending', 'failed'].includes(current.state.withdrawal.status)))
    )
      return current;
    return updateAccountTelemetryConsent(false, current.state, accountId);
  },
);
