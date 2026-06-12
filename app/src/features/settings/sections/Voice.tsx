import { useEffect, useState, type ReactNode } from 'react';
import {
  Mic,
  MicOff,
  AudioLines,
  Check,
  Cloud,
  Download,
  HardDrive,
  Play,
  RefreshCw,
  Volume2,
} from 'lucide-react';
import { useAuthStore } from '@/stores/auth';
import type { PersonaPreset, VoiceEngine, VoicePresetId } from '@/types/common';
import { PERSONAS } from '@/features/onboarding/steps/personas-data';
import { getInstalledSpeechVoices, isSpeechSynthesisSupported } from '@/features/voice/speechSynthesis';
import {
  previewVoiceWithSettings,
  stopAllVoiceOutput,
  warmVoiceEngine,
} from '@/features/voice/voiceRouter';
import { useAppAdmin } from '@/lib/admin';
import { effectivePlan, planAllowsVoiceWithAdmin } from '@/lib/entitlements';
import {
  getDeepgramVoiceKey,
  setVoiceApiKey,
} from '@/lib/security/voiceKeys';
import { testDeepgramVoiceKey } from '@/features/voice/providers/deepgramSpeak';
import { Input } from '@/components/ui/input';
import { VOICE_PROFILES, type VoiceProfile } from '@/features/voice/voiceProfiles';
import { ModelManager } from '@/features/voice/modelManager';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { Switch } from '@/components/ui/switch';
import { toast } from '@/components/ui/toast';
import { cn } from '@/lib/utils';
import { openSystemSpeechSettings } from '@/lib/tauri';
import { readWakeWordEnabled, setWakeWordEnabled } from '@/features/voice/wakeWord';
import {
  VOICE_SILENCE_DELAY_MS_MAX,
  VOICE_SILENCE_DELAY_MS_MIN,
  voiceSilenceDelayLabel,
} from '@/features/voice/voiceConversation';

type MicStatus = 'idle' | 'testing' | 'ok' | 'denied' | 'unavailable';
type LocalVoiceStatus = 'idle' | 'checking' | 'ready' | 'missing' | 'unsupported';
type KokoroStatus = 'idle' | 'downloading' | 'ready' | 'testing' | 'error';

/**
 * The two free local voice presets surfaced in Settings — Jarvis and Friday.
 * Derived from the shared VOICE_PROFILES list so selection/preview/persistence
 * stay intact; we just don't surface the extra technical profiles in the UI.
 */
const FREE_VOICE_PRESET_IDS: readonly VoicePresetId[] = ['jarvis-prime', 'aurora'];
const FREE_VOICE_PRESETS = VOICE_PROFILES.filter((p) => FREE_VOICE_PRESET_IDS.includes(p.id));

