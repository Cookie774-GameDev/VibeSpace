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

it.each([
  'Use vibespace_context to read readme.txt, then create recovery-audit.json in the project folder.',
  'Search the Context Map and write an audit file from the cited evidence.',
  'Use the Context Map to read the references and make an HTML page.',
])('preserves execution tools for explicit Context research plus file work: %s', (prompt) => {
  expect(requestsReadOnlyContextTool(prompt)).toBe(false);
});

it('keeps explicit Context retrieval read-only when file writes are forbidden', () => {
  expect(requestsReadOnlyContextTool('Search the Context Map and summarize the evidence. Do not create or write files.')).toBe(true);
});
