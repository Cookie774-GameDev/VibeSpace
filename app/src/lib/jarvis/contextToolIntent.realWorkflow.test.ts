import { describe, expect, it } from 'vitest';
import { requestsReadOnlyContextTool } from './contextToolIntent';

describe('ordinary file and HTML work', () => {
  it.each([
    'Read these files and make me another HTML quickly.',
    'Read the documents and build a page from them.',
    'Read these files and generate an HTML preview.',
  ])('keeps execution tools for %s', (prompt) => {
    expect(requestsReadOnlyContextTool(prompt)).toBe(false);
  });

  it('retains Context research for a read-only question', () => {
    expect(requestsReadOnlyContextTool('Read the documents and quote the opening sentence.')).toBe(true);
  });
});
