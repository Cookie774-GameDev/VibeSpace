import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { formatUserDateTime } from '@/lib/timeFormat';
import { PROVIDER_CATALOG, PROVIDER_CONNECTIONS } from '@/lib/ai/adapters/catalog';
import type {
  AuthProbeResult,
  DetectionResult,
  ProviderAdapter,
  ProviderConnection,
} from '@/lib/ai/adapters/types';
import { codexCliAdapter } from '@/lib/ai/adapters/codex';
import { claudeCliAdapter } from '@/lib/ai/adapters/claude';
import { geminiCliAdapter } from '@/lib/ai/adapters/gemini';
import { copilotCliAdapter } from '@/lib/ai/adapters/copilot';
import { qwenCliAdapter } from '@/lib/ai/adapters/qwen';
import { openCodeCliAdapter } from '@/lib/ai/adapters/opencode';
import { ensureExternalConnectionAutoDetection } from '@/lib/ai/adapters/autoDetectConnections';
import {
  AI_CONNECTION_STATE_EVENT,
  markConnectionSessionChecked,
  readConnectionMetadata,
  readConnectionMetadataRevision,
  writeConnectionMetadata,
  type ConnectionMetadata,
  type ConnectionMetadataRecord,
} from '@/lib/ai/connectionState';
import { useAuthStore } from '@/stores/auth';
import { useUIStore } from '@/stores/ui';
import { rememberSettingsTab } from '@/features/settings/settingsTabMemory';
import { openExternal } from '@/lib/tauri';
import { toast } from '@/components/ui/toast';
import { cn } from '@/lib/utils';
import { ConnectorBrandMark } from './ConnectorBrandMark';
import {
  connectorModeLabel,
  connectorStatusLabel,
  connectorStatusTone,
  resolveConnectorUiStatus,
  type ConnectorUiStatus,
} from './connectorStatus';
import type { ProviderId } from '@/types/common';
import { McpConnections } from './McpConnections';

export type { ConnectionMetadata, ConnectionMetadataRecord } from '@/lib/ai/connectionState';
export type ConnectionAction =
  | 'refresh'
  | 'sign-in'
  | 'configure'
  | 'disable'
  | 'enable'
  | 'clear-scan'
  | 'add-api-key';

export interface SubscriptionCliBridgeProps {
  records?: ConnectionMetadata;
  onScan?: () => void | Promise<void>;
  onRefresh?: (connection: Readonly<ProviderConnection>) => void | Promise<void>;
  onSignIn?: (connection: Readonly<ProviderConnection>) => void | Promise<void>;
  onAction?: (
    action: ConnectionAction,
    connection: Readonly<ProviderConnection>,
  ) => void | Promise<void>;
  /** When false, skip automatic session scan (tests). Default true. */
  autoDetect?: boolean;
}

const ADAPTERS: Readonly<Record<string, ProviderAdapter>> = Object.freeze(
  Object.fromEntries(
    [
      codexCliAdapter,
      claudeCliAdapter,
      geminiCliAdapter,
      copilotCliAdapter,
      qwenCliAdapter,
      openCodeCliAdapter,
    ].map((adapter) => [adapter.id, adapter]),
  ),
);

/** Official docs for user-driven CLI login (never scrape tokens). */
const CLI_SIGN_IN_DOCS: Readonly<Partial<Record<string, string>>> = Object.freeze({
  'openai-codex': 'https://github.com/openai/codex#authenticating-with-chatgpt',
  'anthropic-claude-code': 'https://docs.anthropic.com/en/docs/claude-code/setup',
  'google-gemini-cli': 'https://github.com/google-gemini/gemini-cli',
  'github-copilot-cli': 'https://docs.github.com/en/copilot/github-copilot-in-the-cli',
  'qwen-code': 'https://github.com/QwenLM/qwen-code',
  'opencode-cli': 'https://opencode.ai/docs',
});

