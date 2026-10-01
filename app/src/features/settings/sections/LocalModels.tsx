import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import '@/features/local-models/sakura-local-models.css';
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
  assertAllowedOllamaEndpoint,
  classifyOllamaModel,
  listOllamaModelInfo,
  LOCAL_MODEL_CATALOG,
  catalogDisplayName,
  catalogFamilyName,
  ollamaBaseUrl,
  OLLAMA_DEFAULT_BASE,
  pullOllamaModel,
  removeOllamaModel,
  syncDiscoveredOllamaModels,
  validateModelName,
  verifyOllamaModelChat,
  type OllamaEnsureStatus,
  type OllamaModelInfo,
  type OllamaPullProgress,
  type LocalAgentCompatibilityResult,
} from '@/lib/ai';
import { bootstrapOllamaConnection, invalidateOllamaBootstrap } from '@/lib/ai/ollamaBootstrap';
import {
  getNativeOllamaStatus,
  installNativeOllamaWithConsent,
  openOllamaTroubleshooting,
  type NativeOllamaStatus,
} from '@/lib/tauri';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { Switch } from '@/components/ui/switch';
import { toast } from '@/components/ui/toast';
import { cn } from '@/lib/utils';
import {
  readLocalAgentPreferences,
  writeLocalAgentPreferences,
  type LocalAgentMode,
} from '@/lib/ai/localAgentRuntime';

interface PullState extends OllamaPullProgress {
  model: string;
}

// ── Module-level download state (survives tab switches) ────────────────

type DownloadStatus = 'downloading' | 'done' | 'error';

interface DownloadEntry {
  status: DownloadStatus;
  progress: PullState | null;
  error?: string;
  abortController?: AbortController;
}

const _downloads = new Map<string, DownloadEntry>();
let _downloadListeners: Array<() => void> = [];

function notifyDownloadListeners() {
  const ls = _downloadListeners;
  for (let i = 0; i < ls.length; i++) ls[i]!();
}

function getDownloadSnapshot(): ReadonlyMap<string, DownloadEntry> {
  return _downloads;
}

function subscribeToDownloads(cb: () => void): () => void {
  _downloadListeners.push(cb);
  return () => {
    _downloadListeners = _downloadListeners.filter((l) => l !== cb);
  };
}

function formatPullProgress(model: string, progress: OllamaPullProgress | null): PullState {
  const family = catalogFamilyName(model);
  const display = catalogDisplayName(model);
  if (!progress) {
    return { model, status: `Preparing ${family}…` };
  }

  const raw = progress.status?.trim() ?? '';
  const preparing =
    raw === 'Preparing…' ||
    raw.startsWith('Starting download') ||
    /checking|installing|starting|waiting/i.test(raw);
  if (preparing) {
    return { ...progress, model, status: `Preparing ${family}…` };
  }

  const early =
    progress.percent === undefined || progress.percent < 2 || /manifest|pulling/i.test(raw);
  if (early) {
    return { ...progress, model, status: `Downloading ${family}…` };
  }

  const detail = raw && raw !== 'success' ? ` — ${raw}` : '';
  return { ...progress, model, status: `Downloading ${display}${detail}` };
}

function createPullProgressReporter(model: string, onUiUpdate: (state: PullState) => void) {
  let lastUiAt = 0;
  return (progress: OllamaPullProgress) => {
    const next = formatPullProgress(model, progress);
    const now = Date.now();
    const force = Boolean(progress.done) || now - lastUiAt >= 150;
    _downloads.set(model, {
      status: progress.done ? 'done' : 'downloading',
      progress: next,
      abortController: _downloads.get(model)?.abortController,
    });
    notifyDownloadListeners();
    if (force) {
      lastUiAt = now;
      onUiUpdate(next);
    }
  };
}

