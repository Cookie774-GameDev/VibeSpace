import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuthStore } from '@/stores/auth';
import type { Agent, AgentId } from '@/types';
import { recycleBinStore, resetRecycleBinStoreForTests } from './recycleBinStore';
import { RecycleBinSettings } from './RecycleBinSettings';

const serviceMocks = vi.hoisted(() => ({
  restore: vi.fn(),
  permanentlyDelete: vi.fn(),
  empty: vi.fn(),
}));

vi.mock('./recycleBinService', () => ({
  recycleBinService: serviceMocks,
}));

const archivedAgent: Agent = {
  id: 'agt-settings-bin' as AgentId,
  slug: 'settings-bin',
  name: 'Settings Bin Agent',
  description: 'Recoverable',
  system_prompt: 'Recover safely.',
  model: { provider: 'openai', model: 'gpt-5' },
  tools_allowed: [],
  memory_scope: 'agent',
  capabilities: [],
  builtin: false,
  created_at: 1,
  updated_at: 1,
};

describe('RecycleBinSettings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    resetRecycleBinStoreForTests();
    useAuthStore.setState({ cloudSession: null, localUserId: 'recycle-settings-account' });
    recycleBinStore.archiveAgent(archivedAgent, Date.now());
  });

  it('shows recoverable items and restores through the connected service', async () => {
    serviceMocks.restore.mockResolvedValueOnce({
      kind: 'agent',
      entityId: archivedAgent.id,
      renamed: false,
    });
    render(<RecycleBinSettings />);

    expect(screen.getByRole('heading', { name: 'Recycle Bin' })).toBeTruthy();
    expect(screen.getByText('Settings Bin Agent')).toBeTruthy();
    expect(screen.getByText('Agent')).toBeTruthy();
    expect(screen.getByText('90 days remaining')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Restore Settings Bin Agent' }));
    await waitFor(() => expect(serviceMocks.restore).toHaveBeenCalledOnce());
  });

  it('requires confirmation for permanent deletion and emptying the bin', async () => {
    render(<RecycleBinSettings />);

    fireEvent.click(screen.getByRole('button', { name: 'Permanently delete Settings Bin Agent' }));
    expect(serviceMocks.permanentlyDelete).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Delete permanently' }));
    await waitFor(() => expect(serviceMocks.permanentlyDelete).toHaveBeenCalledOnce());

    fireEvent.click(screen.getByRole('button', { name: 'Empty Recycle Bin' }));
    expect(serviceMocks.empty).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Empty Recycle Bin permanently' }));
    await waitFor(() => expect(serviceMocks.empty).toHaveBeenCalledOnce());
  });
});