const CLI_SIGN_IN_HINT: Readonly<Partial<Record<string, string>>> = Object.freeze({
  'openai-codex': 'Run `codex login` in a terminal, then Refresh here.',
  'anthropic-claude-code':
    'Run `claude auth login` (or your Claude Code login flow), then Refresh.',
  'google-gemini-cli': 'Complete Gemini CLI login in a terminal, then Refresh.',
  'github-copilot-cli': 'Run `copilot login` / `gh auth login`, then Refresh.',
  'qwen-code': 'Complete Qwen Code CLI login in a terminal, then Refresh.',
  'opencode-cli': 'Configure OpenCode auth providers, then Refresh.',
});

function persistMetadata(metadata: ConnectionMetadata): void {
  writeConnectionMetadata(metadata);
}

function sameConnectionMetadataRecord(
  left: ConnectionMetadataRecord | undefined,
  right: ConnectionMetadataRecord | undefined,
): boolean {
  if (!left || !right) return left === right;
  return (
    left.installation === right.installation &&
    left.auth === right.auth &&
    left.executablePath === right.executablePath &&
    left.version === right.version &&
    left.lastCheckedAt === right.lastCheckedAt &&
    left.disabled === right.disabled
  );
}

export function mergeConnectionInspectionIfUnchanged(
  current: ConnectionMetadata,
  connectionId: string,
  baseline: ConnectionMetadataRecord | undefined,
  inspected: ConnectionMetadataRecord,
  baselineRevision: number,
  currentRevision: number,
): ConnectionMetadata {
  if (currentRevision !== baselineRevision) return current;
  if (!sameConnectionMetadataRecord(current[connectionId], baseline)) return current;
  return { ...current, [connectionId]: inspected };
}

function capabilitySummary(connection: Readonly<ProviderConnection>): string {
  const labels = [
    connection.capabilities.images && 'images',
    connection.capabilities.files && 'files',
    connection.capabilities.tools && 'tools',
    connection.capabilities.streaming && 'streaming',
    connection.capabilities.usage && 'usage',
  ].filter(Boolean);
  return labels.length > 0 ? labels.join(' · ') : 'text';
}

function statusBadgeVariant(
  tone: ReturnType<typeof connectorStatusTone>,
): 'success' | 'outline' | 'destructive' | 'secondary' | 'default' {
  switch (tone) {
    case 'success':
      return 'success';
    case 'danger':
      return 'destructive';
    case 'warning':
    case 'info':
      return 'secondary';
    case 'muted':
    default:
      return 'outline';
  }
}

function productTitle(connection: Readonly<ProviderConnection>): string {
  // Prefer short product names in hierarchy (Claude, Codex) while keeping mode separate.
  return connection.displayName
    .replace(/\s+CLI$/i, '')
    .replace(/\s+API$/i, '')
    .replace(/\s+Bridge$/i, '')
    .trim();
}

