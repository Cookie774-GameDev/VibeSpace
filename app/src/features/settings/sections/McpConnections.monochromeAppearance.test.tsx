import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { VibeSpaceGatewayConnection, VibeSpaceMcpGateway } from '@/lib/mcp/vibeSpaceGateway';
import { McpConnections } from './McpConnections';

function runtimeHarness(initial: readonly VibeSpaceGatewayConnection[] = []) {
  let snapshot = initial;
  const listeners = new Set<() => void>();
  const runtime: VibeSpaceMcpGateway = {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    connect: vi.fn(async () => undefined),
    approve: vi.fn(),
    reconnect: vi.fn(async () => undefined),
    setToolExposure: vi.fn(),
    disconnect: vi.fn(async () => undefined),
    revoke: vi.fn(async () => undefined),
    getCapabilitySnapshot: () => ({
      schemaVersion: 1,
      accountId: 'account-1',
      projectId: 'project-1',
      connections: [],
    }),
    invoke: vi.fn(async () => {
      throw new Error('not used');
    }),
    getReceipts: () => [],
  };
  return { runtime };
}

const connected = Object.freeze({
  id: 'reviewed-server',
  endpoint: 'https://mcp.example.test/rpc',
  state: 'connected' as const,
  tools: Object.freeze([]),
  exposedTools: Object.freeze([]),
  trust: 'approved' as const,
  schemaDigest: 'a'.repeat(16),
  reconnectAttempt: 0,
  durableApproval: true,
});

describe('McpConnections MonoChrome appearance', () => {
  afterEach(cleanup);

  it('gates radius, image, shadow, and card translucency under exact monochrome', () => {
    const harness = runtimeHarness([connected]);
    const { container } = render(<McpConnections runtime={harness.runtime} />);

    const root = container.querySelector('section');
    expect(root).not.toBeNull();
    const rootClassName = root?.className ?? '';
    expect(rootClassName).toContain('[html[data-theme=monochrome]_&_*]:rounded-none');
    expect(rootClassName).toContain('[html[data-theme=monochrome]_&_*]:bg-none');
    expect(rootClassName).toContain('[html[data-theme=monochrome]_&_*]:shadow-none');

    const card = container.querySelector('article');
    expect(card).not.toBeNull();
    expect(card?.className).toContain('bg-panel/60');
    expect(card?.className).toContain('[html[data-theme=monochrome]_&]:bg-panel');

    expect(screen.getByText('VibeSpace MCP Gateway')).toBeTruthy();
    expect(screen.getByText(/credentialless Streamable HTTP/i)).toBeTruthy();
  });
});
