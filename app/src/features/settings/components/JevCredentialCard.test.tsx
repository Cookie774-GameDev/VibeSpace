import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { JevCredentialCard } from './JevCredentialCard';

const mocks = vi.hoisted(() => ({
  status: vi.fn(),
  load: vi.fn(),
  save: vi.fn(),
  test: vi.fn(),
  remove: vi.fn(),
  setModel: vi.fn(),
  usage: vi.fn(),
  toast: {
    success: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
  },
}));

vi.mock('@/lib/security/jevCredentialStore', () => ({
  getJevCredentialStatus: mocks.status,
}));

vi.mock('@/lib/jev', () => ({
  loadJevSettings: mocks.load,
  saveJevApiKey: mocks.save,
  testJevConnection: mocks.test,
  removeJevApiKey: mocks.remove,
  setJevModel: mocks.setModel,
  getJevLocalUsage: mocks.usage,
}));

vi.mock('@/stores/auth', () => ({
  useAuthStore: (
    selector: (state: {
      cloudSession: { user_id: string; email: string; expires_at: number } | null;
      localUserId: string | null;
      workspaceId: string | null;
    }) => unknown,
  ) =>
    selector({
      cloudSession: { user_id: 'account', email: 'account@example.test', expires_at: 0 },
      localUserId: null,
      workspaceId: 'workspace',
    }),
}));

vi.mock('@/components/ui/toast', () => ({ toast: mocks.toast }));

describe('JevCredentialCard', () => {
  it('reuses the shared saved credential when another panel is opened', async () => {
    mocks.status.mockResolvedValue({ available: true, configured: true });
    mocks.load.mockResolvedValue({ modelId: 'jev-latest', hasKey: true, connected: true });
    const first = render(<JevCredentialCard />);
    await screen.findByText('Connected');
    expect(screen.queryByLabelText('Jev API key')).toBeNull();
    first.unmount();
    render(<JevCredentialCard />);
    await screen.findByText('Connected');
    expect(screen.queryByLabelText('Jev API key')).toBeNull();
    expect(mocks.save).not.toHaveBeenCalled();
  });
  beforeEach(() => {
    mocks.status.mockReset().mockResolvedValue({ available: true, configured: false });
    mocks.load.mockReset().mockResolvedValue({
      modelId: 'jev-latest',
      hasKey: false,
      connected: false,
    });
    mocks.save.mockReset().mockResolvedValue(undefined);
    mocks.test.mockReset().mockResolvedValue({ kind: 'connected', status: 200, models: [] });
    mocks.remove.mockReset().mockResolvedValue(undefined);
    mocks.setModel.mockReset().mockResolvedValue(undefined);
    mocks.usage.mockReset().mockResolvedValue([]);
    Object.values(mocks.toast).forEach((method) => method.mockReset());
  });

  it('uses the real secure settings adapter and never renders the saved key', async () => {
    render(<JevCredentialCard />);

    const input = await screen.findByLabelText('Jev API key');
    fireEvent.change(input, { target: { value: 'jev-private-key' } });
    fireEvent.click(screen.getByRole('button', { name: 'Connect Jev' }));

    await waitFor(() => expect(mocks.save).toHaveBeenCalledWith('jev-private-key'));
    expect(screen.queryByDisplayValue('jev-private-key')).toBeNull();
    expect(document.body.textContent).not.toContain('jev-private-key');
  });

  it('tests the fixed native catalog, persists the selected model, and removes the vault key', async () => {
    mocks.status.mockResolvedValue({ available: true, configured: true });
    mocks.load.mockResolvedValue({ modelId: 'jev-1', hasKey: true, connected: false });
    mocks.test.mockResolvedValue({
      kind: 'connected',
      status: 200,
      models: [
        { id: 'jev-1', label: 'Jev 1' },
        { id: 'jev-2', label: 'Jev 2' },
      ],
    });
    mocks.usage.mockResolvedValue([
      {
        recordedAt: 1_700_000_000_000,
        accountId: 'account',
        workspaceId: 'workspace',
        model: 'jev-1',
        inputTokens: 12,
        outputTokens: 4,
        costUsd: null,
        costProvenance: 'unavailable',
        status: 'ok',
      },
    ]);

    render(<JevCredentialCard />);

    expect(await screen.findByText('Saved · untested')).toBeTruthy();
    expect(await screen.findByText(/12 input tokens/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Test Jev connection' }));

    await waitFor(() =>
      expect(mocks.test).toHaveBeenCalledWith({ accountId: 'account', workspaceId: 'workspace' }),
    );
    expect(await screen.findByText('Connected')).toBeTruthy();
    const select = await screen.findByLabelText('Jev decision model');
    fireEvent.change(select, { target: { value: 'jev-2' } });
    await waitFor(() =>
      expect(mocks.setModel).toHaveBeenCalledWith('jev-2', {
        accountId: 'account',
        workspaceId: 'workspace',
      }),
    );

    fireEvent.click(screen.getByRole('button', { name: 'Remove Jev key' }));
    await waitFor(() => expect(mocks.remove).toHaveBeenCalledTimes(1));
    expect(await screen.findByText('Not connected')).toBeTruthy();
    expect(screen.getByText(/provider balance is not available/i)).toBeTruthy();
  });

  it('reports browser use as unavailable instead of offering a fallback key store', async () => {
    mocks.status.mockResolvedValue({ available: false, configured: false });
    render(<JevCredentialCard />);

    expect(await screen.findByText('Desktop app required')).toBeTruthy();
    expect(screen.getByText(/no browser key fallback/i)).toBeTruthy();
  });
});