function userFacingDownloadError(err: unknown): string {
  if (!(err instanceof Error)) return 'Download failed: unknown error.';
  const msg = err.message;

  if (msg.includes('Invalid model name')) return msg;
  if (msg.includes('net::ERR_CONNECTION_REFUSED') || msg.includes('Failed to fetch'))
    return 'Jarvis is still preparing Ollama. Wait a moment and try again.';
  if (msg.includes('timed out'))
    return 'Download timed out. Check your internet connection and try again.';
  if (msg.includes('size exceeded') || msg.includes('maximum allowed'))
    return 'Download exceeds the maximum allowed size. Try a smaller model.';
  if (msg.includes('AbortError') || msg.includes('aborted')) return 'Download was cancelled.';
  if (msg.includes('404') || msg.includes('not found'))
    return 'Model not found in the Ollama registry. Check the model name.';
  if (msg.includes('insufficient') || msg.includes('disk') || msg.includes('space'))
    return 'Not enough disk space to download this model. Free up space and try again.';
  if (msg.includes('verification failed'))
    return 'Download completed but the model could not be verified. Try re-scanning or re-downloading.';
  if (msg.includes('Could not reach Ollama'))
    return 'Ollama became unreachable during download. Check that the service is still running.';
  if (msg.includes('Ollama pull failed')) return `Ollama reported an error: ${msg.slice(0, 200)}`;

  return `Download failed: ${msg.slice(0, 200)}`;
}

async function hasEnoughDiskSpace(requiredBytes = 2_000_000_000): Promise<{
  ok: boolean;
  availableBytes: number | null;
  authoritative: boolean;
  requiredBytes: number;
}> {
  // Always force a fresh probe on write actions so hours-old free space never blocks.
  const { hasEnoughDiskSpaceForWrite } = await import('@/lib/diskSpace');
  return hasEnoughDiskSpaceForWrite(requiredBytes, { force: true });
}

// ── Unified Ollama bootstrap ────────────────────────────────────────────
// This is the core fix. Every Download button call goes through this
// single pipeline: detect install → start if needed → wait (120s) → pull.

interface BootstrapState {
  phase:
    | 'idle'
    | 'detecting'
    | 'installing'
    | 'starting'
    | 'waiting'
    | 'ready'
    | 'error'
    | 'not_installed';
  statusMsg: string;
  error?: string;
}

let _bootstrapState: BootstrapState = { phase: 'idle', statusMsg: '' };
let _bootstrapListeners: Array<() => void> = [];
function notifyBootstrap() {
  _bootstrapListeners.forEach((fn) => fn());
}

function subscribeToBootstrap(cb: () => void): () => void {
  _bootstrapListeners.push(cb);
  return () => {
    _bootstrapListeners = _bootstrapListeners.filter((l) => l !== cb);
  };
}
function getBootstrapSnapshot(): BootstrapState {
  return _bootstrapState;
}

function mapEnsureStatus(status: OllamaEnsureStatus): BootstrapState {
  const phase =
    status.phase === 'not_installed'
      ? 'not_installed'
      : status.phase === 'ready'
        ? 'ready'
        : status.phase === 'error'
          ? 'error'
          : status.phase === 'installing'
            ? 'installing'
            : status.phase === 'starting'
              ? 'starting'
              : status.phase === 'waiting'
                ? 'waiting'
                : 'detecting';

  return {
    phase,
    statusMsg: status.statusMsg,
    error: status.ready ? undefined : status.detail || undefined,
  };
}

async function ensureOllamaReady(signal?: AbortSignal): Promise<boolean> {
  _bootstrapState = { phase: 'detecting', statusMsg: 'Checking Ollama installation…' };
  notifyBootstrap();

  const result = await bootstrapOllamaConnection({
    force: true,
    signal,
    waitTimeoutMs: 90_000,
  });
  _bootstrapState = mapEnsureStatus(result.status);
  notifyBootstrap();
  return result.ready;
}

// ── Component ────────────────────────────────────────────────────────────

