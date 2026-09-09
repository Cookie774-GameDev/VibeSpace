export type JarvisDisplayLinkSyntax = 'markdown' | 'bare';

export interface JarvisDisplayLink {
  start: number;
  end: number;
  target: string;
  syntax: JarvisDisplayLinkSyntax;
}

interface JarvisReferenceDefinition extends JarvisDisplayLink {
  label: string;
}

function escapedAt(text: string, index: number): boolean {
  let backslashes = 0;
  for (let cursor = index - 1; cursor >= 0 && text[cursor] === '\\'; cursor -= 1) {
    backslashes += 1;
  }
  return backslashes % 2 === 1;
}

function markdownLabelEnd(text: string, labelStart: number): number {
  let depth = 1;
  for (let cursor = labelStart + 1; cursor < text.length; cursor += 1) {
    if (escapedAt(text, cursor)) continue;
    const character = text[cursor];
    if (character === '\n' || character === '\r') return -1;
    if (character === '[') depth += 1;
    if (character !== ']') continue;
    depth -= 1;
    if (depth === 0) return cursor;
  }
  return -1;
}

function quotedTitleEnd(text: string, start: number, quote: string): number {
  for (let cursor = start + 1; cursor < text.length; cursor += 1) {
    if (text[cursor] === '\n' || text[cursor] === '\r') return -1;
    if (text[cursor] === quote && !escapedAt(text, cursor)) return cursor + 1;
  }
  return -1;
}

function parenthesizedTitleEnd(text: string, start: number): number {
  let depth = 1;
  for (let cursor = start + 1; cursor < text.length; cursor += 1) {
    if (escapedAt(text, cursor)) continue;
    const character = text[cursor];
    if (character === '\n' || character === '\r') return -1;
    if (character === '(') depth += 1;
    if (character !== ')') continue;
    depth -= 1;
    if (depth === 0) return cursor + 1;
  }
  return -1;
}

function skipHorizontalWhitespace(text: string, start: number): number {
  let cursor = start;
  while (text[cursor] === ' ' || text[cursor] === '\t') cursor += 1;
  return cursor;
}

function unescapeMarkdownTarget(target: string): string {
  return target.replace(/\\([\\()[\]{}<>])/g, '$1');
}

function normalizedReferenceLabel(label: string): string {
  return label.trim().replace(/\s+/gu, ' ').toLowerCase();
}

function markdownLinkAt(text: string, labelStart: number): JarvisDisplayLink | undefined {
  const labelEnd = markdownLabelEnd(text, labelStart);
  if (labelEnd < 0 || text[labelEnd + 1] !== '(') return undefined;
  const opening = labelEnd + 1;
  let cursor = skipHorizontalWhitespace(text, opening + 1);
  let targetStart = cursor;
  let targetEnd = -1;

  if (text[cursor] === '<') {
    targetStart = cursor + 1;
    cursor += 1;
    while (
      cursor < text.length &&
      text[cursor] !== '>' &&
      text[cursor] !== '\n' &&
      text[cursor] !== '\r'
    ) {
      cursor += 1;
    }
    if (text[cursor] !== '>') return undefined;
    targetEnd = cursor;
    cursor += 1;
  } else {
    let depth = 0;
    for (; cursor < text.length; cursor += 1) {
      if (escapedAt(text, cursor)) continue;
      const character = text[cursor];
      if (character === '\n' || character === '\r') return undefined;
      if (character === '(') {
        depth += 1;
        continue;
      }
      if (character === ')') {
        if (depth === 0) {
          targetEnd = cursor;
          break;
        }
        depth -= 1;
        continue;
      }
      if ((character === ' ' || character === '\t') && depth === 0) {
        targetEnd = cursor;
        break;
      }
    }
  }

  if (targetEnd <= targetStart) return undefined;
  cursor = skipHorizontalWhitespace(text, cursor);
  if (text[cursor] !== ')') {
    const titleStart = cursor;
    const quote = text[titleStart];
    const titleEnd =
      quote === '"' || quote === "'"
        ? quotedTitleEnd(text, titleStart, quote)
        : quote === '('
          ? parenthesizedTitleEnd(text, titleStart)
          : -1;
    if (titleEnd < 0) return undefined;
    cursor = skipHorizontalWhitespace(text, titleEnd);
  }
  if (text[cursor] !== ')') return undefined;

  const regionStart = text[labelStart - 1] === '!' ? labelStart - 1 : labelStart;
  return Object.freeze({
    start: regionStart,
    end: cursor + 1,
    target: unescapeMarkdownTarget(text.slice(targetStart, targetEnd)),
    syntax: 'markdown',
  });
}

