import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { OpenCodeHttpClient, OpenCodeMcpStatus } from '@/lib/harness/openCodeClient';
import type { HarnessRuntimeManager, OpenCodeServerConnection } from '@/lib/harness/runtimeManager';
import { OpenCodeMcpConnections } from './OpenCodeMcpConnections';

const connection = Object.freeze({
  version: '1.2.3',
  source: 'managed' as const,
  generation: 'opencode-server-test',
});

function runtimeHarness(): HarnessRuntimeManager {
  const snapshot = Object.freeze({
    kind: 'ready' as const,
    source: 'managed' as const,
    version: '1.2.3',
  });
  return {
    subscribe: () => () => undefined,
    getSnapshot: () => snapshot,
    getConnection: () => connection,
    refresh: vi.fn(async () => undefined),
    download: vi.fn(async () => undefined),
    repair: vi.fn(async () => undefined),
    cancel: vi.fn(async () => undefined),
  };
}

function clientHarness() {
  let statuses: Record<string, OpenCodeMcpStatus> = {
    github: { status: 'connected' as const },
    docs: { status: 'failed' as const, error: 'Safe connection failure.' },
  };
  const client = {
    mcpStatus: vi.fn(async () => statuses),
    addMcp: vi.fn(async () => {
      statuses = { ...statuses, research: { status: 'disabled' as const } };
      return statuses;
    }),
    connectMcp: vi.fn(async () => true),
    disconnectMcp: vi.fn(async () => true),
  } as unknown as OpenCodeHttpClient;
  return client;
}

