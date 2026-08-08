import { useEffect, useMemo } from 'react';
import { FileText, Image as ImageIcon, Video, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useChatMessages } from './hooks';
import { buildChatOutputInventory, type ChatOutputAsset } from './chatOutputInventory';

function AssetCard({ asset }: { asset: ChatOutputAsset }) {
  const Icon = asset.kind === 'video' ? Video : asset.kind === 'image' ? ImageIcon : FileText;
  return (
    <article
      className="flex gap-3 rounded-lg border border-border bg-panel p-2.5"
      data-chat-output-asset={asset.kind}
    >
      <div className="flex h-14 w-14 shrink-0 items-center justify-center overflow-hidden rounded-md border border-border bg-background">
        {asset.kind === 'image' && asset.url ? (
          <img
            src={asset.url}
            alt={asset.name}
            className="h-full w-full object-cover"
            loading="lazy"
          />
        ) : (
          <Icon className="h-5 w-5 text-muted-foreground" aria-hidden />
        )}
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-ui-strong text-foreground">{asset.name}</p>
        <p className="text-metadata text-muted-foreground capitalize">{asset.kind}</p>
        {asset.path ? (
          <p className="truncate text-metadata text-muted-foreground" title={asset.path}>
            {asset.path}
          </p>
        ) : null}
      </div>
    </article>
  );
}

function Column({
  title,
  empty,
  assets,
}: {
  title: string;
  empty: string;
  assets: ChatOutputAsset[];
}) {
  return (
    <section className="flex min-h-0 flex-1 flex-col gap-2" aria-label={title}>
      <header className="flex items-baseline justify-between gap-2">
        <h3 className="text-ui-strong text-foreground">{title}</h3>
        <span className="text-metadata text-muted-foreground">{assets.length}</span>
      </header>
      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto pr-1">
        {assets.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border px-3 py-6 text-center text-metadata text-muted-foreground">
            {empty}
          </p>
        ) : (
          assets.map((asset) => <AssetCard key={asset.id} asset={asset} />)
        )}
      </div>
    </section>
  );
}

export function ChatOutputPanel({
  chatId,
  open,
  onClose,
}: {
  chatId: string;
  open: boolean;
  onClose: () => void;
}) {
  const messages = useChatMessages(chatId);
  const inventory = useMemo(() => buildChatOutputInventory(messages), [messages]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-3 sm:items-center"
      role="dialog"
      aria-modal="true"
      aria-label="Conversation inputs and outputs"
      data-chat-output-panel="true"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className={cn(
          'flex max-h-[min(88vh,720px)] w-full max-w-4xl flex-col overflow-hidden rounded-xl border border-border bg-background shadow-soft',
        )}
      >
        <header className="flex items-center gap-2 border-b border-border px-4 py-3">
          <div className="min-w-0 flex-1">
            <h2 className="text-ui-strong text-foreground">/output</h2>
            <p className="text-metadata text-muted-foreground">
              Inputs you attached and outputs this chat produced.
            </p>
          </div>
          <button
            type="button"
            className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            aria-label="Close output panel"
            onClick={onClose}
          >
            <X className="h-4 w-4" />
          </button>
        </header>
        <div className="grid min-h-0 flex-1 gap-4 overflow-hidden p-4 md:grid-cols-2">
          <Column
            title="Inputs"
            empty="No images, videos, or files attached yet."
            assets={inventory.inputs}
          />
          <Column
            title="Outputs"
            empty="No generated media or file artifacts yet."
            assets={inventory.outputs}
          />
        </div>
      </div>
    </div>
  );
}
