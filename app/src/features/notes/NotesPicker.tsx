import {
  forwardRef,
  useEffect,
  useId,
  useRef,
  useImperativeHandle,
  useMemo,
  useState,
  type KeyboardEvent,
} from 'react';
import { Check, Search } from 'lucide-react';
import { motion, useReducedMotion } from 'motion/react';
import { cn } from '@/lib/utils';
import { useThemeMotionTransition } from '@/features/appearance/themeMotion';
import { LEGACY_DROPDOWN_TRANSITION, resolveDropdownMotion } from '../chat/dropdownMotion';
import type { NoteSummary } from './notesContracts';
import './notes.css';

export interface NotesPickerHandle {
  keyDown(event: KeyboardEvent): void;
}
export const NotesPicker = forwardRef<
  NotesPickerHandle,
  {
    notes: readonly NoteSummary[];
    initialQuery?: string;
    onConfirm: (notes: NoteSummary[]) => void;
    onCancel: () => void;
    loading?: boolean;
    error?: string | null;
    onRetry?: () => void;
  }
>(function NotesPicker(
  { notes, initialQuery = '', onConfirm, onCancel, loading, error, onRetry },
  ref,
) {
  const resultsId = useId();
  const resultsRef = useRef<HTMLDivElement>(null);
  const reducedMotion = useReducedMotion();
  const transition = useThemeMotionTransition(LEGACY_DROPDOWN_TRANSITION);
  const [query, setQuery] = useState(initialQuery);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [cursor, setCursor] = useState(-1);
  const [scroll, setScroll] = useState(0);
  useEffect(() => {
    setQuery(initialQuery);
    setCursor(-1);
    setScroll(0);
  }, [initialQuery]);
  const available = useMemo(() => notes.filter((n) => !n.trashed), [notes]);
  const filtered = useMemo(
    () =>
      available.filter((n) =>
        `${n.title} ${n.preview}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()),
      ),
    [available, query],
  );
  const chosen = available.filter((n) => selected.has(n.id));
  const toggle = (id: string) =>
    setSelected((current) => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  const confirm = () => {
    if (chosen.length) onConfirm(chosen);
  };
  const keyDown = (event: KeyboardEvent) => {
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
    if (event.key === ' ' && cursor < 0) return;
    if (!['Enter', 'Escape', 'ArrowDown', 'ArrowUp', ' '].includes(event.key)) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.key === 'Enter') confirm();
    else if (event.key === 'Escape') onCancel();
    else if (event.key === ' ' && filtered[cursor]) toggle(filtered[cursor].id);
    else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (!filtered.length) return;
      const next =
        cursor < 0
          ? event.key === 'ArrowDown'
            ? 0
            : filtered.length - 1
          : (cursor + (event.key === 'ArrowDown' ? 1 : -1) + filtered.length) % filtered.length;
      setCursor(next);
      const top = Math.max(0, next * 58 - 116);
      setScroll(top);
      resultsRef.current?.scrollTo?.({ top });
    }
  };
  useImperativeHandle(ref, () => ({ keyDown }));
  const start = filtered.length > 100 ? Math.max(0, Math.floor(scroll / 58) - 3) : 0;
  const end = filtered.length > 100 ? Math.min(filtered.length, start + 14) : filtered.length;
  return (
    <motion.div
      {...resolveDropdownMotion(reducedMotion, transition)}
      className={cn(
        'vs-notes-picker jarvis-slash-dropdown w-[338px] max-w-[calc(100vw-32px)] overflow-hidden rounded-[14px] border border-border-mid/80',
        'bg-elevated/95 text-foreground backdrop-blur-xl',
        'shadow-[0_18px_50px_rgba(0,0,0,0.52),inset_0_1px_0_hsl(var(--foreground)/0.05),0_0_30px_hsl(var(--accent-copper)/0.1)]',
        '[html[data-theme=monochrome]_&]:shadow-none [html[data-theme=monochrome]_&]:backdrop-blur-none',
        '[html[data-theme=monochrome]_&_*]:bg-none [html[data-theme=monochrome]_&_*]:shadow-none',
      )}
      role="dialog"
      aria-label="Attach notes"
      onKeyDown={keyDown}
    >
      <div className="vs-notes-picker-heading">
        <strong>Attach notes</strong>
        <span>{chosen.length} selected</span>
      </div>
      <label className="vs-notes-search">
        <Search size={14} />
        <input
          aria-label="Search notes to attach"
          placeholder="Search titles and previews"
          aria-controls={resultsId}
          aria-activedescendant={
            filtered[cursor] ? `${resultsId}-${filtered[cursor].id}` : undefined
          }
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setCursor(-1);
            setScroll(0);
          }}
        />
      </label>
      {error && (
        <div role="alert" className="vs-notes-warning">
          {error}
          <button type="button" onClick={onRetry}>
            Retry
          </button>
        </div>
      )}
      <div
        role="listbox"
        aria-label="Notes to attach"
        aria-multiselectable="true"
        className="vs-notes-picker-results"
        id={resultsId}
        ref={resultsRef}
        onScroll={(e) => setScroll(e.currentTarget.scrollTop)}
      >
        {!filtered.length && (
          <p className="vs-notes-empty">{loading ? 'Loading notes…' : 'No matching notes.'}</p>
        )}
        <div style={{ paddingTop: start * 58, paddingBottom: (filtered.length - end) * 58 }}>
          {filtered.slice(start, end).map((note, index) => (
            <button
              type="button"
              role="option"
              aria-label={note.title}
              aria-selected={selected.has(note.id)}
              id={`${resultsId}-${note.id}`}
              className={cn(
                'vs-notes-picker-row relative mx-2 flex w-[calc(100%-1rem)] items-center gap-3 overflow-hidden rounded-[12px] border px-3 py-2.5 text-left transition-all duration-150',
                cursor === start + index
                  ? 'jarvis-slash-item-selected border-accent-copper/60 bg-accent-copper/[0.12] text-foreground shadow-[inset_0_0_0_1px_hsl(var(--foreground)/0.04),0_0_16px_hsl(var(--accent-copper)/0.1)]'
                  : 'border-transparent text-muted-foreground hover:border-border hover:bg-muted/70 hover:text-foreground',
              )}
              data-active={cursor === start + index}
              key={note.id}
              onClick={() => {
                setCursor(start + index);
                toggle(note.id);
              }}
            >
              <span className="vs-notes-checkbox" aria-hidden="true">
                {selected.has(note.id) && <Check size={12} />}
              </span>
              <span>
                <strong>{note.title}</strong>
                <small>{note.preview || 'Empty note'}</small>
              </span>
            </button>
          ))}
        </div>
      </div>
      <div className="vs-notes-picker-footer">
        <span>↑↓ Move · Space Select · Enter Attach</span>
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
        <button
          type="button"
          aria-label="Add selected notes"
          disabled={!chosen.length}
          onClick={confirm}
        >
          Add selected
        </button>
      </div>
    </motion.div>
  );
});