function isLinkBoundary(character: string | undefined): boolean {
  return character === undefined || /[\s([{"'`<>]/u.test(character);
}

function trimBareLinkEnd(text: string, start: number, end: number): number {
  let trimmed = end;
  while (trimmed > start && /[.,;:!?]/u.test(text[trimmed - 1] ?? '')) trimmed -= 1;
  return trimmed;
}

function bareLinkEnd(text: string, start: number): number {
  const delimiters: string[] = [];
  let cursor = start;
  while (cursor < text.length) {
    const character = text[cursor]!;
    if (/[\s<>"'`]/u.test(character)) break;
    const closing = { '(': ')', '[': ']', '{': '}' }[character];
    if (closing) {
      delimiters.push(closing);
      cursor += 1;
      continue;
    }
    if (character === ')' || character === ']' || character === '}') {
      if (delimiters.at(-1) !== character) break;
      delimiters.pop();
    }
    cursor += 1;
  }
  return trimBareLinkEnd(text, start, cursor);
}

function overlaps(links: readonly JarvisDisplayLink[], start: number, end: number): boolean {
  return links.some((link) => start < link.end && end > link.start);
}

function validDefinitionTitle(value: string): boolean {
  if (!value) return true;
  const first = value[0];
  const last = value.at(-1);
  return ((first === '"' || first === "'") && last === first) || (first === '(' && last === ')');
}

function referenceDefinitions(text: string): readonly JarvisReferenceDefinition[] {
  const definitions: JarvisReferenceDefinition[] = [];
  const prefix = /^[ \t]{0,3}\[([^\]\r\n]+)\]:[ \t]*/gmu;
  for (const match of text.matchAll(prefix)) {
    const lineStart = match.index ?? 0;
    const labelStart = lineStart + match[0].indexOf('[');
    const lineBreak = text.indexOf('\n', lineStart);
    const lineEnd = lineBreak < 0 ? text.length : lineBreak;
    let cursor = lineStart + match[0].length;
    let targetStart = cursor;
    let targetEnd = -1;

    if (text[cursor] === '<') {
      targetStart = cursor + 1;
      cursor += 1;
      while (cursor < lineEnd && text[cursor] !== '>') cursor += 1;
      if (text[cursor] !== '>') continue;
      targetEnd = cursor;
      cursor += 1;
    } else {
      let depth = 0;
      for (; cursor < lineEnd; cursor += 1) {
        if (escapedAt(text, cursor)) continue;
        const character = text[cursor];
        if (character === '(') {
          depth += 1;
          continue;
        }
        if (character === ')' && depth > 0) {
          depth -= 1;
          continue;
        }
        if ((character === ' ' || character === '\t') && depth === 0) break;
      }
      targetEnd = cursor;
    }

    if (targetEnd <= targetStart) continue;
    const title = text.slice(skipHorizontalWhitespace(text, cursor), lineEnd).trim();
    if (!validDefinitionTitle(title)) continue;
    definitions.push(
      Object.freeze({
        start: labelStart,
        end: lineEnd,
        target: unescapeMarkdownTarget(text.slice(targetStart, targetEnd)),
        syntax: 'markdown' as const,
        label: normalizedReferenceLabel(match[1] ?? ''),
      }),
    );
  }
  return Object.freeze(definitions);
}

function addReferenceUsages(
  text: string,
  links: JarvisDisplayLink[],
  definitions: readonly JarvisReferenceDefinition[],
): void {
  const targets = new Map<string, string>();
  for (const definition of definitions) {
    if (definition.label && !targets.has(definition.label)) {
      targets.set(definition.label, definition.target);
    }
  }

  const full = /!?\[([^\]\r\n]+)\]\[([^\]\r\n]*)\]/gu;
  for (const match of text.matchAll(full)) {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    if (overlaps(links, start, end)) continue;
    const label = normalizedReferenceLabel(match[2] || match[1] || '');
    const target = targets.get(label);
    if (!target) continue;
    links.push(Object.freeze({ start, end, target, syntax: 'markdown' as const }));
  }

  const shortcut = /!?\[([^\]\r\n]+)\]/gu;
  for (const match of text.matchAll(shortcut)) {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    if (overlaps(links, start, end)) continue;
    const target = targets.get(normalizedReferenceLabel(match[1] ?? ''));
    if (!target) continue;
    links.push(Object.freeze({ start, end, target, syntax: 'markdown' as const }));
  }
}

export function findJarvisDisplayLinks(text: string): readonly JarvisDisplayLink[] {
  const definitions = referenceDefinitions(text);
  const links: JarvisDisplayLink[] = [...definitions];
  for (let cursor = 0; cursor < text.length; cursor += 1) {
    if (text[cursor] !== '[') continue;
    const link = markdownLinkAt(text, cursor);
    if (!link || overlaps(links, link.start, link.end)) continue;
    links.push(link);
    cursor = link.end - 1;
  }

  addReferenceUsages(text, links, definitions);

  const candidate = /(?:https?:\/\/|www\.|[A-Za-z][A-Za-z0-9+.-]{1,31}:)/giu;
  for (const match of text.matchAll(candidate)) {
    const start = match.index ?? 0;
    if (!isLinkBoundary(text[start - 1])) continue;
    const prefix = match[0];
    const firstPayload = text[start + prefix.length];
    // A field label followed only by closing Markdown emphasis is not a URI.
    // Keep real scheme payloads (including unsafe ones) subject to link policy.
    if (/^(?:\*{1,2}|_{1,2})(?=\s|$)/u.test(text.slice(start + prefix.length))) continue;
    if (
      !prefix.toLowerCase().endsWith('//') &&
      prefix.toLowerCase() !== 'www.' &&
      (firstPayload === undefined || /\s/u.test(firstPayload))
    ) {
      continue;
    }
    const end = bareLinkEnd(text, start);
    if (end <= start + prefix.length || overlaps(links, start, end)) continue;
    links.push(
      Object.freeze({
        start,
        end,
        target: text.slice(start, end),
        syntax: 'bare' as const,
      }),
    );
  }

  links.sort((left, right) => left.start - right.start || left.end - right.end);
  return Object.freeze(links);
}

export function jarvisDisplayLinkTargets(text: string): readonly string[] {
  return Object.freeze(findJarvisDisplayLinks(text).map((link) => link.target));
}
