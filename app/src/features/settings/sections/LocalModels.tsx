import { useCallback, useEffect, useState } from 'react';
import {
  HardDriveDownload,
  RefreshCw,
  WifiOff,
  Check,
  Terminal as TerminalIcon,
  ExternalLink,
} from 'lucide-react';
import { useAuthStore } from '@/stores/auth';
import {
  listOllamaModels,
  isOllamaReachable,
  ollamaBaseUrl,
  OLLAMA_DEFAULT_BASE,
} from '@/lib/ai';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Separator } from '@/components/ui/separator';
import { Badge } from '@/components/ui/badge';
import { toast } from '@/components/ui/toast';
import { cn } from '@/lib/utils';

/**
 * Settings → Local Models.
 *
 * The "no key, no internet" path. Connects to a user-installed Ollama
 * daemon over its OpenAI-compatible API. Nothing is bundled — we detect a
 * local daemon, list its installed models, and let the user pick a default
 * + flip a global Offline toggle that forces all chat through the local
 * model regardless of any cloud keys.
 *
 * We deliberately don't try to download model weights from inside the app
 * (multi-GB pulls with their own progress protocol); instead we surface the
 * exact `ollama pull` command and a link to the model library. This keeps
 * the installer tiny and avoids shipping a sidecar runtime.
 */

// A few good starter models with rough on-disk sizes (Q4). Purely
// informational — the user pulls them via the Ollama CLI.
const SUGGESTED_MODELS: { name: string; size: string; blurb: string }[] = [
  { name: 'llama3.2', size: '~2 GB', blurb: 'Llama 3.2 3B — solid default, fast on most machines.' },
  { name: 'llama3.2:1b', size: '~1.3 GB', blurb: 'Llama 3.2 1B — for low-RAM machines.' },
  { name: 'qwen2.5:3b', size: '~1.9 GB', blurb: 'Qwen 2.5 3B — strong reasoning for its size.' },
  { name: 'phi3.5', size: '~2.2 GB', blurb: 'Phi 3.5 mini — compact, good at code.' },
  { name: 'gemma2:2b', size: '~1.6 GB', blurb: 'Gemma 2 2B — tiny, snappy replies.' },
];

