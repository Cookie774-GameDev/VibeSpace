import * as React from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { Command } from 'cmdk';
import { ChevronRight, Search } from 'lucide-react';
import { Dialog, DialogPortal, DialogOverlay } from '@/components/ui/dialog';
import { HOTKEYS } from '@/lib/hotkeys';
import { cn, renderHotkey } from '@/lib/utils';
import { useUIStore } from '@/stores/ui';
import type { ActionContext } from './actions';
import { PAGE_GROUP_CLASS, PageContent } from './pages';
import {
  PAGE_LABELS,
  type PageId,
  getCurrentPage,
  usePaletteStore,
} from './store';

/**
 * Per-page placeholder text for the search input.
 */
const PLACEHOLDERS: Record<PageId, string> = {
  root: 'Search actions, agents, chats...',
  theme: 'Search theme...',
  'switch-agent': 'Search agents...',
  'switch-mode': 'Search chat modes...',
  new: 'Create...',
  'recent-chats': 'Search recent chats...',
  tasks: 'Search tasks...',
};

/**
 * Page-aware empty messages. Shown by cmdk's <Command.Empty/> when the
 * current page has no items (either because the data is empty or
 * because the search filtered everything out).
 */
function emptyMessageForPage(page: PageId): string {
  switch (page) {
    case 'switch-agent':
      return 'No agents match.';
    case 'recent-chats':
      return 'No recent chats yet.';
    case 'tasks':
      return 'No open tasks.';
    default:
      return 'No results found.';
  }
}

/* -------------------------------------------------------------------------
 * Breadcrumb header
 * ------------------------------------------------------------------------- */

function Breadcrumb({
  pageStack,
  onJump,
}: {
  pageStack: PageId[];
  onJump: (index: number) => void;
}) {
  // Index -1 represents the implicit root; later indices map to the stack.
  const segments = [
    { label: PAGE_LABELS.root, index: -1 },
    ...pageStack.map((p, i) => ({ label: PAGE_LABELS[p], index: i })),
  ];

  return (
    <div className="flex items-center gap-1 px-3 h-8 border-b border-border select-none">
      {segments.map((seg, i) => {
        const isLast = i === segments.length - 1;
        return (
          <React.Fragment key={`${seg.index}-${seg.label}`}>
            {i > 0 ? (
              <ChevronRight
                className="h-3 w-3 text-muted-foreground/60 shrink-0"
                aria-hidden
              />
            ) : null}
            {isLast ? (
              <span className={cn('text-secondary', i === 0 ? 'text-muted-foreground' : 'text-foreground font-medium')}>
                {seg.label}
              </span>
            ) : (
              <button
                type="button"
                onClick={() => onJump(seg.index)}
                className="rounded px-1 py-0.5 text-secondary text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
              >
                {seg.label}
              </button>
            )}
          </React.Fragment>
        );
      })}
    </div>
  );
}

/* -------------------------------------------------------------------------
 * Footer hint bar
 * ------------------------------------------------------------------------- */

function FooterHints({ canPop }: { canPop: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3 px-3 py-2 border-t border-border text-metadata text-muted-foreground">
      <div className="flex items-center gap-3">
        <span className="flex items-center gap-1">
          <kbd className="kbd">&#8629;</kbd>
          <span>Select</span>
        </span>
        <span className="flex items-center gap-1">
          <kbd className="kbd">&uarr;</kbd>
          <kbd className="kbd">&darr;</kbd>
          <span>Navigate</span>
        </span>
        <span className="flex items-center gap-1">
          <kbd className="kbd">&#9003;</kbd>
          <span>{canPop ? 'Back' : 'Close'}</span>
        </span>
      </div>
      <span className="font-mono">{renderHotkey(HOTKEYS.PALETTE)}</span>
    </div>
  );
}

/* -------------------------------------------------------------------------
 * Command palette
 *
 * The global modal palette. Mount once at app root. State lives in
 * `useUIStore.paletteOpen` (open/close) and the palette's own
 * `usePaletteStore` (page stack, search).
 * ------------------------------------------------------------------------- */

