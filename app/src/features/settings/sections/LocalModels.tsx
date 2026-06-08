import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  Check,
  Download,
  ExternalLink,
  HardDriveDownload,
  Play,
  RefreshCw,
  WifiOff,
  X,
} from 'lucide-react';
import { useAuthStore } from '@/stores/auth';
import {
  isOllamaReachable,
  listOllamaModelInfo,
  ollamaBaseUrl,
  OLLAMA_DEFAULT_BASE,
  pullOllamaModel,
  waitForOllamaReachable,
  type OllamaModelInfo,
  type OllamaPullProgress,
} from '@/lib/ai';
import { getNativeOllamaStatus, startNativeOllama, type NativeOllamaStatus } from '@/lib/tauri';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { Switch } from '@/components/ui/switch';
import { toast } from '@/components/ui/toast';
import { cn } from '@/lib/utils';

interface CatalogModel {
  name: string;
  size: string;
  label: string;
  blurb: string;
  recommended?: boolean;
}

interface PullState extends OllamaPullProgress {
  model: string;
}

const MODEL_CATALOG: readonly CatalogModel[] = [
  {
    name: 'qwen3:0.6b',
    size: '523 MB',
    label: 'Smallest',
    blurb: 'Very fast basic chat for constrained devices.',
  },
  {
    name: 'gemma3:1b',
    size: '815 MB',
    label: 'Fast',
    blurb: 'Compact multilingual assistant for quick everyday replies.',
  },
  {
    name: 'llama3.2:1b',
    size: '1.3 GB',
    label: 'Low memory',
    blurb: 'Reliable lightweight assistant for summaries and rewriting.',
  },
  {
    name: 'llama3.2',
    size: '2.0 GB',
    label: 'Recommended',
    blurb: 'Balanced 3B default with tool use and strong instruction following.',
    recommended: true,
  },
  {
    name: 'qwen3:4b',
    size: '2.5 GB',
    label: 'Reasoning',
    blurb: 'Stronger reasoning, coding, and multilingual work.',
  },
  {
    name: 'gemma3',
    size: '3.3 GB',
    label: 'Vision',
    blurb: 'Capable 4B text-and-image model with a large context window.',
  },
  {
    name: 'qwen3:8b',
    size: '5.2 GB',
    label: 'High quality',
    blurb: 'Higher-quality local reasoning for machines with more memory.',
  },
] as const;

