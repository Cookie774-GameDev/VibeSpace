import { useEffect, useRef, useState } from 'react';
import {
  AlertCircle,
  Check,
  ExternalLink,
  RefreshCw,
  ShieldCheck,
  Trash2,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { toast } from '@/components/ui/toast';
import { resolveAccountIdentity } from '@/lib/accountIdentity';
import {
  getJevLocalUsage,
  loadJevSettings,
  removeJevApiKey,
  saveJevApiKey,
  setJevModel,
  testJevConnection,
  type JevConnectionTestResult,
  type JevLocalUsageRecord,
} from '@/lib/jev';
import {
  getJevCredentialStatus,
  type JevHttpKind,
  type JevModelOption,
} from '@/lib/security/jevCredentialStore';
import { useAuthStore } from '@/stores/auth';
import { cn } from '@/lib/utils';

export interface JevLocalUsageSummary {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
  lastUsed: number | null;
}

export interface JevCredentialCardProps {
  className?: string;
}

const EMPTY_USAGE: JevLocalUsageSummary = {
  calls: 0,
  inputTokens: 0,
  outputTokens: 0,
  costUsd: null,
  lastUsed: null,
};

function summarizeLocalUsage(records: readonly JevLocalUsageRecord[]): JevLocalUsageSummary {
  let inputTokens = 0;
  let outputTokens = 0;
  let costUsd = 0;
  let hasCost = false;
  let lastUsed: number | null = null;
  for (const record of records) {
    if (record.inputTokens !== null) inputTokens += record.inputTokens;
    if (record.outputTokens !== null) outputTokens += record.outputTokens;
    if (record.costUsd !== null) {
      costUsd += record.costUsd;
      hasCost = true;
    }
    if (lastUsed === null || record.recordedAt > lastUsed) lastUsed = record.recordedAt;
  }
  return {
    calls: records.length,
    inputTokens,
    outputTokens,
    costUsd: hasCost ? costUsd : null,
    lastUsed,
  };
}

type CardHealth =
  | 'loading'
  | 'native-unavailable'
  | 'missing'
  | 'saved'
  | 'connected'
  | 'invalid'
  | 'forbidden'
  | 'network'
  | 'provider-error'
  | 'malformed'
  | 'storage-error';

type LocalUsageState = 'loading' | 'available' | 'unavailable';

function healthFromProbe(kind: JevHttpKind): CardHealth {
  switch (kind) {
    case 'connected':
      return 'connected';
    case 'missing_key':
      return 'missing';
    case 'invalid_key':
      return 'invalid';
    case 'forbidden':
      return 'forbidden';
    case 'storage_error':
      return 'storage-error';
    case 'malformed':
    case 'response_too_large':
      return 'malformed';
    case 'network':
    case 'provider_error':
    case 'request_too_large':
    case 'invalid_request':
    case 'ok':
      return 'network';
  }
}

function healthBadge(health: CardHealth): {
  label: string;
  variant: 'outline' | 'success' | 'destructive' | 'warning';
} {
  switch (health) {
    case 'loading':
      return { label: 'Checking…', variant: 'outline' };
    case 'native-unavailable':
      return { label: 'Desktop app required', variant: 'warning' };
    case 'missing':
      return { label: 'Not connected', variant: 'outline' };
    case 'saved':
      return { label: 'Saved · untested', variant: 'outline' };
    case 'connected':
      return { label: 'Connected', variant: 'success' };
    case 'invalid':
      return { label: 'Key rejected', variant: 'destructive' };
    case 'forbidden':
      return { label: 'Access denied', variant: 'warning' };
    case 'storage-error':
      return { label: 'Vault unavailable', variant: 'destructive' };
    case 'malformed':
      return { label: 'Invalid response', variant: 'warning' };
    case 'network':
    case 'provider-error':
      return { label: 'Connection unavailable', variant: 'warning' };
  }
}

function healthMessage(health: CardHealth): string | null {
  switch (health) {
    case 'native-unavailable':
      return 'Jev secure settings require the installed VibeSpace desktop app. No browser key fallback is enabled.';
    case 'saved':
      return 'The key is stored in the native credential vault. Test it to verify the TypeSafe connection.';
    case 'invalid':
      return 'TypeSafe rejected the saved key. Replace it or remove it.';
    case 'forbidden':
      return 'TypeSafe denied this key. Check its scope or account access, then test again.';
    case 'storage-error':
      return 'The native credential vault is unavailable. The key was not exposed or copied elsewhere.';
    case 'malformed':
      return 'TypeSafe returned an invalid or oversized response. The saved key was preserved.';
    case 'network':
    case 'provider-error':
      return 'TypeSafe could not be reached. The saved key was preserved; retry when the connection recovers.';
    default:
      return null;
  }
}

function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return String(value);
}

