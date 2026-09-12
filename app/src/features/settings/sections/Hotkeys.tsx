import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { RotateCcw, AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DEFAULT_HOTKEYS,
  HOTKEY_LABELS,
  HOTKEY_SETTINGS_ORDER,
  comboFromKeyboardEvent,
  findConflicts,
  isHotkeyCustomized,
  normalizeHotkeyCombo,
  resetAllHotkeyBindings,
  resetHotkeyBinding,
  resolveHotkey,
  setHotkeyBinding,
  type HotkeyConflict,
  type HotkeyId,
} from '@/lib/hotkeys';
import { renderHotkey } from '@/lib/utils';

/**
 * Settings → Hotkeys.
 * Keeps the existing table layout; adds capture, conflict resolution, reset.
 */
export function Hotkeys() {
  const [, bump] = useState(0);
  const refresh = useCallback(() => bump((n) => n + 1), []);
  const [editingId, setEditingId] = useState<HotkeyId | null>(null);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [conflicts, setConflicts] = useState<HotkeyConflict[]>([]);
  const [pendingCombo, setPendingCombo] = useState<string | null>(null);
  const captureRef = useRef<HTMLButtonElement | null>(null);
  const rowRefs = useRef<Partial<Record<HotkeyId, HTMLTableRowElement | null>>>({});
  const liveId = useId();

  useEffect(() => {
    const onChange = () => refresh();
    window.addEventListener('jarvis:hotkeys-changed', onChange);
    return () => window.removeEventListener('jarvis:hotkeys-changed', onChange);
  }, [refresh]);

  const startEdit = (id: HotkeyId) => {
    setEditingId(id);
    setDraft(resolveHotkey(id));
    setError(null);
    setConflicts([]);
    setPendingCombo(null);
    requestAnimationFrame(() => captureRef.current?.focus());
  };

  const cancelEdit = () => {
    setEditingId(null);
    setDraft('');
    setError(null);
    setConflicts([]);
    setPendingCombo(null);
  };

  const jumpToConflict = (id: HotkeyId) => {
    cancelEdit();
    const row = rowRefs.current[id];
    row?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    row?.classList.add('ring-2', 'ring-accent-copper');
    window.setTimeout(() => {
      row?.classList.remove('ring-2', 'ring-accent-copper');
    }, 1600);
    startEdit(id);
  };

  const trySave = (id: HotkeyId, combo: string) => {
    const normalized = normalizeHotkeyCombo(combo);
    const found = findConflicts(id, normalized);
    if (found.length > 0) {
      setConflicts(found);
      setPendingCombo(normalized);
      setError(
        `${renderHotkey(normalized)} is already assigned to ${found.map((c) => c.label).join(', ')}. Change that binding first, or pick another combo.`,
      );
      return;
    }
    const result = setHotkeyBinding(id, normalized);
    if (!result.ok) {
      setError(result.message ?? 'Could not save binding.');
      setConflicts(result.conflicts);
      return;
    }
    cancelEdit();
    refresh();
  };

  const onCaptureKeyDown = (id: HotkeyId, e: React.KeyboardEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.key === 'Escape') {
      cancelEdit();
      return;
    }
    if (e.key === 'Tab' && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
      // Allow keyboard users to leave the capture control.
      cancelEdit();
      return;
    }
    const combo = comboFromKeyboardEvent(e.nativeEvent);
    if (!combo) return;
    setDraft(combo);
    trySave(id, combo);
  };

  const handleResetOne = (id: HotkeyId) => {
    resetHotkeyBinding(id);
    if (editingId === id) cancelEdit();
    refresh();
  };

  const handleResetAll = () => {
    if (!window.confirm('Reset every hotkey to the factory default?')) return;
    resetAllHotkeyBindings();
    cancelEdit();
    refresh();
  };

  return (
    <div className="mc7f-settings-hotkeys flex flex-col gap-6 [html[data-theme=monochrome]_&]:border-l-2 [html[data-theme=monochrome]_&]:border-l-foreground/20 [html[data-theme=monochrome]_&]:pl-4">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-page-title text-foreground">Hotkeys</h2>
          <p className="text-secondary text-muted-foreground mt-1">
            Keyboard-first. Click a shortcut to rebind it. Conflicts must be resolved before saving —
            nothing is overwritten silently.
          </p>
        </div>
        <Button type="button" size="sm" variant="secondary" onClick={handleResetAll}>
          <RotateCcw className="mr-1.5 h-3.5 w-3.5" />
          Reset all to defaults
        </Button>
      </header>

      <div className="rounded-md border border-border overflow-hidden">
        <table className="w-full text-secondary">
          <thead>
            <tr className="bg-muted">
              <th className="px-3 py-2 text-left font-medium text-muted-foreground">Action</th>
              <th className="px-3 py-2 text-right font-medium text-muted-foreground w-56">
                Shortcut
              </th>
              <th className="px-3 py-2 text-right font-medium text-muted-foreground w-28">
                <span className="sr-only">Reset</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {HOTKEY_SETTINGS_ORDER.map((id, idx) => {
              const combo = resolveHotkey(id);
              const customized = isHotkeyCustomized(id);
              const isEditing = editingId === id;
              return (
                <tr
                  key={id}
                  ref={(el) => {
                    rowRefs.current[id] = el;
                  }}
                  data-hotkey-id={id}
                  className={idx % 2 === 0 ? 'bg-background' : 'bg-panel'}
                >
                  <td className="px-3 py-2 text-foreground">
                    <div className="flex flex-col gap-0.5">
                      <span>{HOTKEY_LABELS[id]}</span>
                      {customized ? (
                        <span className="text-metadata text-muted-foreground">
                          Custom · default {renderHotkey(DEFAULT_HOTKEYS[id])}
                        </span>
                      ) : null}
                    </div>
                  </td>
                  <td className="px-3 py-2 text-right">
                    {isEditing ? (
                      <button
                        ref={captureRef}
                        type="button"
                        className="inline-flex min-w-[9rem] items-center justify-end gap-1 rounded-md border border-accent-cyan/50 bg-accent-cyan/10 px-2 py-1 text-left font-mono text-foreground outline-none focus-visible:ring-2 focus-visible:ring-accent-cyan"
                        aria-describedby={liveId}
                        aria-label={`Press new keys for ${HOTKEY_LABELS[id]}`}
                        onKeyDown={(e) => onCaptureKeyDown(id, e)}
                        onBlur={() => {
                          // Keep edit open if focusing conflict buttons
                          window.setTimeout(() => {
                            if (document.activeElement?.closest('[data-hotkey-conflict]')) return;
                            if (editingId === id) cancelEdit();
                          }, 120);
                        }}
                      >
                        {draft ? (
                          <ComboChips combo={draft} />
                        ) : (
                          <span className="text-metadata text-muted-foreground">
                            Press keys…
                          </span>
                        )}
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="inline-flex items-center justify-end gap-1 rounded-md border border-transparent px-2 py-1 hover:border-border hover:bg-muted/40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                        onClick={() => startEdit(id)}
                        aria-label={`Change shortcut for ${HOTKEY_LABELS[id]}, currently ${renderHotkey(combo)}`}
                      >
                        <ComboChips combo={combo} />
                      </button>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      disabled={!customized && !isEditing}
                      onClick={() => handleResetOne(id)}
                      aria-label={`Reset ${HOTKEY_LABELS[id]} to default`}
                    >
                      Reset
                    </Button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <p id={liveId} className="sr-only" aria-live="polite">
        {error ?? ''}
      </p>

      {error || conflicts.length > 0 ? (
        <div
          className="flex flex-col gap-2 rounded-xl border border-destructive/40 bg-destructive/5 p-3 max-w-2xl"
          role="alert"
          data-hotkey-conflict
        >
          <div className="flex items-start gap-2 text-secondary text-foreground">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
            <span>{error}</span>
          </div>
          {conflicts.length > 0 ? (
            <div className="flex flex-wrap gap-2 pl-6">
              {conflicts.map((c) => (
                <Button
                  key={c.id}
                  type="button"
                  size="sm"
                  variant="secondary"
                  data-hotkey-conflict
                  onClick={() => jumpToConflict(c.id)}
                >
                  Change “{c.label}” ({renderHotkey(c.combo)})
                </Button>
              ))}
              {editingId && pendingCombo ? (
                <Button type="button" size="sm" variant="ghost" onClick={cancelEdit}>
                  Cancel
                </Button>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : (
        <p className="text-metadata text-muted-foreground max-w-2xl">
          Tip: modifier combos work in text fields. Bare letter keys are blocked so typing and
          terminals stay safe. OS-reserved combos (for example Mod+Q) cannot be bound.
        </p>
      )}
    </div>
  );
}

function ComboChips({ combo }: { combo: string }) {
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

export default Hotkeys;
