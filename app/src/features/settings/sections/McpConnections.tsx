import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';

import { Button } from '@/components/ui/button';
import { canonicalRemoteMcpEndpoint } from '@/lib/mcp/remoteAuthorization';
import { getVibeSpaceMcpGateway, type VibeSpaceMcpGateway } from '@/lib/mcp/vibeSpaceGateway';
import { useAuthStore } from '@/stores/auth';

const SAFE_SERVER_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/u;
const SAFE_CONNECTION_ERROR = 'Unable to connect to this MCP server.';

export interface McpConnectionsProps {
  readonly runtime?: VibeSpaceMcpGateway;
}

interface ReviewedConnection {
  readonly name: string;
  readonly description: string;
  readonly id: string;
  readonly endpoint: string;
  readonly transport: 'streamable_http';
  readonly authentication: 'none';
}

interface McpOperationScope {
  readonly accountId: string;
  readonly projectId: string;
  readonly runtime: VibeSpaceMcpGateway;
  readonly generation: number;
  readonly controller: AbortController;
}

export function McpConnections({ runtime: configuredRuntime }: McpConnectionsProps) {
  const accountId = useAuthStore(
    (state) => state.cloudSession?.user_id ?? state.localUserId ?? 'local_account',
  );
  const projectId = useAuthStore(
    (state) => state.projectId ?? state.workspaceId ?? 'default_project',
  );
  const runtime = useMemo(
    () =>
      configuredRuntime ??
      getVibeSpaceMcpGateway({
        accountId,
        projectId,
      }),
    [accountId, configuredRuntime, projectId],
  );
  const operationScopeRef = useRef<McpOperationScope | undefined>(undefined);
  const previousScope = operationScopeRef.current;
  if (
    !previousScope ||
    previousScope.accountId !== accountId ||
    previousScope.projectId !== projectId ||
    previousScope.runtime !== runtime
  ) {
    previousScope?.controller.abort();
    operationScopeRef.current = {
      accountId,
      projectId,
      runtime,
      generation: (previousScope?.generation ?? 0) + 1,
      controller: new AbortController(),
    };
  }
  const operationScope = operationScopeRef.current!;
  const connections = useSyncExternalStore(
    runtime.subscribe,
    runtime.getSnapshot,
    runtime.getSnapshot,
  );
  const [id, setId] = useState('');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [endpoint, setEndpoint] = useState('');
  const [reviewed, setReviewed] = useState<ReviewedConnection>();
  const [authorized, setAuthorized] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const operationIsCurrent = (candidate: McpOperationScope) =>
    operationScopeRef.current === candidate && !candidate.controller.signal.aborted;

  useEffect(() => {
    setId('');
    setName('');
    setDescription('');
    setEndpoint('');
    setReviewed(undefined);
    setAuthorized(false);
    setBusy(false);
    setError(undefined);
    return () => {
      if (operationScopeRef.current === operationScope) {
        operationScope.controller.abort();
      }
    };
  }, [operationScope]);

  const invalidateReview = () => {
    setReviewed(undefined);
    setAuthorized(false);
    setError(undefined);
  };

  const review = () => {
    try {
      const reviewedId = id.trim();
      if (!SAFE_SERVER_ID.test(reviewedId)) throw new Error('Invalid MCP server id.');
      setReviewed({
        name: name.trim() || reviewedId,
        description: description.trim(),
        id: reviewedId,
        endpoint: canonicalRemoteMcpEndpoint(endpoint),
        transport: 'streamable_http',
        authentication: 'none',
      });
      setAuthorized(false);
      setError(undefined);
    } catch {
      setReviewed(undefined);
      setAuthorized(false);
      setError('Enter a valid server identifier and safe MCP endpoint.');
    }
  };

  const connect = async () => {
    if (!reviewed || !authorized || busy) return;
    const scope = operationScope;
    setBusy(true);
    setError(undefined);
    try {
      await scope.runtime.connect({
        id: reviewed.id,
        endpoint: reviewed.endpoint,
        confirmedByUser: true,
      });
      if (!operationIsCurrent(scope)) return;
      setId('');
      setName('');
      setDescription('');
      setEndpoint('');
      setReviewed(undefined);
      setAuthorized(false);
    } catch {
      if (!operationIsCurrent(scope)) return;
      setError(SAFE_CONNECTION_ERROR);
    } finally {
      if (operationIsCurrent(scope)) setBusy(false);
    }
  };

  const runGatewayAction = async (action: () => Promise<void>) => {
    const scope = operationScope;
    setError(undefined);
    try {
      await action();
    } catch {
      if (!operationIsCurrent(scope)) return;
      setError(SAFE_CONNECTION_ERROR);
    }
  };

  const approveProfile = (connectionId: string) => {
    setError(undefined);
    try {
      runtime.approve(connectionId, { confirmedByUser: true });
    } catch {
      setError(SAFE_CONNECTION_ERROR);
    }
  };

  return (
    <section
      className="space-y-4 border-t border-border pt-4 [html[data-theme=monochrome]_&_*]:rounded-none [html[data-theme=monochrome]_&_*]:bg-none [html[data-theme=monochrome]_&_*]:shadow-none"
      aria-labelledby="mcp-connections-title"
    >
      <div>
        <h2 id="mcp-connections-title" className="text-lg font-semibold text-foreground">
          VibeSpace MCP Gateway
        </h2>
        <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
          One trusted gateway for approved capabilities. Connect through credentialless Streamable
          HTTP; every discovered tool stays off until you allow it explicitly.
        </p>
        <p className="mt-1 max-w-2xl text-xs text-muted-foreground">
          This flow does not launch local processes or accept commands, credentials, or raw secrets.
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="grid gap-1 text-sm text-foreground">
          Name
          <input
            className="rounded-md border border-border bg-background px-3 py-2 text-sm"
            value={name}
            onChange={(event) => {
              setName(event.target.value);
              invalidateReview();
            }}
            maxLength={80}
            autoComplete="off"
          />
        </label>
        <label className="grid gap-1 text-sm text-foreground">
          Description
          <input
            className="rounded-md border border-border bg-background px-3 py-2 text-sm"
            value={description}
            onChange={(event) => {
              setDescription(event.target.value);
              invalidateReview();
            }}
            maxLength={240}
            autoComplete="off"
          />
        </label>
        <label className="grid gap-1 text-sm text-foreground">
          Server identifier
          <input
            className="rounded-md border border-border bg-background px-3 py-2 text-sm"
            value={id}
            onChange={(event) => {
              setId(event.target.value);
              invalidateReview();
            }}
            autoComplete="off"
          />
        </label>
        <label className="grid gap-1 text-sm text-foreground">
          MCP endpoint
          <input
            className="rounded-md border border-border bg-background px-3 py-2 text-sm"
            value={endpoint}
            onChange={(event) => {
              setEndpoint(event.target.value);
              invalidateReview();
            }}
            placeholder="https://example.com/mcp"
            inputMode="url"
            autoComplete="off"
          />
        </label>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="grid gap-1 text-sm text-foreground">
          Transport
          <select
            className="rounded-md border border-border bg-background px-3 py-2 text-sm"
            value="streamable_http"
            disabled
          >
            <option value="streamable_http">Streamable HTTP</option>
          </select>
        </label>
        <label className="grid gap-1 text-sm text-foreground">
          Authentication
          <select
            className="rounded-md border border-border bg-background px-3 py-2 text-sm"
            value="none"
            disabled
          >
            <option value="none">None (credentialless endpoint)</option>
          </select>
        </label>
      </div>
      <Button type="button" size="sm" variant="outline" onClick={review}>
        Review MCP connection
      </Button>

      {reviewed ? (
        <div
          role="region"
          aria-label="Review MCP connection"
          className="space-y-3 rounded-lg border border-border bg-panel/60 p-3 [html[data-theme=monochrome]_&]:bg-panel"
        >
          <dl className="grid grid-cols-[7rem_1fr] gap-x-2 gap-y-1 text-xs">
            <dt className="text-muted-foreground">Name</dt>
            <dd>{reviewed.name}</dd>
            <dt className="text-muted-foreground">Description</dt>
            <dd>{reviewed.description || 'No description'}</dd>
            <dt className="text-muted-foreground">Identifier</dt>
            <dd className="font-mono">{reviewed.id}</dd>
            <dt className="text-muted-foreground">Exact endpoint</dt>
            <dd className="break-all font-mono">{reviewed.endpoint}</dd>
            <dt className="text-muted-foreground">Initial access</dt>
            <dd>No tools allowed</dd>
            <dt className="text-muted-foreground">Transport</dt>
            <dd>Streamable HTTP</dd>
            <dt className="text-muted-foreground">Authentication</dt>
            <dd>None (credentialless endpoint)</dd>
          </dl>
          <label className="flex items-start gap-2 text-sm text-foreground">
            <input
              type="checkbox"
              checked={authorized}
              onChange={(event) => setAuthorized(event.target.checked)}
            />
            <span>I authorize VibeSpace to connect to this exact endpoint.</span>
          </label>
          <Button
            type="button"
            size="sm"
            onClick={() => void connect()}
            disabled={!authorized || busy}
          >
            {busy ? 'Connecting…' : 'Connect MCP server'}
          </Button>
        </div>
      ) : null}

      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}

      <div className="space-y-3">
        {connections.map((connection) => (
          <article
            key={connection.id}
            className="space-y-3 rounded-lg border border-border bg-panel/60 p-3 [html[data-theme=monochrome]_&]:bg-panel"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <h3 className="text-sm font-medium text-foreground">{connection.id}</h3>
                <p className="break-all font-mono text-xs text-muted-foreground">
                  {connection.endpoint}
                </p>
              </div>
              <div className="text-right text-xs text-muted-foreground">
                <span className="block capitalize">{connection.state}</span>
                <span className="block capitalize">{connection.trust.replace('_', ' ')}</span>
              </div>
            </div>
            {connection.trust === 'approval_required' || connection.trust === 'changed' ? (
              <div className="space-y-2 rounded-md border border-border bg-background/60 p-2">
                <p className="text-xs text-muted-foreground">
                  Review the exact endpoint and discovered tool names. Approval stores only bounded
                  non-secret identity, schema, integrity, and exposure metadata.
                </p>
                <Button type="button" size="sm" onClick={() => approveProfile(connection.id)}>
                  Approve this exact profile
                </Button>
              </div>
            ) : null}
            {connection.state === 'connected' && connection.trust === 'approved' ? (
              <fieldset className="space-y-2">
                <legend className="text-xs font-medium text-foreground">Allowed tools</legend>
                {connection.tools.length === 0 ? (
                  <p className="text-xs text-muted-foreground">No tools discovered.</p>
                ) : (
                  connection.tools.map((tool) => (
                    <label key={tool.name} className="flex items-start gap-2 text-sm">
                      <input
                        type="checkbox"
                        aria-label={`Allow ${tool.name}`}
                        checked={tool.exposed}
                        onChange={(event) => {
                          const next = event.target.checked
                            ? [...connection.exposedTools, tool.name]
                            : connection.exposedTools.filter((name) => name !== tool.name);
                          try {
                            runtime.setToolExposure(
                              connection.id,
                              [...new Set(next)].sort((left, right) =>
                                left.localeCompare(right, 'en'),
                              ),
                              { confirmedByUser: true },
                            );
                          } catch {
                            setError(SAFE_CONNECTION_ERROR);
                          }
                        }}
                      />
                      <span>
                        <span className="font-mono text-xs text-foreground">{tool.name}</span>
                        <span className="block text-xs text-muted-foreground">
                          {tool.description}
                        </span>
                      </span>
                    </label>
                  ))
                )}
              </fieldset>
            ) : null}
            {connection.error ? (
              <p role="alert" className="text-xs text-destructive">
                {connection.error}
              </p>
            ) : null}
            <Button
              type="button"
              size="sm"
              variant="outline"
              aria-label={`Disconnect ${connection.id}`}
              onClick={() => void runGatewayAction(() => runtime.disconnect(connection.id))}
            >
              Disconnect
            </Button>
            {connection.durableApproval && connection.state !== 'connected' ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                aria-label={`Reconnect ${connection.id}`}
                onClick={() => void runGatewayAction(() => runtime.reconnect(connection.id))}
              >
                Reconnect approved profile
              </Button>
            ) : null}
            {connection.durableApproval ? (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                aria-label={`Forget approval ${connection.id}`}
                onClick={() => void runGatewayAction(() => runtime.revoke(connection.id))}
              >
                Forget approval
              </Button>
            ) : null}
            {connection.state === 'connected' && connection.exposedTools.length > 0 ? (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => {
                  try {
                    runtime.setToolExposure(connection.id, [], { confirmedByUser: true });
                  } catch {
                    setError(SAFE_CONNECTION_ERROR);
                  }
                }}
              >
                Disable all tools
              </Button>
            ) : null}
          </article>
        ))}
      </div>
    </section>
  );
}

export default McpConnections;
