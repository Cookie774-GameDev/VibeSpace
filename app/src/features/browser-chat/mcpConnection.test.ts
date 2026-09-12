import { afterEach, describe, expect, it, vi } from 'vitest';

import { McpConnectionPreflightError, preflightVibeSpaceMcp } from './mcpConnection';

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('VibeSpace MCP connection preflight', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('validates health and the complete OAuth discovery chain', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(
        jsonResponse({
          resource: 'https://vibespace.example/mcp',
          authorization_servers: ['https://auth.example/auth/v1'],
          scopes_supported: ['email', 'profile'],
          bearer_methods_supported: ['header'],
          resource_name: 'VibeSpace MCP',
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          issuer: 'https://auth.example/auth/v1',
          authorization_endpoint: 'https://auth.example/auth/v1/authorize',
          token_endpoint: 'https://auth.example/auth/v1/token',
          registration_endpoint: 'https://auth.example/auth/v1/register',
          scopes_supported: ['openid', 'offline_access'],
          grant_types_supported: ['authorization_code', 'refresh_token'],
          code_challenge_methods_supported: ['S256'],
        }),
      );

    await expect(
      preflightVibeSpaceMcp('https://vibespace.example/mcp', { fetcher }),
    ).resolves.toEqual({
      mcpUrl: 'https://vibespace.example/mcp',
      authorizationServer: 'https://auth.example/auth/v1',
    });
    expect(fetcher.mock.calls.map(([request]) => request.toString())).toEqual([
      'https://vibespace.example/health',
      'https://vibespace.example/.well-known/oauth-protected-resource',
      'https://auth.example/.well-known/oauth-authorization-server/auth/v1',
    ]);
  });

  it.each([
    'http://vibespace.example/mcp',
    'https://user:secret@vibespace.example/mcp',
    'https://vibespace.example/not-mcp',
    'https://vibespace.example/mcp?token=secret',
    'https://vibespace.example/mcp#fragment',
  ])('rejects an unsafe MCP resource before network access: %s', async (mcpUrl) => {
    const fetcher = vi.fn<typeof fetch>();

    await expect(preflightVibeSpaceMcp(mcpUrl, { fetcher })).rejects.toThrow(
      /valid HTTPS MCP endpoint/i,
    );
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('fails closed when protected-resource discovery names a different resource', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(
        jsonResponse({
          resource: 'https://other.example/mcp',
          authorization_servers: ['https://auth.example/auth/v1'],
        }),
      );

    await expect(
      preflightVibeSpaceMcp('https://vibespace.example/mcp', { fetcher }),
    ).rejects.toThrow(/discovery metadata is invalid/i);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('fails closed when authorization discovery names a different issuer', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(
        jsonResponse({
          resource: 'https://vibespace.example/mcp',
          authorization_servers: ['https://auth.example/auth/v1'],
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          issuer: 'https://attacker.example/auth/v1',
          authorization_endpoint: 'https://attacker.example/authorize',
          token_endpoint: 'https://attacker.example/token',
          registration_endpoint: 'https://attacker.example/register',
          scopes_supported: ['offline_access'],
          grant_types_supported: ['authorization_code', 'refresh_token'],
          code_challenge_methods_supported: ['S256'],
        }),
      );

    await expect(
      preflightVibeSpaceMcp('https://vibespace.example/mcp', { fetcher }),
    ).rejects.toThrow(/authorization metadata is invalid/i);
  });

  it('fails closed when OAuth cannot issue refreshable PKCE sessions', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(
        jsonResponse({
          resource: 'https://vibespace.example/mcp',
          authorization_servers: ['https://auth.example/auth/v1'],
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          issuer: 'https://auth.example/auth/v1',
          authorization_endpoint: 'https://auth.example/auth/v1/authorize',
          token_endpoint: 'https://auth.example/auth/v1/token',
          registration_endpoint: 'https://auth.example/auth/v1/register',
          scopes_supported: ['openid'],
          grant_types_supported: ['authorization_code'],
          code_challenge_methods_supported: ['plain'],
        }),
      );

    await expect(
      preflightVibeSpaceMcp('https://vibespace.example/mcp', { fetcher }),
    ).rejects.toThrow(/authorization metadata is invalid/i);
  });

  it('reports an unavailable health endpoint without requesting discovery', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 503 }));

    await expect(
      preflightVibeSpaceMcp('https://vibespace.example/mcp', { fetcher }),
    ).rejects.toThrow(/health check failed/i);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('times out a stalled request and never starts later discovery requests', async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn<typeof fetch>(
      (_request: RequestInfo | URL, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener(
            'abort',
            () => reject(new DOMException('Aborted', 'AbortError')),
            { once: true },
          );
        }),
    );

    const pending = preflightVibeSpaceMcp('https://vibespace.example/mcp', {
      fetcher,
      timeoutMs: 50,
    });
    const assertion = expect(pending).rejects.toThrow(/connection check timed out/i);
    await vi.advanceTimersByTimeAsync(50);

    await assertion;
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('honors caller cancellation and reports it separately from timeout', async () => {
    const controller = new AbortController();
    const fetcher = vi.fn<typeof fetch>(
      (_request: RequestInfo | URL, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener(
            'abort',
            () => reject(new DOMException('Aborted', 'AbortError')),
            { once: true },
          );
        }),
    );

    const pending = preflightVibeSpaceMcp('https://vibespace.example/mcp', {
      fetcher,
      signal: controller.signal,
    });
    controller.abort();

    await expect(pending).rejects.toEqual(
      expect.objectContaining<McpConnectionPreflightError>({
        name: 'McpConnectionPreflightError',
        message: expect.stringMatching(/connection check was cancelled/i),
      }),
    );
  });
});
