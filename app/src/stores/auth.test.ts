import { useAuthStore } from './auth';
import { secureDeleteApiKey, secureGetApiKey } from '@/lib/security/secureApiKeys';
import { DEFAULT_CUSTOM_STEPS } from '@/lib/ai/stacks/presets';

describe('useAuthStore API key persistence', () => {
  beforeEach(async () => {
    window.localStorage.clear();
    useAuthStore.setState({
      apiKeys: {},
      voicePreset: 'jarvis-prime',
      voiceEngine: 'system',
      speakReplies: true,
      voiceAutoListenOnOpen: true,
      voiceSilenceDelayMs: 2000,
      stackPreset: 'off',
      stackCustomSteps: DEFAULT_CUSTOM_STEPS,
    });
    await secureDeleteApiKey('groq');
  });

  it('does not persist secret provider keys to localStorage', () => {
    useAuthStore.getState().setApiKey('groq', 'gsk_secret_value');
    useAuthStore.getState().setApiKey('ollama', 'http://localhost:11434');

    const persisted = window.localStorage.getItem('jarvis-auth') ?? '';
    expect(persisted).not.toContain('gsk_secret_value');
    expect(persisted).toContain('http://localhost:11434');
  });

  it('migrates legacy plaintext provider keys into secure storage', async () => {
    window.localStorage.setItem(
      'jarvis-auth',
      JSON.stringify({
        state: {
          apiKeys: {
            groq: 'gsk_legacy_secret',
            ollama: 'http://localhost:11434',
          },
          defaultProvider: 'groq',
        },
        version: 1,
      }),
    );

    await useAuthStore.persist.rehydrate();

    expect(useAuthStore.getState().apiKeys.groq).toBe('gsk_legacy_secret');
    await expect(secureGetApiKey('groq')).resolves.toBe('gsk_legacy_secret');

    const persisted = window.localStorage.getItem('jarvis-auth') ?? '';
    expect(persisted).not.toContain('gsk_legacy_secret');
    expect(persisted).toContain('http://localhost:11434');
  });

  it('persists the selected spoken voice settings', async () => {
    useAuthStore.getState().setVoicePreset('sentinel');
    useAuthStore.getState().setVoiceEngine('local');
    useAuthStore.getState().setSpeakReplies(false);
    useAuthStore.getState().setVoiceAutoListenOnOpen(false);
    useAuthStore.getState().setVoiceSilenceDelayMs(3000);

    const persisted = window.localStorage.getItem('jarvis-auth') ?? '';
    expect(persisted).toContain('"voicePreset":"sentinel"');
    expect(persisted).toContain('"voiceEngine":"local"');
    expect(persisted).toContain('"speakReplies":false');
    expect(persisted).toContain('"voiceAutoListenOnOpen":false');
    expect(persisted).toContain('"voiceSilenceDelayMs":3000');

    useAuthStore.setState({
      voicePreset: 'jarvis-prime',
      voiceEngine: 'system',
      speakReplies: true,
      voiceAutoListenOnOpen: true,
      voiceSilenceDelayMs: 2000,
    });
    window.localStorage.setItem('jarvis-auth', persisted);
    await useAuthStore.persist.rehydrate();

    expect(useAuthStore.getState().voicePreset).toBe('sentinel');
    expect(useAuthStore.getState().voiceEngine).toBe('local');
    expect(useAuthStore.getState().speakReplies).toBe(false);
    expect(useAuthStore.getState().voiceAutoListenOnOpen).toBe(false);
    expect(useAuthStore.getState().voiceSilenceDelayMs).toBe(3000);
  });

  it('defaults new installs to hands-free voice with a two-second pause', () => {
    expect(useAuthStore.getState().voiceAutoListenOnOpen).toBe(true);
    expect(useAuthStore.getState().voiceSilenceDelayMs).toBe(2000);
  });

  it('persists Hive preset and custom steps without API keys', () => {
    useAuthStore.getState().setStackPreset('custom');
    useAuthStore.getState().setStackCustomSteps([
      {
        id: 'secure-step',
        label: 'Secure step',
        provider: 'openai',
        model: 'gpt-5.5',
        systemAppend: 'Never expose secrets.',
        temperature: 0.2,
      },
    ]);

    const persisted = window.localStorage.getItem('jarvis-auth') ?? '';
    expect(persisted).toContain('"stackPreset":"custom"');
    expect(persisted).toContain('"model":"gpt-5.5"');
    expect(persisted).not.toContain('sk_');
    expect(persisted).not.toContain('service_role');
  });

  it('defaults Hive to off with documented custom steps', () => {
    expect(useAuthStore.getState().stackPreset).toBe('off');
    expect(useAuthStore.getState().stackCustomSteps).toEqual(DEFAULT_CUSTOM_STEPS);
  });
});
