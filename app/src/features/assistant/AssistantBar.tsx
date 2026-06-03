/**
 * Jarvis Assistant — natural-language command bar.
 *
 * A modal dialog with a single text input. The user types a command
 * ("create project tiger", "open 4 terminals", "fullscreen") and the
 * deterministic parser in `parse.ts` shows a live preview underneath.
 * Pressing Enter dispatches the parsed intent through `execute.ts`.
 *
 * No remote AI calls. Everything is matched and executed locally.
 *
 * State:
 *   - Input value is component-local (we don't want it persisted).
 *   - Recent commands are persisted in localStorage under
 *     `jarvis-assistant-recent` so users can re-run the last 5 commands.
 *
 * Why a custom Dialog wiring (instead of the shared <DialogContent>):
 *   - We want control over the focus order and footer layout, similar
 *     to how the CommandPalette mounts the cmdk root inside a primitive
 *     Dialog.Content. Keeps the spacing tight without padding fights.
 */
import * as React from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { Sparkles } from 'lucide-react';
import { Dialog, DialogPortal, DialogOverlay } from '@/components/ui/dialog';
import { toast } from '@/components/ui/toast';
import { cn } from '@/lib/utils';
import { parseAssistantInput } from './parse';
import { executeIntent } from './execute';
import { JARVIS_COMMAND_CATALOG } from './commands';
import type { AssistantIntent } from './intents';

interface AssistantBarProps {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}

/** Persistent storage key for recent commands. Prefixed with the app name
 * so it doesn't collide with anything else writing to localStorage. */
const RECENT_KEY = 'jarvis-assistant-recent';

/** Cap on how many recent commands we remember. */
const RECENT_CAP = 5;

/** Static example list shown in the footer. Kept here so it stays close
 * to the parser's vocabulary — easy to refresh when we add new verbs. */
const EXAMPLE_HINTS = [
  'create project tiger',
  'open 4 terminals',
  'open claude in tiger',
  'make a todo: ship the launcher tomorrow',
  'schedule lunch friday at 1pm',
  'call me at 3pm',
  'message me: build is done',
  'create context map',
  'recenter context map',
  'fullscreen',
];

/**
 * Render a one-line preview of what the parser thinks the user is about
 * to do. Verbs use the warm copper accent so the preview is scannable
 * even in the dimmer text rows.
 */
