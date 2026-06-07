import { useState, type ReactNode } from 'react';
import {
  Mic,
  MicOff,
  AudioLines,
  Check,
  Download,
  HardDrive,
  Play,
  RefreshCw,
  Volume2,
} from 'lucide-react';
import { useAuthStore } from '@/stores/auth';
import type { PersonaPreset, VoiceEngine, VoicePresetId } from '@/types/common';
import { PERSONAS } from '@/features/onboarding/steps/personas-data';
import {
  getInstalledSpeechVoices,
  isSpeechSynthesisSupported,
  speakVoicePreview,
} from '@/features/voice/speechSynthesis';
import { VOICE_PROFILES, type VoiceProfile } from '@/features/voice/voiceProfiles';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { Switch } from '@/components/ui/switch';
import { toast } from '@/components/ui/toast';
import { cn } from '@/lib/utils';
import { openSystemSpeechSettings } from '@/lib/tauri';
import { readWakeWordEnabled, setWakeWordEnabled } from '@/features/voice/wakeWord';

type MicStatus = 'idle' | 'testing' | 'ok' | 'denied' | 'unavailable';
type LocalVoiceStatus = 'idle' | 'checking' | 'ready' | 'missing' | 'unsupported';

export function Voice() {
  const persona = useAuthStore((s) => s.personaPreset);
  const setPersona = useAuthStore((s) => s.setPersona);
  const voicePreset = useAuthStore((s) => s.voicePreset);
  const setVoicePreset = useAuthStore((s) => s.setVoicePreset);
  const voiceEngine = useAuthStore((s) => s.voiceEngine);
  const setVoiceEngine = useAuthStore((s) => s.setVoiceEngine);
  const speakReplies = useAuthStore((s) => s.speakReplies);
  const setSpeakReplies = useAuthStore((s) => s.setSpeakReplies);
  const [previewingVoice, setPreviewingVoice] = useState<VoicePresetId | null>(null);
  const [localVoiceStatus, setLocalVoiceStatus] = useState<LocalVoiceStatus>('idle');
  const [localVoiceNames, setLocalVoiceNames] = useState<string[]>([]);

  const [wakeWord, setWakeWord] = useState<boolean>(() => readWakeWordEnabled());
  function toggleWake(v: boolean) {
    setWakeWord(v);
    setWakeWordEnabled(v);
  }

  const [micStatus, setMicStatus] = useState<MicStatus>('idle');

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

  async function previewVoice(nextVoice: VoicePresetId) {
    if (!isSpeechSynthesisSupported()) {
      toast.warning(
        'Voice preview unavailable',
        'Speech synthesis is not available in this runtime.',
      );
      return;
    }
    setPreviewingVoice(nextVoice);
    try {
      await speakVoicePreview(nextVoice);
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
    setVoiceEngine(engine);
    if (engine === 'local') void checkLocalVoices(false);
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
            Used for previews, wake acknowledgement, voice chat, and spoken replies.
          </p>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
          {VOICE_PROFILES.map((profile) => (
            <VoiceCard
              key={profile.id}
              profile={profile}
              selected={voicePreset === profile.id}
              onSelect={() => setVoicePreset(profile.id)}
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
      </section>

      <section className="flex flex-col gap-3">
        <div>
          <Label>Voice engine</Label>
          <p className="mt-1 text-metadata text-muted-foreground">
            System uses the best available voice. Local restricts playback to voices installed on
            this device.
          </p>
        </div>
        <div className="grid max-w-xl grid-cols-2 gap-2">
          <VoiceEngineCard
            engine="system"
            selected={voiceEngine === 'system'}
            title="System"
            description="Best installed or enhanced voice"
            icon={<Volume2 className="h-4 w-4" />}
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
        </div>
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
  onSelect: () => void;
}

function VoiceEngineCard({
  engine,
  selected,
  title,
  description,
  icon,
  onSelect,
}: VoiceEngineCardProps) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      data-engine={engine}
      className={cn(
        'flex items-start gap-3 rounded-md border bg-panel p-3 text-left transition-colors',
        'hover:bg-elevated focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
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
