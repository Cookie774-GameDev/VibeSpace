import { useId, useState } from 'react';
import { ChevronRight } from 'lucide-react';

/** Only displays reasoning supplied by the runtime's public message stream. */
export function ThinkingDisclosure({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  const detailId = useId();
  return (
    <section className="min-w-0 text-secondary text-muted-foreground">
      <button
        type="button"
        className="flex items-center gap-1.5 rounded px-1 py-1 text-secondary focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
        aria-expanded={expanded}
        aria-controls={detailId}
        onClick={() => setExpanded((value) => !value)}
      >
        <ChevronRight aria-hidden="true" className={`h-3.5 w-3.5 shrink-0 ${expanded ? 'rotate-90' : ''}`} />
        Thinking
      </button>
      <div id={detailId} hidden={!expanded}>
        {expanded ? (
          <p className="m-0 whitespace-pre-wrap break-words [overflow-wrap:anywhere] border-l-2 border-border pl-2">
            {text.trim() ? text : 'Thinking details are unavailable for this response.'}
          </p>
        ) : null}
      </div>
    </section>
  );
}
