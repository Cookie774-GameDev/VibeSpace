import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Ambient } from './Ambient';
import { ComposerStt } from './ComposerStt';
import { PhoneVoice } from './PhoneVoice';
import { Voice } from './Voice';

const mocks = vi.hoisted(() => {
  const authState = {
    apiKeys: {},
    composerSttProvider: 'system' as const,
    fasterWhisperModel: 'small' as const,
    hydrateApiKeysFromVault: vi.fn(async () => undefined),
    jarvisAutoApprove: false,
    personaPreset: 'jarvis',
    plan: 'free',
    setComposerSttProvider: vi.fn(),
    setFasterWhisperModel: vi.fn(),
    setJarvisAutoApprove: vi.fn(),
    setPersona: vi.fn(),
    setSpeakReplies: vi.fn(),
    setVoiceAutoApproveActions: vi.fn(),
    setVoiceAutoListenOnOpen: vi.fn(),
    setVoiceCancelPhrase: vi.fn(),
    setVoiceCommitPhrase: vi.fn(),
    setVoiceEndTrigger: vi.fn(),
    setVoiceEngine: vi.fn(),
    setVoiceListenTimeoutMs: vi.fn(),
    setVoicePreset: vi.fn(),
    setVoiceSilenceDelayMs: vi.fn(),
    speakReplies: false,
    voiceAutoApproveActions: false,
    voiceAutoListenOnOpen: true,
    voiceCancelPhrase: 'cancel',
    voiceCommitPhrase: 'send it',
    voiceEndTrigger: 'phrase' as const,
    voiceEngine: 'jarvis' as const,
    voiceListenTimeoutMs: 30_000,
    voicePreset: 'jarvis-prime' as const,
    voiceSilenceDelayMs: 1_500,
  };
  const uiState = {
    ambient: true,
    ambientActive: false,
    ambientAlwaysPlay: false,
    ambientDrone: true,
    ambientThresholdMs: 300_000,
    ambientTrack: 'music-1' as const,
    ambientVolume: 35,
    setAmbient: vi.fn(),
    setAmbientActive: vi.fn(),
    setAmbientAlwaysPlay: vi.fn(),
    setAmbientDrone: vi.fn(),
    setAmbientThresholdMs: vi.fn(),
    setAmbientTrack: vi.fn(),
    setAmbientVolume: vi.fn(),
    setSettingsOpen: vi.fn(),
  };
  return {
    authState,
    audioEngine: {
      play: vi.fn(),
      resume: vi.fn(),
      setTrack: vi.fn(),
      setVolume: vi.fn(),
      stop: vi.fn(),
      subscribeStatus: vi.fn(() => vi.fn()),
    },
    uiState,
    warmVoiceEngine: vi.fn(),
  };
});

vi.mock('@/stores/auth', () => ({
  useAuthStore: Object.assign(
    (selector: (state: typeof mocks.authState) => unknown) => selector(mocks.authState),
    { getState: () => mocks.authState },
  ),
}));

vi.mock('@/stores/ui', () => ({
  useUIStore: Object.assign(
    (selector: (state: typeof mocks.uiState) => unknown) => selector(mocks.uiState),
    { getState: () => mocks.uiState },
  ),
}));

vi.mock('@/lib/admin', () => ({
  useAppAdmin: () => ({ isAdmin: false }),
}));

vi.mock('@/lib/entitlements', () => ({
  effectivePlan: (plan: string) => plan,
  planAllowsVoiceWithAdmin: () => true,
}));

vi.mock('@/features/billing/planLimits', () => ({
  getCombinedUsage: vi.fn(() => new Promise(() => undefined)),
}));

vi.mock('@/lib/security/voiceKeys', () => ({
  getDeepgramVoiceKey: vi.fn(() => new Promise(() => undefined)),
  getOpenAIVoiceKey: vi.fn(() => new Promise(() => undefined)),
  setVoiceApiKey: vi.fn(),
}));

vi.mock('@/features/voice/providers/deepgramSpeak', () => ({
  testDeepgramVoiceKey: vi.fn(),
}));

vi.mock('@/features/voice/speechSynthesis', () => ({
  getInstalledSpeechVoices: vi.fn(),
  isSpeechSynthesisSupported: vi.fn(() => false),
}));

vi.mock('@/features/voice/voiceRouter', () => ({
  cancelVoicePreview: vi.fn(),
  previewVoiceWithSettings: vi.fn(),
  warmVoiceEngine: mocks.warmVoiceEngine,
}));

vi.mock('@/features/voice/modelManager', () => ({
  JARVIS_HIGH_SOURCE_URL: 'https://huggingface.co/jgkawell/jarvis/tree/main/en/en_GB/jarvis/high',
  JARVIS_HIGH_MANIFEST: {
    files: [{ name: 'jarvis-high.onnx', size_bytes: 114_199_011 }],
  },
  ModelManager: {
    ensureJarvisReady: vi.fn(),
    status: vi.fn(),
  },
}));

vi.mock('@/features/voice/wakeWord', () => ({
  readWakeWordEnabled: () => false,
  setWakeWordEnabled: vi.fn(),
}));

