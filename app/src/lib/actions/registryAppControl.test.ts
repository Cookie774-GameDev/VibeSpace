import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/components/ui/toast', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
  },
}));

import { runAction } from './runner';
import { getBuiltinAction } from './registry';
import { buildAddendumText } from './promptAddendum';
import { useAuthStore } from '@/stores/auth';

describe('registryAppControl actions', () => {
  beforeEach(() => {
    useAuthStore.setState({
      voiceEngine: 'system',
      voicePreset: 'jarvis-prime',
    });
  });

  it('registers voice.setEngine and voice.configure', () => {
    expect(getBuiltinAction('voice.setEngine')).toBeDefined();
    expect(getBuiltinAction('voice.configure')).toBeDefined();
    expect(getBuiltinAction('workflow.run')).toBeDefined();
    expect(getBuiltinAction('settings.jarvisactions')).toBeDefined();
  });

  it('voice.setEngine updates the auth store', async () => {
    const result = await runAction(
      'voice.setEngine',
      { engine: 'deepgram' },
      { source: 'user' },
      { emitToast: false },
    );

    expect(result.ok).toBe(true);
    expect(useAuthStore.getState().voiceEngine).toBe('deepgram');
  });

  it('workflow.run executes steps in order', async () => {
    const result = await runAction(
      'workflow.run',
      {
        stepsJson: JSON.stringify([
          { action: 'voice.setEngine', params: { engine: 'kokoro' } },
          { action: 'voice.setPreset', params: { preset: 'aurora' } },
        ]),
      },
      { source: 'user' },
      { emitToast: false },
    );

    expect(result.ok).toBe(true);
    expect(useAuthStore.getState().voiceEngine).toBe('kokoro');
    expect(useAuthStore.getState().voicePreset).toBe('aurora');
  });

  it('voice.configure opens voice settings by default', async () => {
    const setSettingsOpen = vi.fn();
    const { useUIStore } = await import('@/stores/ui');
    const prev = useUIStore.getState().setSettingsOpen;
    useUIStore.setState({ setSettingsOpen });

    const result = await runAction(
      'voice.configure',
      { engine: 'deepgram' },
      { source: 'user' },
      { emitToast: false },
    );

    useUIStore.setState({ setSettingsOpen: prev });

    expect(result.ok).toBe(true);
    expect(setSettingsOpen).toHaveBeenCalledWith(true);
    expect(useAuthStore.getState().voiceEngine).toBe('deepgram');
  });
});

describe('prompt catalogue awareness', () => {
  it('lists voice mutation and workflow actions for the model', () => {
    const text = buildAddendumText();
    expect(text).toContain('voice.setEngine');
    expect(text).toContain('voice.configure');
    expect(text).toContain('workflow.run');
    expect(text).toContain('settings.voice');
    expect(text).toContain('Settings & voice');
  });
});
