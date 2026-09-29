import * as React from 'react';
import './sakura-plugins.css';
import {
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Download,
  ExternalLink,
  KeyRound,
  Loader2,
  Pin,
  PinOff,
  Plus,
  Search,
  Settings2,
  ShieldCheck,
  Unplug,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { toast } from '@/components/ui/toast';
import { resolveAccountIdentity } from '@/lib/accountIdentity';
import { openExternal } from '@/lib/tauri';
import { useAuthStore } from '@/stores/auth';
import { CLASSIFIED_PLUGIN_CATALOG } from './catalog';
import { usePluginManagementCapability } from './managementContext';
import { pluginSearchBlob } from './providerRegistry';
import {
  selectInstalledPluginIdsForAccount,
  selectPinnedPluginIdsForAccount,
  selectPluginConnectionsForAccount,
  usePluginStore,
} from './store';
import type { ClassifiedPluginManifest, PluginConnection } from './types';
import { isConnectableStatus } from './types';
import { PluginLogo } from './PluginLogo';
import { OpenCodeMcpConnections } from './OpenCodeMcpConnections';
import { hostedMcpProvider, type HostedMcpProvider } from './hostedMcpProviders';
import { PLUGIN_COMPATIBILITY_BY_ID } from './compatibilityMatrix';
import { OPEN_MCP_MANAGER_EVENT, consumePendingMcpManagerOpenRequest } from './openMcpManager';
import {
  isProviderHostedAuthorization,
  verifiedProviderAuthorizationUrl,
} from './authorizationCapability';

type Filter = 'all' | 'available' | 'connected' | 'planned';
type AuthorizationPanel = Readonly<{
  plugin: ClassifiedPluginManifest;
  phase: 'opening' | 'awaiting_approval' | 'connected' | 'error';
  authorizationUrl?: string;
  userCode?: string;
  error?: string;
  setupUrl?: string;
}>;

const STATUS_LABELS = {
  connected: 'Connected',
  not_connected: 'Not connected',
  needs_setup: 'Needs setup',
  error: 'Error',
  connecting: 'Connecting',
  awaiting_approval: 'Awaiting approval',
  reauthorize: 'Reauthorize',
  expired: 'Expired',
} as const;

function defaultConnectionState(plugin: ClassifiedPluginManifest): PluginConnection['state'] {
  if (plugin.status === 'needs_credentials' || plugin.status === 'blocked') return 'needs_setup';
  return isConnectableStatus(plugin.status) ? 'not_connected' : 'needs_setup';
}

function statusBadgeLabel(
  plugin: ClassifiedPluginManifest,
  connectionState: PluginConnection['state'],
): string {
  if (connectionState === 'connected') return STATUS_LABELS.connected;
  if (plugin.authorizationCapability.kind === 'external_blocker') return 'External blocker';
  if (plugin.status === 'needs_credentials' || plugin.status === 'blocked') {
    if (connectionState === 'error') return STATUS_LABELS.error;
    return 'Manual Setup Required';
  }
  if (plugin.status === 'configurable' && connectionState === 'needs_setup') {
    return 'Manual Setup Required';
  }
  return STATUS_LABELS[connectionState];
}

function usesProviderAuthorization(plugin: ClassifiedPluginManifest): boolean {
  return isProviderHostedAuthorization(plugin.authorizationCapability);
}

export function Plugins() {
  const accountId = useAuthStore((state) => resolveAccountIdentity(state)?.accountId ?? '');
  const connections = usePluginStore((state) =>
    selectPluginConnectionsForAccount(state, accountId),
  );
  const setEnabled = usePluginStore((state) => state.setEnabled);
  const installedPluginIds = usePluginStore((state) =>
    selectInstalledPluginIdsForAccount(state, accountId),
  );
  const installPlugin = usePluginStore((state) => state.installPlugin);
  const uninstallPlugin = usePluginStore((state) => state.uninstallPlugin);
  const pinnedPluginIds = usePluginStore((state) =>
    selectPinnedPluginIdsForAccount(state, accountId),
  );
  const pinPlugin = usePluginStore((state) => state.pinPlugin);
  const unpinPlugin = usePluginStore((state) => state.unpinPlugin);
  const movePinnedPlugin = usePluginStore((state) => state.movePinnedPlugin);
  const [query, setQuery] = React.useState('');
  const [filter, setFilter] = React.useState<Filter>('all');
  const [selected, setSelected] = React.useState<ClassifiedPluginManifest | null>(null);
  const [uninstallCandidate, setUninstallCandidate] = React.useState<{
    accountId: string;
    plugin: ClassifiedPluginManifest;
  } | null>(null);
  const [authorizationPanel, setAuthorizationPanel] = React.useState<AuthorizationPanel | null>(
    null,
  );
  const [mcpOpen, setMcpOpen] = React.useState(false);
  const [mcpProvider, setMcpProvider] = React.useState<HostedMcpProvider>();
  const [mcpConnectRequest, setMcpConnectRequest] = React.useState(0);
  const management = usePluginManagementCapability();

  React.useEffect(() => {
    if (consumePendingMcpManagerOpenRequest()) setMcpOpen(true);
    const openMcpManager = () => {
      consumePendingMcpManagerOpenRequest();
      setMcpConnectRequest(0);
      setMcpOpen(true);
    };
    window.addEventListener(OPEN_MCP_MANAGER_EVENT, openMcpManager);
    return () => window.removeEventListener(OPEN_MCP_MANAGER_EVENT, openMcpManager);
  }, []);

  React.useEffect(() => {
    const panel = authorizationPanel;
    if (!panel || panel.phase !== 'awaiting_approval') return;
    const state = connections[panel.plugin.id]?.state;
    if (state === 'connected') {
      setAuthorizationPanel({ ...panel, phase: 'connected' });
      toast.success(`${panel.plugin.name} connected`, 'Provider authorization is verified.');
    } else if (state === 'error' || state === 'expired' || state === 'reauthorize') {
      const error =
        connections[panel.plugin.id]?.error ??
        (state === 'expired'
          ? `${panel.plugin.provider} authorization expired. Reconnect to continue.`
          : state === 'reauthorize'
            ? `${panel.plugin.provider} requires reauthorization.`
            : `${panel.plugin.provider} authorization failed.`);
      setAuthorizationPanel({ ...panel, phase: 'error', error });
    }
  }, [authorizationPanel, connections]);

  async function startProviderAuthorization(plugin: ClassifiedPluginManifest) {
    if (!usesProviderAuthorization(plugin)) {
      setSelected(plugin);
      return;
    }
    setAuthorizationPanel({ plugin, phase: 'opening' });
    if (!accountId || !management) {
      setAuthorizationPanel({
        plugin,
        phase: 'error',
        error: 'Plugin management is unavailable until account setup finishes.',
      });
      return;
    }
    try {
      const result = await management.beginAuthorization({ accountId, pluginId: plugin.id });
      if (!result.ok) {
        const recoveryPanel: AuthorizationPanel = {
          plugin,
          phase: 'error',
          error: result.error,
          setupUrl: result.setupUrl,
        };
        setAuthorizationPanel(recoveryPanel);
        return;
      }
      let authorizationUrl: string | undefined;
      if (result.authorizationUrl) {
        try {
          authorizationUrl = verifiedProviderAuthorizationUrl(
            plugin.authorizationCapability,
            result.authorizationUrl,
          );
        } catch {
          try {
            await management.cancelAuthorization({ accountId, pluginId: plugin.id });
          } catch {
            // The unverified endpoint remains unopened even if cancellation cannot complete.
          }
          setAuthorizationPanel({
            plugin,
            phase: 'error',
            error: 'Provider authorization returned an unverified authorization endpoint.',
          });
          return;
        }
      }
      if (result.state !== 'connected' && !authorizationUrl) {
        try {
          await management.cancelAuthorization({ accountId, pluginId: plugin.id });
        } catch {
          // Missing endpoint is already fail-closed; cancellation is best effort.
        }
        setAuthorizationPanel({
          plugin,
          phase: 'error',
          error: 'Provider authorization did not return its verified authorization endpoint.',
        });
        return;
      }
      const nextPanel: AuthorizationPanel = {
        plugin,
        phase: result.state,
        authorizationUrl,
        userCode: result.userCode,
      };
      setAuthorizationPanel(nextPanel);
      if (authorizationUrl) {
        try {
          await openExternal(authorizationUrl);
        } catch {
          setAuthorizationPanel({
            ...nextPanel,
            error: `The ${plugin.provider} authorization page did not open automatically.`,
          });
        }
      }
      if (result.state === 'connected') {
        toast.success(`${plugin.name} connected`, 'Provider authorization is verified.');
      }
    } catch {
      setAuthorizationPanel({
        plugin,
        phase: 'error',
        error: `Could not start the ${plugin.provider} authorization flow.`,
      });
    }
  }

  function openManualProviderSetup(plugin: ClassifiedPluginManifest) {
    setSelected(plugin);
    if (!plugin.providerAccessUrl) return;
    void openExternal(plugin.providerAccessUrl).catch(() => {
      toast.warning(
        `${plugin.provider} page did not open`,
        'Use the official provider-page button in the connection panel.',
      );
    });
  }

  const visible = React.useMemo(() => {
    const needle = query.trim().toLowerCase();
    return CLASSIFIED_PLUGIN_CATALOG.filter((plugin) => {
      const connection = connections[plugin.id];
      const connectionState = connection?.state ?? defaultConnectionState(plugin);
      if (filter === 'available' && !isConnectableStatus(plugin.status)) return false;
      if (filter === 'connected' && connectionState !== 'connected') return false;
      if (
        filter === 'planned' &&
        plugin.status !== 'needs_credentials' &&
        plugin.status !== 'blocked'
      ) {
        return false;
      }
      if (!needle) return true;
      return pluginSearchBlob(plugin, connectionState).includes(needle);
    });
  }, [connections, filter, query]);

  const connectedCount = Object.values(connections).filter(
    (connection) => connection.state === 'connected',
  ).length;

  return (
    <div className="mc7f-plugins flex flex-col gap-5 [html[data-theme=monochrome]_&]:border-l-2 [html[data-theme=monochrome]_&]:border-l-foreground/20 [html[data-theme=monochrome]_&]:pl-4 [html[data-theme=monochrome]_&_*]:rounded-none [html[data-theme=monochrome]_&_*]:bg-none [html[data-theme=monochrome]_&_*]:shadow-none">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-page-title text-foreground">Plugins</h2>
          <p className="mt-1 max-w-2xl text-secondary text-muted-foreground">
            Connect external services and expose controlled capabilities to Jarvis agents working in
            terminals. Credentials stay in the operating-system keychain on desktop (browser preview
            keeps them in memory for the session only).
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant={connectedCount ? 'success' : 'outline'}>{connectedCount} connected</Badge>
          <Button
            type="button"
            size="icon-sm"
            variant="outline"
            aria-label={mcpOpen ? 'Close MCP connections' : 'Add MCP connection'}
            aria-expanded={mcpOpen}
            aria-controls="plugins-mcp-connections"
            onClick={() => {
              setMcpConnectRequest(0);
              setMcpOpen((open) => !open);
            }}
          >
            <Plus />
          </Button>
        </div>
      </header>

      {mcpOpen ? (
        <div id="plugins-mcp-connections">
          <OpenCodeMcpConnections
            initialProvider={mcpProvider}
            connectRequestId={mcpConnectRequest}
          />
        </div>
      ) : null}

      <div className="rounded-lg border border-accent-cyan/20 bg-accent-cyan/5 p-3 flex gap-3">
        <ShieldCheck className="h-5 w-5 shrink-0 text-accent-cyan" />
        <p className="text-secondary text-muted-foreground">
          Terminals receive plugin names and permitted tool descriptions only. Tokens are never
          copied into prompts, terminal environment variables, localStorage, or Supabase.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[240px] flex-1">
          <Search className="absolute left-2.5 top-2 h-4 w-4 text-muted-foreground" />
          <Input
            aria-label="Search plugins"
            className="pl-8"
            placeholder={`Search ${CLASSIFIED_PLUGIN_CATALOG.length} plugins`}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        {(['all', 'available', 'connected', 'planned'] as Filter[]).map((value) => (
          <Button
            key={value}
            type="button"
            size="sm"
            variant={filter === value ? 'default' : 'outline'}
            aria-pressed={filter === value}
            onClick={() => setFilter(value)}
          >
            {value[0].toUpperCase() + value.slice(1)}
          </Button>
        ))}
      </div>

      <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
        {visible.map((plugin) => {
          const connection = connections[plugin.id];
          const connectionState = connection?.state ?? defaultConnectionState(plugin);
          const badgeLabel = statusBadgeLabel(plugin, connectionState);
          const pinIndex = pinnedPluginIds.indexOf(plugin.id);
          const isPinned = pinIndex >= 0;
          const isInstalled = installedPluginIds.includes(plugin.id) || Boolean(connection);
          const isExternallyBlocked = plugin.authorizationCapability.kind === 'external_blocker';
          return (
            <Card
              key={plugin.id}
              data-testid={`plugin-card-${plugin.id}`}
              data-sakura-surface="plugin-card"
              data-sakura-state={connectionState}
            >
              <CardHeader className="pb-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <PluginLogo plugin={plugin} />
                      <div>
                        <h3 className="text-ui-strong text-foreground">{plugin.name}</h3>
                        <p className="text-metadata text-muted-foreground">{plugin.category}</p>
                      </div>
                    </div>
                  </div>
                  <Badge
                    variant={
                      connectionState === 'connected'
                        ? 'success'
                        : connectionState === 'error'
                          ? 'destructive'
                          : badgeLabel === 'Manual Setup Required'
                            ? 'outline'
                            : 'warning'
                    }
                  >
                    {badgeLabel}
                  </Badge>
                </div>
              </CardHeader>
              <CardContent className="flex flex-col gap-3">
                <p className="text-secondary text-muted-foreground min-h-10">
                  {plugin.description}
                </p>
                {connection?.accountLabel && (
                  <p className="text-metadata text-foreground">
                    Connected as {connection.accountLabel}
                  </p>
                )}
                {connection?.state === 'connected' && (
                  <dl className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-1 text-metadata text-muted-foreground">
                    <dt>Scopes</dt>
                    <dd className="truncate text-foreground/90">
                      {plugin.requiredScopes?.length
                        ? plugin.requiredScopes.join(' · ')
                        : 'No provider scopes declared'}
                    </dd>
                    <dt>Connected / updated</dt>
                    <dd className="text-foreground/90">
                      {new Intl.DateTimeFormat(undefined, {
                        dateStyle: 'medium',
                        timeStyle: 'short',
                      }).format(connection.updatedAt)}
                    </dd>
                    <dt>Last successful check</dt>
                    <dd className="text-foreground/90">
                      {connection.lastTestedAt
                        ? new Intl.DateTimeFormat(undefined, {
                            dateStyle: 'medium',
                            timeStyle: 'short',
                          }).format(connection.lastTestedAt)
                        : 'Not yet verified'}
                    </dd>
                  </dl>
                )}
                {connection?.error && (
                  <p role="alert" className="text-metadata text-destructive">
                    {connection.error}
                  </p>
                )}
                <div className="flex items-center justify-between gap-3 border-t border-border pt-3">
                  {connection?.state === 'connected' ? (
                    <label className="flex items-center gap-2 text-secondary text-muted-foreground">
                      <Switch
                        checked={connection.enabled && connection.enabledProjectIds.length > 0}
                        onCheckedChange={(enabled) => {
                          if (accountId) setEnabled(accountId, plugin.id, enabled);
                        }}
                        aria-label={`Enable ${plugin.name} for terminal agents`}
                      />
                      Terminal access
                    </label>
                  ) : (
                    <span className="text-metadata text-muted-foreground">
                      {plugin.tools.length} tools declared
                    </span>
                  )}
                  <div className="flex items-center gap-2">
                    {isInstalled && !connection && (
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        disabled={!accountId}
                        onClick={() => setUninstallCandidate({ accountId, plugin })}
                      >
                        Uninstall
                      </Button>
                    )}
                    <Button
                      type="button"
                      size="sm"
                      variant={connection?.state === 'connected' ? 'outline' : 'default'}
                      disabled={
                        !accountId || (!isExternallyBlocked && !isConnectableStatus(plugin.status))
                      }
                      onClick={() => {
                        if (connection?.state === 'connected') {
                          setSelected(plugin);
                        } else if (isExternallyBlocked) {
                          setSelected(plugin);
                        } else if (!isInstalled) {
                          installPlugin(accountId, plugin.id);
                          toast.success(
                            `${plugin.name} installed`,
                            'The connector is ready. Connect your provider account when you are ready.',
                          );
                        } else if (usesProviderAuthorization(plugin)) {
                          void startProviderAuthorization(plugin);
                        } else {
                          openManualProviderSetup(plugin);
                        }
                      }}
                    >
                      {connection?.state === 'connected' ? (
                        <>
                          <Settings2 className="h-3.5 w-3.5" /> Manage
                        </>
                      ) : isExternallyBlocked ? (
                        <>
                          <ExternalLink className="h-3.5 w-3.5" /> View requirements
                        </>
                      ) : !isInstalled ? (
                        <>
                          <Download className="h-3.5 w-3.5" /> Install
                        </>
                      ) : (
                        <>
                          <KeyRound className="h-3.5 w-3.5" />
                          {connectionState === 'expired' || connectionState === 'reauthorize'
                            ? 'Reconnect'
                            : 'Connect'}
                        </>
                      )}
                    </Button>
                  </div>
                </div>
                {connection?.state === 'connected' && (
                  <div className="flex items-center justify-end gap-1">
                    {isPinned && (
                      <>
                        <Button
                          type="button"
                          size="icon-sm"
                          variant="ghost"
                          aria-label={`Move ${plugin.name} pin up`}
                          disabled={pinIndex === 0}
                          onClick={() => movePinnedPlugin(accountId, plugin.id, -1)}
                        >
                          <ChevronUp />
                        </Button>
                        <Button
                          type="button"
                          size="icon-sm"
                          variant="ghost"
                          aria-label={`Move ${plugin.name} pin down`}
                          disabled={pinIndex === pinnedPluginIds.length - 1}
                          onClick={() => movePinnedPlugin(accountId, plugin.id, 1)}
                        >
                          <ChevronDown />
                        </Button>
                      </>
                    )}
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        if (isPinned) {
                          unpinPlugin(accountId, plugin.id);
                        } else if (!pinPlugin(accountId, plugin.id)) {
                          toast.warning(
                            'Pin limit reached',
                            'Workbench supports up to 10 plugin pins.',
                          );
                        }
                      }}
                    >
                      {isPinned ? <PinOff /> : <Pin />}
                      {isPinned ? 'Unpin from Workbench' : 'Pin to Workbench'}
                    </Button>
                  </div>
                )}
              </CardContent>
            </Card>
          );
        })}
      </div>

      {visible.length === 0 && (
        <div
          className="rounded-lg border border-dashed border-border p-10 text-center text-secondary text-muted-foreground"
          data-sakura-state="empty"
        >
          No plugins match this search.
        </div>
      )}

      <Dialog
        open={Boolean(uninstallCandidate && uninstallCandidate.accountId === accountId)}
        onOpenChange={(open) => !open && setUninstallCandidate(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Uninstall {uninstallCandidate?.plugin.name}?</DialogTitle>
            <DialogDescription>
              This removes the connector from this account and its Workbench pins. Disconnect it
              first if it has a provider connection.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setUninstallCandidate(null)}>
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={() => {
                if (!uninstallCandidate || uninstallCandidate.accountId !== accountId) return;
                const removed = uninstallPlugin(accountId, uninstallCandidate.plugin.id);
                if (removed) {
                  toast.success(`${uninstallCandidate.plugin.name} uninstalled`);
                } else {
                  toast.warning(
                    'Unable to uninstall connector',
                    'Disconnect this connector before uninstalling it.',
                  );
                }
                setUninstallCandidate(null);
              }}
            >
              Uninstall
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <PluginSetupDialog
        accountId={accountId}
        plugin={selected}
        onClose={() => setSelected(null)}
        onOpenHosted={(provider) => {
          setSelected(null);
          setMcpProvider(provider);
          setMcpConnectRequest((request) => request + 1);
          setMcpOpen(true);
          requestAnimationFrame(() =>
            document.getElementById('plugins-mcp-connections')?.scrollIntoView({ block: 'start' }),
          );
        }}
      />
      <PluginAuthorizationDialog
        accountId={accountId}
        panel={authorizationPanel}
        onClose={() => setAuthorizationPanel(null)}
      />
    </div>
  );
}

