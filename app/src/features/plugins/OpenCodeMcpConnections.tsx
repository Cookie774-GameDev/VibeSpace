import * as React from 'react';
import { Loader2, Plus, RefreshCw } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { getStoredProjectRoot } from '@/features/files/projectFiles';
import {
  createOpenCodeHttpClient,
  type OpenCodeHttpClient,
  type OpenCodeMcpConfig,
  type OpenCodeMcpStatus,
} from '@/lib/harness/openCodeClient';
import {
  harnessRuntimeManager,
  type HarnessRuntimeManager,
  type OpenCodeServerConnection,
} from '@/lib/harness/runtimeManager';
import { useAuthStore } from '@/stores/auth';
import { isTauri } from '@/lib/utils';
import { HOSTED_MCP_PROVIDERS, type HostedMcpProvider } from './hostedMcpProviders';

type ServerKind = 'remote' | 'local';

export interface OpenCodeMcpConnectionsProps {
  runtime?: HarnessRuntimeManager;
  clientFactory?: (connection: OpenCodeServerConnection) => OpenCodeHttpClient;
  directory?: string;
  initialProvider?: HostedMcpProvider;
}

const STATUS_ERROR = 'OpenCode MCP status is unavailable.';
const ACTION_ERROR = 'OpenCode could not update this MCP server.';

const STATUS_LABELS: Record<OpenCodeMcpStatus['status'], string> = {
  connected: 'Connected',
  disabled: 'Disconnected',
  needs_auth: 'Authorization needed',
  failed: 'Connection failed',
  needs_client_registration: 'Registration needed',
};

function statusVariant(status: OpenCodeMcpStatus['status']) {
  if (status === 'connected') return 'success' as const;
  if (status === 'failed') return 'destructive' as const;
  if (status === 'disabled') return 'outline' as const;
  return 'warning' as const;
}

