import * as React from 'react';
import { AppWindow, FileUp, Pin, PinOff, Search } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import type { NativeAppDescriptor } from './nativeApps';

interface NativeAppPickerDialogProps {
  open: boolean;
  apps: readonly NativeAppDescriptor[];
  error?: string | null;
  loading?: boolean;
  onTogglePin?: (app: NativeAppDescriptor) => void;
  onOpenChange: (open: boolean) => void;
  onChoose: (app: NativeAppDescriptor) => void;
  onPickExecutable: () => Promise<NativeAppDescriptor | null>;
}

export function NativeAppPickerDialog({
  open,
  apps,
  error: catalogError,
  loading = false,
  onTogglePin,
  onOpenChange,
  onChoose,
  onPickExecutable,
}: NativeAppPickerDialogProps) {
  const [query, setQuery] = React.useState('');
  const [pickError, setPickError] = React.useState<string | null>(null);
  const [picking, setPicking] = React.useState(false);

  React.useEffect(() => {
    if (!open) {
      setQuery('');
      setPickError(null);
      setPicking(false);
    }
  }, [open]);

  const availableApps = React.useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    return apps.filter(
      (app) =>
        !normalized ||
        app.name.toLocaleLowerCase().includes(normalized) ||
        app.id.toLocaleLowerCase().includes(normalized),
    );
  }, [apps, query]);

  const choose = (app: NativeAppDescriptor) => {
    onChoose(app);
    onOpenChange(false);
  };

  const chooseExecutable = async () => {
    setPicking(true);
    setPickError(null);
    try {
      const app = await onPickExecutable();
      if (app) choose(app);
    } catch (cause) {
      setPickError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPicking(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        aria-label="Open an app"
        className="max-w-xl"
        style={{
          translate: '-50% -50%',
          transform: 'none',
          width: 'calc(100vw - 2rem)',
          maxHeight: 'calc(100dvh - 2rem)',
          overflowY: 'auto',
        }}
      >
        <DialogHeader>
          <DialogTitle>Open an app</DialogTitle>
          <DialogDescription>
            Open an installed app inside Workbench, or pin it to the left taskbar. Unsupported
            embedding uses a separate app window.
          </DialogDescription>
        </DialogHeader>
        <label className="flex items-center gap-2 overflow-hidden rounded-md border border-border px-3 py-2 focus-within:ring-2 focus-within:ring-accent-cyan">
          <Search className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
          <span className="sr-only">Search detected apps</span>
          <input
            aria-label="Search detected apps"
            className="min-w-0 flex-1 !bg-transparent !shadow-none text-sm outline-none"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search installed and running apps"
          />
        </label>
        {loading ? (
          <p role="status" className="text-sm text-muted-foreground">
            Loading installed apps…
          </p>
        ) : null}
        <div className="max-h-72 space-y-2 overflow-y-auto" role="list" aria-busy={loading}>
          {availableApps.map((app) => (
            <div
              key={app.id + ':' + (app.path ?? '')}
              role="listitem"
              className="flex items-center gap-2"
            >
              <button
                type="button"
                aria-label={'Open ' + app.name}
                disabled={!app.launchable}
                className="flex min-w-0 flex-1 items-center gap-3 rounded-md border border-border px-3 py-3 text-left hover:bg-muted/60"
                onClick={() => choose(app)}
              >
                <AppWindow className="h-5 w-5 shrink-0" aria-hidden="true" />
                <span className="min-w-0 flex-1">
                  <strong className="block truncate text-sm">{app.name}</strong>
                  <span className="block truncate text-xs text-muted-foreground">
                    {app.path ?? app.processName ?? 'Detected application'}
                  </span>
                </span>
                {app.running ? (
                  <span className="rounded-full bg-success/15 px-2 py-1 text-xs text-success">
                    Running
                  </span>
                ) : !app.launchable ? (
                  <span>Unavailable</span>
                ) : null}
              </button>
              {onTogglePin ? (
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  aria-label={
                    app.pinned ? `Unpin ${app.name} from taskbar` : `Pin ${app.name} to taskbar`
                  }
                  title={app.pinned ? 'Unpin from taskbar' : 'Pin to taskbar'}
                  aria-pressed={app.pinned}
                  disabled={!app.launchable && !app.pinned}
                  onClick={() => onTogglePin(app)}
                >
                  {app.pinned ? <PinOff className="h-4 w-4" /> : <Pin className="h-4 w-4" />}
                </Button>
              ) : null}
            </div>
          ))}
          {availableApps.length === 0 && !loading ? (
            <p className="py-5 text-center text-sm text-muted-foreground" role="status">
              No matching detected apps.
            </p>
          ) : null}
        </div>
        <p className="text-xs text-muted-foreground">
          Missing an app? Start the app or choose its executable, then reopen Apps.
        </p>
        {catalogError || pickError ? (
          <p role="alert" className="text-sm text-destructive">
            {pickError ?? catalogError}
          </p>
        ) : null}
        <Button
          type="button"
          variant="outline"
          disabled={picking}
          onClick={() => void chooseExecutable()}
        >
          <FileUp className="h-4 w-4" aria-hidden="true" />
          {picking ? 'Opening picker…' : 'Choose executable'}
        </Button>
      </DialogContent>
    </Dialog>
  );
}
