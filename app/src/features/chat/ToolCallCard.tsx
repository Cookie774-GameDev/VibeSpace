import * as React from 'react';
import { useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  ChevronDown,
  FileCode2,
  Pencil,
  Terminal,
  Wrench,
  CheckCircle2,
  XCircle,
  Loader2,
} from 'lucide-react';
import { Badge } from '@/components/ui';
import { useThemeLayoutTransition } from '@/features/appearance/themeMotion';
import { cn } from '@/lib/utils';
import type { Part } from '@/types';
import { displayToolCallArgs } from './toolCallArguments';

type ToolCallPart = Extract<Part, { kind: 'tool_call' }>;
type ToolResultPart = Extract<Part, { kind: 'tool_result' }>;

export interface ToolCallCardProps {
  call: ToolCallPart;
  /** Matching result, if available. May be undefined while pending. */
  result?: ToolResultPart;
}

type Status = 'pending' | 'success' | 'error';
const SPRING = 'spring' as const;
const EXPANSION_TRANSITION = { type: SPRING, stiffness: 400, damping: 30, mass: 0.8 };

const statusMeta: Record<
  Status,
  { label: string; variant: 'secondary' | 'success' | 'destructive'; icon: JSX.Element }
> = {
  pending: {
    label: 'Running',
    variant: 'secondary',
    icon: <Loader2 className="h-3 w-3 animate-spin" />,
  },
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

function basename(path: string): string {
  const parts = path.replace(/[\\/]+$/, '').split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

function toolPresentation(
  tool: string,
  args: Record<string, unknown>,
): {
  kind: 'edit' | 'read' | 'shell' | 'generic';
  label: string;
  path?: string;
  preview?: string;
} {
  const lower = tool.toLowerCase();
  const path =
    typeof args.path === 'string'
      ? args.path
      : typeof args.file === 'string'
        ? args.file
        : typeof args.filePath === 'string'
          ? args.filePath
          : undefined;
  const content =
    typeof args.content === 'string'
      ? args.content
      : typeof args.text === 'string'
        ? args.text
        : typeof args.command === 'string'
          ? args.command
          : undefined;

  if (
    lower.includes('write') ||
    lower.includes('edit') ||
    lower === 'files.write' ||
    lower.endsWith('.write')
  ) {
    return { kind: 'edit', label: 'Edit', path, preview: content };
  }
  if (lower.includes('read') || lower === 'files.read' || lower.endsWith('.read')) {
    return { kind: 'read', label: 'Read', path, preview: content };
  }
  if (lower.includes('shell') || lower.includes('powershell') || lower.includes('terminal')) {
    return { kind: 'shell', label: 'Shell', preview: content };
  }
  return { kind: 'generic', label: tool, path, preview: content };
}

export function ToolCallCard({ call, result }: ToolCallCardProps) {
  const [open, setOpen] = useState(false);
  const expansionTransition = useThemeLayoutTransition(EXPANSION_TRANSITION);
  const status: Status = !result ? 'pending' : result.error ? 'error' : 'success';
  const meta = statusMeta[status];
  const displayArgs = displayToolCallArgs(call);
  const presentation = toolPresentation(call.tool, displayArgs);
  const isFileStyle = presentation.kind === 'edit' || presentation.kind === 'read';

  if (isFileStyle) {
    const Icon = presentation.kind === 'edit' ? Pencil : FileCode2;
    return (
      <div className="overflow-hidden rounded-lg border border-accent-copper/30 bg-elevated/50 shadow-soft">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className={cn(
            'flex w-full items-center gap-2 px-3 py-2 text-left',
            'hover:bg-muted/40 transition-colors',
            'focus:outline-none focus-visible:ring-1 focus-visible:ring-ring',
          )}
          aria-expanded={open}
        >
          <span className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md border border-accent-copper/40 bg-accent-copper/15 text-accent-copper">
            <Icon className="h-3.5 w-3.5" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-[11px] font-semibold uppercase tracking-wide text-accent-copper">
                {presentation.label}
              </span>
              {presentation.path ? (
                <span className="truncate font-mono text-secondary text-foreground">
                  {basename(presentation.path)}
                </span>
              ) : (
                <span className="font-mono text-secondary text-foreground">{call.tool}</span>
              )}
            </div>
            {presentation.path ? (
              <p
                className="truncate font-mono text-[10px] text-muted-foreground"
                title={presentation.path}
              >
                {presentation.path}
              </p>
            ) : null}
          </div>
          <Badge variant={meta.variant} className="gap-1">
            {meta.icon}
            {meta.label}
          </Badge>
          <ChevronDown
            className={cn(
              'h-3.5 w-3.5 text-muted-foreground transition-transform',
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
              transition={expansionTransition}
              className="overflow-hidden border-t border-border"
            >
              <div className="space-y-2 px-3 py-2.5">
                {presentation.preview ? (
                  <pre className="max-h-72 overflow-auto rounded-md border border-border bg-background p-2 font-mono text-[11px] leading-relaxed">
                    {presentation.kind === 'edit'
                      ? presentation.preview.split('\n').map((line, i) => (
                          <div
                            key={i}
                            className="bg-emerald-500/10 text-emerald-300 whitespace-pre-wrap break-all"
                          >
                            +{line}
                          </div>
                        ))
                      : presentation.preview}
                  </pre>
                ) : (
                  <Section label="Args">
                    <pre className="overflow-x-auto whitespace-pre-wrap break-words rounded border border-border bg-background p-2 font-mono text-metadata">
                      {safeStringify(displayArgs)}
                    </pre>
                  </Section>
                )}
                {result && (
                  <Section label={result.error ? 'Error' : 'Result'}>
                    <pre
                      className={cn(
                        'overflow-x-auto whitespace-pre-wrap break-words rounded border p-2 font-mono text-metadata',
                        result.error
                          ? 'border-destructive/30 text-destructive'
                          : 'border-border text-foreground',
                      )}
                    >
                      {result.error ? result.error : safeStringify(result.result)}
                    </pre>
                  </Section>
                )}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-md border border-border bg-elevated">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={cn(
          'flex w-full items-center gap-2 px-3 py-2 text-left',
          'hover:bg-muted/40 transition-colors',
          'focus:outline-none focus-visible:ring-1 focus-visible:ring-ring',
        )}
        aria-expanded={open}
      >
        {presentation.kind === 'shell' ? (
          <Terminal className="h-3.5 w-3.5 shrink-0 text-accent-honey" />
        ) : (
          <Wrench className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        )}
        <span className="truncate font-mono text-secondary text-foreground">{call.tool}</span>
        <Badge variant={meta.variant} className="ml-1 gap-1">
          {meta.icon}
          {meta.label}
        </Badge>
        <ChevronDown
          className={cn(
            'ml-auto h-3.5 w-3.5 text-muted-foreground transition-transform',
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
            transition={expansionTransition}
            className="overflow-hidden border-t border-border"
          >
            <div className="space-y-3 px-3 py-2.5">
              <Section label="Args">
                <pre className="overflow-x-auto whitespace-pre-wrap break-words rounded border border-border bg-background p-2 font-mono text-metadata">
                  {safeStringify(displayArgs)}
                </pre>
              </Section>

              {result && (
                <Section label={result.error ? 'Error' : 'Result'}>
                  <pre
                    className={cn(
                      'overflow-x-auto whitespace-pre-wrap break-words rounded border p-2 font-mono text-metadata',
                      result.error
                        ? 'border-destructive/30 text-destructive'
                        : 'border-border text-foreground',
                    )}
                  >
                    {result.error ? result.error : safeStringify(result.result)}
                  </pre>
                </Section>
              )}

              <div className="font-mono text-metadata text-muted-foreground">
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
      <div className="mb-1 text-metadata uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      {children}
    </div>
  );
}