export function Voice() {
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
  const plan = useAuthStore((s) => s.plan);
  const admin = useAppAdmin();
  const activePlan = effectivePlan(plan, admin);
  const canUseSystemVoice = planAllowsVoiceWithAdmin(activePlan, admin);
  const [deepgramDraft, setDeepgramDraft] = useState('');
  const [deepgramConfigured, setDeepgramConfigured] = useState(false);
  const [deepgramTesting, setDeepgramTesting] = useState(false);
  const [previewingVoice, setPreviewingVoice] = useState<VoicePresetId | null>(null);
  const [localVoiceStatus, setLocalVoiceStatus] = useState<LocalVoiceStatus>('idle');
  const [localVoiceNames, setLocalVoiceNames] = useState<string[]>([]);
  const [kokoroStatus, setKokoroStatus] = useState<KokoroStatus>('idle');
  const [kokoroPercent, setKokoroPercent] = useState(0);
  const [kokoroError, setKokoroError] = useState<string | null>(null);

  const [wakeWord, setWakeWord] = useState<boolean>(() => readWakeWordEnabled());
  function toggleWake(v: boolean) {
    setWakeWord(v);
    setWakeWordEnabled(v);
  }

  const [micStatus, setMicStatus] = useState<MicStatus>('idle');

  useEffect(() => {
    void warmVoiceEngine(voiceEngine);
  }, [voiceEngine]);

  useEffect(() => {
    void getDeepgramVoiceKey().then((key) => setDeepgramConfigured(Boolean(key)));
  }, []);

  useEffect(() => {
    if (!canUseSystemVoice && voiceEngine === 'system') {
      setVoiceEngine('local');
    }
  }, [canUseSystemVoice, voiceEngine, setVoiceEngine]);

  async function testMic() {
    if (!navigator.mediaDevices?.getUserMedia) {
      setMicStatus('unavailable');
      toast.error('Microphone unavailable', 'No mediaDevices API in this runtime.');
      return;
    }
    setMicStatus('testing');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      // Immediately stop tracks - we only wanted to confirm permission.
      stream.getTracks().forEach((t) => t.stop());
      setMicStatus('ok');
      toast.success('Microphone ready', 'Permission granted and a track was opened.');
    } catch (err) {
      setMicStatus('denied');
      const reason = err instanceof Error ? err.message : 'Permission denied';
      toast.warning('Mic test failed', reason);
    }
  }

  async function saveDeepgramKey() {
    const trimmed = deepgramDraft.trim();
    if (!trimmed) {
      toast.warning('Enter your Deepgram API key first.');
      return;
    }
    setDeepgramTesting(true);
    try {
      const ok = await testDeepgramVoiceKey(trimmed);
      if (!ok) {
        toast.error('Deepgram test failed', 'Check the key and try again.');
        return;
      }
      await setVoiceApiKey('deepgram_voice', trimmed);
      setDeepgramConfigured(true);
      setDeepgramDraft('');
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

  async function previewVoice(nextVoice: VoicePresetId, engine: VoiceEngine = voiceEngine) {
    setPreviewingVoice(nextVoice);
    try {
      stopAllVoiceOutput();
      await previewVoiceWithSettings(nextVoice, engine);
    } catch (err) {
      toast.error(
        'Voice preview failed',
        err instanceof Error ? err.message : 'Could not play this voice.',
      );
    } finally {
      setPreviewingVoice((cur) => (cur === nextVoice ? null : cur));
    }
  }

  async function checkLocalVoices(showToast = true) {
    if (!isSpeechSynthesisSupported()) {
      setLocalVoiceStatus('unsupported');
      setLocalVoiceNames([]);
      if (showToast) {
        toast.warning(
          'Local voice unavailable',
          'Speech synthesis is not available in this runtime.',
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
    } catch (err) {
      setLocalVoiceStatus('missing');
      setLocalVoiceNames([]);
      if (showToast) {
        toast.error(
          'Local voice check failed',
          err instanceof Error ? err.message : 'Could not inspect installed voices.',
        );
      }
    }
  }

  function chooseVoiceEngine(engine: VoiceEngine) {
    if (engine === 'system' && !canUseSystemVoice) {
      toast.info('System voice requires a paid plan', 'Local and Kokoro stay available on Spark.');
      return;
    }
    stopAllVoiceOutput();
    setVoiceEngine(engine);
    void warmVoiceEngine(engine);
    void previewVoice(voicePreset, engine);
    if (engine === 'local') void checkLocalVoices(false);
    if (engine === 'kokoro') void downloadKokoro();
    if (engine === 'deepgram') {
      try {
        window.localStorage.setItem('jarvis.voice.cloudProvider', 'deepgram_tts');
      } catch {
        /* ignore */
      }
    }
  }

  async function downloadKokoro() {
    setKokoroError(null);
    const ready = await ModelManager.status();
    if (ready.ready) {
      setKokoroStatus('ready');
      return;
    }
    setKokoroStatus('downloading');
    setKokoroPercent(0);
    const ok = await ModelManager.ensureKokoroReady((p) =>
      setKokoroPercent(Math.max(0, Math.min(100, Math.round(p.percent)))),
    );
    const status = await ModelManager.status();
    if (ok && status.ready) {
      setKokoroStatus('ready');
      void warmVoiceEngine('kokoro');
    } else if (ok && !status.ready) {
      setKokoroStatus('error');
      setKokoroError(
        'Model downloaded, but the neural runtime is not available in this build. Using the Windows Natural voice.',
      );
    } else {
      setKokoroStatus('error');
      setKokoroError('Download failed. Check your connection and try again.');
    }
  }

  async function testKokoro() {
    setKokoroError(null);
    setKokoroStatus('testing');
    try {
      stopAllVoiceOutput();
      await previewVoiceWithSettings(voicePreset, 'kokoro');
      setKokoroStatus('ready');
      toast.success('Kokoro voice', 'Played the test phrase with the local neural voice.');
    } catch (err) {
      setKokoroStatus('error');
      const msg = err instanceof Error ? err.message : 'Kokoro synthesis failed.';
      setKokoroError(`${msg} The Windows Natural voice will be used instead.`);
      toast.error('Kokoro test failed', msg);
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
    } catch (err) {
      toast.warning(
        'Open speech settings manually',
        err instanceof Error ? err.message : 'Install a local system voice and check again.',
      );
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <header>
        <h2 className="text-page-title text-foreground">Voice</h2>
        <p className="text-secondary text-muted-foreground mt-1">
          Spoken voice, persona, wake word, and microphone.
        </p>
      </header>

      <section className="flex flex-col gap-3">
        <div>
          <Label>Jarvis voice</Label>
          <p className="mt-1 text-metadata text-muted-foreground">
            Two free local presets — Jarvis and Friday. Used for previews, wake acknowledgement,
            voice chat, and spoken replies. These voices use built-in system speech and do not
            require an API key. Premium cloud voices (OpenAI) unlock on a paid plan.
          </p>
        </div>
        <div className="grid grid-cols-2 gap-2">
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

        <div className="mt-1 flex max-w-xl items-start justify-between gap-4 rounded-md border border-border bg-panel p-3">
          <div className="flex flex-col gap-1">
            <Label htmlFor="speak-replies-toggle">Speak Jarvis replies</Label>
            <p className="text-metadata text-muted-foreground">
              Read completed replies aloud in normal typed and voice conversations.
            </p>
          </div>
          <Switch
            id="speak-replies-toggle"
            checked={speakReplies}
            onCheckedChange={setSpeakReplies}
          />
        </div>
        <div className="flex max-w-xl flex-col gap-3">
          <div>
            <Label>Conversation mode</Label>
            <p className="mt-1 text-metadata text-muted-foreground">
              Choose whether Jarvis listens continuously or waits for you to tap the symbiote orb.
            </p>
          </div>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <VoiceConversationModeCard
              selected={voiceAutoListenOnOpen}
              title="Hands-free"
              description="Open voice and just talk. Jarvis listens and replies after you pause."
              onSelect={() => setVoiceAutoListenOnOpen(true)}
            />
            <VoiceConversationModeCard
              selected={!voiceAutoListenOnOpen}
              title="Click to talk"
              description="Tap the symbiote orb each time you want Jarvis to hear you."
              onSelect={() => setVoiceAutoListenOnOpen(false)}
            />
          </div>
          <div className="rounded-md border border-border bg-panel p-3">
            <div className="flex items-center justify-between gap-3">
              <Label htmlFor="voice-silence-delay">Pause before Jarvis responds</Label>
              <span className="text-metadata font-medium text-foreground">
                {voiceSilenceDelayLabel(voiceSilenceDelayMs)}
              </span>
            </div>
            <p className="mt-1 text-metadata text-muted-foreground">
              How long you stay quiet after speaking before Jarvis sends your message.
            </p>
            <input
              id="voice-silence-delay"
              type="range"
              min={VOICE_SILENCE_DELAY_MS_MIN}
              max={VOICE_SILENCE_DELAY_MS_MAX}
              step={250}
              value={voiceSilenceDelayMs}
              onChange={(event) => setVoiceSilenceDelayMs(Number(event.target.value))}
              className="mt-3 w-full accent-[hsl(var(--accent-cyan))]"
            />
            <div className="mt-1 flex justify-between text-[10px] text-muted-foreground">
              <span>{voiceSilenceDelayLabel(VOICE_SILENCE_DELAY_MS_MIN)}</span>
              <span>{voiceSilenceDelayLabel(VOICE_SILENCE_DELAY_MS_MAX)}</span>
            </div>
          </div>
        </div>
      </section>

      <section className="flex flex-col gap-3">
        <div>
          <Label>Voice engine</Label>
          <p className="mt-1 text-metadata text-muted-foreground">
            System uses the best available voice. Local restricts playback to voices installed on
            this device.
          </p>
        </div>
        <div className="grid max-w-2xl grid-cols-2 gap-2 sm:grid-cols-4">
          <VoiceEngineCard
            engine="system"
            selected={voiceEngine === 'system'}
            title="System"
            description={
              canUseSystemVoice
                ? 'Best installed or enhanced voice'
                : 'Paid plan required (Orbit+)'
            }
            icon={<Volume2 className="h-4 w-4" />}
            disabled={!canUseSystemVoice}
            onSelect={() => chooseVoiceEngine('system')}
          />
          <VoiceEngineCard
            engine="local"
            selected={voiceEngine === 'local'}
            title="Local only"
            description="Never use an online speech voice"
            icon={<HardDrive className="h-4 w-4" />}
            onSelect={() => chooseVoiceEngine('local')}
          />
          <VoiceEngineCard
            engine="kokoro"
            selected={voiceEngine === 'kokoro'}
            title="Kokoro"
            description="Local neural voice (downloads once)"
            icon={<AudioLines className="h-4 w-4" />}
            onSelect={() => chooseVoiceEngine('kokoro')}
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
        {voiceEngine === 'deepgram' ? (
          <div className="max-w-xl rounded-md border border-border bg-panel p-3 flex flex-col gap-3">
            <p className="text-metadata text-muted-foreground">
              Uses your Deepgram credits directly. Keys stay in the OS keychain — never in cloud
              sync or chat logs.
            </p>
            <div className="flex flex-wrap gap-2">
              <Input
                type="password"
                className="font-mono flex-1 min-w-[200px]"
                placeholder={deepgramConfigured ? 'Saved — paste to replace' : 'Deepgram API key'}
                value={deepgramDraft}
                onChange={(event) => setDeepgramDraft(event.target.value)}
                autoComplete="off"
              />
              <Button
                type="button"
                size="sm"
                disabled={deepgramTesting}
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
          <div className="max-w-xl rounded-md border border-border bg-panel p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
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
        {voiceEngine === 'kokoro' ? (
          <div className="max-w-xl rounded-md border border-border bg-panel p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <KokoroStatusBadge status={kokoroStatus} percent={kokoroPercent} />
                <span className="text-metadata text-muted-foreground">
                  Kokoro-82M neural voice · ~82 MB · downloads once
                </span>
              </div>
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => void downloadKokoro()}
                  disabled={kokoroStatus === 'downloading' || kokoroStatus === 'ready'}
                >
                  <Download
                    className={cn('h-3.5 w-3.5', kokoroStatus === 'downloading' && 'animate-pulse')}
                  />
                  {kokoroStatus === 'ready'
                    ? 'Downloaded'
                    : kokoroStatus === 'downloading'
                      ? `Downloading ${kokoroPercent}%`
                      : 'Download model'}
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={() => void testKokoro()}
                  disabled={kokoroStatus === 'downloading' || kokoroStatus === 'testing'}
                >
                  <Play className={cn('h-3.5 w-3.5', kokoroStatus === 'testing' && 'animate-pulse')} />
                  Test Kokoro voice
                </Button>
              </div>
            </div>
            {kokoroError ? (
              <p className="mt-2 text-metadata text-warning">{kokoroError}</p>
            ) : (
              <p className="mt-2 text-metadata text-muted-foreground">
                If Kokoro is unavailable, Jarvis automatically falls back to the Windows Natural
                voice — it never blocks chat.
              </p>
            )}
          </div>
        ) : null}
      </section>

      <Separator />

      <section className="flex flex-col gap-3">
        <div>
          <Label>Persona</Label>
          <p className="mt-1 text-metadata text-muted-foreground">
            Controls Jarvis&apos;s conversational style and instructions, independently from the
            spoken voice.
          </p>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
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

      <section className="flex flex-col gap-3">
        <div className="flex items-start justify-between gap-3 max-w-md">
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

      <section className="flex flex-col gap-3">
        <Label>Microphone</Label>
        <div className="flex items-center gap-3">
          <Button
            variant="secondary"
            size="sm"
            onClick={testMic}
            disabled={micStatus === 'testing'}
          >
            <AudioLines className="h-3.5 w-3.5" />
            {micStatus === 'testing' ? 'Testing...' : 'Test microphone'}
          </Button>
          <MicStatusPill status={micStatus} />
        </div>
        <p className="text-metadata text-muted-foreground">
          Chat dictation uses free built-in speech recognition when available, or Groq Whisper when
          you connect a Groq key.
        </p>
      </section>
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
      <span className={cn('text-ui-strong', selected ? 'text-accent-gradient' : 'text-foreground')}>
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
        className="flex min-h-[92px] w-full flex-col items-start gap-1 rounded-md px-3 pb-1 pt-3 text-left focus-visible:outline-none"
      >
        <span
          className={cn('text-ui-strong', selected ? 'text-accent-gradient' : 'text-foreground')}
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
        aria-label={`Preview ${profile.name} voice`}
      >
        <Play className={cn('h-3 w-3', previewing && 'animate-pulse')} />
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
      className={cn(
        'relative flex min-h-[88px] flex-col items-start gap-1 rounded-md border bg-panel p-3 text-left transition-colors',
        'hover:bg-elevated focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
        selected
          ? 'border-accent-cyan/50 shadow-[0_0_0_1px_hsl(var(--accent-cyan)/0.35)]'
          : 'border-border',
      )}
    >
      {selected ? (
        <Check className="absolute right-2 top-2 h-3.5 w-3.5 text-accent-cyan" strokeWidth={3} />
      ) : null}
      <span className={cn('text-ui-strong', selected ? 'text-accent-gradient' : 'text-foreground')}>
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
      className={cn(
        'flex items-start gap-3 rounded-md border bg-panel p-3 text-left transition-colors',
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

function KokoroStatusBadge({ status, percent }: { status: KokoroStatus; percent: number }) {
  const config: Record<
    KokoroStatus,
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

function MicStatusPill({ status }: { status: MicStatus }) {
  if (status === 'idle') return null;
  const map: Record<Exclude<MicStatus, 'idle'>, { label: string; cls: string; icon: ReactNode }> = {
    testing: {
      label: 'Requesting...',
      cls: 'bg-info/10 text-info border-info/30',
      icon: <AudioLines className="h-3 w-3 animate-pulse" />,
    },
    ok: {
      label: 'OK',
      cls: 'bg-success/10 text-success border-success/30',
      icon: <Check className="h-3 w-3" />,
    },
    denied: {
      label: 'Denied',
      cls: 'bg-destructive/10 text-destructive border-destructive/30',
      icon: <MicOff className="h-3 w-3" />,
    },
    unavailable: {
      label: 'Unavailable',
      cls: 'bg-warning/10 text-warning border-warning/30',
      icon: <Mic className="h-3 w-3" />,
    },
  };
  const entry = map[status];
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-metadata font-medium',
        entry.cls,
      )}
    >
      {entry.icon}
      {entry.label}
    </span>
  );
}

// Re-export so tests/consumers can import the persona type if they need it.
export type { PersonaPreset };
