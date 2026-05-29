import { useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { ChevronDown, Wrench, CheckCircle2, XCircle, Loader2 } from 'lucide-react';
import { Badge } from '@/components/ui';
import { cn } from '@/lib/utils';
import type { Part } from '@/types';

type ToolCallPart = Extract<Part, { kind: 'tool_call' }>;
type ToolResultPart = Extract<Part, { kind: 'tool_result' }>;

export interface ToolCallCardProps {
  call: ToolCallPart;
  /** Matching result, if available. May be undefined while pending. */
  result?: ToolResultPart;
}

type Status = 'pending' | 'success' | 'error';

const statusMeta: Record<Status, { label: string; variant: 'secondary' | 'success' | 'destructive'; icon: JSX.Element }> = {
  pending: { label: 'Running', variant: 'secondary', icon: <Loader2 className="h-3 w-3 animate-spin" /> },
  success: { label: 'Done', variant: 'success', icon: <CheckCircle2 className="h-3 w-3" /> },
  error: { label: 'Failed', variant: 'destructive', icon: <XCircle className="h-3 w-3" /> },
};

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export function ToolCallCard({ call, result }: ToolCallCardProps) {
  const [open, setOpen] = useState(false);

  const status: Status = !result ? 'pending' : result.error ? 'error' : 'success';
  const meta = statusMeta[status];

  return (
    <div className="rounded-md border border-border bg-elevated overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={cn(
          'w-full flex items-center gap-2 px-3 py-2 text-left',
          'hover:bg-muted/40 transition-colors',
          'focus:outline-none focus-visible:ring-1 focus-visible:ring-ring',
        )}
        aria-expanded={open}
      >
        <Wrench className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
        <span className="font-mono text-secondary text-foreground truncate">{call.tool}</span>
        <Badge variant={meta.variant} className="ml-1 gap-1">
          {meta.icon}
          {meta.label}
        </Badge>
        <ChevronDown
          className={cn(
            'h-3.5 w-3.5 ml-auto text-muted-foreground transition-transform',
            open && 'rotate-180',
          )}
        />
      </button>

      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            key="body"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ type: 'spring', stiffness: 400, damping: 30, mass: 0.8 }}
            className="overflow-hidden border-t border-border"
          >
            <div className="px-3 py-2.5 space-y-3">
              <Section label="Args">
                <pre className="text-metadata font-mono bg-background border border-border rounded p-2 overflow-x-auto whitespace-pre-wrap break-words">
                  {safeStringify(call.args)}
                </pre>
              </Section>

              {result && (
                <Section label={result.error ? 'Error' : 'Result'}>
                  <pre
                    className={cn(
                      'text-metadata font-mono bg-background border rounded p-2 overflow-x-auto whitespace-pre-wrap break-words',
                      result.error ? 'border-destructive/30 text-destructive' : 'border-border text-foreground',
                    )}
                  >
                    {result.error ? result.error : safeStringify(result.result)}
                  </pre>
                </Section>
              )}

              <div className="text-metadata text-muted-foreground font-mono">
                call_id: {call.call_id}
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-metadata text-muted-foreground mb-1 uppercase tracking-wide">{label}</div>
      {children}
    </div>
  );
}
