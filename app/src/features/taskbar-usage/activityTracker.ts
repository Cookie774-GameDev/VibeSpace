export interface ProviderActivitySnapshot {
  total: number;
  byProvider: Record<string, number>;
}

export interface ProviderActivityTracker {
  begin(providerId: string): () => void;
  snapshot(): ProviderActivitySnapshot;
  subscribe(listener: (snapshot: ProviderActivitySnapshot) => void): () => void;
}

export function createProviderActivityTracker(): ProviderActivityTracker {
  const counts = new Map<string, number>();
  const listeners = new Set<(snapshot: ProviderActivitySnapshot) => void>();

  const snapshot = (): ProviderActivitySnapshot => {
    const byProvider = Object.fromEntries(
      [...counts.entries()]
        .filter(([, count]) => count > 0)
        .sort(([left], [right]) => left.localeCompare(right)),
    );
    return Object.freeze({
      total: Object.values(byProvider).reduce((sum, value) => sum + value, 0),
      byProvider: Object.freeze(byProvider),
    });
  };

  const notify = () => {
    const next = snapshot();
    for (const listener of listeners) listener(next);
  };

  return {
    begin(providerId) {
      const id = providerId.trim();
      if (!id) return () => undefined;
      counts.set(id, (counts.get(id) ?? 0) + 1);
      notify();
      let completed = false;
      return () => {
        if (completed) return;
        completed = true;
        const next = Math.max(0, (counts.get(id) ?? 1) - 1);
        if (next === 0) counts.delete(id);
        else counts.set(id, next);
        notify();
      };
    },
    snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export const providerActivityTracker = createProviderActivityTracker();
