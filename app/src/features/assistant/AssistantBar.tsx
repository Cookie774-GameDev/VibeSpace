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
import { formatUserDateTime } from '@/lib/timeFormat';
import { getActiveAccountIdentity } from '@/lib/accountIdentity';
import { useAuthStore } from '@/stores/auth';
import {
  classifyInstantCommandInput,
  InstantCommandEntryBoundary,
} from '@/features/instant-command';
import type { InstantCommand } from '@/features/instant-command';
import { INSTANT_COMMAND_CATALOG } from '@/features/instant-command/catalog';
import { buildInstantCommandHelp } from '@/features/instant-command/help';
import { suggestInstantCommands } from '@/features/instant-command/suggestions';
import { parseAssistantInput } from './parse';
import { executeIntent } from './execute';
import { JARVIS_COMMAND_CATALOG } from './commands';
import type { AssistantIntent } from './intents';
import './assistant.sakura.css';

interface AssistantBarProps {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}

/** Persistent storage key for recent commands. Prefixed with the app name
 * so it doesn't collide with anything else writing to localStorage. */
const RECENT_KEY = 'jarvis-assistant-recent';

/** Cap on how many recent commands we remember. */
const RECENT_CAP = 5;
const assistantInstantBoundary = new InstantCommandEntryBoundary();
const instantCommandHelp = buildInstantCommandHelp(INSTANT_COMMAND_CATALOG);

/** Static example list shown in the footer. Kept here so it stays close
 * to the parser's vocabulary — easy to refresh when we add new verbs. */
const EXAMPLE_HINTS = [
  'spawn a web development workbench',
  'change wallpaper to space clouds',
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
          {intent.project ? (
            <>
              {' '}
              in <span className="text-foreground">'{intent.project}'</span>
            </>
          ) : null}
          .
        </>
      );
    case 'open_terminals':
      return (
        <>
          → Will {verb(`open ${intent.count} terminal${intent.count === 1 ? '' : 's'}`)}
          {intent.command ? (
            <>
              {' '}
              with <span className="text-foreground">{intent.command}</span>
            </>
          ) : null}
          {intent.project ? (
            <>
              {' '}
              in <span className="text-foreground">'{intent.project}'</span>
            </>
          ) : null}
          .
        </>
      );
    case 'workbench':
      if (intent.action === 'spawn')
        return (
          <>
            → Will {verb('spawn Workbench')} from{' '}
            <span className="text-foreground">{intent.templateId}</span>.
          </>
        );
      if (intent.action === 'add-panel')
        return (
          <>
            → Will{' '}
            {verb(`add ${intent.count} ${intent.panelKind} panel${intent.count === 1 ? '' : 's'}`)}{' '}
            to Workbench.
          </>
        );
      if (intent.action === 'set-wallpaper')
        return (
          <>
            → Will {verb('change Workbench wallpaper')} to{' '}
            <span className="text-foreground">{intent.wallpaperId}</span>.
          </>
        );
      if (intent.action === 'pause-wallpaper')
        return <>→ Will {verb('pause Workbench wallpaper motion')}.</>;
      if (intent.action === 'resume-wallpaper')
        return <>→ Will {verb('resume Workbench wallpaper motion')}.</>;
      return <>→ Will {verb('open Workbench')}.</>;
    case 'create_custom_command':
      return (
        <>
          → Will {verb('create command')} <span className="text-foreground">'{intent.name}'</span>{' '}
          to run <span className="text-foreground">{intent.command}</span>.
        </>
      );
    case 'run_custom_command':
      return (
        <>
          → Will {verb('run custom command')}{' '}
          <span className="text-foreground">'{intent.name}'</span>.
        </>
      );
    case 'clock_timer':
      return <>→ Clock/timer tool has been removed.</>;
    case 'clock_alarm':
      return <>→ Clock/alarm tool has been removed.</>;
    case 'ask_provider':
      return (
        <>
          → Will {verb(`ask ${intent.provider}`)}:{' '}
          <span className="text-foreground">{intent.prompt}</span>.
        </>
      );
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
          {intent.due_at ? (
            <>
              {' '}
              due{' '}
              <span className="text-foreground">
                {formatUserDateTime(intent.due_at, { weekday: 'short' })}
              </span>
            </>
          ) : null}
          .
        </>
      );
    case 'create_event':
      return (
        <>
          → Will {verb('schedule event')}: <span className="text-foreground">{intent.raw}</span>
        </>
      );
    case 'schedule_call':
      return (
        <>
          → Will {verb('schedule a Jarvis call')}:{' '}
          <span className="text-foreground">{intent.raw}</span>
        </>
      );
    case 'send_phone_message':
      return (
        <>
          → Will {verb('message your phone')}:{' '}
          <span className="text-foreground">{intent.text}</span>
        </>
      );
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
      return (
        <>
          → Will {verb('show')} <span className="text-foreground">{intent.route}</span>.
        </>
      );
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

