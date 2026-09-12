import * as React from 'react';
import { Activity, CheckCircle2, Download, ExternalLink, Loader2, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  cancelCommandCenterToolDownload,
  downloadCommandCenterTool,
  inspectCommandCenterTool,
  installCommandCenterTool,
  launchCommandCenterTool,
  onCommandCenterDownloadProgress,
  readCommandCenterReleaseAuthority,
  type CommandCenterDownloadProgress,
  type CommandCenterToolState,
} from './commandCenterTool';

const EMPTY_STATE: CommandCenterToolState = {
  installed: false,
  executablePath: null,
  installerReady: false,
  phase: 'idle',
  detail: null,
};

function progressPercent(progress: CommandCenterDownloadProgress | null): number | null {
  if (!progress?.totalBytes || progress.totalBytes <= 0) return null;
  return Math.min(100, Math.round((progress.receivedBytes / progress.totalBytes) * 100));
}

export function CommandCenterToolCard() {
  const release = React.useMemo(() => readCommandCenterReleaseAuthority(), []);
  const [state, setState] = React.useState<CommandCenterToolState>(EMPTY_STATE);
  const [busy, setBusy] = React.useState(false);
  const [progress, setProgress] = React.useState<CommandCenterDownloadProgress | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const percent = progressPercent(progress);

  const inspect = React.useCallback(async () => {
    setError(null);
    try {
      const next = await inspectCommandCenterTool();
      if (next) setState(next);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }, []);

  React.useEffect(() => {
    void inspect();
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void onCommandCenterDownloadProgress((next) => {
      if (!disposed) setProgress(next);
    }).then((stop) => {
      if (disposed) stop();
      else unlisten = stop;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [inspect]);

  const run = async (operation: () => Promise<CommandCenterToolState>) => {
    setBusy(true);
    setError(null);
    try {
      const next = await operation();
      if (next) setState(next);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const primary = state.installed ? (
    <Button size="sm" onClick={() => void run(launchCommandCenterTool)} disabled={busy}>
      <ExternalLink className="h-3.5 w-3.5" /> Launch
    </Button>
  ) : state.installerReady && release ? (
    <Button
      size="sm"
      onClick={() => void run(() => installCommandCenterTool(release))}
      disabled={busy}
    >
      <CheckCircle2 className="h-3.5 w-3.5" /> Install verified download
    </Button>
  ) : release ? (
    <Button
      size="sm"
      onClick={() => void run(() => downloadCommandCenterTool(release))}
      disabled={busy}
    >
      {busy ? (
        <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />
      ) : (
        <Download className="h-3.5 w-3.5" />
      )}
      {busy ? (percent == null ? 'Downloading…' : `Downloading ${percent}%`) : 'Download'}
    </Button>
  ) : (
    <Button
      size="sm"
      disabled
      title="No signed Command Center release is configured in this build."
    >
      Download unavailable
    </Button>
  );

  return (
    <article
      data-monochrome-surface="preloaded-command-center"
      className="flex min-h-36 flex-col gap-3 rounded-lg border border-border bg-paper px-4 py-4 shadow-soft [html[data-theme=monochrome]_&]:rounded-sm [html[data-theme=monochrome]_&]:bg-panel [html[data-theme=monochrome]_&]:shadow-none"
    >
      <div className="flex items-start gap-3">
        <span className="grid h-11 w-11 shrink-0 place-items-center rounded-md border border-accent-copper/25 bg-accent-copper/10">
          <Activity className="h-5 w-5 text-accent-copper" />
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="font-semibold text-foreground">Codex Command Center</h3>
          <p className="mt-0.5 text-sm leading-relaxed text-muted-foreground">
            Lightweight local control for terminals, schedules, progress, daily goals, and
            milestones.
          </p>
        </div>
        <span className="text-xs font-medium text-muted-foreground">
          {state.installed ? 'Installed' : 'Preloaded'}
        </span>
      </div>

      {busy && (
        <div
          role="progressbar"
          aria-label="Codex Command Center download"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent ?? undefined}
          className="h-1.5 overflow-hidden rounded-full bg-muted"
        >
          <span
            className="block h-full bg-accent-copper transition-[width] motion-reduce:transition-none"
            style={{ width: `${percent ?? 12}%` }}
          />
        </div>
      )}

      <div className="mt-auto flex flex-wrap items-center gap-2">
        {primary}
        {busy ? (
          <Button size="sm" variant="ghost" onClick={() => void cancelCommandCenterToolDownload()}>
            Cancel
          </Button>
        ) : (
          <Button size="sm" variant="ghost" onClick={() => void inspect()}>
            <RefreshCw className="h-3.5 w-3.5" /> Check status
          </Button>
        )}
      </div>
      {(error || state.detail) && (
        <p role={error ? 'alert' : undefined} className="text-xs text-muted-foreground">
          {error ?? state.detail}
        </p>
      )}
    </article>
  );
}
