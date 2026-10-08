// @ts-nocheck
import type { LocalDetectedCommand, LocalRouteResult, LocalTextSpan } from './types';
import {
  ACTION_SYNONYMS,
  COLOR_ALIASES,
  COMMANDS,
  CONTENT_MEDIATORS,
  DIRECT_COMMANDS,
  CORRECTION_MARKERS,
  DISCOURSE_MARKERS,
  FAMILY_TERMS,
  FILLER_WORDS,
  NEGATION_PREFIXES,
  PAGE_ALIASES,
  POLITE_PREFIXES,
  PROVIDER_ALIASES,
} from './registry';

const WORD_RE = /[a-z0-9]+(?:'[a-z0-9]+)?/giu;
const CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;
const MAX_INPUT = 200_000;
const MAX_CLAUSES = 512;
const MAX_DELETE_KEYS = 200_000;

function normalizeApostrophes(value) {
  return value.replace(/[\u2018\u2019]/gu, "'");
}

export function normalize(value: unknown): string {
  return normalizeApostrophes(String(value ?? ''))
    .toLowerCase()
    .replace(/[^a-z0-9']+/gu, ' ')
    .trim()
    .replace(/\s+/gu, ' ');
}

function phraseWords(value) {
  return normalize(value).match(/[a-z0-9]+(?:'[a-z0-9]+)?/gu) ?? [];
}

function edits(word, distance) {
  const out = new Set();
  let frontier = new Set([word]);
  for (let depth = 0; depth < distance; depth += 1) {
    const next = new Set();
    for (const candidate of frontier) {
      for (let i = 0; i < candidate.length; i += 1) {
        const deleted = candidate.slice(0, i) + candidate.slice(i + 1);
        if (deleted.length >= 2 && !out.has(deleted)) {
          out.add(deleted);
          next.add(deleted);
          if (out.size >= MAX_DELETE_KEYS) return out;
        }
      }
    }
    frontier = next;
  }
  return out;
}

function levenshtein(a, b, max = 3) {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  const cur = new Array(b.length + 1);
  for (let i = 1; i <= a.length; i += 1) {
    cur[0] = i;
    let rowMin = cur[0];
    for (let j = 1; j <= b.length; j += 1) {
      cur[j] = Math.min(cur[j - 1] + 1, prev[j] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      rowMin = Math.min(rowMin, cur[j]);
    }
    if (rowMin > max) return max + 1;
    for (let j = 0; j <= b.length; j += 1) prev[j] = cur[j];
  }
  return prev[b.length];
}

function collectLexicon() {
  const words = new Map();
  const add = (phrase, weight = 1) => {
    for (const word of phraseWords(phrase)) {
      if (word.length < 3) continue;
      words.set(word, (words.get(word) ?? 0) + weight);
    }
  };
  for (const command of COMMANDS) for (const alias of command.aliases) add(alias, 5);
  // Keep the broad direct-command catalog out of the fuzzy typo dictionary.
  // Direct aliases are matched data-first below; fuzzy expansion here would
  // make every long prompt pay for dozens of low-value command nouns.
  for (const phrases of Object.values(ACTION_SYNONYMS))
    for (const phrase of phrases) add(phrase, 5);
  for (const phrases of Object.values(FAMILY_TERMS)) for (const phrase of phrases) add(phrase, 4);
  for (const phrases of Object.values(PROVIDER_ALIASES))
    for (const phrase of phrases) add(phrase, 7);
  for (const phrases of Object.values(COLOR_ALIASES)) for (const phrase of phrases) add(phrase, 4);
  for (const phrases of Object.values(PAGE_ALIASES)) for (const phrase of phrases) add(phrase, 4);
  return words;
}

const LEXICON = collectLexicon();
// Frequency can rank spelling variants, but cannot choose between intents.
// Group synonyms so equally close words such as claude/cloude remain safe.
const WORD_MEANINGS = new Map();
for (const [category, groups] of Object.entries({
  action: ACTION_SYNONYMS,
  family: FAMILY_TERMS,
  provider: PROVIDER_ALIASES,
  color: COLOR_ALIASES,
  page: PAGE_ALIASES,
})) {
  for (const [meaning, phrases] of Object.entries(groups)) {
    for (const phrase of phrases) {
      for (const word of phraseWords(phrase)) {
        const meanings = WORD_MEANINGS.get(word) ?? new Set();
        meanings.add(`${category}:${meaning}`);
        WORD_MEANINGS.set(word, meanings);
      }
    }
  }
}
function wordMeaning(word) {
  return [...(WORD_MEANINGS.get(word) ?? [word])].sort().join('|');
}
const DELETE_INDEX = new Map();
for (const word of LEXICON.keys()) {
  const distance = word.length >= 7 ? 2 : 1;
  for (const key of edits(word, distance)) {
    const bucket = DELETE_INDEX.get(key) ?? [];
    bucket.push(word);
    DELETE_INDEX.set(key, bucket);
  }
}

const EXACT_ALIAS_INDEX = new Map();
for (const command of [...COMMANDS, ...DIRECT_COMMANDS]) {
  for (const alias of command.aliases) EXACT_ALIAS_INDEX.set(normalize(alias), command);
}

const TYPO_CACHE = new Map();
function typoCandidate(token) {
  if (TYPO_CACHE.has(token)) return TYPO_CACHE.get(token);
  const result = uncachedTypoCandidate(token);
  if (token.length <= 64) {
    if (TYPO_CACHE.size >= 2048) TYPO_CACHE.clear();
    TYPO_CACHE.set(token, result);
  }
  return result;
}

function uncachedTypoCandidate(token) {
  if (LEXICON.has(token)) return { value: token, distance: 0, corrected: false };
  // These are different intents, not spelling variants of local actions.
  if (['clone', 'clothe', 'shop', 'plane', 'prose'].includes(token) || /^\d+$/u.test(token)) {
    return { value: token, distance: 0, corrected: false };
  }
  const transposed = [];
  for (let i = 0; i < token.length - 1; i += 1) {
    const swapped = token.slice(0, i) + token[i + 1] + token[i] + token.slice(i + 2);
    if (LEXICON.has(swapped)) transposed.push(swapped);
  }
  if (transposed.length === 1) {
    transposed.sort((a, b) => (LEXICON.get(b) ?? 0) - (LEXICON.get(a) ?? 0));
    return { value: transposed[0], distance: 1, corrected: true };
  }
  if (transposed.length > 1 || token.length <= 4) {
    return { value: token, distance: 0, corrected: false };
  }
  if (token.length <= 16) {
    const twoTranspositions = new Set();
    for (let i = 0; i < token.length - 1; i += 1) {
      const first = token.slice(0, i) + token[i + 1] + token[i] + token.slice(i + 2);
      for (let j = 0; j < first.length - 1; j += 1) {
        const second = first.slice(0, j) + first[j + 1] + first[j] + first.slice(j + 2);
        if (LEXICON.has(second)) twoTranspositions.add(second);
      }
    }
    if (twoTranspositions.size === 1) {
      return { value: [...twoTranspositions][0], distance: 2, corrected: true };
    }
    if (twoTranspositions.size > 1) return { value: token, distance: 0, corrected: false };
  }

  const candidates = new Set();
  if (DELETE_INDEX.has(token)) for (const c of DELETE_INDEX.get(token)) candidates.add(c);
  const distance = token.length >= 7 ? 2 : 1;
  for (const key of edits(token, distance)) {
    if (LEXICON.has(key)) candidates.add(key);
    for (const c of DELETE_INDEX.get(key) ?? []) candidates.add(c);
  }
  if (candidates.size === 0) return { value: token, distance: 0, corrected: false };
  let best = null;
  let nearestDistance = Infinity;
  const nearestMeanings = new Set();
  for (const candidate of candidates) {
    const maxDistance = Math.max(token.length, candidate.length) >= 7 ? 2 : 1;
    const d = levenshtein(token, candidate, maxDistance);
    if (d > maxDistance) continue;
    if (d < nearestDistance) {
      nearestDistance = d;
      nearestMeanings.clear();
    }
    if (d === nearestDistance) nearestMeanings.add(wordMeaning(candidate));
    const weight = LEXICON.get(candidate) ?? 0;
    const score = d * 100 - weight;
    if (
      !best ||
      d < best.distance ||
      (d === best.distance && score < best.score) ||
      (d === best.distance && score === best.score && candidate.length > best.value.length)
    ) {
      best = { value: candidate, distance: d, corrected: true, score };
    }
  }
  if (nearestMeanings.size > 1) {
    return {
      value: token, distance: 0, corrected: false, intentConflict: true,
      providerConflict: [...nearestMeanings].some((meaning) => meaning.includes('provider:')),
    };
  }
  return best
    ? { value: best.value, distance: best.distance, corrected: true }
    : { value: token, distance: 0, corrected: false };
}

function tokenize(text, baseOffset = 0, correct = true) {
  const source = normalizeApostrophes(text.toLowerCase());
  let originalStarts;
  let originalEnds;
  if (source.length !== text.length) {
    originalStarts = new Uint32Array(source.length);
    originalEnds = new Uint32Array(source.length);
    let foldedOffset = 0;
    let originalOffset = 0;
    for (const character of text) {
      const foldedEnd = foldedOffset + character.toLowerCase().length;
      originalStarts.fill(originalOffset, foldedOffset, foldedEnd);
      originalEnds.fill(originalOffset + character.length, foldedOffset, foldedEnd);
      foldedOffset = foldedEnd;
      originalOffset += character.length;
    }
  }
  const out = [];
  WORD_RE.lastIndex = 0;
  let match;
  while ((match = WORD_RE.exec(source))) {
    const raw = match[0];
    const correction = correct ? typoCandidate(raw) : { value: raw, distance: 0, corrected: false };
    out.push({
      raw,
      value: correction.value,
      corrected: correction.corrected,
      distance: correction.distance,
      intentConflict: correction.intentConflict === true,
      providerConflict: correction.providerConflict === true,
      start: baseOffset + (originalStarts?.[match.index] ?? match.index),
      end: baseOffset + (originalEnds?.[match.index + raw.length - 1] ?? match.index + raw.length),
    });
  }
  return out;
}

function phraseSequence(phrase) {
  return phraseWords(phrase).map((word) => typoCandidate(word).value);
}

const ACTION_SEQUENCES = new Map(
  Object.entries(ACTION_SYNONYMS).map(([action, phrases]) => [
    action,
    phrases.map((phrase) => phraseSequence(phrase)),
  ]),
);
const FAMILY_SEQUENCES = new Map(
  Object.entries(FAMILY_TERMS).map(([family, phrases]) => [
    family,
    phrases.map((phrase) => phraseSequence(phrase)),
  ]),
);
const PROVIDER_SEQUENCES = new Map(
  Object.entries(PROVIDER_ALIASES).map(([provider, phrases]) => [
    provider,
    phrases.map((phrase) => phraseSequence(phrase)),
  ]),
);
const COLOR_SEQUENCES = new Map(
  Object.entries(COLOR_ALIASES).map(([color, phrases]) => [
    color,
    phrases.map((phrase) => phraseSequence(phrase)),
  ]),
);
const PAGE_SEQUENCES = new Map(
  Object.entries(PAGE_ALIASES).map(([page, phrases]) => [
    page,
    phrases.map((phrase) => phraseSequence(phrase)),
  ]),
);
const DIRECT_ALIAS_SEQUENCES = Object.freeze(
  DIRECT_COMMANDS.flatMap((command) =>
    command.aliases.map((alias) =>
      Object.freeze({
        command,
        alias,
        sequence: phraseWords(alias),
      }),
    ),
  ).sort((left, right) => right.sequence.length - left.sequence.length),
);
const DIRECT_ALIASES_BY_FIRST = new Map();
for (const entry of DIRECT_ALIAS_SEQUENCES) {
  const first = entry.sequence[0];
  if (!first) continue;
  const bucket = DIRECT_ALIASES_BY_FIRST.get(first) ?? [];
  bucket.push(entry);
  DIRECT_ALIASES_BY_FIRST.set(first, bucket);
}

function directCandidatesForTokens(tokens) {
  const first = tokens[0]?.value;
  return first ? (DIRECT_ALIASES_BY_FIRST.get(first) ?? []) : [];
}

function sequenceAt(tokens, sequence, start) {
  if (start < 0 || start + sequence.length > tokens.length) return false;
  for (let i = 0; i < sequence.length; i += 1) {
    if (tokens[start + i].value !== sequence[i]) return false;
  }
  return true;
}

function findSequence(tokens, sequence, from = 0, to = tokens.length) {
  for (let i = from; i <= to - sequence.length; i += 1) {
    if (sequenceAt(tokens, sequence, i)) return i;
  }
  return -1;
}

function findAnySequence(tokens, sequenceGroups, from = 0, to = tokens.length) {
  let best = null;
  for (const [key, sequences] of sequenceGroups) {
    for (const sequence of sequences) {
      const index = findSequence(tokens, sequence, from, to);
      if (index < 0) continue;
      if (!best || index < best.index || (index === best.index && sequence.length > best.length)) {
        best = { key, index, length: sequence.length, sequence };
      }
    }
  }
  return best;
}

function allSequenceKeys(tokens, sequenceGroups) {
  const out = new Set();
  for (const [key, sequences] of sequenceGroups) {
    if (sequences.some((sequence) => findSequence(tokens, sequence) >= 0)) out.add(key);
  }
  return out;
}

function sentenceSpans(text) {
  const spans = [];
  let start = 0;
  const ranges = quoteRanges(text);
  let quoteIndex = 0;
  let escaped = false;
  const push = (end) => {
    const raw = text.slice(start, end);
    const left = raw.search(/\S/u);
    if (left >= 0) {
      const rightTrim = raw.length - raw.trimEnd().length;
      spans.push({
        start: start + left,
        end: end - rightTrim,
        text: text.slice(start + left, end - rightTrim),
      });
    }
    start = end;
  };

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    while (quoteIndex < ranges.length && i >= ranges[quoteIndex].end) quoteIndex += 1;
    if (quoteIndex < ranges.length && i >= ranges[quoteIndex].start) continue;
    if (ch === '.' || ch === '!' || ch === '?' || ch === ';' || ch === '\n') {
      if (ch === '.' && /\d/u.test(text[i - 1] ?? '') && /\d/u.test(text[i + 1] ?? '')) {
        continue;
      }
      push(i + 1);
    }
  }
  if (start < text.length) push(text.length);
  return spans.slice(0, MAX_CLAUSES);
}

function directAliasStarts(normalized) {
  const firstSpace = normalized.indexOf(' ');
  const first = firstSpace < 0 ? normalized : normalized.slice(0, firstSpace);
  const candidates = DIRECT_ALIASES_BY_FIRST.get(first) ?? [];
  return candidates.some((entry) => {
    const alias = entry.sequence.join(' ');
    return normalized === alias || normalized.startsWith(alias + ' ');
  });
}

function likelyCommandStart(fragment) {
  const preview = fragment.slice(0, 180);
  const normalized = normalize(preview);
  if (!normalized) return false;
  if (NEGATION_PREFIXES.some((prefix) => normalized.startsWith(prefix))) return true;
  const stripped = stripLeadingWrappers(normalized);
  if (directAliasStarts(stripped) || /^(?:tell|message)\b/u.test(stripped)) return true;
  if (
    /^(?:please\s+)?(?:can|could|would|will)\s+(?:you|u)\b/u.test(normalized) ||
    /^(?:i\s+(?:want|need)\s+(?:you|u)\s+to)\b/u.test(normalized)
  ) {
    return true;
  }
  const rawTokens = tokenize(preview, 0, false);
  const rawAction = findAnySequence(rawTokens.slice(0, 12), ACTION_SEQUENCES);
  if (rawAction && rawAction.index <= 7) return true;
  const correctedTokens = tokenize(preview, 0, true);
  const correctedAction = findAnySequence(correctedTokens.slice(0, 12), ACTION_SEQUENCES);
  return Boolean(correctedAction && correctedAction.index <= 7);
}

function likelyModelWorkStart(fragment) {
  const normalized = normalize(fragment.slice(0, 180));
  return /^(?:please\s+)?(?:review|audit|analyze|analyse|build|write|inspect|research|summarize|summarise|explain|refactor|fix|debug|implement|design|compare|read|check|investigate|scan|test|verify|use|reference)\b/u.test(
    normalized,
  );
}

function isProtectedReportingSentence(raw) {
  const normalized = normalize(raw);
  if (
    /^(?:please\s+)?(?:explain|show\s+me|tell\s+me)\s+how\s+to\b/u.test(normalized) &&
    /\b(?:without|but\s+do\s+not|but\s+don't|without\s+actually|without\s+doing|not\s+actually)\b/u.test(
      normalized,
    )
  ) {
    return true;
  }
  if (
    /^(?:yesterday|today|earlier today|earlier|last week|last month|two hours ago|an hour ago|previously)\b/u.test(
      normalized,
    )
  ) {
    return true;
  }
  if (
    /^(?:my|a|the|another)\s+(?:teammate|user|developer|person)\b[\s\S]*\b(?:said|says|wrote|reported|opened|launched|changed|renamed|showed|used|closed|played|paused)\b/u.test(
      normalized,
    )
  ) {
    return true;
  }
  if (
    /\b(?:fake transcript|chat log|documentation|tutorial|readme|example|quoted text|source code|test data)\b/u.test(
      normalized,
    ) &&
    /\b(?:says|said|contains|includes|reads|shows|uses|has)\b/u.test(normalized)
  ) {
    return true;
  }
  return false;
}

function colonPrefixBlocksSplit(prefix) {
  const normalized = normalize(prefix);
  if (
    /\b(?:genuine live request|genuine request|actual request|actual command|real command|live action|real navigation|actual navigation|perform the genuine|my actual request|this one is real)\b/u.test(
      normalized,
    )
  ) {
    return false;
  }
  return /\b(?:says|said|wrote|reported|contains|includes|reads|quotes|quoted|example|documentation|tutorial|readme|transcript|chat log|phrase|words|source code|test data|article|report)\b/u.test(
    normalized,
  );
}

function splitConnectors(span) {
  const raw = span.text;
  if (isProtectedReportingSentence(raw)) return [span];
  const quoted = quoteRanges(raw);
  const inQuote = (index) => quoted.some((range) => index > range.start && index < range.end);
  const boundaries = [];

  const colonRe = /:\s+/gu;
  let colonMatch;
  while ((colonMatch = colonRe.exec(raw))) {
    if (inQuote(colonMatch.index)) continue;
    const left = raw.slice(0, colonMatch.index);
    if (/(?:^|\b(?:and|also|then|plus)\s+)(?:please\s+)?(?:tell|message)\b/iu.test(normalize(left)))
      continue;
    const right = raw.slice(colonRe.lastIndex);
    if (!colonPrefixBlocksSplit(left) && likelyCommandStart(right)) {
      boundaries.push({ start: colonMatch.index, next: colonRe.lastIndex });
    }
  }

  const re =
    /(?:,\s*|\s+)(and\s+also|and\s+then|also|then|plus|but\s+actually|actually|instead|and)\s+/giu;
  let match;
  while ((match = re.exec(raw))) {
    if (inQuote(match.index)) continue;
    const right = raw.slice(re.lastIndex);
    const marker = normalize(match[1]);
    const rightIsCommand = likelyCommandStart(right);
    const rightIsModelWork = likelyModelWorkStart(right);
    const leftLooksCommandLike = likelyCommandStart(raw.slice(0, match.index));
    if (marker === 'and' && !rightIsCommand && !(rightIsModelWork && leftLooksCommandLike))
      continue;
    if (
      !rightIsCommand &&
      !(rightIsModelWork && leftLooksCommandLike) &&
      !CORRECTION_MARKERS.some((m) => normalize(right).startsWith(m))
    )
      continue;
    boundaries.push({ start: match.index, next: re.lastIndex });
  }

  boundaries.sort((a, b) => a.start - b.start);
  if (boundaries.length === 0) return [span];

  const parts = [];
  let cursor = 0;
  for (const boundary of boundaries) {
    const piece = raw.slice(cursor, boundary.start);
    if (piece.trim()) {
      const lead = piece.search(/\S/u);
      const tail = piece.length - piece.trimEnd().length;
      parts.push({
        start: span.start + cursor + Math.max(0, lead),
        end: span.start + boundary.start - tail,
        text: piece.trim(),
      });
    }
    cursor = boundary.next;
  }
  const tailPiece = raw.slice(cursor);
  if (tailPiece.trim()) {
    const lead = tailPiece.search(/\S/u);
    const tail = tailPiece.length - tailPiece.trimEnd().length;
    parts.push({
      start: span.start + cursor + Math.max(0, lead),
      end: span.end - tail,
      text: tailPiece.trim(),
    });
  }
  return parts.length ? parts : [span];
}

function quoteRanges(text) {
  const ranges = [];
  const lastSingleQuote = { "'": text.lastIndexOf("'"), '\u2019': text.lastIndexOf('\u2019') };
  let open = null;
  let start = -1;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '\\') {
      i += 1;
      continue;
    }
    const apostrophe = ch === "'" || ch === '\u2018' || ch === '\u2019';
    const wordBefore = /[\p{L}\p{N}]/u.test(text[i - 1] ?? '');
    const wordAfter = /[\p{L}\p{N}]/u.test(text[i + 1] ?? '');
    if (apostrophe && wordBefore && (!open || wordAfter)) continue;
    if (apostrophe && open === ch && /s/iu.test(text[i - 1] ?? '') && lastSingleQuote[ch] > i) {
      const followingWord = /^\s+([\p{L}]+)/u.exec(text.slice(i + 1, i + 65))?.[1]?.toLowerCase();
      // Keep a plural possessive inside its enclosing quotation; clause connectors close it.
      if (followingWord && !['and', 'then', 'also', 'plus', 'but', 'instead'].includes(followingWord)) continue;
    }
    if (!open && (ch === '"' || ch.charCodeAt(0) === 96 || ch === '\u201c' || apostrophe)) {
      open = ch === '\u201c' ? '\u201d' : ch === '\u2018' ? '\u2019' : ch;
      start = i;
    } else if (open && ch === open) {
      ranges.push({ start, end: i + 1 });
      open = null;
      start = -1;
    }
  }
  // An unfinished quotation cannot release live commands from its contents.
  if (open) ranges.push({ start, end: text.length });
  return ranges;
}

function insideQuote(span, ranges) {
  return ranges.some((range) => span.start >= range.start && span.end <= range.end);
}

function firstAction(tokens) {
  return findAnySequence(tokens, ACTION_SEQUENCES);
}

function firstCommandStart(tokens, action) {
  let index = action?.index ?? tokens.length;
  for (let i = 0; i < index; i += 1) {
    const aliases = DIRECT_ALIASES_BY_FIRST.get(tokens[i].value) ?? [];
    if (aliases.some((entry) => sequenceAt(tokens, entry.sequence, i))) {
      index = i;
      break;
    }
  }
  return tokens[index]?.start ?? -1;
}

function stripLeadingWrappers(normalized) {
  let value = normalized;
  let changed = true;
  while (changed) {
    changed = false;
    for (const prefix of POLITE_PREFIXES) {
      if (value === prefix) return '';
      if (value.startsWith(prefix + ' ')) {
        value = value.slice(prefix.length).trimStart();
        changed = true;
        break;
      }
    }
    const temporal =
      /^(?:at\s+the\s+very\s+end|at\s+the\s+end|before\s+you\s+finish|while\s+you\s+work|while\s+you\s+do\s+that|for\s+this\s+demo(?:\s+only)?|once\s+that(?:'s|\s+is)\s+done)[,\s]+/u.exec(
        value,
      );
    if (temporal) {
      value = value.slice(temporal[0].length).trimStart();
      changed = true;
    }
  }
  return value;
}

function speechAct(span, ranges) {
  if (insideQuote(span, ranges)) return { status: 'reject', reason: 'quoted' };
  // A numbered conversation heading is not the imperative verb "turn".
  // Check before normalize() removes the colon. splitConnectors() has already
  // separated any following real command, whose own span still needs admission.
  if (/^turn[ \t]+\d+[ \t]*:(?:[ \t]+|$)/iu.test(span.text)) {
    return { status: 'reject', reason: 'not-imperative' };
  }
  const normalized = normalize(span.text);
  if (!normalized) return { status: 'reject', reason: 'empty' };

  for (const prefix of NEGATION_PREFIXES) {
    if (normalized.startsWith(prefix) || normalized.startsWith('please ' + prefix)) {
      return { status: 'reject', reason: 'negated' };
    }
  }

  const markerIndexes = DISCOURSE_MARKERS.map((marker) => normalized.indexOf(marker))
    .filter((index) => index >= 0)
    .sort((a, b) => a - b);
  const originalPreview = span.text.slice(0, 220);
  const originalTokens = tokenize(originalPreview, span.start, false);
  const originalAction = firstAction(originalTokens);
  const actionStart = firstCommandStart(originalTokens, originalAction);
  if (ranges.some((range) => actionStart >= range.start && actionStart < range.end)) {
    return { status: 'reject', reason: 'quoted' };
  }
  const actionChar = originalAction
    ? originalTokens[originalAction.index]?.start - span.start
    : Number.POSITIVE_INFINITY;
  if (markerIndexes.length && markerIndexes[0] * 0.7 <= actionChar) {
    return { status: 'reject', reason: 'discourse' };
  }

  if (/^(?:if|when|whenever|unless|suppose|imagine)\b/u.test(normalized)) {
    return { status: 'reject', reason: 'conditional' };
  }
  if (
    /^(?:(?:yesterday|today|earlier today|earlier|last week|last month|two hours ago|an hour ago|previously)\s+)?(?:i|we|he|she|they|my teammate|a teammate|another user)\s+(?:opened|launched|started|changed|renamed|showed|used|closed|played|paused)\b/u.test(
      normalized,
    )
  ) {
    return { status: 'reject', reason: 'reported' };
  }

  const stripped = stripLeadingWrappers(normalized);
  const polite =
    /^(?:please\s+)?(?:can|could|would|will)\s+(?:you|u)\b/u.test(normalized) ||
    /^(?:i\s+(?:want|need)\s+(?:you|u)\s+to)\b/u.test(normalized);

  const directStart = directAliasStarts(stripped) || /^(?:tell|message)\b/u.test(stripped);
  const rawCore = tokenize(stripped.slice(0, 220), 0, false);
  const rawAction = firstAction(rawCore);
  let typoAction = null;
  if (!directStart && (!rawAction || rawAction.index !== 0)) {
    typoAction = firstAction(tokenize(stripped.slice(0, 220), 0, true));
  }
  const imperative =
    directStart ||
    Boolean(rawAction && rawAction.index === 0) ||
    Boolean(typoAction && typoAction.index === 0) ||
    polite;

  if (!imperative) return { status: 'reject', reason: 'not-imperative' };

  const tokens = directStart ? tokenize(stripped, 0, false) : tokenize(stripped, 0, true);
  const strippedAction = firstAction(tokens);
  if (ranges.length) {
    // Map the admitted token through removed wrappers, beyond the preliminary preview.
    const commandStart = firstCommandStart(tokens, strippedAction);
    const commandIndex = Math.max(0, tokens.findIndex((token) => token.start === commandStart));
    const wrapperCount = tokenize(normalized.slice(0, normalized.length - stripped.length), 0, false).length;
    const sourceTokens = tokenize(span.text, span.start, false);
    const sourceStart = sourceTokens[wrapperCount + commandIndex]?.start ?? -1;
    if (ranges.some((range) => sourceStart >= range.start && sourceStart < range.end)) {
      return { status: 'reject', reason: 'quoted' };
    }
  }
  return {
    status: 'candidate',
    normalized: stripped,
    tokens,
    directTokens: directStart ? tokens : undefined,
    correctedCount: tokens.filter((token) => token.corrected).length,
    polite,
    action: strippedAction,
  };
}

function resolveSingle(tokens, groups) {
  const values = allSequenceKeys(tokens, groups);
  if (values.size > 1) return { status: 'ambiguous', values: [...values] };
  return { status: 'ok', value: [...values][0] ?? null };
}

const NUMBER_WORDS = Object.freeze({
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
});

function parseExplicitCount(tokens, action) {
  const start = Math.max(0, (action?.index ?? 0) + (action?.length ?? 1));
  for (let i = start; i < Math.min(tokens.length, start + 5); i += 1) {
    const value = tokens[i]?.value;
    if (!value || ['a', 'an', 'the'].includes(value)) continue;
    const parsed = NUMBER_WORDS[value] ?? (/^\d+$/u.test(value) ? Number(value) : NaN);
    if (Number.isInteger(parsed) && parsed >= 1 && parsed <= 10) return parsed;
  }
  return null;
}

function trimCommandTail(value) {
  let out = normalize(value);
  let prior = '';
  while (out && out !== prior) {
    prior = out;
    out = out.replace(/\s+(?:right now|now|please|for me)$/u, '').trim();
  }
  return out;
}

function directCommandFromFrame(span, speech) {
  const tokens = speech.directTokens ?? speech.tokens;
  for (const entry of directCandidatesForTokens(tokens)) {
    if (!sequenceAt(tokens, entry.sequence, 0)) continue;
    const remainder = trimCommandTail(
      tokens
        .slice(entry.sequence.length)
        .map((token) => token.raw)
        .join(' '),
    );
    const confidence = Math.max(0.74, 0.99 - speech.correctedCount * 0.04);
    const slotKey = entry.command.slotKey ?? 'remainder';

    // "open file browser" is canonical page navigation, not a request to open
    // a file literally named "browser".
    if (entry.command.id === 'file.open' && remainder === 'browser') continue;

    if (entry.command.slot === 'none') {
      if (remainder) continue;
      return { status: 'command', id: entry.command.id, confidence, slots: {} };
    }

    if (entry.command.slot === 'number') {
      const numeric = /([+-]?(?:\d+(?:\.\d+)?|\.\d+))\s*[.!?;]*$/u.exec(span.text.trim());
      if (!numeric) return { status: 'ambiguous', reason: 'direct-number' };
      const value = Number(numeric[1]);
      if (!Number.isFinite(value)) return { status: 'ambiguous', reason: 'direct-number' };
      return { status: 'command', id: entry.command.id, confidence, slots: { [slotKey]: value } };
    }

    if (!remainder && entry.command.slot === 'remainder') {
      return { status: 'ambiguous', reason: 'direct-missing-slot' };
    }

    return {
      status: 'command',
      id: entry.command.id,
      confidence,
      slots: remainder ? { [slotKey]: remainder } : {},
    };
  }
  return null;
}

function targetedPayload(raw) {
  let payload = raw.trim();
  const marker =
    /^(?:exactly(?:\s+(?:this|the)\s+(?:message|prompt|text))?|verbatim)\s*:?\s+/iu.exec(payload);
  if (marker) payload = payload.slice(marker[0].length);
  const first = payload[0];
  const close = first === '\u201c' ? '\u201d' : first;
  const quoted = first === '"' || first === '\u201c' || first === '`';
  if (quoted) {
    let end = -1;
    for (let i = 1; i < payload.length; i += 1) {
      if (payload[i] === '\\') {
        i += 1;
        continue;
      }
      if (payload[i] === close) {
        end = i;
        break;
      }
    }
    if (end <= 0 || !/^[.!?;]?$/u.test(payload.slice(end + 1).trim())) return null;
    payload = payload.slice(1, end);
  } else if (!marker) {
    payload = payload.replace(/[.!?;]$/u, '').trimEnd();
  }
  if (!payload.trim() || payload.length > 32_768) return null;
  // Context-dependent work needs model composition, not a guessed literal relay.
  const needsComposition =
    /\b(?:rlm|context map|project context|skills?|environment|relevant|downloads|audit|draft|compose|rewrite|research|design|planning)\b/u.test(
      normalize(payload),
    );
  return { payload, needsComposition: !marker && !quoted && needsComposition };
}

function explicitTargetedMessageFromFrame(span, speech) {
  if (!/^(?:tell|message)\b/u.test(speech.normalized)) return null;
  // Recognition is normalized, but delivery bytes are taken from original text.
  const action = tokenize(span.text, 0, false).find(
    (t) => t.value === 'tell' || t.value === 'message',
  );
  if (!action) return null;
  const raw = span.text.slice(action.start);
  const finish = (id, target, source) => {
    const parsed = targetedPayload(source);
    if (!parsed) return { status: 'ambiguous', reason: 'message-payload' };
    if (parsed.needsComposition)
      return { status: 'ambiguous', reason: 'message-needs-model-context' };
    return { status: 'command', id, confidence: 0.99, slots: { target, payload: parsed.payload } };
  };
  let match =
    /^(?:tell|message)\s+terminal\s+(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+(?:to\s+)?([\s\S]+)$/iu.exec(
      raw,
    );
  if (match) {
    const ordinal = NUMBER_WORDS[match[1].toLowerCase()] ?? Number(match[1]);
    if (!Number.isInteger(ordinal) || ordinal < 1 || ordinal > 10)
      return { status: 'ambiguous', reason: 'message-target' };
    return finish('terminal.message', { ordinal, scope: 'one' }, match[2]);
  }
  match = /^tell\s+all\s+terminals?\s+(?:to\s+)?([\s\S]+)$/iu.exec(raw);
  if (match) return finish('terminal.broadcast', { scope: 'all' }, match[1]);
  match = /^tell\s+all\s+(.+?)\s+terminals?\s+(?:to\s+)?([\s\S]+)$/iu.exec(raw);
  if (match) {
    const provider = resolveSingle(tokenize(match[1]), PROVIDER_SEQUENCES);
    if (provider.status === 'ok' && provider.value) {
      return finish('terminal.broadcast', { provider: provider.value, scope: 'all' }, match[2]);
    }
  }
  match = /^tell\s+(.+?)\s+(?:to\s+|(?=exactly\b|verbatim\b))([\s\S]+)$/iu.exec(raw);
  if (match) {
    const provider = resolveSingle(tokenize(match[1]), PROVIDER_SEQUENCES);
    if (provider.status === 'ok' && provider.value) {
      return finish('agent.message', { provider: provider.value, scope: 'one' }, match[2]);
    }
  }
  return null;
}

function familyScores(tokens) {
  const scores = new Map();
  for (const [family, sequences] of FAMILY_SEQUENCES) {
    let best = 0;
    for (const sequence of sequences) {
      const index = findSequence(tokens, sequence);
      if (index >= 0) best = Math.max(best, 100 + sequence.length * 10 - index);
    }
    if (best) scores.set(family, best);
  }
  if (allSequenceKeys(tokens, PROVIDER_SEQUENCES).size) {
    scores.set('terminal', Math.max(scores.get('terminal') ?? 0, 130));
  }
  if (allSequenceKeys(tokens, COLOR_SEQUENCES).size) {
    scores.set('background', Math.max(scores.get('background') ?? 0, 115));
  }
  const pages = allSequenceKeys(tokens, PAGE_SEQUENCES);
  if (pages.size) {
    const explicitSurface = tokens.some(
      (t) =>
        t.value === 'page' || t.value === 'view' || t.value === 'screen' || t.value === 'browser',
    );
    scores.set('page', Math.max(scores.get('page') ?? 0, explicitSurface ? 145 : 135));
  }
  return [...scores.entries()].sort((a, b) => b[1] - a[1]);
}

function actionKeys(tokens) {
  return allSequenceKeys(tokens, ACTION_SEQUENCES);
}

function exactAliasCommand(text) {
  const normalized = stripLeadingWrappers(
    normalize(text)
      .replace(/[.!?;]+$/u, '')
      .trim(),
  );
  const command = EXACT_ALIAS_INDEX.get(normalized);
  return command ? { command, normalized } : null;
}

function extractButtonLabel(source) {
  const match =
    /(?:rename|relabel|change|set)[\s\S]{0,36}?button[\s\S]{0,26}?(?:to|as)\s+["']?([^,.!?;\n]{1,80})/iu.exec(
      source,
    );
  if (!match) return null;
  return match[1]
    .trim()
    .replace(/["']+$/u, '')
    .trim();
}

function hasContentMediator(family, normalized) {
  const mediators = CONTENT_MEDIATORS[family] ?? [];
  const padded = ' ' + normalize(normalized) + ' ';
  return mediators.some((phrase) => padded.includes(' ' + normalize(phrase) + ' '));
}

function commandFromFrame(span, speech) {
  const tokens = speech.tokens;

  const targetedMessage = explicitTargetedMessageFromFrame(span, speech);
  if (targetedMessage) return targetedMessage;

  const direct = directCommandFromFrame(span, speech);
  if (direct) return direct;

  if (tokens.some((token) => token.providerConflict)) {
    return { status: 'ambiguous', reason: 'typo-intent-conflict' };
  }

  const familyRanking = familyScores(tokens);
  if (familyRanking.length === 0) {
    return { status: 'ambiguous', reason: tokens.some((token) => token.intentConflict) ? 'typo-intent-conflict' : 'no-family' };
  }

  const family = familyRanking[0][0];
  const familyScore = familyRanking[0][1];
  const secondFamilyScore = familyRanking[1]?.[1] ?? 0;
  if (secondFamilyScore > 0 && familyScore - secondFamilyScore < 8) {
    const pageLike = family === 'page' || familyRanking[1]?.[0] === 'page';
    if (!pageLike) return { status: 'ambiguous', reason: 'family-margin' };
  }

  const actions = actionKeys(tokens);
  const primaryAction = speech.action?.key ?? null;
  const corrections = speech.correctedCount;
  const confidenceBase = Math.max(0.72, 0.985 - corrections * 0.045);
  const exactAlias = EXACT_ALIAS_INDEX.has(stripLeadingWrappers(speech.normalized));
  if (!exactAlias && hasContentMediator(family, speech.normalized)) {
    return { status: 'ambiguous', reason: 'content-mediator' };
  }

  // No-payload actions cannot consume an unrecognized subject or qualifier.
  // Preserve such text for clarification rather than interpreting a noun
  // phrase (for example "terminal illness") as an application control.
  if (
    ['terminal', 'panel', 'music'].includes(family) &&
    tokens.some(
      (token) =>
        !LEXICON.has(token.value) &&
        !FILLER_WORDS.has(token.value) &&
        !/^(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|to|in|on|my|with|app|application|agents|could|can|would|will|you|u|up|instead|actually|again|both|it)$/u.test(
          token.raw,
        ),
    )
  ) {
    return { status: 'ambiguous', reason: 'unresolved-subject' };
  }

  if (family === 'terminal') {
    const provider = resolveSingle(tokens, PROVIDER_SEQUENCES);
    if (provider.status === 'ambiguous')
      return { status: 'ambiguous', reason: 'provider-conflict' };
    if (primaryAction !== 'open') return { status: 'ambiguous', reason: 'terminal-action' };
    const count = parseExplicitCount(tokens, speech.action);
    return {
      status: 'command',
      id: 'terminal.open',
      confidence: provider.value ? confidenceBase : Math.min(confidenceBase, 0.95),
      slots: {
        provider: provider.value ?? 'shell',
        ...(count ? { count } : {}),
      },
    };
  }

  if (family === 'background') {
    const color = resolveSingle(tokens, COLOR_SEQUENCES);
    if (color.status === 'ambiguous' || !color.value)
      return { status: 'ambiguous', reason: 'background-color' };
    if (primaryAction !== 'set') return { status: 'ambiguous', reason: 'background-action' };
    return {
      status: 'command',
      id: 'appearance.background.set',
      confidence: confidenceBase,
      slots: { color: color.value },
    };
  }

  if (family === 'button') {
    const label = extractButtonLabel(span.text);
    if (!label) return { status: 'ambiguous', reason: 'button-label' };
    if (!(primaryAction === 'rename' || primaryAction === 'set'))
      return { status: 'ambiguous', reason: 'button-action' };
    return {
      status: 'command',
      id: 'button.rename',
      confidence: confidenceBase,
      slots: { label },
    };
  }

  if (family === 'panel') {
    const id =
      primaryAction === 'close'
        ? 'panel.close'
        : primaryAction === 'open'
          ? 'panel.open'
          : primaryAction === 'toggle' || primaryAction === 'set'
            ? 'panel.toggle'
            : null;
    return id
      ? { status: 'command', id, confidence: confidenceBase, slots: {} }
      : { status: 'ambiguous', reason: 'panel-action' };
  }

  if (family === 'status') {
    return primaryAction === 'show'
      ? { status: 'command', id: 'status.show', confidence: confidenceBase, slots: {} }
      : { status: 'ambiguous', reason: 'status-action' };
  }

  if (family === 'font') {
    if (!['set', 'increase', 'decrease'].includes(primaryAction)) {
      return { status: 'ambiguous', reason: 'font-action' };
    }
    const direction = actions.has('increase')
      ? 'increase'
      : actions.has('decrease')
        ? 'decrease'
        : null;
    return direction
      ? { status: 'command', id: 'font.adjust', confidence: confidenceBase, slots: { direction } }
      : { status: 'ambiguous', reason: 'font-direction' };
  }

  if (family === 'music') {
    if (primaryAction === 'pause') {
      return { status: 'command', id: 'music.pause', confidence: confidenceBase, slots: {} };
    }
    if (primaryAction === 'play' || primaryAction === 'open') {
      return { status: 'command', id: 'music.play', confidence: confidenceBase, slots: {} };
    }
    return { status: 'ambiguous', reason: 'music-action' };
  }

  if (family === 'page') {
    const page = resolveSingle(tokens, PAGE_SEQUENCES);
    if (page.status === 'ambiguous' || !page.value)
      return { status: 'ambiguous', reason: 'page-target' };
    if (primaryAction !== 'open') {
      return { status: 'ambiguous', reason: 'page-action' };
    }
    return {
      status: 'command',
      id: 'page.open',
      confidence: confidenceBase,
      slots: { route: page.value },
    };
  }

  return { status: 'ambiguous', reason: 'unknown-family' };
}

export function cleanupResidual(text: string, spans: readonly LocalTextSpan[]): string {
  if (!spans.length) return text.trim();
  const ordered = [...spans].sort((a, b) => a.start - b.start);
  const merged = [];
  for (const span of ordered) {
    const prior = merged[merged.length - 1];
    if (prior && span.start <= prior.end) prior.end = Math.max(prior.end, span.end);
    else merged.push({ start: span.start, end: span.end });
  }

  let out = '';
  let cursor = 0;
  for (const span of merged) {
    out += text.slice(cursor, span.start);
    cursor = span.end;
  }
  out += text.slice(cursor);

  return out
    .trimStart()
    .replace(/\s+([,.!?;:])/gu, '$1')
    .replace(/(^|[\n.!?;]\s*)(?:and\s+also|and\s+then|and|also|then|plus)\s*[,;:]?\s*/giu, '$1')
    .replace(/\b(?:and\s+also|and\s+then|and|also|then|plus)\s*[,;:]?\s*(?=[.!?;]*$)/giu, '')
    .replace(/[ \t]{2,}/gu, ' ')
    .replace(/\n[ \t]+/gu, '\n')
    .trim();
}

function meaningfulResidual(text) {
  const tokens = phraseWords(text).filter((word) => !FILLER_WORDS.has(word));
  return tokens.length >= 4;
}

function commandSignature(command) {
  return command.id + ':' + JSON.stringify(command.slots ?? {});
}

function familyKey(command) {
  if (command.id === 'appearance.background.set') return 'background';
  if (command.id.startsWith('terminal.')) return 'terminal';
  if (command.id.startsWith('panel.')) return 'panel';
  if (command.id.startsWith('button.')) return 'button';
  if (command.id.startsWith('status.')) return 'status';
  if (command.id.startsWith('font.')) return 'font';
  if (command.id.startsWith('music.')) return 'music';
  if (command.id.startsWith('page.')) return 'page';
  return command.id.split('.')[0];
}

function applyCorrections(commands, suppressedControls = []) {
  const out = [];
  const suppressed = [];
  for (const command of commands) {
    const source = normalize(command.source);
    const explicitCorrection =
      /\b(?:instead|rather)\b/u.test(source) ||
      source.startsWith('no wait ') ||
      source.startsWith('wait ') ||
      source.startsWith('scratch that ') ||
      source.startsWith('changed my mind ');
    const nearbySuppressedControl = suppressedControls.some((span) => {
      const gap = command.sourceStart - span.end;
      return gap >= 0 && gap <= 220;
    });
    const correction = explicitCorrection && !nearbySuppressedControl;
    if (!correction) {
      out.push(command);
      continue;
    }
    const family = familyKey(command);
    for (let i = out.length - 1; i >= 0; i -= 1) {
      const prior = out[i];
      const nearby =
        command.sourceStart - prior.sourceEnd >= 0 && command.sourceStart - prior.sourceEnd <= 200;
      if (nearby && familyKey(prior) === family) {
        const removed = out.splice(i, 1)[0];
        suppressed.push({ start: removed.sourceStart, end: removed.sourceEnd });
        break;
      }
    }
    out.push(command);
  }
  return { commands: out, suppressed };
}

function frameForExactAlias(text) {
  const tokens = tokenize(text, 0, false);
  const normalized = normalize(text);
  const speech = {
    tokens,
    directTokens: tokens,
    normalized,
    correctedCount: 0,
    action: firstAction(tokens),
  };
  return commandFromFrame({ text, start: 0, end: text.length }, speech);
}

function fastPath(text, ranges) {
  if (text.length > 256 || /[\n;]/u.test(text)) return null;
  const exact = exactAliasCommand(text);
  if (!exact) return null;
  if (ranges.length) {
    const tokens = tokenize(text, 0, false);
    const action = firstAction(tokens);
    const start = firstCommandStart(tokens, action);
    if (ranges.some((range) => start >= range.start && start < range.end)) return null;
  }
  const frame = frameForExactAlias(text);
  if (frame.status !== 'command') return null;

  const start = text.search(/\S/u);
  const end = text.length - (text.length - text.trimEnd().length);
  const command = Object.freeze({
    id: frame.id,
    confidence: 0.999,
    source: text.slice(Math.max(0, start), end),
    sourceStart: Math.max(0, start),
    sourceEnd: end,
    slots: Object.freeze(frame.slots ?? {}),
    path: 'exact',
  });

  return Object.freeze({
    commands: Object.freeze([command]),
    residual: '',
    classification: 'command_only',
    ambiguous: Object.freeze([]),
    metrics: Object.freeze({
      candidateClauses: 1,
      rejectedClauses: 0,
      correctedTokens: 0,
      fastPath: true,
    }),
  });
}

export function routeLocalCommand(text: unknown): LocalRouteResult {
  if (
    typeof text !== 'string' ||
    !text.trim() ||
    text.length > MAX_INPUT ||
    CONTROL_RE.test(text)
  ) {
    return Object.freeze({
      commands: Object.freeze([]),
      residual: typeof text === 'string' ? text.trim() : '',
      classification: 'llm_only',
      ambiguous: Object.freeze([]),
      metrics: Object.freeze({
        candidateClauses: 0,
        rejectedClauses: 0,
        correctedTokens: 0,
        fastPath: false,
      }),
    });
  }

  const ranges = quoteRanges(text);
  // Exact-alias normalization removes quote marks; retain quoted-action admission checks.
  const fast = fastPath(text, ranges);
  if (fast) return fast;
  const rawClauses = sentenceSpans(text).flatMap(splitConnectors).slice(0, MAX_CLAUSES);
  const accepted = [];
  const ambiguous = [];
  const suppressedControls = [];
  let candidateClauses = 0;
  let rejectedClauses = 0;
  let correctedTokens = 0;

  for (const span of rawClauses) {
    const speech = speechAct(span, ranges);
    if (speech.status !== 'candidate') {
      rejectedClauses += 1;
      if (speech.reason === 'negated') {
        const controlTokens = tokenize(span.text, span.start);
        if (familyScores(controlTokens).length > 0 && firstAction(controlTokens)) {
          suppressedControls.push({ start: span.start, end: span.end });
        }
      }
      continue;
    }

    candidateClauses += 1;
    correctedTokens += speech.correctedCount;
    const frame = commandFromFrame(span, speech);
    if (frame.status !== 'command') {
      ambiguous.push(
        Object.freeze({
          source: span.text,
          sourceStart: span.start,
          sourceEnd: span.end,
          reason: frame.reason,
        }),
      );
      continue;
    }

    accepted.push({
      id: frame.id,
      confidence: frame.confidence,
      source: span.text,
      sourceStart: span.start,
      sourceEnd: span.end,
      slots: Object.freeze(frame.slots ?? {}),
      path: speech.correctedCount > 0 ? 'local-typo' : 'local-frame',
    });
  }

  const correctionResult = applyCorrections(accepted, suppressedControls);
  const corrected = correctionResult.commands;
  const keptSpans = [
    ...corrected.map((command) => ({
      start: command.sourceStart,
      end: command.sourceEnd,
    })),
    ...suppressedControls,
    ...correctionResult.suppressed,
  ];
  const residual = cleanupResidual(text, keptSpans);
  const meaningful = meaningfulResidual(residual);

  const classification = corrected.length
    ? meaningful
      ? 'both'
      : 'command_only'
    : meaningful
      ? 'llm_only'
      : ambiguous.length
        ? 'ambiguous'
        : 'llm_only';

  return Object.freeze({
    commands: Object.freeze(corrected.map((command) => Object.freeze(command))),
    residual,
    classification,
    ambiguous: Object.freeze(ambiguous),
    metrics: Object.freeze({
      candidateClauses,
      rejectedClauses,
      correctedTokens,
      suppressedControlClauses: suppressedControls.length + correctionResult.suppressed.length,
      fastPath: false,
    }),
  });
}

export function signature(command: LocalDetectedCommand): string {
  return commandSignature(command);
}