export function SubscriptionCliBridge({
  records,
  onScan,
  onRefresh,
  onSignIn,
  onAction,
  autoDetect = true,
}: SubscriptionCliBridgeProps) {
  const [busy, setBusy] = useState(false);
  const [checkingIds, setCheckingIds] = useState<ReadonlySet<string>>(() => new Set());
  const [errors, setErrors] = useState<Partial<Record<string, string>>>({});
  const [selectedRouteByFamily, setSelectedRouteByFamily] = useState<
    Partial<Record<string, string>>
  >({});
  const [metadata, setMetadata] = useState<ConnectionMetadata>(
    () => records ?? readConnectionMetadata(),
  );
  const apiKeys = useAuthStore((s) => s.apiKeys);
  const offlineMode = useAuthStore((s) => s.offlineMode);
  const setSettingsOpen = useUIStore((s) => s.setSettingsOpen);

  useEffect(() => {
    if (records) return undefined;
    const syncMetadata = () => setMetadata(readConnectionMetadata());
    window.addEventListener(AI_CONNECTION_STATE_EVENT, syncMetadata);
    return () => window.removeEventListener(AI_CONNECTION_STATE_EVENT, syncMetadata);
  }, [records]);

  // Automatic read-only detection of installed CLIs + signed-in sessions.
  useEffect(() => {
    if (!autoDetect || records) return;
    let cancelled = false;
    setBusy(true);
    void ensureExternalConnectionAutoDetection()
      .then((next) => {
        if (!cancelled) setMetadata(next);
      })
      .catch(() => {
        /* keep last known metadata; user can Scan */
      })
      .finally(() => {
        if (!cancelled) setBusy(false);
      });
    return () => {
      cancelled = true;
    };
  }, [autoDetect, records]);

  const credentialsReadyByConnection = useMemo(() => {
    const map: Record<string, boolean> = {};
    for (const connection of PROVIDER_CONNECTIONS) {
      if (connection.mode === 'local') {
        map[connection.id] = true; // local path is always selectable; offline is separate
        continue;
      }
      if (connection.mode === 'native-api') {
        const provider = connection.providerId as ProviderId;
        map[connection.id] = Boolean(apiKeys[provider]?.trim());
        continue;
      }
      map[connection.id] = false;
    }
    return map;
  }, [apiKeys, offlineMode]);

  const setChecking = (connectionId: string, value: boolean) => {
    setCheckingIds((prev) => {
      const next = new Set(prev);
      if (value) next.add(connectionId);
      else next.delete(connectionId);
      return next;
    });
  };

  const inspect = useCallback(
    async (connection: Readonly<ProviderConnection>) => {
      const adapter = ADAPTERS[connection.adapterId];
      setChecking(connection.id, true);
      setErrors((prev) => {
        const next = { ...prev };
        delete next[connection.id];
        return next;
      });
      try {
        if (connection.mode !== 'external-cli' || !adapter?.detect) {
          // Native/local: refresh last-check stamp only.
          setMetadata((current) => {
            const next = {
              ...current,
              [connection.id]: {
                installation: 'installed' as const,
                auth: (credentialsReadyByConnection[connection.id]
                  ? 'authenticated'
                  : 'unauthenticated') as ConnectionMetadataRecord['auth'],
                lastCheckedAt: Date.now(),
                disabled: current[connection.id]?.disabled,
              },
            };
            persistMetadata(next);
            markConnectionSessionChecked([connection.id]);
            return next;
          });
          return;
        }

        const baseline = readConnectionMetadata()[connection.id];
        const baselineRevision = readConnectionMetadataRevision(connection.id);
        let detection: DetectionResult;
        let auth: AuthProbeResult = { status: 'unknown' };
        try {
          detection = await adapter.detect();
          auth =
            detection.status === 'available' && adapter.probeAuth
              ? await adapter.probeAuth(connection)
              : { status: 'unknown' };
        } catch (err) {
          setErrors((prev) => ({
            ...prev,
            [connection.id]: err instanceof Error ? err.message : 'Scan failed',
          }));
          detection = { status: 'requires_attention' };
        }
        const inspected: ConnectionMetadataRecord = {
          installation:
            detection.status === 'available'
              ? 'installed'
              : detection.status === 'unavailable'
                ? 'not-installed'
                : 'unknown',
          auth: auth.status,
          ...(detection.executablePath ? { executablePath: detection.executablePath } : {}),
          ...(detection.version ? { version: detection.version } : {}),
          lastCheckedAt: Date.now(),
          disabled: baseline?.disabled,
        };
        setMetadata((current) => {
          const next = mergeConnectionInspectionIfUnchanged(
            current,
            connection.id,
            baseline,
            inspected,
            baselineRevision,
            readConnectionMetadataRevision(connection.id),
          );
          if (next === current) return current;
          persistMetadata(next);
          markConnectionSessionChecked([connection.id]);
          return next;
        });
      } finally {
        setChecking(connection.id, false);
      }
    },
    [credentialsReadyByConnection],
  );

  const openSettingsTab = (
    tab: 'providers' | 'localmodels' | 'connections',
    providerId?: string,
  ) => {
    rememberSettingsTab(tab);
    if (providerId && tab === 'providers') {
      try {
        window.sessionStorage.setItem('vibespace.settings.provider-focus.v1', providerId);
      } catch {
        // The Providers page still opens when session storage is unavailable.
      }
    }
    setSettingsOpen(true);
    window.dispatchEvent(new CustomEvent('jarvis:settings:tab', { detail: { tab, providerId } }));
  };

  const act = async (action: ConnectionAction, connection: Readonly<ProviderConnection>) => {
    if (onAction) {
      await onAction(action, connection);
      return;
    }

    if (action === 'refresh') {
      if (onRefresh) {
        await onRefresh(connection);
        return;
      }
      await inspect(connection);
      toast.success('Refreshed', `${connection.displayName} status updated.`);
      return;
    }

    if (action === 'sign-in') {
      if (onSignIn) {
        await onSignIn(connection);
        return;
      }
      if (connection.mode === 'external-cli') {
        const docs = CLI_SIGN_IN_DOCS[connection.id];
        const hint =
          CLI_SIGN_IN_HINT[connection.id] ?? 'Sign in with the provider CLI, then Refresh.';
        toast.info('Sign in outside VibeSpace', hint);
        if (docs) {
          try {
            await openExternal(docs);
          } catch {
            /* toast already shown */
          }
        }
        // Re-probe after a short delay so an already-signed-in session is picked up.
        window.setTimeout(() => {
          void inspect(connection);
        }, 2_500);
        return;
      }
      if (connection.mode === 'native-api') {
        openSettingsTab('providers', connection.providerId);
        return;
      }
      openSettingsTab('localmodels');
      return;
    }

    if (action === 'configure' || action === 'add-api-key') {
      if (connection.mode === 'native-api' || action === 'add-api-key') {
        openSettingsTab('providers', connection.providerId);
        toast.info('API keys', 'Add or edit keys under Settings → Providers.');
        return;
      }
      if (connection.mode === 'local') {
        openSettingsTab('localmodels');
        return;
      }
      // CLI configure: show path/version and re-detect — no secret scraping.
      toast.info(
        'CLI connector',
        connection.displayName +
          (metadata[connection.id]?.executablePath
            ? ` · ${metadata[connection.id]?.executablePath}`
            : ' · use Refresh to re-detect the installed CLI.'),
      );
      await inspect(connection);
      return;
    }

    if (action === 'disable') {
      setMetadata((current) => {
        const next = {
          ...current,
          [connection.id]: {
            ...(current[connection.id] ?? {
              installation: 'unknown' as const,
              auth: 'unknown' as const,
            }),
            disabled: true,
            lastCheckedAt: current[connection.id]?.lastCheckedAt ?? Date.now(),
          },
        };
        persistMetadata(next);
        return next;
      });
      toast.success('Disabled', `${connection.displayName} will not be offered for new chats.`);
      return;
    }

    if (action === 'enable') {
      setMetadata((current) => {
        const prev = current[connection.id];
        const next = {
          ...current,
          [connection.id]: {
            ...(prev ?? { installation: 'unknown' as const, auth: 'unknown' as const }),
            disabled: false,
            lastCheckedAt: prev?.lastCheckedAt ?? Date.now(),
          },
        };
        persistMetadata(next);
        return next;
      });
      void inspect(connection);
      toast.success('Enabled', `${connection.displayName} is available again.`);
      return;
    }

    if (action === 'clear-scan') {
      setMetadata((current) => {
        const next = { ...current };
        delete next[connection.id];
        persistMetadata(next);
        return next;
      });
      toast.success(
        'Scan cache cleared',
        'Only local install/auth status was removed. CLI credentials and API keys were not deleted.',
      );
    }
  };

  const scan = async () => {
    setBusy(true);
    try {
      if (onScan) await onScan();
      else {
        await Promise.all(
          PROVIDER_CONNECTIONS.filter(
            (connection) =>
              connection.mode === 'external-cli' && !metadata[connection.id]?.disabled,
          ).map((connection) => inspect(connection)),
        );
      }
      toast.success('Scan complete', 'CLI detection used read-only probes only.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section
      className="mc7f-settings-subscription-cli space-y-5 [html[data-theme=monochrome]_&]:border-l-2 [html[data-theme=monochrome]_&]:border-l-foreground/20 [html[data-theme=monochrome]_&]:pl-4"
      aria-labelledby="ai-connectors-title"
      data-testid="ai-connectors-panel"
    >
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 id="ai-connectors-title" className="text-page-title font-semibold text-foreground">
            AI Connectors
          </h2>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            Identify each product at a glance, detect signed-in CLI subscriptions automatically, and
            manage them separately from API keys. Scans never send a model prompt or read secret
            files.
          </p>
        </div>
        <Button
          type="button"
          size="sm"
          onClick={() => void scan()}
          disabled={busy}
          aria-label="Scan for agents"
        >
          {busy ? 'Scanning…' : 'Scan now'}
        </Button>
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        {Object.values(PROVIDER_CATALOG).map((family) => {
          const connection =
            family.connections.find(({ id }) => id === selectedRouteByFamily[family.id]) ??
            family.connections[0];
          if (!connection) return null;
          const record = metadata[connection.id];
          const checking = checkingIds.has(connection.id) || (busy && !record?.lastCheckedAt);
          const error = errors[connection.id] ?? null;
          const status: ConnectorUiStatus = resolveConnectorUiStatus({
            connection,
            record,
            checking,
            error,
            credentialsReady: credentialsReadyByConnection[connection.id],
          });
          const tone = connectorStatusTone(status);
          const routeTitle = productTitle(connection);

          return (
            <article
              key={family.id}
              className="flex flex-col rounded-xl border border-border bg-panel/70 p-4 shadow-sm"
              data-connector-id={connection.id}
              data-connector-status={status}
              data-connector-mode={connection.mode}
            >
              <div className="flex items-start gap-3">
                <ConnectorBrandMark
                  providerId={connection.providerId}
                  connectionId={connection.id}
                  title={`${family.displayName} · ${connection.displayName}`}
                />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <h3 className="truncate text-base font-bold tracking-tight text-foreground">
                        {family.displayName}
                      </h3>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        <span className="font-medium text-foreground/80">{routeTitle}</span>
                        <span className="mx-1.5 text-border">·</span>
                        <span>{connectorModeLabel(connection.mode)}</span>
                      </p>
                      <p className="mt-0.5 text-[11px] text-muted-foreground/90">
                        {connection.displayName}
                      </p>
                    </div>
                    <Badge
                      variant={statusBadgeVariant(tone)}
                      className={cn(
                        'shrink-0 text-[11px] font-semibold',
                        tone === 'info' && 'border-accent-copper/40 text-accent-copper',
                      )}
                    >
                      {connectorStatusLabel(status)}
                    </Badge>
                  </div>
                </div>
              </div>

              <div
                className="mt-3 flex flex-wrap gap-1.5"
                role="tablist"
                aria-label={`${family.displayName} connection routes`}
              >
                {family.connections.map((routeConnection) => {
                  const selected = routeConnection.id === connection.id;
                  return (
                    <button
                      key={routeConnection.id}
                      type="button"
                      role="tab"
                      aria-selected={selected}
                      className={cn(
                        'min-h-9 rounded-md border px-2.5 text-xs font-medium transition-colors',
                        'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
                        selected
                          ? 'border-accent-copper/60 bg-accent-copper/10 text-foreground'
                          : 'border-border text-muted-foreground hover:text-foreground',
                      )}
                      onClick={() =>
                        setSelectedRouteByFamily((current) => ({
                          ...current,
                          [family.id]: routeConnection.id,
                        }))
                      }
                    >
                      {connectorModeLabel(routeConnection.mode)}
                    </button>
                  );
                })}
              </div>

              <dl className="mt-3 grid grid-cols-[7rem_1fr] gap-x-2 gap-y-1.5 text-xs">
                {connection.mode === 'external-cli' && record?.executablePath ? (
                  <>
                    <dt className="text-muted-foreground">Detected path</dt>
                    <dd className="truncate font-mono text-[11px]" title={record.executablePath}>
                      {record.executablePath}
                    </dd>
                  </>
                ) : null}
                <dt className="text-muted-foreground">Version</dt>
                <dd className="text-foreground/90">{record?.version ?? '—'}</dd>
                <dt className="text-muted-foreground">Capabilities</dt>
                <dd className="text-foreground/90">{capabilitySummary(connection)}</dd>
                <dt className="text-muted-foreground">Auth source</dt>
                <dd className="text-foreground/90">
                  {connection.mode === 'external-cli'
                    ? 'CLI session (read-only status)'
                    : connection.mode === 'local'
                      ? 'Local runtime'
                      : 'API key (Providers)'}
                </dd>
                <dt className="text-muted-foreground">Last check</dt>
                <dd className="text-foreground/90" data-testid={`last-check-${connection.id}`}>
                  {record?.lastCheckedAt ? formatUserDateTime(record.lastCheckedAt) : 'Never'}
                </dd>
              </dl>

              {error ? (
                <p className="mt-2 text-xs text-destructive" role="alert">
                  {error}
                </p>
              ) : null}

              {status === 'signed-in' ? (
                <p className="mt-2 text-xs text-success">
                  Subscription session detected. Selecting this exact route in Chat sends requests
                  through it instead of an API key.
                </p>
              ) : null}

              <div className="mt-3 flex flex-wrap gap-1.5">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={checking}
                  onClick={() => void act('refresh', connection)}
                  aria-label={`Refresh ${connection.displayName}`}
                >
                  Refresh
                </Button>
                {connection.mode === 'external-cli' ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => void act('sign-in', connection)}
                    aria-label={`Sign in to ${connection.displayName}`}
                  >
                    Sign in
                  </Button>
                ) : connection.mode === 'native-api' ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => void act('add-api-key', connection)}
                    aria-label={`Add API key for ${connection.displayName}`}
                  >
                    Add API key
                  </Button>
                ) : null}
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => void act('configure', connection)}
                  aria-label={`Configure ${connection.displayName}`}
                >
                  Configure
                </Button>
                {record?.disabled ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => void act('enable', connection)}
                    aria-label={`Enable ${connection.displayName}`}
                  >
                    Enable
                  </Button>
                ) : (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => void act('disable', connection)}
                    aria-label={`Disable ${connection.displayName}`}
                  >
                    Disable
                  </Button>
                )}
                {record ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => void act('clear-scan', connection)}
                    aria-label={`Clear scan cache for ${connection.displayName}`}
                    title="Removes only this app’s saved install/auth scan results. Does not delete CLI logins or API keys."
                  >
                    Clear scan cache
                  </Button>
                ) : null}
              </div>
              {record ? (
                <p className="mt-2 text-[11px] leading-snug text-muted-foreground">
                  <span className="font-medium text-foreground/70">Clear scan cache</span> deletes
                  only the last detected path, version, and auth status stored in VibeSpace. It does
                  not log you out of provider CLIs or remove API keys.
                </p>
              ) : null}
            </article>
          );
        })}
      </div>
      <McpConnections />
    </section>
  );
}

export default SubscriptionCliBridge;
