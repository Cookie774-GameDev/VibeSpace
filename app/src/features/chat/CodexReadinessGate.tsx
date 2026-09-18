import { useSyncExternalStore } from 'react';
import { Button } from '@/components/ui';
import { codexRuntimeManager, type CodexRuntimeManager } from '@/lib/harness/codexRuntimeManager';

export function useCodexRuntimeState(manager: CodexRuntimeManager = codexRuntimeManager) {
  return useSyncExternalStore(manager.subscribe, manager.getSnapshot, manager.getSnapshot);
}

export function CodexReadinessGate({
  manager = codexRuntimeManager,
  requiresTranslation = true,
}: {
  manager?: CodexRuntimeManager;
  requiresTranslation?: boolean;
}) {
  const state = useCodexRuntimeState(manager);
  const translationRuntime = state.kind === 'ready'
    ? state.translationRuntime ?? (state.openCodexVersion.trim() ? 'ready' : 'missing')
    : undefined;
  const routeReady = state.kind === 'ready' && (!requiresTranslation || translationRuntime === 'ready');
  if (routeReady) return null;
  const install = () => void manager.install(requiresTranslation ? { includeTranslation: true } : undefined);
  const optionalTranslationOnly = state.kind === 'ready' && requiresTranslation;

  return (
    <section
      aria-label="Codex tools readiness"
      className="mb-2 rounded-lg border border-accent-copper/30 bg-accent-copper/5 px-3 py-2 text-sm"
    >
      {state.kind === 'checking' ? <p>Checking Codex tools…</p> : null}
      {optionalTranslationOnly ? (
        <div className="flex items-center gap-3">
          <div className="min-w-0 flex-1">
            <p className="font-medium">
              {translationRuntime === 'installing' ? 'Installing OpenCodex translation…' : 'OpenCodex translation required'}
            </p>
            <p className="text-muted-foreground">
              {translationRuntime === 'failed'
                ? 'The optional translation runtime failed safely. Retry to use this translated Codex route.'
                : 'This selected provider uses the reviewed OpenCodex translation route. Official OpenAI Codex does not require it.'}
            </p>
          </div>
          {translationRuntime === 'installing' ? (
            <Button type="button" size="sm" variant="ghost" onClick={() => void manager.cancel()}>
              Cancel installation
            </Button>
          ) : (
            <Button type="button" size="sm" variant="accent" onClick={install}>
              {translationRuntime === 'failed' ? 'Retry translation' : 'Install OpenCodex translation'}
            </Button>
          )}
        </div>
      ) : null}
      {!optionalTranslationOnly && (state.kind === 'missing' || state.kind === 'incomplete') ? (
        <div className="flex items-center gap-3">
          <div className="min-w-0 flex-1">
            <p className="font-medium">Codex tools required</p>
            <p className="text-muted-foreground">
              {state.kind === 'incomplete'
                ? state.reason
                : requiresTranslation
                  ? 'Install the pinned Codex and OpenCodex tools for this VibeSpace profile.'
                  : 'Install the pinned Codex CLI for this VibeSpace profile.'}
            </p>
          </div>
          <Button type="button" size="sm" variant="accent" onClick={install}>
            Install Codex tools
          </Button>
        </div>
      ) : null}
      {!optionalTranslationOnly && state.kind === 'installing' ? (
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-3">
            <p>
              Installing {state.component === 'codex' ? 'Codex' : 'OpenCodex'}…{' '}
              {Math.round(state.progress * 100)}%
            </p>
            <Button type="button" size="sm" variant="ghost" onClick={() => void manager.cancel()}>
              Cancel installation
            </Button>
          </div>
          <div
            role="progressbar"
            aria-label="Codex tools installation"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(state.progress * 100)}
            className="h-1.5 overflow-hidden rounded-full bg-muted"
          >
            <div
              className="h-full bg-accent-copper"
              style={{ width: `${state.progress * 100}%` }}
            />
          </div>
        </div>
      ) : null}
      {!optionalTranslationOnly && state.kind === 'failed' ? (
        <div className="flex items-center gap-3">
          <div className="min-w-0 flex-1">
            <p className="font-medium">Codex tools installation failed</p>
            <p className="text-muted-foreground">{state.message}</p>
          </div>
          {state.recoverable ? (
            <Button type="button" size="sm" variant="accent" onClick={install}>
              Retry installation
            </Button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