export function CommandPalette() {
  const open = useUIStore((s) => s.paletteOpen);
  const setPaletteOpen = useUIStore((s) => s.setPaletteOpen);

  const pageStack = usePaletteStore((s) => s.pageStack);
  const search = usePaletteStore((s) => s.search);
  const setSearch = usePaletteStore((s) => s.setSearch);
  const pushPage = usePaletteStore((s) => s.pushPage);
  const popPage = usePaletteStore((s) => s.popPage);
  const popToIndex = usePaletteStore((s) => s.popToIndex);
  const resetPages = usePaletteStore((s) => s.resetPages);

  const currentPage = getCurrentPage(pageStack);
  const canPop = pageStack.length > 0;

  const close = React.useCallback(() => {
    setPaletteOpen(false);
  }, [setPaletteOpen]);

  // Whenever the palette closes, reset the page stack so re-opening
  // always starts at root.
  React.useEffect(() => {
    if (!open) resetPages();
  }, [open, resetPages]);

  const ctx: ActionContext = React.useMemo(
    () => ({ closePalette: close, pushPage }),
    [close, pushPage],
  );

  /**
   * Backspace at the start of an empty search:
   *  - on a sub-page: pop one level
   *  - on root: close the palette
   * If the search has any value, let the input handle the backspace
   * normally so the user can edit the query.
   */
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (
      e.key === 'Backspace' &&
      search === '' &&
      !e.metaKey &&
      !e.ctrlKey &&
      !e.altKey &&
      !e.shiftKey
    ) {
      e.preventDefault();
      e.stopPropagation();
      if (canPop) {
        popPage();
      } else {
        close();
      }
    }
  };

  return (
    <Dialog open={open} onOpenChange={setPaletteOpen}>
      <DialogPortal>
        <DialogOverlay className="bg-black/60" />
        <DialogPrimitive.Content
          aria-label="Command palette"
          onEscapeKeyDown={(e) => {
            if (canPop) {
              // On a sub-page, Esc pops one level instead of closing.
              e.preventDefault();
              popPage();
            }
            // On root, fall through to default behaviour (close).
          }}
          className={cn(
            'fixed left-1/2 top-[15vh] z-50 w-[calc(100%-2rem)] max-w-2xl -translate-x-1/2',
            'border border-border bg-elevated rounded-lg shadow-2xl',
            'data-[state=open]:animate-scale-in data-[state=closed]:animate-fade-out',
            'overflow-hidden flex flex-col',
          )}
        >
          {/* Required for accessibility - hidden visually. */}
          <DialogPrimitive.Title className="sr-only">Command palette</DialogPrimitive.Title>
          <DialogPrimitive.Description className="sr-only">
            Run an action, switch agents, or jump to a recent chat. Type to filter.
          </DialogPrimitive.Description>

          <Command
            label="Command palette"
            shouldFilter
            onKeyDown={onKeyDown}
            className={cn(
              'flex flex-col w-full bg-transparent outline-none',
              PAGE_GROUP_CLASS,
            )}
          >
            <Breadcrumb pageStack={pageStack} onJump={popToIndex} />

            <div className="flex items-center gap-2 px-3 border-b border-border">
              <Search className="h-4 w-4 text-muted-foreground shrink-0" aria-hidden />
              <Command.Input
                value={search}
                onValueChange={setSearch}
                placeholder={PLACEHOLDERS[currentPage]}
                autoFocus
                className={cn(
                  'flex-1 h-11 bg-transparent text-body text-foreground',
                  'placeholder:text-muted-foreground outline-none border-0',
                )}
              />
            </div>

            <Command.List className="max-h-[420px] overflow-y-auto p-1.5 [&_[cmdk-list-sizer]]:w-full">
              <Command.Empty className="px-3 py-8 text-center text-secondary text-muted-foreground">
                {emptyMessageForPage(currentPage)}
              </Command.Empty>
              <PageContent page={currentPage} ctx={ctx} />
            </Command.List>

            <FooterHints canPop={canPop} />
          </Command>
        </DialogPrimitive.Content>
      </DialogPortal>
    </Dialog>
  );
}