export function LocalModels({ active = true }: { active?: boolean } = {}) {
  const offlineMode = useAuthStore((state) => state.offlineMode);
  const setOfflineMode = useAuthStore((state) => state.setOfflineMode);
  const defaultLocalModel = useAuthStore((state) => state.defaultLocalModel);
  const setDefaultLocalModel = useAuthStore((state) => state.setDefaultLocalModel);
  const storedBase = useAuthStore((state) => state.apiKeys.ollama ?? '');
  const setApiKey = useAuthStore((state) => state.setApiKey);

  const [baseDraft, setBaseDraft] = useState(storedBase || OLLAMA_DEFAULT_BASE);
  const [reachable, setReachable] = useState<boolean | null>(null);
  const [nativeStatus, setNativeStatus] = useState<NativeOllamaStatus>({ installed: null });
  const [installed, setInstalled] = useState<OllamaModelInfo[]>([]);
  const [scanning, setScanning] = useState(false);
  const [pullState, setPullState] = useState<PullState | null>(null);
  const [runtimePreferences, setRuntimePreferences] = useState(readLocalAgentPreferences);
  const [compatibility, setCompatibility] = useState<
    ReadonlyMap<string, LocalAgentCompatibilityResult>
  >(new Map());
  const [checkingCompatibility, setCheckingCompatibility] = useState<string | null>(null);
  const autoStartAttemptedRef = useRef(false);

  const downloadMap = useSyncExternalStore(subscribeToDownloads, getDownloadSnapshot);
  const bootstrap = useSyncExternalStore(subscribeToBootstrap, getBootstrapSnapshot);

  useEffect(() => {
    setBaseDraft(storedBase || OLLAMA_DEFAULT_BASE);
  }, [storedBase]);

  const scan = useCallback(
    async (autoStart = true) => {
      setScanning(true);
      try {
        const result = await bootstrapOllamaConnection({
          force: !autoStart,
          waitTimeoutMs: autoStart ? undefined : 90_000,
        });
        const status = await getNativeOllamaStatus();
        setNativeStatus(status);
        setReachable(result.ready);

        if (!result.ready) {
          setInstalled([]);
          return;
        }

        const models = await listOllamaModelInfo();
        setInstalled(models);
        syncDiscoveredOllamaModels(models.map((m) => m.name));

        const currentDefault = useAuthStore.getState().defaultLocalModel;
        if (models.length > 0 && !currentDefault.trim()) {
          setDefaultLocalModel(models[0].name);
        } else if (currentDefault && !isModelInstalled(models, currentDefault)) {
          toast.warning(
            'Selected local model is unavailable',
            `${currentDefault} was removed or is not currently exposed by Ollama. VibeSpace will not silently select a different model.`,
          );
        }
      } finally {
        setScanning(false);
      }
    },
    [setDefaultLocalModel],
  );

  useEffect(() => {
    if (!active) return;
    void scan();
    // Keep in-flight Ollama pulls alive when the user switches settings tabs.
  }, [active, scan]);

  function saveBase() {
    const trimmed = baseDraft.trim() || OLLAMA_DEFAULT_BASE;
    try {
      assertAllowedOllamaEndpoint(trimmed);
    } catch (err) {
      toast.error('Invalid Ollama endpoint', err instanceof Error ? err.message : String(err));
      return;
    }
    setApiKey('ollama', trimmed);
    invalidateOllamaBootstrap();
    autoStartAttemptedRef.current = false;
    toast.success('Local endpoint saved', trimmed);
    void scan();
  }

  function pickModel(name: string) {
    setDefaultLocalModel(name);
    toast.success(
      'Fully Local fallback updated',
      `${name} will be used when Fully Local Chat is enabled. Every installed model remains available in Chat.`,
    );
  }

  async function checkModelCompatibility(model: string) {
    setCheckingCompatibility(model);
    try {
      const result = await classifyOllamaModel(model);
      setCompatibility((current) => {
        const next = new Map(current);
        next.set(model, result);
        return next;
      });
    } finally {
      setCheckingCompatibility((current) => (current === model ? null : current));
    }
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

  function setRuntimeMode(mode: LocalAgentMode) {
    const next = { ...runtimePreferences, mode };
    writeLocalAgentPreferences(next);
    setRuntimePreferences(next);
  }

  function setCloudEscalationEnabled(enabled: boolean) {
    const next = { ...runtimePreferences, cloudEscalationEnabled: enabled };
    writeLocalAgentPreferences(next);
    setRuntimePreferences(next);
  }

  /**
   * Full pipeline: ensure Ollama is running, then download the model.
   * This is the function called by every Download button. It handles
   * the entire lifecycle — the user never has to manually start Ollama
   * or check connectivity first.
   */
  async function downloadModel(model: string, force = false) {
    // Validate model name
    try {
      validateModelName(model);
    } catch (err) {
      toast.error('Invalid model name', err instanceof Error ? err.message : String(err));
      return;
    }

    // Guard: already downloading this exact model
    const existing = _downloads.get(model);
    if (existing?.status === 'downloading') {
      toast.info('Already downloading', `${model} is currently being downloaded.`);
      return;
    }

    // Guard: another model is downloading
    for (const [name, entry] of _downloads) {
      if (entry.status === 'downloading') {
        toast.warning('Download in progress', `${name} is downloading. Wait for it to finish.`);
        return;
      }
    }

    // Disk check — fresh every download/repair (never trust a stale free-space reading).
    const catalogEntry = LOCAL_MODEL_CATALOG.find((entry) => entry.name === model);
    const { sizeLabelToBytes, formatBytesShort } = await import('@/lib/diskSpace');
    const requiredBytes =
      catalogEntry?.approximateDownloadBytes ??
      sizeLabelToBytes(catalogEntry?.size) ??
      2_000_000_000;
    const diskCheck = await hasEnoughDiskSpace(requiredBytes);
    if (!diskCheck.ok) {
      toast.error(
        'Not enough disk space',
        `Need about ${catalogEntry?.size ?? formatBytesShort(requiredBytes)} free (plus headroom). ` +
          `Currently free: ${formatBytesShort(diskCheck.availableBytes)}. Free more storage and try again.`,
      );
      return;
    }

    const installation = await getNativeOllamaStatus();
    if (installation.installed === false) {
      const accepted = window.confirm(
        `Install Ollama from the official source to download ${catalogDisplayName(model)}? ` +
          'This installs a local model runtime on this device. No model or private file is uploaded.',
      );
      if (!accepted) return;

      _bootstrapState = {
        phase: 'installing',
        statusMsg: 'Installing Ollama from the official source…',
      };
      notifyBootstrap();
      const installedRuntime = await installNativeOllamaWithConsent(ollamaBaseUrl());
      if (!installedRuntime.ready) {
        const detail = installedRuntime.detail || 'Ollama installation did not complete.';
        _bootstrapState = {
          phase: 'error',
          statusMsg: 'Ollama installation failed',
          error: detail,
        };
        notifyBootstrap();
        toast.error('Ollama installation failed', detail);
        return;
      }
      setNativeStatus({ installed: true, version: installedRuntime.version ?? undefined });
      invalidateOllamaBootstrap();
    }

    // Step 1: bootstrap Ollama if needed
    const controller = new AbortController();
    const family = catalogFamilyName(model);
    _downloads.set(model, {
      status: 'downloading',
      progress: { model, status: `Preparing ${family}…` },
      abortController: controller,
    });
    notifyDownloadListeners();
    setPullState({ model, status: `Preparing ${family}…` });

    const ready = await ensureOllamaReady(controller.signal);
    if (!ready) {
      const errMsg = _bootstrapState.error || 'Ollama is not running.';
      _downloads.set(model, { status: 'error', progress: null, error: errMsg });
      notifyDownloadListeners();
      setPullState(null);
      toast.error('Ollama not available', errMsg);
      return;
    }

    // Update reachable state now that Ollama is ready
    setReachable(true);

    // Step 2: download
    const reportPullProgress = createPullProgressReporter(model, setPullState);
    reportPullProgress({ status: `Downloading ${family}…` });

    try {
      await pullOllamaModel(model, reportPullProgress, controller.signal, { force });
      const verifyingState = {
        model,
        status: `Verifying ${catalogDisplayName(model)} with a real local chat…`,
        percent: 100,
      };
      _downloads.set(model, {
        status: 'downloading',
        progress: verifyingState,
        abortController: controller,
      });
      notifyDownloadListeners();
      setPullState(verifyingState);
      await verifyOllamaModelChat(model, controller.signal);
      const doneState = formatPullProgress(model, { status: 'success', done: true, percent: 100 });
      _downloads.set(model, {
        status: 'done',
        progress: doneState,
      });
      notifyDownloadListeners();
      setPullState(doneState);
      toast.success(
        'Model ready',
        `${catalogDisplayName(model)} is installed and available in the Chat model selector.`,
      );
      await scan(false);
    } catch (err) {
      if ((err as Error)?.name === 'AbortError') {
        _downloads.delete(model);
      } else {
        const friendly = userFacingDownloadError(err);
        _downloads.set(model, { status: 'error', progress: null, error: friendly });
        toast.error('Model download failed', friendly);
      }
      notifyDownloadListeners();
    } finally {
      setPullState(null);
    }
  }

  async function verifyModel(model: string) {
    const ready = await ensureOllamaReady();
    if (!ready) {
      toast.error('Ollama not available', _bootstrapState.error || 'Ollama is not running.');
      return;
    }
    try {
      await verifyOllamaModelChat(model);
      toast.success('Model verified', `${catalogDisplayName(model)} completed a real local chat.`);
    } catch (error) {
      toast.error('Verification failed', userFacingDownloadError(error));
    }
  }

  async function removeModel(model: string) {
    if (
      !window.confirm(
        `Remove ${catalogDisplayName(model)} from this device? You can download it again later.`,
      )
    ) {
      return;
    }
    const ready = await ensureOllamaReady();
    if (!ready) {
      toast.error('Ollama not available', _bootstrapState.error || 'Ollama is not running.');
      return;
    }
    try {
      await removeOllamaModel(model);
      if (sameModel(defaultLocalModel, model)) setDefaultLocalModel('');
      toast.success('Model removed', `${catalogDisplayName(model)} was removed from this device.`);
      await scan(false);
    } catch (error) {
      toast.error('Could not remove model', userFacingDownloadError(error));
    }
  }

  const activePull: PullState | null =
    pullState ??
    (() => {
      for (const [, entry] of downloadMap) {
        if (entry.status === 'downloading' && entry.progress) return entry.progress;
      }
      return null;
    })();

  const connected = reachable === true;
  const notInstalled =
    reachable === false &&
    (nativeStatus.installed === false || bootstrap.phase === 'not_installed');
  const canStart = reachable === false && nativeStatus.installed === true;
  const busy =
    bootstrap.phase === 'detecting' ||
    bootstrap.phase === 'installing' ||
    bootstrap.phase === 'starting' ||
    bootstrap.phase === 'waiting';
  const anyDownloading = activePull !== null;

  async function handleOpenTroubleshooting() {
    try {
      await openOllamaTroubleshooting();
      toast.info('Opened Ollama troubleshooting', 'Use this only if silent startup failed.');
    } catch (err) {
      toast.error('Could not open Ollama', err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div className="mc7f-settings-local-models flex flex-col gap-6 [html[data-theme=monochrome]_&]:border-l-2 [html[data-theme=monochrome]_&]:border-l-foreground/20 [html[data-theme=monochrome]_&]:pl-4 [html[data-theme=monochrome]_&_*]:rounded-none [html[data-theme=monochrome]_&_*]:bg-none [html[data-theme=monochrome]_&_*]:shadow-none">
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

      <section className="grid gap-3 rounded-md border border-border bg-panel px-4 py-3">
        <div>
          <h3 className="text-ui-strong text-foreground">Local agent mode</h3>
          <p className="mt-0.5 text-metadata text-muted-foreground">
            Fast minimizes reasoning for low latency. Deep uses bounded reasoning and verification
            for difficult tasks.
          </p>
        </div>
        <div className="grid grid-cols-2 gap-2" role="group" aria-label="Local agent mode">
          {(['fast', 'deep'] as const).map((mode) => (
            <Button
              key={mode}
              type="button"
              variant={runtimePreferences.mode === mode ? 'secondary' : 'ghost'}
              aria-label={`${mode === 'fast' ? 'Fast' : 'Deep'} mode`}
              aria-pressed={runtimePreferences.mode === mode}
              onClick={() => setRuntimeMode(mode)}
            >
              {mode === 'fast' ? 'Fast' : 'Deep'}
            </Button>
          ))}
        </div>
        <div className="flex items-start justify-between gap-4 border-t border-border pt-3">
          <div className="min-w-0">
            <Label
              htmlFor="local-cloud-escalation-toggle"
              className={cn('text-ui-strong text-foreground', offlineMode && 'opacity-60')}
            >
              Offer cloud escalation
            </Label>
            <p className="mt-0.5 text-metadata text-muted-foreground">
              After local inference fails, show the provider, model, and data categories for
              approval. VibeSpace never sends data or switches models automatically.
            </p>
            {offlineMode ? (
              <p className="mt-1 text-metadata text-accent-cyan">Disabled by Fully Local Chat.</p>
            ) : null}
          </div>
          <Switch
            id="local-cloud-escalation-toggle"
            checked={!offlineMode && runtimePreferences.cloudEscalationEnabled}
            onCheckedChange={setCloudEscalationEnabled}
            disabled={offlineMode}
            aria-label="Allow cloud escalation offers"
          />
        </div>
      </section>

      <Separator />

      <section className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h3 className="text-ui-strong text-foreground">Ollama connection</h3>
            <p className="text-metadata text-muted-foreground">
              Jarvis starts Ollama automatically when you download a model.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <ConnectionBadge
              reachable={reachable}
              installed={nativeStatus.installed}
              scanning={scanning}
              busy={busy}
              bootstrapStatus={bootstrap.statusMsg}
            />
            {canStart && !busy ? (
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  ensureOllamaReady().then((ok) => {
                    if (ok) {
                      setReachable(true);
                      void scan(false);
                    }
                  });
                }}
                disabled={busy}
              >
                <Play className="h-3.5 w-3.5" />
                Start silently
              </Button>
            ) : null}
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => {
                autoStartAttemptedRef.current = false;
                void scan();
              }}
              disabled={scanning || busy}
              aria-label="Re-scan Ollama"
            >
              <RefreshCw className={cn('h-3.5 w-3.5', (scanning || busy) && 'animate-spin')} />
            </Button>
          </div>
        </div>

        {/* Bootstrap status banner */}
        {busy ? (
          <div className="rounded-md border border-accent-cyan/25 bg-accent-cyan/5 px-3 py-2">
            <p className="text-metadata text-accent-cyan">{bootstrap.statusMsg}</p>
          </div>
        ) : bootstrap.phase === 'error' ? (
          <div className="rounded-md border border-warning/30 bg-warning/10 px-3 py-2">
            <p className="text-metadata text-warning">{bootstrap.statusMsg}</p>
            {bootstrap.error ? (
              <p className="mt-1 text-secondary text-muted-foreground">{bootstrap.error}</p>
            ) : null}
            <div className="mt-2 flex flex-wrap gap-2">
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  invalidateOllamaBootstrap();
                  autoStartAttemptedRef.current = false;
                  void ensureOllamaReady().then((ok) => {
                    if (ok) {
                      setReachable(true);
                      void scan(false);
                    }
                  });
                }}
              >
                <RefreshCw className="h-3.5 w-3.5" />
                Retry connection
              </Button>
              {canStart ? (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    void ensureOllamaReady().then((ok) => {
                      if (ok) {
                        setReachable(true);
                        void scan(false);
                      }
                    });
                  }}
                >
                  <Play className="h-3.5 w-3.5" />
                  Start Ollama silently
                </Button>
              ) : null}
              <Button variant="ghost" size="sm" onClick={() => void handleOpenTroubleshooting()}>
                Open Ollama app (last resort)
              </Button>
            </div>
          </div>
        ) : null}

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

        {notInstalled && !busy ? (
          <div className="flex items-start gap-2 rounded-md border border-warning/30 bg-warning/10 p-3">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
            <div>
              <p className="text-ui-strong text-foreground">Ollama is not installed yet</p>
              <p className="text-metadata text-muted-foreground">
                Click Download on any catalog model. VibeSpace asks for permission before installing
                Ollama from its official source, then pulls the model and connects it to chat
                automatically.
              </p>
            </div>
          </div>
        ) : null}

        {reachable === false && nativeStatus.installed !== false && bootstrap.phase === 'idle' ? (
          <div className="rounded-md border border-border bg-panel/60 px-3 py-2">
            <p className="text-metadata text-muted-foreground">
              Could not reach {ollamaBaseUrl()}. Jarvis checks the Ollama API directly — no tray
              icon required.
            </p>
            <div className="mt-2 flex flex-wrap gap-2">
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  invalidateOllamaBootstrap();
                  void scan(false);
                }}
              >
                <RefreshCw className="h-3.5 w-3.5" />
                Retry
              </Button>
              {canStart ? (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    void ensureOllamaReady().then((ok) => {
                      if (ok) {
                        setReachable(true);
                        void scan(false);
                      }
                    });
                  }}
                >
                  <Play className="h-3.5 w-3.5" />
                  Start silently
                </Button>
              ) : null}
            </div>
          </div>
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
            Downloaded models appear here and in the Jarvis chat model selector automatically.
          </p>
        </div>

        {installed.length > 0 ? (
          <div role="list" aria-label="Installed local models" className="grid max-w-xl gap-2">
            {installed.map((model) => {
              const selected = sameModel(defaultLocalModel, model.name);
              const compatibilityResult = compatibility.get(model.name);
              return (
                <div
                  key={model.name}
                  role="listitem"
                  className={cn(
                    'flex items-center gap-3 rounded-md border border-border bg-panel px-3 py-2 text-left',
                  )}
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-mono text-ui-strong text-foreground">
                      {model.name}
                    </span>
                    {model.size ? (
                      <span className="text-metadata text-muted-foreground">
                        {formatBytes(model.size)}
                      </span>
                    ) : null}
                    {compatibilityResult ? (
                      <span className="block text-metadata text-muted-foreground">
                        {compatibilityResult.reason}
                      </span>
                    ) : null}
                  </span>
                  <Badge variant="success">Available in Chat</Badge>
                  {compatibilityResult ? (
                    <Badge
                      variant={
                        compatibilityResult.status === 'agent_ready'
                          ? 'success'
                          : compatibilityResult.status === 'unsupported'
                            ? 'warning'
                            : 'outline'
                      }
                    >
                      {compatibilityLabel(compatibilityResult.status)}
                    </Badge>
                  ) : (
                    <Button
                      type="button"
                      size="sm"
                      variant="secondary"
                      aria-label="Check agent compatibility"
                      disabled={checkingCompatibility === model.name}
                      onClick={() => void checkModelCompatibility(model.name)}
                    >
                      {checkingCompatibility === model.name ? 'Checking…' : 'Check agent support'}
                    </Button>
                  )}
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    disabled={selected}
                    onClick={() => pickModel(model.name)}
                  >
                    {selected ? 'Local-only fallback' : 'Use for Fully Local'}
                  </Button>
                </div>
              );
            })}
          </div>
        ) : (
          <p className="text-metadata text-muted-foreground">
            {connected
              ? 'No models yet. Download one below.'
              : 'Start Ollama or click Download on any model.'}
          </p>
        )}
      </section>

      <Separator />

      <section className="flex flex-col gap-3">
        <div>
          <h3 className="flex items-center gap-2 text-ui-strong text-foreground">
            <HardDriveDownload className="h-4 w-4 text-accent-copper" />
            Model catalog
          </h3>
          <p className="text-secondary text-muted-foreground">
            Click Download — Jarvis handles starting Ollama, pulling the model, and registering it
            automatically.
          </p>
        </div>

        {activePull ? (
          <PullProgressCard
            state={activePull}
            onCancel={() => {
              for (const [, entry] of _downloads) {
                if (entry.status === 'downloading' && entry.abortController)
                  entry.abortController.abort();
              }
            }}
          />
        ) : null}

        <div className="grid max-w-2xl gap-2">
          {LOCAL_MODEL_CATALOG.map((model) => {
            const modelInstalled = isModelInstalled(installed, model.name);
            const dlEntry = downloadMap.get(model.name);
            const pullingThisModel = dlEntry?.status === 'downloading';
            const downloadFailed = dlEntry?.status === 'error';
            return (
              <div
                key={model.name}
                className={cn(
                  'flex flex-col gap-3 rounded-md border bg-panel px-3 py-3 sm:flex-row sm:items-center sm:justify-between',
                  model.recommended ? 'border-accent-copper/40' : 'border-border',
                )}
              >
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-ui-strong text-foreground">
                      {model.displayName}
                    </span>
                    <Badge variant={model.recommended ? 'accent' : 'outline'}>{model.label}</Badge>
                    <Badge variant="outline">{model.size}</Badge>
                    {modelInstalled ? (
                      <Badge variant="success">
                        <Check className="h-3 w-3" />
                        Installed
                      </Badge>
                    ) : null}
                    {downloadFailed ? (
                      <Badge variant="warning">
                        <AlertTriangle className="h-3 w-3" />
                        Failed
                      </Badge>
                    ) : null}
                  </div>
                  <p className="mt-1 text-metadata text-muted-foreground">{model.blurb}</p>
                  {model.hardware ? (
                    <div className="mt-2 grid gap-1 text-metadata text-muted-foreground">
                      <p>
                        {model.size} download · {model.hardware.ram} · {model.hardware.vram}
                      </p>
                      <p>
                        CPU-only: {model.hardware.cpuOnly} · Speed: {model.hardware.speedClass}
                      </p>
                      <p>
                        {model.contextTokens
                          ? `${Math.round(model.contextTokens / 1024)}K context`
                          : 'Context varies'}{' '}
                        · {model.license ?? 'See source for license'} ·{' '}
                        {model.quantizationOptions?.join(', ') || 'Runtime default quantization'}
                      </p>
                      {model.sourceUrl ? (
                        <a
                          href={model.sourceUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex w-fit items-center gap-1 text-accent-copper underline-offset-4 hover:underline"
                        >
                          Official model source
                          <ExternalLink className="h-3 w-3" />
                        </a>
                      ) : null}
                    </div>
                  ) : null}
                  {downloadFailed && dlEntry?.error ? (
                    <p className="mt-1 text-metadata text-red-400">{dlEntry.error}</p>
                  ) : null}
                </div>
                {modelInstalled ? (
                  <div className="flex w-full shrink-0 flex-wrap gap-1 sm:w-auto sm:justify-end">
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => pickModel(model.name)}
                      disabled={sameModel(defaultLocalModel, model.name)}
                    >
                      <Check className="h-3.5 w-3.5" />
                      {sameModel(defaultLocalModel, model.name)
                        ? 'Local-only fallback'
                        : 'Use for Fully Local'}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => void verifyModel(model.name)}
                      disabled={anyDownloading || busy}
                    >
                      Verify
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => void downloadModel(model.name, true)}
                      disabled={anyDownloading || busy}
                    >
                      Repair
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => void downloadModel(model.name, true)}
                      disabled={anyDownloading || busy}
                    >
                      Update
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => void removeModel(model.name)}
                      disabled={anyDownloading || busy}
                    >
                      Remove
                    </Button>
                  </div>
                ) : (
                  <Button
                    variant="secondary"
                    size="sm"
                    className="shrink-0"
                    onClick={() => void downloadModel(model.name)}
                    disabled={anyDownloading || busy}
                  >
                    <Download className={cn('h-3.5 w-3.5', pullingThisModel && 'animate-pulse')} />
                    {pullingThisModel
                      ? `Downloading ${catalogFamilyName(model.name)}`
                      : downloadFailed
                        ? 'Retry'
                        : 'Download'}
                  </Button>
                )}
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );
}

