import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuthStore } from '@/stores/auth';
import { Voice } from './Voice';

vi.mock('@/lib/security/voiceKeys', () => ({
  getDeepgramVoiceKey: vi.fn(async () => undefined),
  getOpenAIVoiceKey: vi.fn(async () => undefined),
  setVoiceApiKey: vi.fn(),
}));

vi.mock('@/features/billing/planLimits', () => ({
  getCombinedUsage: vi.fn(async () => null),
}));

afterEach(cleanup);

describe('Voice agent provider settings', () => {
  beforeEach(() => {
    useAuthStore.setState({
      voiceMainAgentProvider: 'codex',
      voiceWorkerProvider: 'codex',
    });
  });

  it('shows independent Main Agent and Worker selectors in Voice settings', () => {
    render(<Voice active={false} />);

    const settings = screen.getByRole('region', { name: 'Voice agent providers' });
    const mainAgent = within(settings).getByRole('combobox', {
      name: 'Voice Main Agent provider',
    }) as HTMLSelectElement;
    const worker = within(settings).getByRole('combobox', {
      name: 'Voice Worker provider',
    }) as HTMLSelectElement;

    expect(mainAgent.value).toBe('codex');
    expect(worker.value).toBe('codex');

    fireEvent.change(worker, { target: { value: 'opencode' } });
    expect(useAuthStore.getState().voiceWorkerProvider).toBe('opencode');
    expect(useAuthStore.getState().voiceMainAgentProvider).toBe('codex');

    fireEvent.change(worker, { target: { value: 'codex' } });
    fireEvent.change(mainAgent, { target: { value: 'opencode' } });
    expect(useAuthStore.getState().voiceMainAgentProvider).toBe('opencode');
    expect(useAuthStore.getState().voiceWorkerProvider).toBe('codex');
  });
});