function renderInstantPreview(command: InstantCommand): React.ReactNode {
  const verb = (text: string) => <span className="text-accent-copper font-medium">{text}</span>;
  switch (command.kind) {
    case 'legacy':
      return renderPreview(command.intent);
    case 'open-agent-cli':
      return (
        <>
          → Will{' '}
          {verb(
            `queue ${command.count} ${command.provider} terminal${command.count === 1 ? '' : 's'}`,
          )}
          {command.modelId ? <> using {command.modelId}, then send: {command.prompt}</> : null}.
        </>
      );
    case 'open-model-picker':
      return <>→ Will {verb('open provider and model selection')}.</>;
    case 'terminal-message':
      return (
        <>
          → Will {verb(`queue for terminal ${command.target.ordinal}`)}:{' '}
          <span className="text-foreground">{command.payload}</span>.
        </>
      );
    case 'agent-message':
      return (
        <>
          → Will {verb(`queue for ${command.target.provider}`)}:{' '}
          <span className="text-foreground">{command.payload}</span>.
        </>
      );
    case 'terminal-broadcast':
      return (
        <>
          → Will{' '}
          {verb(
            `queue for all ${command.target.provider ? `${command.target.provider} ` : ''}terminals`,
          )}
          : <span className="text-foreground">{command.payload}</span>.
        </>
      );
    case 'catalog': {
      const action = command.id.replace(/[._]+/gu, ' ');
      const boundedSlots = Object.entries(command.slots)
        .filter(
          ([key, value]) =>
            !/(?:api.?key|secret|token|credential|password|billing)/iu.test(key) &&
            (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'),
        )
        .map(([, value]) => String(value).trim().slice(0, 120))
        .filter(Boolean)
        .slice(0, 3);
      return (
        <>
          → Will {verb(action)}
          {boundedSlots.length > 0 ? (
            <>
              {' for '}
              <span className="text-foreground">{boundedSlots.join(' · ')}</span>
            </>
          ) : null}
          .{' '}
          {command.safety === 'approval' ? (
            <span className="text-muted-foreground">Approval required before execution. </span>
          ) : command.safety === 'confirm' ? (
            <span className="text-muted-foreground">Confirmation required before execution. </span>
          ) : null}
          {command.family === 'team' ? (
            <span className="text-muted-foreground">
              Bundled Terminal Peer Fabric capability required.
            </span>
          ) : null}
        </>
      );
    }
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
  const [activeSuggestionIndex, setActiveSuggestionIndex] = React.useState(-1);
  const [suggestionsDismissed, setSuggestionsDismissed] = React.useState(false);
  const [recent, setRecent] = React.useState<string[]>(() => readRecent());
  const inputRef = React.useRef<HTMLInputElement>(null);
  const executionInFlightRef = React.useRef(false);
  const [executionInFlight, setExecutionInFlight] = React.useState(false);

  // Reload recents from storage every time we open. Keeps the list in
  // sync if the user ran commands across multiple windows / tabs.
  React.useEffect(() => {
    if (open) {
      setRecent(readRecent());
      setValue('');
      setActiveSuggestionIndex(-1);
      setSuggestionsDismissed(false);
      // Defer focus to the next tick so the input has mounted.
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  const instantClassification = React.useMemo(() => classifyInstantCommandInput(value), [value]);
  const instantCommand =
    instantClassification.status === 'matched' ? instantClassification.command : null;
  const instantSuggestions = React.useMemo(
    () =>
      value.trim().length >= 2 && !instantCommand && !suggestionsDismissed
        ? suggestInstantCommands(instantCommandHelp, value, 4)
        : [],
    [instantCommand, suggestionsDismissed, value],
  );
  const intent = React.useMemo<AssistantIntent | null>(
    () => (instantClassification.status === 'unmatched' ? parseAssistantInput(value) : null),
    [instantClassification.status, value],
  );

  const handleExecute = React.useCallback(async () => {
    if (executionInFlightRef.current) return;
    const raw = value.trim();
    if (!raw) return;
    executionInFlightRef.current = true;
    setExecutionInFlight(true);
    try {
      const interactionId = `assistant-${crypto.randomUUID()}`;
      const auth = useAuthStore.getState();
      const outcome = await assistantInstantBoundary.submit({
        interactionId,
        trigger: 'typed',
        source: raw,
        context: {
          correlationId: interactionId,
          accountId: getActiveAccountIdentity()?.accountId ?? 'local-account',
          workspaceId: String(auth.workspaceId ?? 'local-workspace'),
          projectId: String(auth.projectId ?? 'local-project'),
        },
      });
      if (outcome.kind === 'rejected') {
        toast.warning('Invalid command', outcome.reason);
        return;
      }
      const result =
        outcome.kind === 'command'
          ? {
              ok: outcome.receipt.status === 'completed' || outcome.receipt.status === 'queued',
              message:
                outcome.receipt.followUp?.prompt ??
                `Instant command ${outcome.receipt.status} (${outcome.receipt.commandId}).`,
            }
          : await executeIntent(intent ?? parseAssistantInput(raw));
      if (result.ok) {
        setRecent(pushRecent(raw));
        toast.success('Done', result.message);
        onOpenChange(false);
        setValue('');
      } else {
        // For unknown commands we DON'T persist into recents — there's no
        // point letting the user re-run a misspelt verb.
        if (outcome.kind === 'command' || intent?.kind !== 'unknown') {
          setRecent(pushRecent(raw));
        }
        toast.warning('Hmm', result.message);
      }
    } finally {
      executionInFlightRef.current = false;
      setExecutionInFlight(false);
    }
  }, [intent, onOpenChange, value]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape' && instantSuggestions.length > 0) {
      e.preventDefault();
      e.stopPropagation();
      setActiveSuggestionIndex(-1);
      setSuggestionsDismissed(true);
      return;
    }
    if (e.key === 'Home' || e.key === 'End') {
      const selectableIndexes = instantSuggestions
        .map((suggestion, index) => (suggestion.disabled ? -1 : index))
        .filter((index) => index >= 0);
      if (selectableIndexes.length > 0) {
        e.preventDefault();
        setActiveSuggestionIndex(
          e.key === 'Home'
            ? (selectableIndexes[0] ?? -1)
            : (selectableIndexes[selectableIndexes.length - 1] ?? -1),
        );
      }
      return;
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      const selectableIndexes = instantSuggestions
        .map((suggestion, index) => (suggestion.disabled ? -1 : index))
        .filter((index) => index >= 0);
      if (selectableIndexes.length > 0) {
        e.preventDefault();
        const currentPosition = selectableIndexes.indexOf(activeSuggestionIndex);
        const nextPosition =
          currentPosition === -1
            ? e.key === 'ArrowDown'
              ? 0
              : selectableIndexes.length - 1
            : (currentPosition + (e.key === 'ArrowDown' ? 1 : -1) + selectableIndexes.length) %
              selectableIndexes.length;
        setActiveSuggestionIndex(selectableIndexes[nextPosition] ?? -1);
      }
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      const activeSuggestion = instantSuggestions[activeSuggestionIndex];
      if (activeSuggestion && !activeSuggestion.disabled) {
        setValue(activeSuggestion.label);
        setActiveSuggestionIndex(-1);
        return;
      }
      void handleExecute();
    }
  };

  const onPillClick = (cmd: string) => {
    setValue(cmd);
    setActiveSuggestionIndex(-1);
    setSuggestionsDismissed(false);
    inputRef.current?.focus();
  };

  const showPreview = value.trim().length > 0;
  const previewNode = showPreview
    ? instantCommand
      ? renderInstantPreview(instantCommand)
      : intent
        ? renderPreview(intent)
        : null
    : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPortal>
        <DialogOverlay
          className="bg-black/60"
          data-sakura-overlay="assistant"
          data-vibespace-owned-chrome="assistant"
        />
        <DialogPrimitive.Content
          aria-label="Jarvis Assistant"
          data-monochrome-surface="assistant"
          data-vibespace-owned-chrome="assistant"
          className={cn(
            'fixed left-1/2 top-[18vh] z-50 w-[calc(100%-2rem)] max-w-xl -translate-x-1/2',
            'border border-border bg-elevated rounded-lg shadow-2xl',
            '[[data-theme=monochrome]_&]:rounded-sm [[data-theme=monochrome]_&]:border-border-mid [[data-theme=monochrome]_&]:bg-background [[data-theme=monochrome]_&]:shadow-none',
            'data-[state=open]:animate-scale-in data-[state=closed]:animate-fade-out',
            '[[data-theme=monochrome]_&]:data-[state=open]:!animate-none [[data-theme=monochrome]_&]:data-[state=closed]:!animate-none',
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
              onChange={(e) => {
                setValue(e.target.value);
                setActiveSuggestionIndex(-1);
                setSuggestionsDismissed(false);
              }}
              onKeyDown={onKeyDown}
              placeholder="Tell Jarvis what to do…"
              autoFocus
              spellCheck={false}
              autoComplete="off"
              disabled={executionInFlight}
              aria-busy={executionInFlight}
              role="combobox"
              aria-autocomplete="list"
              aria-haspopup="listbox"
              aria-controls={
                instantSuggestions.length > 0 ? 'instant-command-suggestions' : undefined
              }
              aria-expanded={instantSuggestions.length > 0}
              aria-activedescendant={
                activeSuggestionIndex >= 0
                  ? `instant-command-option-${instantSuggestions[activeSuggestionIndex]?.id.replaceAll('.', '-')}`
                  : undefined
              }
              className={cn(
                'w-full bg-transparent border-0 outline-none ring-0',
                'text-page-title text-foreground placeholder:text-muted-foreground/70',
                'py-1',
              )}
              aria-label="Jarvis Assistant command"
            />
            <span role="status" aria-live="polite" className="sr-only">
              {instantSuggestions.length > 0
                ? `${instantSuggestions.length} Instant Command suggestions available.`
                : ''}
            </span>

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
                  Press <kbd className="kbd">&#8629;</kbd> to run · <kbd className="kbd">Esc</kbd>{' '}
                  to close
                </span>
              )}
            </div>

            {instantSuggestions.length > 0 ? (
              <ul
                id="instant-command-suggestions"
                role="listbox"
                aria-label="Instant Command suggestions"
                className="mt-2 space-y-1"
              >
                {instantSuggestions.map((suggestion, index) => (
                  <li
                    key={suggestion.id}
                    id={`instant-command-option-${suggestion.id.replaceAll('.', '-')}`}
                    role="option"
                    aria-selected={index === activeSuggestionIndex}
                  >
                    <button
                      type="button"
                      aria-label={`Use suggestion: ${suggestion.label}`}
                      disabled={suggestion.disabled}
                      onClick={() => onPillClick(suggestion.label)}
                      className={cn(
                        'flex w-full items-center justify-between gap-3 rounded-md px-2 py-1.5 text-left',
                        'hover:bg-panel focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent-copper',
                        'disabled:cursor-not-allowed disabled:opacity-45',
                        '[[data-theme=monochrome]_&]:rounded-sm',
                        index === activeSuggestionIndex && 'bg-panel ring-1 ring-accent-copper',
                      )}
                    >
                      <span className="truncate text-secondary text-foreground">
                        {suggestion.label}
                      </span>
                      <span className="shrink-0 text-metadata text-muted-foreground">
                        {suggestion.detail}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
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
                    '[[data-theme=monochrome]_&]:rounded-sm [[data-theme=monochrome]_&]:border-border [[data-theme=monochrome]_&]:bg-panel',
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
            <span className="text-muted-foreground/70">
              {[...EXAMPLE_HINTS, ...JARVIS_COMMAND_CATALOG.slice(0, 12)].join(' · ')}
            </span>
          </div>
        </DialogPrimitive.Content>
      </DialogPortal>
    </Dialog>
  );
}