function ConnectionBadge({
  reachable,
  installed,
  scanning,
  busy,
  bootstrapStatus,
}: {
  reachable: boolean | null;
  installed: boolean | null;
  scanning: boolean;
  busy: boolean;
  bootstrapStatus?: string;
}) {
  if (busy) return <Badge variant="outline">{bootstrapStatus || 'Working…'}</Badge>;
  if (scanning || reachable === null) return <Badge variant="outline">Checking…</Badge>;
  if (reachable)
    return (
      <Badge variant="success">
        <Check className="h-3 w-3" />
        Ollama ready
      </Badge>
    );
  if (installed === false) return <Badge variant="warning">Not installed</Badge>;
  if (installed === true) return <Badge variant="warning">Installed, stopped</Badge>;
  return <Badge variant="outline">Not connected</Badge>;
}

function PullProgressCard({ state, onCancel }: { state: PullState; onCancel: () => void }) {
  const percent = state.percent === undefined ? null : Math.round(state.percent);
  const title = catalogDisplayName(state.model);
  return (
    <div className="max-w-2xl rounded-md border border-accent-cyan/35 bg-accent-cyan/5 p-3">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-ui-strong text-foreground">{title}</p>
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
            'h-full rounded-full bg-accent-gradient transition-[width] duration-300 [html[data-theme=monochrome]_&]:!bg-none [html[data-theme=monochrome]_&]:!bg-foreground',
            percent === null && 'animate-pulse',
          )}
          style={{ width: percent === null ? '18%' : `${percent}%` }}
        />
      </div>
      <p className="mt-2 text-metadata text-muted-foreground">
        Ollama does not support pausing a pull. Cancel is safe; retry restarts or reuses cached
        layers when the runtime supports it.
      </p>
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

function compatibilityLabel(status: LocalAgentCompatibilityResult['status']): string {
  switch (status) {
    case 'agent_ready':
      return 'Agent ready';
    case 'chat_only':
      return 'Chat only';
    case 'unsupported':
      return 'Unsupported';
    case 'unknown':
      return 'Unknown';
  }
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
