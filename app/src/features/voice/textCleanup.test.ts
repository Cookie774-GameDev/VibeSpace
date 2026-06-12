import { describe, expect, it } from 'vitest';
import {
  chunkText,
  cleanTextForSpeech,
  looksLikeRawData,
  prepareForSpeech,
  pullNewSpeechSegments,
  pullRemainingSpeech,
} from './textCleanup';

describe('cleanTextForSpeech', () => {
  it('strips markdown emphasis and headings', () => {
    const out = cleanTextForSpeech('# Title\n\nThis is **bold** and *italic* and `code`.');
    expect(out).not.toContain('#');
    expect(out).not.toContain('**');
    expect(out).not.toContain('`');
    expect(out).toContain('bold');
    expect(out).toContain('italic');
    expect(out).toContain('code');
  });

  it('converts links to their label and bare URLs to "link"', () => {
    expect(cleanTextForSpeech('See [the docs](https://example.com/docs).')).toContain('the docs');
    expect(cleanTextForSpeech('Go to https://example.com/page now')).toContain('link');
    expect(cleanTextForSpeech('Go to https://example.com/page now')).not.toContain('example.com');
  });

  it('summarizes code blocks by default', () => {
    const out = cleanTextForSpeech('Here:\n```js\nconst a = 1;\nconst b = 2;\n```\nDone.');
    expect(out.toLowerCase()).toContain('code block');
    expect(out).not.toContain('const a = 1;');
    expect(out).toContain('Done.');
  });

  it('reads code verbatim when readCode=true', () => {
    const out = cleanTextForSpeech('```\nhello world\n```', { readCode: true });
    expect(out).toContain('hello world');
  });

  it('flattens bullet and numbered lists', () => {
    const out = cleanTextForSpeech('- one\n- two\n1. three');
    expect(out).not.toMatch(/^\s*[-*+]\s/m);
    expect(out).not.toMatch(/^\s*\d+\.\s/m);
    expect(out).toContain('one');
    expect(out).toContain('three');
  });

  it('collapses repeated punctuation and whitespace', () => {
    expect(cleanTextForSpeech('Wow!!!   really???')).toBe('Wow! really?');
  });

  it('returns empty string for empty input', () => {
    expect(cleanTextForSpeech('')).toBe('');
  });
});

describe('chunkText', () => {
  it('returns a single chunk for short text', () => {
    expect(chunkText('Hello there.')).toEqual(['Hello there.']);
  });

  it('splits on sentence boundaries within the limit', () => {
    const text = 'First sentence here. Second sentence here. Third one here.';
    const chunks = chunkText(text, 30);
    expect(chunks.length).toBeGreaterThan(1);
    chunks.forEach((c) => expect(c.length).toBeLessThanOrEqual(31));
  });

  it('hard-wraps an over-long sentence on word boundaries without losing words', () => {
    const long = 'word '.repeat(100).trim();
    const chunks = chunkText(long, 50);
    chunks.forEach((c) => expect(c.length).toBeLessThanOrEqual(50));
    expect(chunks.join(' ').split(' ').length).toBe(100);
  });

  it('returns empty array for empty input', () => {
    expect(chunkText('')).toEqual([]);
  });
});

describe('prepareForSpeech', () => {
  it('cleans then chunks in one pass', () => {
    const out = prepareForSpeech('# Hi\n\nGo to https://x.com. ' + 'a '.repeat(300), {
      maxChunkChars: 100,
    });
    expect(out.length).toBeGreaterThan(1);
    out.forEach((c) => expect(c.length).toBeLessThanOrEqual(100));
    expect(out.join(' ')).not.toContain('#');
  });
});

describe('pullNewSpeechSegments', () => {
  it('returns only newly completed sentences from streamed text', () => {
    const first = pullNewSpeechSegments('Hello there. How are', 0);
    expect(first.segments).toEqual(['Hello there.']);
    const second = pullNewSpeechSegments('Hello there. How are you today?', first.nextSpokenCleanLength);
    expect(second.segments).toEqual(['How are you today?']);
  });

  it('starts speaking early phrase chunks before the sentence ends', () => {
    const first = pullNewSpeechSegments('Today is', 0);
    expect(first.segments).toEqual(['Today is']);
    const second = pullNewSpeechSegments('Today is Thursday', first.nextSpokenCleanLength);
    expect(second.segments).toEqual([]);
    const third = pullNewSpeechSegments('Today is Thursday.', first.nextSpokenCleanLength);
    expect(third.segments).toEqual(['Thursday.']);
  });
});

describe('pullRemainingSpeech', () => {
  it('speaks the tail without a closing delimiter at stream end', () => {
    const partial = pullNewSpeechSegments('Hello there. Still going', 0);
    const tail = pullRemainingSpeech('Hello there. Still going strong', partial.nextSpokenCleanLength);
    expect(tail.remainder).toBe('strong');
  });
});

describe('looksLikeRawData', () => {
  it('detects JSON-ish payloads', () => {
    expect(looksLikeRawData('{"a":1,"b":[2,3]}')).toBe(true);
  });
  it('detects stack traces', () => {
    expect(looksLikeRawData('Error\n    at foo (file.js:1:2)')).toBe(true);
  });
  it('passes normal prose', () => {
    expect(looksLikeRawData('This is a normal sentence.')).toBe(false);
  });
});
