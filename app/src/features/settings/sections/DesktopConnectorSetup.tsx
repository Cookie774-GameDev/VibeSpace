import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';

type Status = {
  packaged: boolean;
  connectionDetected: boolean;
  connectionFile?: string;
  status: string;
  toolCount: number;
  hasKey: boolean;
  setupComplete?: boolean;
  enabled?: boolean;
  watchdog?: boolean;
  startOnComputer?: boolean | null;
};
export function DesktopConnectorSetup({
  onConnectionReady,
}: {
  onConnectionReady?: (file: string) => void;
}) {
  const [status, setStatus] = useState<Status>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const changing = useRef(false);
  const revision = useRef(0);
  useEffect(() => {
    let active = true;
    let pending = false;
    const refresh = () => {
      if (pending || changing.current) return;
      pending = true;
      const requested = revision.current;
      void invoke<Status>('desktop_connector_status')
        .then((value) => {
          if (active && requested === revision.current) setStatus(value);
        })
        .catch(() => {
          if (active && requested === revision.current)
            setError('Connection status is available in the installed Windows app.');
        })
        .finally(() => {
          pending = false;
        });
    };
    refresh();
    const timer = window.setInterval(refresh, 5000);
    window.addEventListener('focus', refresh);
    return () => {
      active = false;
      window.clearInterval(timer);
      window.removeEventListener('focus', refresh);
    };
  }, []);
  async function act(action = 'setup') {
    if (changing.current) return;
    changing.current = true;
    revision.current++;
    setBusy(true);
    setError('');
    try {
      if (action === 'setup') await invoke('desktop_connector_setup');
      else await invoke('desktop_connector_setup', { action });
      const confirmed = await invoke<Status>('desktop_connector_status');
      setStatus(confirmed);
      if (
        (action === 'disconnect' && confirmed.enabled !== false) ||
        (action === 'connect' && confirmed.enabled !== true) ||
        (action === 'startup-on' && confirmed.startOnComputer !== true) ||
        (action === 'startup-off' && confirmed.startOnComputer !== false)
      )
        setError('The change could not be confirmed. Check the connection and retry.');
    } catch {
      setError('The connector change could not be confirmed. Check setup and retry.');
    } finally {
      changing.current = false;
      setBusy(false);
    }
  }
  const complete =
    status?.setupComplete === true || (status?.status === 'ready' && status.toolCount > 0);
  useEffect(() => {
    if (complete && status?.connectionDetected && status.connectionFile)
      onConnectionReady?.(status.connectionFile);
  }, [complete, status?.connectionDetected, status?.connectionFile, onConnectionReady]);
  return (
    <div
      className="my-4 rounded-xl border border-border bg-background p-4"
      aria-label="Browser and desktop connection"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h5 className="font-medium">VibeSpace Desktop Link</h5>
          <p className="mt-1 text-sm text-muted-foreground">
            {complete
              ? 'Setup complete. Manage your MCP connection below.'
              : 'Connect your OpenAI tunnel in a guided setup page. Your progress is saved on this computer.'}
          </p>
        </div>
        <Button onClick={() => void act()} disabled={busy || !status?.packaged}>
          {busy
            ? 'Applying…'
            : complete
              ? 'Connection settings'
              : status?.hasKey
                ? 'Resume setup'
                : 'Setup'}
        </Button>
      </div>
      <p role="status" className="mt-3 text-sm text-muted-foreground">
        {!status
          ? 'Checking connection…'
          : !status.packaged
            ? 'Connector package is not included in this build.'
            : status.enabled === false
              ? 'MCP is off · automatic recovery paused'
              : status.status === 'ready'
                ? `Tunnel ready · ${status.toolCount} tools detected`
                : status.status === 'connecting'
                  ? 'Connecting tunnel…'
                  : status.connectionDetected
                    ? 'Connection file detected · tunnel disconnected'
                    : 'Preloaded · ready to set up'}
      </p>
      {complete && (
        <div className="mt-3 divide-y divide-border">
          <label className="flex items-center justify-between gap-4 py-3">
            <span>Enable Desktop Link MCP</span>
            <Switch
              aria-label="Enable Desktop Link MCP"
              checked={status?.enabled === true}
              disabled={busy || typeof status?.enabled !== 'boolean'}
              onCheckedChange={(enabled) => void act(enabled ? 'connect' : 'disconnect')}
            />
          </label>
          <p className="py-3 text-sm text-muted-foreground">
            {status?.watchdog
              ? 'Automatic recovery checks every second and pauses when switched off. The connector can keep running after VibeSpace closes.'
              : 'Automatic recovery status is unavailable.'}{' '}
            Enabled connections start with VibeSpace.
          </p>
          <label className="flex items-center justify-between gap-4 py-3">
            <span>
              Start with computer{' '}
              <span className="block text-xs text-muted-foreground">
                Start the connector when you sign in to Windows.
              </span>
            </span>
            <Switch
              aria-label="Start with computer"
              checked={status?.startOnComputer === true}
              disabled={busy || typeof status?.startOnComputer !== 'boolean'}
              onCheckedChange={(enabled) => void act(enabled ? 'startup-on' : 'startup-off')}
            />
          </label>
        </div>
      )}
      {error && (
        <p role="alert" className="mt-2 text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
