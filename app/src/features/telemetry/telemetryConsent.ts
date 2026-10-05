import type { AccountTelemetryConsent } from './accountTelemetryConsent';
import {
  APP_DIAGNOSTICS_SCOPE,
  APP_DIAGNOSTICS_POLICY_VERSION,
} from '../../../../supabase/functions/_shared/telemetrySchema';

export const TELEMETRY_CONSENT_KEY = 'vibespace-telemetry-consent-v1';
export const TELEMETRY_AUDIT_KEY = 'vibespace-telemetry-consent-audit-v1';
export const APP_DIAGNOSTICS_CONSENT_KEY = 'vibespace-app-diagnostics-consent-v1';
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
  storageError: boolean;
  revision: number;
  appDiagnosticsConsent: AppDiagnosticsConsent | null;
  consent: TelemetryConsent;
  audit: readonly TelemetryAuditRecord[];
  reward: TelemetryReward;
}>;

export type AppDiagnosticsConsent = Readonly<{
  accountId: string;
  policyVersion: typeof APP_DIAGNOSTICS_POLICY_VERSION;
  scope: typeof APP_DIAGNOSTICS_SCOPE;
  acceptedAt: number;
}>;

export function offersAppDiagnostics(state: AccountTelemetryConsent | null): boolean {
  return (
    state?.policyVersion === APP_DIAGNOSTICS_POLICY_VERSION &&
    state.diagnosticsScope === APP_DIAGNOSTICS_SCOPE &&
    state.supportedSchemaVersions?.join(',') === '1,2'
  );
}

function serverAcceptedAppDiagnostics(state: AccountTelemetryConsent | null): boolean {
  return (
    offersAppDiagnostics(state) &&
    state?.enabled === true &&
    state.eligible === true &&
    state.acceptedPolicyVersion === APP_DIAGNOSTICS_POLICY_VERSION &&
    state.acceptedDiagnosticsScope === APP_DIAGNOSTICS_SCOPE &&
    !['pending', 'failed'].includes(state.withdrawal?.status ?? '')
  );
}

function allClasses(consent: TelemetryConsent): boolean {
  return consent.productUsage && consent.diagnostics && consent.toolOutcomes;
}

/** Collector admission only; a current verified server state is required every time. */
export function canCollectAppDiagnostics(
  snapshot: TelemetrySnapshot,
  accountId: string | null,
  server: AccountTelemetryConsent | null,
): boolean {
  const accepted = snapshot.appDiagnosticsConsent;
  return (
    !!accountId &&
    !snapshot.storageError &&
    allClasses(snapshot.consent) &&
    accepted?.accountId === accountId &&
    accepted.policyVersion === APP_DIAGNOSTICS_POLICY_VERSION &&
    accepted.scope === APP_DIAGNOSTICS_SCOPE &&
    serverAcceptedAppDiagnostics(server)
  );
}

function parseDiagnosticsAcceptanceId(raw: string | null): string | null {
  if (!raw) return null;
  try {
    const id = JSON.parse(raw)?.appDiagnosticsAcceptanceId;
    return typeof id === 'string' &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)
      ? id
      : null;
  } catch {
    return null;
  }
}

