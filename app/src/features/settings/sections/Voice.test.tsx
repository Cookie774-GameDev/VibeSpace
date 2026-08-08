import * as React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Voice } from './Voice';

const mocks = vi.hoisted(() => ({
  authState: {
    personaPreset: 'jarvis',
    setPersona: vi.fn(),
    voicePreset: 'jarvis-prime',
    setVoicePreset: vi.fn(),
    voiceEngine: 'jarvis' as 'deepgram' | 'jarvis' | 'local' | 'system',
    setVoiceEngine: vi.fn(),
    speakReplies: false,
    setSpeakReplies: vi.fn(),
    voiceAutoListenOnOpen: true,
    setVoiceAutoListenOnOpen: vi.fn(),
    voiceSilenceDelayMs: 1_500,
    setVoiceSilenceDelayMs: vi.fn(),
    voiceListenTimeoutMs: 30_000,
    setVoiceListenTimeoutMs: vi.fn(),
    voiceEndTrigger: 'phrase',
    setVoiceEndTrigger: vi.fn(),
    voiceCommitPhrase: 'send it',
    setVoiceCommitPhrase: vi.fn(),
    voiceCancelPhrase: 'cancel',
    setVoiceCancelPhrase: vi.fn(),
    jarvisAutoApprove: false,
    setJarvisAutoApprove: vi.fn(),
    voiceAutoApproveActions: true,
    setVoiceAutoApproveActions: vi.fn(),
    plan: 'free',
  },
  cancelVoicePreview: vi.fn(),
  getInstalledSpeechVoices: vi.fn(),
  isSpeechSynthesisSupported: vi.fn(),
  openSystemSpeechSettings: vi.fn(),
  previewVoiceWithSettings: vi.fn(),
  toast: {
    error: vi.fn(),
    info: vi.fn(),
    success: vi.fn(),
    warning: vi.fn(),
  },
  warmVoiceEngine: vi.fn(),
}));

vi.mock('@/stores/auth', () => ({
  useAuthStore: (selector: (state: typeof mocks.authState) => unknown) => selector(mocks.authState),
}));

vi.mock('@/features/voice/speechSynthesis', () => ({
  getInstalledSpeechVoices: mocks.getInstalledSpeechVoices,
  isSpeechSynthesisSupported: mocks.isSpeechSynthesisSupported,
}));

vi.mock('@/features/voice/voiceRouter', () => ({
  cancelVoicePreview: mocks.cancelVoicePreview,
  previewVoiceWithSettings: mocks.previewVoiceWithSettings,
  warmVoiceEngine: mocks.warmVoiceEngine,
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
  setVoiceApiKey: vi.fn(async () => undefined),
}));

vi.mock('@/features/voice/providers/deepgramSpeak', () => ({
  testDeepgramVoiceKey: vi.fn(async () => true),
}));

vi.mock('@/features/voice/modelManager', () => ({
  JARVIS_HIGH_SOURCE_URL: 'https://huggingface.co/jgkawell/jarvis/tree/main/en/en_GB/jarvis/high',
  JARVIS_HIGH_MANIFEST: {
    files: [{ name: 'jarvis-high.onnx', size_bytes: 114_199_011 }],
  },
  ModelManager: {
    ensureJarvisReady: vi.fn(async () => false),
    status: vi.fn(async () => ({ ready: false })),
  },
}));

vi.mock('@/lib/tauri', () => ({
  openSystemSpeechSettings: mocks.openSystemSpeechSettings,
}));

vi.mock('@/features/voice/wakeWord', () => ({
  readWakeWordEnabled: () => false,
  setWakeWordEnabled: vi.fn(),
}));

vi.mock('@/components/ui/toast', () => ({
  toast: mocks.toast,
}));

vi.mock('@/components/ui/switch', () => ({
  Switch: () => null,
}));

vi.mock('@/features/settings/components/MicrophoneTestPanel', () => ({
  MicrophoneTestPanel: () => <button type="button">Test microphone</button>,
}));

