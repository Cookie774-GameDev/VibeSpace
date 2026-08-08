import { afterEach, vi } from 'vitest';
import { useAuthStore } from './auth';
import { secureDeleteApiKey, secureGetApiKey } from '@/lib/security/secureApiKeys';
import { DEFAULT_CUSTOM_STEPS } from '@/lib/ai/stacks/presets';

describe('Prompt Forge model preference', () => {
  beforeEach(() => {
    window.localStorage.clear();
    useAuthStore.setState({
      chatModelSelection: { mode: 'none' },
      promptForgeModelSelection: { mode: 'prefer_local' },
    });
  });

  it('defaults separately to Prefer local and never changes the chat model', () => {
    expect(useAuthStore.getInitialState().promptForgeModelSelection).toEqual({
      mode: 'prefer_local',
    });
    useAuthStore.getState().setPromptForgeModelSelection({
      mode: 'single',
      providerId: 'openai',
      modelId: 'gpt-5.6-sol',
      connectionId: 'openai-codex',
    });
    expect(useAuthStore.getState().chatModelSelection).toEqual({ mode: 'none' });
    expect(useAuthStore.getState().promptForgeModelSelection).toMatchObject({
      mode: 'single',
      connectionId: 'openai-codex',
    });
    expect(window.localStorage.getItem('jarvis-auth')).toContain(
      '"promptForgeModelSelection":{"mode":"single"',
    );
  });

  it('migrates prior state to the safe local-first default', async () => {
    useAuthStore.setState({
      promptForgeModelSelection: { mode: 'current_chat_model' },
    });
    window.localStorage.setItem(
      'jarvis-auth',
      JSON.stringify({
        state: {
          apiKeys: {},
          chatModelSelection: { mode: 'none' },
          previousChatModelSelection: { mode: 'none' },
        },
        version: 13,
      }),
    );
    await useAuthStore.persist.rehydrate();
    expect(useAuthStore.getState().promptForgeModelSelection).toEqual({
      mode: 'prefer_local',
    });
  });
});

describe('composer STT defaults', () => {
  it('defaults to system provider and Whisper small.en Q8 local catalog id', () => {
    expect(useAuthStore.getInitialState().composerSttProvider).toBe('system');
    expect(useAuthStore.getInitialState().fasterWhisperModel).toBe('whisper-small-en-q8');
  });
});

describe('automatic model routing preference', () => {
  beforeEach(() => {
    window.localStorage.clear();
    useAuthStore.setState({ automaticModelRoutingEnabled: false });
  });

  it('defaults disabled and persists an explicit user toggle', async () => {
    expect(useAuthStore.getInitialState().automaticModelRoutingEnabled).toBe(false);

    useAuthStore.getState().setAutomaticModelRoutingEnabled(true);
    const persisted = window.localStorage.getItem('jarvis-auth') ?? '';
    expect(persisted).toContain('"automaticModelRoutingEnabled":true');

    useAuthStore.setState({ automaticModelRoutingEnabled: false });
    window.localStorage.setItem('jarvis-auth', persisted);
    await useAuthStore.persist.rehydrate();
    expect(useAuthStore.getState().automaticModelRoutingEnabled).toBe(true);
  });

  it('migrates v12 state to the safe disabled policy', async () => {
    window.localStorage.setItem(
      'jarvis-auth',
      JSON.stringify({
        state: {
          chatModelSelection: { mode: 'none' },
          previousChatModelSelection: { mode: 'none' },
          apiKeys: {},
        },
        version: 12,
      }),
    );

    await useAuthStore.persist.rehydrate();
    expect(useAuthStore.getState().automaticModelRoutingEnabled).toBe(false);
  });
});

