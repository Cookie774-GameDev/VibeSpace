export type BrowserAgentSource = 'isolated' | 'approved_existing';
export type BrowserAgentPreferredBrowser = 'vibespace' | 'system' | 'chrome' | 'edge';

export interface BrowserAgentPreferences {
  readonly enabled: boolean;
  readonly source: BrowserAgentSource;
  readonly preferredBrowser: BrowserAgentPreferredBrowser;
  readonly autoReconnectApprovedMcps: boolean;
  readonly askBeforeWebsiteSubmission: boolean;
  readonly askBeforeTransfers: boolean;
  readonly askBeforeExternalCommitment: boolean;
  readonly isolateSessions: boolean;
  readonly sessionEpoch: number;
}

const STORAGE_KEY = 'vibespace.browser-agent.preferences.v1';
const DEFAULTS: BrowserAgentPreferences = Object.freeze({
  enabled: false,
  source: 'isolated',
  preferredBrowser: 'vibespace',
  autoReconnectApprovedMcps: true,
  askBeforeWebsiteSubmission: true,
  askBeforeTransfers: true,
  askBeforeExternalCommitment: true,
  isolateSessions: true,
  sessionEpoch: 0,
});

function load(): BrowserAgentPreferences {
  if (typeof window === 'undefined') return DEFAULTS;
  try {
    const value = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? 'null') as
      | Partial<BrowserAgentPreferences>
      | null;
    if (!value || typeof value !== 'object') return DEFAULTS;
    return Object.freeze({
      enabled: value.enabled === true,
      source: value.source === 'approved_existing' ? 'approved_existing' : 'isolated',
      preferredBrowser: ['vibespace', 'system', 'chrome', 'edge'].includes(
        value.preferredBrowser ?? '',
      )
        ? (value.preferredBrowser as BrowserAgentPreferredBrowser)
        : 'vibespace',
      autoReconnectApprovedMcps: value.autoReconnectApprovedMcps !== false,
      askBeforeWebsiteSubmission: value.askBeforeWebsiteSubmission !== false,
      askBeforeTransfers: value.askBeforeTransfers !== false,
      askBeforeExternalCommitment: value.askBeforeExternalCommitment !== false,
      isolateSessions: value.isolateSessions !== false,
      sessionEpoch:
        Number.isSafeInteger(value.sessionEpoch) && (value.sessionEpoch ?? -1) >= 0
          ? value.sessionEpoch!
          : 0,
    });
  } catch {
    return DEFAULTS;
  }
}

let snapshot = load();
const listeners = new Set<() => void>();

function publish(next: BrowserAgentPreferences): void {
  snapshot = Object.freeze(next);
  if (typeof window !== 'undefined') {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot));
  }
  listeners.forEach((listener) => listener());
}

export const browserAgentPreferences = Object.freeze({
  getSnapshot: () => snapshot,
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  update(patch: Partial<Omit<BrowserAgentPreferences, 'sessionEpoch'>>): void {
    publish({ ...snapshot, ...patch });
  },
  clearSession(): void {
    const nextEpoch = snapshot.sessionEpoch + 1;
    publish({ ...snapshot, sessionEpoch: nextEpoch });
    if (typeof window !== 'undefined') {
      window.dispatchEvent(
        new CustomEvent('vibespace:browser-agent:clear-session', {
          detail: Object.freeze({ sessionEpoch: nextEpoch }),
        }),
      );
    }
  },
});
