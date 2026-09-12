import { useSyncExternalStore } from 'react';
import { Button } from '@/components/ui';
import { harnessRuntimeManager, type HarnessRuntimeManager } from '@/lib/harness/runtimeManager';

export function useHarnessRuntimeState(manager: HarnessRuntimeManager = harnessRuntimeManager) {
  return useSyncExternalStore(manager.subscribe, manager.getSnapshot, manager.getSnapshot);
}

export function HarnessReadinessGate({
  manager = harnessRuntimeManager,
}: {
  manager?: HarnessRuntimeManager;
}) {
  const state = useHarnessRuntimeState(manager);

  if (state.kind === 'ready') return null;

  const download = () => void manager.download();
  const cancel = () => void manager.cancel();

  return (
    <section
      aria-label="OpenCode Harness readiness"
      className="mb-2 rounded-lg border border-accent-copper/30 bg-accent-copper/5 px-3 py-2 text-sm"
    >
      {state.kind === 'checking' ? (
        <p className="text-muted-foreground">Checking OpenCode Harness…</p>
      ) : null}

      {state.kind === 'missing' || state.kind === 'download_required' ? (
        <div className="flex items-center gap-3">
          <div className="min-w-0 flex-1">
            <p className="font-medium text-foreground">OpenCode Harness required</p>
            <p className="text-muted-foreground">
              Download the verified OpenCode harness to enable Chat.
            </p>
          </div>
          <Button type="button" size="sm" variant="accent" onClick={download}>
            Download Harness
          </Button>
        </div>
      ) : null}

      {state.kind === 'downloading' ? (
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-3">
            <p className="text-foreground">
              Downloading OpenCode Harness… {Math.round(state.progress * 100)}%
            </p>
            <Button type="button" size="sm" variant="ghost" onClick={cancel}>
              Cancel
            </Button>
          </div>
          <div
            role="progressbar"
            aria-label="OpenCode Harness download"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(state.progress * 100)}
            className="h-1.5 overflow-hidden rounded-full bg-muted"
          >
            <div
              className="h-full bg-accent-copper transition-[width]"
              style={{ width: `${Math.round(state.progress * 100)}%` }}
            />
          </div>
        </div>
      ) : null}

      {state.kind === 'verifying' ? (
        <p className="text-foreground">Verifying OpenCode Harness…</p>
      ) : null}
      {state.kind === 'installing' ? (
        <p className="text-foreground">Installing OpenCode Harness…</p>
      ) : null}
      {state.kind === 'starting' ? (
        <p className="text-foreground">Starting OpenCode Harness…</p>
      ) : null}

      {state.kind === 'incompatible' ? (
        <div className="flex items-center gap-3">
          <div className="min-w-0 flex-1">
            <p className="font-medium text-foreground">OpenCode Harness needs repair</p>
            <p className="text-muted-foreground">{state.reason}</p>
          </div>
          <Button type="button" size="sm" variant="accent" onClick={download}>
            Download Harness
          </Button>
        </div>
      ) : null}

      {state.kind === 'failed' ? (
        <div className="flex items-center gap-3">
          <div className="min-w-0 flex-1">
            <p className="font-medium text-foreground">Harness installation failed</p>
            <p className="text-muted-foreground">{state.message}</p>
          </div>
          {state.recoverable ? (
            <Button type="button" size="sm" variant="accent" onClick={download}>
              Retry Download
            </Button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
