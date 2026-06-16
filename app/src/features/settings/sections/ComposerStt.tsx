import { useCallback, useEffect, useState } from 'react';
import { Check, Download, HardDrive, Mic, RefreshCw, Sparkles } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { toast } from '@/components/ui/toast';
import { cn, isTauri } from '@/lib/utils';
import { openSystemSpeechSettings } from '@/lib/tauri';
import { useAuthStore } from '@/stores/auth';
import type { ComposerSttProvider, FasterWhisperModelId } from '@/types/common';
import {
  FASTER_WHISPER_MODELS,
  FasterWhisperManager,
  formatBytesShort,
  isSystemSttAvailable,
  type FasterWhisperDownloadProgress,
} from '@/features/composer-stt';

type DownloadUiState = 'idle' | 'downloading' | 'ready' | 'error';

export function ComposerStt() {
  const provider = useAuthStore((s) => s.composerSttProvider);
  const model = useAuthStore((s) => s.fasterWhisperModel);
  const setProvider = useAuthStore((s) => s.setComposerSttProvider);
  const setModel = useAuthStore((s) => s.setFasterWhisperModel);

  const [downloadState, setDownloadState] = useState<Record<FasterWhisperModelId, DownloadUiState>>({
    tiny: 'idle',
    small: 'idle',
    'large-v3': 'idle',
  });
  const [downloadPercent, setDownloadPercent] = useState<Record<FasterWhisperModelId, number>>({
    tiny: 0,
    small: 0,
    'large-v3': 0,
  });

  const refreshInstalled = useCallback(async () => {
    if (!isTauri) return;
    const next: Record<FasterWhisperModelId, DownloadUiState> = {
      tiny: 'idle',
      small: 'idle',
      'large-v3': 'idle',
    };
    await Promise.all(
      FASTER_WHISPER_MODELS.map(async (entry) => {
        const installed = await FasterWhisperManager.checkInstalled(entry.id);
        next[entry.id] = installed ? 'ready' : 'idle';
      }),
    );
    setDownloadState(next);
  }, []);

  useEffect(() => {
    void refreshInstalled();
  }, [refreshInstalled]);

  const downloadModel = async (modelId: FasterWhisperModelId) => {
    if (!isTauri) {
      toast.warning('Desktop required', 'Download local STT models in the VibeSpace desktop app.');
      return;
    }
    setDownloadState((s) => ({ ...s, [modelId]: 'downloading' }));
    setDownloadPercent((s) => ({ ...s, [modelId]: 0 }));
    const ok = await FasterWhisperManager.downloadModel(
      modelId,
      (progress: FasterWhisperDownloadProgress) => {
        setDownloadPercent((s) => ({ ...s, [modelId]: Math.round(progress.percent) }));
      },
    );
    if (ok) {
      setDownloadState((s) => ({ ...s, [modelId]: 'ready' }));
      toast.success('Model ready', `${modelId} is installed for offline dictation.`);
    } else {
      setDownloadState((s) => ({ ...s, [modelId]: 'error' }));
      toast.error('Download failed', `Could not download ${modelId}. Check your connection and try again.`);
    }
  };

  const chooseProvider = (next: ComposerSttProvider) => {
    setProvider(next);
    toast.success('Speech-to-text updated', next === 'system' ? 'Using free system dictation.' : 'Using local faster-whisper.');
  };

  return (
    <div className="flex max-w-2xl flex-col gap-6">
      <div>
        <h2 className="text-ui-strong text-foreground flex items-center gap-2">
          <Mic className="h-4 w-4 text-accent-cyan" />
          Speech to Text
        </h2>
        <p className="mt-1 text-secondary text-muted-foreground">
          Configure the composer microphone button for chat dictation. This does not affect Jarvis voice,
          wake word, or phone calls.
        </p>
      </div>

      <section className="flex flex-col gap-3">
        <Label>Provider</Label>
        <div className="grid gap-3 sm:grid-cols-2">
          <ProviderCard
            selected={provider === 'system'}
            title="Free / system"
            description="Built-in OS speech recognition. Always available when supported — Web Speech on macOS/Linux; Windows speech services in WebView2, with Win+H fallback on desktop."
            icon={<Sparkles className="h-4 w-4" />}
            onSelect={() => chooseProvider('system')}
          />
          <ProviderCard
            selected={provider === 'faster-whisper'}
            title="Local faster-whisper"
            description="Offline transcription with a downloaded model. Requires the desktop app and Python 3 for the first run."
            icon={<HardDrive className="h-4 w-4" />}
            onSelect={() => chooseProvider('faster-whisper')}
          />
        </div>
        {provider === 'system' ? (
          <p className="text-metadata text-muted-foreground">
            Status: {isSystemSttAvailable() ? 'Web Speech available in this runtime ✓' : 'Web Speech unavailable — Groq Whisper is used when a Groq key is configured.'}
            {isTauri ? (
              <>
                {' '}
                <button
                  type="button"
                  className="text-accent-cyan underline-offset-4 hover:underline"
                  onClick={() => void openSystemSpeechSettings().catch(() => {
                    toast.info('Speech settings', 'Open Windows Settings → Time & language → Speech.');
                  })}
                >
                  Open speech settings
                </button>
              </>
            ) : null}
          </p>
        ) : null}
      </section>

      {provider === 'faster-whisper' ? (
        <>
          <Separator />
          <section className="flex flex-col gap-3">
            <div className="flex items-center justify-between gap-2">
              <Label>Local model</Label>
              <Button variant="ghost" size="sm" onClick={() => void refreshInstalled()}>
                <RefreshCw className="h-3.5 w-3.5" />
                Refresh
              </Button>
            </div>
            {!isTauri ? (
              <p className="text-metadata text-warning">
                Local faster-whisper downloads require the VibeSpace desktop app.
              </p>
            ) : null}
            <div className="flex flex-col gap-2">
              {FASTER_WHISPER_MODELS.map((entry) => {
                const state = downloadState[entry.id];
                const percent = downloadPercent[entry.id];
                const selected = model === entry.id;
                return (
                  <div
                    key={entry.id}
                    className={cn(
                      'rounded-md border bg-panel p-3 transition-colors',
                      selected ? 'border-accent-cyan/50' : 'border-border',
                    )}
                  >
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <button
                        type="button"
                        className="min-w-0 flex-1 text-left"
                        onClick={() => setModel(entry.id)}
                      >
                        <div className="flex items-center gap-2">
                          <span className="text-ui-strong text-foreground">{entry.label}</span>
                          <span className="text-metadata text-muted-foreground">{entry.sizeLabel}</span>
                          {entry.recommended ? (
                            <Badge variant="outline" className="text-accent-cyan border-accent-cyan/40">
                              Recommended
                            </Badge>
                          ) : null}
                          {selected ? <Check className="h-3.5 w-3.5 text-accent-cyan" /> : null}
                        </div>
                        <p className="mt-0.5 text-metadata text-muted-foreground">{entry.description}</p>
                      </button>
                      <Button
                        variant="secondary"
                        size="sm"
                        disabled={!isTauri || state === 'downloading'}
                        onClick={() => void downloadModel(entry.id)}
                      >
                        <Download className={cn('h-3.5 w-3.5', state === 'downloading' && 'animate-pulse')} />
                        {state === 'ready'
                          ? 'Re-download'
                          : state === 'downloading'
                            ? `${percent}%`
                            : 'Download'}
                      </Button>
                    </div>
                    {state === 'ready' ? (
                      <p className="mt-2 text-metadata text-muted-foreground">
                        Installed ({formatBytesShort(entry.sizeBytes)} estimated)
                      </p>
                    ) : null}
                  </div>
                );
              })}
            </div>
            <p className="text-metadata text-muted-foreground">
              First transcription installs a small Python environment with faster-whisper (~1–2 min one-time).
              If the model is missing, dictation falls back to system speech.
            </p>
          </section>
        </>
      ) : null}
    </div>
  );
}

function ProviderCard({
  selected,
  title,
  description,
  icon,
  onSelect,
}: {
  selected: boolean;
  title: string;
  description: string;
  icon: React.ReactNode;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={cn(
        'relative flex min-h-[110px] flex-col items-start gap-2 rounded-md border bg-panel p-4 text-left transition-colors',
        'hover:bg-elevated focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
        selected
          ? 'border-accent-cyan/50 shadow-[0_0_0_1px_hsl(var(--accent-cyan)/0.35)]'
          : 'border-border',
      )}
    >
      {selected ? (
        <Check className="absolute right-2 top-2 h-3.5 w-3.5 text-accent-cyan" strokeWidth={3} />
      ) : null}
      <span className={cn('text-muted-foreground', selected && 'text-accent-cyan')}>{icon}</span>
      <span className={cn('text-ui-strong', selected ? 'text-accent-gradient' : 'text-foreground')}>
        {title}
      </span>
      <span className="text-metadata text-muted-foreground">{description}</span>
    </button>
  );
}