function formatLocalUsage(usage: JevLocalUsageSummary): string {
  if (usage.calls === 0) return 'No local Jev usage recorded yet.';
  const parts = [
    `${usage.calls} call${usage.calls === 1 ? '' : 's'}`,
    `${formatTokens(usage.inputTokens)} input tokens`,
    `${formatTokens(usage.outputTokens)} output tokens`,
  ];
  if (usage.costUsd !== null) parts.push(`$${usage.costUsd.toFixed(4)} recorded cost`);
  return parts.join(' · ');
}

export function JevCredentialCard({ className }: JevCredentialCardProps) {
  const [health, setHealth] = useState<CardHealth>('loading');
  const [draft, setDraft] = useState('');
  const [replacing, setReplacing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [models, setModels] = useState<readonly JevModelOption[]>([]);
  const [modelId, setModelId] = useState('');
  const [localUsage, setLocalUsage] = useState(EMPTY_USAGE);
  const [localUsageState, setLocalUsageState] = useState<LocalUsageState>('loading');
  const keyInputRef = useRef<HTMLInputElement>(null);
  const cloudSession = useAuthStore((state) => state.cloudSession);
  const localUserId = useAuthStore((state) => state.localUserId);
  const workspaceId = useAuthStore((state) => state.workspaceId);
  const accountIdentity = resolveAccountIdentity({ cloudSession, localUserId });
  const scope =
    accountIdentity && workspaceId
      ? { accountId: accountIdentity.accountId, workspaceId: String(workspaceId) }
      : undefined;

  useEffect(() => {
    let cancelled = false;
    setHealth('loading');
    setModels([]);
    setLocalUsageState('loading');
    void (async () => {
      const status = await getJevCredentialStatus();
      if (cancelled) return;
      if (!status.available) {
        setHealth('native-unavailable');
        setLocalUsageState('unavailable');
        return;
      }
      if (status.error) {
        setHealth('storage-error');
        setLocalUsageState('unavailable');
        return;
      }
      try {
        const [settings, usage] = await Promise.all([
          loadJevSettings(scope),
          scope ? getJevLocalUsage(scope) : Promise.resolve(null),
        ]);
        if (cancelled) return;
        setModelId(settings.modelId);
        if (usage) {
          setLocalUsage(summarizeLocalUsage(usage));
          setLocalUsageState('available');
        } else {
          setLocalUsage(EMPTY_USAGE);
          setLocalUsageState('unavailable');
        }
        setHealth(status.configured ? (settings.connected ? 'connected' : 'saved') : 'missing');
      } catch {
        if (!cancelled) {
          setHealth('storage-error');
          setLocalUsageState('unavailable');
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [accountIdentity?.accountId, scope?.workspaceId]);

  const save = async () => {
    const key = draft.trim();
    if (!key) {
      toast.warning('Enter a Jev API key first.');
      return;
    }
    setBusy(true);
    try {
      await saveJevApiKey(key);
      setDraft('');
      if (keyInputRef.current) keyInputRef.current.value = '';
      setReplacing(false);
      setHealth('saved');
      toast.success('Jev key saved', 'Stored in the native credential vault.');
    } catch {
      setHealth('storage-error');
      toast.error(
        'Jev key was not saved',
        'Secure storage could not verify the key. Your previous connection was preserved.',
      );
    } finally {
      setBusy(false);
    }
  };

  const test = async () => {
    setBusy(true);
    try {
      const result: JevConnectionTestResult = await testJevConnection(scope);
      const nextHealth = healthFromProbe(result.kind);
      setHealth(nextHealth);
      setModels(result.models);
      let modelChanged = false;
      if (result.models.length > 0) {
        const nextModel = result.models.some((model) => model.id === modelId)
          ? modelId
          : result.models[0]!.id;
        if (nextModel && nextModel !== modelId) {
          const previousModel = modelId;
          setModelId(nextModel);
          try {
            await setJevModel(nextModel, scope);
            modelChanged = true;
          } catch {
            setModelId(previousModel);
            toast.warning(
              'Jev model was not saved',
              'The catalog is available; the selected model will be retried.',
            );
          }
        }
      }
      if (nextHealth === 'connected' && modelChanged) {
        setHealth('saved');
        toast.success('Jev catalog loaded', 'Test again after choosing a decision model.');
      } else if (nextHealth === 'connected') toast.success('Jev connection verified');
      else if (nextHealth === 'invalid') toast.error('Jev key is invalid or revoked');
      else
        toast.warning(
          'Jev test unavailable',
          healthMessage(nextHealth) ?? 'The saved key was preserved.',
        );
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    try {
      await removeJevApiKey();
      setDraft('');
      setModels([]);
      setModelId('');
      setReplacing(false);
      setHealth('missing');
      toast.info('Jev key removed from secure storage');
    } finally {
      setBusy(false);
    }
  };

  const chooseModel = async (next: string) => {
    const previous = modelId;
    setModelId(next);
    try {
      await setJevModel(next, scope);
      setHealth('saved');
    } catch {
      setModelId(previous);
      toast.error('Jev model was not saved', 'The previous CAO profile remains selected.');
    }
  };

  const showInput = health === 'missing' || replacing || health === 'native-unavailable';
  const badge = healthBadge(health);
  const message = healthMessage(health);

  return (
    <section
      className={cn(
        'jarvis-jev-credential-card rounded-lg border border-border bg-panel/80 p-4',
        className,
      )}
      aria-label="Jev decision provider credential"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <div className="mt-0.5 flex h-7 w-7 items-center justify-center rounded-md border border-accent-violet/30 bg-accent-violet/10 text-accent-violet">
            <img src="/brands/typesafe.png" alt="TypeSafe AI" className="h-5 w-5 rounded-sm" />
          </div>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h4 className="text-ui-strong text-foreground">Jev / TypeSafe AI</h4>
              <Badge variant={badge.variant}>{badge.label}</Badge>
            </div>
            <p className="text-metadata text-muted-foreground">
              Decision and automation checks for CAO · never a normal chat provider
            </p>
          </div>
        </div>
        <a
          href="https://typesafe.ai/"
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 text-metadata text-accent-cyan hover:underline"
        >
          TypeSafe AI
          <ExternalLink className="h-3 w-3" />
        </a>
      </div>

      {message ? (
        <p className="mt-3 flex items-start gap-2 text-metadata text-warning" role="status">
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          {message}
        </p>
      ) : null}

      {showInput ? (
        <div className="mt-3 flex flex-col gap-2 sm:flex-row">
          <div className="min-w-0 flex-1">
            <Label htmlFor="jev-central-key" className="sr-only">
              Jev API key
            </Label>
            <Input
              id="jev-central-key"
              ref={keyInputRef}
              type="password"
              value={draft}
              onChange={(event) => setDraft(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  void save();
                }
              }}
              placeholder="Paste a TypeSafe API key"
              autoComplete="off"
              spellCheck={false}
              data-jarvis-api-key="true"
            />
          </div>
          <Button
            type="button"
            size="sm"
            disabled={busy || !draft.trim()}
            onClick={() => void save()}
          >
            <ShieldCheck className="h-3.5 w-3.5" />
            {health === 'native-unavailable'
              ? 'Use desktop app'
              : health === 'missing'
                ? 'Connect Jev'
                : 'Save replacement'}
          </Button>
        </div>
      ) : null}

      {health !== 'missing' && health !== 'native-unavailable' && health !== 'loading' ? (
        <div className="mt-3 flex flex-wrap gap-2">
          <Button
            type="button"
            size="sm"
            variant="secondary"
            disabled={busy}
            aria-label="Test Jev connection"
            onClick={() => void test()}
          >
            <RefreshCw className={cn('h-3.5 w-3.5', busy && 'animate-spin')} />
            Test
          </Button>
          {!replacing ? (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              aria-label="Replace Jev key"
              disabled={busy}
              onClick={() => setReplacing(true)}
            >
              Replace
            </Button>
          ) : null}
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={busy}
            aria-label="Remove Jev key"
            className="text-muted-foreground hover:text-destructive"
            onClick={() => void remove()}
          >
            <Trash2 className="h-3.5 w-3.5" />
            Remove
          </Button>
        </div>
      ) : null}

      {models.length > 0 ? (
        <div className="mt-3 border-t border-border/70 pt-3">
          <Label htmlFor="jev-model-select" className="text-metadata text-muted-foreground">
            Jev decision model
          </Label>
          <select
            id="jev-model-select"
            value={modelId || models[0]?.id || ''}
            onChange={(event) => void chooseModel(event.currentTarget.value)}
            className="mt-1 flex h-8 w-full rounded-md border border-input bg-background px-2.5 text-body text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring sm:max-w-sm"
          >
            {models.map((model) => (
              <option key={model.id} value={model.id}>
                {model.label ? `${model.label} (${model.id})` : model.id}
              </option>
            ))}
          </select>
          <p className="mt-1 text-[10px] text-muted-foreground">
            Models come from the verified TypeSafe catalog. CAO keeps the selected model in its own
            account-scoped profile when a profile adapter is connected.
          </p>
        </div>
      ) : null}

      <div className="mt-3 border-t border-border/70 pt-3 text-metadata text-muted-foreground">
        <p className="font-medium text-foreground">Local Jev usage</p>
        <p>
          {localUsageState === 'unavailable'
            ? 'Local usage is unavailable until an account and workspace are active.'
            : formatLocalUsage(localUsage)}
        </p>
        {localUsageState === 'available' && localUsage.calls > 0 ? (
          <p>
            Last used{' '}
            {localUsage.lastUsed ? new Date(localUsage.lastUsed).toLocaleString() : 'unknown'}
          </p>
        ) : null}
        <p>
          Usage is recorded by VibeSpace on this device. Provider balance is not available here.
        </p>
      </div>

      <p className="mt-3 text-[11px] text-muted-foreground">
        Desktop keys stay in the operating-system credential vault. VibeSpace never displays,
        copies, logs, syncs, or returns the saved Jev key to the renderer.
      </p>
    </section>
  );
}
