import { ChevronDown, Cloud, Sparkles, Square } from 'lucide-react';
import { Button, Hint, Popover, PopoverContent, PopoverTrigger } from '@/components/ui';
import { HOTKEYS } from '@/lib/hotkeys';
import { cn } from '@/lib/utils';
import type {
  PromptForgeModelSelection,
  PromptForgePrivacyMode,
  PromptForgeStatus,
} from './contracts';
import type { PromptForgeModelOption } from './modelSelection';
import './sakura-prompt-forge.css';

export interface PromptForgeControlProps {
  status: PromptForgeStatus;
  statusMessage: string;
  isRunning: boolean;
  disabledReason: string | null;
  error: string | null;
  compact: boolean;
  modelSelection: PromptForgeModelSelection;
  modelOptions: readonly PromptForgeModelOption[];
  onModelSelectionChange: (selection: PromptForgeModelSelection) => void;
  privacyMode: PromptForgePrivacyMode;
  onPrivacyModeChange: (mode: PromptForgePrivacyMode) => void;
  allowPublicResearch: boolean;
  onAllowPublicResearchChange: (allowed: boolean) => void;
  publicResearchAvailable: boolean;
  offlineMode: boolean;
  /** Upgrade every Send with Prompt Forge (falls back to original on failure). */
  autoUpgradeOnSend: boolean;
  onAutoUpgradeOnSendChange: (enabled: boolean) => void;
  onStart: () => void | Promise<unknown>;
  onCancel: () => void | Promise<unknown>;
}

function selected(selection: PromptForgeModelSelection, option: PromptForgeModelOption): boolean {
  return (
    selection.mode === 'single' &&
    selection.providerId === option.providerId &&
    selection.modelId === option.modelId &&
    (selection.connectionId ?? null) === (option.connectionId ?? null)
  );
}

