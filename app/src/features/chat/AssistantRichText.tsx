import { Fragment, useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import { cn } from '@/lib/utils';
import './assistant-rich-text.css';

type InlineToken =
  | { kind: 'text'; value: string }
  | { kind: 'code'; value: string }
  | { kind: 'strong'; value: string }
  | { kind: 'emphasis'; value: string }
  | { kind: 'link'; label: string; href: string };

export type AssistantListItem = {
  text: string;
  depth: number;
  ordered: boolean;
  marker: string;
};

export type AssistantBlock =
  | { kind: 'paragraph'; lines: string[] }
  | { kind: 'heading'; level: 1 | 2 | 3; text: string }
  | { kind: 'list'; items: AssistantListItem[] }
  | { kind: 'quote'; lines: string[] }
  | { kind: 'code'; language: string; value: string }
  | { kind: 'diagram'; language: string; value: string }
  | { kind: 'table'; headers: string[]; rows: string[][] }
  | { kind: 'rule' };

type DiagramNode = { id: string; label: string };
type DiagramEdge = { from: string; to: string };
type Fence = { language: string; marker: string };

const DIAGRAM_LANGUAGES = new Set(['mermaid', 'graphviz', 'dot']);
const PLAIN_SNIPPET_LANGUAGES = new Set(['plain', 'text', 'txt', 'plaintext', 'writing', 'md', 'markdown']);
const SAFE_LINK_PROTOCOLS = new Set([
  'http:',
  'https:',
  'mailto:',
  'asset:',
  'app:',
  'jarvis:',
  'tauri:',
  'vibespace:',
]);

function isSafeHref(value: string): boolean {
  const href = value.trim();
  if (!href || href.startsWith('#') || href.startsWith('/') || href.startsWith('./') || href.startsWith('../')) {
    return Boolean(href);
  }
  try {
    return SAFE_LINK_PROTOCOLS.has(new URL(href).protocol);
  } catch {
    return false;
  }
}

function pushText(tokens: InlineToken[], value: string): void {
  if (!value) return;
  const previous = tokens.at(-1);
  if (previous?.kind === 'text') previous.value += value;
  else tokens.push({ kind: 'text', value });
}

/**
 * Parse the small, presentation-focused Markdown subset used in chat.
 * Everything that is not recognized remains a text token, so the renderer
 * never evaluates model-authored HTML or silently drops prose.
 */
export function parseAssistantInline(value: string): InlineToken[] {
  const tokens: InlineToken[] = [];
  let index = 0;

  while (index < value.length) {
    const remaining = value.slice(index);

    if (value[index] === '`') {
      const end = value.indexOf('`', index + 1);
      if (end > index + 1) {
        tokens.push({ kind: 'code', value: value.slice(index + 1, end) });
        index = end + 1;
        continue;
      }
    }

    const link = remaining.match(/^\[([^\]\n]+)\]\(([^)\s]+(?:\s+[^)\s]+)?)\)/);
    if (link) {
      const href = link[2].trim();
      if (isSafeHref(href)) {
        tokens.push({ kind: 'link', label: link[1], href });
        index += link[0].length;
        continue;
      }
    }

    const strongMarker = remaining.startsWith('**') ? '**' : remaining.startsWith('__') ? '__' : null;
    if (strongMarker) {
      const end = value.indexOf(strongMarker, index + 2);
      if (end > index + 2) {
        tokens.push({ kind: 'strong', value: value.slice(index + 2, end) });
        index = end + 2;
        continue;
      }
    }

    const emphasisMarker = remaining[0] === '*' || remaining[0] === '_' ? remaining[0] : null;
    if (emphasisMarker && remaining[1] !== emphasisMarker) {
      const end = value.indexOf(emphasisMarker, index + 1);
      if (end > index + 1 && !/\s/.test(value[index + 1] ?? '')) {
        tokens.push({ kind: 'emphasis', value: value.slice(index + 1, end) });
        index = end + 1;
        continue;
      }
    }

    pushText(tokens, value[index]);
    index += 1;
  }

  return tokens;
}

