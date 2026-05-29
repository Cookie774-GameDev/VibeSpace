/**
 * SkillDetail — renders the markdown body of one skill/agent.
 *
 * Includes a tiny inline markdown renderer (no external library) covering:
 *   - `# heading` (h1–h3)
 *   - paragraphs
 *   - `- bullet` and `1. ordered` lists
 *   - inline `code` and fenced ``` code blocks
 *   - **bold** and *italic*
 *
 * Input is HTML-escaped before any structural parsing, so the only HTML in
 * the output comes from our trusted templates.
 */
import * as React from 'react';
import { Check, Copy, Power, RefreshCw } from 'lucide-react';
import type { SkillManifest } from '@/features/skills/loader';
import { skillRegistry } from '@/features/skills/registry';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { toast } from '@/components/ui/toast';
import { cn } from '@/lib/utils';

const SEVERITY_LABEL = {
  crit: 'CRIT',
  high: 'HIGH',
  med: 'MED',
  low: 'LOW',
  info: 'INFO',
} as const;

/* ------------------------------------------------------------------ */
/* Tiny markdown renderer                                              */
/* ------------------------------------------------------------------ */

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Inline transforms. Input must already be HTML-escaped. */
function renderInline(s: string): string {
  let out = s;
  // Backtick code first so we don't accidentally match * inside it.
  out = out.replace(
    /`([^`]+)`/g,
    '<code class="px-1 py-0.5 rounded bg-paper-soft border border-border font-mono text-[0.92em]">$1</code>',
  );
  // **bold** must run before *italic* so the inner asterisks don't match.
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  // *italic* — leading/trailing asterisks not adjacent to another asterisk.
  out = out.replace(/(^|[^*])\*([^\s*][^*]*?)\*(?!\*)/g, '$1<em>$2</em>');
  return out;
}

const HEADING_CLASSES: Record<number, string> = {
  1: 'font-display text-2xl font-semibold text-foreground mt-4 mb-2 leading-tight tracking-tight',
  2: 'font-display text-xl font-semibold text-foreground mt-4 mb-2 leading-tight tracking-tight',
  3: 'font-display text-lg font-semibold text-foreground mt-3 mb-1.5 leading-snug',
};

function renderMarkdown(src: string): string {
  // 1. Escape first so anything that looks like HTML is harmless.
  let escaped = escapeHtml(src);

  // 2. Pull fenced code blocks out into placeholders.
  const codeBlocks: string[] = [];
  escaped = escaped.replace(/```([\s\S]*?)```/g, (_, body: string) => {
    const cleaned = body.replace(/^\n/, '').replace(/\n$/, '');
    codeBlocks.push(
      `<pre class="my-3 rounded-md bg-paper-soft border border-border p-3 font-mono text-secondary leading-relaxed overflow-x-auto"><code>${cleaned}</code></pre>`,
    );
    return `\u0000CB${codeBlocks.length - 1}\u0000`;
  });

  // 3. Split into block-level chunks.
  const blocks = escaped.split(/\n\s*\n/);
  const parts: string[] = [];

  for (const block of blocks) {
    const trimmed = block.trim();
    if (!trimmed) continue;

    // Code-block placeholder occupying its own block.
    const phMatch = trimmed.match(/^\u0000CB(\d+)\u0000$/);
    if (phMatch) {
      parts.push(codeBlocks[Number(phMatch[1])]);
      continue;
    }

    // Single-line heading.
    const hMatch = trimmed.match(/^(#{1,3})\s+(.+)$/);
    if (hMatch && !trimmed.includes('\n')) {
      const level = hMatch[1].length;
      parts.push(
        `<h${level} class="${HEADING_CLASSES[level]}">${renderInline(hMatch[2])}</h${level}>`,
      );
      continue;
    }

    const lines = trimmed.split('\n');

    // Ordered list (every line "N. ...")
    if (lines.every((l) => /^\d+\.\s+/.test(l))) {
      const items = lines
        .map((l) => `<li class="my-0.5">${renderInline(l.replace(/^\d+\.\s+/, ''))}</li>`)
        .join('');
      parts.push(`<ol class="list-decimal pl-6 my-2 space-y-0.5">${items}</ol>`);
      continue;
    }

    // Unordered list (every line "- ...")
    if (lines.every((l) => /^-\s+/.test(l))) {
      const items = lines
        .map((l) => `<li class="my-0.5">${renderInline(l.replace(/^-\s+/, ''))}</li>`)
        .join('');
      parts.push(`<ul class="list-disc pl-6 my-2 space-y-0.5">${items}</ul>`);
      continue;
    }

    // Plain paragraph: collapse soft line breaks into spaces.
    parts.push(`<p class="my-2 leading-relaxed">${renderInline(lines.join(' '))}</p>`);
  }

  // Backstop: re-insert any orphan placeholders (e.g. inline with prose).
  let out = parts.join('\n');
  out = out.replace(/\u0000CB(\d+)\u0000/g, (_, i) => codeBlocks[Number(i)] ?? '');
  return out;
}

/* ------------------------------------------------------------------ */
/* Component                                                           */
/* ------------------------------------------------------------------ */

export interface SkillDetailProps {
  manifest: SkillManifest;
  onToggleEnabled: (name: string, next: boolean) => void;
  className?: string;
}

export function SkillDetail({ manifest, onToggleEnabled, className }: SkillDetailProps) {
  const [copied, setCopied] = React.useState(false);
  const [reloading, setReloading] = React.useState(false);
  const html = React.useMemo(() => renderMarkdown(manifest.body), [manifest.body]);

  const severity = (manifest.severity ?? 'info') as keyof typeof SEVERITY_LABEL;

  const handleCopyId = async () => {
    try {
      await navigator.clipboard.writeText(manifest.name);
      setCopied(true);
      toast.success('Copied', `${manifest.name} → clipboard`);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      toast.error('Copy failed', 'Clipboard access denied.');
    }
  };

  const handleReload = async () => {
    setReloading(true);
    try {
      await skillRegistry.loadFromDisk();
      toast.success('Reloaded', 'Skills re-read from disk.');
    } catch (err) {
      toast.error('Reload failed', err instanceof Error ? err.message : String(err));
    } finally {
      setReloading(false);
    }
  };

  return (
    <div className={cn('flex flex-col h-full overflow-hidden', className)}>
      {/* Header */}
      <header className="px-6 pt-6 pb-4 shrink-0">
        <div className="eyebrow mb-2 flex flex-wrap items-center gap-x-1.5">
          <span>{manifest.kind}</span>
          <span className="opacity-50">·</span>
          <span className={cn(severity === 'crit' ? 'text-destructive' : 'text-accent-copper')}>
            {SEVERITY_LABEL[severity]}
          </span>
          {manifest.trigger && (
            <>
              <span className="opacity-50">·</span>
              <span>{manifest.trigger}</span>
            </>
          )}
        </div>
        <h1 className="font-display text-3xl font-semibold text-foreground leading-tight tracking-tight">
          {manifest.title}
        </h1>
        <div className="mt-1 text-metadata text-muted-foreground font-mono break-all">
          {manifest.name}
        </div>

        {/* Provider scope chips */}
        {manifest.when && manifest.when.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-1.5">
            {manifest.when.map((w: string) => (
              <span
                key={w}
                className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium bg-muted text-muted-foreground border border-border"
              >
                {w}
              </span>
            ))}
          </div>
        )}
      </header>

      <Separator />

      {/* Tools */}
      {manifest.tools && manifest.tools.length > 0 && (
        <>
          <div className="px-6 py-3 shrink-0">
            <div className="eyebrow mb-2">Tools</div>
            <div className="flex flex-wrap gap-1.5">
              {manifest.tools.map((tool: string) => (
                <span key={tool} className="kbd">
                  {tool}
                </span>
              ))}
            </div>
          </div>
          <Separator />
        </>
      )}

      {/* Markdown body */}
      <div className="flex-1 overflow-y-auto px-6 py-4 scrollbar-hidden">
        <div
          className="text-body text-foreground"
          // Renderer HTML-escapes input before parsing; output HTML comes only from our templates.
          dangerouslySetInnerHTML={{ __html: html }}
        />
      </div>

      <Separator />

      {/* Footer actions */}
      <div className="px-6 py-3 shrink-0 flex items-center justify-between gap-3 bg-elevated">
        <div className="text-metadata text-muted-foreground truncate font-mono">
          {manifest.filePath}
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <Button variant="ghost" size="sm" onClick={handleReload} disabled={reloading}>
            <RefreshCw className={cn('h-3.5 w-3.5', reloading && 'animate-spin')} />
            Reload from disk
          </Button>
          <Button variant="ghost" size="sm" onClick={handleCopyId}>
            {copied ? (
              <Check className="h-3.5 w-3.5 text-accent-sage" />
            ) : (
              <Copy className="h-3.5 w-3.5" />
            )}
            Copy ID
          </Button>
          <Button
            variant={manifest.enabled ? 'secondary' : 'accent'}
            size="sm"
            onClick={() => onToggleEnabled(manifest.name, !manifest.enabled)}
          >
            <Power
              className={cn('h-3.5 w-3.5', manifest.enabled && 'text-accent-sage')}
            />
            {manifest.enabled ? 'Disable' : 'Enable'}
          </Button>
        </div>
      </div>
    </div>
  );
}

export default SkillDetail;
