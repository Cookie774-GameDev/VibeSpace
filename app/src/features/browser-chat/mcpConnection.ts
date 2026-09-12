export const CHATGPT_APPS_URL = 'https://chatgpt.com/';
export const CHATGPT_PLUGINS_URL = 'https://chatgpt.com/plugins';

const DEFAULT_PREFLIGHT_TIMEOUT_MS = 5_000;

export interface McpConnectionPreflightResult {
  readonly mcpUrl: string;
  readonly authorizationServer: string;
}

export interface McpConnectionPreflightOptions {
  readonly fetcher?: typeof fetch;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

export class McpConnectionPreflightError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'McpConnectionPreflightError';
  }
}

function requireMcpUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new McpConnectionPreflightError('Enter a valid HTTPS MCP endpoint.');
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.pathname !== '/mcp' ||
    url.search ||
    url.hash
  ) {
    throw new McpConnectionPreflightError('Enter a valid HTTPS MCP endpoint.');
  }
  return url;
}

function requireAuthorizationServer(value: unknown): URL {
  if (typeof value !== 'string') {
    throw new McpConnectionPreflightError('The VibeSpace MCP discovery metadata is invalid.');
  }
  let issuer: URL;
  try {
    issuer = new URL(value);
  } catch {
    throw new McpConnectionPreflightError('The VibeSpace MCP authorization metadata is invalid.');
  }
  if (
    issuer.protocol !== 'https:' ||
    issuer.username ||
    issuer.password ||
    issuer.search ||
    issuer.hash
  ) {
    throw new McpConnectionPreflightError('The VibeSpace MCP authorization metadata is invalid.');
  }
  return issuer;
}

function authorizationMetadataUrl(issuer: URL): URL {
  const metadata = new URL(issuer.origin);
  metadata.pathname = `/.well-known/oauth-authorization-server${issuer.pathname.replace(/\/$/u, '')}`;
  return metadata;
}

function isSecureEndpoint(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash;
  } catch {
    return false;
  }
}

function includesString(value: unknown, expected: string): boolean {
  return Array.isArray(value) && value.includes(expected);
}

async function requestJson(
  fetcher: typeof fetch,
  url: URL,
  signal: AbortSignal,
  label: string,
): Promise<Record<string, unknown>> {
  const response = await fetcher(url, {
    method: 'GET',
    headers: { accept: 'application/json' },
    signal,
  });
  if (!response.ok) {
    throw new McpConnectionPreflightError(`${label} is unavailable.`);
  }
  const payload = (await response.json()) as unknown;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new McpConnectionPreflightError(`${label} is invalid.`);
  }
  return payload as Record<string, unknown>;
}

export async function preflightVibeSpaceMcp(
  mcpUrl: string,
  options: McpConnectionPreflightOptions = {},
): Promise<McpConnectionPreflightResult> {
  const endpoint = requireMcpUrl(mcpUrl);
  const fetcher = options.fetcher ?? fetch;
  const controller = new AbortController();
  let timedOut = false;
  const abortFromCaller = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener('abort', abortFromCaller, { once: true });
  if (options.signal?.aborted) abortFromCaller();
  const timeout = globalThis.setTimeout(
    () => {
      timedOut = true;
      controller.abort('timeout');
    },
    Math.max(1, options.timeoutMs ?? DEFAULT_PREFLIGHT_TIMEOUT_MS),
  );

  try {
    const healthResponse = await fetcher(new URL('/health', endpoint), {
      method: 'GET',
      signal: controller.signal,
    });
    if (!healthResponse.ok) {
      throw new McpConnectionPreflightError('The VibeSpace MCP health check failed.');
    }

    const resourceMetadata = await requestJson(
      fetcher,
      new URL('/.well-known/oauth-protected-resource', endpoint),
      controller.signal,
      'VibeSpace MCP discovery metadata',
    );
    const authorizationServers = resourceMetadata.authorization_servers;
    if (
      resourceMetadata.resource !== endpoint.toString() ||
      !Array.isArray(authorizationServers) ||
      authorizationServers.length === 0
    ) {
      throw new McpConnectionPreflightError('The VibeSpace MCP discovery metadata is invalid.');
    }
    const authorizationServer = requireAuthorizationServer(authorizationServers[0]);
    const authorizationMetadata = await requestJson(
      fetcher,
      authorizationMetadataUrl(authorizationServer),
      controller.signal,
      'VibeSpace MCP authorization metadata',
    );
    if (authorizationMetadata.issuer !== authorizationServer.toString()) {
      throw new McpConnectionPreflightError('The VibeSpace MCP authorization metadata is invalid.');
    }
    if (
      !isSecureEndpoint(authorizationMetadata.authorization_endpoint) ||
      !isSecureEndpoint(authorizationMetadata.token_endpoint) ||
      !isSecureEndpoint(authorizationMetadata.registration_endpoint) ||
      !includesString(authorizationMetadata.scopes_supported, 'offline_access') ||
      !includesString(authorizationMetadata.grant_types_supported, 'authorization_code') ||
      !includesString(authorizationMetadata.grant_types_supported, 'refresh_token') ||
      !includesString(authorizationMetadata.code_challenge_methods_supported, 'S256')
    ) {
      throw new McpConnectionPreflightError('The VibeSpace MCP authorization metadata is invalid.');
    }

    return {
      mcpUrl: endpoint.toString(),
      authorizationServer: authorizationServer.toString(),
    };
  } catch (cause) {
    if (cause instanceof McpConnectionPreflightError) throw cause;
    if (controller.signal.aborted) {
      throw new McpConnectionPreflightError(
        timedOut
          ? 'The VibeSpace MCP connection check timed out.'
          : 'The VibeSpace MCP connection check was cancelled.',
      );
    }
    throw new McpConnectionPreflightError('The VibeSpace MCP connection check failed.');
  } finally {
    globalThis.clearTimeout(timeout);
    options.signal?.removeEventListener('abort', abortFromCaller);
  }
}
