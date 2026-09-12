import * as React from 'react';
import { ArchiveRestore, Bot, Puzzle, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/toast';
import { RecycleBinConfirmDialog } from './RecycleBinConfirmDialog';
import { recycleBinService } from './recycleBinService';
import { recycleBinStore, type RecycleBinItem } from './recycleBinStore';

const DAY_MS = 24 * 60 * 60 * 1000;
const EMPTY_SNAPSHOT: readonly RecycleBinItem[] = [];

type Confirmation = { action: 'delete'; item: RecycleBinItem } | { action: 'empty' } | null;

function daysRemaining(item: RecycleBinItem): number {
  return Math.max(1, Math.ceil((item.expiresAt - Date.now()) / DAY_MS));
}

function formattedDate(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  }).format(timestamp);
}

export function RecycleBinSettings() {
  const items = React.useSyncExternalStore(
    recycleBinStore.subscribe,
    () => recycleBinStore.getSnapshot(),
    () => EMPTY_SNAPSHOT,
  );
  const [restoring, setRestoring] = React.useState<string | null>(null);
  const [confirmation, setConfirmation] = React.useState<Confirmation>(null);
  const [expirationCheck, setExpirationCheck] = React.useState(0);

  React.useEffect(() => {
    try {
      recycleBinStore.pruneExpired();
    } catch {
      // Keep the durable recovery copy visible if storage is temporarily
      // unavailable; the service still rejects an expired restore exactly.
    }
    const nearestExpiry = items.reduce(
      (nearest, item) => Math.min(nearest, item.expiresAt),
      Number.POSITIVE_INFINITY,
    );
    if (!Number.isFinite(nearestExpiry)) return;
    let retryTimer: number | undefined;
    const timer = window.setTimeout(
      () => {
        try {
          recycleBinStore.pruneExpired();
          setExpirationCheck((value) => value + 1);
        } catch {
          retryTimer = window.setTimeout(() => setExpirationCheck((value) => value + 1), 60_000);
        }
      },
      Math.min(2_147_483_647, Math.max(0, nearestExpiry - Date.now())),
    );
    return () => {
      window.clearTimeout(timer);
      if (retryTimer !== undefined) window.clearTimeout(retryTimer);
    };
  }, [expirationCheck, items]);

  const restore = async (item: RecycleBinItem) => {
    if (restoring) return;
    setRestoring(item.archiveId);
    try {
      const result = await recycleBinService.restore(item);
      toast.success(
        result.renamed ? 'Restored as a copy' : 'Restored',
        result.renamed
          ? `${item.name} was restored with a safe new identity.`
          : `${item.name} is active again.`,
      );
    } catch (error) {
      toast.error(
        'Restore failed',
        error instanceof Error ? error.message : 'This item could not be restored.',
      );
    } finally {
      setRestoring(null);
    }
  };

  const confirmationTitle =
    confirmation?.action === 'delete'
      ? `Permanently delete ${confirmation.item.name}?`
      : 'Empty the Recycle Bin?';
  const confirmationDescription =
    confirmation?.action === 'delete'
      ? 'This immediately removes the recovery copy. This action cannot be undone.'
      : `This permanently deletes all ${items.length} recoverable item${items.length === 1 ? '' : 's'}. This action cannot be undone.`;

  return (
    <section
      className="rounded-lg border border-border bg-panel p-4"
      aria-labelledby="recycle-bin-title"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 id="recycle-bin-title" className="text-ui-strong text-foreground">
            Recycle Bin
          </h3>
          <p className="mt-1 text-metadata text-muted-foreground">
            Deleted custom agents and skills stay recoverable on this device for exactly 90 days.
            Built-in agents and preset skills are protected.
          </p>
        </div>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={items.length === 0}
          onClick={() => setConfirmation({ action: 'empty' })}
        >
          <Trash2 aria-hidden="true" />
          Empty Recycle Bin
        </Button>
      </div>

      {items.length === 0 ? (
        <div className="mt-4 rounded-md border border-dashed border-border p-5 text-center">
          <ArchiveRestore className="mx-auto h-5 w-5 text-muted-foreground" aria-hidden="true" />
          <p className="mt-2 text-secondary text-foreground">Recycle Bin is empty</p>
          <p className="text-metadata text-muted-foreground">
            Recoverable custom agents and skills will appear here.
          </p>
        </div>
      ) : (
        <ul className="mt-4 divide-y divide-border rounded-md border border-border">
          {items.map((item) => {
            const Icon = item.kind === 'agent' ? Bot : Puzzle;
            return (
              <li key={item.archiveId} className="flex flex-wrap items-center gap-3 p-3">
                <span className="grid h-9 w-9 place-items-center rounded-md bg-muted text-muted-foreground">
                  <Icon aria-hidden="true" />
                </span>
                <div className="min-w-[180px] flex-1">
                  <p className="truncate text-secondary font-medium text-foreground">{item.name}</p>
                  <p className="text-metadata text-muted-foreground">
                    <span>{item.kind === 'agent' ? 'Agent' : 'Custom skill'}</span>
                    <span aria-hidden="true"> · </span>
                    Deleted {formattedDate(item.deletedAt)}
                    <span aria-hidden="true"> · </span>
                    <span>{daysRemaining(item)} days remaining</span>
                  </p>
                </div>
                <div className="flex items-center gap-1.5">
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    disabled={restoring !== null}
                    aria-label={`Restore ${item.name}`}
                    onClick={() => void restore(item)}
                  >
                    <ArchiveRestore aria-hidden="true" />
                    {restoring === item.archiveId ? 'Restoring…' : 'Restore'}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    aria-label={`Permanently delete ${item.name}`}
                    onClick={() => setConfirmation({ action: 'delete', item })}
                  >
                    <Trash2 className="text-destructive" aria-hidden="true" />
                    Delete permanently
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <RecycleBinConfirmDialog
        open={confirmation !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmation(null);
        }}
        title={confirmationTitle}
        description={confirmationDescription}
        confirmLabel={
          confirmation?.action === 'delete' ? 'Delete permanently' : 'Empty Recycle Bin permanently'
        }
        onConfirm={() => {
          if (confirmation?.action === 'delete') {
            recycleBinService.permanentlyDelete(confirmation.item.archiveId);
            toast.info('Permanently deleted', confirmation.item.name);
          } else if (confirmation?.action === 'empty') {
            recycleBinService.empty();
            toast.info('Recycle Bin emptied');
          }
        }}
      />
    </section>
  );
}
