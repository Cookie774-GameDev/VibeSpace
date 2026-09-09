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

  it.each([
    'Read C:\\references\\notes.txt as reference data and give three facts.',
    'Please read "/home/user/notes.txt" and summarize the file.',
    'Read this exact file directly with the native read tool: C:\\references\\notes.txt. It is outside the Context Map; do not substitute that map.',
  ])('preserves a direct filesystem read: %s', (prompt) => {
    expect(requestsReadOnlyContextTool(prompt)).toBe(false);
  });

  it('retains explicit mapped-file research even when it mentions a disk path', () => {
    expect(requestsReadOnlyContextTool(
      'Search the Context Map for documents about C:\\references\\notes.txt.',
    )).toBe(true);
  });
});
