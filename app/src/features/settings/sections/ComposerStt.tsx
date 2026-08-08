import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Check,
  Cloud,
  Download,
  HardDrive,
  Mic,
  RefreshCw,
  Sparkles,
  Trash2,
  AlertCircle,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { toast } from '@/components/ui/toast';
import { cn, isTauri } from '@/lib/utils';
import { openSystemSpeechSettings } from '@/lib/tauri';
import { useAuthStore } from '@/stores/auth';
import type { ComposerSttProvider, FasterWhisperModelId } from '@/types/common';
import { DeepgramCredentialCard } from '../components/DeepgramCredentialCard';
import { DeepgramBrandMark, DeepgramModelMark } from '../components/DeepgramBrandMark';
import {
  DEEPGRAM_MODEL_SOURCE,
  DEEPGRAM_PRICE_LAST_UPDATED,
  DEEPGRAM_PRICE_SOURCE,
  DEEPGRAM_STT_OPTIONS,
  calculateDeepgramCost,
  deepgramHoursForBudget,
  deepgramPriceFreshnessFooter,
  getDeepgramSttOption,
  isDeepgramPriceStale,
  readDeepgramSttOption,
  writeDeepgramSttOption,
  type DeepgramSttOptionId,
} from '@/lib/deepgram';
import {
  LOCAL_STT_CATALOG,
  FasterWhisperManager,
  formatBytesShort,
  isSystemSttAvailable,
  localSttCatalogEntry,
  normalizeLocalSttCatalogId,
  placementLabel,
  toFasterWhisperModelId,
  type FasterWhisperDownloadProgress,
  type LocalSttCatalogId,
} from '@/features/composer-stt';

type DownloadUiState = 'idle' | 'downloading' | 'ready' | 'active' | 'error';

