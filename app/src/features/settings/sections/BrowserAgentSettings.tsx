import { useSyncExternalStore } from 'react';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { remoteMcpSetupRuntime } from '@/lib/mcp/remoteSetupRuntime';
import { browserAgentPreferences } from '../browserAgentPreferences';

function ToggleRow({
  label,
  description,
  checked,
  onChange,
}: {
  label: string;
  description: string;
  checked: boolean;
  onChange(checked: boolean): void;
}) {
  return (
    <label className="flex min-h-12 items-center justify-between gap-4 py-3">
      <span>
        <span className="block text-secondary text-foreground">{label}</span>
        <span className="block text-metadata text-muted-foreground">{description}</span>
      </span>
      <Switch aria-label={label} checked={checked} onCheckedChange={onChange} />
    </label>
  );
}

export function BrowserAgentSettings() {
  const preferences = useSyncExternalStore(
    browserAgentPreferences.subscribe,
    browserAgentPreferences.getSnapshot,
    browserAgentPreferences.getSnapshot,
  );
  const connections = useSyncExternalStore(
    remoteMcpSetupRuntime.subscribe,
    remoteMcpSetupRuntime.getSnapshot,
    remoteMcpSetupRuntime.getSnapshot,
  );
  const connected = connections.filter(({ state }) => state === 'connected').length;
  const failed = connections.filter(({ state }) => state === 'failed').length;
  const health =
    failed > 0
      ? `${failed} connector${failed === 1 ? '' : 's'} need attention`
      : connected > 0
        ? `${connected} approved connector${connected === 1 ? '' : 's'} ready`
        : 'No approved MCP connectors active';

  return (
    <section
      className="rounded-lg border border-border bg-panel p-4"
      aria-labelledby="browser-agent-settings-title"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 id="browser-agent-settings-title" className="text-ui-strong text-foreground">
            Browser Agent
          </h3>
          <p className="text-metadata text-muted-foreground">
            Uses the current chat mode and model. Site-changing actions still require approval.
          </p>
        </div>
        <span className="rounded-full border border-border px-2 py-1 text-[11px] text-muted-foreground">
          {health}
        </span>
      </div>

      <div className="mt-3 divide-y divide-border">
        <ToggleRow
          label="Enable Browser Agent"
          description="Allows approved browser goals; it does not start a browser by itself."
          checked={preferences.enabled}
          onChange={(enabled) => browserAgentPreferences.update({ enabled })}
        />

        <div className="grid gap-3 py-3 sm:grid-cols-2">
          <label className="text-secondary text-foreground">
            Browser source
            <select
              className="mt-1 h-9 w-full rounded-md border border-border bg-background px-2 text-sm"
              value={preferences.source}
              onChange={(event) =>
                browserAgentPreferences.update({
                  source:
                    event.target.value === 'approved_existing' ? 'approved_existing' : 'isolated',
                })
              }
            >
              <option value="isolated">Isolated VibeSpace browser</option>
              <option value="approved_existing">Approved existing browser</option>
            </select>
          </label>
          <label className="text-secondary text-foreground">
            Preferred browser
            <select
              className="mt-1 h-9 w-full rounded-md border border-border bg-background px-2 text-sm"
              value={preferences.preferredBrowser}
              onChange={(event) =>
                browserAgentPreferences.update({
                  preferredBrowser: event.target.value as typeof preferences.preferredBrowser,
                })
              }
            >
              <option value="vibespace">VibeSpace isolated</option>
              <option value="system">System default</option>
              <option value="chrome">Chrome</option>
              <option value="edge">Edge</option>
            </select>
          </label>
        </div>

        <ToggleRow
          label="Reconnect approved MCPs"
          description="Reconnect only connectors already approved for this account and project."
          checked={preferences.autoReconnectApprovedMcps}
          onChange={(autoReconnectApprovedMcps) =>
            browserAgentPreferences.update({ autoReconnectApprovedMcps })
          }
        />
        <ToggleRow
          label="Ask before website submission"
          description="Require approval before submitting forms or messages."
          checked={preferences.askBeforeWebsiteSubmission}
          onChange={(askBeforeWebsiteSubmission) =>
            browserAgentPreferences.update({ askBeforeWebsiteSubmission })
          }
        />
        <ToggleRow
          label="Ask before uploads or downloads"
          description="Require approval before transferring local or remote files."
          checked={preferences.askBeforeTransfers}
          onChange={(askBeforeTransfers) => browserAgentPreferences.update({ askBeforeTransfers })}
        />
        <ToggleRow
          label="Ask before sending, publishing, or purchasing"
          description="Require approval before any external commitment."
          checked={preferences.askBeforeExternalCommitment}
          onChange={(askBeforeExternalCommitment) =>
            browserAgentPreferences.update({ askBeforeExternalCommitment })
          }
        />
        <ToggleRow
          label="Isolate browser sessions"
          description="Use a fresh goal lease and keep site state separate by default."
          checked={preferences.isolateSessions}
          onChange={(isolateSessions) => browserAgentPreferences.update({ isolateSessions })}
        />
      </div>

      <div className="mt-3 flex items-center justify-between gap-3">
        <p className="text-[11px] text-muted-foreground">
          VibeSpace MCP Gateway · session lease {preferences.sessionEpoch + 1}
        </p>
        <Button
          type="button"
          variant="secondary"
          onClick={() => browserAgentPreferences.clearSession()}
        >
          Clear session and revoke leases
        </Button>
      </div>
    </section>
  );
}
