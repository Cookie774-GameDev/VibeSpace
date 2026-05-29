import { HOTKEYS } from '@/lib/hotkeys';
import { renderHotkey } from '@/lib/utils';

const HOTKEY_LABELS: Record<keyof typeof HOTKEYS, string> = {
  PALETTE: 'Open command palette',
  TOGGLE_NAV: 'Toggle nav pane',
  TOGGLE_INSPECTOR: 'Toggle inspector pane',
  NEW_CHAT: 'New chat',
  NEW_TAB: 'New tab',
  CLOSE_TAB: 'Close tab',
  SEND: 'Send to current agent',
  BROADCAST: 'Broadcast to all agents (council)',
  PUSH_TO_TALK: 'Push-to-talk (global)',
  TOGGLE_TODO: 'Toggle todo drawer',
  SETTINGS: 'Open settings',
  ESCAPE: 'Close modal / exit council',
};

export function Hotkeys() {
  const rows = Object.entries(HOTKEYS) as [keyof typeof HOTKEYS, string][];

  return (
    <div className="flex flex-col gap-6">
      <header>
        <h2 className="text-page-title text-foreground">Hotkeys</h2>
        <p className="text-secondary text-muted-foreground mt-1">
          Keyboard-first. Custom rebindings ship in a later release.
        </p>
      </header>

      <div className="rounded-md border border-border overflow-hidden">
        <table className="w-full text-secondary">
          <thead>
            <tr className="bg-muted">
              <th className="px-3 py-2 text-left font-medium text-muted-foreground">Action</th>
              <th className="px-3 py-2 text-right font-medium text-muted-foreground w-40">Shortcut</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(([key, combo], idx) => (
              <tr
                key={key}
                className={idx % 2 === 0 ? 'bg-background' : 'bg-panel'}
              >
                <td className="px-3 py-2 text-foreground">{HOTKEY_LABELS[key]}</td>
                <td className="px-3 py-2 text-right">
                  <ComboChips combo={combo} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ComboChips({ combo }: { combo: string }) {
  // renderHotkey gives a single string with platform-correct symbols. Split it
  // back into individual visible parts and render each as a chip.
  const rendered = renderHotkey(combo);
  const parts = rendered.split(' ').filter(Boolean);
  return (
    <span className="inline-flex items-center gap-1 justify-end">
      {parts.map((p, i) => (
        <span key={i} className="kbd font-mono">
          {p}
        </span>
      ))}
    </span>
  );
}