export function ComposerStt() {
  const provider = useAuthStore((s) => s.composerSttProvider);
  const model = useAuthStore((s) => s.fasterWhisperModel);
  const setProvider = useAuthStore((s) => s.setComposerSttProvider);
  const setModel = useAuthStore((s) => s.setFasterWhisperModel);
  const selectedCatalogId = normalizeLocalSttCatalogId(model);

  const downloadableIds = useMemo(
    () =>
      LOCAL_STT_CATALOG.filter((entry) => entry.placement === 'local-downloadable').map(
        (entry) => entry.id,
      ),
    [],
  );

  const [downloadState, setDownloadState] = useState<Record<string, DownloadUiState>>({});
  const [downloadPercent, setDownloadPercent] = useState<Record<string, number>>({});
  const [deepgramOptionId, setDeepgramOptionId] =
    useState<DeepgramSttOptionId>(readDeepgramSttOption);
  const [calculatorOptionId, setCalculatorOptionId] =
    useState<DeepgramSttOptionId>(readDeepgramSttOption);
  const [calculatorHours, setCalculatorHours] = useState(1);
  const calculatorCost = calculateDeepgramCost(calculatorOptionId, calculatorHours * 60);

  const refreshInstalled = useCallback(async () => {
    const next: Record<string, DownloadUiState> = {};
    if (!isTauri) {
      for (const id of downloadableIds) next[id] = 'idle';
      setDownloadState(next);
      return;
    }
    await Promise.all(
      downloadableIds.map(async (catalogId) => {
        const fwId = toFasterWhisperModelId(catalogId);
        if (!fwId) {
          next[catalogId] = 'idle';
          return;
        }
        const installed = await FasterWhisperManager.checkInstalled(fwId);
        next[catalogId] = installed
          ? provider === 'faster-whisper' && selectedCatalogId === catalogId
            ? 'active'
            : 'ready'
          : 'idle';
      }),
    );
    setDownloadState(next);
  }, [downloadableIds, provider, selectedCatalogId]);

  useEffect(() => {
    void refreshInstalled();
  }, [refreshInstalled]);

  const downloadModel = async (catalogId: LocalSttCatalogId) => {
    const fwId = toFasterWhisperModelId(catalogId);
    const entry = localSttCatalogEntry(catalogId);
    if (!fwId || !entry?.runnable) {
      toast.info(
        'Not downloadable here',
        entry?.description ?? 'This catalog entry is not wired to the local STT runtime yet.',
      );
      return;
    }
    if (!isTauri) {
      toast.warning('Desktop required', 'Download local STT models in the VibeSpace desktop app.');
      return;
    }
    setDownloadState((s) => ({ ...s, [catalogId]: 'downloading' }));
    setDownloadPercent((s) => ({ ...s, [catalogId]: 0 }));
    const ok = await FasterWhisperManager.downloadModel(
      fwId,
      (progress: FasterWhisperDownloadProgress) => {
        setDownloadPercent((s) => ({ ...s, [catalogId]: Math.round(progress.percent) }));
      },
    );
    if (ok) {
      setDownloadState((s) => ({
        ...s,
        [catalogId]:
          provider === 'faster-whisper' && selectedCatalogId === catalogId ? 'active' : 'ready',
      }));
      toast.success('Model ready', `${entry.label} is installed for offline dictation.`);
    } else {
      setDownloadState((s) => ({ ...s, [catalogId]: 'error' }));
      toast.error(
        'Download failed',
        `Could not download ${entry.label}. Check your connection and try again.`,
      );
    }
  };

  const removeModel = async (catalogId: LocalSttCatalogId) => {
    const fwId = toFasterWhisperModelId(catalogId);
    const entry = localSttCatalogEntry(catalogId);
    if (!fwId || !entry) return;
    if (!isTauri) {
      toast.warning('Desktop required', 'Remove local models in the VibeSpace desktop app.');
      return;
    }
    const ok = await FasterWhisperManager.removeModel(fwId);
    if (ok) {
      setDownloadState((s) => ({ ...s, [catalogId]: 'idle' }));
      toast.success('Model removed', `${entry.label} files were deleted from this device.`);
    } else {
      toast.error('Remove failed', `Could not remove ${entry.label}.`);
    }
  };

  const chooseProvider = (next: ComposerSttProvider) => {
    setProvider(next);
    if (next === 'system') {
      toast.success('Speech-to-text updated', 'Using free system dictation.');
    } else if (next === 'faster-whisper') {
      toast.success('Speech-to-text updated', 'Using local models when installed.');
    } else {
      toast.success(
        'Deepgram selected',
        'Choose a verified streaming model and connect one shared Deepgram key.',
      );
    }
  };

  const chooseLocalModel = (catalogId: LocalSttCatalogId) => {
    const entry = localSttCatalogEntry(catalogId);
    if (!entry) return;
    setModel(catalogId as FasterWhisperModelId);
    if (!entry.runnable) {
      toast.info(
        'Catalog only',
        entry.placement === 'cloud-or-advanced'
          ? 'This model is not a one-click local install in this build. See placement details below.'
          : 'Local runtime for this model is not wired yet. Free System or a downloadable Whisper pack still work for dictation.',
      );
      return;
    }
    if (provider !== 'faster-whisper') {
      setProvider('faster-whisper');
    }
    toast.success('Local model selected', entry.label);
  };

  return (
    <div className="mc7f-settings-composer-stt flex max-w-2xl flex-col gap-6 [html[data-theme=monochrome]_&]:border-l-2 [html[data-theme=monochrome]_&]:border-l-foreground/20 [html[data-theme=monochrome]_&]:pl-4 [html[data-theme=monochrome]_&_*]:rounded-none [html[data-theme=monochrome]_&_*]:bg-none [html[data-theme=monochrome]_&_*]:shadow-none [html[data-theme=monochrome]_&_*]:!animate-none [html[data-theme=monochrome]_&_*]:!blur-none [html[data-theme=monochrome]_&_*]:backdrop-blur-none [html[data-theme=monochrome]_&_*]:transition-none [html[data-theme=monochrome]_&_*]:focus-visible:outline [html[data-theme=monochrome]_&_*]:focus-visible:outline-2 [html[data-theme=monochrome]_&_*]:focus-visible:outline-offset-2 [html[data-theme=monochrome]_&_*]:focus-visible:outline-ring motion-reduce:[&_*]:!animate-none motion-reduce:[&_*]:transition-none">
      <header className="space-y-1">
        <h2 className="text-ui-strong text-foreground flex items-center gap-2">
          <Mic className="h-4 w-4 text-accent-cyan" />
          Speech to Text
        </h2>
        <p className="text-secondary text-muted-foreground">
          Composer microphone dictation only — not Jarvis voice, wake word, or phone calls.
        </p>
      </header>

      <section className="flex flex-col gap-3" aria-label="Speech-to-text provider">
        <Label className="text-sm font-medium text-foreground">How should dictation run?</Label>
        <div className="flex flex-col gap-2" role="radiogroup" aria-label="Speech-to-text provider">
          <ProviderRow
            selected={provider === 'system'}
            title="Free System"
            description="Built-in speech recognition when available. Groq Whisper is used only when a Groq key is configured. No comparable accuracy estimate is shown because quality varies by OS engine, browser, language, and microphone."
            meta={
              isSystemSttAvailable()
                ? 'Web Speech available'
                : 'Web Speech unavailable in this runtime'
            }
            icon={<Sparkles className="h-4 w-4" />}
            onSelect={() => chooseProvider('system')}
          />
          <ProviderRow
            selected={provider === 'faster-whisper'}
            title="Local"
            description="Offline models on this device. Download a Whisper pack below — Moonshine entries are cataloged until their runtime ships. No cross-model accuracy percentage is shown without a comparable benchmark for this exact runtime."
            meta={`${downloadableIds.length} downloadable · desktop app required`}
            icon={<HardDrive className="h-4 w-4" />}
            onSelect={() => chooseProvider('faster-whisper')}
          />
          <ProviderRow
            selected={provider === 'deepgram'}
            title="Deepgram"
            description="Paid cloud streaming with one secure key shared across every Deepgram surface."
            meta={getDeepgramSttOption(deepgramOptionId).label}
            icon={<DeepgramBrandMark className="h-5 w-5 rounded-md" />}
            onSelect={() => chooseProvider('deepgram')}
          />
        </div>

        {provider === 'system' && isTauri ? (
          <p className="text-metadata text-muted-foreground">
            <button
              type="button"
              className="text-accent-cyan underline-offset-4 hover:underline"
              onClick={() =>
                void openSystemSpeechSettings().catch(() => {
                  toast.info(
                    'Speech settings',
                    'Open Windows Settings → Time & language → Speech.',
                  );
                })
              }
            >
              Open system speech settings
            </button>
          </p>
        ) : null}

        {provider === 'deepgram' ? (
          <div className="flex flex-col gap-4">
            <DeepgramCredentialCard compact showUsage />

            <section aria-label="Deepgram speech-to-text models" className="space-y-3">
              <div>
                <Label className="text-sm font-medium text-foreground">Streaming model</Label>
                <p className="text-metadata text-muted-foreground">
                  Five verified choices. Price does not imply accuracy: Nova-3 is Deepgram's
                  highest-performing general-purpose ASR and is also its cheapest current public
                  streaming rate.
                </p>
              </div>
              <div className="grid gap-2" role="radiogroup" aria-label="Deepgram STT model">
                {DEEPGRAM_STT_OPTIONS.map((option) => {
                  const selected = deepgramOptionId === option.id;
                  return (
                    <button
                      key={option.id}
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      onClick={() => {
                        setDeepgramOptionId(option.id);
                        setCalculatorOptionId(option.id);
                        writeDeepgramSttOption(option.id);
                      }}
                      className={cn(
                        'rounded-xl border p-3 text-left transition-colors',
                        selected
                          ? 'border-accent-cyan/60 bg-accent-cyan/5'
                          : 'border-border/80 bg-panel/60 hover:bg-elevated/70',
                      )}
                    >
                      <span className="flex items-start gap-3">
                        <DeepgramModelMark id={option.id} label={option.label} />
                        <span className="min-w-0 flex-1">
                          <span className="flex flex-wrap items-center justify-between gap-2">
                            <span className="font-semibold text-foreground">{option.label}</span>
                            <span className="font-mono text-xs text-foreground">
                              ${option.priceUsdPerMinute.toFixed(4)}/min
                            </span>
                          </span>
                          <span className="mt-1 block text-metadata text-muted-foreground">
                            {option.useCase}
                          </span>
                        </span>
                      </span>
                      <span className="mt-1 block text-metadata text-muted-foreground">
                        $10 ≈ {deepgramHoursForBudget(option.id)} continuous hours ·{' '}
                        {option.languages}
                      </span>
                      <span className="mt-2 block text-metadata text-foreground">
                        Quality evidence: {option.qualityEvidence}
                      </span>
                      <span className="mt-1 block text-[11px] text-muted-foreground">
                        {option.qualityCaveat}
                      </span>
                    </button>
                  );
                })}
              </div>
            </section>

            <section
              aria-label="Deepgram cost calculator"
              className="rounded-xl border border-border/80 bg-background/40 p-3"
            >
              <Label className="text-sm font-medium text-foreground">Mini cost calculator</Label>
              <div className="mt-2 grid gap-3 sm:grid-cols-2">
                <div>
                  <Label htmlFor="deepgram-calculator-model" className="text-xs">
                    Calculator model
                  </Label>
                  <select
                    id="deepgram-calculator-model"
                    value={calculatorOptionId}
                    onChange={(event) =>
                      setCalculatorOptionId(event.target.value as DeepgramSttOptionId)
                    }
                    className="mt-1 h-8 w-full rounded-md border border-input bg-background px-2 text-sm text-foreground"
                  >
                    {DEEPGRAM_STT_OPTIONS.map((option) => (
                      <option key={option.id} value={option.id}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <Label htmlFor="deepgram-calculator-hours" className="text-xs">
                    Intended usage hours
                  </Label>
                  <input
                    id="deepgram-calculator-hours"
                    type="number"
                    min="0"
                    step="0.25"
                    value={calculatorHours}
                    onChange={(event) => {
                      const next = Number(event.target.value);
                      setCalculatorHours(Number.isFinite(next) && next >= 0 ? next : 0);
                    }}
                    className="mt-1 h-8 w-full rounded-md border border-input bg-background px-2 text-sm text-foreground"
                  />
                </div>
              </div>
              <p className="mt-3 text-sm font-semibold text-foreground">
                ${calculatorCost.costUsd.toFixed(4)} estimated
              </p>
              <p className="text-[11px] text-muted-foreground">
                {calculatorCost.minutes.toFixed(0)} minutes × $
                {getDeepgramSttOption(calculatorOptionId).priceUsdPerMinute.toFixed(4)}/minute.
                Actual provider billing and optional add-ons can differ.
              </p>
            </section>

            <p
              className="text-[11px] text-muted-foreground"
              data-price-freshness={isDeepgramPriceStale() ? 'stale' : 'current'}
              data-price-last-updated={DEEPGRAM_PRICE_LAST_UPDATED}
            >
              {deepgramPriceFreshnessFooter()} Source:{' '}
              <a
                href={DEEPGRAM_PRICE_SOURCE}
                target="_blank"
                rel="noreferrer"
                className="underline"
              >
                Deepgram pricing
              </a>
              . Model and language support:{' '}
              <a
                href={DEEPGRAM_MODEL_SOURCE}
                target="_blank"
                rel="noreferrer"
                className="underline"
              >
                official model documentation
              </a>
              . Estimates only — never use as a billing invoice.
            </p>
          </div>
        ) : null}
      </section>

      {provider === 'faster-whisper' || provider === 'system' ? (
        <>
          <Separator />
          <section className="flex flex-col gap-3" aria-label="Local model catalog">
            <div className="flex flex-wrap items-end justify-between gap-2">
              <div>
                <Label className="text-sm font-medium text-foreground">Local model catalog</Label>
                <p className="mt-0.5 text-metadata text-muted-foreground">
                  Exact product labels. Placement is verified — we never pretend a cloud or
                  unfinished runtime is a ready local install.
                </p>
              </div>
              <Button variant="ghost" size="sm" onClick={() => void refreshInstalled()}>
                <RefreshCw className="h-3.5 w-3.5" />
                Refresh
              </Button>
            </div>

            {!isTauri ? (
              <p className="text-metadata text-warning">
                Local downloads require the VibeSpace desktop app.
              </p>
            ) : null}

            <div className="flex flex-col gap-2">
              {LOCAL_STT_CATALOG.map((entry) => {
                const selected = selectedCatalogId === entry.id;
                const state = downloadState[entry.id] ?? 'idle';
                const percent = downloadPercent[entry.id] ?? 0;
                const active =
                  provider === 'faster-whisper' && selected && entry.runnable && state === 'ready'
                    ? 'active'
                    : selected && entry.runnable && state === 'active'
                      ? 'active'
                      : state;

                return (
                  <article
                    key={entry.id}
                    data-testid={`stt-catalog-${entry.id}`}
                    data-placement={entry.placement}
                    data-selected={selected ? 'true' : 'false'}
                    data-state={active}
                    className={cn(
                      'rounded-xl border bg-panel/80 p-3 transition-colors',
                      selected
                        ? 'border-accent-cyan/55 shadow-[0_0_0_1px_hsl(var(--accent-cyan)/0.2)]'
                        : 'border-border/80 hover:border-border',
                    )}
                  >
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <button
                        type="button"
                        className="min-w-0 flex-1 text-left"
                        onClick={() => chooseLocalModel(entry.id)}
                        aria-pressed={selected}
                      >
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-sm font-semibold text-foreground">
                            {entry.label}
                          </span>
                          <Badge variant="outline" className="text-[10px]">
                            {placementLabel(entry.placement)}
                          </Badge>
                          {selected ? (
                            <Badge
                              variant="outline"
                              className="border-accent-cyan/40 text-accent-cyan text-[10px]"
                            >
                              Selected
                            </Badge>
                          ) : null}
                          {active === 'active' ? (
                            <Badge
                              variant="outline"
                              className="border-accent-sage/40 text-accent-sage text-[10px]"
                            >
                              Active
                            </Badge>
                          ) : null}
                          {active === 'ready' ? (
                            <Badge variant="outline" className="text-[10px]">
                              Ready
                            </Badge>
                          ) : null}
                          {active === 'error' ? (
                            <Badge
                              variant="outline"
                              className="border-destructive/40 text-destructive text-[10px]"
                            >
                              Error
                            </Badge>
                          ) : null}
                        </div>
                        <p className="mt-1 text-metadata text-muted-foreground">
                          {entry.description}
                        </p>
                        <dl className="mt-2 grid gap-x-4 gap-y-0.5 text-[11px] text-muted-foreground sm:grid-cols-2">
                          <div>
                            <dt className="inline text-foreground/70">Provider · </dt>
                            <dd className="inline">{entry.provider}</dd>
                          </div>
                          <div>
                            <dt className="inline text-foreground/70">Id · </dt>
                            <dd className="inline font-mono">{entry.modelIdentifier}</dd>
                          </div>
                          <div>
                            <dt className="inline text-foreground/70">Size · </dt>
                            <dd className="inline">{entry.sizeLabel}</dd>
                          </div>
                          <div>
                            <dt className="inline text-foreground/70">License · </dt>
                            <dd className="inline">{entry.license}</dd>
                          </div>
                          <div>
                            <dt className="inline text-foreground/70">Languages · </dt>
                            <dd className="inline">{entry.languages}</dd>
                          </div>
                          <div>
                            <dt className="inline text-foreground/70">Streaming · </dt>
                            <dd className="inline">{entry.streaming ? 'Yes' : 'Batch'}</dd>
                          </div>
                          <div className="sm:col-span-2">
                            <dt className="inline text-foreground/70">Hardware · </dt>
                            <dd className="inline">{entry.hardware}</dd>
                          </div>
                        </dl>
                      </button>

                      <div className="flex shrink-0 flex-col gap-1.5">
                        {entry.placement === 'local-downloadable' ? (
                          <>
                            <Button
                              variant="secondary"
                              size="sm"
                              disabled={!isTauri || active === 'downloading'}
                              onClick={() => void downloadModel(entry.id)}
                            >
                              <Download
                                className={cn(
                                  'h-3.5 w-3.5',
                                  active === 'downloading' && 'animate-pulse',
                                )}
                              />
                              {active === 'ready' || active === 'active'
                                ? 'Re-download'
                                : active === 'downloading'
                                  ? `${percent}%`
                                  : active === 'error'
                                    ? 'Retry'
                                    : 'Download'}
                            </Button>
                            {(active === 'ready' || active === 'active') && (
                              <Button
                                variant="ghost"
                                size="sm"
                                disabled={!isTauri}
                                onClick={() => void removeModel(entry.id)}
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                                Remove
                              </Button>
                            )}
                          </>
                        ) : (
                          <div className="flex max-w-[11rem] items-start gap-1.5 rounded-md border border-dashed border-border px-2 py-1.5 text-[11px] text-muted-foreground">
                            <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                            <span>
                              {entry.placement === 'local-runtime-pending'
                                ? 'Runtime not integrated — no in-app download yet.'
                                : 'Cloud / advanced — not a faster-whisper install.'}
                            </span>
                          </div>
                        )}
                      </div>
                    </div>
                    {entry.placement === 'local-downloadable' &&
                    (active === 'ready' || active === 'active') ? (
                      <p className="mt-2 text-metadata text-muted-foreground">
                        Installed ({formatBytesShort(entry.sizeBytes)} estimated)
                        {active === 'active' ? ' · active for local dictation' : ''}
                      </p>
                    ) : null}
                  </article>
                );
              })}
            </div>

            <p className="text-metadata text-muted-foreground">
              First local transcription installs a small Python environment with faster-whisper
              (~1–2 min one-time). If a downloadable model is missing, dictation falls back to
              system speech.
            </p>
          </section>
        </>
      ) : null}
    </div>
  );
}

function ProviderRow({
  selected,
  title,
  description,
  meta,
  icon,
  onSelect,
}: {
  selected: boolean;
  title: string;
  description: string;
  meta: string;
  icon: React.ReactNode;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onSelect}
      data-monochrome-control-size="preserve"
      className={cn(
        'relative flex w-full items-start gap-3 rounded-xl border bg-panel px-3.5 py-3 text-left transition-colors',
        'hover:bg-elevated/80 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
        selected
          ? 'border-accent-cyan/50 shadow-[0_0_0_1px_hsl(var(--accent-cyan)/0.28)]'
          : 'border-border/80',
      )}
    >
      <span
        className={cn(
          'mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full border transition-colors',
          selected
            ? 'border-accent-cyan bg-accent-cyan text-background'
            : 'border-border bg-background text-transparent',
        )}
        aria-hidden
      >
        <Check className="h-3 w-3" strokeWidth={3} />
      </span>
      <span className={cn('mt-0.5 shrink-0 text-muted-foreground', selected && 'text-accent-cyan')}>
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-2">
          <span
            className={cn(
              'text-sm font-semibold [html[data-theme=monochrome]_&]:!bg-none [html[data-theme=monochrome]_&]:!text-foreground [html[data-theme=monochrome]_&]:![-webkit-text-fill-color:currentColor]',
              selected ? 'text-accent-gradient' : 'text-foreground',
            )}
          >
            {title}
          </span>
          <span className="text-[11px] text-muted-foreground">{meta}</span>
        </span>
        <span className="mt-0.5 block text-metadata leading-snug text-muted-foreground">
          {description}
        </span>
      </span>
    </button>
  );
}
