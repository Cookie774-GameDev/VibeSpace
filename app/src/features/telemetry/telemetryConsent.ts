export const TELEMETRY_CONSENT_KEY = 'vibespace-telemetry-consent-v1';
export const TELEMETRY_AUDIT_KEY = 'vibespace-telemetry-consent-audit-v1';
const MAX_AUDIT_RECORDS = 100;

export type TelemetryDataClass = 'product_usage' | 'diagnostics' | 'tool_outcomes';
export type TelemetryConsent = Readonly<{
  productUsage: boolean;
  diagnostics: boolean;
  toolOutcomes: boolean;
}>;

export const DEFAULT_TELEMETRY_CONSENT: TelemetryConsent = Object.freeze({
  productUsage: false,
  diagnostics: false,
  toolOutcomes: false,
});

export type TelemetryAuditRecord = Readonly<{
  at: number;
  action: 'consent_updated' | 'consent_revoked';
  enabledClasses: readonly TelemetryDataClass[];
}>;

export interface TelemetryStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export type TelemetryReward = Readonly<{
  configured: boolean;
  label: string | null;
  status: 'eligible' | 'unavailable';
}>;

export type TelemetrySnapshot = Readonly<{
  consent: TelemetryConsent;
  audit: readonly TelemetryAuditRecord[];
  reward: TelemetryReward;
}>;

function parseConsent(raw: string | null): TelemetryConsent {
  if (!raw) return DEFAULT_TELEMETRY_CONSENT;
  try {
    const value = JSON.parse(raw) as Partial<TelemetryConsent>;
    return Object.freeze({
      productUsage: value.productUsage === true,
      diagnostics: value.diagnostics === true,
      toolOutcomes: value.toolOutcomes === true,
    });
  } catch {
    return DEFAULT_TELEMETRY_CONSENT;
  }
}

function parseAudit(raw: string | null): readonly TelemetryAuditRecord[] {
  if (!raw) return Object.freeze([]);
  try {
    const value = JSON.parse(raw) as unknown;
    if (!Array.isArray(value)) return Object.freeze([]);
    return Object.freeze(
      value
        .filter(
          (item): item is TelemetryAuditRecord =>
            typeof item === 'object' &&
            item !== null &&
            typeof (item as TelemetryAuditRecord).at === 'number' &&
            ['consent_updated', 'consent_revoked'].includes(
              (item as TelemetryAuditRecord).action,
            ) &&
            Array.isArray((item as TelemetryAuditRecord).enabledClasses),
        )
        .slice(-MAX_AUDIT_RECORDS),
    );
  } catch {
    return Object.freeze([]);
  }
}

function enabledClasses(consent: TelemetryConsent): TelemetryDataClass[] {
  const enabled: TelemetryDataClass[] = [];
  if (consent.productUsage) enabled.push('product_usage');
  if (consent.diagnostics) enabled.push('diagnostics');
  if (consent.toolOutcomes) enabled.push('tool_outcomes');
  return enabled;
}

export function createTelemetryConsentStore(
  storage: TelemetryStorage,
  now: () => number = Date.now,
  rewardConfig: { label?: string } = {
    label: import.meta.env.VITE_TELEMETRY_REWARD_LABEL,
  },
) {
  const listeners = new Set<() => void>();
  const rewardLabel = rewardConfig.label?.trim() || null;
  let snapshot: TelemetrySnapshot = Object.freeze({
    consent: parseConsent(storage.getItem(TELEMETRY_CONSENT_KEY)),
    audit: parseAudit(storage.getItem(TELEMETRY_AUDIT_KEY)),
    reward: Object.freeze({
      configured: rewardLabel !== null,
      label: rewardLabel,
      status: rewardLabel ? 'eligible' : 'unavailable',
    }),
  });

  const publish = (consent: TelemetryConsent, audit: readonly TelemetryAuditRecord[]) => {
    snapshot = Object.freeze({ ...snapshot, consent, audit: Object.freeze([...audit]) });
    storage.setItem(TELEMETRY_CONSENT_KEY, JSON.stringify(consent));
    storage.setItem(TELEMETRY_AUDIT_KEY, JSON.stringify(audit));
    listeners.forEach((listener) => listener());
  };

  const record = (
    consent: TelemetryConsent,
    action: TelemetryAuditRecord['action'],
  ): TelemetryAuditRecord =>
    Object.freeze({ at: now(), action, enabledClasses: Object.freeze(enabledClasses(consent)) });

  return Object.freeze({
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    updateConsent(patch: Partial<TelemetryConsent>) {
      const consent = Object.freeze({ ...snapshot.consent, ...patch });
      publish(consent, [...snapshot.audit, record(consent, 'consent_updated')].slice(-100));
    },
    revoke() {
      publish(
        DEFAULT_TELEMETRY_CONSENT,
        [...snapshot.audit, record(DEFAULT_TELEMETRY_CONSENT, 'consent_revoked')].slice(-100),
      );
    },
    exportAudit() {
      return JSON.stringify(
        {
          schemaVersion: 1,
          exportedAt: now(),
          consent: snapshot.consent,
          audit: snapshot.audit,
        },
        null,
        2,
      );
    },
    deleteAudit() {
      snapshot = Object.freeze({ ...snapshot, audit: Object.freeze([]) });
      storage.removeItem(TELEMETRY_AUDIT_KEY);
      listeners.forEach((listener) => listener());
    },
    resetForTests() {
      storage.removeItem(TELEMETRY_CONSENT_KEY);
      storage.removeItem(TELEMETRY_AUDIT_KEY);
      snapshot = Object.freeze({
        ...snapshot,
        consent: DEFAULT_TELEMETRY_CONSENT,
        audit: Object.freeze([]),
      });
      listeners.forEach((listener) => listener());
    },
  });
}

const fallbackStorage: TelemetryStorage = {
  getItem: () => null,
  setItem: () => undefined,
  removeItem: () => undefined,
};

export const telemetryConsentStore = createTelemetryConsentStore(
  typeof window === 'undefined' ? fallbackStorage : window.localStorage,
);