describe('OpenCodeMcpConnections', () => {
  it('loads authoritative status for the exact active project and controls lifecycle', async () => {
    const client = clientHarness();
    render(
      <OpenCodeMcpConnections
        runtime={runtimeHarness()}
        clientFactory={() => client}
        directory={'C:\\Work\\VibeSpace'}
      />,
    );

    expect(screen.getByRole('heading', { name: 'OpenCode MCP servers' })).toBeTruthy();
    expect(await screen.findByText('github')).toBeTruthy();
    expect(client.mcpStatus).toHaveBeenCalledWith('C:\\Work\\VibeSpace');

    const github = screen.getByRole('article', { name: 'github MCP server' });
    expect(within(github).getByText('Connected')).toBeTruthy();
    fireEvent.click(within(github).getByRole('button', { name: 'Disconnect github' }));
    await waitFor(() =>
      expect(client.disconnectMcp).toHaveBeenCalledWith('github', 'C:\\Work\\VibeSpace'),
    );

    const docs = screen.getByRole('article', { name: 'docs MCP server' });
    expect(within(docs).getByText('Safe connection failure.')).toBeTruthy();
    fireEvent.click(within(docs).getByRole('button', { name: 'Connect docs' }));
    await waitFor(() =>
      expect(client.connectMcp).toHaveBeenCalledWith('docs', 'C:\\Work\\VibeSpace'),
    );
  });

  it('adds a remote server through OpenCode without collecting credentials', async () => {
    const client = clientHarness();
    render(
      <OpenCodeMcpConnections
        runtime={runtimeHarness()}
        clientFactory={() => client}
        directory={'C:\\Work\\VibeSpace'}
      />,
    );
    await screen.findByText('github');

    fireEvent.change(screen.getByLabelText('Server name'), { target: { value: 'research' } });
    fireEvent.change(screen.getByLabelText('Remote URL'), {
      target: { value: 'https://mcp.example.test/rpc' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add OpenCode MCP server' }));

    await waitFor(() =>
      expect(client.addMcp).toHaveBeenCalledWith(
        'research',
        { type: 'remote', url: 'https://mcp.example.test/rpc', enabled: true },
        'C:\\Work\\VibeSpace',
      ),
    );
    expect(screen.queryByLabelText(/token|password|credential|api key/i)).toBeNull();
    expect(await screen.findByText('research')).toBeTruthy();
  });

  it('shows a bounded generic error instead of leaking transport details', async () => {
    const client = clientHarness();
    vi.mocked(client.mcpStatus).mockRejectedValueOnce(
      new Error('Bearer live-secret-private-transport-detail'),
    );
    render(
      <OpenCodeMcpConnections
        runtime={runtimeHarness()}
        clientFactory={() => client}
        directory={'C:\\Work\\VibeSpace'}
      />,
    );

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe('OpenCode MCP status is unavailable.');
    expect(alert.textContent).not.toContain('live-secret');
  });

  it('clears the prior project server projection when runtime authority disappears', async () => {
    const client = clientHarness();
    const readyRuntime = runtimeHarness();
    const failedSnapshot = Object.freeze({
      kind: 'failed' as const,
      recoverable: true,
      message: 'OpenCode stopped.',
    });
    const unavailableRuntime: HarnessRuntimeManager = {
      ...runtimeHarness(),
      getSnapshot: () => failedSnapshot,
      getConnection: () => undefined,
    };
    const view = render(
      <OpenCodeMcpConnections
        runtime={readyRuntime}
        clientFactory={() => client}
        directory={'C:\\Work\\VibeSpace'}
      />,
    );
    expect(await screen.findByText('github')).toBeTruthy();
    expect(screen.getByRole('article', { name: 'docs MCP server' })).toBeTruthy();

    view.rerender(
      <OpenCodeMcpConnections
        runtime={unavailableRuntime}
        clientFactory={() => client}
        directory={'C:\\Work\\Other'}
      />,
    );

    expect(screen.getByText('OpenCode is unavailable in this app session.')).toBeTruthy();
    expect(screen.queryByRole('article')).toBeNull();
    expect(screen.queryByText('Safe connection failure.')).toBeNull();
  });

  it('never projects a late prior-generation status into the replacement project', async () => {
    let resolveLateA!: (value: Readonly<Record<string, OpenCodeMcpStatus>>) => void;
    let resolveB!: (value: Readonly<Record<string, OpenCodeMcpStatus>>) => void;
    const lateA = new Promise<Readonly<Record<string, OpenCodeMcpStatus>>>((resolve) => {
      resolveLateA = resolve;
    });
    const pendingB = new Promise<Readonly<Record<string, OpenCodeMcpStatus>>>((resolve) => {
      resolveB = resolve;
    });
    const clientA = clientHarness();
    vi.mocked(clientA.mcpStatus)
      .mockResolvedValueOnce({ alpha: { status: 'connected' } })
      .mockReturnValueOnce(lateA);
    const clientB = clientHarness();
    vi.mocked(clientB.mcpStatus).mockReturnValue(pendingB);
    const connectionB = Object.freeze({ ...connection, generation: 'opencode-server-replacement' });
    const runtimeA = runtimeHarness();
    const runtimeB: HarnessRuntimeManager = {
      ...runtimeHarness(),
      getConnection: () => connectionB,
    };
    const clientFactory = (active: OpenCodeServerConnection) =>
      active.generation === connection.generation ? clientA : clientB;
    const view = render(
      <OpenCodeMcpConnections
        runtime={runtimeA}
        clientFactory={clientFactory}
        directory={'C:\\Work\\A'}
      />,
    );
    expect(await screen.findByText('alpha')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh OpenCode MCP status' }));
    await waitFor(() => expect(clientA.mcpStatus).toHaveBeenCalledTimes(2));

    view.rerender(
      <OpenCodeMcpConnections
        runtime={runtimeB}
        clientFactory={clientFactory}
        directory={'C:\\Work\\B'}
      />,
    );
    expect(screen.queryByText('alpha')).toBeNull();
    expect(
      (
        screen.getByRole('button', {
          name: 'Refresh OpenCode MCP status',
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);

    await act(async () => resolveLateA({ stale: { status: 'failed', error: 'stale A' } }));
    expect(screen.queryByText('stale')).toBeNull();
    await act(async () => resolveB({ beta: { status: 'disabled' } }));
    expect(await screen.findByText('beta')).toBeTruthy();
    expect(screen.queryByText('alpha')).toBeNull();
  });
});


describe('MCP browser authorization', () => {
  it('opens provider authorization when Connect encounters needs_auth, then requires status readback', async () => {
    const client = clientHarness();
    const authenticateMcp = vi.fn(async () => ({ status: 'connected' as const }));
    Object.assign(client, { authenticateMcp, removeMcpAuth: vi.fn(async () => true) });
    vi.mocked(client.mcpStatus)
      .mockResolvedValueOnce({ supabase: { status: 'needs_auth' } })
      .mockResolvedValue({ supabase: { status: 'connected' } });
    render(<OpenCodeMcpConnections runtime={runtimeHarness()} clientFactory={() => client} directory="C:/Work/One" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Connect supabase' }));
    await waitFor(() => expect(authenticateMcp).toHaveBeenCalledWith('supabase', 'C:/Work/One'));
    expect(client.connectMcp).not.toHaveBeenCalled();
    await waitFor(() => expect(within(screen.getByRole('article', { name: 'supabase MCP server' })).getByText('Connected')).toBeTruthy());
  });

  it('starts OAuth after adding a remote server that requires authorization', async () => {
    const client = clientHarness();
    const authenticateMcp = vi.fn(async () => ({ status: 'connected' as const }));
    Object.assign(client, { authenticateMcp, removeMcpAuth: vi.fn(async () => true) });
    vi.mocked(client.mcpStatus).mockResolvedValueOnce({}).mockResolvedValue({ supabase: { status: 'connected' } });
    vi.mocked(client.addMcp).mockResolvedValue({ supabase: { status: 'needs_auth' } });
    render(<OpenCodeMcpConnections runtime={runtimeHarness()} clientFactory={() => client} directory="C:/Work/One" />);
    await screen.findByText('No OpenCode MCP servers are configured for this project.');
    fireEvent.change(screen.getByLabelText('Server name'), { target: { value: 'supabase' } });
    fireEvent.change(screen.getByLabelText('Remote URL'), { target: { value: 'https://mcp.supabase.com/mcp?read_only=true' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add OpenCode MCP server' }));
    await waitFor(() => expect(authenticateMcp).toHaveBeenCalledWith('supabase', 'C:/Work/One'));
    expect(await screen.findByText('Connected')).toBeTruthy();
  });

  it('cancels pending authorization and ignores its late success', async () => {
    const client = clientHarness();
    let finish!: (status: OpenCodeMcpStatus) => void;
    const authenticateMcp = vi.fn(() => new Promise<OpenCodeMcpStatus>(resolve => { finish = resolve; }));
    const removeMcpAuth = vi.fn(async () => true);
    Object.assign(client, { authenticateMcp, removeMcpAuth });
    vi.mocked(client.mcpStatus).mockResolvedValue({ supabase: { status: 'needs_auth' } });
    render(<OpenCodeMcpConnections runtime={runtimeHarness()} clientFactory={() => client} directory="C:/Work/One" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Connect supabase' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel authorization' }));
    await waitFor(() => expect(removeMcpAuth).toHaveBeenCalledWith('supabase', 'C:/Work/One'));
    await act(async () => finish({ status: 'connected' }));
    expect(screen.queryByText('Connected')).toBeNull();
    expect(screen.getByText('Authorization needed')).toBeTruthy();
  });

  it('never reports a failed or incomplete authorization as connected', async () => {
    const client = clientHarness();
    const authenticateMcp = vi.fn(async () => ({ status: 'failed' as const, error: 'Bearer hidden-secret' }));
    Object.assign(client, { authenticateMcp, removeMcpAuth: vi.fn(async () => true) });
    vi.mocked(client.mcpStatus).mockResolvedValue({ supabase: { status: 'needs_auth' } });
    render(<OpenCodeMcpConnections runtime={runtimeHarness()} clientFactory={() => client} directory="C:/Work/One" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Connect supabase' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).not.toContain('hidden-secret');
    expect(screen.queryByText('Connected')).toBeNull();
  });

  it('does not start authorization after an add completes in an unmounted project', async () => {
    const client = clientHarness();
    let finish!: (status: Readonly<Record<string, OpenCodeMcpStatus>>) => void;
    vi.mocked(client.mcpStatus).mockResolvedValue({});
    vi.mocked(client.addMcp).mockReturnValue(new Promise(resolve => { finish = resolve; }));
    const authenticateMcp = vi.fn();
    Object.assign(client, { authenticateMcp, removeMcpAuth: vi.fn(async () => true) });
    const view = render(<OpenCodeMcpConnections runtime={runtimeHarness()} clientFactory={() => client} directory="C:/Work/One" />);
    await screen.findByText('No OpenCode MCP servers are configured for this project.');
    fireEvent.change(screen.getByLabelText('Server name'), { target: { value: 'supabase' } });
    fireEvent.change(screen.getByLabelText('Remote URL'), { target: { value: 'https://mcp.supabase.com/mcp' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add OpenCode MCP server' }));
    view.unmount();
    await act(async () => finish({ supabase: { status: 'needs_auth' } }));
    expect(authenticateMcp).not.toHaveBeenCalled();
  });
});
