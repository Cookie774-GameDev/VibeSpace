import { useEffect, useState } from 'react';
import { Check, MessageSquarePlus, RefreshCw, RotateCcw, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui';
import { cn } from '@/lib/utils';
import type { PromptForgeJob } from './contracts';
import './sakura-prompt-forge.css';

export interface PromptForgeReviewProps {
  open: boolean;
  compact?: boolean;
  job: PromptForgeJob;
  onAccept: () => void;
  onRegenerate: () => void;
  onRegenerateWithInstructions: (instructions: string) => void;
  onRestoreOriginal: () => void;
  onReturnFocus: () => void;
}

export function PromptForgeReview({
  open,
  compact = false,
  job,
  onAccept,
  onRegenerate,
  onRegenerateWithInstructions,
  onRestoreOriginal,
  onReturnFocus,
}: PromptForgeReviewProps) {
  const [showContext, setShowContext] = useState(false);
  const [context, setContext] = useState('');

  useEffect(() => {
    if (!open) return;
    setShowContext(false);
    setContext('');
  }, [job.id, open]);

  if (!open) return null;

  const modelLabel = job.resolvedModel?.label ?? 'Prompt Forge model';
  const validated = job.validation?.passed === true;

  return (
    <section
      role="region"
      aria-label="Prompt Forge inline review"
      data-sakura-surface="prompt-forge-inline-review"
      data-compact={compact ? 'true' : 'false'}
      className={cn(
        'mx-2 mb-1 rounded-lg border border-accent-cyan/30 bg-accent-cyan/[0.06] px-2.5 py-2',
        compact && 'mx-1 px-2 py-1.5',
      )}
    >
      <div className="flex min-w-0 items-center gap-2">
        <Sparkles
          aria-hidden
          className={cn('h-4 w-4 shrink-0 text-accent-cyan', compact && 'h-3.5 w-3.5')}
        />
        <div className="min-w-0 flex-1">
          <p className={cn('truncate text-secondary font-medium', compact && 'text-[11px]')}>
            Upgraded prompt ready
          </p>
          <p
            className={cn('truncate text-metadata text-muted-foreground', compact && 'text-[9px]')}
          >
            {modelLabel} · {validated ? 'details verified' : 'review suggested'}
          </p>
        </div>
      </div>

      {showContext ? (
        <div className="mt-2 flex min-w-0 gap-1.5">
          <input
            aria-label="Additional prompt context"
            value={context}
            onChange={(event) => setContext(event.target.value)}
            placeholder="Add constraints or missing context…"
            className={cn(
              'h-8 min-w-0 flex-1 rounded-md border border-input bg-background px-2.5 text-secondary outline-none focus:border-accent-cyan/50 focus:ring-1 focus:ring-ring',
              compact && 'h-7 px-2 text-[10px]',
            )}
          />
          <Button
            type="button"
            size="sm"
            variant="accent"
            aria-label="Apply additional context"
            disabled={!context.trim()}
            className={cn(compact && 'h-7 px-2 text-[10px]')}
            onClick={() => {
              const instructions = context.trim();
              if (!instructions) return;
              onRegenerateWithInstructions(instructions);
              onReturnFocus();
            }}
          >
            Apply
          </Button>
        </div>
      ) : null}

      <div className={cn('mt-2 flex flex-wrap items-center gap-1.5', compact && 'mt-1.5 gap-1')}>
        <Button
          type="button"
          size="sm"
          variant="accent"
          aria-label="Accept upgraded prompt"
          className={cn('h-7 px-2.5', compact && 'h-6 px-1.5 text-[10px]')}
          onClick={() => {
            onAccept();
            onReturnFocus();
          }}
        >
          <Check />
          Accept
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          aria-label="Retry prompt upgrade"
          className={cn('h-7 px-2.5', compact && 'h-6 px-1.5 text-[10px]')}
          onClick={() => {
            onRegenerate();
            onReturnFocus();
          }}
        >
          <RefreshCw />
          Retry
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          aria-label="Add context to prompt upgrade"
          aria-expanded={showContext}
          className={cn('h-7 px-2.5', compact && 'h-6 px-1.5 text-[10px]')}
          onClick={() => setShowContext((value) => !value)}
        >
          <MessageSquarePlus />
          Add context
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          aria-label="Restore original prompt"
          className={cn(
            'ml-auto h-7 px-2.5 text-muted-foreground',
            compact && 'ml-0 h-6 px-1.5 text-[10px]',
          )}
          onClick={() => {
            onRestoreOriginal();
            onReturnFocus();
          }}
        >
          <RotateCcw />
          Original
        </Button>
      </div>
    </section>
  );
}
