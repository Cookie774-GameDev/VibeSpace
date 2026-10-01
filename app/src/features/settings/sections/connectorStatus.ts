import type { ConnectionMetadataRecord } from '@/lib/ai/connectionState';
import type { ProviderConnection } from '@/lib/ai/adapters/types';

/** User-facing connector lifecycle states for Settings → AI Connectors. */
export type ConnectorUiStatus =
  | 'checking'
  | 'signed-in'
  | 'configured'
  | 'detected'
  | 'unavailable'
  | 'disabled'
  | 'expired'
  | 'error'
  | 'not-checked';

export interface ConnectorStatusInput {
  connection: Readonly<ProviderConnection>;
  record?: ConnectionMetadataRecord;
  /** In-flight refresh/scan for this card. */
  checking?: boolean;
  /** Transient action/probe failure message. */
  error?: string | null;
  /** Native API key present (or local runtime ready). */
  credentialsReady?: boolean;
}

export function resolveConnectorUiStatus(input: ConnectorStatusInput): ConnectorUiStatus {
  const { connection, record, checking, error, credentialsReady } = input;
  if (checking) return 'checking';
  if (error) return 'error';
  if (record?.disabled) return 'disabled';

  if (connection.mode === 'external-cli') {
    if (!record || record.lastCheckedAt == null) return 'not-checked';
    if (record.installation === 'not-installed') return 'unavailable';
    if (record.installation === 'unknown') return 'error';
    // installed
    if (record.auth === 'authenticated') return 'signed-in';
    if (record.auth === 'unauthenticated') return 'detected';
    return 'detected';
  }

  if (connection.mode === 'local') {
    return credentialsReady ? 'configured' : 'unavailable';
  }

  // native-api
  if (credentialsReady) return 'configured';
  if (record?.auth === 'authenticated') return 'configured';
  if (record?.lastCheckedAt != null && !credentialsReady) return 'unavailable';
  return 'not-checked';
}

export function connectorStatusLabel(status: ConnectorUiStatus): string {
  switch (status) {
    case 'checking':
      return 'Checking…';
    case 'signed-in':
      return 'Signed in (subscription)';
    case 'configured':
      return 'Configured (API key)';
    case 'detected':
      return 'Detected · sign-in required';
    case 'unavailable':
      return 'Unavailable';
    case 'disabled':
      return 'Disabled';
    case 'expired':
      return 'Session expired';
    case 'error':
      return 'Error';
    case 'not-checked':
      return 'Not checked';
  }
}

export function connectorModeLabel(mode: ProviderConnection['mode']): string {
  switch (mode) {
    case 'external-cli':
      return 'CLI subscription bridge';
    case 'native-api':
      return 'API key connection';
    case 'local':
      return 'Local runtime';
  }
}

export function connectorStatusTone(
  status: ConnectorUiStatus,
): 'success' | 'warning' | 'danger' | 'muted' | 'info' {
  switch (status) {
    case 'signed-in':
    case 'configured':
      return 'success';
    case 'detected':
    case 'checking':
    case 'not-checked':
      return 'info';
    case 'expired':
    case 'error':
      return 'danger';
    case 'unavailable':
    case 'disabled':
      return 'muted';
  }
}