function splitTableRow(line: string): string[] {
  const trimmed = line.trim();
  const withoutOuterPipes = trimmed.startsWith('|') ? trimmed.slice(1) : trimmed;
  const row = withoutOuterPipes.endsWith('|')
    ? withoutOuterPipes.slice(0, -1)
    : withoutOuterPipes;
  return row.split(/(?<!\\)\|/).map((cell) => cell.replace(/\\\|/g, '|').trim());
}

function isTableDivider(line: string): boolean {
  const cells = splitTableRow(line);
  return cells.length >= 2 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

function isTableRow(line: string): boolean {
  return line.includes('|') && splitTableRow(line).length >= 2;
}

function listMatch(line: string): { depth: number; ordered: boolean; marker: string; text: string } | undefined {
  const match = line.match(/^(\s*)(?:(\d+[.)])|([-+*]))\s+(.*)$/);
  if (!match) return undefined;
  return {
    depth: Math.min(6, Math.floor(match[1].replace(/\t/g, '  ').length / 2)),
    ordered: Boolean(match[2]),
    marker: match[2] ?? match[3] ?? '•',
    text: match[4],
  };
}

function fenceMatch(line: string): Fence | undefined {
  const match = line.match(/^\s*(`{3,}|~{3,})\s*([\w.+-]*)\s*$/);
  return match ? { marker: match[1], language: match[2].toLowerCase() } : undefined;
}

function isClosingFence(line: string, opening: Fence): boolean {
  const match = line.match(/^\s*(`{3,}|~{3,})\s*$/);
  return Boolean(match && match[1][0] === opening.marker[0] && match[1].length >= opening.marker.length);
}

function isStructuralLine(line: string): boolean {
  return Boolean(
    fenceMatch(line) ||
      /^\s{0,3}#{1,3}\s+/.test(line) ||
      listMatch(line) ||
      /^\s*>/.test(line) ||
      /^\s*(?:---+|\*\*\*+|___+)\s*$/.test(line),
  );
}

/** Parse the safe block-level subset used by assistant responses. */
export function parseAssistantBlocks(source: string): AssistantBlock[] {
  if (!source) return [];

  const lines = source.split(/\r?\n/);
  const blocks: AssistantBlock[] = [];
  let index = 0;

  const pushParagraph = (paragraph: string[]) => {
    if (paragraph.length > 0) blocks.push({ kind: 'paragraph', lines: paragraph });
  };

  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) {
      index += 1;
      continue;
    }

    const fence = fenceMatch(line);
    if (fence) {
      const content: string[] = [];
      index += 1;
      while (index < lines.length && !isClosingFence(lines[index], fence)) {
        content.push(lines[index]);
        index += 1;
      }
      if (index < lines.length && isClosingFence(lines[index], fence)) index += 1;
      const value = content.join('\n');
      blocks.push(
        DIAGRAM_LANGUAGES.has(fence.language)
          ? { kind: 'diagram', language: fence.language, value }
          : { kind: 'code', language: fence.language, value },
      );
      continue;
    }

    const heading = line.match(/^\s{0,3}(#{1,3})\s+(.+?)\s*$/);
    if (heading) {
      blocks.push({ kind: 'heading', level: heading[1].length as 1 | 2 | 3, text: heading[2] });
      index += 1;
      continue;
    }

    if (index + 1 < lines.length && isTableRow(line) && isTableDivider(lines[index + 1])) {
      const headers = splitTableRow(line);
      const rows: string[][] = [];
      index += 2;
      while (index < lines.length && isTableRow(lines[index]) && lines[index].trim()) {
        rows.push(splitTableRow(lines[index]));
        index += 1;
      }
      blocks.push({ kind: 'table', headers, rows });
      continue;
    }

    const firstListItem = listMatch(line);
    if (firstListItem) {
      const items: AssistantListItem[] = [];
      while (index < lines.length) {
        const item = listMatch(lines[index]);
        if (!item) break;
        items.push(item);
        index += 1;
      }
      blocks.push({ kind: 'list', items });
      continue;
    }

    if (/^\s*>/.test(line)) {
      const quoteLines: string[] = [];
      while (index < lines.length && /^\s*>/.test(lines[index])) {
        quoteLines.push(lines[index].replace(/^\s*>\s?/, ''));
        index += 1;
      }
      blocks.push({ kind: 'quote', lines: quoteLines });
      continue;
    }

    if (/^\s*(?:---+|\*\*\*+|___+)\s*$/.test(line)) {
      blocks.push({ kind: 'rule' });
      index += 1;
      continue;
    }

    const paragraph: string[] = [line];
    index += 1;
    while (index < lines.length && lines[index].trim() && !isStructuralLine(lines[index])) {
      paragraph.push(lines[index]);
      index += 1;
    }
    pushParagraph(paragraph);
  }

  return blocks;
}

