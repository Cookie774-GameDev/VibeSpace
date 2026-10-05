export function createAccountHydrationAuthority(hydrate: (accountId: string) => Promise<void>): {
  ready: (accountId: string) => Promise<boolean>;
  invalidate: () => void;
} {
  const attempts = new Map<string, Promise<boolean>>();
  const ready = (accountId: string): Promise<boolean> => {
    const existing = attempts.get(accountId);
    if (existing) return existing;
    const pending: Promise<boolean> = hydrate(accountId).then(
      () => attempts.get(accountId) === pending,
      () => {
        if (attempts.get(accountId) === pending) attempts.delete(accountId);
        return false;
      },
    );
    attempts.set(accountId, pending);
    return pending;
  };
  return {
    ready,
    invalidate: () => attempts.clear(),
  };
}
