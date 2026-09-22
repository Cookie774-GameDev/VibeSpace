import { describe, expect, it } from 'vitest';
import { requestsReadOnlyContextTool } from './contextToolIntent';

describe('ordinary file and HTML work', () => {
  it.each([
    'Read only the CLI source file you created for this inventory tool. State the exact exit code for invalid input and name the exported parser. Do not edit any files.',
    'Read the configuration file and explain the timeout.',
    'Read the file you wrote and report its exported functions.',
  ])('retains native tools for working source files: %s', (prompt) => {
    expect(requestsReadOnlyContextTool(prompt)).toBe(false);
  });

  it('keeps explicitly requested source-file Context research', () => {
    expect(requestsReadOnlyContextTool('Search the Context Map for the CLI source file.')).toBe(true);
  });
  it.each([
    'Use request_user_input to ask Short or Detailed. Wait for my selection; do not read more files or run commands.',
    'Ask me to choose Blue or Green. Never search the documents.',
    'Please wait for my answer without reading files.',
  ])('does not turn a forbidden file read into Context research: %s', (prompt) => {
    expect(requestsReadOnlyContextTool(prompt)).toBe(false);
  });

  it.each([
    'Read these files and make me another HTML quickly.',
    'Read the documents and build a page from them.',
    'Read these files and generate an HTML preview.',
  ])('keeps execution tools for %s', (prompt) => {
    expect(requestsReadOnlyContextTool(prompt)).toBe(false);
  });

  it('retains the full catalog for an unnamed read-only file question', () => {
    expect(requestsReadOnlyContextTool('Read the documents and quote the opening sentence.')).toBe(false);
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
