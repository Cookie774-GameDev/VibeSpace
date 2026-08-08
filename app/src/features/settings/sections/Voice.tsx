import { useEffect, useRef, useState, type ReactNode } from 'react';
import { AudioLines, Check, Cloud, Download, HardDrive, Play, RefreshCw } from 'lucide-react';
import { useAuthStore } from '@/stores/auth';
import type { PersonaPreset, VoiceEngine, VoicePresetId } from '@/types/common';
import { PERSONAS } from '@/features/onboarding/steps/personas-data';
import {
  getInstalledSpeechVoices,
  isSpeechSynthesisSupported,
} from '@/features/voice/speechSynthesis';
import {
  cancelVoicePreview,
  previewVoiceWithSettings,
  warmVoiceEngine,
} from '@/features/voice/voiceRouter';
import { useAppAdmin } from '@/lib/admin';
import { effectivePlan, planAllowsVoiceWithAdmin } from '@/lib/entitlements';
import { getCombinedUsage } from '@/features/billing/planLimits';
import { getDeepgramVoiceKey, getOpenAIVoiceKey, setVoiceApiKey } from '@/lib/security/voiceKeys';
import {
  DEEPGRAM_CREDENTIAL_EVENT,
  saveDeepgramCredential,
  type DeepgramCredentialSnapshot,
} from '@/lib/deepgram';
import { Input } from '@/components/ui/input';
import { VOICE_PROFILES, type VoiceProfile } from '@/features/voice/voiceProfiles';
import {
  JARVIS_HIGH_MANIFEST,
  JARVIS_HIGH_SOURCE_URL,
  ModelManager,
} from '@/features/voice/modelManager';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { Switch } from '@/components/ui/switch';
import { HOTKEYS } from '@/lib/hotkeys';
import { renderHotkey } from '@/lib/utils';
import { toast } from '@/components/ui/toast';
import { cn } from '@/lib/utils';
import { openSystemSpeechSettings } from '@/lib/tauri';
import { readWakeWordEnabled, setWakeWordEnabled } from '@/features/voice/wakeWord';
import {
  VOICE_SILENCE_DELAY_MS_MAX,
  VOICE_SILENCE_DELAY_MS_MIN,
  voiceSilenceDelayLabel,
} from '@/features/voice/voiceConversation';
import {
  VOICE_COMMIT_PHRASE_MAX_LEN,
  VOICE_COMMIT_PHRASE_MIN_LEN,
} from '@/features/voice/voiceTurnCommit';
import { formatJarvisVerifiedNarration } from '@/lib/jarvis/response/templates';
import { MicrophoneTestPanel } from '@/features/settings/components/MicrophoneTestPanel';

type LocalVoiceStatus = 'idle' | 'checking' | 'ready' | 'missing' | 'unsupported';
type JarvisVoiceStatus = 'idle' | 'downloading' | 'ready' | 'testing' | 'error';
type VoiceSettingsFailureKind =
  | 'installed_voice_inspection'
  | 'jarvis_test'
  | 'local_voice_unavailable'
  | 'windows_speech_settings';

const VOICE_ENGINE_LABELS: Readonly<Record<VoiceEngine, string>> = {
  deepgram: 'Deepgram',
  jarvis: 'Jarvis High',
  local: 'Local',
  system: 'System',
};

const VOICE_SETTINGS_FAILURE_DETAILS: Readonly<
  Record<VoiceSettingsFailureKind, Readonly<{ actionLabel: string; reason: string }>>
> = {
  installed_voice_inspection: {
    actionLabel: 'Installed voice inspection',
    reason:
      'Installed voices could not be inspected. Check Windows speech voice packages, then try the check again',
  },
  jarvis_test: {
    actionLabel: 'Jarvis High voice test',
    reason:
      'The local Piper voice could not synthesize the test phrase. Jarvis will use the operating-system fallback; check the local model in Settings → Voice, then try again',
  },
  local_voice_unavailable: {
    actionLabel: 'Local voice availability',
    reason:
      'This runtime does not provide system speech synthesis. Select Jarvis High or another available voice engine in Settings → Voice',
  },
  windows_speech_settings: {
    actionLabel: 'Windows speech settings',
    reason:
      'Windows Speech settings could not be opened automatically. Open Settings → Time & language → Speech manually, install a voice package, then check local voices again',
  },
};

function formatVoiceSettingsFailure(kind: VoiceSettingsFailureKind): string {
  const details = VOICE_SETTINGS_FAILURE_DETAILS[kind];
  return formatJarvisVerifiedNarration({
    kind: 'failure',
    actionLabel: details.actionLabel,
    reason: details.reason,
  }).text;
}

function formatVoicePreviewFailure(engine: VoiceEngine): string {
  const engineLabel = VOICE_ENGINE_LABELS[engine];
  return formatJarvisVerifiedNarration({
    kind: 'failure',
    actionLabel: `${engineLabel} voice preview`,
    reason: `The selected voice could not play. Check the ${engineLabel} engine in Settings → Voice, then try the preview again`,
  }).text;
}

/**
 * The two free local voice presets surfaced in Settings — Jarvis and Friday.
 * Derived from the shared VOICE_PROFILES list so selection/preview/persistence
 * stay intact; we just don't surface the extra technical profiles in the UI.
 */
const FREE_VOICE_PRESET_IDS: readonly VoicePresetId[] = ['jarvis-prime', 'aurora'];
const FREE_VOICE_PRESETS = VOICE_PROFILES.filter((p) => FREE_VOICE_PRESET_IDS.includes(p.id));

