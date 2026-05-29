import { FileText, Image as ImageIcon } from 'lucide-react';
import { ToolCallCard } from './ToolCallCard';
import type { Part } from '@/types';

export interface MessagePartProps {
  part: Part;
  /**
   * Full parts array of the parent message - lets us pair a `tool_call`
   * with its matching `tool_result` for inline rendering.
   */
  allParts: Part[];
}

/**
 * Dispatch on Part.kind. Each part renders as its own block in the bubble body.
 * Pairs tool_call <-> tool_result by call_id.
 */
export function MessagePart({ part, allParts }: MessagePartProps) {
  switch (part.kind) {
    case 'text': {
      if (!part.text) {
        // Streaming-not-yet-arrived: render a faint pulse so the bubble has presence.
        return <span className="inline-block h-3 w-3 rounded-full bg-muted-foreground/40 animate-pulse" aria-label="Thinking" />;
      }
      return (
        <div className="text-body text-foreground whitespace-pre-wrap break-words leading-relaxed">
          {part.text}
        </div>
      );
    }

    case 'reasoning': {
      if (!part.text) return null;
      return (
        <div className="text-secondary text-muted-foreground italic whitespace-pre-wrap break-words border-l-2 border-border pl-2">
          {part.text}
        </div>
      );
    }

    case 'tool_call': {
      const result = allParts.find(
        (p): p is Extract<Part, { kind: 'tool_result' }> =>
          p.kind === 'tool_result' && p.call_id === part.call_id,
      );
      return <ToolCallCard call={part} result={result} />;
    }

    case 'tool_result': {
      // Tool results are rendered alongside their tool_call. Skip if a
      // matching call exists; otherwise show as an orphan card.
      const hasCall = allParts.some(
        (p) => p.kind === 'tool_call' && p.call_id === part.call_id,
      );
      if (hasCall) return null;
      return (
        <div className="rounded-md border border-border bg-elevated px-3 py-2">
          <div className="text-metadata text-muted-foreground mb-1 uppercase tracking-wide">
            Tool result ({part.call_id})
          </div>
          <pre className="text-metadata font-mono whitespace-pre-wrap break-words">
            {part.error ?? JSON.stringify(part.result, null, 2)}
          </pre>
        </div>
      );
    }

    case 'image': {
      return (
        <div className="rounded-md overflow-hidden border border-border bg-elevated max-w-sm">
          <img
            src={part.url}
            alt={part.alt ?? ''}
            className="block w-full h-auto"
            loading="lazy"
          />
          {part.alt && (
            <div className="px-2 py-1 text-metadata text-muted-foreground flex items-center gap-1">
              <ImageIcon className="h-3 w-3" />
              {part.alt}
            </div>
          )}
        </div>
      );
    }

    case 'file_ref': {
      const ref = part.ref;
      return (
        <div className="inline-flex items-center gap-1.5 rounded-md border border-border bg-elevated px-2 py-1 text-secondary text-foreground">
          <FileText className="h-3.5 w-3.5 text-muted-foreground" />
          <span className="font-mono text-metadata">{ref.kind}</span>
          <span className="text-muted-foreground">·</span>
          <span className="truncate max-w-[20ch]">{ref.id}</span>
          {ref.excerpt && (
            <span className="text-muted-foreground truncate max-w-[24ch]">"{ref.excerpt}"</span>
          )}
        </div>
      );
    }

    default: {
      // Exhaustive check - new Part kinds will surface here at compile time.
      const _exhaustive: never = part;
      void _exhaustive;
      return null;
    }
  }
}