function renderInline(value: string, keyPrefix: string): ReactNode[] {
  return parseAssistantInline(value).map((token, index) => {
    const key = `${keyPrefix}-${index}`;
    switch (token.kind) {
      case 'code':
        return <code key={key} className="assistant-rich-text__inline-code">{token.value}</code>;
      case 'strong':
        return <strong key={key}>{renderInline(token.value, `${key}-strong`)}</strong>;
      case 'emphasis':
        return <em key={key}>{renderInline(token.value, `${key}-emphasis`)}</em>;
      case 'link':
        return (
          <a
            key={key}
            className="assistant-rich-text__link"
            href={token.href}
            target={/^https?:/i.test(token.href) ? '_blank' : undefined}
            rel={/^https?:/i.test(token.href) ? 'noreferrer' : undefined}
          >
            {renderInline(token.label, `${key}-link`)}
          </a>
        );
      case 'text':
        return <Fragment key={key}>{token.value}</Fragment>;
    }
  });
}

function renderLines(lines: string[], keyPrefix: string): ReactNode[] {
  return lines.flatMap((line, index) => [
    <Fragment key={`${keyPrefix}-line-${index}`}>{renderInline(line, `${keyPrefix}-${index}`)}</Fragment>,
    ...(index < lines.length - 1 ? [<br key={`${keyPrefix}-break-${index}`} />] : []),
  ]);
}

function diagramPreview(value: string, language: string): {
  nodes: DiagramNode[];
  edges: DiagramEdge[];
  supported: boolean;
} {
  const nodes = new Map<string, string>();
  const edges: DiagramEdge[] = [];
  const addNode = (id: string, label?: string) => {
    const cleanId = id.trim();
    if (!cleanId || /^(?:flowchart|graph|subgraph|end|direction|TD|TB|LR|RL|BT)$/i.test(cleanId)) return;
    nodes.set(cleanId, (label ?? nodes.get(cleanId) ?? cleanId).trim());
  };

  const lines = value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const supported = language === 'mermaid'
    ? lines.length >= 2 &&
      /^(?:flowchart|graph)\s+(?:TD|TB|BT|RL|LR)$/i.test(lines[0]) &&
      lines.slice(1).every((line) =>
        /^[A-Za-z][\w-]*(?:\[[^\]]+\]|\([^)]+\)|\{[^}]+\})?\s*-->\s*[A-Za-z][\w-]*(?:\[[^\]]+\]|\([^)]+\)|\{[^}]+\})?$/i.test(line),
      )
    : lines.every((line) =>
        /^(?:strict\s+)?(?:digraph|graph)\b/i.test(line) ||
        /^[{};]+$/.test(line) ||
        /^\/\//.test(line) ||
        /^[A-Za-z][\w-]*\s*\[\s*label\s*=/.test(line) ||
        /^[A-Za-z][\w-]*\s*->\s*[A-Za-z][\w-]*\s*;?$/.test(line),
      );

  if (language === 'mermaid') {
    for (const match of value.matchAll(/\b([A-Za-z][\w-]*)\s*(?:\[([^\]]+)\]|\(([^)]+)\)|\{([^}]+)\})/g)) {
      addNode(match[1], match[2] ?? match[3] ?? match[4]);
    }
    for (const match of value.matchAll(/\b([A-Za-z][\w-]*)\s*(?:\[[^\]]+\]|\([^)]+\)|\{[^}]+\})?\s*-->\s*([A-Za-z][\w-]*)/g)) {
      addNode(match[1]);
      addNode(match[2]);
      edges.push({ from: match[1], to: match[2] });
    }
  } else {
    for (const match of value.matchAll(/\b([A-Za-z][\w-]*)\s*\[\s*label\s*=\s*["']?([^\]"']+)["']?\s*\];?/g)) {
      addNode(match[1], match[2]);
    }
    for (const match of value.matchAll(/\b([A-Za-z][\w-]*)\s*->\s*([A-Za-z][\w-]*)/g)) {
      addNode(match[1]);
      addNode(match[2]);
      edges.push({ from: match[1], to: match[2] });
    }
  }

  return { nodes: [...nodes].map(([id, label]) => ({ id, label })), edges, supported };
}