export function Voice({ active = true }: { active?: boolean } = {}) {
  const persona = useAuthStore((s) => s.personaPreset);
  const setPersona = useAuthStore((s) => s.setPersona);
  const voicePreset = useAuthStore((s) => s.voicePreset);
  const setVoicePreset = useAuthStore((s) => s.setVoicePreset);
  const voiceEngine = useAuthStore((s) => s.voiceEngine);
  const setVoiceEngine = useAuthStore((s) => s.setVoiceEngine);
  const speakReplies = useAuthStore((s) => s.speakReplies);
  const setSpeakReplies = useAuthStore((s) => s.setSpeakReplies);
  const voiceAutoListenOnOpen = useAuthStore((s) => s.voiceAutoListenOnOpen);
  const setVoiceAutoListenOnOpen = useAuthStore((s) => s.setVoiceAutoListenOnOpen);
  const voiceSilenceDelayMs = useAuthStore((s) => s.voiceSilenceDelayMs);
  const setVoiceSilenceDelayMs = useAuthStore((s) => s.setVoiceSilenceDelayMs);
  const voiceEndTrigger = useAuthStore((s) => s.voiceEndTrigger);
  const setVoiceEndTrigger = useAuthStore((s) => s.setVoiceEndTrigger);
  const voiceCommitPhrase = useAuthStore((s) => s.voiceCommitPhrase);
  const setVoiceCommitPhrase = useAuthStore((s) => s.setVoiceCommitPhrase);
  const voiceCancelPhrase = useAuthStore((s) => s.voiceCancelPhrase);
  const setVoiceCancelPhrase = useAuthStore((s) => s.setVoiceCancelPhrase);
  const jarvisAutoApprove = useAuthStore((s) => s.jarvisAutoApprove);
  const setJarvisAutoApprove = useAuthStore((s) => s.setJarvisAutoApprove);
  const voiceAutoApproveActions = useAuthStore((s) => s.voiceAutoApproveActions);
  const setVoiceAutoApproveActions = useAuthStore((s) => s.setVoiceAutoApproveActions);
  const plan = useAuthStore((s) => s.plan);
  const admin = useAppAdmin();
  const activePlan = effectivePlan(plan, admin);
  const canUseSystemVoice = planAllowsVoiceWithAdmin(activePlan, admin);
  const deepgramInputRef = useRef<HTMLInputElement>(null);
  const [hasDeepgramDraft, setHasDeepgramDraft] = useState(false);
  const [deepgramConfigured, setDeepgramConfigured] = useState(false);
  const [deepgramTesting, setDeepgramTesting] = useState(false);
  const [systemOpenAIDraft, setSystemOpenAIDraft] = useState('');
  const [systemOpenAIConfigured, setSystemOpenAIConfigured] = useState(false);
  const systemDeepgramInputRef = useRef<HTMLInputElement>(null);
  const [hasSystemDeepgramDraft, setHasSystemDeepgramDraft] = useState(false);
  const [subscriptionIncluded, setSubscriptionIncluded] = useState(false);
  const [previewingVoice, setPreviewingVoice] = useState<VoicePresetId | null>(null);
  const previewSeqRef = useRef(0);
  const [localVoiceStatus, setLocalVoiceStatus] = useState<LocalVoiceStatus>('idle');
  const [localVoiceNames, setLocalVoiceNames] = useState<string[]>([]);
  const [jarvisStatus, setJarvisStatus] = useState<JarvisVoiceStatus>('idle');
  const [jarvisPercent, setJarvisPercent] = useState(0);
  const [jarvisError, setJarvisError] = useState<string | null>(null);

  const [wakeWord, setWakeWord] = useState<boolean>(() => readWakeWordEnabled());
  function toggleWake(v: boolean) {
    setWakeWord(v);
    setWakeWordEnabled(v);
  }

  useEffect(() => {
    if (!active) return;
    void warmVoiceEngine(voiceEngine);
  }, [active, voiceEngine]);

  useEffect(() => () => cancelVoicePreview(), []);

  useEffect(() => {
    void getDeepgramVoiceKey().then((key) => setDeepgramConfigured(Boolean(key)));
    void getOpenAIVoiceKey().then((key) => setSystemOpenAIConfigured(Boolean(key)));
    // Subscription status comes from the server usage endpoint; never trusted
    // for gating (the edge functions enforce), display only.
    void getCombinedUsage().then((u) => {
      if (u) setSubscriptionIncluded(u.admin_unlimited || u.plan !== 'free');
    });
    const onDeepgramCredentialChanged = (event: Event) => {
      const snapshot = (event as CustomEvent<DeepgramCredentialSnapshot>).detail;
      setDeepgramConfigured(Boolean(snapshot?.configured && snapshot.health !== 'invalid'));
    };
    window.addEventListener(DEEPGRAM_CREDENTIAL_EVENT, onDeepgramCredentialChanged);
    return () => {
      window.removeEventListener(DEEPGRAM_CREDENTIAL_EVENT, onDeepgramCredentialChanged);
    };
  }, []);

  useEffect(() => {
    if (!canUseSystemVoice && voiceEngine === 'system') {
      setVoiceEngine('jarvis');
    }
  }, [canUseSystemVoice, voiceEngine, setVoiceEngine]);

  async function saveDeepgramKey() {
    const trimmed = deepgramInputRef.current?.value.trim() ?? '';
    if (!trimmed) {
      toast.warning('Enter your Deepgram API key first.');
      return;
    }
    setDeepgramTesting(true);
    try {
      const result = await saveDeepgramCredential(trimmed);
      if (result.health !== 'connected') {
        toast.error('Deepgram test failed', 'Check the key and try again.');
        return;
      }
      setDeepgramConfigured(true);
      if (deepgramInputRef.current) deepgramInputRef.current.value = '';
      setHasDeepgramDraft(false);
      setVoiceEngine('deepgram');
      try {
        window.localStorage.setItem('jarvis.voice.cloudProvider', 'deepgram_tts');
      } catch {
        /* ignore */
      }
      toast.success('Deepgram connected', 'Jarvis will speak through your Deepgram account.');
      void warmVoiceEngine('deepgram');
    } finally {
      setDeepgramTesting(false);
    }
  }

  async function saveSystemOpenAIKey() {
    const trimmed = systemOpenAIDraft.trim();
    if (!trimmed) {
      toast.warning('Enter your OpenAI API key first.');
      return;
    }
    await setVoiceApiKey('openai_voice', trimmed);
    setSystemOpenAIConfigured(true);
    setSystemOpenAIDraft('');
    toast.success('OpenAI key saved', 'Stored in the OS keychain — never synced or logged.');
  }

  async function saveSystemDeepgramKey() {
    const trimmed = systemDeepgramInputRef.current?.value.trim() ?? '';
    if (!trimmed) {
      toast.warning('Enter your Deepgram API key first.');
      return;
    }
    setDeepgramTesting(true);
    try {
      const result = await saveDeepgramCredential(trimmed);
      if (result.health !== 'connected') {
        toast.error('Deepgram test failed', 'Check the key and try again.');
        return;
      }
      setDeepgramConfigured(true);
      if (systemDeepgramInputRef.current) systemDeepgramInputRef.current.value = '';
      setHasSystemDeepgramDraft(false);
      toast.success('Deepgram connected', 'Stored in the OS keychain — never synced or logged.');
    } finally {
      setDeepgramTesting(false);
    }
  }

  async function previewVoice(nextVoice: VoicePresetId, engine: VoiceEngine = voiceEngine) {
    const seq = ++previewSeqRef.current;
    setPreviewingVoice(nextVoice);
    try {
      await previewVoiceWithSettings(nextVoice, engine);
    } catch {
      if (previewSeqRef.current !== seq) return;
      toast.error('Voice preview failed', formatVoicePreviewFailure(engine));
    } finally {
      if (previewSeqRef.current === seq) {
        setPreviewingVoice(null);
      }
    }
  }

  async function checkLocalVoices(showToast = true) {
    if (!isSpeechSynthesisSupported()) {
      setLocalVoiceStatus('unsupported');
      setLocalVoiceNames([]);
      if (showToast) {
        toast.warning(
          'Local voice unavailable',
          formatVoiceSettingsFailure('local_voice_unavailable'),
        );
      }
      return;
    }

    setLocalVoiceStatus('checking');
    try {
      const voices = await getInstalledSpeechVoices('local');
      setLocalVoiceNames(voices.map((voice) => voice.name));
      setLocalVoiceStatus(voices.length > 0 ? 'ready' : 'missing');
      if (!showToast) return;
      if (voices.length > 0) {
        toast.success(
          'Local voice ready',
          `${voices.length} installed voice${voices.length === 1 ? '' : 's'} detected.`,
        );
      } else {
        toast.warning(
          'No local voice detected',
          'Install a Windows speech voice pack, then check again.',
        );
      }
    } catch {
      setLocalVoiceStatus('missing');
      setLocalVoiceNames([]);
      if (showToast) {
        toast.error(
          'Local voice check failed',
          formatVoiceSettingsFailure('installed_voice_inspection'),
        );
      }
    }
  }

  function chooseVoiceEngine(engine: VoiceEngine) {
    if (engine === 'system' && !canUseSystemVoice) {
      toast.info(
        'System voice requires a paid plan',
        'Jarvis High and the local fallback stay available on Spark.',
      );
      return;
    }
    previewSeqRef.current += 1;
    setPreviewingVoice(null);
    cancelVoicePreview();
    setVoiceEngine(engine);
    void warmVoiceEngine(engine);
    void previewVoice(voicePreset, engine);
    if (engine === 'local') void checkLocalVoices(false);
    if (engine === 'jarvis') void downloadJarvisVoice();
    if (engine === 'deepgram') {
      try {
        window.localStorage.setItem('jarvis.voice.cloudProvider', 'deepgram_tts');
      } catch {
        /* ignore */
      }
    }
  }

  async function downloadJarvisVoice() {
    setJarvisError(null);
    const ready = await ModelManager.status();
    if (ready.ready) {
      setJarvisStatus('ready');
      return;
    }
    setJarvisStatus('downloading');
    setJarvisPercent(0);
    const ok = await ModelManager.ensureJarvisReady((p) =>
      setJarvisPercent(Math.max(0, Math.min(100, Math.round(p.percent)))),
    );
    const status = await ModelManager.status();
    if (ok && status.ready) {
      setJarvisStatus('ready');
      void warmVoiceEngine('jarvis');
    } else if (ok && !status.ready) {
      setJarvisStatus('error');
      setJarvisError(
        'Model downloaded, but the Piper runtime is not available in this build. Using the operating-system fallback.',
      );
    } else {
      setJarvisStatus('error');
      setJarvisError('Download failed. Check your connection and try again.');
    }
  }

  async function testJarvisVoice() {
    setJarvisError(null);
    setJarvisStatus('testing');
    try {
      cancelVoicePreview();
      await previewVoiceWithSettings(voicePreset, 'jarvis');
      setJarvisStatus('ready');
      toast.success('Jarvis High voice', 'Played the bundled offline Jarvis preview.');
    } catch {
      setJarvisStatus('error');
      const message = formatVoiceSettingsFailure('jarvis_test');
      setJarvisError(message);
      toast.error('Jarvis High test failed', message);
    }
  }

  async function installLocalVoice() {
    try {
      await openSystemSpeechSettings();
      setLocalVoiceStatus('idle');
      toast.info(
        'Windows Speech settings opened',
        'Add a voice package, then return to Jarvis and check local voices.',
      );
    } catch {
      toast.warning(
        'Open speech settings manually',
        formatVoiceSettingsFailure('windows_speech_settings'),
      );
    }
  }

  return (
    <div className="mc7f-settings-voice flex max-w-4xl flex-col gap-8 [html[data-theme=monochrome]_&]:border-l-2 [html[data-theme=monochrome]_&]:border-l-foreground/20 [html[data-theme=monochrome]_&]:pl-4 [html[data-theme=monochrome]_&_*]:rounded-none [html[data-theme=monochrome]_&_*]:bg-none [html[data-theme=monochrome]_&_*]:shadow-none [html[data-theme=monochrome]_&_*]:!animate-none [html[data-theme=monochrome]_&_*]:!blur-none [html[data-theme=monochrome]_&_*]:backdrop-blur-none [html[data-theme=monochrome]_&_*]:transition-none [html[data-theme=monochrome]_&_*]:focus-visible:outline [html[data-theme=monochrome]_&_*]:focus-visible:outline-2 [html[data-theme=monochrome]_&_*]:focus-visible:outline-offset-2 [html[data-theme=monochrome]_&_*]:focus-visible:outline-ring motion-reduce:[&_*]:!animate-none motion-reduce:[&_*]:transition-none">
      <header className="space-y-1">
        <h2 className="text-page-title text-foreground">Voice</h2>
        <p className="text-secondary text-muted-foreground">
          Spoken voice, persona, wake word, and microphone.
        </p>
      </header>

      <section className="flex flex-col gap-4">
        <div>
          <Label>Jarvis voice</Label>
          <p className="mt-1 text-metadata text-muted-foreground">
            Two local personas — Jarvis and Friday. Jarvis uses the default Jarvis High Piper model;
            Friday uses an installed operating-system voice. Neither requires an API key. Premium
            cloud voices remain explicit opt-ins.
          </p>
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {FREE_VOICE_PRESETS.map((profile) => (
            <VoiceCard
              key={profile.id}
              profile={profile}
              selected={voicePreset === profile.id}
              onSelect={() => {
                setVoicePreset(profile.id);
                void previewVoice(profile.id);
              }}
              onPreview={() => void previewVoice(profile.id)}
              previewing={previewingVoice === profile.id}
            />
          ))}
        </div>

        <div className="flex items-start justify-between gap-4 rounded-md border border-border bg-panel p-4">
          <div className="flex flex-col gap-1">
            <Label htmlFor="speak-replies-toggle">Speak Jarvis replies</Label>
            <p className="text-metadata text-muted-foreground">
              Also read completed replies aloud when you send messages from the chat composer. The
              voice panel always speaks replies while it is open.
            </p>
          </div>
          <Switch
            id="speak-replies-toggle"
            checked={speakReplies}
            onCheckedChange={setSpeakReplies}
          />
        </div>
        <div className="flex flex-col gap-4">
          <div>
            <Label>Conversation mode</Label>
            <p className="mt-1 text-metadata text-muted-foreground">
              Choose whether Jarvis listens continuously or waits for you to tap the symbiote orb.
            </p>
          </div>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <VoiceConversationModeCard
              selected={voiceAutoListenOnOpen}
              title="Hands-free"
              description={`Speak your message, then say "${voiceCommitPhrase}" to send.`}
              onSelect={() => setVoiceAutoListenOnOpen(true)}
            />
            <VoiceConversationModeCard
              selected={!voiceAutoListenOnOpen}
              title="Click to talk"
              description="Tap the symbiote orb each time you want Jarvis to hear you."
              onSelect={() => setVoiceAutoListenOnOpen(false)}
            />
          </div>
          {voiceAutoListenOnOpen ? (
            <div className="flex flex-col gap-4 rounded-md border border-border bg-panel p-4">
              <div>
                <Label htmlFor="voice-commit-phrase">Send phrase</Label>
                <p className="mt-1 text-metadata text-muted-foreground">
                  Say this when your message is ready. Jarvis will not send until he hears it.
                </p>
                <Input
                  id="voice-commit-phrase"
                  value={voiceCommitPhrase}
                  onChange={(event) => setVoiceCommitPhrase(event.target.value)}
                  placeholder="send it"
                  maxLength={VOICE_COMMIT_PHRASE_MAX_LEN}
                  className="mt-2"
                />
                <p className="mt-1 text-[10px] text-muted-foreground">
                  {VOICE_COMMIT_PHRASE_MIN_LEN}–{VOICE_COMMIT_PHRASE_MAX_LEN} characters.
                </p>
              </div>
              <div>
                <Label htmlFor="voice-cancel-phrase">Cancel phrase</Label>
                <p className="mt-1 text-metadata text-muted-foreground">
                  Say this to discard what you were saying without sending.
                </p>
                <Input
                  id="voice-cancel-phrase"
                  value={voiceCancelPhrase}
                  onChange={(event) => setVoiceCancelPhrase(event.target.value)}
                  placeholder="cancel"
                  maxLength={VOICE_COMMIT_PHRASE_MAX_LEN}
                  className="mt-2"
                />
              </div>
              <div>
                <Label>End message with</Label>
                <p className="mt-1 text-metadata text-muted-foreground">
                  Choose explicit submission or one silence duration.
                </p>
                <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <VoiceConversationModeCard
                    selected={voiceEndTrigger === 'phrase'}
                    title="Say a phrase"
                    description={`Send only after "${voiceCommitPhrase}".`}
                    onSelect={() => setVoiceEndTrigger('phrase')}
                  />
                  <VoiceConversationModeCard
                    selected={voiceEndTrigger === 'silence'}
                    title="Pause (silence)"
                    description="Send after you stop talking for a few seconds."
                    onSelect={() => setVoiceEndTrigger('silence')}
                  />
                </div>
                {voiceEndTrigger === 'phrase' ? (
                  <p className="mt-3 text-metadata text-sage">
                    No timeout — Jarvis keeps listening until you say "{voiceCommitPhrase}".
                  </p>
                ) : null}
              </div>
            </div>
          ) : null}
          {!voiceAutoListenOnOpen || voiceEndTrigger === 'silence' ? (
            <div className="rounded-md border border-border bg-panel p-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <Label htmlFor="voice-silence-delay">
                  {voiceAutoListenOnOpen ? 'Silence duration' : 'Pause before sending'}
                </Label>
                <span className="text-metadata font-medium text-foreground">
                  {voiceSilenceDelayLabel(voiceSilenceDelayMs)}
                </span>
              </div>
              <p className="mt-1 text-metadata text-muted-foreground">
                {voiceAutoListenOnOpen
                  ? 'Jarvis sends after this much silence. This is the only timer used in pause mode.'
                  : 'Jarvis sends after you stop speaking for this duration.'}
              </p>
              <input
                id="voice-silence-delay"
                type="range"
                min={VOICE_SILENCE_DELAY_MS_MIN}
                max={VOICE_SILENCE_DELAY_MS_MAX}
                step={1000}
                value={voiceSilenceDelayMs}
                onChange={(event) => setVoiceSilenceDelayMs(Number(event.target.value))}
                className="mt-3 w-full accent-[hsl(var(--accent-cyan))]"
              />
              <div className="mt-1 flex justify-between text-[10px] text-muted-foreground">
                <span>{voiceSilenceDelayLabel(VOICE_SILENCE_DELAY_MS_MIN)}</span>
                <span>{voiceSilenceDelayLabel(VOICE_SILENCE_DELAY_MS_MAX)}</span>
              </div>
            </div>
          ) : null}
          <div className="flex items-center justify-between gap-4 rounded-md border border-border bg-panel p-4">
            <div className="min-w-0">
              <Label htmlFor="voice-auto-approve-toggle">Auto-run command voice</Label>
              <p className="mt-1 text-metadata text-muted-foreground">
                When on, voice requests like “open five terminals” run immediately without Approve
                cards.
              </p>
            </div>
            <Switch
              id="voice-auto-approve-toggle"
              checked={voiceAutoApproveActions}
              onCheckedChange={setVoiceAutoApproveActions}
            />
          </div>
          <div className="flex items-center justify-between gap-4 rounded-md border border-border bg-panel p-4">
            <div className="min-w-0">
              <Label htmlFor="chat-auto-approve-toggle">Auto-run Jarvis command chat</Label>
              <p className="mt-1 text-metadata text-muted-foreground">
                Same for typed chat. Toggle quickly with {renderHotkey(HOTKEYS.JARVIS_BUBBLE)} while
                chatting.
              </p>
            </div>
            <Switch
              id="chat-auto-approve-toggle"
              checked={jarvisAutoApprove}
              onCheckedChange={setJarvisAutoApprove}
            />
          </div>
        </div>
      </section>

      <section className="flex flex-col gap-4">
        <div>
          <Label>Voice engine</Label>
          <p className="mt-1 text-metadata text-muted-foreground">
            Jarvis High is the default offline voice. OS local fallback uses only voices installed
            on this device.
          </p>
        </div>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
          <VoiceEngineCard
            engine="system"
            selected={voiceEngine === 'system'}
            title="System"
            description={
              subscriptionIncluded
                ? 'Cloud voice · included with your plan'
                : canUseSystemVoice
                  ? 'Cloud voice · your OpenAI/Deepgram key'
                  : 'Paid plan required (Orbit+)'
            }
            icon={<Cloud className="h-4 w-4" />}
            disabled={!canUseSystemVoice}
            onSelect={() => chooseVoiceEngine('system')}
          />
          <VoiceEngineCard
            engine="local"
            selected={voiceEngine === 'local'}
            title="OS local fallback"
            description="Installed operating-system voices only"
            icon={<HardDrive className="h-4 w-4" />}
            onSelect={() => chooseVoiceEngine('local')}
          />
          <VoiceEngineCard
            engine="jarvis"
            selected={voiceEngine === 'jarvis'}
            title="Jarvis High"
            description="Default offline Piper voice"
            icon={<AudioLines className="h-4 w-4" />}
            onSelect={() => chooseVoiceEngine('jarvis')}
          />
          <VoiceEngineCard
            engine="deepgram"
            selected={voiceEngine === 'deepgram'}
            title="Deepgram"
            description={
              deepgramConfigured ? 'Your API key · Aura voices' : 'Paste your Deepgram key'
            }
            icon={<Cloud className="h-4 w-4" />}
            onSelect={() => chooseVoiceEngine('deepgram')}
          />
        </div>
        {voiceEngine === 'system' ? (
          <div className="rounded-md border border-border bg-panel p-4 flex flex-col gap-3">
            {subscriptionIncluded ? (
              <p className="text-metadata text-foreground">
                <Cloud className="inline h-3.5 w-3.5 mr-1 text-accent-cyan" aria-hidden />
                Cloud voice usage is included with your subscription. Adding your own keys below is
                optional — they take priority and never count against your plan.
              </p>
            ) : (
              <p className="text-metadata text-muted-foreground">
                Bring your own OpenAI or Deepgram key for cloud voice. Keys stay in the OS keychain
                — never in cloud sync or chat logs.
              </p>
            )}
            <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
              <Input
                ref={systemDeepgramInputRef}
                type="password"
                className="font-mono w-full sm:min-w-[240px] sm:flex-1"
                placeholder={
                  systemOpenAIConfigured ? 'OpenAI key saved — paste to replace' : 'OpenAI API key'
                }
                value={systemOpenAIDraft}
                onChange={(event) => setSystemOpenAIDraft(event.target.value)}
                autoComplete="off"
              />
              <Button type="button" size="sm" onClick={() => void saveSystemOpenAIKey()}>
                {systemOpenAIConfigured ? 'Update OpenAI key' : 'Save OpenAI key'}
              </Button>
            </div>
            <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
              <Input
                type="password"
                className="font-mono w-full sm:min-w-[240px] sm:flex-1"
                placeholder={
                  deepgramConfigured ? 'Deepgram key saved — paste to replace' : 'Deepgram API key'
                }
                onChange={(event) =>
                  setHasSystemDeepgramDraft(Boolean(event.currentTarget.value.trim()))
                }
                autoComplete="off"
                data-jarvis-api-key="true"
              />
              <Button
                type="button"
                size="sm"
                disabled={deepgramTesting || !hasSystemDeepgramDraft}
                onClick={() => void saveSystemDeepgramKey()}
              >
                {deepgramTesting
                  ? 'Testing…'
                  : deepgramConfigured
                    ? 'Update & test'
                    : 'Connect Deepgram'}
              </Button>
            </div>
          </div>
        ) : null}
        {voiceEngine === 'deepgram' ? (
          <div className="rounded-md border border-border bg-panel p-4 flex flex-col gap-3">
            <p className="text-metadata text-muted-foreground">
              Uses your Deepgram credits directly. Keys stay in the OS keychain — never in cloud
              sync or chat logs.
            </p>
            <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
              <Input
                ref={deepgramInputRef}
                type="password"
                className="font-mono w-full sm:min-w-[240px] sm:flex-1"
                placeholder={deepgramConfigured ? 'Saved — paste to replace' : 'Deepgram API key'}
                onChange={(event) => setHasDeepgramDraft(Boolean(event.currentTarget.value.trim()))}
                autoComplete="off"
                data-jarvis-api-key="true"
              />
              <Button
                type="button"
                size="sm"
                disabled={deepgramTesting || !hasDeepgramDraft}
                onClick={() => void saveDeepgramKey()}
              >
                {deepgramTesting ? 'Testing…' : deepgramConfigured ? 'Update & test' : 'Connect'}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="secondary"
                onClick={() => void previewVoice(voicePreset, 'deepgram')}
              >
                <Play className="h-3.5 w-3.5" />
                Preview
              </Button>
            </div>
            <a
              className="text-metadata text-accent-copper hover:underline w-fit"
              href="https://console.deepgram.com/project/default/keys"
              target="_blank"
              rel="noreferrer"
            >
              Open Deepgram API keys
            </a>
          </div>
        ) : null}
        {voiceEngine === 'local' ? (
          <div className="rounded-md border border-border bg-panel p-4">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex flex-wrap items-center gap-2">
                <LocalVoiceStatusBadge status={localVoiceStatus} />
                {localVoiceStatus === 'ready' ? (
                  <span className="text-metadata text-muted-foreground">
                    {localVoiceNames.length} installed voice
                    {localVoiceNames.length === 1 ? '' : 's'}
                  </span>
                ) : null}
              </div>
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => void installLocalVoice()}
                >
                  <Download className="h-3.5 w-3.5" />
                  Install voice pack
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={() => void checkLocalVoices()}
                  disabled={localVoiceStatus === 'checking'}
                >
                  <RefreshCw
                    className={cn('h-3.5 w-3.5', localVoiceStatus === 'checking' && 'animate-spin')}
                  />
                  Check local voices
                </Button>
              </div>
            </div>
            {localVoiceStatus === 'missing' ? (
              <p className="mt-2 text-metadata text-muted-foreground">
                Install an English voice under Windows Settings, Time &amp; language, Speech, then
                check again.
              </p>
            ) : null}
            {localVoiceNames.length > 0 ? (
              <p
                className="mt-2 truncate text-metadata text-muted-foreground"
                title={localVoiceNames.join(', ')}
              >
                {localVoiceNames.join(', ')}
              </p>
            ) : null}
          </div>
        ) : null}
        {voiceEngine === 'jarvis' ? (
          <div className="rounded-md border border-border bg-panel p-4">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex flex-wrap items-center gap-2">
                <JarvisVoiceStatusBadge status={jarvisStatus} percent={jarvisPercent} />
                <span className="text-metadata text-muted-foreground">
                  Jarvis High · {formatJarvisModelSize()} · downloads once on first use
                </span>
              </div>
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => void downloadJarvisVoice()}
                  disabled={jarvisStatus === 'downloading' || jarvisStatus === 'ready'}
                >
                  <Download
                    className={cn('h-3.5 w-3.5', jarvisStatus === 'downloading' && 'animate-pulse')}
                  />
                  {jarvisStatus === 'ready'
                    ? 'Downloaded'
                    : jarvisStatus === 'downloading'
                      ? `Downloading ${jarvisPercent}%`
                      : 'Download model'}
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={() => void testJarvisVoice()}
                  disabled={jarvisStatus === 'downloading' || jarvisStatus === 'testing'}
                >
                  <Play
                    className={cn('h-3.5 w-3.5', jarvisStatus === 'testing' && 'animate-pulse')}
                  />
                  Test Jarvis High voice
                </Button>
              </div>
            </div>
            {jarvisError ? (
              <p className="mt-2 text-metadata text-warning">{jarvisError}</p>
            ) : (
              <p className="mt-2 text-metadata text-muted-foreground">
                If Jarvis High is unavailable, VibeSpace automatically uses the operating-system
                local voice fallback. Model by{' '}
                <a
                  className="underline underline-offset-2 hover:text-foreground"
                  href={JARVIS_HIGH_SOURCE_URL}
                  target="_blank"
                  rel="noreferrer"
                >
                  Jack Kawell on Hugging Face
                </a>
                .
              </p>
            )}
          </div>
        ) : null}
      </section>

      <Separator />

      <section className="flex flex-col gap-4">
        <div>
          <Label>Persona</Label>
          <p className="mt-1 text-metadata text-muted-foreground">
            Controls Jarvis&apos;s conversational style and instructions, independently from the
            spoken voice.
          </p>
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {PERSONAS.map((p) => (
            <PersonaCard
              key={p.id}
              persona={p}
              selected={persona === p.id}
              onSelect={() => setPersona(p.id)}
            />
          ))}
        </div>
      </section>

      <Separator />

      <section className="flex flex-col gap-4">
        <div className="flex items-start justify-between gap-4 rounded-md border border-border bg-panel p-4">
          <div className="flex flex-col gap-1">
            <Label htmlFor="wake-word-toggle">Wake word</Label>
            <p className="text-metadata text-muted-foreground">
              Listen for "Jarvis", "Hey Jarvis", and similar phrases when Web Speech is available. A
              small wake bubble appears while enabled.
            </p>
          </div>
          <Switch id="wake-word-toggle" checked={wakeWord} onCheckedChange={toggleWake} />
        </div>
      </section>

      <Separator />

      <MicrophoneTestPanel />
    </div>
  );
}