const EXPECTED = {
  localInspection:
    'The action failed, sir. Action: Installed voice inspection. Cause: Installed voices could not be inspected. Check Windows speech voice packages, then try the check again.',
  localUnsupported:
    'The action failed, sir. Action: Local voice availability. Cause: This runtime does not provide system speech synthesis. Select Jarvis High or another available voice engine in Settings → Voice.',
  preview: {
    deepgram:
      'The action failed, sir. Action: Deepgram voice preview. Cause: The selected voice could not play. Check the Deepgram engine in Settings → Voice, then try the preview again.',
    jarvis:
      'The action failed, sir. Action: Jarvis High voice preview. Cause: The selected voice could not play. Check the Jarvis High engine in Settings → Voice, then try the preview again.',
    local:
      'The action failed, sir. Action: Local voice preview. Cause: The selected voice could not play. Check the Local engine in Settings → Voice, then try the preview again.',
    system:
      'The action failed, sir. Action: System voice preview. Cause: The selected voice could not play. Check the System engine in Settings → Voice, then try the preview again.',
  },
  jarvis:
    'The action failed, sir. Action: Jarvis High voice test. Cause: The local Piper voice could not synthesize the test phrase. Jarvis will use the operating-system fallback; check the local model in Settings → Voice, then try again.',
  settings:
    'The action failed, sir. Action: Windows speech settings. Cause: Windows Speech settings could not be opened automatically. Open Settings → Time & language → Speech manually, install a voice package, then check local voices again.',
} as const;

function renderVoice() {
  return render(<Voice active={false} />);
}

function toastPayload(): string {
  return JSON.stringify(Object.values(mocks.toast).flatMap((toastMock) => toastMock.mock.calls));
}

