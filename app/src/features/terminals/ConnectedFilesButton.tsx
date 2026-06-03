/**
 * ConnectedFilesButton — popover affordance in each terminal pane's
 * chrome strip. Lets the user pin a list of file paths to a pane so
 * the AI runtime can read them and inject excerpts into the agent's
 * system prompt for any request that targets the pane's `agentSlug`.
 *
 * Why a popover over a side panel:
 *   - Pane chrome is tight (28 px tall). Anything taller is too much
 *     visual weight for an "occasionally used" affordance.
 *   - The list itself is short — the cap is small and the typical use
 *     is two or three files (a spec + a target source file).
 *   - The popover keeps the data spatially close to the pane so the
 *     user sees which pane the files are bound to without reading.
 *
 * The button shows a paperclip icon. When the pane has files
 * attached, a small numeric badge sits in the top-right corner of
 * the icon — same visual language used elsewhere for counts.
 *
 * Storage: file paths live on the leaf as `connectedFiles: string[]`.
 * The runtime reads them via `lib/fs.ts:readTextFiles` only when an
 * AI request fires; this component never reads file content itself.
 *
 * Pasting paths: a tiny input + add button. We accept absolute
 * paths only (the Rust command rejects relative paths anyway). Multi-
 * paste is handled by splitting on newlines + commas so a user can
 * paste a list copied from a shell.
 */

import * as React from 'react';
import { Paperclip, Trash2, Plus, AlertTriangle, FolderOpen } from 'lucide-react';

import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { useAuthStore } from '@/stores/auth';
import { useUIStore } from '@/stores/ui';
import { setStoredContextSelectedFile } from '@/features/context/tree';
import { chooseProjectFiles } from '@/features/files/projectFiles';

interface ConnectedFilesButtonProps {
  /** Current file paths attached to the pane. */
  files: string[];
  /** Persist updated list back onto the leaf. */
  onChange: (next: string[]) => void;
}

/** Hard cap so the system prompt doesn't balloon. */
const MAX_FILES = 8;

/** Soft heuristic — anything that doesn't smell like an absolute path is rejected client-side. */
function looksAbsolute(p: string): boolean {
  // POSIX: starts with `/`. Windows: drive letter (`C:\` or `C:/`) or UNC (`\\`).
  if (!p) return false;
  if (p.startsWith('/')) return true;
  if (/^[A-Za-z]:[\\/]/.test(p)) return true;
  if (p.startsWith('\\\\')) return true;
  return false;
}