interface PersonaCardProps {
  persona: (typeof PERSONAS)[number];
  selected: boolean;
  onSelect: () => void;
}

function PersonaCard({ persona, selected, onSelect }: PersonaCardProps) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      data-monochrome-control-size="preserve"
      className={cn(
        'group relative flex min-h-[92px] flex-col items-start gap-1 rounded-md border bg-panel p-3 text-left transition-colors',
        'hover:bg-elevated focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
        selected
          ? 'border-accent-cyan/50 shadow-[0_0_0_1px_hsl(var(--accent-cyan)/0.4)]'
          : 'border-border',
      )}
    >
      {selected && (
        <Check className="absolute right-2 top-2 h-3.5 w-3.5 text-accent-cyan" strokeWidth={3} />
      )}
      <span
        className={cn(
          'text-ui-strong [html[data-theme=monochrome]_&]:!bg-none [html[data-theme=monochrome]_&]:!text-foreground [html[data-theme=monochrome]_&]:![-webkit-text-fill-color:currentColor]',
          selected ? 'text-accent-gradient' : 'text-foreground',
        )}
      >
        {persona.name}
      </span>
      <span className="text-metadata text-muted-foreground line-clamp-2">{persona.tone}</span>
    </button>
  );
}

interface VoiceCardProps {
  profile: VoiceProfile;
  selected: boolean;
  onSelect: () => void;
  onPreview: () => void;
  previewing: boolean;
}

