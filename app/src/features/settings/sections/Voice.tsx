import { useState, type ReactNode } from 'react';
import { Mic, MicOff, AudioLines, Check } from 'lucide-react';
import { useAuthStore } from '@/stores/auth';
import type { PersonaPreset } from '@/types/common';
import { PERSONAS } from '@/features/onboarding/steps/personas-data';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { Switch } from '@/components/ui/switch';
import { toast } from '@/components/ui/toast';
import { cn } from '@/lib/utils';
import { readWakeWordEnabled, setWakeWordEnabled } from '@/features/voice/wakeWord';

type MicStatus = 'idle' | 'testing' | 'ok' | 'denied' | 'unavailable';

export function Voice() {
  const persona = useAuthStore((s) => s.personaPreset);
  const setPersona = useAuthStore((s) => s.setPersona);

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

  return (
    <div className="flex flex-col gap-6">
      <header>
        <h2 className="text-page-title text-foreground">Voice</h2>
        <p className="text-secondary text-muted-foreground mt-1">
          Persona, wake word, and microphone.
        </p>
      </header>

      <section className="flex flex-col gap-3">
        <Label>Persona</Label>
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
              Listen for "Hey Jarvis" in the background when Web Speech is available. A small wake bubble appears while enabled.
            </p>
          </div>
          <Switch id="wake-word-toggle" checked={wakeWord} onCheckedChange={toggleWake} />
        </div>
      </section>

      <Separator />

      <section className="flex flex-col gap-3">
        <Label>Microphone</Label>
        <div className="flex items-center gap-3">
          <Button variant="secondary" size="sm" onClick={testMic} disabled={micStatus === 'testing'}>
            <AudioLines className="h-3.5 w-3.5" />
            {micStatus === 'testing' ? 'Testing...' : 'Test microphone'}
          </Button>
          <MicStatusPill status={micStatus} />
        </div>
        <p className="text-metadata text-muted-foreground">
          We open a track briefly to confirm permission, then release it.
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
        'group relative flex flex-col items-start gap-1 rounded-md border bg-panel p-3 text-left transition-colors',
        'hover:bg-elevated focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
        selected
          ? 'border-accent-cyan/50 shadow-[0_0_0_1px_hsl(var(--accent-cyan)/0.4)]'
          : 'border-border',
      )}
    >
      {selected && (
        <Check
          className="absolute right-2 top-2 h-3.5 w-3.5 text-accent-cyan"
          strokeWidth={3}
        />
      )}
      <span
        className={cn(
          'text-ui-strong',
          selected ? 'text-accent-gradient' : 'text-foreground',
        )}
      >
        {persona.name}
      </span>
      <span className="text-metadata text-muted-foreground line-clamp-2">
        {persona.tone}
      </span>
    </button>
  );
}

function MicStatusPill({ status }: { status: MicStatus }) {
  if (status === 'idle') return null;
  const map: Record<Exclude<MicStatus, 'idle'>, { label: string; cls: string; icon: ReactNode }> =
    {
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
