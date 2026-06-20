/**
 * SkillCard — the cozy paper-card for one skill or agent in the Library rail.
 *
 * Pure presentation: the parent owns selection state and the toggle handler.
 * Click anywhere on the card selects it; clicks on the inner Switch are
 * absorbed so they don't double-fire as a select.
 *
 * Slice 5 owns the manifest + registry. We only consume `SkillManifest` here.
 */
import * as React from 'react';
import { Sparkles } from 'lucide-react';
import type { SkillManifest } from '@/features/skills/loader';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';

/**
 * Pull the first prose paragraph out of a markdown body.
 * Skips fenced code, ATX headings, and list lines so the preview is real
 * sentences rather than the file's H1.
 */
function firstProseParagraph(body: string, maxChars = 220): string {
  const noCode = body.replace(/```[\s\S]*?```/g, '');
  for (const block of noCode.split(/\n\s*\n/)) {
    const trimmed = block.trim();
    if (!trimmed) continue;
    if (/^#/.test(trimmed)) continue; // heading
    if (/^[-*]\s/.test(trimmed)) continue; // bullet
    if (/^\d+\.\s/.test(trimmed)) continue; // ordered
    const plain = trimmed
      .replace(/`([^`]+)`/g, '$1')
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/\*([^*]+)\*/g, '$1')
      .replace(/\s+/g, ' ');
    return plain.length > maxChars ? plain.slice(0, maxChars - 1) + '…' : plain;
  }
  return '';
}

export interface SkillCardProps {
  manifest: SkillManifest;
  selected: boolean;
  onSelect: (name: string) => void;
  onToggleEnabled: (name: string, next: boolean) => void;
}

export function SkillCard({
  manifest,
  selected,
  onSelect,
  onToggleEnabled,
}: SkillCardProps) {
  const id = manifest.catalogId ?? manifest.name;
  const hue = manifest.colorHue ?? 35;
  const Icon = Sparkles;
  const summary = React.useMemo(
    () => manifest.description || firstProseParagraph(manifest.body),
    [manifest.description, manifest.body],
  );

  return (
    <div
      role="button"
      tabIndex={0}
      aria-pressed={selected}
      onClick={() => onSelect(id)}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return;
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelect(id);
        }
      }}
      className={cn(
        'group flex flex-col gap-2.5 cursor-pointer transition-all',
        'rounded-xl border border-border bg-paper shadow-soft p-3.5',
        'hover:shadow-lift hover:border-accent-cream/50',
        'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent-copper',
        selected && 'ring-1 ring-accent-copper border-accent-copper/60',
      )}
      style={{ borderLeftWidth: 3, borderLeftColor: `hsl(${hue}, 50%, 45%)` }}
    >
      <div className="flex items-start gap-2">
        <span className="text-xl shrink-0 leading-none" aria-hidden>
          {manifest.emoji ?? (manifest.isPreset ? '⚙️' : '✨')}
        </span>
        <div className="flex-1 min-w-0 font-display font-semibold text-foreground leading-tight text-[15px]">
          {manifest.title}
        </div>
      </div>

      <div className="flex items-center gap-1.5 text-metadata text-muted-foreground">
        <Icon className="h-3.5 w-3.5 text-accent-copper" />
        <span className="uppercase tracking-wider font-semibold">
          {manifest.isPreset ? 'preset' : 'custom'}
        </span>
        {manifest.source === 'project' && !manifest.isPreset && (
          <span className="ml-1 px-1.5 py-px rounded-sm border border-border text-[10px] font-medium">
            local
          </span>
        )}
      </div>

      {/* 2-line body preview */}
      {summary && (
        <p className="text-secondary text-muted-foreground leading-relaxed line-clamp-2">
          {summary}
        </p>
      )}

      {/* Footer: tags + enabled switch */}
      <div className="flex items-center justify-between gap-2 mt-auto pt-1">
        <div className="flex flex-wrap gap-1 min-w-0">
          {(manifest.tags ?? []).slice(0, 4).map((t: string) => (
            <span
              key={t}
              className="inline-flex items-center px-1.5 py-0.5 rounded-full text-[10px] font-medium bg-muted text-muted-foreground border border-border"
            >
              {t}
            </span>
          ))}
        </div>
        <div
          className="shrink-0"
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
        >
          <Switch
            checked={!!manifest.enabled}
            onCheckedChange={(v) => onToggleEnabled(id, v)}
            aria-label={manifest.enabled ? 'Disable skill' : 'Enable skill'}
          />
        </div>
      </div>
    </div>
  );
}

export default SkillCard;