/** Tiny animated bars shown while a voice preview is playing. */
function VoiceSpeakingBars() {
  const delays = ['0ms', '120ms', '240ms', '360ms'];
  return (
    <span className="inline-flex h-3 w-3.5 items-end justify-center gap-[1.5px]" aria-hidden>
      {delays.map((delay) => (
        <span
          key={delay}
          className="h-full w-[2px] origin-bottom scale-y-[0.25] rounded-full bg-current animate-voice-bar"
          style={{ animationDelay: delay }}
        />
      ))}
    </span>
  );
}

function VoiceCard({ profile, selected, onSelect, onPreview, previewing }: VoiceCardProps) {
  return (
    <div
      className={cn(
        'group relative rounded-md border bg-panel text-left transition-colors',
        'hover:bg-elevated focus-within:ring-1 focus-within:ring-ring',
        selected
          ? 'border-accent-cyan/50 shadow-[0_0_0_1px_hsl(var(--accent-cyan)/0.4)]'
          : 'border-border',
      )}
    >
      {selected ? (
        <Check className="absolute right-2 top-2 h-3.5 w-3.5 text-accent-cyan" strokeWidth={3} />
      ) : null}
      <button
        type="button"
        onClick={onSelect}
        aria-pressed={selected}
        data-monochrome-control-size="preserve"
        className="flex min-h-[92px] w-full flex-col items-start gap-1 rounded-md px-3 pb-1 pt-3 text-left focus-visible:outline-none"
      >
        <span
          className={cn(
            'text-ui-strong [html[data-theme=monochrome]_&]:!bg-none [html[data-theme=monochrome]_&]:!text-foreground [html[data-theme=monochrome]_&]:![-webkit-text-fill-color:currentColor]',
            selected ? 'text-accent-gradient' : 'text-foreground',
          )}
        >
          {profile.name}
        </span>
        <span className="text-metadata text-muted-foreground line-clamp-2">
          {profile.description}
        </span>
        <span className="mt-auto text-metadata font-medium text-foreground/70">
          {profile.bestFor}
        </span>
      </button>
      <button
        type="button"
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          onPreview();
        }}
        className={cn(
          'mx-3 mb-3 mt-2 inline-flex items-center gap-1 rounded-full border px-2 py-1 text-metadata font-medium transition-colors',
          'border-border/70 bg-background/70 text-muted-foreground hover:border-accent-cyan/40 hover:text-accent-cyan',
          'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
          previewing && 'border-accent-cyan/50 text-accent-cyan',
        )}
        aria-label={
          previewing ? `${profile.name} voice preview playing` : `Preview ${profile.name} voice`
        }
      >
        {previewing ? <VoiceSpeakingBars /> : <Play className="h-3 w-3" />}
        {previewing ? 'Playing' : 'Preview'}
      </button>
    </div>
  );
}

