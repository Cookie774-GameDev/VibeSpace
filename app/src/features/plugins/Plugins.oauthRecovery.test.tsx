import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { Plugins } from './Plugins';
import { HOSTED_MCP_PROVIDERS } from './hostedMcpProviders';
import { CLASSIFIED_PLUGIN_CATALOG } from './catalog';
import { PluginManagementCapabilityProvider } from './managementContext';
import type { PluginManagementCapability } from './runtime';
import { usePluginStore } from './store';
import { useAuthStore } from '@/stores/auth';

vi.mock('@/lib/sync', () => ({ enqueueMutation: vi.fn(async () => 'test') }));
vi.mock('@/lib/tauri', () => ({ openExternal: vi.fn(async () => undefined) }));
vi.mock('./OpenCodeMcpConnections', () => ({
  OpenCodeMcpConnections: ({
    initialProvider,
    connectRequestId,
  }: {
    initialProvider?: { url: string };
    connectRequestId?: number;
  }) => (
    <div data-testid="selected-mcp" data-request={connectRequestId}>
      {initialProvider?.url}
    </div>
  ),
}));

const management = {
  beginAuthorization: vi.fn(),
  cancelAuthorization: vi.fn(async () => undefined),
  saveCredential: vi.fn(async () => undefined),
  testConnection: vi.fn(async () => ({ ok: false, error: 'Invalid test credential' })),
  disconnect: vi.fn(),
} as unknown as PluginManagementCapability;

beforeEach(() => {
  vi.clearAllMocks();
  useAuthStore.setState({ cloudSession: null, localUserId: 'oauth-ui-test' });
  usePluginStore.setState({
    connectionsByAccount: {},
    installedPluginIdsByAccount: {
      'oauth-ui-test': CLASSIFIED_PLUGIN_CATALOG.map((item) => item.id),
    },
    pinnedPluginIdsByAccount: {},
  });
});

function open(id: string) {
  render(
    <PluginManagementCapabilityProvider value={management}>
      <Plugins />
    </PluginManagementCapabilityProvider>,
  );
  const card = screen.getByTestId(`plugin-card-${id}`);
  fireEvent.click(within(card).getByRole('button', { name: /^(connect|view requirements)$/i }));
}

describe('catalog browser sign-in and credential recovery', () => {
  it.each(HOSTED_MCP_PROVIDERS)(
    'routes the $name catalog entry to its official MCP server',
    (provider) => {
      open(provider.id);
      fireEvent.click(screen.getByRole('button', { name: /with browser sign-in$/i }));
      expect(screen.getByTestId('selected-mcp').textContent).toBe(provider.url);
      expect(screen.getByTestId('selected-mcp').getAttribute('data-request')).toBe('1');
      expect(management.beginAuthorization).not.toHaveBeenCalled();
    },
  );

  it('does not repeat authorization when manually reopening the manager', () => {
    open('supabase');
    fireEvent.click(screen.getByRole('button', { name: /with browser sign-in$/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Close MCP connections' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add MCP connection' }));
    expect(screen.getByTestId('selected-mcp').getAttribute('data-request')).toBe('0');
  });

  it('does not label the Supabase MCP route as an unavailable authorization flow', () => {
    open('supabase');
    const dialog = within(screen.getByRole('dialog'));
    expect(dialog.getAllByText(/hosted MCP.*OpenCode.*separate.*API/i).length).toBeGreaterThan(0);
    expect(
      dialog.getByRole('button', { name: /with browser sign-in/i }).hasAttribute('disabled'),
    ).toBe(false);
  });

  it('shows the Figma client-approval prerequisite before opening its MCP route', () => {
    open('figma');
    expect(screen.getByText(/Figma.*approved.*MCP client/i)).toBeTruthy();
  });

  it('offers Supabase project credentials separately and does not claim OAuth or accept a failed probe', async () => {
    open('supabase');
    const dialog = within(screen.getByRole('dialog'));
    fireEvent.click(dialog.getByRole('button', { name: 'Use a project API key instead' }));
    fireEvent.change(dialog.getByLabelText('Project URL'), {
      target: { value: 'https://example.supabase.co' },
    });
    fireEvent.change(dialog.getByLabelText('Project API key'), {
      target: { value: 'sb_publishable_test_only' },
    });
    fireEvent.click(dialog.getByRole('button', { name: 'Connect' }));
    await waitFor(() =>
      expect(management.testConnection).toHaveBeenCalledWith({
        accountId: 'oauth-ui-test',
        pluginId: 'supabase',
      }),
    );
    expect(management.saveCredential).toHaveBeenCalledWith({
      accountId: 'oauth-ui-test',
      pluginId: 'supabase',
      fieldId: 'key',
      value: 'sb_publishable_test_only',
    });
    expect((await dialog.findByRole('alert')).textContent).toContain('Invalid test credential');
    expect(management.beginAuthorization).not.toHaveBeenCalled();
  });
});
