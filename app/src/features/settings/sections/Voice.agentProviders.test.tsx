import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
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
      voiceWorkerSessionMode: 'new',
      voiceProviderAccentsEnabled: false,
      voiceAccentIntensity: 60,
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

    act(() => fireEvent.change(worker, { target: { value: 'opencode' } }));
    expect(useAuthStore.getState().voiceWorkerProvider).toBe('opencode');
    expect(useAuthStore.getState().voiceMainAgentProvider).toBe('codex');

    act(() => fireEvent.change(worker, { target: { value: 'codex' } }));
    act(() => fireEvent.change(mainAgent, { target: { value: 'opencode' } }));
    expect(useAuthStore.getState().voiceMainAgentProvider).toBe('opencode');
    expect(useAuthStore.getState().voiceWorkerProvider).toBe('codex');
  });

  it('keeps Main resume and Worker new defaults independent, with the mini bar off', () => {
    render(<Voice active={false} />);
    const settings = screen.getByRole('region', { name: 'Voice agent providers' });
    const conversation = within(settings).getByRole('combobox', {
      name: 'Jarvis voice chat on open',
    }) as HTMLSelectElement;
    const workerSession = within(settings).getByRole('combobox', {
      name: 'Jarvis worker session',
    }) as HTMLSelectElement;
    const miniBar = within(settings).getByRole('switch', { name: /Typed mini bar/i });

    expect(conversation.value).toBe('resume');
    expect(workerSession.value).toBe('new');
    expect(miniBar.getAttribute('aria-checked')).toBe('false');
    fireEvent.change(conversation, { target: { value: 'new' } });
    expect(useAuthStore.getState().voiceStartFreshChat).toBe(true);
    expect(useAuthStore.getState().voiceWorkerSessionMode).toBe('new');
    fireEvent.change(workerSession, { target: { value: 'resume' } });
    expect(useAuthStore.getState().voiceWorkerSessionMode).toBe('resume');
    expect(useAuthStore.getState().voiceStartFreshChat).toBe(true);
    expect(useAuthStore.getState().voiceMiniBarEnabled).toBe(false);
    fireEvent.click(miniBar);
    expect(useAuthStore.getState().voiceMiniBarEnabled).toBe(true);
    expect(useAuthStore.getState().voiceStartFreshChat).toBe(true);
    expect(useAuthStore.getState().voiceMainAgentProvider).toBe('codex');
    expect(useAuthStore.getState().voiceWorkerProvider).toBe('codex');

    const persisted = JSON.parse(window.localStorage.getItem('jarvis-auth') ?? '{}') as {
      state?: Record<string, unknown>;
    };
    expect(persisted.state).toMatchObject({
      voiceStartFreshChat: true,
      voiceWorkerSessionMode: 'resume',
      voiceMiniBarEnabled: true,
    });
  });

  it('offers provider accents and intensity as independent saved voice controls', () => {
    render(<Voice active={false} />);
    const settings = screen.getByRole('region', { name: 'Voice agent providers' });
    const accents = within(settings).getByRole('switch', { name: 'Provider accents' });
    const intensity = within(settings).getByRole('slider', { name: 'Accent intensity' });

    expect(accents.getAttribute('aria-checked')).toBe('false');
    expect((intensity as HTMLInputElement).value).toBe('60');
    expect((intensity as HTMLInputElement).disabled).toBe(true);

    act(() => fireEvent.click(accents));
    expect(useAuthStore.getState().voiceProviderAccentsEnabled).toBe(true);
    expect((intensity as HTMLInputElement).disabled).toBe(false);
    act(() => fireEvent.change(intensity, { target: { value: '83' } }));
    expect(useAuthStore.getState().voiceAccentIntensity).toBe(83);
    expect(useAuthStore.getState().voiceMainAgentProvider).toBe('codex');
    expect(useAuthStore.getState().voiceWorkerProvider).toBe('codex');
  });

  it('defaults the new controls when upgrading persisted version 20 settings', async () => {
    window.localStorage.setItem(
      'jarvis-auth',
      JSON.stringify({
        state: {
          apiKeys: {},
          voiceMainAgentProvider: 'opencode',
          voiceWorkerProvider: 'codex',
          voiceStartFreshChat: false,
        },
        version: 20,
      }),
    );

    await useAuthStore.persist.rehydrate();

    expect(useAuthStore.getState()).toMatchObject({
      voiceMainAgentProvider: 'opencode',
      voiceWorkerProvider: 'codex',
      voiceStartFreshChat: false,
      voiceWorkerSessionMode: 'new',
      voiceProviderAccentsEnabled: false,
      voiceAccentIntensity: 60,
    });
  });
});
