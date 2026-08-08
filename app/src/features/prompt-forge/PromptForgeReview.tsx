import { useEffect, useMemo, useState } from 'react';
import { Check, Copy, RefreshCw, RotateCcw, ShieldCheck, Sparkles, X } from 'lucide-react';
import { Button, Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui';
import { cn } from '@/lib/utils';
import { formatUserDateTime } from '@/lib/timeFormat';
import type { PromptForgeJob } from './contracts';
import './sakura-prompt-forge.css';

type ReviewTab = 'upgraded' | 'original' | 'changes' | 'sources';
type DiffPart = Readonly<{ kind: 'same' | 'added' | 'removed'; text: string }>;

const TABS: readonly Readonly<{ id: ReviewTab; label: string }>[] = Object.freeze([
  { id: 'upgraded', label: 'Upgraded' },
  { id: 'original', label: 'Original' },
  { id: 'changes', label: 'Changes' },
  { id: 'sources', label: 'Sources' },
]);

function tokens(value: string): string[] {
  return value.split(/(\s+)/u).filter(Boolean);
}

export function buildPromptForgeDiff(original: string, upgraded: string): readonly DiffPart[] {
  const before = tokens(original);
  const after = tokens(upgraded);
  let prefix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) {
    prefix += 1;
  }
  let suffix = 0;
  while (
    suffix < before.length - prefix &&
    suffix < after.length - prefix &&
    before[before.length - suffix - 1] === after[after.length - suffix - 1]
  ) {
    suffix += 1;
  }
  const parts: DiffPart[] = [];
  const commonPrefix = before.slice(0, prefix).join('');
  const removed = before.slice(prefix, before.length - suffix).join('');
  const added = after.slice(prefix, after.length - suffix).join('');
  const commonSuffix = suffix === 0 ? '' : before.slice(before.length - suffix).join('');
  if (commonPrefix) parts.push(Object.freeze({ kind: 'same', text: commonPrefix }));
  if (removed) parts.push(Object.freeze({ kind: 'removed', text: removed }));
  if (added) parts.push(Object.freeze({ kind: 'added', text: added }));
  if (commonSuffix) parts.push(Object.freeze({ kind: 'same', text: commonSuffix }));
  return Object.freeze(parts);
}

export interface PromptForgeReviewProps {
  open: boolean;
  job: PromptForgeJob;
  upgradedDraft: string;
  onUpgradedDraftChange: (value: string) => void;
  excludedSourceIds: readonly string[];
  onExcludeSource: (sourceId: string) => void;
  onReplace: () => void;
  onInsertBelow: () => void;
  onCopy: () => void;
  onRegenerate: () => void;
  onRegenerateWithInstructions: (instructions: string) => void;
  onUndo: () => void;
  canUndo: boolean;
  onClose: () => void;
  onReturnFocus: () => void;
}

function validationLabel(job: PromptForgeJob): string {
  if (!job.validation) return 'Validation unavailable';
  return job.validation.passed
    ? 'Protected details verified'
    : `${job.validation.missingCount} protected detail${
        job.validation.missingCount === 1 ? '' : 's'
      } need review`;
}