export function LocalModels() {
  const offlineMode = useAuthStore((state) => state.offlineMode);
  const setOfflineMode = useAuthStore((state) => state.setOfflineMode);
  const defaultLocalModel = useAuthStore((state) => state.defaultLocalModel);
  const setDefaultLocalModel = useAuthStore((state) => state.setDefaultLocalModel);
  const storedBase = useAuthStore((state) => state.apiKeys.ollama ?? '');
  const setApiKey = useAuthStore((state) => state.setApiKey);

  const [baseDraft, setBaseDraft] = useState(storedBase || OLLAMA_DEFAULT_BASE);
  const [reachable, setReachable] = useState<boolean | null>(null);
  const [nativeStatus, setNativeStatus] = useState<NativeOllamaStatus>({
    installed: null,
  });
  const [installed, setInstalled] = useState<OllamaModelInfo[]>([]);
  const [scanning, setScanning] = useState(false);
  const [starting, setStarting] = useState(false);
  const [pullState, setPullState] = useState<PullState | null>(null);
  const autoStartAttemptedRef = useRef(false);
  const pullAbortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    setBaseDraft(storedBase || OLLAMA_DEFAULT_BASE);
  }, [storedBase]);

  const scan = useCallback(
    async (autoStart = true) => {
      setScanning(true);
      try {
        const [status, initiallyReachable] = await Promise.all([
          getNativeOllamaStatus(),
          isOllamaReachable(),
        ]);
        setNativeStatus(status);

        let connected = initiallyReachable;
        if (
          !connected &&
          autoStart &&
          status.installed === true &&
          !autoStartAttemptedRef.current
        ) {
          autoStartAttemptedRef.current = true;
          setStarting(true);
          try {
            await startNativeOllama();
            connected = await waitForOllamaReachable();
          } catch {
            connected = false;
          } finally {
            setStarting(false);
          }
        }

        setReachable(connected);
        if (!connected) {
          setInstalled([]);
          return;
        }

        const models = await listOllamaModelInfo();
        setInstalled(models);
        const currentDefault = useAuthStore.getState().defaultLocalModel;
        if (models.length > 0 && !isModelInstalled(models, currentDefault)) {
          setDefaultLocalModel(models[0].name);
        }
      } finally {
        setScanning(false);
      }
    },
    [setDefaultLocalModel],
  );

  useEffect(() => {
    void scan();
    return () => pullAbortRef.current?.abort();
  }, [scan]);

  function saveBase() {
    const trimmed = baseDraft.trim() || OLLAMA_DEFAULT_BASE;
    setApiKey('ollama', trimmed);
    autoStartAttemptedRef.current = false;
    toast.success('Local endpoint saved', trimmed);
    void scan();
  }

  function pickModel(name: string) {
    setDefaultLocalModel(name);
    toast.success('Default local model set', name);
  }

  function handleToggleOffline(enabled: boolean) {
    if (enabled && (!reachable || installed.length === 0)) {
      toast.warning(
        'Local model not ready',
        'Connect Ollama and download at least one model before enabling offline mode.',
      );
      return;
    }
    setOfflineMode(enabled);
    toast.info(
      enabled ? 'Offline mode on' : 'Offline mode off',
      enabled
        ? 'All chat now runs through your local model. Nothing is sent to a cloud model.'
        : 'Jarvis can use your selected cloud provider again.',
    );
  }

  async function startDaemon() {
    setStarting(true);
    try {
      await startNativeOllama();
      const connected = await waitForOllamaReachable();
      if (!connected) throw new Error('Ollama did not become reachable within 12 seconds.');
      toast.success('Ollama started', 'The local model service is connected.');
      await scan(false);
    } catch (err) {
      toast.error(
        'Could not start Ollama',
        err instanceof Error ? err.message : 'The local service did not start.',
      );
    } finally {
      setStarting(false);
    }
  }

  async function downloadModel(model: string) {
    if (!reachable) {
      toast.warning('Ollama is not connected', 'Start Ollama before downloading a model.');
      return;
    }

    const controller = new AbortController();
    pullAbortRef.current?.abort();
    pullAbortRef.current = controller;
    setPullState({ model, status: 'Starting download' });

    try {
      await pullOllamaModel(
        model,
        (progress) => setPullState({ model, ...progress }),
        controller.signal,
      );
      setDefaultLocalModel(model);
      toast.success('Model ready', `${model} is installed and selected.`);
      await scan(false);
    } catch (err) {
      if ((err as Error)?.name !== 'AbortError') {
        toast.error(
          'Model download failed',
          err instanceof Error ? err.message : 'Ollama could not download this model.',
        );
      }
    } finally {
      if (pullAbortRef.current === controller) pullAbortRef.current = null;
      setPullState(null);
    }
  }

  const connected = reachable === true;
  const notInstalled = reachable === false && nativeStatus.installed === false;
  const canStart = reachable === false && nativeStatus.installed === true;

  return (
    <div className="flex flex-col gap-6">
      <header>
        <h2 className="text-page-title text-foreground">Local Models</h2>
        <p className="mt-1 text-secondary text-muted-foreground">
          Download and run models entirely on this device through{' '}
          <a
            href="https://ollama.com/download"
            target="_blank"
            rel="noreferrer"
            className="text-accent-copper underline-offset-4 hover:underline"
          >
            Ollama
          </a>
          . Local chats do not require an API key.
        </p>
      </header>

      <section className="flex items-start justify-between gap-4 rounded-md border border-border bg-panel px-4 py-3">
        <div className="flex min-w-0 items-start gap-3">
          <WifiOff
            className={cn(
              'mt-0.5 h-4 w-4 shrink-0',
              offlineMode ? 'text-accent-cyan' : 'text-muted-foreground',
            )}
          />
          <div className="min-w-0">
            <Label
              htmlFor="offline-toggle"
              className="cursor-pointer text-ui-strong text-foreground"
            >
              Fully local chat
            </Label>
            <p className="mt-0.5 text-metadata text-muted-foreground">
              Force every conversation through the selected local model and ignore cloud providers.
            </p>
          </div>
        </div>
        <Switch
          id="offline-toggle"
          checked={offlineMode}
          onCheckedChange={handleToggleOffline}
          aria-label="Toggle fully local chat"
        />
      </section>

      <Separator />

      <section className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h3 className="text-ui-strong text-foreground">Ollama connection</h3>
            <p className="text-metadata text-muted-foreground">
              Jarvis reconnects automatically and can start an installed desktop service.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <ConnectionBadge
              reachable={reachable}
              installed={nativeStatus.installed}
              scanning={scanning}
              starting={starting}
            />
            {canStart ? (
              <Button
                variant="secondary"
                size="sm"
                onClick={() => void startDaemon()}
                disabled={starting}
              >
                <Play className="h-3.5 w-3.5" />
                Start Ollama
              </Button>
            ) : null}
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => {
                autoStartAttemptedRef.current = false;
                void scan();
              }}
              disabled={scanning || starting}
              aria-label="Re-scan Ollama"
            >
              <RefreshCw className={cn('h-3.5 w-3.5', (scanning || starting) && 'animate-spin')} />
            </Button>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <Input
            value={baseDraft}
            onChange={(event) => setBaseDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                saveBase();
              }
            }}
            placeholder={OLLAMA_DEFAULT_BASE}
            className="font-mono"
            spellCheck={false}
            autoComplete="off"
            aria-label="Ollama base URL"
          />
          <Button
            variant="secondary"
            size="sm"
            onClick={saveBase}
            disabled={baseDraft.trim() === (storedBase || OLLAMA_DEFAULT_BASE)}
          >
            Save
          </Button>
        </div>

        {notInstalled ? (
          <div className="flex items-start gap-2 rounded-md border border-warning/30 bg-warning/10 p-3">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
            <div>
              <p className="text-ui-strong text-foreground">Ollama is not installed</p>
              <p className="text-metadata text-muted-foreground">
                Install the official Windows app, reopen Jarvis, and it will connect automatically.
              </p>
              <a
                href="https://ollama.com/download/windows"
                target="_blank"
                rel="noreferrer"
                className="mt-2 inline-flex items-center gap-1 text-metadata font-medium text-accent-copper hover:underline"
              >
                Download Ollama <ExternalLink className="h-3 w-3" />
              </a>
            </div>
          </div>
        ) : null}

        {reachable === false && nativeStatus.installed !== false ? (
          <p className="text-metadata text-muted-foreground">
            Could not reach {ollamaBaseUrl()}. Start the service, verify the endpoint, then re-scan.
          </p>
        ) : null}

        {connected && nativeStatus.version ? (
          <p className="text-metadata text-muted-foreground">{nativeStatus.version}</p>
        ) : null}
      </section>

      <Separator />

      <section className="flex flex-col gap-3">
        <div>
          <h3 className="text-ui-strong text-foreground">Installed models</h3>
          <p className="text-secondary text-muted-foreground">
            Jarvis automatically registers downloaded models and uses the selected one for local
            chat.
          </p>
        </div>

        {installed.length > 0 ? (
          <div
            role="radiogroup"
            aria-label="Installed local models"
            className="grid max-w-xl gap-2"
          >
            {installed.map((model) => {
              const selected = sameModel(defaultLocalModel, model.name);
              return (
                <button
                  type="button"
                  key={model.name}
                  role="radio"
                  aria-checked={selected}
                  onClick={() => pickModel(model.name)}
                  className={cn(
                    'flex items-center gap-3 rounded-md border bg-panel px-3 py-2 text-left transition-colors',
                    'hover:bg-elevated focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
                    selected
                      ? 'border-accent-cyan/50 shadow-[0_0_0_1px_hsl(var(--accent-cyan)/0.3)]'
                      : 'border-border',
                  )}
                >
                  <span
                    className={cn(
                      'flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full border',
                      selected
                        ? 'border-transparent bg-accent-gradient'
                        : 'border-border-mid bg-background',
                    )}
                  >
                    {selected ? <Check className="h-2.5 w-2.5 text-white" strokeWidth={3} /> : null}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-mono text-ui-strong text-foreground">
                      {model.name}
                    </span>
                    {model.size ? (
                      <span className="text-metadata text-muted-foreground">
                        {formatBytes(model.size)}
                      </span>
                    ) : null}
                  </span>
                  {selected ? <Badge variant="success">Selected</Badge> : null}
                </button>
              );
            })}
          </div>
        ) : (
          <p className="text-metadata text-muted-foreground">
            {connected
              ? 'No models are installed yet. Download one from the catalog below.'
              : 'Connect Ollama to detect installed models.'}
          </p>
        )}

        <div className="flex max-w-xl items-center gap-2">
          <Input
            value={defaultLocalModel}
            onChange={(event) => setDefaultLocalModel(event.target.value)}
            placeholder="llama3.2"
            className="font-mono"
            spellCheck={false}
            autoComplete="off"
            aria-label="Default local model name"
          />
          <span className="shrink-0 text-metadata text-muted-foreground">custom model</span>
        </div>
      </section>

      <Separator />

      <section className="flex flex-col gap-3">
        <div>
          <h3 className="flex items-center gap-2 text-ui-strong text-foreground">
            <HardDriveDownload className="h-4 w-4 text-accent-copper" />
            Model catalog
          </h3>
          <p className="text-secondary text-muted-foreground">
            Download directly in Jarvis with live Ollama progress. Model sizes are approximate.
          </p>
        </div>

        {pullState ? (
          <PullProgressCard state={pullState} onCancel={() => pullAbortRef.current?.abort()} />
        ) : null}

        <div className="grid max-w-2xl gap-2">
          {MODEL_CATALOG.map((model) => {
            const modelInstalled = isModelInstalled(installed, model.name);
            const pullingThisModel = pullState?.model === model.name;
            return (
              <div
                key={model.name}
                className={cn(
                  'flex items-center justify-between gap-3 rounded-md border bg-panel px-3 py-3',
                  model.recommended ? 'border-accent-copper/40' : 'border-border',
                )}
              >
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-ui-strong text-foreground">{model.name}</span>
                    <Badge variant={model.recommended ? 'accent' : 'outline'}>{model.label}</Badge>
                    <Badge variant="outline">{model.size}</Badge>
                    {modelInstalled ? (
                      <Badge variant="success">
                        <Check className="h-3 w-3" />
                        Installed
                      </Badge>
                    ) : null}
                  </div>
                  <p className="mt-1 text-metadata text-muted-foreground">{model.blurb}</p>
                </div>
                {modelInstalled ? (
                  <Button
                    variant="secondary"
                    size="sm"
                    className="shrink-0"
                    onClick={() => pickModel(model.name)}
                    disabled={sameModel(defaultLocalModel, model.name)}
                  >
                    <Check className="h-3.5 w-3.5" />
                    {sameModel(defaultLocalModel, model.name) ? 'Selected' : 'Use'}
                  </Button>
                ) : (
                  <Button
                    variant="secondary"
                    size="sm"
                    className="shrink-0"
                    onClick={() => void downloadModel(model.name)}
                    disabled={!connected || pullState !== null}
                  >
                    <Download className={cn('h-3.5 w-3.5', pullingThisModel && 'animate-pulse')} />
                    {pullingThisModel ? 'Downloading' : 'Download'}
                  </Button>
                )}
              </div>
            );
          })}
        </div>

        <a
          href="https://ollama.com/library"
          target="_blank"
          rel="noreferrer"
          className="inline-flex w-fit items-center gap-1 text-metadata font-medium text-accent-copper hover:underline"
        >
          Browse the full Ollama library <ExternalLink className="h-3 w-3" />
        </a>
      </section>
    </div>
  );
}

