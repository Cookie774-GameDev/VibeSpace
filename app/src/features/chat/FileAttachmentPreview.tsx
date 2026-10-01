import { useEffect, useState } from 'react';
import { FileText, Loader2, X } from 'lucide-react';
import { readTextFileSample } from '@/lib/fs';

const MAX_PREVIEW_BYTES = 64 * 1024;

type PreviewState =
  | { status: 'loading' }
  | { status: 'ready'; content: string }
  | { status: 'error'; message: string };

export function FileAttachmentPreview({
  path,
  projectRoot,
  onClose,
}: {
  path: string;
  projectRoot: string;
  onClose: () => void;
}) {
  const [state, setState] = useState<PreviewState>({ status: 'loading' });
  const label = path.split(/[/\\]/).pop() ?? path;

  useEffect(() => {
    let cancelled = false;
    setState({ status: 'loading' });
    void readTextFileSample(path, MAX_PREVIEW_BYTES, { root: projectRoot }).then((result) => {
      if (cancelled) return;
      if (result.ok) {
        setState({ status: 'ready', content: result.content });
      } else {
        setState({
          status: 'error',
          message: result.error.raw || 'This file cannot be previewed.',
        });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [path, projectRoot]);

  return (
    <aside
      className="mx-2 mb-2 overflow-hidden rounded-xl border border-border/80 bg-background/95 shadow-soft backdrop-blur"
      aria-label={`Preview of ${label}`}
    >
      <header className="flex h-9 items-center gap-2 border-b border-border/70 px-3">
        <FileText aria-hidden="true" className="h-3.5 w-3.5 text-accent-copper" />
        <strong className="min-w-0 flex-1 truncate text-metadata">{label}</strong>
        <button
          type="button"
          className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label={`Close preview of ${label}`}
          onClick={onClose}
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </header>
      {state.status === 'loading' ? (
        <div className="flex h-24 items-center justify-center gap-2 text-metadata text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          Loading preview…
        </div>
      ) : state.status === 'error' ? (
        <p className="px-3 py-4 text-metadata text-destructive">{state.message}</p>
      ) : (
        <pre className="max-h-56 overflow-auto whitespace-pre-wrap break-words p-3 font-mono text-[12px] leading-5 text-foreground">
          {state.content}
        </pre>
      )}
    </aside>
  );
}
