import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Button } from '@/components/ui/button';

type Status = {
  packaged: boolean;
  connectionDetected: boolean;
  status: string;
  toolCount: number;
  hasKey: boolean;
};
export function DesktopConnectorSetup() {
  const [status, setStatus] = useState<Status>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true;
    const refresh = () => {
      void invoke<Status>('desktop_connector_status')
        .then((value) => {
          if (active) setStatus(value);
        })
        .catch(() => {
          if (active) setError('Connection status is available in the installed Windows app.');
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
  async function setup() {
    setBusy(true);
    setError('');
    try {
      await invoke('desktop_connector_setup');
    } catch {
      setError(
        'Setup could not open. Check that this Windows build includes the desktop connector, then retry.',
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <div
      className="my-4 rounded-xl border border-border bg-background p-4"
      aria-label="Browser and desktop connection"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h5 className="font-medium">VibeSpace Desktop Link</h5>
          <p className="mt-1 text-sm text-muted-foreground">
            Connect your OpenAI tunnel in a guided setup page. Your progress is saved on this
            computer.
          </p>
        </div>
        <Button onClick={() => void setup()} disabled={busy || !status?.packaged}>
          {busy ? 'Opening…' : status?.hasKey ? 'Resume setup' : 'Setup'}
        </Button>
      </div>
      <p role="status" className="mt-3 text-sm text-muted-foreground">
        {!status
          ? 'Checking connection…'
          : !status.packaged
            ? 'Connector package is not included in this build.'
            : status.status === 'ready'
              ? `Tunnel ready · ${status.toolCount} tools detected`
              : status.status === 'connecting'
                ? 'Connecting tunnel…'
                : status.connectionDetected
                  ? 'Connection file detected · tunnel disconnected'
                  : 'Preloaded · ready to set up'}
      </p>
      {status?.status === 'ready' && (
        <p className="mt-1 text-sm text-muted-foreground">
          Finish adding the connector in ChatGPT from the setup page.
        </p>
      )}
      {error && (
        <p role="alert" className="mt-2 text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