function AssistantDiagram({ language, value }: { language: string; value: string }) {
  const preview = diagramPreview(value, language);
  const canPreview = preview.supported && preview.nodes.length >= 2 && preview.edges.length > 0;
  return (
    <figure className="assistant-rich-text__diagram" data-assistant-diagram>
      <div className="assistant-rich-text__diagram-header">
        <span className="assistant-rich-text__eyebrow">Diagram</span>
        <div className="assistant-rich-text__header-actions">
          <span className="assistant-rich-text__language">{language || 'source'}</span>
          <CopySourceButton value={value} label="diagram source" />
        </div>
      </div>
      {canPreview ? (
        <div className="assistant-rich-text__diagram-preview" aria-label="Diagram preview">
          {preview.nodes.map((node) => (
            <div className="assistant-rich-text__diagram-node" key={node.id}>
              <span className="assistant-rich-text__diagram-node-id">{node.id}</span>
              <span>{node.label}</span>
            </div>
          ))}
        </div>
      ) : null}
      <details className="assistant-rich-text__diagram-source" open>
        <summary>Source · {language || 'text'}</summary>
        <pre><code>{value}</code></pre>
      </details>
      {canPreview ? (
        <div className="assistant-rich-text__diagram-edges" aria-label="Diagram connections">
          {preview.edges.map((edge, index) => (
            <span key={`${edge.from}-${edge.to}-${index}`}>{edge.from} → {edge.to}</span>
          ))}
        </div>
      ) : null}
    </figure>
  );
}

function AssistantSnippet({ language, value }: { language: string; value: string }) {
  const isWriting = !language || PLAIN_SNIPPET_LANGUAGES.has(language);
  const label = isWriting ? 'Writing' : language;
  return (
    <figure
      className={cn(
        'assistant-rich-text__snippet',
        isWriting ? 'assistant-rich-text__snippet--writing' : 'assistant-rich-text__snippet--code',
      )}
      data-assistant-code
      data-assistant-snippet={isWriting ? 'writing' : language}
    >
      <div className="assistant-rich-text__snippet-header">
        <span className="assistant-rich-text__snippet-label">{label}</span>
        <CopySourceButton value={value} label={isWriting ? 'text' : 'code'} iconOnly />
      </div>
      <pre><code>{value}</code></pre>
    </figure>
  );
}