/** Normalise pasted blobs into individual paths. */
function splitPaths(blob: string): string[] {
  return blob
    .split(/[\r\n]+|,/g)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export function ConnectedFilesButton({
  files,
  onChange,
}: ConnectedFilesButtonProps) {
  const [open, setOpen] = React.useState(false);
  const [draft, setDraft] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  const projectId = useAuthStore((s) => s.projectId);
  const setRoute = useUIStore((s) => s.setRoute);

  const count = files.length;
  const atCap = count >= MAX_FILES;

  const addCandidates = (candidates: string[]) => {
    setError(null);
    if (candidates.length === 0) {
      setError('Paste a path first.');
      return;
    }
    const rejected: string[] = [];
    const accepted: string[] = [];
    for (const c of candidates) {
      if (!looksAbsolute(c)) {
        rejected.push(c);
        continue;
      }
      if (files.includes(c) || accepted.includes(c)) continue;
      accepted.push(c);
    }
    if (accepted.length === 0) {
      setError(
        rejected.length > 0
          ? 'Paths must be absolute (start with `/` or a drive letter).'
          : 'Already attached.',
      );
      return;
    }
    const next = [...files, ...accepted].slice(0, MAX_FILES);
    onChange(next);
    setDraft('');
    if (rejected.length > 0) {
      setError(
        `${rejected.length} path${rejected.length === 1 ? '' : 's'} rejected (not absolute).`,
      );
    } else if (next.length === MAX_FILES && accepted.length < candidates.length) {
      setError(`Capped at ${MAX_FILES} files.`);
    }
  };

  const handleAdd = () => {
    addCandidates(splitPaths(draft));
  };

  const handleChooseFiles = async () => {
    if (atCap) return;
    const picked = await chooseProjectFiles(true);
    if (picked.length === 0) {
      setError('Use the path field, or run the desktop app for native picking.');
      return;
    }
    addCandidates(picked);
  };

  const handleRemove = (path: string) => {
    onChange(files.filter((f) => f !== path));
  };

  const handleClear = () => {
    onChange([]);
  };

  const openInContext = (path: string) => {
    setStoredContextSelectedFile(projectId, path);
    setRoute('context');
    setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={
            count > 0
              ? `Connected files (${count})`
              : 'Attach files to this pane'
          }
          title={
            count > 0
              ? `${count} file${count === 1 ? '' : 's'} connected · click to manage`
              : 'Attach files to this pane'
          }
          className={cn(
            'relative inline-flex h-5 w-5 items-center justify-center rounded-sm text-muted-foreground transition-colors',
            'hover:bg-muted hover:text-foreground',
            'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
            count > 0 && 'text-accent-copper',
          )}
        >
          <Paperclip className="h-3 w-3" />
          {count > 0 && (
            <span
              aria-hidden
              className="absolute -right-1 -top-1 inline-flex h-3 min-w-3 items-center justify-center rounded-full bg-accent-copper px-0.5 text-[9px] font-mono text-background leading-none"
            >
              {count}
            </span>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="bottom"
        align="end"
        className="w-[320px] p-0 overflow-hidden"
      >
        <div className="flex items-center justify-between gap-2 border-b border-border bg-paper-soft px-3 py-2">
          <div className="text-ui-strong text-foreground">Connected files</div>
          <div className="text-metadata text-muted-foreground">
            {count}/{MAX_FILES}
          </div>
        </div>

        <div className="max-h-[220px] overflow-y-auto">
          {files.length === 0 ? (
            <p className="p-3 text-secondary text-muted-foreground">
              No files attached. Paste an absolute path below — the agent in
              this pane will see those files when it answers.
            </p>
          ) : (
            <ul className="divide-y divide-border">
              {files.map((p) => (
                <li
                  key={p}
                  className="group flex items-center gap-2 px-3 py-1.5"
                >
                  <button
                    type="button"
                    onClick={() => openInContext(p)}
                    className="min-w-0 flex-1 truncate text-left font-mono text-metadata text-foreground hover:text-accent-copper focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                    title="Open this file in the Context map"
                  >
                    {p}
                  </button>
                  <button
                    type="button"
                    onClick={() => handleRemove(p)}
                    aria-label={`Remove ${p}`}
                    className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-sm text-muted-foreground opacity-0 transition-opacity hover:bg-destructive/10 hover:text-destructive group-hover:opacity-100"
                  >
                    <Trash2 className="h-3 w-3" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="border-t border-border p-3 space-y-2 bg-background">
          <div className="flex gap-1.5">
            <Input
              value={draft}
              onChange={(e) => {
                setDraft(e.target.value);
                if (error) setError(null);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  handleAdd();
                }
              }}
              placeholder={atCap ? `Cap reached (${MAX_FILES})` : 'C:\\path\\to\\file.ts or /abs/path'}
              disabled={atCap}
              className="font-mono text-metadata"
              spellCheck={false}
              autoComplete="off"
            />
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void handleChooseFiles()}
              disabled={atCap}
              className="shrink-0 gap-1"
            >
              <FolderOpen className="h-3 w-3" />
              Choose
            </Button>
            <Button
              variant="accent"
              size="sm"
              onClick={handleAdd}
              disabled={atCap || draft.trim().length === 0}
              className="shrink-0 gap-1"
            >
              <Plus className="h-3 w-3" />
              Add
            </Button>
          </div>
          {error && (
            <div className="flex items-start gap-1.5 text-metadata text-accent-copper">
              <AlertTriangle className="h-3 w-3 mt-0.5 shrink-0" />
              <span>{error}</span>
            </div>
          )}
          {files.length > 0 && (
            <button
              type="button"
              onClick={handleClear}
              className="text-metadata text-muted-foreground hover:text-foreground transition-colors"
            >
              Clear all
            </button>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

export default ConnectedFilesButton;