export function OpenCodeMcpConnections({
  runtime = harnessRuntimeManager,
  clientFactory = createOpenCodeHttpClient,
  directory: configuredDirectory,
  initialProvider,
}: OpenCodeMcpConnectionsProps) {
  const projectId = useAuthStore((state) => state.projectId);
  const directory = configuredDirectory ?? (getStoredProjectRoot(projectId).trim() || undefined);
  const runtimeState = React.useSyncExternalStore(
    runtime.subscribe,
    runtime.getSnapshot,
    runtime.getSnapshot,
  );
  const connection = runtime.getConnection();
  const client = React.useMemo(
    () => (connection ? clientFactory(connection) : undefined),
    [clientFactory, connection],
  );
  const authorityKey =
    client && connection ? `${connection.generation}\u0000${directory ?? ''}` : undefined;
  const [servers, setServers] = React.useState<Readonly<Record<string, OpenCodeMcpStatus>>>({});
  const [error, setError] = React.useState<string>();
  const [busy, setBusy] = React.useState<string>();
  const [authorizing, setAuthorizing] = React.useState<string>();
  const pendingAuthorization = React.useRef<
    | {
        client: OpenCodeHttpClient;
        name: string;
        directory?: string;
      }
    | undefined
  >(undefined);
  const [projectionAuthority, setProjectionAuthority] = React.useState<string>();
  const [kind, setKind] = React.useState<ServerKind>('remote');
  const [name, setName] = React.useState('');
  const [remoteUrl, setRemoteUrl] = React.useState('');
  const [localCommand, setLocalCommand] = React.useState('');
  const generation = React.useRef(0);

  React.useEffect(() => {
    if (!initialProvider) return;
    setKind('remote');
    setName(initialProvider.id);
    setRemoteUrl(initialProvider.url);
  }, [initialProvider]);

  const loadStatus = React.useCallback(async () => {
    if (!client || !authorityKey) return;
    const current = ++generation.current;
    setProjectionAuthority(authorityKey);
    setBusy('refresh');
    setError(undefined);
    try {
      const next = await client.mcpStatus(directory);
      if (current === generation.current) setServers(next);
    } catch {
      if (current === generation.current) setError(STATUS_ERROR);
    } finally {
      if (current === generation.current) setBusy(undefined);
    }
  }, [authorityKey, client, directory]);

  React.useEffect(() => {
    generation.current += 1;
    setProjectionAuthority(authorityKey);
    setServers({});
    setError(undefined);
    setBusy(undefined);
    setAuthorizing(undefined);
    if (client) {
      void loadStatus();
      return () => {
        generation.current += 1;
        const pending = pendingAuthorization.current;
        pendingAuthorization.current = undefined;
        if (pending)
          void pending.client.removeMcpAuth(pending.name, pending.directory).catch(() => undefined);
      };
    }
    if (runtimeState.kind === 'checking') void runtime.refresh();
    return undefined;
  }, [authorityKey, client, loadStatus, runtime, runtimeState.kind]);

  async function authorizeServer(serverName: string, current: number) {
    if (!client || current !== generation.current) return;
    const pending = { client, name: serverName, directory };
    pendingAuthorization.current = pending;
    setAuthorizing(serverName);
    setBusy(`authorize:${serverName}`);
    try {
      const result = await client.authenticateMcp(serverName, directory);
      if (current !== generation.current) return;
      if (result.status !== 'connected') throw new Error(ACTION_ERROR);
      const next = await client.mcpStatus(directory);
      if (current !== generation.current) return;
      setServers(next);
      if (next[serverName]?.status !== 'connected') throw new Error(ACTION_ERROR);
    } finally {
      if (pendingAuthorization.current === pending) pendingAuthorization.current = undefined;
      if (current === generation.current) setAuthorizing(undefined);
    }
  }

  async function cancelAuthorization() {
    const pending = pendingAuthorization.current;
    if (!pending) return;
    pendingAuthorization.current = undefined;
    const current = ++generation.current;
    setAuthorizing(undefined);
    setBusy('cancel-authorization');
    setError(undefined);
    try {
      if (!(await pending.client.removeMcpAuth(pending.name, pending.directory)))
        throw new Error(ACTION_ERROR);
      const next = await pending.client.mcpStatus(pending.directory);
      if (current === generation.current) setServers(next);
    } catch {
      if (current === generation.current) setError(ACTION_ERROR);
    } finally {
      if (current === generation.current) setBusy(undefined);
    }
  }

  function needsAuthorization(status: OpenCodeMcpStatus | undefined) {
    return status?.status === 'needs_auth' || status?.status === 'needs_client_registration';
  }

  async function updateServer(nameToUpdate: string, action: 'connect' | 'disconnect') {
    if (!client || !authorityKey) return;
    const current = ++generation.current;
    setProjectionAuthority(authorityKey);
    setBusy(`${action}:${nameToUpdate}`);
    setError(undefined);
    try {
      if (action === 'connect' && needsAuthorization(servers[nameToUpdate])) {
        await authorizeServer(nameToUpdate, current);
        return;
      }
      const ok = await client[`${action}Mcp`](nameToUpdate, directory);
      if (!ok) throw new Error('OpenCode rejected the MCP lifecycle request.');
      const next = await client.mcpStatus(directory);
      if (current !== generation.current) return;
      setServers(next);
      if (action === 'connect' && needsAuthorization(next[nameToUpdate])) {
        await authorizeServer(nameToUpdate, current);
      }
    } catch {
      if (current === generation.current) setError(ACTION_ERROR);
    } finally {
      if (current === generation.current) setBusy(undefined);
    }
  }

  async function addServer(event: React.FormEvent) {
    event.preventDefault();
    if (!client || !authorityKey) return;
    const normalizedName = name.trim();
    const config: OpenCodeMcpConfig =
      kind === 'remote'
        ? { type: 'remote', url: remoteUrl.trim(), enabled: true }
        : {
            type: 'local',
            command: localCommand
              .split('\n')
              .map((part) => part.trim())
              .filter(Boolean),
            enabled: true,
          };
    const current = ++generation.current;
    setProjectionAuthority(authorityKey);
    setBusy('add');
    setError(undefined);
    try {
      const next = await client.addMcp(normalizedName, config, directory);
      if (current !== generation.current) return;
      setServers(next);
      setName('');
      setRemoteUrl('');
      setLocalCommand('');
      if (kind === 'remote' && needsAuthorization(next[normalizedName])) {
        await authorizeServer(normalizedName, current);
      }
    } catch {
      if (current === generation.current) setError(ACTION_ERROR);
    } finally {
      if (current === generation.current) setBusy(undefined);
    }
  }

  const projectionCurrent = authorityKey !== undefined && projectionAuthority === authorityKey;
  const visibleBusy = projectionCurrent ? busy : client ? 'authority-change' : undefined;
  const visibleError = projectionCurrent ? error : undefined;
  const entries = Object.entries(projectionCurrent ? servers : {}).sort(([left], [right]) =>
    left.localeCompare(right, 'en'),
  );
  const ready = Boolean(client);

  return (
    <section className="space-y-4 rounded-lg border border-border bg-card p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-ui-strong text-foreground">OpenCode MCP servers</h3>
          <p className="mt-1 text-secondary text-muted-foreground">
            These are the MCP servers OpenCode uses for this project. Changes apply to OpenCode's
            own configuration and lifecycle.
          </p>
          {directory ? (
            <p className="mt-1 truncate font-mono text-metadata text-muted-foreground">
              {directory}
            </p>
          ) : null}
        </div>
        <Button
          type="button"
          size="icon-sm"
          variant="outline"
          aria-label="Refresh OpenCode MCP status"
          disabled={!ready || Boolean(visibleBusy)}
          onClick={() => void loadStatus()}
        >
          {visibleBusy === 'refresh' ? <Loader2 className="animate-spin" /> : <RefreshCw />}
        </Button>
      </div>

      {!ready ? (
        <p className="text-secondary text-muted-foreground">
          {!isTauri && runtime === harnessRuntimeManager
            ? 'Browser preview cannot start the desktop OAuth runtime. Open VibeSpace desktop to finish provider sign-in.'
            : runtimeState.kind === 'download_required'
              ? 'OpenCode must be installed before MCP servers can be managed.'
              : runtimeState.kind === 'incompatible' || runtimeState.kind === 'failed'
                ? 'OpenCode is unavailable in this app session.'
                : 'Starting OpenCode…'}
        </p>
      ) : null}

      {visibleError ? (
        <p role="alert" className="text-secondary text-destructive">
          {visibleError}
        </p>
      ) : null}

      {projectionCurrent && authorizing ? (
        <div
          role="status"
          className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border p-3"
        >
          <span className="text-secondary text-muted-foreground">
            Complete authorization for {authorizing} in your browser. Waiting for verified
            connection status…
          </span>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => void cancelAuthorization()}
          >
            Cancel authorization
          </Button>
        </div>
      ) : null}

      {ready && !visibleBusy && entries.length === 0 && !visibleError ? (
        <p className="rounded-md border border-dashed border-border p-3 text-secondary text-muted-foreground">
          No OpenCode MCP servers are configured for this project.
        </p>
      ) : null}

      <div className="grid gap-2">
        {entries.map(([serverName, status]) => {
          const connected = status.status === 'connected';
          const action = connected ? 'disconnect' : 'connect';
          return (
            <article
              key={serverName}
              aria-label={`${serverName} MCP server`}
              className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border bg-background/60 p-3"
            >
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-sm text-foreground">{serverName}</span>
                  <Badge variant={statusVariant(status.status)}>
                    {STATUS_LABELS[status.status]}
                  </Badge>
                </div>
                {'error' in status ? (
                  <p className="mt-1 max-w-xl text-metadata text-destructive">{status.error}</p>
                ) : null}
              </div>
              <Button
                type="button"
                size="sm"
                variant="outline"
                aria-label={`${connected ? 'Disconnect' : 'Connect'} ${serverName}`}
                disabled={Boolean(visibleBusy)}
                onClick={() => void updateServer(serverName, action)}
              >
                {visibleBusy === `${action}:${serverName}` ? (
                  <Loader2 className="animate-spin" />
                ) : null}
                {connected ? 'Disconnect' : 'Connect'}
              </Button>
            </article>
          );
        })}
      </div>

      {ready ? (
        <form className="space-y-3 border-t border-border pt-4" onSubmit={addServer}>
          <div className="space-y-1.5">
            <Label htmlFor="opencode-mcp-provider">Official provider</Label>
            <select
              id="opencode-mcp-provider"
              className="w-full rounded-md border border-input bg-background p-2 text-foreground"
              value={
                kind === 'remote'
                  ? (HOSTED_MCP_PROVIDERS.find((provider) => provider.url === remoteUrl)?.id ?? '')
                  : ''
              }
              disabled={Boolean(visibleBusy)}
              onChange={(event) => {
                const provider = HOSTED_MCP_PROVIDERS.find(
                  (item) => item.id === event.target.value,
                );
                if (provider) {
                  setKind('remote');
                  setName(provider.id);
                  setRemoteUrl(provider.url);
                }
              }}
            >
              <option value="">Custom server</option>
              {HOSTED_MCP_PROVIDERS.map((provider) => (
                <option key={provider.id} value={provider.id}>
                  {provider.name}
                </option>
              ))}
            </select>
            <p className="text-metadata text-muted-foreground">
              Adding a provider starts browser authorization when required. Approve access on the
              provider page; this panel confirms the returned connection status.
            </p>
            {HOSTED_MCP_PROVIDERS.filter(
              (provider) => provider.url === remoteUrl && 'setup' in provider,
            ).map((provider) => (
              <p key={provider.id} role="note" className="text-metadata text-warning">
                {'setup' in provider ? provider.setup : ''}{' '}
                <a href={provider.docs} target="_blank" rel="noreferrer">
                  Provider setup guide
                </a>
              </p>
            ))}
          </div>
          <div className="flex flex-wrap items-end gap-2">
            <div className="min-w-[180px] flex-1 space-y-1.5">
              <Label htmlFor="opencode-mcp-name">Server name</Label>
              <Input
                id="opencode-mcp-name"
                value={name}
                required
                autoComplete="off"
                placeholder="example-server"
                onChange={(event) => setName(event.target.value)}
              />
            </div>
            <div className="flex gap-1" aria-label="MCP server type">
              <Button
                type="button"
                size="sm"
                variant={kind === 'remote' ? 'default' : 'outline'}
                aria-pressed={kind === 'remote'}
                onClick={() => setKind('remote')}
              >
                Remote
              </Button>
              <Button
                type="button"
                size="sm"
                variant={kind === 'local' ? 'default' : 'outline'}
                aria-pressed={kind === 'local'}
                onClick={() => setKind('local')}
              >
                Local
              </Button>
            </div>
          </div>
          {kind === 'remote' ? (
            <div className="space-y-1.5">
              <Label htmlFor="opencode-mcp-url">Remote URL</Label>
              <Input
                id="opencode-mcp-url"
                type="url"
                value={remoteUrl}
                required
                autoComplete="off"
                placeholder="https://mcp.example.com/rpc"
                onChange={(event) => setRemoteUrl(event.target.value)}
              />
            </div>
          ) : (
            <div className="space-y-1.5">
              <Label htmlFor="opencode-mcp-command">Local command</Label>
              <textarea
                id="opencode-mcp-command"
                className="min-h-24 w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-sm text-foreground"
                value={localCommand}
                required
                placeholder={'Executable on the first line\nOne argument per additional line'}
                onChange={(event) => setLocalCommand(event.target.value)}
              />
              <p className="text-metadata text-muted-foreground">
                Put the executable on the first line and one argument on each following line.
              </p>
            </div>
          )}
          <Button type="submit" size="sm" disabled={Boolean(visibleBusy)}>
            {visibleBusy === 'add' ? <Loader2 className="animate-spin" /> : <Plus />}
            Add OpenCode MCP server
          </Button>
        </form>
      ) : null}
    </section>
  );
}

export default OpenCodeMcpConnections;