function CopySourceButton({ value, label, iconOnly = false }: { value: string; label: string; iconOnly?: boolean }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      if (!navigator.clipboard?.writeText) return;
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1_400);
    } catch {
      // Clipboard permission is optional; the source remains visible and scrollable.
    }
  };

  return (
    <button
      type="button"
      className={cn('assistant-rich-text__copy', iconOnly && 'assistant-rich-text__copy--icon')}
      aria-label={copied ? `Copied ${label}` : `Copy ${label}`}
      title={copied ? `Copied ${label}` : `Copy ${label}`}
      onClick={copy}
    >
      {iconOnly ? (
        copied ? (
          <svg aria-hidden="true" viewBox="0 0 16 16" focusable="false">
            <path d="m3.25 8.25 3 3 6.5-6.5" />
          </svg>
        ) : (
          <svg aria-hidden="true" viewBox="0 0 16 16" focusable="false">
            <rect x="5.25" y="2.75" width="8" height="9.5" rx="1.5" />
            <path d="M10.75 12.25v.5a1.5 1.5 0 0 1-1.5 1.5h-6a1.5 1.5 0 0 1-1.5-1.5v-8a1.5 1.5 0 0 1 1.5-1.5h1" />
          </svg>
        )
      ) : copied ? 'Copied' : 'Copy'}
    </button>
  );
}

function AssistantTable({ headers, rows }: { headers: string[]; rows: string[][] }) {
  const columnCount = Math.max(headers.length, ...rows.map((row) => row.length));
  return (
    <div className="assistant-rich-text__table-wrap" data-assistant-table>
      <table className="assistant-rich-text__table">
        <thead>
          <tr>
            {Array.from({ length: columnCount }, (_, index) => (
              <th key={`header-${index}`}>{renderInline(headers[index] ?? '', `header-${index}`)}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, rowIndex) => (
            <tr key={`row-${rowIndex}`}>
              {Array.from({ length: columnCount }, (_, columnIndex) => (
                <td key={`cell-${rowIndex}-${columnIndex}`}>
                  {renderInline(row[columnIndex] ?? '', `cell-${rowIndex}-${columnIndex}`)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export interface AssistantRichTextProps {
  /** The model-authored text. It is rendered as text and is never evaluated as HTML. */
  text: string;
  /** Adds a restrained live-state shimmer for streaming previews. */
  live?: boolean;
  className?: string;
}

export function AssistantRichText({ text, live = false, className }: AssistantRichTextProps) {
  const blocks = useMemo(() => parseAssistantBlocks(text), [text]);
  if (!text) return null;

  return (
    <div
      className={cn('assistant-rich-text', live && 'assistant-rich-text--live', className)}
      data-assistant-rich-text="true"
      data-assistant-rich-text-live={live ? 'true' : undefined}
    >
      {blocks.map((block, index) => {
        const key = `assistant-block-${index}`;
        switch (block.kind) {
          case 'paragraph':
            return <p className="assistant-rich-text__paragraph" key={key}>{renderLines(block.lines, key)}</p>;
          case 'heading': {
            const Heading = `h${block.level}` as 'h1' | 'h2' | 'h3';
            return <Heading className={cn('assistant-rich-text__heading', `assistant-rich-text__heading--${block.level}`)} key={key}>{renderInline(block.text, key)}</Heading>;
          }
          case 'list':
            return (
              <ul className="assistant-rich-text__list" key={key} data-assistant-list>
                {block.items.map((item, itemIndex) => (
                  <li
                    className="assistant-rich-text__list-item"
                    data-depth={item.depth}
                    key={`${key}-${itemIndex}`}
                    style={{ '--assistant-list-depth': item.depth } as CSSProperties}
                  >
                    <span className="assistant-rich-text__list-marker" aria-hidden="true">
                      {item.ordered ? item.marker : '•'}
                    </span>
                    <span>{renderInline(item.text, `${key}-${itemIndex}`)}</span>
                  </li>
                ))}
              </ul>
            );
          case 'quote':
            return <blockquote className="assistant-rich-text__quote" key={key}>{renderLines(block.lines, key)}</blockquote>;
          case 'code':
            return <AssistantSnippet key={key} language={block.language} value={block.value} />;
          case 'diagram':
            return <AssistantDiagram key={key} language={block.language} value={block.value} />;
          case 'table':
            return <AssistantTable key={key} headers={block.headers} rows={block.rows} />;
          case 'rule':
            return <hr className="assistant-rich-text__rule" key={key} />;
        }
      })}
    </div>
  );
}