interface VoiceEngineCardProps {
  engine: VoiceEngine;
  selected: boolean;
  title: string;
  description: string;
  icon: ReactNode;
  disabled?: boolean;
  onSelect: () => void;
}

function VoiceConversationModeCard({
  selected,
  title,
  description,
  onSelect,
}: {
  selected: boolean;
  title: string;
  description: string;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      data-monochrome-control-size="preserve"
      className={cn(
        'relative flex min-h-[96px] flex-col items-start gap-1.5 rounded-md border bg-panel p-4 text-left transition-colors',
        'hover:bg-elevated focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
        selected
          ? 'border-accent-cyan/50 shadow-[0_0_0_1px_hsl(var(--accent-cyan)/0.35)]'
          : 'border-border',
      )}
    >
      {selected ? (
        <Check className="absolute right-2 top-2 h-3.5 w-3.5 text-accent-cyan" strokeWidth={3} />
      ) : null}
      <span
        className={cn(
          'text-ui-strong [html[data-theme=monochrome]_&]:!bg-none [html[data-theme=monochrome]_&]:!text-foreground [html[data-theme=monochrome]_&]:![-webkit-text-fill-color:currentColor]',
          selected ? 'text-accent-gradient' : 'text-foreground',
        )}
      >
        {title}
      </span>
      <span className="text-metadata text-muted-foreground">{description}</span>
    </button>
  );
}

