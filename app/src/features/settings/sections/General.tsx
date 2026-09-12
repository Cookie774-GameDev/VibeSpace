import { useSyncExternalStore } from 'react';
import { ArrowDown, ArrowUp, Eye, EyeOff, RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { taskbarUsageStore } from '@/features/taskbar-usage/taskbarUsageStore';
import { chatActivityPreferences } from '@/features/chat/activity/chatActivityPreferences';
import { TokenOptimizationGlobalSettings } from '@/features/token-optimizer';
import { BrowserAgentSettings } from './BrowserAgentSettings';
import { RecycleBinSettings } from '@/features/recycle-bin/RecycleBinSettings';

export function General() {
  const state = useSyncExternalStore(
    taskbarUsageStore.subscribe,
    taskbarUsageStore.getSnapshot,
    taskbarUsageStore.getSnapshot,
  );
  const chatActivity = useSyncExternalStore(
    chatActivityPreferences.subscribe,
    chatActivityPreferences.getSnapshot,
    chatActivityPreferences.getSnapshot,
  );
  const hidden = new Set(state.preferences.hiddenProviderIds);
  const order = new Map(state.preferences.providerOrder.map((id, index) => [id, index]));
  const providers = [...state.payload.snapshots].sort((left, right) => {
    return (
      (order.get(left.providerId) ?? Number.MAX_SAFE_INTEGER) -
        (order.get(right.providerId) ?? Number.MAX_SAFE_INTEGER) ||
      left.displayName.localeCompare(right.displayName)
    );
  });

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6">
      <header>
        <h2 className="text-lg font-semibold text-foreground">General</h2>
        <p className="text-secondary text-muted-foreground">
          Keep essential VibeSpace controls close without adding background overhead.
        </p>
      </header>

      <TokenOptimizationGlobalSettings />
      <BrowserAgentSettings />
      <RecycleBinSettings />

      <section
        className="rounded-lg border border-border bg-panel p-4"
        aria-labelledby="taskbar-usage-title"
      >
        <div className="mb-4">
          <h3 id="taskbar-usage-title" className="text-ui-strong text-foreground">
            Taskbar Usage
          </h3>
          <p className="text-metadata text-muted-foreground">
            Automatically detects connected providers and shows the top four beside the taskbar.
          </p>
          {!('__TAURI_INTERNALS__' in window) && (
            <p className="mt-2 text-metadata text-muted-foreground">
              Desktop taskbar placement is unavailable in browser preview.
            </p>
          )}
          {state.runtimeDiagnostic && (
            <div
              className="mt-3 rounded-md border border-destructive/40 bg-destructive/10 p-3"
              role="alert"
            >
              <p className="text-secondary font-medium text-foreground">
                Usage module could not open
              </p>
              <p className="mt-1 text-metadata text-muted-foreground">
                {state.runtimeDiagnostic.message}
              </p>
              <Button
                type="button"
                size="sm"
                variant="secondary"
                className="mt-2"
                onClick={() => window.dispatchEvent(new Event('taskbar-usage://retry-mount'))}
              >
                Retry usage module
              </Button>
            </div>
          )}
        </div>

        <div className="divide-y divide-border">
          <label className="flex min-h-12 items-center justify-between gap-4 py-3">
            <span>
              <span className="block text-secondary text-foreground">
                Show taskbar usage module
              </span>
              <span className="block text-metadata text-muted-foreground">
                Uses sanitized connection metadata; credentials never enter the module.
              </span>
            </span>
            <Switch
              aria-label="Show taskbar usage module"
              checked={state.preferences.enabled}
              onCheckedChange={(enabled) => taskbarUsageStore.updatePreferences({ enabled })}
            />
          </label>

          <label className="flex min-h-12 items-center justify-between gap-4 py-3">
            <span>
              <span className="block text-secondary text-foreground">Launch with VibeSpace</span>
              <span className="block text-metadata text-muted-foreground">
                Keep the compact module available while the main window is hidden.
              </span>
            </span>
            <Switch
              aria-label="Launch taskbar usage with VibeSpace"
              checked={state.preferences.launchWithVibeSpace}
              disabled={!state.preferences.enabled}
              onCheckedChange={(launchWithVibeSpace) =>
                taskbarUsageStore.updatePreferences({ launchWithVibeSpace })
              }
            />
          </label>
        </div>

        <div className="mt-4">
          <div className="mb-2 flex items-center justify-between">
            <div>
              <h4 className="text-secondary font-medium text-foreground">Provider order</h4>
              <p className="text-metadata text-muted-foreground">
                The first four visible providers are shown.
              </p>
            </div>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => taskbarUsageStore.resetProviderOrder()}
            >
              <RotateCcw aria-hidden="true" />
              Restore order
            </Button>
          </div>
          <div className="max-h-52 overflow-y-auto rounded-md border border-border">
            {providers.length === 0 ? (
              <p className="px-3 py-4 text-metadata text-muted-foreground">
                Providers appear automatically after VibeSpace detects a connection.
              </p>
            ) : (
              providers.map((provider, index) => {
                const isHidden = hidden.has(provider.providerId);
                return (
                  <div
                    key={provider.providerId}
                    className="flex min-h-10 items-center gap-2 border-b border-border px-3 last:border-b-0"
                    draggable
                    onDragStart={(event) => {
                      event.dataTransfer.effectAllowed = 'move';
                      event.dataTransfer.setData(
                        'application/x-vibespace-provider',
                        provider.providerId,
                      );
                    }}
                    onDragOver={(event) => {
                      event.preventDefault();
                      event.dataTransfer.dropEffect = 'move';
                    }}
                    onDrop={(event) => {
                      event.preventDefault();
                      const dragged = event.dataTransfer.getData(
                        'application/x-vibespace-provider',
                      );
                      if (providers.some(({ providerId }) => providerId === dragged)) {
                        taskbarUsageStore.moveProviderTo(dragged, index);
                      }
                    }}
                  >
                    <span className="min-w-0 flex-1 truncate text-secondary text-foreground">
                      {provider.displayName}
                    </span>
                    {!isHidden && index < 4 && (
                      <span className="text-[10px] font-semibold uppercase tracking-wide text-accent-cyan">
                        Shown
                      </span>
                    )}
                    <Button
                      type="button"
                      size="icon-sm"
                      variant="ghost"
                      disabled={index === 0}
                      aria-label={`Move ${provider.displayName} earlier`}
                      onClick={() => taskbarUsageStore.moveProvider(provider.providerId, -1)}
                    >
                      <ArrowUp aria-hidden="true" />
                    </Button>
                    <Button
                      type="button"
                      size="icon-sm"
                      variant="ghost"
                      disabled={index === providers.length - 1}
                      aria-label={`Move ${provider.displayName} later`}
                      onClick={() => taskbarUsageStore.moveProvider(provider.providerId, 1)}
                    >
                      <ArrowDown aria-hidden="true" />
                    </Button>
                    <Button
                      type="button"
                      size="icon-sm"
                      variant="ghost"
                      aria-label={`${isHidden ? 'Show' : 'Hide'} ${provider.displayName}`}
                      onClick={() =>
                        taskbarUsageStore.setProviderHidden(provider.providerId, !isHidden)
                      }
                    >
                      {isHidden ? <Eye aria-hidden="true" /> : <EyeOff aria-hidden="true" />}
                    </Button>
                  </div>
                );
              })
            )}
          </div>
        </div>

        <div className="mt-4 flex justify-end">
          <Button
            type="button"
            variant="secondary"
            aria-label="Reset taskbar usage position"
            onClick={() => taskbarUsageStore.setPlacement(null)}
          >
            Reset position
          </Button>
        </div>
      </section>

      <section className="rounded-lg border border-border bg-panel p-4">
        <h3 className="text-ui-strong text-foreground">Chat activity</h3>
        <label className="mt-3 flex min-h-12 items-center justify-between gap-4">
          <span>
            <span className="block text-secondary text-foreground">Show Jarvis session panel</span>
            <span className="block text-metadata text-muted-foreground">
              Shows compact progress, files, tools, duration, and token counters in each chat.
            </span>
          </span>
          <Switch
            aria-label="Show Jarvis session panel"
            checked={chatActivity.showSessionPanel}
            onCheckedChange={(show) => chatActivityPreferences.setShowSessionPanel(show)}
          />
        </label>
      </section>
    </div>
  );
}
