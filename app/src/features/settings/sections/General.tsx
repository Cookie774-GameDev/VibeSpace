import { useEffect, useState, useSyncExternalStore } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { ArrowDown, ArrowUp, Eye, EyeOff, RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { taskbarUsageStore } from '@/features/taskbar-usage/taskbarUsageStore';
import { chatActivityPreferences } from '@/features/chat/activity/chatActivityPreferences';
import { TokenOptimizationGlobalSettings } from '@/features/token-optimizer';
import { BrowserAgentSettings } from './BrowserAgentSettings';
import { RecycleBinSettings } from '@/features/recycle-bin/RecycleBinSettings';
import { readRelaySettings, subscribeRelaySettings, writeRelaySettings } from '../relaySettings';

type RelayEngineHealth =
  'checking' | 'healthy' | 'unhealthy' | 'unavailable' | 'unknown' | 'desktop-only';

async function testNativeRelayExchange(): Promise<number> {
  const startedAt = performance.now();
  const native = await invoke<{ generation: number; context: {
    accountId: string; workspaceId: string | null; projectId: string; chatId: string;
  } | null }>('relay_active_context_snapshot');
  const context = native?.context;
  if (!context?.accountId || !context.workspaceId || !context.projectId || !context.chatId ||
      !Number.isSafeInteger(native.generation)) throw new Error('Select a native chat to test Relay.');
  const sessionId = `vibespace-human-test:${context.chatId}`;
  const settings = readRelaySettings();
  if (settings.scope === 'off' || settings.excludedParticipants.includes(context.projectId) ||
      settings.excludedParticipants.includes(sessionId)) throw new Error('Relay is off or this chat is excluded.');
  await invoke('relay_engine_start');
  let binding: { bindingId: string; relayAgentId: string } | null = null;
  try {
    binding = await invoke<{ bindingId: string; relayAgentId: string }>('relay_participant_bind', {
      scope: context, sessionId, generation: native.generation, agentName: 'You', role: 'human',
    });
    const text = `VibeSpace Relay connection test ${crypto.randomUUID()}`;
    const receipt = await invoke<{ messageId: string }>('relay_human_message', {
      bindingId: binding.bindingId, generation: native.generation, text,
    });
    const room = await invoke<{ channel: string; messages: Array<{
      id: string; authorId: string; text: string;
    }> }>('relay_human_room_snapshot', {
      bindingId: binding.bindingId, generation: native.generation, limit: 50,
    });
    if (room.channel !== 'vibespace' || !room.messages?.some((message) =>
      message.id === receipt.messageId && message.authorId === binding?.relayAgentId && message.text === text)) {
      throw new Error('Relay did not return the authenticated test message.');
    }
    return Math.round(performance.now() - startedAt);
  } finally {
    if (binding) await invoke('relay_participant_unbind', {
      bindingId: binding.bindingId, generation: native.generation,
    }).catch(() => undefined);
  }
}

function relayEngineHealthMessage(status: RelayEngineHealth): string {
  switch (status) {
    case 'checking':
      return 'Checking local Relay backend health.';
    case 'healthy':
      return 'Local Relay backend health check passed. This does not verify a participant exchange.';
    case 'unhealthy':
      return 'Local Relay backend is running but failed its health check.';
    case 'unavailable':
      return 'Local Relay backend is stopped or its status could not be read.';
    case 'desktop-only':
      return 'Local Relay backend health is available in the native VibeSpace app.';
    case 'unknown':
      return 'This app build did not return a verifiable Relay backend health status.';
  }
}

export function General() {
  const [relaySettings, setRelaySettings] = useState(readRelaySettings);
  const [relayEngineHealth, setRelayEngineHealth] = useState<RelayEngineHealth>('checking');
  const [relayTestState, setRelayTestState] = useState<'idle' | 'running' | 'passed' | 'failed'>('idle');
  const [relayTestDetail, setRelayTestDetail] = useState('');
  useEffect(() => subscribeRelaySettings(setRelaySettings), []);
  useEffect(() => {
    let active = true;
    const refreshRelayEngineHealth = async () => {
      if (!('__TAURI_INTERNALS__' in window)) {
        setRelayEngineHealth('desktop-only');
        return;
      }
      setRelayEngineHealth('checking');
      try {
        const result = await invoke<unknown>('relay_engine_status');
        if (!active) return;
        if (!result || typeof result !== 'object') {
          setRelayEngineHealth('unknown');
          return;
        }
        const status = result as Record<string, unknown>;
        if (status.running === false) setRelayEngineHealth('unavailable');
        else if (status.running === true && status.healthy === true)
          setRelayEngineHealth('healthy');
        else if (status.running === true && status.healthy === false)
          setRelayEngineHealth('unhealthy');
        else setRelayEngineHealth('unknown');
      } catch {
        if (active) setRelayEngineHealth('unavailable');
      }
    };

    void refreshRelayEngineHealth();
    window.addEventListener('focus', refreshRelayEngineHealth);
    return () => {
      active = false;
      window.removeEventListener('focus', refreshRelayEngineHealth);
    };
  }, []);
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
        aria-labelledby="relay-title"
      >
        <div>
          <h3 id="relay-title" className="text-ui-strong text-foreground">
            Agent Relay
          </h3>
          <p className="mt-1 text-metadata text-muted-foreground">
            Choose which VibeSpace sessions may collaborate. Participation stays off until you
            enable it.
          </p>
        </div>

        <label className="mt-4 flex min-h-12 items-center justify-between gap-4">
          <span>
            <span className="block text-secondary text-foreground">Collaboration</span>
            <span className="block text-metadata text-muted-foreground">
              Off disables Relay participation. Project is recommended for first use. Entire app
              connects enabled projects in this account, workspace, and profile without granting
              extra file access.
            </span>
          </span>
          <select
            aria-label="Agent Relay collaboration scope"
            className="min-h-10 rounded-md border border-border bg-background px-3 text-secondary text-foreground"
            value={relaySettings.scope}
            onChange={(event) => {
              const next = writeRelaySettings({
                ...relaySettings,
                scope: event.currentTarget.value as typeof relaySettings.scope,
              });
              setRelaySettings(next);
            }}
          >
            <option value="off">Off</option>
            <option value="project">Project (recommended)</option>
            <option value="entire-app">Entire app</option>
          </select>
        </label>

        <label className="mt-2 flex min-h-12 items-center justify-between gap-4">
          <span>
            <span className="block text-secondary text-foreground">
              Automatic check-ins and replies
            </span>
            <span className="block text-metadata text-muted-foreground">
              Allow bounded peer check-ins and replies at safe boundaries when collaboration is
              enabled.
            </span>
          </span>
          <Switch
            aria-label="Automatic Agent Relay check-ins and replies"
            checked={relaySettings.automaticParticipation}
            onCheckedChange={(automaticParticipation) =>
              setRelaySettings(writeRelaySettings({ ...relaySettings, automaticParticipation }))
            }
          />
        </label>

        <label className="mt-3 block">
          <span className="block text-secondary text-foreground">Participation exclusions</span>
          <span className="block text-metadata text-muted-foreground">
            Enter project or session IDs, one per line. Exclusions take priority over the
            collaboration scope.
          </span>
          <textarea
            aria-label="Agent Relay excluded project and session IDs"
            className="mt-2 min-h-20 w-full resize-y rounded-md border border-border bg-background p-3 text-secondary text-foreground"
            value={relaySettings.excludedParticipants.join('\n')}
            onChange={(event) => {
              const excludedParticipants = event.currentTarget.value
                .split(/[\n,]/)
                .map((id) => id.trim())
                .filter(Boolean);
              setRelaySettings(writeRelaySettings({ ...relaySettings, excludedParticipants }));
            }}
          />
        </label>

        <div className="mt-4 rounded-md border border-border p-3" aria-live="polite">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-secondary font-medium text-foreground">Connection status</p>
              <p className="text-metadata text-muted-foreground">
                {relayTestState === 'passed'
                  ? relayTestDetail
                  : relayTestState === 'running'
                    ? 'Sending and reading an authenticated test message…'
                    : relayTestState === 'failed'
                      ? relayTestDetail
                      : 'No authenticated Relay exchange has been verified in this settings session.'}
              </p>
              <p className="mt-1 text-metadata text-muted-foreground">
                {relayEngineHealthMessage(relayEngineHealth)}
              </p>
            </div>
            <Button
              type="button"
              variant="secondary"
              disabled={relaySettings.scope === 'off' || relayTestState === 'running' || !('__TAURI_INTERNALS__' in window)}
              onClick={() => {
                setRelayTestState('running');
                void testNativeRelayExchange()
                  .then((durationMs) => {
                    setRelayTestState('passed');
                    setRelayTestDetail(`Authenticated send/read round trip passed in ${durationMs} ms. Agent reply was not tested.`);
                  })
                  .catch((error) => {
                    setRelayTestState('failed');
                    setRelayTestDetail(error instanceof Error ? error.message : 'Relay test failed.');
                  });
              }}
              title="Send and read a test message in the active Relay project"
            >
              Test connection
            </Button>
          </div>
          <p className="mt-2 text-metadata text-muted-foreground">
            The test sends one message as you and reads it back through the local Relay backend.
            It does not verify that another agent responded.
          </p>
        </div>
      </section>

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
