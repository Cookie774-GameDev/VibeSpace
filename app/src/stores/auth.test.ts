import { useAuthStore } from './auth';
import { secureDeleteApiKey, secureGetApiKey } from '@/lib/security/secureApiKeys';

describe('useAuthStore API key persistence', () => {
  beforeEach(async () => {
    window.localStorage.clear();
    useAuthStore.setState({
      apiKeys: {},
      voicePreset: 'jarvis-prime',
      voiceEngine: 'system',
      speakReplies: true,
      voiceAutoListenOnOpen: false,
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
    useAuthStore.getState().setVoiceAutoListenOnOpen(true);

    const persisted = window.localStorage.getItem('jarvis-auth') ?? '';
    expect(persisted).toContain('"voicePreset":"sentinel"');
    expect(persisted).toContain('"voiceEngine":"local"');
    expect(persisted).toContain('"speakReplies":false');
    expect(persisted).toContain('"voiceAutoListenOnOpen":true');

    useAuthStore.setState({
      voicePreset: 'jarvis-prime',
      voiceEngine: 'system',
      speakReplies: true,
      voiceAutoListenOnOpen: false,
    });
    window.localStorage.setItem('jarvis-auth', persisted);
    await useAuthStore.persist.rehydrate();

    expect(useAuthStore.getState().voicePreset).toBe('sentinel');
    expect(useAuthStore.getState().voiceEngine).toBe('local');
    expect(useAuthStore.getState().speakReplies).toBe(false);
    expect(useAuthStore.getState().voiceAutoListenOnOpen).toBe(true);
  });
});
