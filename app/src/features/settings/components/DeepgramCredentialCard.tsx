import { useEffect, useRef, useState } from 'react';
import { AlertCircle, Check, ExternalLink, RefreshCw, ShieldCheck, Trash2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { toast } from '@/components/ui/toast';
import {
  DEEPGRAM_CREDENTIAL_EVENT,
  fetchDeepgramProjectUsage,
  getDeepgramApiKey,
  loadDeepgramCredential,
  readDeepgramLocalUsage,
  removeDeepgramCredential,
  saveDeepgramCredential,
  testDeepgramCredential,
  type DeepgramCredentialSnapshot,
} from '@/lib/deepgram';
import { cn } from '@/lib/utils';
import { DeepgramBrandMark } from './DeepgramBrandMark';

export interface DeepgramCredentialCardProps {
  compact?: boolean;
  showUsage?: boolean;
  className?: string;
}

const MISSING: DeepgramCredentialSnapshot = { configured: false, health: 'missing' };

function statusMessage(snapshot: DeepgramCredentialSnapshot): string | null {
  if (snapshot.health === 'invalid') {
    return snapshot.errorCode === 'permission'
      ? 'The key cannot read Deepgram projects. Replace it with a key that has the required project scope.'
      : 'This Deepgram key is invalid or revoked. Replace it or remove it.';
  }
  if (snapshot.health === 'unreachable') {
    return snapshot.errorCode === 'storage'
      ? 'Secure credential storage is unavailable. Your key was not exposed or copied elsewhere.'
      : 'Deepgram could not be reached. The stored key was preserved; retry when the connection recovers.';
  }
  return null;
}

export function DeepgramCredentialCard({
  compact = false,
  showUsage = false,
  className,
}: DeepgramCredentialCardProps) {
  const [snapshot, setSnapshot] = useState<DeepgramCredentialSnapshot>(MISSING);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [replacing, setReplacing] = useState(false);
  const keyInputRef = useRef<HTMLInputElement>(null);
  const [hasDraft, setHasDraft] = useState(false);
  const [usage, setUsage] = useState<{
    loading: boolean;
    hours?: number;
    requests?: number;
    checkedAt?: string;
    unavailable?: boolean;
  }>({ loading: false });

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const loaded = await loadDeepgramCredential();
      const next = loaded.configured ? await testDeepgramCredential() : loaded;
      if (!cancelled) {
        setSnapshot(next);
        setLoading(false);
      }
    })();
    const onChanged = (event: Event) => {
      const next = (event as CustomEvent<DeepgramCredentialSnapshot>).detail;
      if (next && typeof next.configured === 'boolean') setSnapshot(next);
    };
    window.addEventListener(DEEPGRAM_CREDENTIAL_EVENT, onChanged);
    return () => {
      cancelled = true;
      window.removeEventListener(DEEPGRAM_CREDENTIAL_EVENT, onChanged);
    };
  }, []);

  useEffect(() => {
    if (!showUsage || snapshot.health !== 'connected') return;
    if (!snapshot.projectId) {
      setUsage({ loading: false, unavailable: true, checkedAt: new Date().toISOString() });
      return;
    }
    let cancelled = false;
    setUsage({ loading: true });
    void (async () => {
      const key = await getDeepgramApiKey();
      if (!key) throw new Error('missing');
      return fetchDeepgramProjectUsage(key, snapshot.projectId!);
    })()
      .then((live) => {
        if (!cancelled) {
          setUsage({
            loading: false,
            hours: live.sttHours,
            requests: live.sttRequests,
            checkedAt: new Date().toISOString(),
          });
        }
      })
      .catch(() => {
        if (!cancelled) {
          setUsage({
            loading: false,
            unavailable: true,
            checkedAt: new Date().toISOString(),
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [showUsage, snapshot.health, snapshot.projectId]);

  const save = async () => {
    const key = keyInputRef.current?.value.trim() ?? '';
    if (!key) {
      toast.warning('Enter a Deepgram API key first.');
      return;
    }
    setBusy(true);
    try {
      const next = await saveDeepgramCredential(key);
      setSnapshot(next);
      if (keyInputRef.current) keyInputRef.current.value = '';
      setHasDraft(false);
      if (next.health === 'connected') {
        setReplacing(false);
        toast.success('Deepgram connected', 'Saved in secure platform credential storage.');
      } else if (next.health === 'invalid') {
        toast.error('Deepgram rejected the key', 'The key was not saved.');
      } else {
        toast.warning('Deepgram unavailable', 'The key was not saved. Check your connection.');
      }
    } finally {
      setBusy(false);
    }
  };

  const test = async () => {
    setBusy(true);
    try {
      const next = await testDeepgramCredential();
      setSnapshot(next);
      if (next.health === 'connected') toast.success('Deepgram connection verified');
      else if (next.health === 'invalid') toast.error('Deepgram key is invalid or revoked');
      else toast.warning('Deepgram test unavailable', 'The saved key was preserved.');
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    try {
      const next = await removeDeepgramCredential();
      setSnapshot(next);
      if (keyInputRef.current) keyInputRef.current.value = '';
      setHasDraft(false);
      setReplacing(false);
      if (next.health === 'missing') toast.info('Deepgram key removed from secure storage');
      else toast.error('Could not remove Deepgram key', 'Secure storage is unavailable.');
    } finally {
      setBusy(false);
    }
  };

  const showInput = !snapshot.configured || replacing;
  const message = statusMessage(snapshot);

  return (
    <section
      className={cn(
        'jarvis-deepgram-credential-card rounded-lg border border-border bg-panel/80 p-4',
        compact && 'p-3',
        className,
      )}
      aria-label="Deepgram provider credential"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <DeepgramBrandMark className="mt-0.5 h-7 w-7" />
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h4 className="text-ui-strong text-foreground">Deepgram</h4>
              {loading ? (
                <Badge variant="outline">Checking…</Badge>
              ) : snapshot.configured && snapshot.health !== 'invalid' ? (
                <Badge variant="success" className="gap-1">
                  <Check className="h-3 w-3" />
                  Connected
                </Badge>
              ) : snapshot.health === 'invalid' ? (
                <Badge variant="destructive">Needs attention</Badge>
              ) : (
                <Badge variant="outline">Not connected</Badge>
              )}
            </div>
            <p className="text-metadata text-muted-foreground">
              Speech-to-text (Nova/Flux) · text-to-speech (Aura) · voice services
            </p>
            {snapshot.projectName ? (
              <p className="mt-1 text-metadata text-muted-foreground">{snapshot.projectName}</p>
            ) : null}
          </div>
        </div>
        <a
          href="https://console.deepgram.com/project/default/keys"
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 text-metadata text-accent-cyan hover:underline"
        >
          Get a key
          <ExternalLink className="h-3 w-3" />
        </a>
      </div>

      {message ? (
        <p
          className="mt-3 flex items-start gap-2 text-metadata text-warning"
          role={snapshot.health === 'invalid' ? 'alert' : 'status'}
        >
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          {message}
        </p>
      ) : null}

      {showInput ? (
        <div className="mt-3 flex flex-col gap-2 sm:flex-row">
          <div className="min-w-0 flex-1">
            <Label htmlFor="deepgram-central-key" className="sr-only">
              Deepgram API key
            </Label>
            <Input
              id="deepgram-central-key"
              ref={keyInputRef}
              type="password"
              onChange={(event) => setHasDraft(Boolean(event.currentTarget.value.trim()))}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  void save();
                }
              }}
              placeholder="Paste a Deepgram API key"
              autoComplete="off"
              spellCheck={false}
              data-jarvis-api-key="true"
            />
          </div>
          <Button type="button" size="sm" disabled={busy || !hasDraft} onClick={() => void save()}>
            <ShieldCheck className="h-3.5 w-3.5" />
            {snapshot.configured ? 'Validate replacement' : 'Connect Deepgram'}
          </Button>
        </div>
      ) : null}

      {snapshot.configured ? (
        <div className="mt-3 flex flex-wrap gap-2">
          <Button
            type="button"
            size="sm"
            variant="secondary"
            disabled={busy}
            aria-label="Test Deepgram"
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
              aria-label="Replace Deepgram key"
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
            aria-label="Remove Deepgram key"
            className="text-muted-foreground hover:text-destructive"
            onClick={() => void remove()}
          >
            <Trash2 className="h-3.5 w-3.5" />
            Remove
          </Button>
        </div>
      ) : null}

      {showUsage ? (
        <DeepgramUsageSummary
          live={usage}
          local={readDeepgramLocalUsage()}
          configured={snapshot.configured}
        />
      ) : null}

      <p className="mt-3 text-[11px] text-muted-foreground">
        Desktop keys stay in the operating-system credential vault. Browser preview is session-only.
        VibeSpace never displays, copies, logs, or syncs the saved key.
      </p>
    </section>
  );
}

function DeepgramUsageSummary({
  live,
  local,
  configured,
}: {
  live: {
    loading: boolean;
    hours?: number;
    requests?: number;
    checkedAt?: string;
    unavailable?: boolean;
  };
  local: ReturnType<typeof readDeepgramLocalUsage>;
  configured: boolean;
}) {
  return (
    <div className="mt-3 grid gap-2 border-t border-border/70 pt-3 text-metadata text-muted-foreground sm:grid-cols-2">
      <div>
        <p className="font-medium text-foreground">VibeSpace estimate</p>
        <p>
          {(local.seconds / 60).toFixed(1)} min · {local.requests} request
          {local.requests === 1 ? '' : 's'} · ${local.estimatedCostUsd.toFixed(4)}
        </p>
        <p>Only STT sessions started by this app on this device.</p>
      </div>
      <div>
        <p className="font-medium text-foreground">Deepgram project usage</p>
        {!configured ? (
          <p>Connect a key to request provider-reported usage.</p>
        ) : live.loading ? (
          <p>Loading provider usage…</p>
        ) : typeof live.hours === 'number' ? (
          <>
            <p>
              {live.hours.toFixed(2)} hr · {live.requests ?? 0} STT requests (last 30 days)
            </p>
            <p>
              Checked {live.checkedAt ? new Date(live.checkedAt).toLocaleString() : 'just now'}.
            </p>
          </>
        ) : (
          <>
            <p>
              Live usage unavailable for this key or project scope. The VibeSpace estimate remains
              available.
            </p>
            {live.checkedAt ? (
              <p>Last attempted {new Date(live.checkedAt).toLocaleString()}.</p>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}
