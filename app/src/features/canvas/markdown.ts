import { CANVAS_MAX_TEXT_LENGTH, CanvasValidationError, pageOrderedBlocks } from './contracts';
import type { CanvasBlock, CanvasBlockContent, CanvasDocument } from './contracts';

export const CANVAS_MARKDOWN_MAX_SOURCE_LENGTH = 1_000_000;
export const CANVAS_MARKDOWN_MAX_BLOCKS = 10_000;
export const CANVAS_MARKDOWN_MAX_FENCE_LENGTH = 64;

const CODE_LANGUAGE_PATTERN = /^[A-Za-z0-9+#.-]{1,32}$/;

const TAB = String.fromCharCode(9);
const LF = String.fromCharCode(10);
const CR = String.fromCharCode(13);
const BACKSLASH = String.fromCharCode(92);
const BACKTICK = String.fromCharCode(96);

function hasControlChar(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (
      (code >= 0x00 && code <= 0x08) ||
      code === 0x0b ||
      code === 0x0c ||
      (code >= 0x0e && code <= 0x1f) ||
      code === 0x7f
    ) {
      return true;
    }
  }
  return false;
}

function hasBidiChar(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if ((code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069)) {
      return true;
    }
  }
  return false;
}

function onlySpacesOrTabs(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i];
    if (ch !== ' ' && ch !== TAB) {
      return false;
    }
  }
  return true;
}

function readHeading(line: string): { level: 1 | 2 | 3 | 4 | 5 | 6; text: string } | null {
  if (line[0] !== '#') {
    return null;
  }
  let level = 0;
  while (level < line.length && line[level] === '#') {
    level += 1;
  }
  if (level > 6) {
    return null;
  }
  if (level === line.length) {
    return { level: level as 1 | 2 | 3 | 4 | 5 | 6, text: '' };
  }
  const after = line[level];
  if (after !== ' ' && after !== TAB) {
    return null;
  }
  return { level: level as 1 | 2 | 3 | 4 | 5 | 6, text: line.slice(level + 1).trim() };
}

function readFenceMarker(line: string): { char: string; len: number; info: string } | null {
  const ch = line[0];
  if (ch !== BACKTICK && ch !== '~') {
    return null;
  }
  let len = 0;
  while (len < line.length && line[len] === ch) {
    len += 1;
  }
  if (len < 3) {
    return null;
  }
  return { char: ch, len, info: line.slice(len).trim() };
}

function isFenceClose(line: string, fenceChar: string, fenceLen: number): boolean {
  let count = 0;
  while (count < line.length && line[count] === fenceChar) {
    count += 1;
  }
  if (count < fenceLen) {
    return false;
  }
  return onlySpacesOrTabs(line.slice(count));
}

function longestBacktickRun(value: string): number {
  let longest = 0;
  let current = 0;
  for (let i = 0; i < value.length; i += 1) {
    if (value[i] === BACKTICK) {
      current += 1;
      if (current > longest) {
        longest = current;
      }
    } else {
      current = 0;
    }
  }
  return longest;
}

function needsTextEscape(line: string): boolean {
  if (line === '') {
    return true;
  }
  const code = line.charCodeAt(0);
  return (
    code === 92 || code === 35 || code === 62 || code === 96 || code === 126 || line.trim() === ''
  );
}

function escapeTextLine(line: string): string {
  if (line === '') {
    return BACKSLASH;
  }
  if (needsTextEscape(line)) {
    return BACKSLASH + line;
  }
  return line;
}

function validateText(text: unknown, path: string): string {
  if (typeof text !== 'string') {
    throw new CanvasValidationError('invalid-type', path, 'text must be a string');
  }
  if (text.length > CANVAS_MAX_TEXT_LENGTH) {
    throw new CanvasValidationError('unsupported-value', path, 'text exceeds the maximum length');
  }
  if (hasControlChar(text) || hasBidiChar(text)) {
    throw new CanvasValidationError(
      'unsupported-value',
      path,
      'text contains unsupported control characters',
    );
  }
  return text;
}