function renderPreview(intent: AssistantIntent): React.ReactNode {
  const verb = (text: string) => <span className="text-accent-copper font-medium">{text}</span>;
  switch (intent.kind) {
    case 'create_project':
      return (
        <>
          → Will {verb('create project')} <span className="text-foreground">'{intent.name}'</span>
          {' and switch to it.'}
        </>
      );
    case 'switch_project':
      return (
        <>
          → Will {verb('switch')} to project{' '}
          <span className="text-foreground">'{intent.name}'</span>.
        </>
      );
    case 'create_chat':
      return (
        <>
          → Will {verb('create chat')}{' '}
          <span className="text-foreground">'{intent.title ?? 'New chat'}'</span>
          {intent.project ? <> in <span className="text-foreground">'{intent.project}'</span></> : null}.
        </>
      );
    case 'open_terminals':
      return (
        <>
          → Will {verb(`open ${intent.count} terminal${intent.count === 1 ? '' : 's'}`)}
          {intent.command ? <> with <span className="text-foreground">{intent.command}</span></> : null}
          {intent.project ? <> in <span className="text-foreground">'{intent.project}'</span></> : null}.
        </>
      );
    case 'create_custom_command':
      return <>→ Will {verb('create command')} <span className="text-foreground">'{intent.name}'</span> to run <span className="text-foreground">{intent.command}</span>.</>;
    case 'run_custom_command':
      return <>→ Will {verb('run custom command')} <span className="text-foreground">'{intent.name}'</span>.</>;
    case 'ask_provider':
      return <>→ Will {verb(`ask ${intent.provider}`)}: <span className="text-foreground">{intent.prompt}</span>.</>;
    case 'give_terminals_context':
      return <>→ Will {verb('send project context')} to all terminal panes.</>;
    case 'create_context_map':
      return <>→ Will {verb('create the Context map')} from the saved project folder.</>;
    case 'recenter_context_map':
      return <>→ Will {verb('recenter the Context map')}.</>;
    case 'create_task':
      return (
        <>
          → Will {verb('add task')} <span className="text-foreground">'{intent.title}'</span>
          {intent.due_at
            ? <> due <span className="text-foreground">
                {new Date(intent.due_at).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' })}
              </span></>
            : null}.
        </>
      );
    case 'create_event':
      return (
        <>
          → Will {verb('schedule event')}: <span className="text-foreground">{intent.raw}</span>
        </>
      );
    case 'schedule_call':
      return <>→ Will {verb('schedule a Jarvis call')}: <span className="text-foreground">{intent.raw}</span></>;
    case 'send_phone_message':
      return <>→ Will {verb('message your phone')}: <span className="text-foreground">{intent.text}</span></>;
    case 'set_ambient':
      return <>→ Will {verb(`turn ambient mode ${intent.on ? 'on' : 'off'}`)}.</>;
    case 'set_fullscreen':
      if (intent.on === undefined) return <>→ Will {verb('toggle fullscreen')}.</>;
      return <>→ Will {verb(intent.on ? 'enter fullscreen' : 'exit fullscreen')}.</>;
    case 'open_settings':
      return <>→ Will {verb('open settings')}.</>;
    case 'open_palette':
      return <>→ Will {verb('open command palette')}.</>;
    case 'open_launcher':
      return <>→ Will {verb('open quick launcher')}.</>;
    case 'open_schedule':
      return <>→ Will {verb('open schedule')}.</>;
    case 'navigate':
      return <>→ Will {verb('show')} <span className="text-foreground">{intent.route}</span>.</>;
    case 'multi_step':
      return (
        <>
          → Will {verb(`run ${intent.steps.length} steps`)}:{' '}
          <span className="text-foreground">
            {intent.steps.map((step) => step.kind.replace(/_/g, ' ')).join(' → ')}
          </span>
        </>
      );
    case 'unknown':
    default:
      return null;
  }
}

/** Read the last-N recent commands from localStorage, defensively. */
function readRecent(): string[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(RECENT_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((s): s is string => typeof s === 'string').slice(0, RECENT_CAP);
  } catch {
    return [];
  }
}

/** Push a new command to the front of the recent list, dedup'd. */
function pushRecent(cmd: string): string[] {
  const trimmed = cmd.trim();
  if (!trimmed) return readRecent();
  const existing = readRecent().filter((s) => s.toLowerCase() !== trimmed.toLowerCase());
  const next = [trimmed, ...existing].slice(0, RECENT_CAP);
  try {
    window.localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    // Quota errors / private mode — just skip persistence.
  }
  return next;
}

export function AssistantBar({ open, onOpenChange }: AssistantBarProps) {
  const [value, setValue] = React.useState('');
  const [recent, setRecent] = React.useState<string[]>(() => readRecent());
  const inputRef = React.useRef<HTMLInputElement>(null);

  // Reload recents from storage every time we open. Keeps the list in
  // sync if the user ran commands across multiple windows / tabs.
  React.useEffect(() => {
    if (open) {
      setRecent(readRecent());
      setValue('');
      // Defer focus to the next tick so the input has mounted.
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  const intent = React.useMemo<AssistantIntent>(() => parseAssistantInput(value), [value]);

  const handleExecute = React.useCallback(async () => {
    const raw = value.trim();
    if (!raw) return;
    const result = await executeIntent(intent);
    if (result.ok) {
      setRecent(pushRecent(raw));
      toast.success('Done', result.message);
      onOpenChange(false);
      setValue('');
    } else {
      // For unknown commands we DON'T persist into recents — there's no
      // point letting the user re-run a misspelt verb.
      if (intent.kind !== 'unknown') {
        setRecent(pushRecent(raw));
      }
      toast.warning('Hmm', result.message);
    }
  }, [intent, onOpenChange, value]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void handleExecute();
    }
  };

  const onPillClick = (cmd: string) => {
    setValue(cmd);
    inputRef.current?.focus();
  };

  const showPreview = value.trim().length > 0;
  const previewNode = showPreview ? renderPreview(intent) : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPortal>
        <DialogOverlay className="bg-black/60" />
        <DialogPrimitive.Content
          aria-label="Jarvis Assistant"
          className={cn(
            'fixed left-1/2 top-[18vh] z-50 w-[calc(100%-2rem)] max-w-xl -translate-x-1/2',
            'border border-border bg-elevated rounded-lg shadow-2xl',
            'data-[state=open]:animate-scale-in data-[state=closed]:animate-fade-out',
            'overflow-hidden flex flex-col',
          )}
        >
          {/* Required for Radix accessibility — visually hidden */}
          <DialogPrimitive.Title className="sr-only">Jarvis Assistant</DialogPrimitive.Title>
          <DialogPrimitive.Description className="sr-only">
            Type a command to act on projects, chats, terminals, tasks, events, and UI.
          </DialogPrimitive.Description>

          {/* Header */}
          <div className="flex items-center gap-2 px-4 pt-3.5 pb-2.5 border-b border-border">
            <Sparkles className="h-4 w-4 text-accent-copper" aria-hidden />
            <span className="text-ui-strong text-foreground">Jarvis Assistant</span>
          </div>

          {/* Input */}
          <div className="px-4 pt-3.5 pb-2">
            <input
              ref={inputRef}
              type="text"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder="Tell Jarvis what to do…"
              autoFocus
              spellCheck={false}
              autoComplete="off"
              className={cn(
                'w-full bg-transparent border-0 outline-none ring-0',
                'text-page-title text-foreground placeholder:text-muted-foreground/70',
                'py-1',
              )}
              aria-label="Jarvis Assistant command"
            />

            {/* Live preview */}
            <div className="min-h-[20px] mt-1.5 text-secondary italic">
              {previewNode ? (
                <span className="text-muted-foreground">{previewNode}</span>
              ) : showPreview ? (
                <span className="text-muted-foreground/60">
                  Try: create project tiger / open 4 terminals / schedule lunch friday 1pm
                </span>
              ) : (
                <span className="text-muted-foreground/60">
                  Press <kbd className="kbd">&#8629;</kbd> to run · <kbd className="kbd">Esc</kbd> to close
                </span>
              )}
            </div>
          </div>

          {/* Recent commands */}
          {recent.length > 0 && (
            <div className="px-4 pb-3 flex flex-wrap gap-1.5">
              {recent.map((r) => (
                <button
                  key={r}
                  type="button"
                  onClick={() => onPillClick(r)}
                  className={cn(
                    'rounded-full border border-border bg-panel px-2.5 py-0.5',
                    'text-metadata text-muted-foreground',
                    'hover:border-border-mid hover:text-foreground transition-colors',
                  )}
                  title={`Re-run: ${r}`}
                >
                  {r}
                </button>
              ))}
            </div>
          )}

          {/* Footer hints */}
          <div className="border-t border-border px-4 py-2 text-metadata text-muted-foreground/80">
            <span className="text-muted-foreground">Examples:</span>{' '}
            <span className="text-muted-foreground/70">{[...EXAMPLE_HINTS, ...JARVIS_COMMAND_CATALOG.slice(0, 12)].join(' · ')}</span>
          </div>
        </DialogPrimitive.Content>
      </DialogPortal>
    </Dialog>
  );
}
