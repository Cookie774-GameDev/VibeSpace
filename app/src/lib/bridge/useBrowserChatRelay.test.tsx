import { describe, expect, it, vi } from 'vitest';

import {
  requestBrowserChatRelayTicket,
  resolveBrowserChatCloudUrl,
  resolveBrowserChatMcpUrl,
  resolveBrowserChatRelayUrl,
} from './useBrowserChatRelay';

describe('Browser Chat relay lifecycle', () => {
  it('uses a dedicated encrypted endpoint rather than the Phone/Voice bridge', () => {
    expect(resolveBrowserChatRelayUrl('https://cloud.vibespace.test/')).toBe(
      'wss://cloud.vibespace.test/browser-chat/bridge',
    );
    expect(resolveBrowserChatRelayUrl('http://127.0.0.1:8787')).toBe(
      'ws://127.0.0.1:8787/browser-chat/bridge',
    );
  });

  it('fails closed for absent and unsupported cloud URLs', () => {
    expect(resolveBrowserChatRelayUrl(undefined)).toBeNull();
    expect(resolveBrowserChatRelayUrl('ftp://cloud.vibespace.test')).toBeNull();
  });

  it('derives the public VibeSpace MCP endpoint without leaking the relay route', () => {
    expect(resolveBrowserChatMcpUrl('https://cloud.vibespace.test/')).toBe(
      'https://cloud.vibespace.test/mcp',
    );
    expect(resolveBrowserChatMcpUrl('http://127.0.0.1:8787')).toBeNull();
    expect(resolveBrowserChatMcpUrl('javascript:alert(1)')).toBeNull();
  });

  it('prefers the dedicated free VibeSpace MCP gateway over the legacy Phone bridge', () => {
    expect(
      resolveBrowserChatCloudUrl({
        VITE_VIBESPACE_MCP_URL: 'https://mcp.vibespace.test',
        VITE_PHONE_JARVIS_CLOUD_URL: 'https://phone.vibespace.test',
      }),
    ).toBe('https://mcp.vibespace.test');
    expect(resolveBrowserChatCloudUrl({})).toBe('https://vibespace-mcp.combatonline02.workers.dev');
  });

  it('exchanges the signed-in VibeSpace token for a same-origin one-time relay URL', async () => {
    const fetcher = vi.fn(async () =>
      Response.json({
        url: 'wss://mcp.vibespace.test/browser-chat/bridge?ticket=opaque',
      }),
    );
    await expect(
      requestBrowserChatRelayTicket('https://mcp.vibespace.test', 'desktop-jwt', fetcher),
    ).resolves.toBe('wss://mcp.vibespace.test/browser-chat/bridge?ticket=opaque');
    expect(fetcher).toHaveBeenCalledWith(
      new URL('https://mcp.vibespace.test/relay/ticket'),
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ authorization: 'Bearer desktop-jwt' }),
      }),
    );
  });

  it('rejects cross-origin or unencrypted relay tickets', async () => {
    const crossOrigin = vi.fn(async () =>
      Response.json({ url: 'wss://attacker.test/browser-chat/bridge?ticket=opaque' }),
    );
    await expect(
      requestBrowserChatRelayTicket('https://mcp.vibespace.test', 'desktop-jwt', crossOrigin),
    ).rejects.toThrow(/invalid ticket/i);
  });
});
