import { useEffect, useRef } from 'react';
import { History, Play, RotateCcw, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui';
import { cn } from '@/lib/utils';
import { formatUserDateTime } from '@/lib/timeFormat';
import type { PromptForgeJob } from './contracts';
import './sakura-prompt-forge.css';

export interface PromptForgeRecoveryProps {
  job: PromptForgeJob;
  loading: boolean;
  error: string | null;
  resumeDisabledReason: string | null;
  needsContextConfirmation: boolean;
  compact: boolean;
  onRestore: () => void;
  onResume: () => void | Promise<unknown>;
  onDiscard: () => boolean | Promise<boolean>;
  onConfirmContextChange: () => void;
  onReturnFocus: () => void;
}

export function PromptForgeRecovery({
  job,
  loading,
  error,
  resumeDisabledReason,
  needsContextConfirmation,
  compact,
  onRestore,
  onResume,
  onDiscard,
  onConfirmContextChange,
  onReturnFocus,
}: PromptForgeRecoveryProps) {
  const restoreRef = useRef<HTMLButtonElement>(null);
  const resumeRef = useRef<HTMLButtonElement>(null);
  const focusResumeAfterConfirmationRef = useRef(false);

  useEffect(() => {
    if (needsContextConfirmation || !focusResumeAfterConfirmationRef.current) return;
    focusResumeAfterConfirmationRef.current = false;
    if (resumeRef.current && !resumeRef.current.disabled) {
      resumeRef.current.focus();
    } else if (restoreRef.current && !restoreRef.current.disabled) {
      restoreRef.current.focus();
    } else {
      onReturnFocus();
    }
  }, [needsContextConfirmation, onReturnFocus]);

  const confirmContextChange = () => {
    focusResumeAfterConfirmationRef.current = true;
    onConfirmContextChange();
  };

  const discard = async () => {
    if (await onDiscard()) onReturnFocus();
  };

  return (
    <section
      role="status"
      aria-live="polite"
      aria-label="Interrupted Prompt Forge upgrade"
      data-sakura-surface="prompt-forge-recovery"
      data-sakura-state={job.status}
      className={cn(
        'relative mb-2 overflow-hidden rounded-lg border border-accent-copper/30 bg-accent-copper/5',
        compact ? 'px-2.5 py-2' : 'px-3 py-2.5',
      )}
    >
      <div
        aria-hidden
        className="absolute inset-y-0 left-0 w-0.5 bg-gradient-to-b from-accent-copper to-accent-cyan"
      />
      <div className="flex flex-wrap items-center gap-2 pl-1">
        <History className="h-3.5 w-3.5 shrink-0 text-accent-copper" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="text-secondary font-medium text-foreground">
            Interrupted Prompt Forge upgrade
          </p>
          <p className="truncate text-metadata text-muted-foreground">
            Saved {formatUserDateTime(job.updatedAt)} · Your composer was not submitted.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-1">
          <Button
            ref={restoreRef}
            type="button"
            size="sm"
            variant="ghost"
            disabled={loading}
            onClick={onRestore}
            aria-label="Restore interrupted draft"
          >
            <RotateCcw />
            Restore draft
          </Button>
          <Button
            ref={resumeRef}
            type="button"
            size="sm"
            variant="secondary"
            disabled={loading || resumeDisabledReason !== null}
            onClick={() => void onResume()}
            aria-label="Resume interrupted upgrade"
            aria-description={resumeDisabledReason ?? undefined}
          >
            <Play />
            Resume
          </Button>
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            disabled={loading}
            onClick={() => void discard()}
            aria-label="Discard interrupted upgrade"
            className="text-muted-foreground hover:text-destructive"
          >
            <Trash2 />
          </Button>
        </div>
      </div>
      {resumeDisabledReason ? (
        <div className="mt-2 flex flex-wrap items-center gap-2 pl-5">
          <p className="min-w-0 flex-1 text-metadata text-muted-foreground">
            {resumeDisabledReason}
          </p>
          {needsContextConfirmation ? (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={loading}
              onClick={confirmContextChange}
              aria-label="Confirm current recovery context"
            >
              Use current context
            </Button>
          ) : null}
        </div>
      ) : null}
      {error ? (
        <p role="alert" className="mt-2 pl-5 text-metadata text-destructive">
          {error}
        </p>
      ) : null}
    </section>
  );
}
