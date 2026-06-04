import * as React from 'react';
import { Copy, Keyboard, MessageSquarePlus, MousePointer2, PanelRightOpen, Search } from 'lucide-react';
import { useUIStore } from '@/stores/ui';
import { cn } from '@/lib/utils';

interface MenuState {
  x: number;
  y: number;
  selection: string;
}

export function JarvisContextMenu() {
  const [menu, setMenu] = React.useState<MenuState | null>(null);
  const setPaletteOpen = useUIStore((s) => s.setPaletteOpen);
  const toggleInspector = useUIStore((s) => s.toggleInspector);
  const setRoute = useUIStore((s) => s.setRoute);

  React.useEffect(() => {
    const close = () => setMenu(null);
    const onContextMenu = (event: MouseEvent) => {
      if (event.defaultPrevented) return;
      if (document.body.classList.contains('jarvis-terminal-right-dragging')) return;
      const suppressUntil = Number(document.body.dataset.jarvisSuppressContextMenuUntil ?? 0);
      if (Number.isFinite(suppressUntil) && Date.now() < suppressUntil) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest('[data-jarvis-suppress-context-menu]')) {
        event.preventDefault();
        return;
      }
      if (target?.closest('[data-native-context-menu]')) return;
      event.preventDefault();
      const selection = window.getSelection()?.toString().trim() ?? '';
      setMenu({ x: event.clientX, y: event.clientY, selection });
    };
    window.addEventListener('contextmenu', onContextMenu);
    window.addEventListener('click', close);
    window.addEventListener('keydown', close);
    window.addEventListener('resize', close);
    return () => {
      window.removeEventListener('contextmenu', onContextMenu);
      window.removeEventListener('click', close);
      window.removeEventListener('keydown', close);
      window.removeEventListener('resize', close);
    };
  }, []);

  if (!menu) return null;

  const copySelection = async () => {
    if (!menu.selection) return;
    await navigator.clipboard?.writeText(menu.selection);
    setMenu(null);
  };

  const left = Math.min(menu.x, window.innerWidth - 260);
  const top = Math.min(menu.y, window.innerHeight - 260);

  return (
    <div
      className="jarvis-context-menu"
      style={{ left, top }}
      role="menu"
      onClick={(event) => event.stopPropagation()}
    >
      <MenuButton icon={<Search />} label="Command Palette" shortcut="Ctrl+K" onClick={() => { setPaletteOpen(true); setMenu(null); }} />
      <MenuButton icon={<PanelRightOpen />} label="Toggle Inspector" shortcut="Ctrl+\\" onClick={() => { toggleInspector(); setMenu(null); }} />
      <MenuButton icon={<MessageSquarePlus />} label="Open Chat" onClick={() => { setRoute('chat'); setMenu(null); }} />
      <MenuButton icon={<Keyboard />} label="Open Settings" shortcut="Ctrl+," onClick={() => { useUIStore.getState().setSettingsOpen(true); setMenu(null); }} />
      <div className="my-1 h-px bg-border/80" />
      <MenuButton icon={<Copy />} label="Copy Selection" shortcut="Ctrl+C" disabled={!menu.selection} onClick={() => void copySelection()} />
      <div className="mt-1 rounded-lg bg-accent-copper/10 px-2 py-1.5 text-[11px] text-accent-copper">
        <MousePointer2 className="mr-1 inline h-3 w-3" /> Right-drag files or Context maps to paste paths.
      </div>
    </div>
  );
}

function MenuButton({
  icon,
  label,
  shortcut,
  disabled,
  onClick,
}: {
  icon: React.ReactElement;
  label: string;
  shortcut?: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-secondary text-foreground transition-colors',
        disabled ? 'cursor-not-allowed opacity-45' : 'hover:bg-accent-copper/12',
      )}
      role="menuitem"
    >
      {React.cloneElement(icon, { className: 'h-4 w-4 text-accent-copper' })}
      <span className="min-w-0 flex-1">{label}</span>
      {shortcut ? <span className="font-mono text-[11px] text-muted-foreground">{shortcut}</span> : null}
    </button>
  );
}