function pushBlock(blocks: CanvasBlockContent[], content: CanvasBlockContent): void {
  if (blocks.length >= CANVAS_MARKDOWN_MAX_BLOCKS) {
    throw new CanvasValidationError('unsupported-value', 'source', 'too many blocks');
  }
  if (
    content.kind === 'mind-map' ||
    content.kind === 'shape' ||
    content.kind === 'stroke' ||
    content.kind === 'image'
  ) {
    throw new CanvasValidationError(
      'unsupported-value',
      'source',
      'markdown cannot create structured canvas payloads',
    );
  }
  if (content.text.length > CANVAS_MAX_TEXT_LENGTH) {
    throw new CanvasValidationError(
      'unsupported-value',
      'source',
      'block text exceeds the maximum length',
    );
  }
  blocks.push(Object.freeze(content));
}

export function parseMarkdownToBlockContents(source: string): readonly CanvasBlockContent[] {
  if (typeof source !== 'string') {
    throw new CanvasValidationError('invalid-type', 'source', 'source must be a string');
  }
  if (source.length > CANVAS_MARKDOWN_MAX_SOURCE_LENGTH) {
    throw new CanvasValidationError(
      'unsupported-value',
      'source',
      'source exceeds the maximum length',
    );
  }
  if (hasControlChar(source)) {
    throw new CanvasValidationError(
      'unsupported-value',
      'source',
      'source contains control characters',
    );
  }
  if (hasBidiChar(source)) {
    throw new CanvasValidationError(
      'unsupported-value',
      'source',
      'source contains bidirectional control characters',
    );
  }

  const normalized = source
    .split(CR + LF)
    .join(LF)
    .split(CR)
    .join(LF);
  const lines = normalized.split(LF);
  const blocks: CanvasBlockContent[] = [];
  let paragraph: string[] = [];
  let quote: string[] = [];

  const flushParagraph = (): void => {
    if (paragraph.length === 0) {
      return;
    }
    pushBlock(blocks, { kind: 'text', text: paragraph.join(LF) });
    paragraph = [];
  };
  const flushQuote = (): void => {
    if (quote.length === 0) {
      return;
    }
    pushBlock(blocks, { kind: 'note', text: quote.join(LF) });
    quote = [];
  };
  const flushAll = (): void => {
    flushParagraph();
    flushQuote();
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith(BACKSLASH)) {
      flushQuote();
      paragraph.push(line.slice(1));
      i += 1;
      continue;
    }
    if (line.trim() === '') {
      flushAll();
      i += 1;
      continue;
    }
    const heading = readHeading(line);
    if (heading !== null) {
      flushAll();
      pushBlock(blocks, { kind: 'heading', level: heading.level, text: heading.text });
      i += 1;
      continue;
    }
    const fence = readFenceMarker(line);
    if (fence !== null) {
      flushAll();
      if (fence.len > CANVAS_MARKDOWN_MAX_FENCE_LENGTH) {
        throw new CanvasValidationError(
          'unsupported-value',
          'source',
          'code fence marker is too long',
        );
      }
      if (fence.info.includes(BACKTICK)) {
        throw new CanvasValidationError(
          'unsupported-value',
          'source',
          'code fence info cannot contain backticks',
        );
      }
      const language = fence.info === '' ? 'text' : fence.info;
      if (!CODE_LANGUAGE_PATTERN.test(language)) {
        throw new CanvasValidationError('unsupported-value', 'source', 'invalid code language');
      }
      const body: string[] = [];
      let j = i + 1;
      let closed = false;
      while (j < lines.length) {
        if (isFenceClose(lines[j], fence.char, fence.len)) {
          closed = true;
          break;
        }
        body.push(lines[j]);
        j += 1;
      }
      if (!closed) {
        throw new CanvasValidationError('unsupported-value', 'source', 'unclosed code fence');
      }
      pushBlock(blocks, { kind: 'code', language, text: body.join(LF) });
      i = j + 1;
      continue;
    }
    if (line.startsWith('>')) {
      flushParagraph();
      let rest = line.slice(1);
      if (rest.startsWith(' ')) {
        rest = rest.slice(1);
      }
      quote.push(rest);
      i += 1;
      continue;
    }
    flushQuote();
    paragraph.push(line);
    i += 1;
  }

  flushAll();
  return Object.freeze(blocks);
}