describe('voice defaults', () => {
  it('defaults new installs to Jarvis High neural voice', () => {
    expect(useAuthStore.getInitialState().voiceEngine).toBe('jarvis');
  });

  it('migrates legacy system voice to Jarvis High', async () => {
    window.localStorage.setItem(
      'jarvis-auth',
      JSON.stringify({
        state: {
          voiceEngine: 'system',
          voicePreset: 'jarvis-prime',
        },
        version: 7,
      }),
    );
    await useAuthStore.persist.rehydrate();
    expect(useAuthStore.getState().voiceEngine).toBe('jarvis');
  });

  it('migrates Kokoro and retired personas to Jarvis', async () => {
    window.localStorage.setItem(
      'jarvis-auth',
      JSON.stringify({
        state: {
          voiceEngine: 'kokoro',
          voicePreset: 'jarvis-prime',
          personaPreset: 'athena',
        },
        version: 14,
      }),
    );
    await useAuthStore.persist.rehydrate();
    expect(useAuthStore.getState().voiceEngine).toBe('jarvis');
    expect(useAuthStore.getState().personaPreset).toBe('jarvis');
  });
});

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
    expect(useAuthStore.getState().voiceEndTrigger).toBe('phrase');
    expect(useAuthStore.getState().voiceCommitPhrase).toBe('send it');
    expect(useAuthStore.getState().voiceCancelPhrase).toBe('cancel');
  });

  it('persists voice commit phrase settings', () => {
    useAuthStore.getState().setVoiceEndTrigger('silence');
    useAuthStore.getState().setVoiceCommitPhrase('go ahead');
    useAuthStore.getState().setVoiceCancelPhrase('never mind');

    const persisted = window.localStorage.getItem('jarvis-auth') ?? '';
    expect(persisted).toContain('"voiceEndTrigger":"silence"');
    expect(persisted).toContain('"voiceCommitPhrase":"go ahead"');
    expect(persisted).toContain('"voiceCancelPhrase":"never mind"');
  });

  it('persists Hive preset and custom steps without API keys', () => {
    vi.stubEnv('VITE_HIVE_ENABLED', 'true');
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
    expect(persisted).toContain('"chatModelSelection":{"mode":"hive","hiveId":"custom"}');
    expect(persisted).toContain('"model":"gpt-4o-mini"');
    expect(persisted).not.toContain('sk_');
    expect(persisted).not.toContain('service_role');
    vi.unstubAllEnvs();
  });

  it('refuses Hive stack activation while the product is gated', () => {
    useAuthStore.getState().setStackPreset('balanced');
    expect(useAuthStore.getState().stackPreset).toBe('off');
    expect(useAuthStore.getState().chatModelSelection).toEqual({ mode: 'none' });
  });

  it('persists explicit single-model chat selection', () => {
    useAuthStore.getState().setChatModelSelection({
      mode: 'single',
      providerId: 'groq',
      modelId: 'llama-3.3-70b-versatile',
    });

    const persisted = window.localStorage.getItem('jarvis-auth') ?? '';
    expect(persisted).toContain(
      '"chatModelSelection":{"mode":"single","providerId":"groq","modelId":"llama-3.3-70b-versatile"}',
    );
    expect(persisted).toContain('"stackPreset":"off"');
  });

  it('defaults chat model selection to Choose model state', () => {
    expect(useAuthStore.getInitialState().chatModelSelection).toEqual({ mode: 'none' });
  });

  it('defaults Hive to off with documented custom steps', () => {
    expect(useAuthStore.getState().stackPreset).toBe('off');
    expect(useAuthStore.getState().stackCustomSteps).toEqual(DEFAULT_CUSTOM_STEPS);
  });

  it('caps Custom Hive to five model steps', () => {
    useAuthStore.getState().setStackCustomSteps(
      Array.from({ length: 7 }, (_, index) => ({
        id: `step-${index}`,
        label: `Step ${index}`,
        provider: 'google',
        model: 'gemini-3.5-flash',
        systemAppend: `Prompt ${index}`,
      })),
    );

    expect(useAuthStore.getState().stackCustomSteps).toHaveLength(5);
  });
});

describe('chat model selection history', () => {
  beforeEach(() => {
    window.localStorage.clear();
    useAuthStore.setState({
      chatModelSelection: { mode: 'none' },
      previousChatModelSelection: { mode: 'none' },
      stackPreset: 'off',
      selectedModels: {},
      defaultProvider: 'google',
    });
  });

  it('rotates exact previous selection atomically and ignores a same-selection write', () => {
    useAuthStore.getState().setChatModelSelection({
      mode: 'single',
      providerId: 'openai',
      modelId: 'gpt-4o-mini',
    });
    useAuthStore.getState().setChatModelSelection({
      mode: 'single',
      providerId: 'google',
      modelId: 'gemini-2.5-flash',
    });

    expect(useAuthStore.getState().previousChatModelSelection).toEqual({
      mode: 'single',
      providerId: 'openai',
      modelId: 'gpt-4o-mini',
    });
    useAuthStore.getState().setChatModelSelection({
      mode: 'single',
      providerId: 'google',
      modelId: 'gemini-2.5-flash',
    });
    expect(useAuthStore.getState().previousChatModelSelection).toEqual({
      mode: 'single',
      providerId: 'openai',
      modelId: 'gpt-4o-mini',
    });
  });

  it('persists normalized previous selection without credential fields', () => {
    useAuthStore.setState({
      chatModelSelection: {
        mode: 'single',
        providerId: 'openai',
        modelId: 'gpt-4o-mini',
      },
    });
    useAuthStore.getState().setChatModelSelection({
      mode: 'single',
      providerId: 'google',
      modelId: 'gemini-2.5-flash',
    });

    const persisted = JSON.parse(window.localStorage.getItem('jarvis-auth') ?? '{}') as {
      state?: { previousChatModelSelection?: unknown };
    };
    expect(persisted.state?.previousChatModelSelection).toEqual({
      mode: 'single',
      providerId: 'openai',
      modelId: 'gpt-4o-mini',
    });
    expect(JSON.stringify(persisted.state?.previousChatModelSelection)).not.toMatch(
      /apiKey|accessToken|accountLabel/,
    );
  });

  it('migrates v11 state with fail-closed empty previous history', async () => {
    window.localStorage.setItem(
      'jarvis-auth',
      JSON.stringify({
        state: {
          chatModelSelection: {
            mode: 'single',
            providerId: 'google',
            modelId: 'gemini-2.5-flash',
          },
          previousChatModelSelection: {
            mode: 'single',
            providerId: 'google',
            modelId: ' ',
          },
          stackPreset: 'off',
          selectedModels: {},
          defaultProvider: 'google',
          apiKeys: {},
        },
        version: 11,
      }),
    );

    await useAuthStore.persist.rehydrate();

    expect(useAuthStore.getState().previousChatModelSelection).toEqual({ mode: 'none' });
  });
});
