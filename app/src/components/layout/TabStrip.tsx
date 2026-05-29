import * as React from 'react';
import { Reorder, AnimatePresence } from 'motion/react';
import { Plus, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Hint } from '@/components/ui/tooltip';
import { useHotkey, HOTKEYS } from '@/lib/hotkeys';
import { useUIStore } from '@/stores/ui';
import { newChatId } from '@/lib/ids';
import { cn } from '@/lib/utils';

interface Tab {
  id: string;
  title: string;
}

/**
 * TabStrip - Arc-style tabs above the main canvas.
 *
 * - Drag to reorder via motion/react's <Reorder>.
 * - Cmd+T   - new tab
 * - Cmd+W   - close active tab
 * - Cmd+1..9 - switch to the nth tab if it exists
 *
 * Tabs are local state for now since there is no chats store yet.
 * When a tab becomes active, useUIStore.setActiveChat(id) is called
 * so the rest of the app can bind to the active id.
 */
export function TabStrip() {
  const setActiveChat = useUIStore((s) => s.setActiveChat);
  const [tabs, setTabs] = React.useState<Tab[]>(() => {
    const id = newChatId();
    return [{ id, title: 'New chat' }];
  });
  const [activeId, setActiveId] = React.useState<string | null>(() => tabs[0]?.id ?? null);

  // Keep the global active chat id in sync.
  React.useEffect(() => {
    setActiveChat(activeId);
  }, [activeId, setActiveChat]);

  const addTab = React.useCallback(() => {
    const id = newChatId();
    const tab: Tab = { id, title: 'New chat' };
    setTabs((prev) => [...prev, tab]);
    setActiveId(id);
  }, []);

  const closeTab = React.useCallback(
    (id: string) => {
      setTabs((prev) => {
        const idx = prev.findIndex((t) => t.id === id);
        if (idx === -1) return prev;
        const next = prev.filter((t) => t.id !== id);
        if (id === activeId) {
          const fallback = next[idx] ?? next[idx - 1] ?? null;
          setActiveId(fallback ? fallback.id : null);
        }
        return next;
      });
    },
    [activeId],
  );

  const switchToIndex = React.useCallback(
    (index: number) => {
      const tab = tabs[index];
      if (tab) setActiveId(tab.id);
    },
    [tabs],
  );

  // Hotkeys
  useHotkey(HOTKEYS.NEW_TAB, (e) => {
    e.preventDefault();
    addTab();
  });
  useHotkey(HOTKEYS.CLOSE_TAB, (e) => {
    e.preventDefault();
    if (activeId) closeTab(activeId);
  });
  useHotkey('Mod+1', (e) => {
    e.preventDefault();
    switchToIndex(0);
  });
  useHotkey('Mod+2', (e) => {
    e.preventDefault();
    switchToIndex(1);
  });
  useHotkey('Mod+3', (e) => {
    e.preventDefault();
    switchToIndex(2);
  });
  useHotkey('Mod+4', (e) => {
    e.preventDefault();
    switchToIndex(3);
  });
  useHotkey('Mod+5', (e) => {
    e.preventDefault();
    switchToIndex(4);
  });
  useHotkey('Mod+6', (e) => {
    e.preventDefault();
    switchToIndex(5);
  });
  useHotkey('Mod+7', (e) => {
    e.preventDefault();
    switchToIndex(6);
  });
  useHotkey('Mod+8', (e) => {
    e.preventDefault();
    switchToIndex(7);
  });
  useHotkey('Mod+9', (e) => {
    e.preventDefault();
    switchToIndex(8);
  });

  return (
    <div
      role="tablist"
      aria-label="Open chats"
      className="flex h-8 shrink-0 items-stretch gap-1 border-b border-border bg-panel px-2"
    >
      <Reorder.Group
        as="div"
        axis="x"
        values={tabs}
        onReorder={setTabs}
        className="flex min-w-0 flex-1 items-stretch gap-1 overflow-x-auto scrollbar-hidden"
      >
        <AnimatePresence initial={false}>
          {tabs.map((tab) => (
            <TabItem
              key={tab.id}
              tab={tab}
              active={tab.id === activeId}
              onActivate={() => setActiveId(tab.id)}
              onClose={() => closeTab(tab.id)}
            />
          ))}
        </AnimatePresence>
      </Reorder.Group>

      <div className="flex shrink-0 items-center">
        <Hint label="New chat" hotkey="Mod+T">
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={addTab}
            aria-label="New chat"
          >
            <Plus className="h-4 w-4" />
          </Button>
        </Hint>
      </div>
    </div>
  );
}

interface TabItemProps {
  tab: Tab;
  active: boolean;
  onActivate: () => void;
  onClose: () => void;
}

function TabItem({ tab, active, onActivate, onClose }: TabItemProps) {
  return (
    <Reorder.Item
      value={tab}
      id={tab.id}
      role="tab"
      aria-selected={active}
      whileDrag={{ cursor: 'grabbing', scale: 1.02 }}
      transition={{ type: 'spring', stiffness: 400, damping: 30 }}
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 4 }}
      onPointerDown={onActivate}
      className={cn(
        'group flex h-7 max-w-[200px] shrink-0 cursor-default select-none items-center gap-1.5 self-center rounded-md border border-transparent px-2 text-secondary transition-colors',
        active
          ? 'bg-elevated text-foreground border-border'
          : 'text-muted-foreground hover:bg-muted/50 hover:text-foreground',
      )}
    >
      <span className="min-w-0 flex-1 truncate">{tab.title}</span>
      <button
        type="button"
        aria-label={`Close ${tab.title}`}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
        className={cn(
          'inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-sm text-muted-foreground transition-opacity',
          'hover:bg-muted hover:text-foreground',
          active ? 'opacity-70 hover:opacity-100' : 'opacity-0 group-hover:opacity-70',
        )}
      >
        <X className="h-3 w-3" />
      </button>
    </Reorder.Item>
  );
}