function ConnectionBadge({
  reachable,
  installed,
  scanning,
  starting,
}: {
  reachable: boolean | null;
  installed: boolean | null;
  scanning: boolean;
  starting: boolean;
}) {
  if (starting) return <Badge variant="outline">Starting...</Badge>;
  if (scanning || reachable === null) return <Badge variant="outline">Checking...</Badge>;
  if (reachable) {
    return (
      <Badge variant="success">
        <Check className="h-3 w-3" />
        Connected
      </Badge>
    );
  }
  if (installed === false) return <Badge variant="warning">Not installed</Badge>;
  if (installed === true) return <Badge variant="warning">Installed, stopped</Badge>;
  return <Badge variant="outline">Not connected</Badge>;
}

function PullProgressCard({ state, onCancel }: { state: PullState; onCancel: () => void }) {
  const percent = state.percent === undefined ? null : Math.round(state.percent);
  return (
    <div className="max-w-2xl rounded-md border border-accent-cyan/35 bg-accent-cyan/5 p-3">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate font-mono text-ui-strong text-foreground">{state.model}</p>
          <p className="truncate text-metadata text-muted-foreground">{state.status}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {percent !== null ? (
            <span className="text-metadata font-semibold text-accent-cyan">{percent}%</span>
          ) : null}
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={onCancel}
            aria-label="Cancel model download"
          >
            <X className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>
      <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-muted">
        <div
          className={cn(
            'h-full rounded-full bg-accent-gradient transition-[width] duration-300',
            percent === null && 'animate-pulse',
          )}
          style={{ width: percent === null ? '18%' : `${percent}%` }}
        />
      </div>
      {state.completed !== undefined && state.total ? (
        <p className="mt-2 text-right text-metadata text-muted-foreground">
          {formatBytes(state.completed)} / {formatBytes(state.total)}
        </p>
      ) : null}
    </div>
  );
}

function normalizeModelName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/:latest$/, '');
}

function sameModel(left: string, right: string): boolean {
  return normalizeModelName(left) === normalizeModelName(right);
}

function isModelInstalled(models: readonly OllamaModelInfo[], name: string): boolean {
  return models.some((model) => sameModel(model.name, name));
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const index = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** index).toFixed(index >= 3 ? 1 : 0)} ${units[index]}`;
}
