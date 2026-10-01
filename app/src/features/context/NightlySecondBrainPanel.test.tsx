import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuthStore } from '@/stores/auth';
import { NightlySecondBrainPanel } from './NightlySecondBrainPanel';
import {
  nightlySecondBrainScopeKey,
  resetNightlySecondBrainStoreForTests,
  useNightlySecondBrainStore,
} from './nightlySecondBrainStore';

const runNightlySecondBrain = vi.fn().mockResolvedValue(undefined);

vi.mock('@/lib/ai/useAccessibleChatModels', () => ({
  useAccessibleChatModels: () => ({ flatOptions: [] }),
}));

vi.mock('./nightlySecondBrainRuntime', () => ({
  runNightlySecondBrain,
}));

describe('NightlySecondBrainPanel manual run', () => {
  beforeEach(() => {
    runNightlySecondBrain.mockClear();
    resetNightlySecondBrainStoreForTests();
    useAuthStore.setState({
      cloudSession: null,
      localUserId: 'account-a',
      workspaceId: 'workspace-a' as never,
      projectId: 'project-a' as never,
    });
    const scopeKey = nightlySecondBrainScopeKey({
      accountId: 'account-a',
      workspaceId: 'workspace-a',
      projectId: 'project-a',
    });
    const store = useNightlySecondBrainStore.getState();
    store.setModel(scopeKey, {
      id: 'local:model',
      label: 'Local model',
      local: true,
      provider: 'ollama',
      modelId: 'model',
    });
    store.setEnabled(scopeKey, true);
  });

  it('offers an explicit run-now action and sends one canonical manual schedule timestamp', async () => {
    render(<NightlySecondBrainPanel />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /expand nightly maintenance settings/i }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /run now/i }));
    });

    await vi.waitFor(() => expect(runNightlySecondBrain).toHaveBeenCalledTimes(1));
    expect(runNightlySecondBrain.mock.calls[0]?.[0]).toEqual(expect.any(Number));
  });
});
