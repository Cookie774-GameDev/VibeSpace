import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import {
  Bold,
  Check,
  CheckSquare,
  Code2,
  Copy,
  Download,
  FileText,
  Heading2,
  Italic,
  Link2,
  List,
  ListOrdered,
  Pin,
  Plus,
  Quote,
  RotateCcw,
  Search,
  Star,
  Trash2,
} from 'lucide-react';
import {
  formatNoteSelection,
  renderNotesMarkdown,
  toggleNoteChecklist,
  type NoteFormat,
} from './notesFormatting';
import { MAX_NOTE_BODY, type NotePatch } from './notesContracts';
import type { NotesWorkspace } from './notesWorkspace';
import './notes.css';

const FILTERS = ['All', 'Pinned', 'Favorites', 'Trash'] as const;
type Filter = (typeof FILTERS)[number];
const FORMATS = [
  ['heading', 'Heading', Heading2],
  ['bold', 'Bold', Bold],
  ['italic', 'Italic', Italic],
  ['checklist', 'Checklist', CheckSquare],
  ['bullet', 'Bullet list', List],
  ['numbered', 'Numbered list', ListOrdered],
  ['quote', 'Quote', Quote],
  ['link', 'Link', Link2],
  ['code', 'Code block', Code2],
] as const;
export function NotesWorkspaceView({ workspace }: { workspace: NotesWorkspace }) {
  const state = useSyncExternalStore(
    workspace.subscribe,
    workspace.getSnapshot,
    workspace.getSnapshot,
  );
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('All');
  const [preview, setPreview] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [listHeight, setListHeight] = useState(840);
  const editorRef = useRef<HTMLTextAreaElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const focusNew = useRef(false);
  const drag = useRef<{ pointerId: number; x: number; width: number } | null>(null);
  const active = state.active;
  const error = actionError || state.error || state.checkpointError;
  const act = (action: () => void | Promise<unknown>) => {
    setActionError(null);
    try {
      Promise.resolve(action()).catch((e) =>
        setActionError(e instanceof Error ? e.message : 'Notes action failed. Retry.'),
      );
    } catch (e) {
      setActionError(e instanceof Error ? e.message : 'Notes action failed. Retry.');
    }
  };
  const edit = (patch: NotePatch) => {
    if (active) act(() => workspace.edit(active.id, patch));
  };
  const format = (action: NoteFormat) => {
    if (!active || active.trashed) return;
    const editor = editorRef.current;
    const result = formatNoteSelection(
      active.body,
      editor?.selectionStart ?? active.body.length,
      editor?.selectionEnd ?? active.body.length,
      action,
    );
    setPreview(false);
    edit({ body: result.text });
    requestAnimationFrame(() => {
      editorRef.current?.focus();
      editorRef.current?.setSelectionRange(result.start, result.end);
    });
  };
  const exportNote = () => {
    if (!active) return;
    const url = URL.createObjectURL(
      new Blob([`# ${active.title}\n\n${active.body}`], { type: 'text/markdown;charset=utf-8' }),
    );
    const link = document.createElement('a');
    link.href = url;
    link.download = `${active.title.replace(/[<>:"/\\|?*\u0000-\u001f]/gu, '-').slice(0, 100) || 'Untitled note'}.md`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const create = () =>
    act(() => {
      focusNew.current = true;
      setFilter('All');
      setQuery('');
      setPreview(false);
      workspace.create();
      if (listRef.current) listRef.current.scrollTop = 0;
    });
  useLayoutEffect(() => {
    if (active && focusNew.current) {
      editorRef.current?.focus();
      focusNew.current = false;
    }
  }, [active?.id]);
  useEffect(() => {
    if (!listRef.current || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(([entry]) => setListHeight(entry.contentRect.height));
    observer.observe(listRef.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (listRef.current) listRef.current.scrollTop = 0;
    setScrollTop(0);
  }, [query, filter]);
  const filtered = useMemo(
    () =>
      state.notes.filter((note) => {
        if (filter === 'Trash' ? !note.trashed : note.trashed) return false;
        if (filter === 'Pinned' && !note.pinned) return false;
        if (filter === 'Favorites' && !note.favorite) return false;
        return `${note.title} ${note.preview}`
          .toLocaleLowerCase()
          .includes(query.trim().toLocaleLowerCase());
      }),
    [state.notes, query, filter],
  );
  const start = filtered.length > 120 ? Math.max(0, Math.floor(scrollTop / 84) - 5) : 0;
  const end =
    filtered.length > 120
      ? Math.min(filtered.length, start + Math.ceil(listHeight / 84) + 12)
      : filtered.length;
  const previewHtml = useMemo(
    () => (preview && active ? renderNotesMarkdown(active.body) : ''),
    [preview, active?.body],
  );
  const wordCount = useMemo(() => active?.body.trim().match(/\S+/gu)?.length ?? 0, [active?.body]);
  const saveLabel = {
    empty: 'No note selected',
    loading: 'Loading…',
    draft: 'Draft · pending save',
    saving: 'Saving…',
    saved: 'Saved to SiYuan',
    error: 'Not saved · Retry',
  }[state.status];
  return (
    <div className="vs-notes-frame">
      <section className="vs-notes" aria-label="Notes workspace" data-testid="notes-workspace">
        <aside
          className="vs-notes-list-pane"
          aria-label="Notes list"
          style={{ width: state.listWidth }}
        >
          <div className="vs-notes-heading">
            <div>
              <span className="vs-notes-eyebrow">YOUR WORKSPACE</span>
              <h1>
                Notes{' '}
                <span className="vs-notes-count">
                  {state.notes.filter((n) => !n.trashed).length}
                </span>
              </h1>
            </div>
            <FileText size={21} strokeWidth={1.3} />
          </div>
          <button type="button" className="vs-notes-new" aria-label="New Note" onClick={create}>
            <Plus size={15} /> New note <span>Start writing</span>
          </button>
          <label className="vs-notes-search">
            <Search size={13} aria-hidden="true" />
            <input
              aria-label="Search notes"
              placeholder="Search notes"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </label>
          <div className="vs-notes-filters" aria-label="Filter notes">
            {FILTERS.map((item) => (
              <button
                type="button"
                key={item}
                aria-pressed={filter === item}
                onClick={() => setFilter(item)}
              >
                {item}
              </button>
            ))}
          </div>
          <div
            className="vs-notes-list"
            ref={listRef}
            onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
          >
            {filtered.length === 0 && (
              <p className="vs-notes-empty">
                {query
                  ? 'No matching notes.'
                  : filter === 'Trash'
                    ? 'Trash is empty.'
                    : 'A little room for your thoughts.'}
              </p>
            )}
            <div style={{ paddingTop: start * 84, paddingBottom: (filtered.length - end) * 84 }}>
              {filtered.slice(start, end).map((note) => (
                <button
                  type="button"
                  className="vs-notes-row"
                  key={note.id}
                  aria-current={state.activeId === note.id}
                  aria-label={`Open note: ${note.title || 'Untitled note'}`}
                  onClick={() => {
                    setPreview(false);
                    act(() => workspace.select(note.id));
                  }}
                >
                  <span className="vs-notes-row-title">
                    <FileText size={13} aria-hidden="true" />
                    <span>{note.title || 'Untitled note'}</span>
                    {note.pinned && <Pin size={11} aria-label="Pinned" />}
                    {note.favorite && <Star size={11} aria-label="Favorite" />}
                  </span>
                  <span className="vs-notes-row-preview">{note.preview || 'Empty note'}</span>
                  <time dateTime={new Date(note.updatedAt).toISOString()}>
                    {new Date(note.updatedAt).toLocaleDateString(undefined, {
                      month: 'short',
                      day: 'numeric',
                      year: 'numeric',
                    })}
                  </time>
                </button>
              ))}
            </div>
          </div>
        </aside>
        <div
          className="vs-notes-divider"
          role="separator"
          aria-label="Resize notes list"
          aria-orientation="vertical"
          aria-valuemin={200}
          aria-valuemax={480}
          aria-valuenow={state.listWidth}
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
              e.preventDefault();
              act(() =>
                workspace.setListWidth(state.listWidth + (e.key === 'ArrowRight' ? 12 : -12)),
              );
            }
          }}
          onPointerDown={(e) => {
            drag.current = { pointerId: e.pointerId, x: e.clientX, width: state.listWidth };
            e.currentTarget.setPointerCapture(e.pointerId);
          }}
          onPointerMove={(e) => {
            if (drag.current?.pointerId === e.pointerId)
              workspace.setListWidth(drag.current.width + e.clientX - drag.current.x, false);
          }}
          onPointerUp={(e) => {
            if (drag.current?.pointerId === e.pointerId) {
              workspace.checkpoint();
              drag.current = null;
              e.currentTarget.releasePointerCapture(e.pointerId);
            }
          }}
          onLostPointerCapture={() => {
            workspace.checkpoint();
            drag.current = null;
          }}
        />
        <div className="vs-notes-editor">
          {error && (
            <div role="alert" className="vs-notes-warning">
              {error}
              <button
                type="button"
                onClick={() =>
                  act(() => (active ? workspace.flush(active.id) : workspace.refresh()))
                }
              >
                Retry
              </button>
              {active && (
                <button
                  type="button"
                  onClick={() =>
                    act(() => {
                      focusNew.current = true;
                      workspace.saveCopy(active.id);
                    })
                  }
                >
                  Save a copy
                </button>
              )}
            </div>
          )}
          {active ? (
            <>
              <div className="vs-notes-toolbar">
                <span className="vs-notes-save" role="status" aria-label="Note save status">
                  {state.status === 'saved' && <Check size={12} />}
                  {saveLabel}
                </span>
                <button
                  type="button"
                  className="vs-notes-mode"
                  aria-pressed={!preview}
                  onClick={() => setPreview(false)}
                >
                  Source
                </button>
                <button
                  type="button"
                  className="vs-notes-mode"
                  aria-pressed={preview}
                  onClick={() => setPreview(true)}
                >
                  Preview
                </button>
                <span className="vs-notes-action-divider" />
                <button
                  type="button"
                  className="vs-notes-icon"
                  aria-label="Duplicate note"
                  title="Duplicate note"
                  onClick={() =>
                    act(() => {
                      focusNew.current = true;
                      setPreview(false);
                      workspace.saveCopy(active.id);
                    })
                  }
                >
                  <Copy />
                </button>
                <button
                  type="button"
                  className="vs-notes-icon"
                  aria-label="Export Markdown"
                  title="Export Markdown"
                  onClick={() => act(exportNote)}
                >
                  <Download />
                </button>
                <button
                  type="button"
                  className="vs-notes-icon"
                  aria-label={active.pinned ? 'Unpin note' : 'Pin note'}
                  aria-pressed={active.pinned}
                  onClick={() => edit({ pinned: !active.pinned })}
                >
                  <Pin />
                </button>
                <button
                  type="button"
                  className="vs-notes-icon"
                  aria-label={active.favorite ? 'Unfavorite note' : 'Favorite note'}
                  aria-pressed={active.favorite}
                  onClick={() => edit({ favorite: !active.favorite })}
                >
                  <Star />
                </button>
                <button
                  type="button"
                  className="vs-notes-icon"
                  aria-label={active.trashed ? 'Restore note' : 'Move note to Trash'}
                  onClick={() => edit({ trashed: !active.trashed })}
                >
                  {active.trashed ? <RotateCcw /> : <Trash2 />}
                </button>
              </div>
              {active.trashed && (
                <div className="vs-notes-warning">
                  This note is in Trash. Restore it to continue writing or reference it in chat.
                </div>
              )}
              <div className="vs-notes-paper">
                <div className="vs-notes-document-meta">
                  PROJECT NOTES{' '}
                  <span>
                    Updated{' '}
                    {new Date(active.updatedAt).toLocaleDateString(undefined, {
                      month: 'short',
                      day: 'numeric',
                    })}
                  </span>
                </div>
                <input
                  aria-label="Note title"
                  className="vs-notes-title"
                  value={active.title}
                  maxLength={250}
                  readOnly={active.trashed}
                  placeholder="Untitled note"
                  onChange={(e) => edit({ title: e.target.value })}
                  onBlur={() => {
                    if (!active.title.trim()) edit({ title: 'Untitled note' });
                  }}
                />
                <div className="vs-notes-formatbar" role="toolbar" aria-label="Format note">
                  {FORMATS.map(([action, label, Icon]) => (
                    <button
                      type="button"
                      key={action}
                      className="vs-notes-format"
                      aria-label={label}
                      title={label}
                      disabled={active.trashed}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => format(action)}
                    >
                      <Icon size={15} strokeWidth={1.7} />
                    </button>
                  ))}
                  <span className="vs-notes-format-hint">Markdown</span>
                </div>
                <textarea
                  key={active.id}
                  ref={editorRef}
                  aria-label="Note content"
                  className="vs-notes-body"
                  value={active.body}
                  maxLength={MAX_NOTE_BODY}
                  hidden={preview}
                  readOnly={active.trashed}
                  placeholder="Start writing…"
                  spellCheck
                  onChange={(e) => edit({ body: e.target.value })}
                  onKeyDown={(e) => {
                    if (e.nativeEvent.isComposing) return;
                    if (e.ctrlKey || e.metaKey) {
                      const key = e.key.toLowerCase();
                      if (key === 's') {
                        e.preventDefault();
                        act(() => workspace.flush(active.id));
                      }
                      if (key === 'b' || key === 'i') {
                        e.preventDefault();
                        format(key === 'b' ? 'bold' : 'italic');
                      }
                    }
                  }}
                />
                {preview && (
                  <div
                    role="region"
                    aria-label="Note preview"
                    className="vs-notes-preview"
                    onClick={(event) => {
                      const target = event.target as HTMLInputElement;
                      if (
                        target instanceof HTMLInputElement &&
                        target.dataset.noteLine !== undefined
                      ) {
                        if (active.trashed) {
                          event.preventDefault();
                          return;
                        }
                        edit({
                          body: toggleNoteChecklist(active.body, Number(target.dataset.noteLine)),
                        });
                      }
                    }}
                    dangerouslySetInnerHTML={{ __html: previewHtml }}
                  />
                )}
                <div className="vs-notes-footer">
                  <span>
                    {wordCount.toLocaleString()} words <span aria-hidden="true">·</span>{' '}
                    {Math.max(1, Math.ceil(wordCount / 220))} min read
                  </span>
                  <span>{active.body.length.toLocaleString()} characters</span>
                  <span className="vs-notes-footer-scope">Private to this project</span>
                </div>
              </div>
            </>
          ) : (
            <div className="vs-notes-empty">
              <FileText size={24} className="mx-auto" />
              <h2>
                {state.status === 'loading' ? 'Opening your note…' : 'Make room for a thought.'}
              </h2>
              <p>
                Notes stay with this project. Write freely, then use <strong>/notes</strong> to
                bring them into a conversation.
              </p>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
