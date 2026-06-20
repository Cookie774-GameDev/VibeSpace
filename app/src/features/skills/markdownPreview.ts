/**
 * Markdown preview helpers shared by SkillDetail and SkillEditor.
 */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function renderInlineMarkdown(s: string): string {
  let out = s;
  out = out.replace(
    /`([^`]+)`/g,
    '<code class="px-1 py-0.5 rounded bg-paper-soft border border-border font-mono text-[0.92em]">$1</code>',
  );
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/(^|[^*])\*([^\s*][^*]*?)\*(?!\*)/g, '$1<em>$2</em>');
  return out;
}

const HEADING_CLASSES: Record<number, string> = {
  1: 'font-display text-2xl font-semibold text-foreground mt-4 mb-2 leading-tight tracking-tight',
  2: 'font-display text-xl font-semibold text-foreground mt-4 mb-2 leading-tight tracking-tight',
  3: 'font-display text-lg font-semibold text-foreground mt-3 mb-1.5 leading-snug',
};

/** Tiny trusted markdown → HTML for skill bodies. */
export function renderSkillMarkdown(src: string): string {
  let escaped = escapeHtml(src);

  const codeBlocks: string[] = [];
  escaped = escaped.replace(/```([\s\S]*?)```/g, (_, body: string) => {
    const cleaned = body.replace(/^\n/, '').replace(/\n$/, '');
    codeBlocks.push(
      `<pre class="my-3 rounded-md bg-paper-soft border border-border p-3 font-mono text-secondary leading-relaxed overflow-x-auto"><code>${cleaned}</code></pre>`,
    );
    return `\u0000CB${codeBlocks.length - 1}\u0000`;
  });

  // Images: ![alt](url) — spacing-friendly block display
  escaped = escaped.replace(
    /!\[([^\]]*)\]\(([^)]+)\)/g,
    '<figure class="my-4"><img src="$2" alt="$1" class="max-w-full rounded-lg border border-border shadow-soft" /><figcaption class="text-metadata text-muted-foreground mt-1.5 text-center">$1</figcaption></figure>',
  );

  const blocks = escaped.split(/\n\s*\n/);
  const parts: string[] = [];

  for (const block of blocks) {
    const trimmed = block.trim();
    if (!trimmed) continue;

    const phMatch = trimmed.match(/^\u0000CB(\d+)\u0000$/);
    if (phMatch) {
      parts.push(codeBlocks[Number(phMatch[1])]);
      continue;
    }

    const hMatch = trimmed.match(/^(#{1,3})\s+(.+)$/);
    if (hMatch && !trimmed.includes('\n')) {
      const level = hMatch[1].length;
      parts.push(
        `<h${level} class="${HEADING_CLASSES[level]}">${renderInlineMarkdown(hMatch[2])}</h${level}>`,
      );
      continue;
    }

    const lines = trimmed.split('\n');

    if (lines.every((l) => /^\d+\.\s+/.test(l))) {
      const items = lines
        .map((l) => `<li class="my-0.5">${renderInlineMarkdown(l.replace(/^\d+\.\s+/, ''))}</li>`)
        .join('');
      parts.push(`<ol class="list-decimal pl-6 my-2 space-y-0.5">${items}</ol>`);
      continue;
    }

    if (lines.every((l) => /^[-*]\s+/.test(l))) {
      const items = lines
        .map((l) => `<li class="my-0.5">${renderInlineMarkdown(l.replace(/^[-*]\s+/, ''))}</li>`)
        .join('');
      parts.push(`<ul class="list-disc pl-6 my-2 space-y-0.5">${items}</ul>`);
      continue;
    }

    parts.push(`<p class="my-2 leading-relaxed">${renderInlineMarkdown(lines.join(' '))}</p>`);
  }

  let out = parts.join('\n');
  out = out.replace(/\u0000CB(\d+)\u0000/g, (_, i) => codeBlocks[Number(i)] ?? '');
  return out;
}

export const SKILL_EMOJI_PRESETS = ['✨', '💻', '🔍', '✍️', '📋', '📅', '⌨️', '🌐', '📁', '🎙️', '🎵', '🧠', '📝', '⚡', '🐙', '🧩'];