function exportHeading(block: Extract<CanvasBlockContent, { kind: 'heading' }>): string {
  const level = block.level;
  if (!Number.isInteger(level) || level < 1 || level > 6) {
    throw new CanvasValidationError(
      'unsupported-value',
      'level',
      'heading level must be between 1 and 6',
    );
  }
  const text = validateText(block.text, 'text');
  if (text.includes(LF) || text.includes(CR)) {
    throw new CanvasValidationError(
      'unsupported-value',
      'text',
      'heading text cannot contain newlines',
    );
  }
  if (text === '') {
    return '#'.repeat(level);
  }
  return '#'.repeat(level) + ' ' + text;
}

function exportText(block: Extract<CanvasBlockContent, { kind: 'text' }>): string {
  const text = validateText(block.text, 'text');
  return text.split(LF).map(escapeTextLine).join(LF);
}

function exportNote(block: Extract<CanvasBlockContent, { kind: 'note' }>): string {
  const text = validateText(block.text, 'text');
  return text
    .split(LF)
    .map((line) => (line === '' ? '>' : '> ' + line))
    .join(LF);
}

function exportCode(block: Extract<CanvasBlockContent, { kind: 'code' }>): string {
  const language = block.language;
  if (typeof language !== 'string' || !CODE_LANGUAGE_PATTERN.test(language)) {
    throw new CanvasValidationError('unsupported-value', 'language', 'invalid code language');
  }
  const text = validateText(block.text, 'text');
  const fenceLen = Math.max(3, longestBacktickRun(text) + 1);
  const fence = BACKTICK.repeat(fenceLen);
  if (text === '') {
    return fence + language + LF + fence;
  }
  return fence + language + LF + text + LF + fence;
}

function exportBlockContent(block: CanvasBlockContent): string {
  switch (block.kind) {
    case 'heading':
      return exportHeading(block);
    case 'text':
      return exportText(block);
    case 'note':
      return exportNote(block);
    case 'code':
      return exportCode(block);
    default:
      throw new CanvasValidationError('invalid-type', 'kind', 'unknown block kind');
  }
}

export function exportBlockContentsToMarkdown(blocks: readonly CanvasBlockContent[]): string {
  if (!Array.isArray(blocks)) {
    throw new CanvasValidationError('invalid-type', 'blocks', 'blocks must be an array');
  }
  if (blocks.length > CANVAS_MARKDOWN_MAX_BLOCKS) {
    throw new CanvasValidationError('unsupported-value', 'blocks', 'too many blocks');
  }
  const parts: string[] = [];
  for (const block of blocks) {
    parts.push(exportBlockContent(block));
  }
  return parts.join(LF + LF);
}

export function exportCanvasBlocksToMarkdown(blocks: readonly CanvasBlock[]): string {
  if (!Array.isArray(blocks)) {
    throw new CanvasValidationError('invalid-type', 'blocks', 'blocks must be an array');
  }
  return exportBlockContentsToMarkdown(blocks.map((block) => block.content));
}

export function exportCanvasDocumentToMarkdown(doc: CanvasDocument): string {
  const value = doc as unknown;
  if (
    typeof value !== 'object' ||
    value === null ||
    !Array.isArray((value as CanvasDocument).blocks)
  ) {
    throw new CanvasValidationError(
      'invalid-type',
      'document',
      'document must be an object with blocks',
    );
  }
  return exportCanvasBlocksToMarkdown(pageOrderedBlocks(doc));
}
