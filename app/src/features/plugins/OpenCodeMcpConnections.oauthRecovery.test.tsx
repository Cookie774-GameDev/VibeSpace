import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { OpenCodeHttpClient, OpenCodeMcpStatus } from '@/lib/harness/openCodeClient';
import type { HarnessRuntimeManager } from '@/lib/harness/runtimeManager';
import { OpenCodeMcpConnections } from './OpenCodeMcpConnections';
import { HOSTED_MCP_PROVIDERS } from './hostedMcpProviders';

function setup(initial: OpenCodeMcpStatus) {
  const connection = {
    generation: 'oauth-recovery-test',
    source: 'managed',
    version: '1.2.3',
  } as const;
  const snapshot = { kind: 'ready', source: 'managed', version: '1.2.3' } as const;
  const runtime = {
    subscribe: () => () => undefined,
    getSnapshot: () => snapshot,
    getConnection: () => connection,
    refresh: vi.fn(),
  } as unknown as HarnessRuntimeManager;
  const client = {
    addMcp: vi.fn(async () => ({}) as Record<string, OpenCodeMcpStatus>),
    mcpStatus: vi.fn(async (): Promise<Record<string, OpenCodeMcpStatus>> => ({ docs: initial })),
    connectMcp: vi.fn(async () => true),
    authenticateMcp: vi.fn(async (): Promise<OpenCodeMcpStatus> => ({ status: 'connected' })),
    removeMcpAuth: vi.fn(async () => true),
  };
  const mount = (
    initialProvider?: (typeof HOSTED_MCP_PROVIDERS)[number],
    connectRequestId?: number,
  ) =>
    render(
      <OpenCodeMcpConnections
        runtime={runtime}
        clientFactory={() => client as unknown as OpenCodeHttpClient}
        directory="C:/OAuth/Test"
        initialProvider={initialProvider}
        connectRequestId={connectRequestId}
      />,
    );
  return { client, mount };
}

describe('MCP OAuth recovery', () => {
  it.each(HOSTED_MCP_PROVIDERS)(
    'starts $name authorization from the catalog request without another form submission',
    async (provider) => {
      const { client, mount } = setup({ status: 'disabled' });
      client.addMcp.mockResolvedValue({ [provider.id]: { status: 'needs_auth' } });
      client.mcpStatus
        .mockResolvedValueOnce({ docs: { status: 'disabled' } })
        .mockResolvedValue({ [provider.id]: { status: 'connected' } });
      mount(provider, 1);
      await waitFor(() =>
        expect(client.authenticateMcp).toHaveBeenCalledWith(provider.id, 'C:/OAuth/Test'),
      );
      await screen.findByText('Connected');
      expect(client.addMcp).toHaveBeenCalledTimes(1);
      expect(client.authenticateMcp).toHaveBeenCalledTimes(1);
    },
  );

  it.each(HOSTED_MCP_PROVIDERS)(
    'starts the real OAuth client operation for the $name preset',
    async (provider) => {
      const { client, mount } = setup({ status: 'disabled' });
      client.addMcp.mockResolvedValue({ [provider.id]: { status: 'needs_auth' } });
      client.mcpStatus
        .mockResolvedValueOnce({ docs: { status: 'disabled' } })
        .mockResolvedValue({ [provider.id]: { status: 'connected' } });
      mount();
      await screen.findByRole('button', { name: 'Connect docs' });
      fireEvent.change(screen.getByLabelText('Official provider'), {
        target: { value: provider.id },
      });
      expect((screen.getByLabelText('Remote URL') as HTMLInputElement).value).toBe(provider.url);
      fireEvent.click(screen.getByRole('button', { name: 'Add OpenCode MCP server' }));
      await waitFor(() =>
        expect(client.authenticateMcp).toHaveBeenCalledWith(provider.id, 'C:/OAuth/Test'),
      );
      expect(client.addMcp).toHaveBeenCalledWith(
        provider.id,
        { type: 'remote', url: provider.url, enabled: true },
        'C:/OAuth/Test',
      );
      await screen.findByText('Connected');
    },
  );

  it('authenticates when a disconnected server discovers OAuth during Connect', async () => {
    const { client, mount } = setup({ status: 'disabled' });
    client.mcpStatus
      .mockResolvedValueOnce({ docs: { status: 'disabled' } })
      .mockResolvedValueOnce({ docs: { status: 'needs_auth' } })
      .mockResolvedValue({ docs: { status: 'connected' } });
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Connect docs' }));
    await screen.findByText('Connected');
    expect(client.connectMcp).toHaveBeenCalledWith('docs', 'C:/OAuth/Test');
    expect(client.authenticateMcp).toHaveBeenCalledWith('docs', 'C:/OAuth/Test');
  });

  it('does not trust an OAuth success receipt when authoritative readback is still unauthenticated', async () => {
    const { client, mount } = setup({
      status: 'needs_client_registration',
      error: 'Client registration required',
    });
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Connect docs' }));
    await screen.findByRole('alert');
    expect(client.authenticateMcp).toHaveBeenCalledWith('docs', 'C:/OAuth/Test');
    expect(client.connectMcp).not.toHaveBeenCalled();
    expect(screen.queryByText('Connected')).toBeNull();
  });

  it('removes pending authorization on unmount and ignores a late result', async () => {
    const { client, mount } = setup({ status: 'needs_auth' });
    let finish!: (status: OpenCodeMcpStatus) => void;
    client.authenticateMcp.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const view = mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Connect docs' }));
    await screen.findByRole('button', { name: 'Cancel authorization' });
    view.unmount();
    await waitFor(() => expect(client.removeMcpAuth).toHaveBeenCalledWith('docs', 'C:/OAuth/Test'));
    await act(async () => finish({ status: 'connected' }));
    expect(client.mcpStatus).toHaveBeenCalledTimes(1);
  });
});