export function PromptForgeReview({
  open,
  job,
  upgradedDraft,
  onUpgradedDraftChange,
  excludedSourceIds,
  onExcludeSource,
  onReplace,
  onInsertBelow,
  onCopy,
  onRegenerate,
  onRegenerateWithInstructions,
  onUndo,
  canUndo,
  onClose,
  onReturnFocus,
}: PromptForgeReviewProps) {
  const [tab, setTab] = useState<ReviewTab>('upgraded');
  const [showInstructions, setShowInstructions] = useState(false);
  const [instructions, setInstructions] = useState('');
  const excluded = useMemo(() => new Set(excludedSourceIds), [excludedSourceIds]);
  const diff = useMemo(
    () => buildPromptForgeDiff(job.originalDraft, upgradedDraft),
    [job.originalDraft, upgradedDraft],
  );

  useEffect(() => {
    if (!open) return;
    setTab('upgraded');
    setShowInstructions(false);
    setInstructions('');
  }, [job.id, open]);

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent
        data-sakura-surface="prompt-forge-review"
        className="flex h-[min(720px,90vh)] w-[min(920px,94vw)] max-w-4xl flex-col gap-0 overflow-hidden border-border/90 bg-elevated p-0"
        aria-label="Prompt Forge review"
      >
        <header
          data-sakura-surface="prompt-forge-review-header"
          className="relative shrink-0 border-b border-border bg-background/75 px-5 py-4 pr-14"
        >
          <div
            aria-hidden
            className="absolute inset-y-0 left-0 w-1 bg-gradient-to-b from-accent-cyan via-accent-violet to-accent-copper"
          />
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <DialogTitle className="flex items-center gap-2 font-display text-lg">
                <Sparkles className="h-4 w-4 text-accent-cyan" />
                Prompt Forge review
              </DialogTitle>
              <DialogDescription className="mt-1">
                Review the upgrade before it changes your composer.
              </DialogDescription>
            </div>
            <div className="flex flex-wrap items-center justify-end gap-2 text-metadata">
              <span className="rounded-full border border-border bg-muted/40 px-2 py-1 text-muted-foreground">
                {job.resolvedModel?.label ?? 'Model unavailable'}
              </span>
              <span
                className={cn(
                  'inline-flex items-center gap-1 rounded-full border px-2 py-1',
                  job.validation?.passed
                    ? 'border-success/30 bg-success/10 text-success'
                    : 'border-accent-copper/30 bg-accent-copper/10 text-accent-copper',
                )}
              >
                {job.validation?.passed ? (
                  <ShieldCheck className="h-3 w-3" />
                ) : (
                  <Sparkles className="h-3 w-3" />
                )}
                {validationLabel(job)}
              </span>
            </div>
          </div>
        </header>

        <div
          role="tablist"
          aria-label="Prompt Forge review views"
          data-sakura-surface="prompt-forge-review-tabs"
          className="flex shrink-0 gap-1 border-b border-border bg-panel/60 px-4 pt-2"
        >
          {TABS.map((item) => (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-label={item.label}
              aria-selected={tab === item.id}
              aria-controls={`prompt-forge-panel-${item.id}`}
              onClick={() => setTab(item.id)}
              className={cn(
                'relative rounded-t-md px-3 py-2 text-secondary outline-none transition-colors',
                'focus-visible:ring-1 focus-visible:ring-ring',
                tab === item.id
                  ? 'bg-background text-foreground after:absolute after:inset-x-2 after:-bottom-px after:h-px after:bg-accent-cyan'
                  : 'text-muted-foreground hover:bg-muted/50 hover:text-foreground',
              )}
            >
              {item.label}
              {item.id === 'sources' && job.retrievedSources.length > 0 ? (
                <span className="ml-1.5 text-metadata text-muted-foreground">
                  {job.retrievedSources.length - excluded.size}
                </span>
              ) : null}
            </button>
          ))}
        </div>

        <main
          data-sakura-content="prompt-forge-review-content"
          className="min-h-0 flex-1 overflow-auto bg-background p-4"
        >
          {tab === 'upgraded' ? (
            <section
              id="prompt-forge-panel-upgraded"
              role="tabpanel"
              aria-label="Upgraded prompt"
              className="h-full"
            >
              <label className="flex h-full min-h-[280px] flex-col gap-2">
                <span className="text-metadata font-medium uppercase tracking-[0.12em] text-muted-foreground">
                  Editable upgrade
                </span>
                <textarea
                  aria-label="Edit upgraded prompt"
                  value={upgradedDraft}
                  onChange={(event) => onUpgradedDraftChange(event.target.value)}
                  className="min-h-0 flex-1 resize-none rounded-lg border border-input bg-panel/40 p-4 font-mono text-secondary leading-relaxed text-foreground outline-none focus:border-accent-cyan/50 focus:ring-1 focus:ring-ring"
                />
              </label>
            </section>
          ) : null}

          {tab === 'original' ? (
            <section id="prompt-forge-panel-original" role="tabpanel" aria-label="Original prompt">
              <p className="mb-2 text-metadata font-medium uppercase tracking-[0.12em] text-muted-foreground">
                Preserved original
              </p>
              <pre className="whitespace-pre-wrap rounded-lg border border-border bg-panel/40 p-4 font-mono text-secondary leading-relaxed text-foreground">
                {job.originalDraft}
              </pre>
            </section>
          ) : null}

          {tab === 'changes' ? (
            <section id="prompt-forge-panel-changes" role="tabpanel" aria-label="Prompt changes">
              <p className="mb-3 text-metadata text-muted-foreground">
                Removed text is struck through; added text is highlighted.
              </p>
              <div className="whitespace-pre-wrap rounded-lg border border-border bg-panel/40 p-4 font-mono text-secondary leading-relaxed">
                {diff.map((part, index) => (
                  <span
                    key={`${part.kind}-${index}`}
                    className={cn(
                      part.kind === 'same' && 'text-foreground',
                      part.kind === 'added' &&
                        'rounded-sm bg-success/15 text-success ring-1 ring-success/20',
                      part.kind === 'removed' &&
                        'bg-destructive/10 text-destructive line-through decoration-destructive/70',
                    )}
                  >
                    {part.text}
                  </span>
                ))}
              </div>
            </section>
          ) : null}

          {tab === 'sources' ? (
            <section
              id="prompt-forge-panel-sources"
              role="tabpanel"
              aria-label="Prompt sources"
              className="space-y-2"
            >
              {job.retrievedSources.length === 0 ? (
                <div className="rounded-lg border border-dashed border-border p-6 text-center text-secondary text-muted-foreground">
                  No project sources were used for this upgrade.
                </div>
              ) : (
                job.retrievedSources.map((source) => {
                  const removed = excluded.has(source.id);
                  return (
                    <article
                      key={source.id}
                      className={cn(
                        'rounded-lg border border-border bg-panel/40 p-3',
                        removed && 'opacity-55',
                      )}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <h3
                              className={cn(
                                'text-secondary font-medium',
                                removed && 'line-through',
                              )}
                            >
                              {source.label}
                            </h3>
                            <span className="rounded border border-border px-1.5 py-0.5 text-metadata text-muted-foreground">
                              {source.kind.replaceAll('_', ' ')}
                            </span>
                          </div>
                          <p className="mt-1 break-all font-mono text-metadata text-accent-cyan">
                            {source.reference}
                          </p>
                          <p className="mt-2 text-secondary text-muted-foreground">
                            {source.whySelected}
                          </p>
                          <p className="mt-1 text-metadata text-muted-foreground">
                            Observed {formatUserDateTime(source.observedAt)}
                          </p>
                        </div>
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          onClick={() => onExcludeSource(source.id)}
                          aria-label={`${removed ? 'Restore' : 'Remove'} ${source.label}`}
                        >
                          {removed ? <Check /> : <X />}
                          {removed ? 'Restore' : 'Remove'}
                        </Button>
                      </div>
                    </article>
                  );
                })
              )}
            </section>
          ) : null}
        </main>

        {showInstructions ? (
          <div className="shrink-0 border-t border-border bg-panel/50 px-4 py-3">
            <label className="flex flex-col gap-2">
              <span className="text-metadata font-medium text-foreground">
                Regeneration instructions
              </span>
              <div className="flex gap-2">
                <input
                  aria-label="Regeneration instructions"
                  value={instructions}
                  onChange={(event) => setInstructions(event.target.value)}
                  placeholder="For example: Keep it shorter and preserve the checklist."
                  className="h-8 min-w-0 flex-1 rounded-md border border-input bg-background px-3 text-secondary outline-none focus:border-accent-cyan/50 focus:ring-1 focus:ring-ring"
                />
                <Button
                  type="button"
                  size="sm"
                  variant="accent"
                  disabled={!instructions.trim()}
                  onClick={() => {
                    onRegenerateWithInstructions(instructions.trim());
                    onReturnFocus();
                  }}
                  aria-label="Apply regeneration instructions"
                >
                  Apply
                </Button>
              </div>
            </label>
          </div>
        ) : null}

        <footer
          data-sakura-surface="prompt-forge-review-footer"
          className="flex shrink-0 flex-wrap items-center gap-2 border-t border-border bg-elevated px-4 py-3"
        >
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => {
              onRegenerate();
              onReturnFocus();
            }}
            aria-label="Regenerate"
          >
            <RefreshCw />
            Regenerate
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => setShowInstructions((value) => !value)}
            aria-label="Regenerate with instructions"
          >
            <Sparkles />
            Instructions
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={onCopy}
            aria-label="Copy upgraded prompt"
          >
            <Copy />
            Copy
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={onUndo}
            disabled={!canUndo}
            aria-label="Undo last replacement"
          >
            <RotateCcw />
            Undo
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="ml-auto"
            onClick={onClose}
            aria-label="Cancel and keep original"
          >
            Keep original
          </Button>
          <Button
            type="button"
            size="sm"
            variant="secondary"
            onClick={onInsertBelow}
            aria-label="Insert below original"
          >
            Insert below
          </Button>
          <Button
            type="button"
            size="sm"
            variant="accent"
            onClick={onReplace}
            disabled={!upgradedDraft.trim()}
            aria-label="Replace original"
          >
            Replace original
          </Button>
        </footer>
      </DialogContent>
    </Dialog>
  );
}