function VoiceEngineCard({
  engine,
  selected,
  title,
  description,
  icon,
  disabled = false,
  onSelect,
}: VoiceEngineCardProps) {
  return (
    <button
      type="button"
      onClick={onSelect}
      disabled={disabled}
      aria-pressed={selected}
      data-engine={engine}
      data-monochrome-control-size="preserve"
      className={cn(
        'flex min-h-[96px] items-start gap-3 rounded-md border bg-panel p-4 text-left transition-colors',
        'hover:bg-elevated focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
        disabled && 'cursor-not-allowed opacity-60 hover:bg-panel',
        selected
          ? 'border-accent-cyan/50 shadow-[0_0_0_1px_hsl(var(--accent-cyan)/0.35)]'
          : 'border-border',
      )}
    >
      <span className={cn('mt-0.5 text-muted-foreground', selected && 'text-accent-cyan')}>
        {icon}
      </span>
      <span className="min-w-0">
        <span className="block text-ui-strong text-foreground">{title}</span>
        <span className="block text-metadata text-muted-foreground">{description}</span>
      </span>
    </button>
  );
}

function JarvisVoiceStatusBadge({
  status,
  percent,
}: {
  status: JarvisVoiceStatus;
  percent: number;
}) {
  const config: Record<
    JarvisVoiceStatus,
    { label: string; variant: 'outline' | 'success' | 'warning' }
  > = {
    idle: { label: 'Not downloaded', variant: 'outline' },
    downloading: { label: `Downloading ${percent}%`, variant: 'outline' },
    ready: { label: 'Ready', variant: 'success' },
    testing: { label: 'Testing', variant: 'outline' },
    error: { label: 'Unavailable', variant: 'warning' },
  };
  const item = config[status];
  return <Badge variant={item.variant}>{item.label}</Badge>;
}

export function formatJarvisModelSize(): string {
  const modelBytes =
    JARVIS_HIGH_MANIFEST.files.find((file) => file.name === 'jarvis-high.onnx')?.size_bytes ?? 0;
  return `${(modelBytes / 1024 / 1024).toFixed(2)} MiB`;
}

function LocalVoiceStatusBadge({ status }: { status: LocalVoiceStatus }) {
  const config: Record<
    LocalVoiceStatus,
    { label: string; variant: 'outline' | 'success' | 'warning' }
  > = {
    idle: { label: 'Not checked', variant: 'outline' },
    checking: { label: 'Checking', variant: 'outline' },
    ready: { label: 'Local ready', variant: 'success' },
    missing: { label: 'Install required', variant: 'warning' },
    unsupported: { label: 'Unsupported', variant: 'warning' },
  };
  const item = config[status];
  return <Badge variant={item.variant}>{item.label}</Badge>;
}

// Re-export so tests/consumers can import the persona type if they need it.
export type { PersonaPreset };