vi.mock('@/features/composer-stt', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/features/composer-stt')>();
  return {
    ...actual,
    FasterWhisperManager: {
      checkInstalled: vi.fn(async () => false),
      downloadModel: vi.fn(async () => false),
      removeModel: vi.fn(async () => false),
    },
    isSystemSttAvailable: () => false,
  };
});

vi.mock('@/lib/tauri', () => ({
  openSystemSpeechSettings: vi.fn(),
}));

vi.mock('@/features/ambient/ambientAudio', () => ({
  AmbientAudioEngine: {
    getInstance: () => mocks.audioEngine,
  },
}));

vi.mock('@/lib/supabase/client', () => ({
  getSupabaseClient: () => null,
}));

vi.mock('@/lib/bridge', () => ({
  getBridgeClient: () => ({ getStatus: () => 'disabled' }),
}));

vi.mock('@/features/call/CallService', () => ({
  getCallService: () => ({ getCloudUrl: () => '' }),
}));

const MONOCHROME_GATES = [
  '[html[data-theme=monochrome]_&_*]:rounded-none',
  '[html[data-theme=monochrome]_&_*]:bg-none',
  '[html[data-theme=monochrome]_&_*]:shadow-none',
  '[html[data-theme=monochrome]_&_*]:!animate-none',
  '[html[data-theme=monochrome]_&_*]:!blur-none',
  '[html[data-theme=monochrome]_&_*]:backdrop-blur-none',
  '[html[data-theme=monochrome]_&_*]:transition-none',
  '[html[data-theme=monochrome]_&_*]:focus-visible:outline',
  '[html[data-theme=monochrome]_&_*]:focus-visible:outline-2',
  '[html[data-theme=monochrome]_&_*]:focus-visible:outline-offset-2',
  '[html[data-theme=monochrome]_&_*]:focus-visible:outline-ring',
  'motion-reduce:[&_*]:!animate-none',
  'motion-reduce:[&_*]:transition-none',
] as const;

function expectSurfaceGates(selector: string) {
  const root = document.querySelector<HTMLElement>(selector);
  expect(root).not.toBeNull();
  for (const gate of MONOCHROME_GATES) {
    expect(root?.className).toContain(gate);
  }
}

function expectGradientTextFallbacks() {
  const gradientText = document.querySelectorAll<HTMLElement>('.text-accent-gradient');
  expect(gradientText.length).toBeGreaterThan(0);
  for (const label of gradientText) {
    expect(label.className).toContain('[html[data-theme=monochrome]_&]:!bg-none');
    expect(label.className).toContain('[html[data-theme=monochrome]_&]:!text-foreground');
    expect(label.className).toContain(
      '[html[data-theme=monochrome]_&]:![-webkit-text-fill-color:currentColor]',
    );
  }
}

describe('voice-related settings MonoChrome appearance', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('closes Voice effects without warming or capturing media', () => {
    render(<Voice active={false} />);

    expectSurfaceGates('.mc7f-settings-voice');
    expectGradientTextFallbacks();
    expect(screen.getByRole('heading', { name: 'Voice' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Test microphone' })).toBeTruthy();
    const voiceCards = document.querySelectorAll<HTMLButtonElement>(
      '.mc7f-settings-voice button[aria-pressed]',
    );
    expect(voiceCards.length).toBeGreaterThan(0);
    for (const card of voiceCards) {
      expect(card.dataset.monochromeControlSize).toBe('preserve');
    }
    expect(mocks.warmVoiceEngine).not.toHaveBeenCalled();
  });

  it('closes composer STT effects without inspecting or downloading a model', () => {
    render(<ComposerStt />);

    expectSurfaceGates('.mc7f-settings-composer-stt');
    expectGradientTextFallbacks();
    expect(screen.getByRole('heading', { name: 'Speech to Text' })).toBeTruthy();
    expect(screen.getByRole('radio', { name: /Free System/i })).toBeTruthy();
    const providerCards = document.querySelectorAll<HTMLButtonElement>(
      '.mc7f-settings-composer-stt button[role="radio"]',
    );
    expect(providerCards.length).toBeGreaterThan(0);
    for (const card of providerCards) {
      expect(card.dataset.monochromeControlSize).toBe('preserve');
    }
  });

  it('closes phone effects while preserving the privacy disclosure and isolated fixture', async () => {
    render(<PhoneVoice />);

    expect(await screen.findByRole('heading', { name: 'Phone & Voice' })).toBeTruthy();
    expectSurfaceGates('.mc7f-settings-phone-voice');
    expect(screen.getByText(/Your files stay on this computer/)).toBeTruthy();
  });

  it('closes ambient effects without starting audio', () => {
    render(<Ambient />);

    expectSurfaceGates('.mc7f-settings-ambient');
    expect(screen.getByRole('heading', { name: 'Ambient mode' })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Try ambient mode now/ })).toBeTruthy();
    expect(
      screen.getByText('Arabian Dunes at Night').closest('button')?.dataset.monochromeControlSize,
    ).toBe('preserve');
    expect(mocks.audioEngine.play).not.toHaveBeenCalled();
    expect(mocks.audioEngine.resume).not.toHaveBeenCalled();
  });
});
