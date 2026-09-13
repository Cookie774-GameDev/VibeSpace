import * as React from 'react';
import { ChevronRight, Copy, GitCompareArrows } from 'lucide-react';
import { toast } from '@/components/ui';
import { cn } from '@/lib/utils';
import { formatUnifiedDiffLines, type TranscriptBlock } from './projection';
import { PerceptibleAgentMotionIndicator, resolveAgentMotion } from './AgentMotionIndicator';

function copyText(text: string) {
  void navigator.clipboard?.writeText(text)
    .then(() => toast.success('Copied')).catch(() => toast.error('Copy failed'));
}

export function DiffView({
  block,
  compact,
}: {
  block: Pick<Extract<TranscriptBlock, { kind: 'diff' }>, 'diff' | 'status' | 'title' | 'filePath' | 'addedLines' | 'removedLines' | 'activityCategory'>;
  compact?: boolean;
}) {
  const [expanded, setExpanded] = React.useState(false);
  const detailId = React.useId();
  const lines = React.useMemo(() => formatUnifiedDiffLines(block.diff), [block.diff]);
  const label = block.status === 'done' ? 'Edited files'
    : block.status === 'error' ? 'Edit failed'
      : block.status === 'cancelled' ? 'Edit cancelled'
        : block.status === 'pending' ? 'Proposed file changes' : 'Editing files';
  const motion = resolveAgentMotion({
    status: block.status,
    activityCategory: block.activityCategory,
    activityKind: 'diff',
    title: block.title,
    filePath: block.filePath,
  });
  return (
    <section className="min-w-0">
      <button type="button" className="assistant-activity-ledger__disclosure"
        aria-expanded={expanded} aria-controls={detailId}
        onClick={() => setExpanded((value) => !value)}>
        <ChevronRight aria-hidden="true" className={cn('h-3.5 w-3.5 shrink-0', expanded && 'rotate-90')} />
        <span className="min-w-0 break-words [overflow-wrap:anywhere]">{label} · {block.filePath ?? block.title}</span>
      </button>
      <div id={detailId} hidden={!expanded}>
      {expanded ? (
    <article className="agentic-diff" aria-label={`Diff ${block.filePath ?? block.title}`}>
      <div className="agentic-block-head">
        <span>
          <PerceptibleAgentMotionIndicator motion={motion} compact={compact} />
          <GitCompareArrows aria-hidden="true" />
          <strong>{block.filePath ?? block.title}</strong>
        </span>
        <span className="agentic-block-head__metrics">
          {block.addedLines != null ? <b className="is-add">+{block.addedLines}</b> : null}
          {block.removedLines != null ? <b className="is-remove">-{block.removedLines}</b> : null}
          <button type="button" aria-label="Copy diff" onClick={() => copyText(block.diff)}>
            <Copy aria-hidden="true" />
          </button>
        </span>
      </div>
      <pre>
        {lines.map((line, index) => (
          <code
            key={`${index}:${line.text.slice(0, 20)}`}
            className={cn(
              'agentic-diff-line',
              line.kind === 'add' && 'agentic-diff-line--add',
              line.kind === 'remove' && 'agentic-diff-line--remove',
              line.kind === 'meta' && 'agentic-diff-line--meta',
            )}
          >
            <span className="agentic-diff-line__number" aria-hidden="true">
              {line.oldLine ?? ''}
            </span>
            <span className="agentic-diff-line__number" aria-hidden="true">
              {line.newLine ?? ''}
            </span>
            <span className="agentic-diff-line__text">{line.text || ' '}</span>
          </code>
        ))}
      </pre>
    </article>
      ) : null}
      </div>
    </section>
  );
}
