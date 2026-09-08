import { useEffect, useId, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { requestOpenMcpManager } from '@/features/plugins/openMcpManager';
import {
  connectDesktopCommander,
  type DesktopCommanderClient,
  type DesktopCommanderConfig,
  type DesktopCommanderSnapshot,
} from '../desktopCommanderClient';

const fields = [
  {
    key: 'blockedCommands',
    label: 'Blocked Commands',
    description: 'Commands Desktop Commander refuses to run. Add one command per line.',
  },
  {
    key: 'allowedDirectories',
    label: 'Allowed Folders',
    description:
      'Folders Desktop Commander may read and edit. An empty list permits all folders. This setting does not sandbox terminal commands.',
  },
  {
    key: 'defaultShell',
    label: 'Default Shell',
    description:
      'Shell executable used for new command sessions. Existing terminals keep their current shell.',
  },
  {
    key: 'telemetryEnabled',
    label: 'Anonymous Telemetry',
    description: 'Send anonymous Desktop Commander usage information when enabled.',
  },
  {
    key: 'fileReadLineLimit',
    label: 'File Read Limit',
    description: 'Maximum number of lines returned in one file read action.',
  },
  {
    key: 'fileWriteLineLimit',
    label: 'File Write Limit',
    description: 'Maximum number of lines written in one file edit operation.',
  },
] as const;
const inputClass =
  'rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground';

export function DesktopCommanderSettings({
  connect = connectDesktopCommander,
}: {
  connect?: typeof connectDesktopCommander;
}) {
  const controlId = useId();
  const [path, setPath] = useState('');
  const [client, setClient] = useState<DesktopCommanderClient>();
  const [snapshot, setSnapshot] = useState<DesktopCommanderSnapshot>();
  const [draft, setDraft] = useState<DesktopCommanderConfig>();
  const [editing, setEditing] = useState<keyof DesktopCommanderConfig>();
  const [listText, setListText] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const lifetime = useRef<AbortController | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    return () => {
      controller.abort();
    };
  }, []);
  async function run(
    operation: (signal: AbortSignal) => Promise<DesktopCommanderSnapshot>,
    success: string,
    savedKey?: keyof DesktopCommanderConfig,
  ) {
    const signal = lifetime.current!.signal;
    if (busy || signal.aborted) return;
    setBusy(true);
    setMessage('');
    setError('');
    try {
      const next = await operation(signal);
      if (signal.aborted) return;
      setSnapshot(next);
      setDraft((current) =>
        savedKey && current
          ? { ...current, [savedKey]: next.config[savedKey] }
          : structuredClone(next.config),
      );
      setEditing(undefined);
      setMessage(success);
    } catch (cause) {
      if (!signal.aborted)
        setError(cause instanceof Error ? cause.message : 'Desktop Commander request failed.');
    } finally {
      if (!signal.aborted) setBusy(false);
    }
  }
  function update<K extends keyof DesktopCommanderConfig>(
    key: K,
    value: DesktopCommanderConfig[K],
  ) {
    setDraft((current) => (current ? { ...current, [key]: value } : current));
  }
  return (
    <section
      className="mt-4 rounded-2xl border border-border bg-panel p-4"
      aria-label="Desktop Commander configuration"
    >
      <h4 className="text-ui-strong text-foreground">Desktop Commander</h4>
      <p className="mt-1 text-metadata text-muted-foreground">
        Configure the VibeSpace copy. Changes are saved to its running MCP and checked by reading
        them back.
      </p>
      <details className="my-3 rounded-lg border border-border p-3">
        <summary className="cursor-pointer text-secondary text-foreground">
          Setup Desktop Commander and browser tools
        </summary>
        <a
          className="mt-3 inline-block text-sm underline"
          href="/browser-agent-setup/vibespace-desktop-commander.zip"
          download
        >
          Download the VibeSpace Desktop Commander package
        </a>
        <ol className="ml-5 mt-3 list-decimal space-y-2 text-sm text-muted-foreground">
          <li>
            Extract the VibeSpace Desktop Commander package. In that folder, run{' '}
            <code>npm ci --ignore-scripts</code>, <code>npm run browser:install</code>, then{' '}
            <code>npm start</code>.
          </li>
          <li>
            Select the package’s <code>state/connection.json</code> below. Its private connection
            credential stays out of chat and browser storage.
          </li>
          <li>
            Open MCP connections, add a local server named <code>vibespace-desktop-commander</code>,
            and use the command array <code>["node", "ABSOLUTE_PACKAGE_PATH/mcp.mjs"]</code>. Review
            the tools before enabling them for your model.
          </li>
          <li>
            For browser actions, use the <code>browser_command</code> tool with a unique session
            name and <code>args: ["open", "https://example.com"]</code>. Follow with snapshot,
            click, fill, or press. Browser sessions use Playwright in Edge.
          </li>
        </ol>
        <p className="my-3 text-sm text-muted-foreground">
          Local tools need no tunnel or OpenAI key. An OpenAI key is only needed if you select
          OpenAI as your model provider. Remote access requires a separately secured tunnel; keep
          the gateway’s bearer authentication enabled.
        </p>
        <Button variant="secondary" onClick={requestOpenMcpManager}>
          Open MCP connections
        </Button>
        <video
          className="mt-3 w-full rounded-lg"
          controls
          preload="none"
          aria-label="Browser Agent setup walkthrough"
          src="/browser-agent-setup/setup.webm"
        >
          <track
            kind="captions"
            src="/browser-agent-setup/setup.vtt"
            srcLang="en"
            label="English"
            default
          />
        </video>
      </details>
      <div className="my-3 flex flex-wrap items-end gap-2">
        <label className="min-w-0 flex-1 text-sm">
          Connection file
          <input
            aria-label="Desktop Commander connection file"
            className={`${inputClass} mt-1 w-full`}
            value={path}
            disabled={busy}
            onChange={(event) => {
              setPath(event.target.value);
              setClient(undefined);
              setSnapshot(undefined);
              setDraft(undefined);
              setEditing(undefined);
              setMessage('');
              setError('');
            }}
            placeholder="C:\…\state\connection.json"
          />
        </label>
        <Button
          disabled={busy || !path.trim()}
          onClick={() =>
            void run(async (signal) => {
              const next = await connect(path.trim());
              const loaded = await next.load(signal);
              if (!signal.aborted) setClient(next);
              return loaded;
            }, 'Connected to the VibeSpace Desktop Commander copy.')
          }
        >
          Connect Desktop Commander
        </Button>
        {client && (
          <Button
            variant="secondary"
            disabled={busy}
            onClick={() => void run((signal) => client.load(signal), 'Configuration reloaded.')}
          >
            Reload configuration
          </Button>
        )}
      </div>
      {snapshot && draft && client && (
        <div className="divide-y divide-border">
          {fields.map(({ key, label, description }) => {
            const arrayField = key === 'blockedCommands' || key === 'allowedDirectories';
            const changed = JSON.stringify(draft[key]) !== JSON.stringify(snapshot.config[key]);
            const numeric = key === 'fileReadLineLimit' || key === 'fileWriteLineLimit';
            const valid =
              !numeric ||
              (Number.isSafeInteger(draft[key]) &&
                Number(draft[key]) >= 1 &&
                Number(draft[key]) <= 1000000);
            return (
              <div key={key} className="flex flex-wrap items-center justify-between gap-4 py-4">
                <div className="min-w-0 flex-1">
                  <label
                    htmlFor={`${controlId}-${key}`}
                    className="block text-sm font-semibold text-foreground"
                  >
                    {label}
                  </label>
                  <p className="mt-1 text-sm text-muted-foreground">{description}</p>
                  {arrayField && (
                    <p className="mt-2 text-xs font-semibold text-muted-foreground">
                      {key === 'blockedCommands'
                        ? `${draft[key].length} commands blocked`
                        : draft[key].length
                          ? `${draft[key].length} folders allowed`
                          : 'All folders allowed (no restriction)'}
                    </p>
                  )}
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {arrayField ? (
                    <Button
                      variant="secondary"
                      aria-label={editing === key ? `Hide ${label}` : `Edit ${label}`}
                      disabled={busy}
                      onClick={() => {
                        setListText(draft[key].join('\n'));
                        setEditing(editing === key ? undefined : key);
                      }}
                    >
                      {editing === key ? 'Hide' : 'Edit'}
                    </Button>
                  ) : key === 'telemetryEnabled' ? (
                    <Switch
                      id={`${controlId}-${key}`}
                      aria-label={label}
                      checked={draft[key]}
                      disabled={busy}
                      onCheckedChange={(value) => update(key, value)}
                    />
                  ) : (
                    <input
                      id={`${controlId}-${key}`}
                      className={`${inputClass} w-40`}
                      type={numeric ? 'number' : 'text'}
                      min={numeric ? 1 : undefined}
                      max={numeric ? 1000000 : undefined}
                      step={numeric ? 1 : undefined}
                      list={key === 'defaultShell' ? `${controlId}-shells` : undefined}
                      value={Number.isNaN(draft[key]) ? '' : String(draft[key])}
                      disabled={busy}
                      onChange={(event) =>
                        numeric
                          ? update(
                              key,
                              event.target.value === '' ? Number.NaN : Number(event.target.value),
                            )
                          : update(key, event.target.value)
                      }
                    />
                  )}
                  {changed && (
                    <Button
                      disabled={busy || !valid}
                      onClick={() =>
                        void run(
                          (signal) => client.save(key, draft[key], snapshot.config[key], signal),
                          `${label} saved and verified.`,
                          key,
                        )
                      }
                    >
                      Save {label}
                    </Button>
                  )}
                </div>
                {arrayField && editing === key && (
                  <textarea
                    id={`${controlId}-${key}`}
                    aria-label={label}
                    className={`${inputClass} min-h-32 w-full`}
                    value={listText}
                    disabled={busy}
                    onChange={(event) => {
                      setListText(event.target.value);
                      update(
                        key,
                        event.target.value
                          .split(/\r?\n/)
                          .map((line) => line.trim())
                          .filter(Boolean),
                      );
                    }}
                  />
                )}
              </div>
            );
          })}
          <datalist id={`${controlId}-shells`}>
            {snapshot.availableShells.map((shell) => (
              <option key={shell} value={shell} />
            ))}
          </datalist>
        </div>
      )}
      {busy && (
        <p role="status" className="mt-2 text-sm">
          Checking Desktop Commander…
        </p>
      )}
      {message && (
        <p role="status" className="mt-2 text-sm text-muted-foreground">
          {message}
        </p>
      )}
      {error && (
        <p role="alert" className="mt-2 text-sm text-destructive">
          {error}
        </p>
      )}
    </section>
  );
}
