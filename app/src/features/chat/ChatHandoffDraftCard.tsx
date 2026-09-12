import { useId, useState } from 'react';
import { MessageSquare, X } from 'lucide-react';
import type { ChatHandoffProjectionV1 } from './chatHandoffProjection';
import './chat-reference-chip.css';

export interface ChatHandoffDraftCardProps {
  handoff: ChatHandoffProjectionV1;
  instruction: string;
  onInstructionChange: (value: string) => void;
  onRemove: () => void;
  initiallyExpanded?: boolean;
}

export function ChatHandoffDraftCard({
  handoff,
  instruction,
  onInstructionChange,
  onRemove,
  initiallyExpanded = false,
}: ChatHandoffDraftCardProps) {
  const [expanded, setExpanded] = useState(initiallyExpanded);
  const [showTranscript, setShowTranscript] = useState(false);
  const detailsId = useId();
  return (
    <section aria-label={`Pending handoff from ${handoff.source.title}`}>
      <span className="chat-reference-chip" contentEditable={false}>
        <button
          type="button"
          aria-label={`Reference ${handoff.source.title}`}
          aria-expanded={expanded}
          aria-controls={detailsId}
          title="View chat reference · Backspace or Delete removes it"
          onClick={() => setExpanded((value) => !value)}
          onKeyDown={(event) => {
            if (event.key === 'Backspace' || event.key === 'Delete') {
              event.preventDefault();
              event.stopPropagation();
              onRemove();
            }
          }}
        >
          <MessageSquare size={14} aria-hidden="true" />
          <span className="truncate">{handoff.source.title}</span>
        </button>
        <button
          type="button"
          className="chat-reference-remove"
          aria-label={`Remove handoff from ${handoff.source.title}`}
          onClick={onRemove}
        >
          <X size={12} aria-hidden="true" />
        </button>
      </span>
      {expanded ? (
        <div
          id={detailsId}
          className="mt-2 max-h-64 overflow-auto rounded-lg border border-border bg-background p-3 text-secondary text-foreground"
        >
          {handoff.goal ? <p>{handoff.goal}</p> : null}
          <p className="text-muted-foreground">{handoff.status}</p>
          {handoff.lastMeaningfulActivity ? (
            <p className="mt-1 whitespace-pre-wrap break-words">{handoff.lastMeaningfulActivity}</p>
          ) : null}
          {handoff.summaries.files.length ? (
            <p className="mt-2 break-words">Files: {handoff.summaries.files.join(', ')}</p>
          ) : null}
          <label className="mt-3 block">
            Instruction for {handoff.source.title}
            <textarea
              value={instruction}
              onChange={(event) => onInstructionChange(event.currentTarget.value)}
              rows={2}
              className="mt-1 w-full resize-y rounded-md border border-border bg-background px-2 py-1.5 text-body focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            />
          </label>
          <details
            className="mt-2"
            onToggle={(event) => setShowTranscript(event.currentTarget.open)}
          >
            <summary className="cursor-pointer">Saved context</summary>
            {showTranscript ? (
              <>
                {handoff.recentSections.map((section) => (
                  <p key={section.messageId} className="mt-2 whitespace-pre-wrap break-words">
                    <strong>{section.role}</strong>
                    {'\n'}
                    {section.visibleText}
                  </p>
                ))}
                <p className="mt-2 whitespace-pre-wrap break-words">{handoff.olderDigest}</p>
              </>
            ) : null}
          </details>
          <p className="mt-2 text-metadata text-muted-foreground">
            Nothing sends until you press Send.
          </p>
        </div>
      ) : null}
    </section>
  );
}
