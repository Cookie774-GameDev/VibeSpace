import * as React from 'react';
import { ExternalLink, Loader2, MonitorUp, RotateCcw, ShieldCheck, Square } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import {
  OPEN_IN_TERMINAL_PROVIDERS,
  buildLaunchPlan,
  getOpenInTerminalRuntime,
  loadPersistedRun,
  type OpenInTerminalProviderId,
  type OpenInTerminalRuntime,
  type OpenTerminalProviderDetection,
  type OpenTerminalSession,
} from './openInTerminal';

type Stage = 'configure' | 'review' | 'launching' | 'result';

export function OpenInTerminalDialog({
  open,
  onOpenChange,
  runtime: suppliedRuntime,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  runtime?: OpenInTerminalRuntime;
}) {
  const [runtime, setRuntime] = React.useState<OpenInTerminalRuntime | null>(
    suppliedRuntime ?? null,
  );
  const [detection, setDetection] = React.useState<OpenTerminalProviderDetection | null>(null);
  const [sessions, setSessions] = React.useState<OpenTerminalSession[]>([]);
  const [stage, setStage] = React.useState<Stage>('configure');
  const [desiredTotal, setDesiredTotal] = React.useState(1);
  const [providerId, setProviderId] = React.useState<OpenInTerminalProviderId | 'custom'>(
    'opencode',
  );
  const [customPath, setCustomPath] = React.useState('');
  const [directory, setDirectory] = React.useState('');
  const [followUp, setFollowUp] = React.useState('');
  const [error, setError] = React.useState('');
  const [progress, setProgress] = React.useState({ completed: 0, total: 0 });
  const cancelRequestedRef = React.useRef(false);
  const [result, setResult] = React.useState<Awaited<
    ReturnType<OpenInTerminalRuntime['launch']>
  > | null>(null);

  const refresh = React.useCallback(async () => {
    setError('');
    try {
      const resolved = suppliedRuntime ?? runtime ?? (await getOpenInTerminalRuntime());
      setRuntime(resolved);
      const [nextDetection, nextSessions] = await Promise.all([
        resolved.detect(),
        resolved.inspect(),
      ]);
      setDetection(nextDetection);
      setSessions(nextSessions);
      const first = nextDetection.available[0];
      if (first && !nextDetection.available.some((item) => item.id === providerId)) {
        setProviderId(first.id);
      }
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : 'Terminal providers could not be inspected.',
      );
    }
  }, [providerId, runtime, suppliedRuntime]);

  React.useEffect(() => {
    if (!open) return;
    setStage('configure');
    setResult(null);
    void refresh();
  }, [open, refresh]);

  const provider = OPEN_IN_TERMINAL_PROVIDERS.find((item) => item.id === providerId);
  const available = new Set(detection?.available.map((item) => item.id) ?? []);
  const providerCommand =
    providerId === 'custom' ? customPath.trim() : (provider?.executable ?? '');
  const preview = React.useMemo(() => {
    if (!providerCommand) return null;
    try {
      return buildLaunchPlan({
        desiredTotal,
        providerId,
        providerCommand,
        directory,
        followUp,
        sessions,
        now: Date.now(),
        platform: navigator.userAgent.includes('Windows') ? 'windows' : 'unix',
      });
    } catch {
      return null;
    }
  }, [desiredTotal, directory, followUp, providerCommand, providerId, sessions]);
  const canReview =
    Boolean(runtime && preview) &&
    (providerId === 'custom' ? Boolean(customPath.trim()) : available.has(providerId));

  const approve = async () => {
    if (!runtime || !canReview) return;
    setStage('launching');
    cancelRequestedRef.current = false;
    setProgress({ completed: 0, total: preview?.launchCount ?? 0 });
    setError('');
    try {
      const launched = await runtime.launch(
        {
          desiredTotal,
          providerId,
          providerCommand,
          directory,
          followUp,
        },
        {
          shouldCancel: () => cancelRequestedRef.current,
          onProgress: (completed, total) => setProgress({ completed, total }),
        },
      );
      if (launched.cancelled && launched.executionIds.length) {
        await runtime.cancel(launched.executionIds);
      }
      setResult(launched);
      setStage('result');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The terminal launch failed.');
      setStage('result');
    }
  };

  const cancel = async () => {
    cancelRequestedRef.current = true;
    if (runtime && result?.executionIds.length) await runtime.cancel(result.executionIds);
    if (stage !== 'launching') onOpenChange(false);
  };

  const retry = async () => {
    if (runtime && result?.executionIds.length) await runtime.cancel(result.executionIds);
    setResult(null);
    setError('');
    setStage('configure');
    await refresh();
  };

  const recovered = open ? loadPersistedRun() : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <MonitorUp className="h-5 w-5 text-accent-copper" />
            Open in Terminal
          </DialogTitle>
          <DialogDescription>
            Add terminal-agent sessions without closing or replacing terminals already working in
            this project.
          </DialogDescription>
        </DialogHeader>

        {recovered && (
          <div className="rounded-md border border-border bg-panel px-3 py-2 text-xs text-muted-foreground">
            Last launch: {recovered.executionIds.length} queued · {recovered.state}
          </div>
        )}

        {stage === 'configure' && (
          <div className="space-y-5">
            <fieldset>
              <legend className="mb-2 text-sm font-medium">Desired project total</legend>
              <div className="grid grid-cols-10 gap-1" aria-label="Terminal count">
                {Array.from({ length: 10 }, (_, index) => index + 1).map((count) => (
                  <button
                    key={count}
                    type="button"
                    aria-pressed={desiredTotal === count}
                    onClick={() => setDesiredTotal(count)}
                    className={cn(
                      'h-9 rounded border text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                      desiredTotal === count
                        ? 'border-accent-copper bg-accent-copper/10 text-foreground'
                        : 'border-border bg-paper text-muted-foreground hover:text-foreground',
                    )}
                  >
                    {count}
                  </button>
                ))}
              </div>
              <p className="mt-2 text-xs text-muted-foreground">
                {sessions.length} already present ({preview?.inventory.active ?? 0} active,{' '}
                {preview?.inventory.idle ?? sessions.length} idle). {preview?.launchCount ?? 0} new
                terminal
                {(preview?.launchCount ?? 0) === 1 ? '' : 's'} will open.
              </p>
            </fieldset>

            <fieldset>
              <legend className="mb-2 text-sm font-medium">Terminal provider</legend>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                {OPEN_IN_TERMINAL_PROVIDERS.map((item) => {
                  const installed = available.has(item.id);
                  return (
                    <button
                      key={item.id}
                      type="button"
                      aria-pressed={providerId === item.id}
                      onClick={() => setProviderId(item.id)}
                      className={cn(
                        'rounded-md border px-3 py-2 text-left text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                        providerId === item.id
                          ? 'border-accent-copper bg-accent-copper/10'
                          : 'border-border bg-paper',
                        !installed && 'opacity-60',
                      )}
                    >
                      <span className="block font-medium">{item.name}</span>
                      <span className="text-[11px] text-muted-foreground">
                        {installed ? 'Installed' : 'Setup required'}
                      </span>
                    </button>
                  );
                })}
                <button
                  type="button"
                  aria-pressed={providerId === 'custom'}
                  onClick={() => setProviderId('custom')}
                  className={cn(
                    'rounded-md border px-3 py-2 text-left text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                    providerId === 'custom'
                      ? 'border-accent-copper bg-accent-copper/10'
                      : 'border-border bg-paper',
                  )}
                >
                  <span className="block font-medium">Custom</span>
                  <span className="text-[11px] text-muted-foreground">Validated executable</span>
                </button>
              </div>
              {provider && !available.has(provider.id) && (
                <p className="mt-2 text-xs text-muted-foreground">
                  {provider.setup}{' '}
                  <a
                    href={provider.setupUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="text-accent-copper underline"
                  >
                    Setup guide <ExternalLink className="inline h-3 w-3" />
                  </a>
                </p>
              )}
            </fieldset>

            {providerId === 'custom' && (
              <div>
                <Label htmlFor="open-terminal-custom">Custom executable path</Label>
                <Input
                  id="open-terminal-custom"
                  value={customPath}
                  onChange={(event) => setCustomPath(event.target.value)}
                  placeholder="C:\Tools\my-agent.exe"
                />
              </div>
            )}
            <div>
              <Label htmlFor="open-terminal-directory">Project directory (optional)</Label>
              <Input
                id="open-terminal-directory"
                value={directory}
                onChange={(event) => setDirectory(event.target.value)}
                placeholder="C:\Projects\VibeSpace"
              />
              <p className="mt-1 text-xs text-muted-foreground">
                The first terminal input will change into this directory.
              </p>
            </div>
            <div>
              <Label htmlFor="open-terminal-follow-up">
                Command or prompt after setup (optional)
              </Label>
              <Textarea
                id="open-terminal-follow-up"
                value={followUp}
                onChange={(event) => setFollowUp(event.target.value)}
                rows={3}
              />
            </div>
          </div>
        )}

        {stage === 'review' && preview && (
          <div className="space-y-4">
            <div className="flex items-start gap-3 rounded-md border border-border bg-panel p-3">
              <ShieldCheck className="mt-0.5 h-5 w-5 text-status-success" />
              <div>
                <p className="font-medium">Approval required</p>
                <p className="text-sm text-muted-foreground">
                  Preserve all {preview.inventory.total} existing terminals and open{' '}
                  {preview.launchCount} new {provider?.name ?? 'custom'} session
                  {preview.launchCount === 1 ? '' : 's'}.
                </p>
              </div>
            </div>
            <ol className="space-y-2" aria-label="Startup command preview">
              {preview.startupCommands.map((command, index) => (
                <li
                  key={`${index}-${command}`}
                  className="rounded bg-input px-3 py-2 font-mono text-xs"
                >
                  {index + 1}. {command}
                </li>
              ))}
            </ol>
          </div>
        )}

        {stage === 'launching' && (
          <div className="flex min-h-32 items-center justify-center gap-3" role="status">
            <Loader2 className="h-5 w-5 animate-spin motion-reduce:animate-none" />
            Rechecking capacity and queuing terminals… {progress.completed}/{progress.total}
          </div>
        )}

        {stage === 'result' && (
          <div className="space-y-3" role="status">
            <p className="font-medium">
              {error
                ? 'Launch could not start'
                : result?.cancelled
                  ? 'Launch cancelled'
                  : result?.failures.length
                    ? 'Some terminals could not be queued'
                    : 'Terminal launch queued'}
            </p>
            <p className="text-sm text-muted-foreground">
              {error ||
                `${result?.executionIds.length ?? 0} queued, ${result?.failures.length ?? 0} failed.`}
            </p>
            {result?.failures.map((failure) => (
              <p key={failure.index} className="text-xs text-destructive">
                Terminal {failure.index + 1}: {failure.error}
              </p>
            ))}
          </div>
        )}

        {error && stage !== 'result' && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}

        <DialogFooter>
          {stage === 'configure' && (
            <>
              <Button variant="ghost" onClick={() => void refresh()}>
                <RotateCcw className="h-4 w-4" /> Rescan
              </Button>
              <Button disabled={!canReview} onClick={() => setStage('review')}>
                Preview
              </Button>
            </>
          )}
          {stage === 'review' && (
            <>
              <Button variant="ghost" onClick={() => setStage('configure')}>
                Back
              </Button>
              <Button onClick={() => void approve()}>Approve and launch</Button>
            </>
          )}
          {stage === 'launching' && (
            <Button variant="outline" onClick={() => void cancel()}>
              <Square className="h-3.5 w-3.5" /> Cancel
            </Button>
          )}
          {stage === 'result' && (
            <>
              {(error || result?.failures.length) && (
                <Button variant="outline" onClick={() => void retry()}>
                  <RotateCcw className="h-4 w-4" /> Retry
                </Button>
              )}
              {result?.executionIds.length && !result.cancelled ? (
                <Button
                  onClick={() => {
                    runtime?.navigateToTerminals();
                    onOpenChange(false);
                  }}
                >
                  View terminals
                </Button>
              ) : (
                <Button onClick={() => onOpenChange(false)}>Done</Button>
              )}
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