describe('Voice settings failure narration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authState.voiceEngine = 'jarvis';
    mocks.authState.voiceAutoListenOnOpen = true;
    mocks.authState.voiceEndTrigger = 'phrase';
    mocks.authState.voiceSilenceDelayMs = 1_500;
    mocks.isSpeechSynthesisSupported.mockReturnValue(true);
    mocks.getInstalledSpeechVoices.mockResolvedValue([]);
    mocks.previewVoiceWithSettings.mockResolvedValue(undefined);
    mocks.openSystemSpeechSettings.mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        getUserMedia: vi.fn(async () => ({
          getTracks: () => [{ stop: vi.fn() }],
        })),
      },
    });
  });

  it('shows Jarvis High as default, credits the model, labels OS fallback, and exposes two personas', () => {
    renderVoice();

    expect(
      screen.getByRole('button', { name: /Jarvis HighDefault offline Piper voice/i }),
    ).toBeTruthy();
    expect(screen.getByText(/108\.91 MiB/)).toBeTruthy();
    expect(
      screen.getByRole<HTMLAnchorElement>('link', { name: 'Jack Kawell on Hugging Face' }).href,
    ).toBe('https://huggingface.co/jgkawell/jarvis/tree/main/en/en_GB/jarvis/high');
    expect(screen.getByRole('button', { name: /OS local fallback/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /JarvisCrisp, attentive/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /FridayWarm, capable/i })).toBeTruthy();
    expect(screen.queryByText('Athena')).toBeNull();
    expect(screen.queryByText('Edge')).toBeNull();
    expect(screen.queryByText('Watson')).toBeNull();
    expect(screen.queryByText('HAL')).toBeNull();
  });

  it('shows no duration or hands-free timeout in explicit send-it mode', () => {
    renderVoice();

    expect(screen.getByText(/keeps listening until you say "send it"/i)).toBeTruthy();
    expect(document.querySelector('#voice-silence-delay')).toBeNull();
    expect(document.querySelector('#voice-listen-timeout')).toBeNull();
  });

  it('shows exactly one 1-60 second silence control in pause mode', () => {
    mocks.authState.voiceEndTrigger = 'silence';
    mocks.authState.voiceSilenceDelayMs = 60_000;
    renderVoice();

    const control = document.querySelector<HTMLInputElement>('#voice-silence-delay');
    expect(control).not.toBeNull();
    expect(control?.min).toBe('1000');
    expect(control?.max).toBe('60000');
    expect(screen.getAllByText('60 seconds')).toHaveLength(2);
    expect(document.querySelector('#voice-listen-timeout')).toBeNull();
    expect(screen.getAllByText(/silence duration/i)).toHaveLength(2);
  });

  it.each(['deepgram', 'jarvis', 'local', 'system'] as const)(
    'does not expose a %s preview exception and identifies the selected engine',
    async (engine) => {
      const rawDetail = `RAW_${engine.toUpperCase()}_PROVIDER_PREVIEW_SENTINEL`;
      mocks.authState.voiceEngine = engine;
      mocks.previewVoiceWithSettings.mockRejectedValueOnce(new Error(rawDetail));
      renderVoice();

      fireEvent.click(screen.getByRole('button', { name: 'Preview JARVIS voice' }));

      await vi.waitFor(() =>
        expect(mocks.toast.error).toHaveBeenCalledWith(
          'Voice preview failed',
          EXPECTED.preview[engine],
        ),
      );
      expect(toastPayload()).not.toContain(rawDetail);
    },
  );

  it('directs unsupported local speech to another available engine', () => {
    mocks.authState.voiceEngine = 'local';
    mocks.isSpeechSynthesisSupported.mockReturnValue(false);
    renderVoice();

    fireEvent.click(screen.getByRole('button', { name: 'Check local voices' }));

    expect(mocks.toast.warning).toHaveBeenCalledWith(
      'Local voice unavailable',
      EXPECTED.localUnsupported,
    );
  });

  it('does not expose an installed-voice enumeration exception', async () => {
    const rawDetail = 'RAW_INSTALLED_VOICE_ENUMERATION_SENTINEL';
    mocks.authState.voiceEngine = 'local';
    mocks.getInstalledSpeechVoices.mockRejectedValueOnce(new Error(rawDetail));
    renderVoice();

    fireEvent.click(screen.getByRole('button', { name: 'Check local voices' }));

    await vi.waitFor(() =>
      expect(mocks.toast.error).toHaveBeenCalledWith(
        'Local voice check failed',
        EXPECTED.localInspection,
      ),
    );
    expect(toastPayload()).not.toContain(rawDetail);
  });

  it('uses the same safe Jarvis fallback diagnostic in the toast and inline status', async () => {
    const rawDetail = 'RAW_JARVIS_SYNTHESIS_SENTINEL';
    mocks.previewVoiceWithSettings.mockRejectedValueOnce(new Error(rawDetail));
    renderVoice();

    fireEvent.click(screen.getByRole('button', { name: 'Test Jarvis High voice' }));

    expect(await screen.findByText(EXPECTED.jarvis)).toBeTruthy();
    expect(mocks.toast.error).toHaveBeenCalledWith('Jarvis High test failed', EXPECTED.jarvis);
    expect(screen.queryByText(rawDetail)).toBeNull();
    expect(toastPayload()).not.toContain(rawDetail);
  });

  it('retains the manual Windows path without exposing launcher details', async () => {
    const rawDetail = 'RAW_TAURI_SETTINGS_LAUNCH_SENTINEL';
    mocks.authState.voiceEngine = 'local';
    mocks.openSystemSpeechSettings.mockRejectedValueOnce(new Error(rawDetail));
    renderVoice();

    fireEvent.click(screen.getByRole('button', { name: 'Install voice pack' }));

    await vi.waitFor(() =>
      expect(mocks.toast.warning).toHaveBeenCalledWith(
        'Open speech settings manually',
        EXPECTED.settings,
      ),
    );
    expect(toastPayload()).not.toContain(rawDetail);
  });
});
