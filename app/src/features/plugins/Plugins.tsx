import * as React from 'react';
import './sakura-plugins.css';
import {
  CheckCircle2,
  ChevronDown,
  ChevronUp,
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
import { PLUGIN_CATALOG } from './catalog';
import { usePluginManagementCapability } from './managementContext';
import { pluginSearchBlob } from './providerRegistry';
import {
  selectPinnedPluginIdsForAccount,
  selectPluginConnectionsForAccount,
  usePluginStore,
} from './store';
import type { PluginConnection, PluginManifest } from './types';
import { isConnectableStatus } from './types';
import { PluginLogo } from './PluginLogo';
import { McpConnections } from '@/features/settings/sections/McpConnections';
import { PLUGIN_COMPATIBILITY_BY_ID } from './compatibilityMatrix';

type Filter = 'all' | 'available' | 'connected' | 'planned';

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

function defaultConnectionState(plugin: PluginManifest): PluginConnection['state'] {
  if (plugin.status === 'needs_credentials' || plugin.status === 'blocked') return 'needs_setup';
  return isConnectableStatus(plugin.status) ? 'not_connected' : 'needs_setup';
}

function statusBadgeLabel(
  plugin: PluginManifest,
  connectionState: PluginConnection['state'],
): string {
  if (plugin.status === 'needs_credentials' || plugin.status === 'blocked') {
    if (connectionState === 'connected') return STATUS_LABELS.connected;
    if (connectionState === 'error') return STATUS_LABELS.error;
    return 'Manual Setup Required';
  }
  if (plugin.status === 'configurable' && connectionState === 'needs_setup') {
    return 'Manual Setup Required';
  }
  return STATUS_LABELS[connectionState];
}

export function Plugins() {
  const accountId = useAuthStore((state) => resolveAccountIdentity(state)?.accountId ?? '');
  const connections = usePluginStore((state) =>
    selectPluginConnectionsForAccount(state, accountId),
  );
  const setEnabled = usePluginStore((state) => state.setEnabled);
  const pinnedPluginIds = usePluginStore((state) =>
    selectPinnedPluginIdsForAccount(state, accountId),
  );
  const pinPlugin = usePluginStore((state) => state.pinPlugin);
  const unpinPlugin = usePluginStore((state) => state.unpinPlugin);
  const movePinnedPlugin = usePluginStore((state) => state.movePinnedPlugin);
  const [query, setQuery] = React.useState('');
  const [filter, setFilter] = React.useState<Filter>('all');
  const [selected, setSelected] = React.useState<PluginManifest | null>(null);
  const [mcpOpen, setMcpOpen] = React.useState(false);

  const visible = React.useMemo(() => {
    const needle = query.trim().toLowerCase();
    return PLUGIN_CATALOG.filter((plugin) => {
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
            aria-label="Add MCP connection"
            aria-expanded={mcpOpen}
            onClick={() => setMcpOpen((open) => !open)}
          >
            <Plus />
          </Button>
        </div>
      </header>

      {mcpOpen && <McpConnections />}

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
            placeholder={`Search ${PLUGIN_CATALOG.length} plugins`}
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
                        checked={connection.enabled}
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
                  <Button
                    type="button"
                    size="sm"
                    variant={connection?.state === 'connected' ? 'outline' : 'default'}
                    disabled={!isConnectableStatus(plugin.status)}
                    onClick={() => setSelected(plugin)}
                  >
                    {connection?.state === 'connected' ? (
                      <>
                        <Settings2 className="h-3.5 w-3.5" /> Manage
                      </>
                    ) : (
                      <>
                        <KeyRound className="h-3.5 w-3.5" /> Connect
                      </>
                    )}
                  </Button>
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

      <PluginSetupDialog
        accountId={accountId}
        plugin={selected}
        onClose={() => setSelected(null)}
      />
    </div>
  );
}

function PluginSetupDialog({
  accountId,
  plugin,
  onClose,
}: {
  accountId: string;
  plugin: PluginManifest | null;
  onClose: () => void;
}) {
  const management = usePluginManagementCapability();
  const connection = usePluginStore((state) =>
    plugin ? selectPluginConnectionsForAccount(state, accountId)[plugin.id] : undefined,
  );
  const [draft, setDraft] = React.useState<Record<string, string>>({});
  const [testing, setTesting] = React.useState(false);
  const [error, setError] = React.useState('');

  React.useEffect(() => {
    setDraft({});
    setError('');
  }, [plugin?.id]);

  if (!plugin) return null;

  const activePlugin = plugin;
  const compatibility = PLUGIN_COMPATIBILITY_BY_ID[activePlugin.id];
  const configuredFields = new Set(connection?.configuredFields ?? []);
  const hasAutomatedTest = Boolean(activePlugin.httpTest) || activePlugin.authType === 'none';
  const providerConnectLabel =
    activePlugin.authType === 'oauth'
      ? `Continue with ${activePlugin.provider}`
      : `Open ${activePlugin.provider} connect page`;
  const requiresLocalCredential = activePlugin.fields.length > 0;

  function openProviderConnect() {
    if (!activePlugin.credentialUrl) return;
    setError('');
    void openExternal(activePlugin.credentialUrl).then(
      () =>
        toast.info(
          `${activePlugin.provider} opened`,
          requiresLocalCredential
            ? 'Finish the provider setup in your browser, then paste the returned credential here.'
            : 'Finish the provider authorization in your browser, then return to VibeSpace.',
        ),
      () => setError(`Could not open the ${activePlugin.provider} setup page.`),
    );
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
          <DialogDescription>{plugin.help}</DialogDescription>
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
              Connection method: {compatibility.connectionClass.replace(/_/g, ' ')} ·{' '}
              {compatibility.redirectMethod.replace(/_/g, ' ')}
            </p>
          </div>

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

          {plugin.credentialUrl && (
            <div className="mc7f-plugins-credential-hero relative overflow-hidden rounded-2xl border border-accent-cyan/20 bg-gradient-to-br from-accent-cyan/10 via-elevated to-purple-500/10 p-4 [html[data-theme=monochrome]_&]:rounded-none [html[data-theme=monochrome]_&]:bg-none">
              <div className="pointer-events-none absolute -right-10 -top-10 h-28 w-28 rounded-full bg-accent-cyan/20 blur-3xl [html[data-theme=monochrome]_&]:hidden" />
              <div className="relative flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <p className="text-ui-strong text-foreground">
                    {activePlugin.authType === 'oauth'
                      ? `Sign in with ${activePlugin.provider}`
                      : `Connect through ${activePlugin.provider}`}
                  </p>
                  <p className="text-secondary text-muted-foreground">
                    {activePlugin.authType === 'oauth'
                      ? 'Start from the official provider page. VibeSpace never asks for your password.'
                      : 'We send you to the official provider page first, then store only the credential you choose to save.'}
                  </p>
                </div>
                <Button type="button" onClick={openProviderConnect}>
                  <ExternalLink className="h-4 w-4" />
                  {providerConnectLabel}
                </Button>
              </div>
            </div>
          )}

          {plugin.setupSteps.length > 0 && (
            <div>
              <p className="text-metadata uppercase tracking-wide text-muted-foreground mb-1">
                Setup steps
              </p>
              <ol className="list-decimal pl-5 text-secondary text-muted-foreground space-y-1">
                {plugin.setupSteps.map((step) => (
                  <li key={step}>{step}</li>
                ))}
              </ol>
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

          {plugin.fields.length === 0 && (
            <div className="rounded-md border border-border bg-panel p-3 flex gap-2">
              <CheckCircle2 className="h-4 w-4 text-success" />
              <span className="text-secondary text-muted-foreground">
                No credentials are required.
              </span>
            </div>
          )}

          {plugin.limitations && (
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
            <p role="alert" className="text-secondary text-destructive">
              {error}
            </p>
          )}
        </div>

        <DialogFooter className="justify-between">
          <div>
            {connection && (
              <Button
                type="button"
                variant="destructive"
                disabled={testing || !accountId || !management}
                onClick={() => void disconnect()}
              >
                <Unplug className="h-4 w-4" /> Disconnect
              </Button>
            )}
          </div>
          <div className="flex gap-2">
            <Button type="button" variant="outline" onClick={onClose}>
              Close
            </Button>
            <Button
              type="button"
              disabled={testing || !accountId || !management}
              onClick={() => void connect()}
            >
              {testing && <Loader2 className="h-4 w-4 animate-spin" />}
              {connection ? 'Test Connection' : 'Connect'}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