function PluginAuthorizationDialog({
  accountId,
  panel,
  onClose,
}: {
  accountId: string;
  panel: AuthorizationPanel | null;
  onClose: () => void;
}) {
  const management = usePluginManagementCapability();
  const [cancelling, setCancelling] = React.useState(false);
  const [manualDraft, setManualDraft] = React.useState<Record<string, string>>({});
  const [savingManual, setSavingManual] = React.useState(false);
  const [manualError, setManualError] = React.useState('');

  if (!panel) return null;

  const { plugin } = panel;
  const isOpening = panel.phase === 'opening';
  const canCancel = panel.phase === 'awaiting_approval';
  const hasManualFallback =
    plugin.authorizationCapability.kind === 'provider_hosted_oauth' &&
    plugin.authorizationCapability.manualFallback &&
    plugin.fields.length > 0 &&
    Boolean(plugin.credentialUrl);

  async function cancel() {
    if (!management || !accountId) return;
    setCancelling(true);
    try {
      await management.cancelAuthorization({ accountId, pluginId: plugin.id });
      toast.info(`${plugin.name} authorization cancelled`);
      onClose();
    } finally {
      setCancelling(false);
    }
  }

  async function connectManually() {
    if (!management || !accountId) return;
    setManualError('');
    for (const field of plugin.fields) {
      if (field.required && !manualDraft[field.id]?.trim()) {
        setManualError(`${field.label} is required.`);
        return;
      }
    }
    setSavingManual(true);
    try {
      await management.cancelAuthorization({ accountId, pluginId: plugin.id });
      for (const field of plugin.fields) {
        const value = manualDraft[field.id]?.trim();
        if (value) {
          await management.saveCredential({
            accountId,
            pluginId: plugin.id,
            fieldId: field.id,
            value,
          });
        }
      }
      const result = await management.testConnection({ accountId, pluginId: plugin.id });
      if (!result.ok) {
        setManualError(result.error ?? 'Connection test failed.');
        return;
      }
      setManualDraft({});
      toast.success(`${plugin.name} connected`, 'The fallback credential was verified.');
      onClose();
    } catch {
      setManualError(`Could not verify the ${plugin.provider} fallback credential.`);
    } finally {
      setSavingManual(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sakura-plugin-dialog max-w-md [html[data-theme=monochrome]_&]:rounded-none [html[data-theme=monochrome]_&]:shadow-none">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <PluginLogo plugin={plugin} size="sm" />
            Connect {plugin.name}
          </DialogTitle>
          <DialogDescription>
            {isOpening
              ? `Opening ${plugin.provider}’s official authorization page…`
              : panel.phase === 'connected'
                ? 'Provider authorization completed and verified.'
                : panel.authorizationUrl
                  ? `${plugin.provider} authorization should open in your browser.`
                  : `${plugin.provider} authorization could not start. Review the exact requirement or use the supported fallback.`}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          {isOpening && (
            <div className="flex items-center gap-2 rounded-lg border border-border bg-panel p-3 text-secondary text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" />
              Starting secure authorization…
            </div>
          )}

          {panel.authorizationUrl && (
            <div className="flex flex-col items-start gap-2 rounded-lg border border-accent-cyan/25 bg-accent-cyan/5 p-3">
              <p className="text-secondary text-foreground">
                If authorization did not open automatically, use this secure provider link.
              </p>
              <Button
                type="button"
                size="sm"
                onClick={() => void openExternal(panel.authorizationUrl!)}
              >
                <ExternalLink className="h-3.5 w-3.5" />
                Open {plugin.provider} authorization
              </Button>
              {panel.userCode && (
                <p className="text-secondary text-muted-foreground">
                  Provider code:{' '}
                  <strong className="font-mono text-foreground">{panel.userCode}</strong>
                </p>
              )}
            </div>
          )}

          {!isOpening && panel.authorizationUrl && (
            <div>
              <p className="mb-1 text-metadata uppercase tracking-wide text-muted-foreground">
                Manual recovery
              </p>
              <ol className="list-decimal space-y-1 pl-5 text-secondary text-muted-foreground">
                <li>Open the provider authorization link.</li>
                <li>Sign in, review the requested permissions, and approve or decline.</li>
                <li>Return to VibeSpace; the connection status updates after verification.</li>
              </ol>
            </div>
          )}

          {panel.phase === 'connected' && (
            <div className="flex gap-2 rounded-lg border border-success/30 bg-success/10 p-3 text-secondary text-success">
              <CheckCircle2 className="h-4 w-4" />
              Provider authorization completed and verified.
            </div>
          )}

          {!isOpening && hasManualFallback && (
            <details className="rounded-lg border border-border bg-panel/70 p-3">
              <summary className="cursor-pointer text-secondary font-medium text-foreground">
                Use a key instead
              </summary>
              <p className="mt-2 text-metadata text-muted-foreground">
                This fallback is optional. The provider sign-in flow above is the recommended
                connection method. Values entered here are saved to the desktop OS keychain.
              </p>
              <div className="mt-3 flex flex-col gap-3">
                {plugin.fields.map((field) => (
                  <div key={field.id} className="flex flex-col gap-1.5">
                    <Label htmlFor={`authorization-fallback-${plugin.id}-${field.id}`}>
                      {field.label}
                    </Label>
                    <Input
                      id={`authorization-fallback-${plugin.id}-${field.id}`}
                      type={field.secret ? 'password' : 'text'}
                      autoComplete="off"
                      value={manualDraft[field.id] ?? ''}
                      placeholder={field.placeholder}
                      onChange={(event) =>
                        setManualDraft((current) => ({
                          ...current,
                          [field.id]: event.target.value,
                        }))
                      }
                    />
                    {field.help && (
                      <p className="text-metadata text-muted-foreground">{field.help}</p>
                    )}
                  </div>
                ))}
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    size="sm"
                    disabled={savingManual || !management || !accountId}
                    onClick={() => void connectManually()}
                  >
                    {savingManual ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <KeyRound className="h-3.5 w-3.5" />
                    )}
                    Save and verify key
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => void openExternal(plugin.credentialUrl!)}
                  >
                    <ExternalLink className="h-3.5 w-3.5" />
                    Open provider key page
                  </Button>
                </div>
                {manualError && (
                  <p role="alert" className="text-secondary text-destructive">
                    {manualError}
                  </p>
                )}
              </div>
            </details>
          )}

          {(plugin.requiredScopes?.length ?? 0) > 0 && (
            <details className="rounded-lg border border-border bg-panel/70 p-3">
              <summary className="cursor-pointer text-secondary font-medium text-foreground">
                Permissions requested
              </summary>
              <ul className="mt-2 flex flex-col gap-1" aria-label="Permissions requested">
                {plugin.requiredScopes?.map((scope) => (
                  <li
                    key={scope}
                    className="break-all font-mono text-metadata text-muted-foreground"
                  >
                    {scope}
                  </li>
                ))}
              </ul>
            </details>
          )}

          {panel.error && (
            <div
              role="alert"
              className="flex flex-col items-start gap-2 text-secondary text-destructive"
            >
              <p>{panel.error}</p>
              {panel.setupUrl && (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => void openExternal(panel.setupUrl!)}
                >
                  <ExternalLink className="h-3.5 w-3.5" />
                  View provider requirements
                </Button>
              )}
            </div>
          )}
        </div>

        <DialogFooter>
          {canCancel && (
            <Button
              type="button"
              variant="outline"
              disabled={cancelling || !management || !accountId}
              onClick={() => void cancel()}
            >
              {cancelling && <Loader2 className="h-4 w-4 animate-spin" />}
              Cancel authorization
            </Button>
          )}
          <Button type="button" variant="outline" onClick={onClose}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function PluginSetupDialog({
  accountId,
  plugin,
  onClose,
  onOpenHosted,
}: {
  accountId: string;
  plugin: ClassifiedPluginManifest | null;
  onClose: () => void;
  onOpenHosted: (provider: HostedMcpProvider) => void;
}) {
  const management = usePluginManagementCapability();
  const connection = usePluginStore((state) =>
    plugin ? selectPluginConnectionsForAccount(state, accountId)[plugin.id] : undefined,
  );
  const [draft, setDraft] = React.useState<Record<string, string>>({});
  const [testing, setTesting] = React.useState(false);
  const [error, setError] = React.useState('');
  const [setupUrl, setSetupUrl] = React.useState('');
  const [useProjectKey, setUseProjectKey] = React.useState(false);
  const [authorizationUserCode, setAuthorizationUserCode] = React.useState('');

  React.useEffect(() => {
    setDraft({});
    setError('');
    setSetupUrl('');
    setUseProjectKey(false);
    setAuthorizationUserCode('');
  }, [accountId, plugin?.id]);

  React.useEffect(() => {
    if (connection?.state === 'connected' || connection?.state === 'error' ||
        connection?.state === 'expired' || connection?.state === 'reauthorize') {
      setAuthorizationUserCode('');
    }
  }, [connection?.state, connection?.updatedAt]);

  if (!plugin) return null;

  const activePlugin = plugin;
  const compatibility = PLUGIN_COMPATIBILITY_BY_ID[activePlugin.id];
  const authorizationCapability = activePlugin.authorizationCapability;
  const usesProviderAuthorization = isProviderHostedAuthorization(authorizationCapability);
  const isExternallyBlocked = authorizationCapability.kind === 'external_blocker' && !useProjectKey;
  const configuredFields = new Set(connection?.configuredFields ?? []);
  const hasAutomatedTest = Boolean(activePlugin.httpTest) || activePlugin.authType === 'none';
  const providerConnectLabel = `Continue with ${activePlugin.provider}`;
  const requiresLocalCredential =
    (authorizationCapability.kind === 'manual_fallback' || useProjectKey) &&
    activePlugin.fields.length > 0;
  const displayedSetupSteps = useProjectKey
    ? [
        'Enter your Supabase project URL and a publishable or anon API key.',
        'Choose Connect to verify access. This connects the project API only; hosted browser sign-in is separate.',
      ]
    : usesProviderAuthorization
      ? [
          `Choose Continue with ${activePlugin.provider}.`,
          'Review the exact permissions on the provider-owned authorization page.',
          'Approve or decline there, then return to VibeSpace for verification.',
        ]
      : authorizationCapability.kind === 'manual_fallback'
        ? [...authorizationCapability.externalPrerequisites, ...activePlugin.setupSteps]
        : authorizationCapability.kind === 'external_blocker'
          ? [...authorizationCapability.externalPrerequisites]
          : activePlugin.setupSteps;

  async function authorize() {
    setError('');
    setSetupUrl('');
    setAuthorizationUserCode('');
    if (!accountId || !management) {
      setError('Plugin management is unavailable until account setup finishes.');
      return;
    }
    setTesting(true);
    try {
      const result = await management.beginAuthorization({
        accountId,
        pluginId: activePlugin.id,
      });
      if (!result.ok) {
        setError(result.error);
        setSetupUrl(result.setupUrl ?? '');
        return;
      }
      setAuthorizationUserCode(result.state === 'connected' ? '' : result.userCode ?? '');
      if (result.authorizationUrl) {
        await openExternal(result.authorizationUrl);
      }
      if (result.state === 'connected') {
        toast.success(`${activePlugin.name} connected`, 'Provider authorization is verified.');
      } else {
        toast.info(
          `${activePlugin.provider} authorization opened`,
          result.userCode
            ? `Enter code ${result.userCode} on the provider page.`
            : 'Approve access in the provider page, then return to VibeSpace.',
        );
      }
    } catch {
      setError(`Could not open the ${activePlugin.provider} authorization flow.`);
    } finally {
      setTesting(false);
    }
  }

  async function cancelAuthorization() {
    if (!accountId || !management) return;
    setTesting(true);
    try {
      await management.cancelAuthorization({ accountId, pluginId: activePlugin.id });
      toast.info(`${activePlugin.name} authorization cancelled`);
      onClose();
    } finally {
      setTesting(false);
    }
  }

  async function connect() {
    setError('');
    if (!accountId || !management) {
      setError('Plugin management is unavailable until account setup finishes.');
      return;
    }
    for (const field of activePlugin.fields) {
      if (field.required && !draft[field.id]?.trim() && !configuredFields.has(field.id)) {
        setError(`${field.label} is required.`);
        return;
      }
    }
    setTesting(true);
    try {
      for (const field of activePlugin.fields) {
        const value = draft[field.id]?.trim();
        if (value) {
          await management.saveCredential({
            accountId,
            pluginId: activePlugin.id,
            fieldId: field.id,
            value,
          });
        }
      }
      const result = await management.testConnection({
        accountId,
        pluginId: activePlugin.id,
      });
      const configured = activePlugin.fields
        .filter((field) => Boolean(draft[field.id]?.trim()) || configuredFields.has(field.id))
        .map((field) => field.id);
      if (!result.ok) {
        setError(result.error ?? 'Connection test failed.');
        if (!hasAutomatedTest && configured.length > 0) {
          toast.info(
            `${activePlugin.name} credentials saved`,
            'Manual Setup Required — finish provider setup, then test again.',
          );
        }
        return;
      }
      setDraft({});
      toast.success(`${activePlugin.name} connected`, 'Terminal capability context is enabled.');
    } finally {
      setTesting(false);
    }
  }

  async function disconnect() {
    if (!accountId || !management) {
      setError('Plugin management is unavailable until account setup finishes.');
      return;
    }
    setTesting(true);
    try {
      await management.disconnect({ accountId, pluginId: activePlugin.id });
      toast.success(
        `${activePlugin.name} disconnected`,
        'Saved credentials were removed from the keychain.',
      );
      onClose();
    } finally {
      setTesting(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sakura-plugin-dialog max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <PluginLogo plugin={plugin} size="sm" />
            <span>
              {connection?.state === 'connected'
                ? `Manage ${plugin.name}`
                : `Connect ${plugin.name}`}
            </span>
          </DialogTitle>
          <DialogDescription>
            {useProjectKey
              ? 'Connect limited project API access using a publishable or anon key. Your existing database access rules still apply.'
              : usesProviderAuthorization
                ? `Authorize ${plugin.name} on ${plugin.provider}’s official page. VibeSpace receives only a token-free connection receipt in this interface.`
                : isExternallyBlocked
                  ? authorizationCapability.reason
                  : plugin.help}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <div>
            <p className="text-metadata uppercase tracking-wide text-muted-foreground mb-1">
              What this plugin does
            </p>
            <p className="text-secondary text-muted-foreground">{plugin.description}</p>
            <p className="mt-1 text-metadata text-muted-foreground">
              Provider: {plugin.provider} · Auth: {plugin.authType.replace(/_/g, ' ')}
            </p>
            <p className="mt-1 text-metadata text-muted-foreground">
              Connection method:{' '}
              {useProjectKey ? 'Project API key' : authorizationCapability.kind.replace(/_/g, ' ')}
            </p>
          </div>

          {hostedMcpProvider(plugin.id) && (
            <div className="space-y-2 rounded-xl border border-border bg-panel p-3">
              <p className="text-secondary font-medium">Browser sign-in with {plugin.name}</p>
              <p className="text-metadata text-muted-foreground">
                Connect the official hosted server through OpenCode. Its OAuth connection is managed
                separately from this catalog’s API connection. Existing key or token fields below
                remain available for the API features they support.
              </p>
              <Button type="button" onClick={() => onOpenHosted(hostedMcpProvider(plugin.id)!)}>
                Connect {plugin.name} with browser sign-in
              </Button>
            </div>
          )}

          {(plugin.requiredScopes?.length ?? 0) > 0 && (
            <div className="rounded-md border border-accent-cyan/25 bg-accent-cyan/5 p-3">
              <p className="text-secondary font-medium text-foreground">Required provider scopes</p>
              <p className="mt-1 text-metadata text-muted-foreground">
                VibeSpace uses only these declared permissions for this connector.
              </p>
              <ul className="mt-2 flex flex-col gap-1" aria-label="Required provider scopes">
                {plugin.requiredScopes?.map((scope) => (
                  <li
                    key={scope}
                    className="break-all rounded border border-border/70 bg-background/60 px-2 py-1 font-mono text-metadata text-foreground"
                  >
                    <span>{scope}</span>
                    {compatibility.highRiskScopes.includes(scope) ? (
                      <span className="ml-1 text-warning">· elevated permission</span>
                    ) : null}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {usesProviderAuthorization && (
            <div className="mc7f-plugins-credential-hero relative overflow-hidden rounded-2xl border border-accent-cyan/20 bg-gradient-to-br from-accent-cyan/10 via-elevated to-purple-500/10 p-4 [html[data-theme=monochrome]_&]:rounded-none [html[data-theme=monochrome]_&]:bg-none">
              <div className="pointer-events-none absolute -right-10 -top-10 h-28 w-28 rounded-full bg-accent-cyan/20 blur-3xl [html[data-theme=monochrome]_&]:hidden" />
              <div className="relative flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <p className="text-ui-strong text-foreground">
                    Sign in with {activePlugin.provider}
                  </p>
                  <p className="text-secondary text-muted-foreground">
                    Authorization happens on the official provider page. VibeSpace never asks for
                    your provider password, refresh grant, or client secret.
                  </p>
                </div>
                <Button type="button" disabled={testing} onClick={() => void authorize()}>
                  {testing ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <ExternalLink className="h-4 w-4" />
                  )}
                  {providerConnectLabel}
                </Button>
              </div>
              {authorizationUserCode && (
                <div role="status" className="relative mt-3 rounded-md border border-border bg-panel p-3 text-secondary">
                  <p>Enter this code on the {activePlugin.provider} authorization page:</p>
                  <p className="mt-1">
                    Provider code: <strong className="select-all font-mono text-foreground">{authorizationUserCode}</strong>
                  </p>
                  <p className="mt-1 text-metadata text-muted-foreground">Keep this dialog open until authorization completes.</p>
                </div>
              )}
            </div>
          )}

          {authorizationCapability.kind === 'manual_fallback' && activePlugin.providerAccessUrl && (
            <div className="rounded-xl border border-accent-cyan/20 bg-accent-cyan/5 p-3">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <p className="text-secondary font-medium text-foreground">
                    Official provider account page
                  </p>
                  <p className="text-metadata text-muted-foreground">
                    Sign in or create your {activePlugin.provider} account on the provider-owned
                    page. Keep this panel open to finish the supported credential fallback.
                  </p>
                </div>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => void openExternal(activePlugin.providerAccessUrl!)}
                >
                  <ExternalLink className="h-3.5 w-3.5" />
                  Open {activePlugin.name} account page
                </Button>
              </div>
            </div>
          )}

          {isExternallyBlocked && (
            <div
              role="alert"
              className="rounded-xl border border-destructive/30 bg-destructive/5 p-3"
            >
              <p className="text-secondary font-medium text-destructive">
                External authorization prerequisite
              </p>
              <p className="mt-1 text-secondary text-muted-foreground">
                {authorizationCapability.reason}
              </p>
              {authorizationCapability.providerAccessUrl && (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="mt-3"
                  onClick={() => void openExternal(authorizationCapability.providerAccessUrl!)}
                >
                  <ExternalLink className="h-3.5 w-3.5" />
                  Open {activePlugin.provider} configuration
                </Button>
              )}
            </div>
          )}

          {displayedSetupSteps.length > 0 && (
            <div>
              <p className="text-metadata uppercase tracking-wide text-muted-foreground mb-1">
                Setup steps
              </p>
              <ol className="list-decimal pl-5 text-secondary text-muted-foreground space-y-1">
                {displayedSetupSteps.map((step) => (
                  <li key={step}>{step}</li>
                ))}
              </ol>
            </div>
          )}

          {activePlugin.id === 'supabase' && (
            <div className="space-y-2 rounded-xl border border-border p-3">
              <p className="text-secondary font-medium">Project API-key fallback</p>
              <p className="text-metadata text-muted-foreground">
                For the limited project API connector, you can use a publishable or anon key. This
                does not authorize the hosted MCP server. Service-role and secret keys are rejected.
              </p>
              <Button
                type="button"
                variant="outline"
                aria-pressed={useProjectKey}
                onClick={() => setUseProjectKey((value) => !value)}
              >
                {useProjectKey ? 'Hide project API-key fields' : 'Use a project API key instead'}
              </Button>
            </div>
          )}

          {requiresLocalCredential && (
            <div className="rounded-xl border border-border bg-panel/70 p-3">
              <div className="mb-3 flex items-start gap-2">
                <ShieldCheck className="mt-0.5 h-4 w-4 text-success" />
                <div>
                  <p className="text-secondary font-medium text-foreground">
                    Secure credential storage
                  </p>
                  <p className="text-metadata text-muted-foreground">
                    Values saved here go to the OS keychain on desktop (session-only memory in
                    browser preview). VibeSpace does not print them in logs or terminal context.
                  </p>
                </div>
              </div>
              <div className="flex flex-col gap-3">
                {plugin.fields.map((field) => (
                  <div key={field.id} className="flex flex-col gap-1.5">
                    <Label htmlFor={`plugin-${plugin.id}-${field.id}`}>{field.label}</Label>
                    <Input
                      id={`plugin-${plugin.id}-${field.id}`}
                      type={field.secret ? 'password' : 'text'}
                      autoComplete="off"
                      value={draft[field.id] ?? ''}
                      placeholder={
                        configuredFields.has(field.id)
                          ? 'Saved securely - enter a new value to replace'
                          : field.placeholder
                      }
                      onChange={(event) =>
                        setDraft((current) => ({ ...current, [field.id]: event.target.value }))
                      }
                    />
                    {field.help && (
                      <p className="text-metadata text-muted-foreground">{field.help}</p>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {authorizationCapability.kind === 'no_auth' && (
            <div className="rounded-md border border-border bg-panel p-3 flex gap-2">
              <CheckCircle2 className="h-4 w-4 text-success" />
              <span className="text-secondary text-muted-foreground">
                No credentials are required.
              </span>
            </div>
          )}

          {plugin.limitations && !useProjectKey && (
            <p className="text-metadata text-muted-foreground">{plugin.limitations}</p>
          )}

          <div>
            <p className="text-metadata uppercase tracking-wide text-muted-foreground mb-1">
              Declared tools
            </p>
            <div className="flex flex-wrap gap-1.5">
              {plugin.tools.map((tool) => (
                <Badge key={tool.name} variant="outline">
                  {tool.name}
                  {tool.readOnly ? ' · read-only' : ''}
                </Badge>
              ))}
            </div>
          </div>

          {plugin.docsUrl && (
            <a
              className="inline-flex items-center gap-1 text-secondary text-accent-cyan hover:underline"
              href={plugin.docsUrl}
              target="_blank"
              rel="noreferrer"
            >
              Open connection documentation <ExternalLink className="h-3.5 w-3.5" />
            </a>
          )}

          {error && (
            <div
              role="alert"
              className="flex flex-col items-start gap-2 text-secondary text-destructive"
            >
              <p>{error}</p>
              {setupUrl && (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => void openExternal(setupUrl)}
                >
                  <ExternalLink className="h-3.5 w-3.5" />
                  View provider requirements
                </Button>
              )}
            </div>
          )}
        </div>

        <DialogFooter className="justify-between">
          <div>
            {connection &&
              (connection.state === 'connecting' || connection.state === 'awaiting_approval' ? (
                <Button
                  type="button"
                  variant="outline"
                  disabled={testing || !accountId || !management}
                  onClick={() => void cancelAuthorization()}
                >
                  Cancel authorization
                </Button>
              ) : (
                <Button
                  type="button"
                  variant="destructive"
                  disabled={testing || !accountId || !management}
                  onClick={() => void disconnect()}
                >
                  <Unplug className="h-4 w-4" /> Disconnect
                </Button>
              ))}
          </div>
          <div className="flex gap-2">
            <Button type="button" variant="outline" onClick={onClose}>
              Close
            </Button>
            {!usesProviderAuthorization && !isExternallyBlocked && (
              <Button
                type="button"
                disabled={testing || !accountId || !management}
                onClick={() => void connect()}
              >
                {testing && <Loader2 className="h-4 w-4 animate-spin" />}
                {connection ? 'Test Connection' : 'Connect'}
              </Button>
            )}
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
