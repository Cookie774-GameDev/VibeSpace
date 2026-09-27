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
      voiceMiniBarEnabled: false,
      voiceStartFreshChat: false,
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

  it('resumes by default, keeps the mini bar off, and saves both settings independently', () => {
    render(<Voice active={false} />);
    const settings = screen.getByRole('region', { name: 'Voice agent providers' });
    const conversation = within(settings).getByRole('combobox', {
      name: 'Jarvis voice chat on open',
    }) as HTMLSelectElement;
    const miniBar = within(settings).getByRole('switch', { name: /Typed mini bar/i });

    expect(conversation.value).toBe('resume');
    expect(miniBar.getAttribute('aria-checked')).toBe('false');
    fireEvent.change(conversation, { target: { value: 'new' } });
    expect(useAuthStore.getState().voiceStartFreshChat).toBe(true);
    expect(useAuthStore.getState().voiceMiniBarEnabled).toBe(false);
    fireEvent.click(miniBar);
    expect(useAuthStore.getState().voiceMiniBarEnabled).toBe(true);
    expect(useAuthStore.getState().voiceStartFreshChat).toBe(true);
    expect(useAuthStore.getState().voiceMainAgentProvider).toBe('codex');
    expect(useAuthStore.getState().voiceWorkerProvider).toBe('codex');
  });
});