export function PromptForgeControl({
  status,
  statusMessage,
  isRunning,
  disabledReason,
  error,
  compact,
  modelSelection,
  modelOptions,
  onModelSelectionChange,
  // Privacy mode remains in the API for runtime defaults; lock UI was removed from chat.
  privacyMode: _privacyMode,
  onPrivacyModeChange: _onPrivacyModeChange,
  allowPublicResearch: _allowPublicResearch,
  onAllowPublicResearchChange: _onAllowPublicResearchChange,
  publicResearchAvailable: _publicResearchAvailable,
  offlineMode: _offlineMode,
  autoUpgradeOnSend,
  onAutoUpgradeOnSendChange,
  onStart,
  onCancel,
}: PromptForgeControlProps) {
  void _privacyMode;
  void _onPrivacyModeChange;
  void _allowPublicResearch;
  void _onAllowPublicResearchChange;
  void _publicResearchAvailable;
  void _offlineMode;
  const accessibleModels = modelOptions.filter((option) => option.available);
  const actionLabel = isRunning
    ? 'Cancel Prompt Forge upgrade'
    : 'Upgrade prompt with Prompt Forge';
  const tooltip = isRunning
    ? `${statusMessage} · Select to cancel`
    : (error ?? disabledReason ?? 'Upgrade this prompt with project context');

  return (
    <div
      data-monochrome-surface="prompt-forge"
      data-monochrome-state={status}
      data-sakura-surface="prompt-forge"
      data-sakura-state={status}
      className="mc7d-prompt-forge flex items-center gap-0.5 [html[data-theme=monochrome]_&]:font-mono"
    >
      <Hint label={tooltip} hotkey={HOTKEYS.PROMPT_FORGE}>
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          data-variant="ghost"
          aria-label={actionLabel}
          aria-description={error ?? disabledReason ?? undefined}
          disabled={!isRunning && disabledReason !== null}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => void (isRunning ? onCancel() : onStart())}
          className={cn(
            'relative [html[data-theme=monochrome]_&]:rounded-sm [html[data-theme=monochrome]_&]:border [html[data-theme=monochrome]_&]:border-transparent [html[data-theme=monochrome]_&]:shadow-none',
            '[html[data-theme=monochrome]_&]:hover:border-border-mid [html[data-theme=monochrome]_&]:hover:bg-muted',
            isRunning && 'text-accent-cyan',
            isRunning &&
              '[html[data-theme=monochrome]_&]:border-accent-cyan/60 [html[data-theme=monochrome]_&]:bg-accent-cyan/10',
            status === 'ready' && 'text-success',
            status === 'ready' &&
              '[html[data-theme=monochrome]_&]:border-success/60 [html[data-theme=monochrome]_&]:bg-success/10',
          )}
        >
          {isRunning ? (
            <>
              <Sparkles className="motion-safe:animate-pulse" />
              <Square className="absolute h-1.5 w-1.5 fill-current" />
            </>
          ) : (
            <Sparkles />
          )}
        </Button>
      </Hint>

      <Popover>
        <PopoverTrigger asChild>
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            aria-label="Configure Prompt Forge"
            className="h-6 min-h-6 w-6 min-w-6 shrink-0 px-0 [html[data-theme=monochrome]_&]:rounded-sm [html[data-theme=monochrome]_&]:shadow-none"
          >
            <ChevronDown className="!h-3 !w-3" />
          </Button>
        </PopoverTrigger>
        <PopoverContent
          side="top"
          align={compact ? 'start' : 'center'}
          sideOffset={8}
          data-monochrome-surface="prompt-forge-settings"
          data-sakura-surface="prompt-forge-settings"
          className="w-[min(360px,92vw)] space-y-4 p-3 [[data-theme=monochrome]_&]:rounded-sm [[data-theme=monochrome]_&]:border-border-mid [[data-theme=monochrome]_&]:bg-panel [[data-theme=monochrome]_&]:font-mono [[data-theme=monochrome]_&]:shadow-none"
        >
          <section>
            <div className="mb-2 flex items-center justify-between gap-2">
              <h3 className="text-secondary font-medium text-foreground">Prompt upgrade model</h3>
              <span className="text-metadata text-muted-foreground">Independent from chat</span>
            </div>
            <div role="radiogroup" aria-label="Prompt upgrade model" className="space-y-1">
              <button
                type="button"
                role="radio"
                aria-checked={modelSelection.mode === 'prefer_local'}
                data-monochrome-state={modelSelection.mode === 'prefer_local' ? 'selected' : 'idle'}
                onClick={() => onModelSelectionChange({ mode: 'prefer_local' })}
                className={cn(
                  'flex w-full items-center justify-between rounded-md px-2.5 py-2 text-left text-secondary outline-none',
                  'hover:bg-muted focus-visible:ring-1 focus-visible:ring-ring',
                  modelSelection.mode === 'prefer_local' && 'bg-accent-cyan/10 text-foreground',
                  '[html[data-theme=monochrome]_&]:rounded-sm [html[data-theme=monochrome]_&]:border [html[data-theme=monochrome]_&]:border-transparent',
                  modelSelection.mode === 'prefer_local' &&
                    '[html[data-theme=monochrome]_&]:border-l-2 [html[data-theme=monochrome]_&]:border-l-accent-cyan [html[data-theme=monochrome]_&]:border-y-border [html[data-theme=monochrome]_&]:border-r-border',
                )}
              >
                <span>
                  <span className="block font-medium">Prefer local</span>
                  <span className="block text-metadata text-muted-foreground">
                    Uses an available Ollama or local model
                  </span>
                </span>
              </button>
              <button
                type="button"
                role="radio"
                aria-checked={modelSelection.mode === 'current_chat_model'}
                data-monochrome-state={
                  modelSelection.mode === 'current_chat_model' ? 'selected' : 'idle'
                }
                onClick={() => onModelSelectionChange({ mode: 'current_chat_model' })}
                className={cn(
                  'flex w-full items-center justify-between rounded-md px-2.5 py-2 text-left text-secondary outline-none',
                  'hover:bg-muted focus-visible:ring-1 focus-visible:ring-ring',
                  modelSelection.mode === 'current_chat_model' &&
                    'bg-accent-cyan/10 text-foreground',
                  '[html[data-theme=monochrome]_&]:rounded-sm [html[data-theme=monochrome]_&]:border [html[data-theme=monochrome]_&]:border-transparent',
                  modelSelection.mode === 'current_chat_model' &&
                    '[html[data-theme=monochrome]_&]:border-l-2 [html[data-theme=monochrome]_&]:border-l-accent-cyan [html[data-theme=monochrome]_&]:border-y-border [html[data-theme=monochrome]_&]:border-r-border',
                )}
              >
                <span>
                  <span className="block font-medium">Use current chat model</span>
                  <span className="block text-metadata text-muted-foreground">
                    Does not change the chat selection
                  </span>
                </span>
              </button>
              {accessibleModels.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  role="radio"
                  aria-checked={selected(modelSelection, option)}
                  data-monochrome-state={selected(modelSelection, option) ? 'selected' : 'idle'}
                  onClick={() =>
                    onModelSelectionChange({
                      mode: 'single',
                      providerId: option.providerId,
                      modelId: option.modelId,
                      ...(option.connectionId ? { connectionId: option.connectionId } : {}),
                    })
                  }
                  className={cn(
                    'flex w-full items-center justify-between rounded-md px-2.5 py-2 text-left text-secondary outline-none',
                    'hover:bg-muted focus-visible:ring-1 focus-visible:ring-ring',
                    selected(modelSelection, option) && 'bg-accent-cyan/10 text-foreground',
                    '[html[data-theme=monochrome]_&]:rounded-sm [html[data-theme=monochrome]_&]:border [html[data-theme=monochrome]_&]:border-transparent',
                    selected(modelSelection, option) &&
                      '[html[data-theme=monochrome]_&]:border-l-2 [html[data-theme=monochrome]_&]:border-l-accent-cyan [html[data-theme=monochrome]_&]:border-y-border [html[data-theme=monochrome]_&]:border-r-border',
                  )}
                >
                  <span className="min-w-0">
                    <span className="block truncate font-medium">{option.label}</span>
                    <span className="block truncate text-metadata text-muted-foreground">
                      {option.connectionMode === 'local'
                        ? 'Local · no hosted AI charge'
                        : option.connectionMode === 'external-cli'
                          ? 'Signed-in subscription connection'
                          : 'Provider API connection'}
                    </span>
                  </span>
                  {!option.localOnly ? (
                    <Cloud className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  ) : null}
                </button>
              ))}
              {accessibleModels.length === 0 ? (
                <p className="px-2.5 py-2 text-metadata text-muted-foreground">
                  No other accessible models right now. Connect a provider or start a local model.
                </p>
              ) : null}
            </div>
          </section>

          <section className="border-t border-border pt-3">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h3 className="text-secondary font-medium text-foreground">
                  Upgrade automatically on Send
                </h3>
                <p className="mt-1 text-metadata text-muted-foreground">
                  When you press Send, upgrade the draft with context first. If upgrade fails, your
                  original text is sent. Manual Upgrade still opens preview/edit.
                </p>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={autoUpgradeOnSend}
                aria-label="Upgrade automatically on Send"
                onClick={() => onAutoUpgradeOnSendChange(!autoUpgradeOnSend)}
                className={cn(
                  'relative mt-0.5 h-5 w-9 shrink-0 rounded-full border transition-colors',
                  autoUpgradeOnSend
                    ? 'border-accent-cyan/60 bg-accent-cyan/30'
                    : 'border-border bg-muted',
                )}
              >
                <span
                  className={cn(
                    'absolute top-0.5 h-3.5 w-3.5 rounded-full bg-foreground transition-transform',
                    autoUpgradeOnSend ? 'left-4' : 'left-0.5',
                  )}
                />
              </button>
            </div>
          </section>

        </PopoverContent>
      </Popover>

      {isRunning ? (
        <span
          role="status"
          aria-live="polite"
          className={cn('max-w-36 truncate text-metadata text-accent-cyan', compact && 'sr-only')}
        >
          {statusMessage}
        </span>
      ) : null}
      {error ? (
        <span
          role="alert"
          className={cn('max-w-44 truncate text-metadata text-destructive', compact && 'sr-only')}
        >
          {error}
        </span>
      ) : null}
    </div>
  );
}
