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
  OpenCodeMcpConnections: ({ initialProvider }: { initialProvider?: { url: string } }) => (
    <div data-testid="selected-mcp">{initialProvider?.url}</div>
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
      expect(management.beginAuthorization).not.toHaveBeenCalled();
    },
  );

  it('offers Supabase project credentials separately and does not claim OAuth or accept a failed probe', async () => {
    open('supabase');
    fireEvent.click(screen.getByRole('button', { name: 'Use a project API key instead' }));
    fireEvent.change(screen.getByLabelText('Project URL'), {
      target: { value: 'https://example.supabase.co' },
    });
    fireEvent.change(screen.getByLabelText('Project API key'), {
      target: { value: 'sb_publishable_test_only' },
    });
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Connect' }));
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
    expect((await screen.findByRole('alert')).textContent).toContain('Invalid test credential');
    expect(management.beginAuthorization).not.toHaveBeenCalled();
  });
});
