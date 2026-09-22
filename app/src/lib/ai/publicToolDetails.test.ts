import { describe, expect, it } from 'vitest';
import {
  MAX_PUBLIC_TOOL_OUTPUT_BYTES,
  mergePublicToolDetails,
  openCodeToolDetails,
  publicToolDetails,
  publicToolOutput,
} from './publicToolDetails';

describe('public tool detail safety and merging', () => {
  it('retains complete structured search results beyond the old preview node and item caps', () => {
    const records = Array.from({ length: 300 }, (_, index) => ({
      title: `Source file ${index}`, path: `src/file-${index}.ts`,
      pointer: { start: index, end: index + 1 }, preview: `Line ${index}`,
    }));
    const result = { records, total: 300, finalMarker: 'END OF RESULTS' };
    const details = publicToolDetails({ result });
    expect(details.result).toEqual(result);
    expect(details.truncated).toBeUndefined();
  });
  it('retains a wide ordinary result while still redacting credentials near its end', () => {
    const fields = Object.fromEntries(Array.from({ length: 300 }, (_, index) => [`field${index}`, index]));
    const details = publicToolDetails({ result: { ...fields, password: 'do-not-display' } });
    expect(details.result).toEqual({ ...fields, password: '[redacted: credentials]' });
    expect(details.redacted).toBe(true);
    expect(details.truncated).toBeUndefined();
  });
  it('retains ordinary large tool payloads beyond the old inline preview limits', () => {
    const content = 'export const score = 1;\n'.repeat(4_000) + '// FINAL FILE LINE';
    const output = 'verified game behavior\n'.repeat(4_000) + 'FINAL OUTPUT LINE';
    const diff = '+export const score = 1;\n'.repeat(4_000) + '+// FINAL DIFF LINE';
    const details = publicToolDetails({ arguments: { content }, output,
      changes: [{ path: 'game.ts', kind: 'add', diff }] });
    expect(details.arguments).toEqual({ content });
    expect(details.output).toMatchObject({ text: output, complete: true, omittedBytes: 0 });
    expect(details.changes?.[0]).toMatchObject({ diff, complete: true });
    expect(details.truncated).toBeUndefined();
  });
  it('preserves OpenCode edit lines when the provider omits explicit diff metadata', () => {
    const details = openCodeToolDetails('edit', {
      status: 'completed',
      input: {
        filePath: '/workspace/game.html',
        oldString: '<p>old</p>\n<p>old again</p>',
        newString: '<p>new</p>\n<p>new again</p>',
      },
      output: 'Updated game.html',
    });
    expect(details.changes).toEqual([
      expect.objectContaining({
        path: '/workspace/game.html',
        diff: '-<p>old</p>\n-<p>old again</p>\n+<p>new</p>\n+<p>new again</p>',
        complete: true,
      }),
    ]);
  });
  it('keeps OpenCode write content visibly labeled when no before-state exists', () => {
    const content = '<!doctype html>\n' + '<canvas id="game"></canvas>\n'.repeat(2_000);
    const details = openCodeToolDetails('write', {
      status: 'completed',
      input: { filePath: '/workspace/game.html', content },
      output: 'Wrote file successfully.',
    });
    expect(details.changes).toEqual([
      expect.objectContaining({ path: '/workspace/game.html', writtenContent: content, complete: true }),
    ]);
  });
  it('projects a completed OpenCode write with explicit absence into an added-file diff', () => {
    const content = '<!doctype html>\n<canvas id="game"></canvas>\n';
    const details = openCodeToolDetails('write', {
      status: 'completed',
      input: { filePath: '/workspace/game.html', content },
      metadata: { exists: false, truncated: false },
      output: 'Wrote file successfully.',
    });
    expect(details.changes).toEqual([
      expect.objectContaining({
        path: '/workspace/game.html',
        kind: 'add',
        diff: '@@ -0,0 +1,2 @@\n+<!doctype html>\n+<canvas id="game"></canvas>',
        writtenContent: content,
        complete: true,
      }),
    ]);
  });
  it.each([
    [{ exists: true }, 'existing file metadata'],
    [undefined, 'missing file metadata'],
    [{ exists: false, truncated: true }, 'partial write metadata'],
  ] as const)('keeps %s as written content without inferring a new-file diff', (metadata, _description) => {
    const content = 'partial or existing content\n';
    const details = openCodeToolDetails('write', {
      status: 'completed',
      input: { filePath: '/workspace/game.html', content },
      ...(metadata === undefined ? {} : { metadata }),
      output: 'Wrote file successfully.',
    });
    expect(details.changes).toEqual([
      expect.objectContaining({
        path: '/workspace/game.html',
        kind: 'unknown',
        writtenContent: content,
        complete: true,
      }),
    ]);
    expect(details.changes?.[0]?.diff).toBeUndefined();
  });
  it('keeps an oversized explicit new-file write as bounded content', () => {
    const content = 'x'.repeat(MAX_PUBLIC_TOOL_OUTPUT_BYTES + 1);
    const details = openCodeToolDetails('write', {
      status: 'completed',
      input: { filePath: '/workspace/large.bin', content },
      metadata: { exists: false, truncated: false },
      output: 'Wrote file successfully.',
    });
    expect(details.changes?.[0]).toMatchObject({ path: '/workspace/large.bin', kind: 'unknown' });
    expect(details.changes?.[0]?.diff).toBeUndefined();
    expect(details.truncated).toBe(true);
  });
  it('keeps a truncated diff incomplete when its written content is complete', () => {
    const diff = '+x'.repeat(MAX_PUBLIC_TOOL_OUTPUT_BYTES);
    const details = publicToolDetails({
      changes: [{ path: 'large.txt', kind: 'update', diff, writtenContent: 'complete file content' }],
    });
    expect(details.changes?.[0]).toMatchObject({
      path: 'large.txt',
      diff: expect.any(String),
      writtenContent: 'complete file content',
      complete: false,
    });
  });
  it('does not erase known fields with absent update values', () => {
    expect(
      mergePublicToolDetails({ command: 'node verify.cjs', exitCode: 0 }, { command: undefined }),
    ).toMatchObject({ command: 'node verify.cjs', exitCode: 0 });
  });
  it('replaces partial output with the terminal snapshot exactly once', () => {
    const first = { output: publicToolOutput('one\n', 'append', false) };
    const second = mergePublicToolDetails(first, {
      output: publicToolOutput('two\n', 'append', false),
    });
    expect(second.output?.text).toBe('one\ntwo\n');
    const final = mergePublicToolDetails(second, { output: publicToolOutput('one\ntwo\n') });
    expect(mergePublicToolDetails(final, final).output?.text).toBe('one\ntwo\n');
    expect(
      mergePublicToolDetails(final, { output: publicToolOutput('late', 'append', false) }).output,
    ).toEqual(final.output);
  });
  it('bounds circular JSON and redacts nested credential keys', () => {
    const input: Record<string, unknown> = { nested: { password: 'hidden' } };
    input.self = input;
    const details = publicToolDetails({ arguments: input });
    expect(details).toMatchObject({ redacted: true, truncated: true });
    expect(JSON.stringify(details)).not.toContain('hidden');
  });
  it('redacts sensitive MCP reference keys before tool details are persisted', () => {
    const details = publicToolDetails({ arguments: {
      accessTokenRef: 'native-secret-ref-should-not-persist',
      clientSecretRef: 'another-native-secret-ref',
      safeInput: 'preserved',
      nested: { refresh_token_ref: 'nested-native-secret-ref' },
    } });
    const serialized = JSON.stringify(details);
    expect(details).toMatchObject({ redacted: true, arguments: {
      accessTokenRef: '[redacted: credentials]',
      clientSecretRef: '[redacted: credentials]',
      safeInput: 'preserved',
      nested: { refresh_token_ref: '[redacted: credentials]' },
    } });
    expect(serialized).not.toContain('native-secret-ref-should-not-persist');
    expect(serialized).not.toContain('another-native-secret-ref');
    expect(serialized).not.toContain('nested-native-secret-ref');
  });
  it('redacts URL credentials and sensitive query values before tool output is persisted', () => {
    const details = publicToolDetails({
      output: 'Open https://report-user:short-url-secret@example.com/report?access_token=short-query-token&view=full',
    });
    const serialized = JSON.stringify(details);
    expect(details.output?.redacted).toBe(true);
    expect(serialized).not.toContain('short-url-secret');
    expect(serialized).not.toContain('short-query-token');
    expect(details.output?.text).toContain('https://example.com/report');
  });
  it('does not evaluate accessor-bearing detail objects', () => {
    let evaluated = false;
    const argumentsValue = Object.defineProperty({} as Record<string, unknown>, 'safeInput', {
      enumerable: true,
      get: () => {
        evaluated = true;
        return 'accessor-secret-should-never-be-read';
      },
    });
    const details = publicToolDetails({ arguments: argumentsValue });
    expect(evaluated).toBe(false);
    expect(details.truncated).toBe(true);
    expect(JSON.stringify(details)).not.toContain('accessor-secret-should-never-be-read');
  });
  it('removes incomplete terminal escape controls', () => {
    expect(publicToolOutput('safe\u001b[31').text).not.toContain('\u001b');
  });
});
