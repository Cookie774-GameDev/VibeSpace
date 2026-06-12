/**
 * Text cleanup + chunking for TTS.
 *
 * Assistant responses are full of markdown, code blocks, URLs, and JSON that
 * sound terrible when read aloud. This module normalizes text into clean,
 * speech-friendly chunks before it reaches any voice provider.
 *
 * Pure functions only — no I/O, no provider deps — so they're trivially unit
 * tested and reused by every provider (Kokoro, OpenAI, Deepgram, etc.).
 */

export interface CleanupOptions {
  /** When true, code blocks are read verbatim; otherwise summarized. Default false. */
  readCode?: boolean;
  /** Max characters per chunk. Default 400 (plan target: 200-500). */
  maxChunkChars?: number;
}

const DEFAULT_MAX_CHUNK = 520;

/** Strip a fenced code block down to a short spoken summary (or keep it). */
function handleCodeBlocks(text: string, readCode: boolean): string {
  const fence = /```[\s\S]*?```/g;
  if (readCode) {
    return text.replace(/```(\w+)?\n?/g, '').replace(/```/g, '');
  }
  return text.replace(fence, (block) => {
    const lines = block.split('\n').length;
    return ` (code block, ${Math.max(1, lines - 2)} lines omitted) `;
  });
}

/** Replace URLs with the word "link" so we don't read out long hrefs. */
function replaceUrls(text: string): string {
  return text.replace(/https?:\/\/[^\s)]+/gi, 'link').replace(/www\.[^\s)]+/gi, 'link');
}

/** Turn markdown bullets/numbered lists into spoken sentences. */
function flattenLists(text: string): string {
  return text
    .replace(/^\s*[-*+]\s+/gm, '') // bullet markers
    .replace(/^\s*\d+\.\s+/gm, ''); // numbered markers
}

/** Remove markdown emphasis/heading/inline-code/link syntax. */
function stripMarkdown(text: string): string {
  return text
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '') // images
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1') // links -> label
    .replace(/`([^`]+)`/g, '$1') // inline code
    .replace(/^#{1,6}\s+/gm, '') // headings
    .replace(/(\*\*|__)(.*?)\1/g, '$2') // bold
    .replace(/(\*|_)(.*?)\1/g, '$2') // italic
    .replace(/~~(.*?)~~/g, '$1') // strikethrough
    .replace(/^>\s?/gm, '') // blockquotes
    .replace(/\|/g, ' ') // table pipes
    .replace(/^[-=]{3,}$/gm, ''); // hr / table separators
}

/** Collapse repeated punctuation and whitespace. */
function normalizeWhitespace(text: string): string {
  return text
    .replace(/([!?.,;:])\1{1,}/g, '$1') // !!! -> !
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]+\n/g, '\n')
    .trim();
}

/** Detect content we should not read raw unless explicitly asked. */
export function looksLikeRawData(text: string): boolean {
  const t = text.trim();
  if (/^[[{][\s\S]*[\]}]$/.test(t) && /["{}[\]:,]/.test(t)) return true; // JSON-ish
  if (/\bat\s+.+\(.+:\d+:\d+\)/.test(t)) return true; // stack trace
  return false;
}

/** Full cleanup pipeline. Returns speech-ready plain text. */
export function cleanTextForSpeech(input: string, options: CleanupOptions = {}): string {
  if (!input) return '';
  const readCode = options.readCode ?? false;
  let text = input;
  text = handleCodeBlocks(text, readCode);
  text = stripMarkdown(text);
  text = flattenLists(text);
  text = replaceUrls(text);
  text = normalizeWhitespace(text);
  return text;
}

/**
 * Split text into sentence-aware chunks of ~maxChunkChars. Never splits a word.
 * Falls back to hard slicing for pathological no-punctuation input.
 */
export function chunkText(input: string, maxChunkChars = DEFAULT_MAX_CHUNK): string[] {
  const text = input.trim();
  if (!text) return [];
  if (text.length <= maxChunkChars) return [text];

  // Split on sentence boundaries, keeping the delimiter.
  const sentences = text.match(/[^.!?\n]+[.!?]?(\s|$)|\n+/g) ?? [text];
  const chunks: string[] = [];
  let current = '';

  for (const raw of sentences) {
    const sentence = raw.trim();
    if (!sentence) continue;

    if (sentence.length > maxChunkChars) {
      if (current) {
        chunks.push(current.trim());
        current = '';
      }
      // Hard-wrap an over-long sentence on word boundaries.
      let rest = sentence;
      while (rest.length > maxChunkChars) {
        let cut = rest.lastIndexOf(' ', maxChunkChars);
        if (cut <= 0) cut = maxChunkChars;
        chunks.push(rest.slice(0, cut).trim());
        rest = rest.slice(cut).trim();
      }
      if (rest) current = rest;
      continue;
    }

    if ((current + ' ' + sentence).trim().length > maxChunkChars) {
      chunks.push(current.trim());
      current = sentence;
    } else {
      current = current ? `${current} ${sentence}` : sentence;
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks.filter(Boolean);
}

/**
 * Prepare a response for speaking: clean it, optionally summarize very long
 * answers, and chunk. Returns the ordered chunks ready for the audio queue.
 */
export function prepareForSpeech(
  input: string,
  options: CleanupOptions & { summarizeLongOver?: number } = {},
): string[] {
  const cleaned = cleanTextForSpeech(input, options);
  if (!cleaned) return [];
  return chunkText(cleaned, options.maxChunkChars ?? DEFAULT_MAX_CHUNK);
}

/** Completed sentences from streamed assistant text (no tiny partial chunks). */
export function pullNewSpeechSegments(
  rawAccumulated: string,
  spokenCleanLength: number,
  options: CleanupOptions = {},
): { segments: string[]; nextSpokenCleanLength: number } {
  const cleaned = cleanTextForSpeech(rawAccumulated, options);
  if (cleaned.length <= spokenCleanLength) {
    return { segments: [], nextSpokenCleanLength: spokenCleanLength };
  }

  const tail = cleaned.slice(spokenCleanLength);
  const segments: string[] = [];
  let advance = 0;

  const sentenceRe = /[^.!?\n]+[.!?]+(?:\s+|$)/g;
  let match: RegExpExecArray | null;
  while ((match = sentenceRe.exec(tail)) !== null) {
    const sentence = match[0].trim();
    if (sentence.length >= 4) {
      segments.push(sentence);
      advance = match.index + match[0].length;
    }
  }

  return {
    segments,
    nextSpokenCleanLength: spokenCleanLength + advance,
  };
}

/** Trailing fragment without a closing sentence delimiter (spoken at stream end). */
export function pullRemainingSpeech(
  rawAccumulated: string,
  spokenCleanLength: number,
  options: CleanupOptions = {},
): { remainder: string; nextSpokenCleanLength: number } {
  const cleaned = cleanTextForSpeech(rawAccumulated, options);
  if (cleaned.length <= spokenCleanLength) {
    return { remainder: '', nextSpokenCleanLength: spokenCleanLength };
  }
  const remainder = cleaned.slice(spokenCleanLength).trim();
  return { remainder, nextSpokenCleanLength: cleaned.length };
}
