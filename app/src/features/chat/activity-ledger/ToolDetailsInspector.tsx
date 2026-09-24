import { useMemo, useState } from 'react';
import type { PublicToolDetails } from '@/lib/ai/adapters/types';
import type { ChatActivityStatus } from '../activity/types';
import { DiffView } from '../agentic-console/DiffView';
import {
  captureToolFileScope,
  listToolEditors,
  openToolFile,
  saveToolFileCopy,
  type ToolEditor,
  type ToolFileAction,
} from './toolFileActions';

export function ToolFileLink({ path, projectRoot }: { path: string; projectRoot?: string }) {
  const scope = useMemo(
    () => (projectRoot ? captureToolFileScope(projectRoot) : null),
    [projectRoot],
  );
  const [error, setError] = useState('');
  const [menuOpen, setMenuOpen] = useState(false);
  const [editors, setEditors] = useState<ToolEditor[]>([]);
  const [savingCopy, setSavingCopy] = useState(false);
  const [copyPath, setCopyPath] = useState('');
  const [status, setStatus] = useState('');
  const open = async (action: ToolFileAction) => {
    if (!scope) return;
    setMenuOpen(false);
    setError('');
    setStatus('');
    try {
      await openToolFile(path, action, scope);
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : typeof error === 'string'
            ? error.slice(0, 512)
            : 'File could not open',
      );
    }
  };
  const saveCopy = async () => {
    if (!scope) return;
    setError('');
    try {
      const saved = await saveToolFileCopy(path, copyPath, scope);
      setStatus(`Saved copy: ${saved}`);
      setSavingCopy(false);
      setMenuOpen(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not save a copy');
    }
  };
  if (!scope) return <span className="break-all">{path}</span>;
  return (
    <span className="inline-block max-w-full">
      <button
        type="button"
        className="break-all text-accent-copper underline underline-offset-2"
        title="Open in VibeSpace Files · Ctrl-click opens this file"
        onClick={() => void open('editor')}
        onContextMenu={(event) => {
          event.preventDefault();
          setMenuOpen(true);
          void listToolEditors(scope)
            .then(setEditors)
            .catch(() => setEditors([]));
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape') setMenuOpen(false);
        }}
      >
        {path}
      </button>
      {menuOpen ? (
        <span
          role="group"
          aria-label={`File actions for ${path}`}
          className="flex gap-3 rounded border border-border bg-panel p-2"
        >
          <button type="button" onClick={() => void open('editor')}>
            Open in VibeSpace
          </button>
          <button type="button" onClick={() => void open('reveal')}>
            Open in File Explorer
          </button>
          <button type="button" onClick={() => { setSavingCopy(true); setCopyPath(path); }}>
            Save a copy as…
          </button>
          {editors.map((editor) => (
            <button type="button" key={editor.id} onClick={() => void open(editor.id)}>
              Open in {editor.name}
            </button>
          ))}
          <button type="button" onClick={() => setMenuOpen(false)}>
            Close file actions
          </button>
        </span>
      ) : null}
      {savingCopy ? (
        <span role="group" aria-label={`Save a copy of ${path}`} className="flex gap-2 rounded border border-border bg-panel p-2">
          <input aria-label="New project file path" value={copyPath}
            onChange={(event) => setCopyPath(event.target.value)}
            className="min-w-40 rounded border border-border bg-background px-2 text-foreground" />
          <button type="button" onClick={() => void saveCopy()}>Save copy</button>
          <button type="button" onClick={() => setSavingCopy(false)}>Cancel copy</button>
        </span>
      ) : null}
      {status ? <span role="status" className="block text-muted-foreground">{status}</span> : null}
      {error ? (
        <span role="alert" className="block text-destructive">
          {error}
        </span>
      ) : null}
    </span>
  );
}

function JsonDetail({ label, value }: { label: string; value: unknown }) {
  const [open, setOpen] = useState(false);
  if (value === undefined) return null;
  return (
    <details onToggle={(event) => setOpen(event.currentTarget.open)} className="my-1">
      <summary className="cursor-pointer text-metadata">{label}</summary>
      {open ? (
        <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words font-mono text-[12px]">
          {JSON.stringify(value, null, 2)}
        </pre>
      ) : null}
    </details>
  );
}

