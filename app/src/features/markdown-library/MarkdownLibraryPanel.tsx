import * as React from 'react';
import { BookOpen, History, Plus, RotateCcw, Save, Search } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { isTauri } from '@/lib/utils';
import type { MarkdownDocumentMetadataV1 } from './contracts';
import { openNativeMarkdownLibrary } from './nativeAdapters';
import { MARKDOWN_LIBRARY_MUTATION_MAX_BYTES } from './runtime';

type Session = Awaited<ReturnType<typeof openNativeMarkdownLibrary>>;

function message(error: unknown): string {
  const code = error instanceof Error ? error.message : '';
  if (code === 'markdown_library_revision_stale' || code === 'markdown_library_file_stale') {
    return 'This document changed elsewhere. Reopen it before editing.';
  }
  if (code === 'markdown_library_file_exists') return 'A document with this title already exists.';
  if (code === 'markdown_library_content_invalid') return 'The document exceeds the 256 KiB limit.';
  if (code === 'markdown_library_title_invalid') return 'Enter a title without line breaks.';
  return 'The Markdown library could not complete that action. Your existing files were kept.';
}

export function MarkdownLibraryPanel({
  accountId,
  projectId,
  desktopAvailable = isTauri,
  openLibrary = openNativeMarkdownLibrary,
}: {
  accountId: string;
  projectId: string;
  desktopAvailable?: boolean;
  openLibrary?: typeof openNativeMarkdownLibrary;
}) {
  const [session, setSession] = React.useState<Session | null>(null);
  const [documents, setDocuments] = React.useState<readonly MarkdownDocumentMetadataV1[]>([]);
  const [query, setQuery] = React.useState('');
  const [selected, setSelected] = React.useState<MarkdownDocumentMetadataV1 | null>(null);
  const [content, setContent] = React.useState('');
  const [baseline, setBaseline] = React.useState('');
  const [newDocument, setNewDocument] = React.useState(false);
  const [newTitle, setNewTitle] = React.useState('');
  const [newBody, setNewBody] = React.useState('');
  const [history, setHistory] = React.useState<readonly { revision: number; createdAt: number }[]>(
    [],
  );
  const [preview, setPreview] = React.useState<{ revision: number; content: string } | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!desktopAvailable) return;
    let cancelled = false;
    setSession(null);
    setSelected(null);
    setDocuments([]);
    setError(null);
    void (async () => {
      try {
        const opened = await openLibrary(accountId, projectId);
        await opened.authority.reindex(opened.scope);
        const rows = await opened.authority.list(opened.scope);
        if (!cancelled) {
          setSession(opened);
          setDocuments(rows);
        }
      } catch (caught) {
        if (!cancelled) setError(message(caught));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [accountId, projectId, desktopAvailable, openLibrary]);

  React.useEffect(() => {
    if (!session) return;
    let cancelled = false;
    void session.authority.list(session.scope, { query }).then(
      (rows) => {
        if (!cancelled) setDocuments(rows);
      },
      (caught) => {
        if (!cancelled) setError(message(caught));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [session, query]);

  const run = async (operation: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await operation();
    } catch (caught) {
      setError(message(caught));
    } finally {
      setBusy(false);
    }
  };

  const refresh = async (opened: Session, search = query) => {
    await opened.authority.reindex(opened.scope);
    setDocuments(await opened.authority.list(opened.scope, { query: search }));
  };

  const open = async (opened: Session, id: string) => {
    const result = await opened.authority.open(opened.scope, id);
    const page = await opened.authority.history(opened.scope, id);
    setSelected(result.document);
    setContent(result.content);
    setBaseline(result.content);
    setHistory(page.items);
    setPreview(null);
    setNewDocument(false);
  };

  const dirty = content !== baseline;
  const newContentBytes = new TextEncoder().encode(`# ${newTitle.trim()}\n\n${newBody}`).byteLength;
  const contentBytes = new TextEncoder().encode(content).byteLength;

  return (
    <section
      aria-label="Markdown Library"
      data-sakura-surface="project-markdown-library"
      className="surface-panel rounded-lg p-5 space-y-4"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 text-ui-strong text-foreground">
            <BookOpen className="h-4 w-4" /> Markdown Library
          </div>
          <p className="mt-0.5 text-metadata text-muted-foreground">
            Project Markdown files and revision history saved on this device.
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          disabled={!session || busy || dirty || newDocument}
          onClick={() => {
            setNewDocument(true);
            setSelected(null);
            setPreview(null);
            setNewTitle('');
            setNewBody('');
          }}
        >
          <Plus className="h-3.5 w-3.5" /> New Markdown
        </Button>
      </div>

      {!desktopAvailable ? (
        <p className="text-secondary text-muted-foreground">
          Open VibeSpace desktop to use this library.
        </p>
      ) : !session && !error ? (
        <p role="status" className="text-secondary text-muted-foreground">
          Loading library…
        </p>
      ) : null}
      {error && (
        <p role="alert" className="text-secondary text-destructive">
          {error}
        </p>
      )}

      {session && (
        <>
          <div className="relative">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              aria-label="Search Markdown library"
              className="pl-9"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search titles and content"
            />
          </div>
          <div className="grid gap-4 md:grid-cols-[minmax(12rem,0.8fr)_minmax(0,1.2fr)]">
            <div
              aria-label="Markdown documents"
              className="max-h-64 space-y-1 overflow-y-auto rounded-md border border-border p-2"
            >
              {documents.length === 0 && (
                <p className="p-2 text-metadata text-muted-foreground">No matching documents.</p>
              )}
              {documents.map((document) => (
                <button
                  key={document.documentId}
                  type="button"
                  disabled={busy || dirty}
                  aria-current={selected?.documentId === document.documentId ? 'true' : undefined}
                  onClick={() => void run(() => open(session, document.documentId))}
                  className="block w-full rounded-md px-3 py-2 text-left text-secondary text-foreground hover:bg-muted disabled:opacity-50"
                >
                  <span className="block truncate">{document.title}</span>
                  <span className="text-metadata text-muted-foreground">
                    Revision {document.revision}
                  </span>
                </button>
              ))}
            </div>
            <div className="min-w-0 space-y-3">
              {newDocument ? (
                <form
                  className="space-y-3"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void run(async () => {
                      const created = await session.authority.create(session.scope, {
                        title: newTitle,
                        body: newBody,
                      });
                      setQuery('');
                      await refresh(session, '');
                      await open(session, created.documentId);
                    });
                  }}
                >
                  <Input
                    aria-label="New Markdown title"
                    value={newTitle}
                    maxLength={256}
                    onChange={(event) => setNewTitle(event.target.value)}
                    placeholder="Document title"
                  />
                  <Textarea
                    aria-label="New Markdown body"
                    value={newBody}
                    onChange={(event) => setNewBody(event.target.value)}
                    placeholder="Write Markdown…"
                    className="min-h-40 font-mono"
                  />
                  <div className="flex gap-2">
                    <Button
                      type="submit"
                      variant="accent"
                      size="sm"
                      disabled={
                        busy ||
                        !newTitle.trim() ||
                        newContentBytes > MARKDOWN_LIBRARY_MUTATION_MAX_BYTES
                      }
                    >
                      Create document
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => setNewDocument(false)}
                    >
                      Cancel
                    </Button>
                  </div>
                </form>
              ) : selected ? (
                <>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="text-ui-strong text-foreground">
                      {selected.title} · revision {selected.revision}
                    </div>
                    <div className="flex gap-2">
                      {dirty && (
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={busy}
                          onClick={() => setContent(baseline)}
                        >
                          Discard edits
                        </Button>
                      )}
                      <Button
                        variant="accent"
                        size="sm"
                        disabled={
                          busy || !dirty || contentBytes > MARKDOWN_LIBRARY_MUTATION_MAX_BYTES
                        }
                        onClick={() =>
                          void run(async () => {
                            const saved = await session.authority.save(
                              session.scope,
                              selected.documentId,
                              selected.revision,
                              content,
                            );
                            setSelected(saved);
                            setBaseline(content);
                            setHistory(
                              (await session.authority.history(session.scope, saved.documentId))
                                .items,
                            );
                            await refresh(session);
                          })
                        }
                      >
                        <Save className="h-3.5 w-3.5" /> Save Markdown
                      </Button>
                    </div>
                  </div>
                  <Textarea
                    aria-label="Markdown content"
                    value={content}
                    onChange={(event) => setContent(event.target.value)}
                    className="min-h-48 font-mono"
                  />
                  <div className="text-metadata text-muted-foreground">
                    {contentBytes.toLocaleString()} /{' '}
                    {MARKDOWN_LIBRARY_MUTATION_MAX_BYTES.toLocaleString()} bytes
                  </div>
                  <div className="space-y-2 border-t border-border pt-3">
                    <div className="flex items-center gap-2 text-secondary font-medium">
                      <History className="h-4 w-4" /> Revision history
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {history.map((revision) => (
                        <Button
                          key={revision.revision}
                          aria-label={`View revision ${revision.revision}`}
                          variant="outline"
                          size="sm"
                          disabled={busy}
                          onClick={() =>
                            void run(async () => {
                              setPreview({
                                revision: revision.revision,
                                content: await session.authority.revisionContent(
                                  session.scope,
                                  selected.documentId,
                                  revision.revision,
                                ),
                              });
                            })
                          }
                        >
                          Revision {revision.revision}
                        </Button>
                      ))}
                    </div>
                    {preview && (
                      <div className="space-y-2 rounded-md border border-border p-3">
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-metadata text-muted-foreground">
                            Revision {preview.revision} · read-only
                          </span>
                          {preview.revision !== selected.revision && (
                            <Button
                              variant="outline"
                              size="sm"
                              disabled={busy || dirty}
                              onClick={() =>
                                void run(async () => {
                                  await session.authority.rollback(
                                    session.scope,
                                    selected.documentId,
                                    preview.revision,
                                  );
                                  await open(session, selected.documentId);
                                  await refresh(session);
                                })
                              }
                            >
                              <RotateCcw className="h-3.5 w-3.5" /> Restore revision
                            </Button>
                          )}
                        </div>
                        <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words text-metadata text-foreground">
                          {preview.content}
                        </pre>
                      </div>
                    )}
                  </div>
                </>
              ) : (
                <p className="text-secondary text-muted-foreground">
                  Select a document or create a new one.
                </p>
              )}
            </div>
          </div>
        </>
      )}
    </section>
  );
}
