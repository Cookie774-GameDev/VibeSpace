import type { CodexDiscoveredSkill } from '@/lib/ai/adapters/codexAppServerProtocol';

export interface NativeSkillMention {
  /** Start of `$` in the source string. */
  start: number;
  /** Exclusive end of the whole skill-name token, including text after the caret. */
  end: number;
  /** Skill-name prefix between `$` and the caret. */
  query: string;
  /** Caret position used to derive the prefix. */
  caret: number;
}

const WORD_CHARACTER = /[\p{L}\p{N}_]/u;
const SKILL_NAME_CHARACTER = /[\p{L}\p{N}._-]/u;
const VALID_SKILL_NAME = /^[\p{L}\p{N}][\p{L}\p{N}._-]*$/u;

function isEscaped(text: string, index: number): boolean {
  let slashes = 0;
  for (let cursor = index - 1; cursor >= 0 && text[cursor] === '\\'; cursor -= 1) slashes += 1;
  return slashes % 2 === 1;
}

function isInsideCodeSpan(text: string, index: number): boolean {
  let delimiterLength = 0;
  for (let cursor = 0; cursor < index; ) {
    if (text[cursor] !== '`' || isEscaped(text, cursor)) {
      cursor += 1;
      continue;
    }
    let end = cursor + 1;
    while (end < index && text[end] === '`') end += 1;
    const runLength = end - cursor;
    if (delimiterLength === 0) delimiterLength = runLength;
    else if (runLength === delimiterLength) delimiterLength = 0;
    cursor = end;
  }
  return delimiterLength > 0;
}

export function parseNativeSkillMention(text: string, caret: number): NativeSkillMention | null {
  if (!Number.isSafeInteger(caret) || caret < 0 || caret > text.length) return null;
  for (
    let start = text.lastIndexOf('$', caret - 1);
    start >= 0;
    start = text.lastIndexOf('$', start - 1)
  ) {
    if (isEscaped(text, start) || isInsideCodeSpan(text, start)) continue;
    const before = text[start - 1];
    if (before && (WORD_CHARACTER.test(before) || before === '$')) continue;

    let end = start + 1;
    while (end < text.length && SKILL_NAME_CHARACTER.test(text[end])) end += 1;
    const firstNameCharacter = text[start + 1];
    if (
      (firstNameCharacter && /\p{N}/u.test(firstNameCharacter)) ||
      text[start + 1] === '$' ||
      caret < start + 1 ||
      caret > end ||
      ![...text.slice(start + 1, caret)].every((character) =>
        SKILL_NAME_CHARACTER.test(character),
      ) ||
      (caret === end && text[end] && !/\s/u.test(text[end]) && !/[),.;!?]/u.test(text[end]))
    ) {
      continue;
    }
    return { start, end, query: text.slice(start + 1, caret), caret };
  }
  return null;
}

export function nativeSkillSelectionKey(skill: CodexDiscoveredSkill): string {
  return JSON.stringify([skill.cwd, skill.path, skill.name]);
}

export function replaceNativeSkillMention(
  text: string,
  mention: NativeSkillMention,
  skill: CodexDiscoveredSkill,
): { text: string; caret: number } {
  if (!skill.enabled) throw new Error('Cannot insert a disabled Codex skill.');
  if (!VALID_SKILL_NAME.test(skill.name)) throw new Error('Codex returned an invalid skill name.');
  if (
    !Number.isSafeInteger(mention.start) ||
    !Number.isSafeInteger(mention.end) ||
    mention.start < 0 ||
    mention.end < mention.start ||
    mention.end > text.length ||
    text[mention.start] !== '$'
  ) {
    throw new Error('The Codex skill mention is stale or invalid.');
  }

  const insertion = `$${skill.name}${mention.end === text.length ? ' ' : ''}`;
  const nextText = text.slice(0, mention.start) + insertion + text.slice(mention.end);
  return { text: nextText, caret: mention.start + insertion.length };
}