function writtenContentFromArguments(
  details: Readonly<PublicToolDetails>,
  change: Readonly<NonNullable<PublicToolDetails['changes']>[number]>,
): string | undefined {
  if (change.diff !== undefined || change.writtenContent !== undefined)
    return change.writtenContent;
  const args = details.arguments;
  if (!args || typeof args !== 'object' || Array.isArray(args)) return undefined;
  const value = args as Readonly<Record<string, unknown>>;
  const content =
    typeof value.content === 'string'
      ? value.content
      : typeof value.contents === 'string'
        ? value.contents
        : undefined;
  if (content === undefined) return undefined;
  const argumentPath =
    typeof value.path === 'string'
      ? value.path
      : typeof value.filePath === 'string'
        ? value.filePath
        : undefined;
  return argumentPath === undefined || argumentPath === change.path ? content : undefined;
}

/** Public, bounded provider data only. These fields never grant execution authority. */
export function ToolDetailsInspector({
  details,
  status,
  projectRoot,
}: {
  details: Readonly<PublicToolDetails>;
  status: ChatActivityStatus;
  projectRoot?: string;
}) {
  const [outputOpen, setOutputOpen] = useState(false);
  return (
    <section
      className="min-w-0 px-3 pb-2 text-metadata"
      aria-label="Tool call details"
      data-tool-details="true"
    >
      {details.command ? (
        <pre
          className="overflow-auto whitespace-pre-wrap break-words font-mono text-[12px]"
          aria-label="Executed command"
        >
          {details.command}
        </pre>
      ) : null}
      {details.exitCode !== undefined ? (
        <p>
          Exit code: {details.exitCode}
          {details.exitCode !== 0 ? ' · Command failed' : ''}
        </p>
      ) : null}
      {details.durationMs !== undefined ? <p>Duration: {details.durationMs} ms</p> : null}
      <JsonDetail label="Arguments" value={details.arguments} />
      {details.output ? (
        <div>
          <pre
            className="max-h-28 overflow-auto whitespace-pre-wrap break-words font-mono text-[12px]"
            aria-label="Tool output preview"
          >
            {details.output.text.slice(0, 240)}
          </pre>
          <details onToggle={(event) => setOutputOpen(event.currentTarget.open)}>
            <summary className="cursor-pointer">Output</summary>
            {outputOpen ? (
              <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words font-mono text-[12px]">
                {details.output.text}
              </pre>
            ) : null}
          </details>
          {!details.output.complete ? (
            <p role="note">
              Partial output
              {details.output.omittedBytes > 0
                ? ' · ' + details.output.omittedBytes + ' bytes omitted from this preview'
                : ' · Streaming'}
            </p>
          ) : null}
        </div>
      ) : null}
      <JsonDetail label="Result" value={details.result} />
      <JsonDetail label="Error" value={details.error} />
      {details.redacted ? <p role="note">Sensitive values redacted.</p> : null}
      {details.truncated ? (
        <p role="note">Details are bounded; omitted content is not represented as complete.</p>
      ) : null}
      {details.changes?.map((change, index) => {
        const writtenContent = writtenContentFromArguments(details, change);
        return (
          <div key={index} className="my-2" data-tool-file-change={change.path}>
            <div className="break-all">
              {change.kind}: <ToolFileLink path={change.path} projectRoot={projectRoot} />
              {change.destinationPath ? (
                <>
                  {' '}
                  → <ToolFileLink path={change.destinationPath} projectRoot={projectRoot} />
                </>
              ) : null}
            </div>
            {change.diff !== undefined ? (
              <div className="max-h-80 overflow-auto" data-tool-change-scroll="diff">
                <DiffView
                  block={{ title: change.path, filePath: change.path, diff: change.diff, status }}
                  compact
                />
              </div>
            ) : writtenContent !== undefined ? (
              <details className="my-1" data-tool-change-scroll="written-content">
                <summary className="cursor-pointer">
                  Written content · previous file state unavailable
                </summary>
                <pre
                  className="max-h-80 overflow-auto whitespace-pre-wrap break-words font-mono text-[12px]"
                  aria-label={`Written content for ${change.path}`}
                >
                  {writtenContent}
                </pre>
              </details>
            ) : (
              <p>Per-call diff unavailable.</p>
            )}
            {!change.complete ? <p role="note">Change details are incomplete.</p> : null}
          </div>
        );
      })}
      {details.omittedChanges ? (
        <p role="note">{details.omittedChanges} additional changes omitted.</p>
      ) : null}
    </section>
  );
}
