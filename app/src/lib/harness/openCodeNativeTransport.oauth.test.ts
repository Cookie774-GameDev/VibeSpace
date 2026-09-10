import { describe, expect, it, vi } from 'vitest';
import { nativeOpenCodeRequest } from './openCodeNativeTransport';
import { createOpenCodeHttpClient } from './openCodeClient';

describe('native MCP OAuth route contract', () => {
  it.each([
    ['POST', '/mcp/supabase%3Areadonly/auth/authenticate', 'mcp_authenticate'],
    ['DELETE', '/mcp/supabase%3Areadonly/auth', 'mcp_auth_remove'],
  ])('maps %s %s to one closed native route', async (method, route, kind) => {
    const invoke = vi.fn(async () => ({ status: 200, statusText: 'OK', body: 'true' }));
    await nativeOpenCodeRequest('opencode-server-test', route + '?directory=C%3A%2FWork', { method }, 330_000,
      async () => ({ invoke, channel: () => ({ onmessage: () => undefined }) }));
    expect(invoke).toHaveBeenCalledWith('opencode_server_request', {
      request: { generation: 'opencode-server-test', route: { kind, name: 'supabase:readonly' }, directory: 'C:/Work', body: undefined, timeoutMs: 330_000 },
    });
  });

  it('rejects unapproved OAuth paths and forged query parameters before IPC', async () => {
    const invoke = vi.fn();
    for (const route of ['/mcp/supabase/auth/callback', '/mcp/supabase/auth/authenticate?token=secret']) {
      await expect(nativeOpenCodeRequest('opencode-server-test', route, { method: 'POST' }, 30_000,
        async () => ({ invoke, channel: () => ({ onmessage: () => undefined }) }))).rejects.toThrow();
    }
    expect(invoke).not.toHaveBeenCalled();
  });

  it('allows browser consent longer than the normal 30-second request deadline', async () => {
    const invoke = vi.fn(async () => ({ status: 200, statusText: 'OK', body: JSON.stringify({ status: 'connected' }) }));
    vi.doMock('@tauri-apps/api/core', () => ({ invoke, Channel: class {} }));
    try {
      const client = createOpenCodeHttpClient({ source: 'managed', version: '1.2.3', generation: 'opencode-server-test' });
      await client.authenticateMcp('supabase', 'C:/Work');
      expect(invoke).toHaveBeenCalledWith('opencode_server_request', expect.objectContaining({ request: expect.objectContaining({ timeoutMs: 330_000 }) }));
    } finally { vi.doUnmock('@tauri-apps/api/core'); }
  });
});
