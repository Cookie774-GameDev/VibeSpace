import {
  escapeHtml,
  renderInlineMarkdown,
  renderSkillMarkdown,
} from '@/features/skills/markdownPreview';
export type NoteFormat =
  'checklist' | 'bullet' | 'numbered' | 'heading' | 'quote' | 'link' | 'code' | 'bold' | 'italic';
export function formatNoteSelection(text: string, start: number, end: number, action: NoteFormat) {
  start = Math.max(0, Math.min(text.length, start));
  end = Math.max(start, Math.min(text.length, end));
  let replacement: string;
  if (['checklist', 'bullet', 'numbered', 'heading', 'quote'].includes(action)) {
    start = text.lastIndexOf('\n', start - 1) + 1;
    const last = text.indexOf('\n', end > start && text[end - 1] === '\n' ? end - 1 : end);
    end = last < 0 ? text.length : last;
    const prefixes = {
      checklist: '- [ ] ',
      bullet: '- ',
      numbered: '1. ',
      heading: '## ',
      quote: '> ',
    };
    replacement = text
      .slice(start, end)
      .split('\n')
      .map((line, index) => {
        const clean = line.replace(/^(?:#{1,6}\s+|>\s*|[-*]\s+(?:\[[ xX]\]\s+)?|\d+\.\s+)/u, '');
        return (
          (action === 'numbered' ? `${index + 1}. ` : prefixes[action as keyof typeof prefixes]) +
          clean
        );
      })
      .join('\n');
  } else {
    const selected = text.slice(start, end);
    if (action === 'link') replacement = `[${selected || 'link text'}](https://example.com)`;
    else if (action === 'code') {
      const longest = Math.max(
        2,
        ...[...(selected || '').matchAll(/`+/gu)].map((m) => m[0].length),
      );
      const fence = '`'.repeat(longest + 1);
      replacement = `${start && text[start - 1] !== '\n' ? '\n' : ''}${fence}\n${selected || 'code'}\n${fence}${end < text.length && text[end] !== '\n' ? '\n' : ''}`;
    } else {
      const marker = action === 'bold' ? '**' : '*';
      replacement =
        marker + (selected || (action === 'bold' ? 'bold text' : 'italic text')) + marker;
    }
  }
  return {
    text: text.slice(0, start) + replacement + text.slice(end),
    start,
    end: start + replacement.length,
  };
}
function fenceAt(line: string) {
  return /^\s{0,3}(`{3,}|~{3,})/u.exec(line)?.[1];
}
export function toggleNoteChecklist(text: string, lineNumber: number) {
  const lines = text.split('\n');
  let fence: string | undefined;
  for (let i = 0; i < lines.length; i++) {
    const marker = fenceAt(lines[i]);
    if (marker) {
      if (!fence) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = undefined;
      continue;
    }
    if (i === lineNumber && !fence)
      lines[i] = lines[i].replace(
        /^(\s*[-*]\s+)\[([ xX])\]/u,
        (_, prefix: string, checked: string) => `${prefix}[${checked === ' ' ? 'x' : ' '}]`,
      );
  }
  return lines.join('\n');
}
function inline(text: string): string {
  // Existing escaped inline renderer; only credential-free HTTP(S) links are made clickable.
  const pieces: string[] = [];
  let last = 0;
  for (const match of text.matchAll(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/gu)) {
    let url: URL;
    try {
      url = new URL(match[2]);
    } catch {
      continue;
    }
    if (url.username || url.password) continue;
    pieces.push(renderInlineMarkdown(escapeHtml(text.slice(last, match.index))));
    pieces.push(
      `<a href="${escapeHtml(url.href)}" target="_blank" rel="noopener noreferrer">${renderInlineMarkdown(escapeHtml(match[1]))}</a>`,
    );
    last = match.index! + match[0].length;
  }
  pieces.push(renderInlineMarkdown(escapeHtml(text.slice(last))));
  return pieces.join('');
}
export function renderNotesMarkdown(text: string): string {
  const lines = text.replace(/\r\n?/gu, '\n').split('\n');
  const output: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    const fence = fenceAt(line);
    if (fence) {
      const body: string[] = [];
      while (++i < lines.length) {
        const closing = fenceAt(lines[i]);
        if (closing && closing[0] === fence[0] && closing.length >= fence.length) break;
        body.push(lines[i]);
      }
      output.push(`<pre><code>${escapeHtml(body.join('\n'))}</code></pre>`);
      continue;
    }
    const task = /^\s*[-*]\s+\[([ xX])\]\s*(.*)$/u.exec(line);
    if (task) {
      output.push(
        `<label class="vs-notes-task"><input type="checkbox" data-note-line="${i}" ${task[1] === ' ' ? '' : 'checked'} aria-label="${escapeHtml(task[2] || 'Checklist item')}" /><span>${inline(task[2])}</span></label>`,
      );
      continue;
    }
    if (/^>\s?/u.test(line)) {
      output.push(`<blockquote>${inline(line.replace(/^>\s?/u, ''))}</blockquote>`);
      continue;
    }
    if (/^#{1,6}\s/u.test(line)) {
      const heading = /^(#{1,6})\s+(.*)$/u.exec(line)!;
      output.push(`<h${heading[1].length}>${inline(heading[2])}</h${heading[1].length}>`);
      continue;
    }
    if (/^(?:[-*]\s+|\d+\.\s+)/u.test(line)) {
      const block = [line];
      const numbered = /^\d+\./u.test(line);
      const pattern = numbered ? /^\d+\.\s+/u : /^[-*]\s+(?!\[[ xX]\])/u;
      while (i + 1 < lines.length && pattern.test(lines[i + 1])) block.push(lines[++i]);
      output.push(renderSkillMarkdown(block.join('\n')));
      continue;
    }
    if (/^\s*---+\s*$/u.test(line)) {
      output.push('<hr />');
      continue;
    }
    output.push(`<p>${inline(line)}</p>`);
  }
  return output.join('\n');
}
