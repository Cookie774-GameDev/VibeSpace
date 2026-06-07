import * as React from 'react';
import {
  CheckCircle2,
  ExternalLink,
  KeyRound,
  Loader2,
  Plug,
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
import { PLUGIN_CATALOG } from './catalog';
import { deletePluginCredential, setPluginCredential } from './credentials';
import { testPluginConnection } from './runtime';
import { usePluginStore } from './store';
import type { PluginConnection, PluginManifest } from './types';

type Filter = 'all' | 'available' | 'connected' | 'planned';

const STATUS_LABELS = {
  connected: 'Connected',
  not_connected: 'Not connected',
  needs_setup: 'Needs setup',
  error: 'Error',
} as const;

export function Plugins() {
  const connections = usePluginStore((state) => state.connections);
  const setEnabled = usePluginStore((state) => state.setEnabled);
  const [query, setQuery] = React.useState('');
  const [filter, setFilter] = React.useState<Filter>('all');
  const [selected, setSelected] = React.useState<PluginManifest | null>(null);

  const visible = React.useMemo(() => {
    const needle = query.trim().toLowerCase();
    return PLUGIN_CATALOG.filter((plugin) => {
      const connection = connections[plugin.id];
      if (filter === 'available' && plugin.status !== 'implemented') return false;
      if (filter === 'connected' && connection?.state !== 'connected') return false;
      if (filter === 'planned' && plugin.status !== 'planned') return false;
      return (
        !needle ||
        plugin.name.toLowerCase().includes(needle) ||
        plugin.description.toLowerCase().includes(needle) ||
        plugin.category.toLowerCase().includes(needle)
      );
    });
  }, [connections, filter, query]);

  const connectedCount = Object.values(connections).filter(
    (connection) => connection.state === 'connected',
  ).length;

  return (
    <div className="flex flex-col gap-5">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-page-title text-foreground">Plugins</h2>
          <p className="mt-1 max-w-2xl text-secondary text-muted-foreground">
            Connect external services and expose controlled capabilities to Jarvis agents working in
            terminals. Credentials stay in the operating-system keychain.
          </p>
        </div>
        <Badge variant={connectedCount ? 'success' : 'outline'}>{connectedCount} connected</Badge>
      </header>

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
          const connectionState =
            connection?.state ??
            (plugin.status === 'implemented' ? 'not_connected' : 'needs_setup');
          return (
            <Card key={plugin.id} data-testid={`plugin-card-${plugin.id}`}>
              <CardHeader className="pb-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="h-8 w-8 rounded-md bg-elevated flex items-center justify-center">
                        <Plug className="h-4 w-4 text-accent-cyan" />
                      </span>
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
                          : plugin.status === 'planned'
                            ? 'outline'
                            : 'warning'
                    }
                  >
                    {plugin.status === 'planned' ? 'Planned' : STATUS_LABELS[connectionState]}
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
                        onCheckedChange={(enabled) => setEnabled(plugin.id, enabled)}
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
                    disabled={plugin.status !== 'implemented'}
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
              </CardContent>
            </Card>
          );
        })}
      </div>

      {visible.length === 0 && (
        <div className="rounded-lg border border-dashed border-border p-10 text-center text-secondary text-muted-foreground">
          No plugins match this search.
        </div>
      )}

      <PluginSetupDialog plugin={selected} onClose={() => setSelected(null)} />
    </div>
  );
}

function PluginSetupDialog({
  plugin,
  onClose,
}: {
  plugin: PluginManifest | null;
  onClose: () => void;
}) {
  const connection = usePluginStore((state) => (plugin ? state.connections[plugin.id] : undefined));
  const upsertConnection = usePluginStore((state) => state.upsertConnection);
  const removeConnection = usePluginStore((state) => state.removeConnection);
  const [draft, setDraft] = React.useState<Record<string, string>>({});
  const [testing, setTesting] = React.useState(false);
  const [error, setError] = React.useState('');

  React.useEffect(() => {
    setDraft({});
    setError('');
  }, [plugin?.id]);

  if (!plugin) return null;

  const activePlugin = plugin;
  const configuredFields = new Set(connection?.configuredFields ?? []);

  async function connect() {
    setError('');
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
        if (value) await setPluginCredential(activePlugin.id, field.id, value);
      }
      const result = await testPluginConnection(activePlugin.id);
      const configured = activePlugin.fields
        .filter((field) => Boolean(draft[field.id]?.trim()) || configuredFields.has(field.id))
        .map((field) => field.id);
      const next: PluginConnection = {
        pluginId: activePlugin.id,
        state: result.ok ? 'connected' : 'error',
        enabled: result.ok ? (connection?.enabled ?? true) : false,
        enabledProjectIds: connection?.enabledProjectIds ?? ['*'],
        accountLabel: result.accountLabel,
        error: result.error,
        lastTestedAt: Date.now(),
        configuredFields: configured,
        updatedAt: Date.now(),
      };
      upsertConnection(next);
      if (!result.ok) {
        setError(result.error ?? 'Connection test failed.');
        return;
      }
      setDraft({});
      toast.success(`${activePlugin.name} connected`, 'Terminal capability context is enabled.');
    } finally {
      setTesting(false);
    }
  }

  async function disconnect() {
    setTesting(true);
    try {
      await Promise.all(
        activePlugin.fields.map((field) => deletePluginCredential(activePlugin.id, field.id)),
      );
      removeConnection(activePlugin.id);
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
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>
            {connection?.state === 'connected' ? `Manage ${plugin.name}` : `Connect ${plugin.name}`}
          </DialogTitle>
          <DialogDescription>{plugin.help}</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
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
              {field.help && <p className="text-metadata text-muted-foreground">{field.help}</p>}
            </div>
          ))}

          {plugin.fields.length === 0 && (
            <div className="rounded-md border border-border bg-panel p-3 flex gap-2">
              <CheckCircle2 className="h-4 w-4 text-success" />
              <span className="text-secondary text-muted-foreground">
                No credentials are required.
              </span>
            </div>
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
                disabled={testing}
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
            <Button type="button" disabled={testing} onClick={() => void connect()}>
              {testing && <Loader2 className="h-4 w-4 animate-spin" />}
              {connection ? 'Test and save' : 'Connect'}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