function parseAppDiagnosticsConsent(
  raw: string | null,
  acceptanceId: string | null,
): AppDiagnosticsConsent | null {
  if (!raw || !acceptanceId) return null;
  try {
    const value = JSON.parse(raw);
    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      Object.keys(value).some(
        (key) =>
          !['accountId', 'policyVersion', 'scope', 'acceptedAt', 'acceptanceId'].includes(key),
      ) ||
      value.acceptanceId !== acceptanceId ||
      typeof value.accountId !== 'string' ||
      !value.accountId.trim() ||
      value.accountId.length > 160 ||
      value.policyVersion !== APP_DIAGNOSTICS_POLICY_VERSION ||
      value.scope !== APP_DIAGNOSTICS_SCOPE ||
      !Number.isSafeInteger(value.acceptedAt) ||
      value.acceptedAt < 0
    )
      return null;
    return Object.freeze({
      accountId: value.accountId,
      policyVersion: value.policyVersion,
      scope: value.scope,
      acceptedAt: value.acceptedAt,
    });
  } catch {
    return null;
  }
}

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
  let storageError = false;
  const read = (key: string) => {
    try {
      return storage.getItem(key);
    } catch {
      storageError = true;
      return null;
    }
  };
  const persistedConsent = read(TELEMETRY_CONSENT_KEY);
  const consent = parseConsent(persistedConsent);
  const audit = parseAudit(read(TELEMETRY_AUDIT_KEY));
  let appDiagnosticsAcceptanceId = allClasses(consent)
    ? parseDiagnosticsAcceptanceId(persistedConsent)
    : null;
  const appDiagnosticsConsent = parseAppDiagnosticsConsent(
    read(APP_DIAGNOSTICS_CONSENT_KEY),
    appDiagnosticsAcceptanceId,
  );
  let snapshot: TelemetrySnapshot = Object.freeze({
    storageError,
    revision: 0,
    appDiagnosticsConsent: allClasses(consent) ? appDiagnosticsConsent : null,
    consent,
    audit,
    reward: Object.freeze({
      configured: rewardLabel !== null,
      label: rewardLabel,
      status: rewardLabel ? 'eligible' : 'unavailable',
    }),
  });

  const publish = (
    consent: TelemetryConsent,
    audit: readonly TelemetryAuditRecord[],
    expanded: AppDiagnosticsConsent | null = allClasses(consent)
      ? snapshot.appDiagnosticsConsent
      : null,
    acceptanceId: string | null = expanded ? appDiagnosticsAcceptanceId : null,
  ) => {
    appDiagnosticsAcceptanceId = expanded ? acceptanceId : null;
    snapshot = Object.freeze({
      ...snapshot,
      consent,
      audit: Object.freeze([...audit]),
      revision: snapshot.revision + 1,
      appDiagnosticsConsent: expanded,
    });
    let failed = false;
    const persist = (write: () => void) => {
      try {
        write();
      } catch {
        failed = true;
      }
    };
    // The legacy preference write invalidates the binding independently of scope-key cleanup.
    // Restoration requires both records to name the same explicit acceptance.
    persist(() => storage.removeItem(APP_DIAGNOSTICS_CONSENT_KEY));
    persist(() =>
      storage.setItem(
        TELEMETRY_CONSENT_KEY,
        JSON.stringify({ ...consent, appDiagnosticsAcceptanceId }),
      ),
    );
    persist(() => storage.setItem(TELEMETRY_AUDIT_KEY, JSON.stringify(audit)));
    if (expanded && !failed)
      persist(() =>
        storage.setItem(
          APP_DIAGNOSTICS_CONSENT_KEY,
          JSON.stringify({ ...expanded, acceptanceId: appDiagnosticsAcceptanceId }),
        ),
      );
    if (failed) appDiagnosticsAcceptanceId = null;
    snapshot = Object.freeze({
      ...snapshot,
      storageError: failed,
      appDiagnosticsConsent: failed ? null : expanded,
    });
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
    acceptAppDiagnostics(accountId: string, server: AccountTelemetryConsent): boolean {
      if (
        !accountId.trim() ||
        accountId.length > 160 ||
        snapshot.storageError ||
        !allClasses(snapshot.consent) ||
        !serverAcceptedAppDiagnostics(server)
      )
        return false;
      const acceptedAt = now();
      if (!Number.isSafeInteger(acceptedAt) || acceptedAt < 0) return false;
      publish(
        snapshot.consent,
        snapshot.audit,
        Object.freeze({
          accountId,
          policyVersion: APP_DIAGNOSTICS_POLICY_VERSION,
          scope: APP_DIAGNOSTICS_SCOPE,
          acceptedAt,
        }),
        crypto.randomUUID(),
      );
      return !snapshot.storageError;
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
      appDiagnosticsAcceptanceId = null;
      storage.removeItem(TELEMETRY_CONSENT_KEY);
      storage.removeItem(TELEMETRY_AUDIT_KEY);
      storage.removeItem(APP_DIAGNOSTICS_CONSENT_KEY);
      snapshot = Object.freeze({
        ...snapshot,
        consent: DEFAULT_TELEMETRY_CONSENT,
        appDiagnosticsConsent: null,
        revision: snapshot.revision + 1,
        audit: Object.freeze([]),
      });
      listeners.forEach((listener) => listener());
    },
  });
}

const fallbackStorage: TelemetryStorage = {
  getItem: () => null,
  setItem: () => {
    throw new Error('Storage unavailable');
  },
  removeItem: () => undefined,
};

function browserStorage(): TelemetryStorage {
  try {
    return typeof window === 'undefined' ? fallbackStorage : window.localStorage;
  } catch {
    return fallbackStorage;
  }
}
export const telemetryConsentStore = createTelemetryConsentStore(browserStorage());
