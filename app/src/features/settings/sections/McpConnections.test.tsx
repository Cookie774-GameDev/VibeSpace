import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { VibeSpaceGatewayConnection, VibeSpaceMcpGateway } from '@/lib/mcp/vibeSpaceGateway';
import { useAuthStore } from '@/stores/auth';
import type { ProjectId, WorkspaceId } from '@/types/common';
import { McpConnections } from './McpConnections';

function deferred() {
  let resolve!: (value?: undefined) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<undefined>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function setScope(accountId: string, projectId: string) {
  useAuthStore.setState({
    cloudSession: null,
    localUserId: accountId,
    workspaceId: 'workspace-test' as WorkspaceId,
    projectId: projectId as ProjectId,
  });
}

function runtimeHarness(initial: readonly VibeSpaceGatewayConnection[] = []) {
  let snapshot = initial;
  const listeners = new Set<() => void>();
  const connect = vi.fn(async () => undefined);
  const setToolExposure = vi.fn((id: string, toolNames: readonly string[]) => {
    snapshot = snapshot.map((connection) =>
      connection.id === id
        ? Object.freeze({
            ...connection,
            tools: Object.freeze(
              connection.tools.map((tool) =>
                Object.freeze({ ...tool, exposed: toolNames.includes(tool.name) }),
              ),
            ),
            exposedTools: Object.freeze([...toolNames]),
          })
        : connection,
    );
    listeners.forEach((listener) => listener());
  });
  const disconnect = vi.fn(async () => undefined);
  const approve = vi.fn();
  const reconnect = vi.fn(async () => undefined);
  const revoke = vi.fn(async () => undefined);
  const runtime: VibeSpaceMcpGateway = {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    connect,
    setToolExposure,
    disconnect,
    approve,
    reconnect,
    revoke,
    getCapabilitySnapshot: () => ({
      schemaVersion: 1,
      accountId: 'account',
      projectId: 'project',
      connections: [],
    }),
    invoke: vi.fn(async () => {
      throw new Error('Invocation is not used by this UI harness.');
    }),
    getReceipts: () => [],
  };
  return {
    runtime,
    connect,
    setToolExposure,
    disconnect,
    approve,
    reconnect,
    revoke,
    publish(next: readonly VibeSpaceGatewayConnection[]) {
      snapshot = next;
      listeners.forEach((listener) => listener());
    },
  };
}

const connected = Object.freeze({
  id: 'reviewed-server',
  endpoint: 'https://mcp.example.test/rpc',
  state: 'connected' as const,
  tools: Object.freeze([
    Object.freeze({
      name: 'repo.read',
      description: 'Read repository files',
      inputSchema: Object.freeze({ type: 'object', properties: {}, additionalProperties: false }),
      exposed: false,
    }),
    Object.freeze({
      name: 'repo.write',
      title: 'Write',
      description: 'Write repository files',
      inputSchema: Object.freeze({ type: 'object', properties: {}, additionalProperties: false }),
      exposed: true,
    }),
  ]),
  exposedTools: Object.freeze(['repo.write']),
  trust: 'approved' as const,
  schemaDigest: '0123456789abcdef',
  reconnectAttempt: 0,
  durableApproval: true,
});

afterEach(() => {
  act(() => setScope('local_account', 'default_project'));
});

describe('McpConnections', () => {
  it('invalidates a pending connect immediately on account and project switch', async () => {
    setScope('account-a', 'project-a');
    const pending = deferred();
    const harness = runtimeHarness();
    harness.connect.mockImplementationOnce(() => pending.promise);
    render(<McpConnections runtime={harness.runtime} />);

    fireEvent.change(screen.getByLabelText('Server identifier'), {
      target: { value: 'account-a-server' },
    });
    fireEvent.change(screen.getByLabelText('MCP endpoint'), {
      target: { value: 'https://mcp.example.test/account-a' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Review MCP connection' }));
    fireEvent.click(screen.getByRole('checkbox', { name: /authorize VibeSpace/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Connect MCP server' }));
    await waitFor(() => expect(harness.connect).toHaveBeenCalledOnce());

    act(() => setScope('account-b', 'project-b'));
    await waitFor(() =>
      expect(screen.queryByRole('region', { name: 'Review MCP connection' })).toBeNull(),
    );
    expect(screen.queryByText('Connecting…')).toBeNull();

    await act(async () => pending.reject(new Error('former-account-secret-detail')));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByText(/former-account/i)).toBeNull();
  });

  it('rejects late completion after runtime generation drift or disposal', async () => {
    const oldPending = deferred();
    const oldHarness = runtimeHarness();
    oldHarness.connect.mockImplementationOnce(() => oldPending.promise);
    const nextHarness = runtimeHarness();
    const view = render(<McpConnections runtime={oldHarness.runtime} />);

    fireEvent.change(screen.getByLabelText('Server identifier'), {
      target: { value: 'generation-server' },
    });
    fireEvent.change(screen.getByLabelText('MCP endpoint'), {
      target: { value: 'https://mcp.example.test/generation' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Review MCP connection' }));
    fireEvent.click(screen.getByRole('checkbox', { name: /authorize VibeSpace/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Connect MCP server' }));
    await waitFor(() => expect(oldHarness.connect).toHaveBeenCalledOnce());

    view.rerender(<McpConnections runtime={nextHarness.runtime} />);
    await waitFor(() =>
      expect(screen.queryByRole('region', { name: 'Review MCP connection' })).toBeNull(),
    );
    await act(async () => oldPending.resolve());
    expect((screen.getByLabelText('Server identifier') as HTMLInputElement).value).toBe('');

    const disposedPending = deferred();
    nextHarness.disconnect.mockImplementationOnce(() => disposedPending.promise);
    act(() => nextHarness.publish([connected]));
    fireEvent.click(await screen.findByRole('button', { name: 'Disconnect reviewed-server' }));
    await waitFor(() => expect(nextHarness.disconnect).toHaveBeenCalledOnce());
    view.unmount();
    await act(async () => disposedPending.reject(new Error('disposed-secret-detail')));
  });
  it('requires review and a separate exact-endpoint authorization before connecting', async () => {
    const harness = runtimeHarness();
    render(<McpConnections runtime={harness.runtime} />);

    fireEvent.change(screen.getByLabelText('Server identifier'), {
      target: { value: 'reviewed-server' },
    });
    fireEvent.change(screen.getByLabelText('MCP endpoint'), {
      target: { value: 'https://mcp.example.test/rpc' },
    });
    expect(screen.queryByRole('checkbox', { name: /authorize VibeSpace/i })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Review MCP connection' }));
    expect(screen.getByRole('region', { name: 'Review MCP connection' }).textContent).toContain(
      'https://mcp.example.test/rpc',
    );
    const connectButton = screen.getByRole('button', { name: 'Connect MCP server' });
    expect((connectButton as HTMLButtonElement).disabled).toBe(true);
    expect(harness.connect).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('checkbox', { name: /authorize VibeSpace/i }));
    fireEvent.click(connectButton);

    await waitFor(() =>
      expect(harness.connect).toHaveBeenCalledWith({
        id: 'reviewed-server',
        endpoint: 'https://mcp.example.test/rpc',
        confirmedByUser: true,
      }),
    );
  });

  it('is credentialless and never offers a local command or process field', () => {
    const harness = runtimeHarness();
    render(<McpConnections runtime={harness.runtime} />);

    expect(screen.getByText(/credentialless Streamable HTTP/i)).toBeTruthy();
    expect(screen.getByText(/does not launch local processes/i)).toBeTruthy();
    expect(screen.queryByLabelText(/api.?key|token|password|credential/i)).toBeNull();
    expect(screen.queryByLabelText(/command|process|executable/i)).toBeNull();
  });

  it('keeps discovered tools off by default and changes only the explicit allowlist', async () => {
    const harness = runtimeHarness([connected]);
    render(<McpConnections runtime={harness.runtime} />);

    const read = screen.getByRole('checkbox', { name: 'Allow repo.read' });
    const write = screen.getByRole('checkbox', { name: 'Allow repo.write' });
    expect((read as HTMLInputElement).checked).toBe(false);
    expect((write as HTMLInputElement).checked).toBe(true);

    fireEvent.click(read);
    expect(harness.setToolExposure).toHaveBeenLastCalledWith(
      'reviewed-server',
      ['repo.read', 'repo.write'],
      { confirmedByUser: true },
    );
    fireEvent.click(write);
    expect(harness.setToolExposure).toHaveBeenLastCalledWith('reviewed-server', ['repo.read'], {
      confirmedByUser: true,
    });

    fireEvent.click(screen.getByRole('button', { name: 'Disconnect reviewed-server' }));
    await waitFor(() => expect(harness.disconnect).toHaveBeenCalledWith('reviewed-server'));
  });

  it('shows trust health and requires explicit profile approval before tools appear', () => {
    const harness = runtimeHarness([
      Object.freeze({
        ...connected,
        trust: 'approval_required',
        durableApproval: false,
        exposedTools: Object.freeze([]),
      }),
    ]);
    render(<McpConnections runtime={harness.runtime} />);

    expect(screen.getByText('approval required')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Approve this exact profile' }));
    expect(harness.approve).toHaveBeenCalledWith('reviewed-server', {
      confirmedByUser: true,
    });
    expect(screen.queryByRole('checkbox', { name: 'Allow repo.read' })).toBeNull();
  });

  it('offers lazy reconnect and durable revocation for an approved offline profile', async () => {
    const harness = runtimeHarness([
      Object.freeze({ ...connected, state: 'disconnected' as const }),
    ]);
    render(<McpConnections runtime={harness.runtime} />);

    fireEvent.click(screen.getByRole('button', { name: 'Reconnect reviewed-server' }));
    await waitFor(() => expect(harness.reconnect).toHaveBeenCalledWith('reviewed-server'));
    fireEvent.click(screen.getByRole('button', { name: 'Forget approval reviewed-server' }));
    await waitFor(() => expect(harness.revoke).toHaveBeenCalledWith('reviewed-server'));
  });

  it('never exposes a provider failure string', async () => {
    const harness = runtimeHarness();
    harness.connect.mockRejectedValueOnce(new Error('Bearer live-secret-provider-detail'));
    render(<McpConnections runtime={harness.runtime} />);

    fireEvent.change(screen.getByLabelText('Server identifier'), {
      target: { value: 'reviewed-server' },
    });
    fireEvent.change(screen.getByLabelText('MCP endpoint'), {
      target: { value: 'https://mcp.example.test/rpc' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Review MCP connection' }));
    fireEvent.click(screen.getByRole('checkbox', { name: /authorize VibeSpace/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Connect MCP server' }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Unable to connect to this MCP server.');
    expect(alert.textContent).not.toContain('live-secret');
  });
});