export function LocalModels() {
  const offlineMode = useAuthStore((s) => s.offlineMode);
  const setOfflineMode = useAuthStore((s) => s.setOfflineMode);
  const defaultLocalModel = useAuthStore((s) => s.defaultLocalModel);
  const setDefaultLocalModel = useAuthStore((s) => s.setDefaultLocalModel);
  const storedBase = useAuthStore((s) => s.apiKeys.ollama ?? '');
  const setApiKey = useAuthStore((s) => s.setApiKey);

  const [baseDraft, setBaseDraft] = useState(storedBase || OLLAMA_DEFAULT_BASE);
  const [reachable, setReachable] = useState<boolean | null>(null);
  const [installed, setInstalled] = useState<string[]>([]);
  const [scanning, setScanning] = useState(false);

  useEffect(() => {
    setBaseDraft(storedBase || OLLAMA_DEFAULT_BASE);
  }, [storedBase]);

  const scan = useCallback(async () => {
    setScanning(true);
    const ok = await isOllamaReachable();
    setReachable(ok);
    setInstalled(ok ? await listOllamaModels() : []);
    setScanning(false);
  }, []);

  // Probe on mount.
  useEffect(() => {
    void scan();
  }, [scan]);

  function saveBase() {
    const trimmed = baseDraft.trim() || OLLAMA_DEFAULT_BASE;
    setApiKey('ollama', trimmed);
    toast.success('Local endpoint saved', trimmed);
    void scan();
  }

  function pickModel(name: string) {
    setDefaultLocalModel(name);
    toast.success('Default local model set', name);
  }

  function handleToggleOffline(v: boolean) {
    setOfflineMode(v);
    if (v) {
      toast.info(
        'Offline mode on',
        'All chat now runs through your local model. No internet, no API key.',
      );
    } else {
      toast.info('Offline mode off', 'Back to cloud providers (Gemini and your saved keys).');
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <header>
        <h2 className="text-page-title text-foreground">Local Models</h2>
        <p className="text-secondary text-muted-foreground mt-1">
          Run a model entirely on your machine — no API key, no internet, nothing leaves this
          device. Powered by{' '}
          <a
            href="https://ollama.com/download"
            target="_blank"
            rel="noreferrer"
            className="text-accent-copper underline-offset-4 hover:underline"
          >
            Ollama
          </a>
          .
        </p>
      </header>

      {/* Offline toggle */}
      <section className="flex items-start justify-between gap-4 rounded-md border border-border bg-panel px-4 py-3">
        <div className="flex items-start gap-3 min-w-0">
          <WifiOff
            className={cn(
              'h-4 w-4 mt-0.5 shrink-0',
              offlineMode ? 'text-accent-cyan' : 'text-muted-foreground',
            )}
          />
          <div className="min-w-0">
            <Label htmlFor="offline-toggle" className="text-ui-strong text-foreground cursor-pointer">
              Offline mode
            </Label>
            <p className="text-metadata text-muted-foreground mt-0.5">
              Force every chat through your local model and ignore all cloud providers. Great on a
              plane or when you want zero data to leave the machine.
            </p>
          </div>
        </div>
        <Switch
          id="offline-toggle"
          checked={offlineMode}
          onCheckedChange={handleToggleOffline}
          aria-label="Toggle offline mode"
        />
      </section>

      <Separator />

      {/* Connection */}
      <section className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-ui-strong text-foreground">Connection</h3>
          <span className="flex items-center gap-1.5">
            {reachable === null ? (
              <Badge variant="outline">Checking…</Badge>
            ) : reachable ? (
              <Badge variant="success">
                <Check className="h-3 w-3" />
                Connected
              </Badge>
            ) : (
              <Badge variant="outline">Not running</Badge>
            )}
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => void scan()}
              disabled={scanning}
              aria-label="Re-scan local daemon"
            >
              <RefreshCw className={cn('h-3.5 w-3.5', scanning && 'animate-spin')} />
            </Button>
          </span>
        </div>
        <div className="flex items-center gap-2">
          <Input
            value={baseDraft}
            onChange={(e) => setBaseDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
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
        {reachable === false && (
          <p className="text-metadata text-muted-foreground">
            Couldn't reach Ollama at {ollamaBaseUrl()}. Install it, then run{' '}
            <code className="font-mono text-accent-copper">ollama serve</code>. In a packaged build
            you may also need{' '}
            <code className="font-mono text-accent-copper">OLLAMA_ORIGINS=*</code> so the app is
            allowed to connect.
          </p>
        )}
      </section>

      <Separator />

      {/* Installed models / default picker */}
      <section className="flex flex-col gap-3">
        <div>
          <h3 className="text-ui-strong text-foreground">Default local model</h3>
          <p className="text-secondary text-muted-foreground">
            Used for chat when offline mode is on (or an agent is pinned to the local provider).
          </p>
        </div>

        {installed.length > 0 ? (
          <div role="radiogroup" aria-label="Installed local models" className="grid gap-2 max-w-xl">
            {installed.map((name) => {
              const selected = defaultLocalModel === name;
              return (
                <button
                  type="button"
                  key={name}
                  role="radio"
                  aria-checked={selected}
                  onClick={() => pickModel(name)}
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
                      'h-3.5 w-3.5 rounded-full border flex items-center justify-center shrink-0',
                      selected ? 'border-transparent bg-accent-gradient' : 'border-border-mid bg-background',
                    )}
                  >
                    {selected && <Check className="h-2.5 w-2.5 text-white" strokeWidth={3} />}
                  </span>
                  <span className="text-ui-strong text-foreground font-mono">{name}</span>
                </button>
              );
            })}
          </div>
        ) : (
          <p className="text-metadata text-muted-foreground">
            {reachable
              ? 'No models installed yet. Pull one below, then re-scan.'
              : 'Connect to a running Ollama daemon to see your installed models.'}
          </p>
        )}

        {/* Manual override — lets the user type a model name even if not detected */}
        <div className="flex items-center gap-2 max-w-xl">
          <Input
            value={defaultLocalModel}
            onChange={(e) => setDefaultLocalModel(e.target.value)}
            placeholder="llama3.2"
            className="font-mono"
            spellCheck={false}
            autoComplete="off"
            aria-label="Default local model name"
          />
          <span className="text-metadata text-muted-foreground shrink-0">manual override</span>
        </div>
      </section>

      <Separator />

      {/* Suggested models — pull via CLI */}
      <section className="flex flex-col gap-3">
        <div>
          <h3 className="text-ui-strong text-foreground flex items-center gap-2">
            <HardDriveDownload className="h-4 w-4 text-accent-copper" />
            Download a model
          </h3>
          <p className="text-secondary text-muted-foreground">
            Pull any of these with the Ollama CLI, then re-scan. Browse the full{' '}
            <a
              href="https://ollama.com/library"
              target="_blank"
              rel="noreferrer"
              className="text-accent-copper underline-offset-4 hover:underline inline-flex items-center gap-0.5"
            >
              model library <ExternalLink className="h-3 w-3" />
            </a>
            .
          </p>
        </div>
        <div className="grid gap-2 max-w-xl">
          {SUGGESTED_MODELS.map((m) => (
            <div
              key={m.name}
              className="flex items-center justify-between gap-3 rounded-md border border-border bg-panel px-3 py-2"
            >
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-ui-strong text-foreground font-mono">{m.name}</span>
                  <Badge variant="outline">{m.size}</Badge>
                  {installed.includes(m.name) && (
                    <Badge variant="success">
                      <Check className="h-3 w-3" />
                      Installed
                    </Badge>
                  )}
                </div>
                <p className="text-metadata text-muted-foreground mt-0.5 truncate">{m.blurb}</p>
              </div>
              <Button
                variant="ghost"
                size="sm"
                className="shrink-0 font-mono"
                onClick={() => {
                  void navigator.clipboard?.writeText(`ollama pull ${m.name}`);
                  toast.success('Copied', `ollama pull ${m.name}`);
                }}
              >
                <TerminalIcon className="h-3.5 w-3.5" />
                Copy pull
              </Button>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
