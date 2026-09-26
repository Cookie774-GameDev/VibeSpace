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

describe('Plan 1 structured OpenCode result regression', () => {
  it.each([
    { label: 'object', output: { records: [{ path: 'src/game.ts', lines: [1, 2] }], total: 1 } },
    { label: 'array', output: [{ path: 'first.ts' }, { path: 'last.ts', found: true }] },
    { label: 'false', output: false },
    { label: 'zero', output: 0 },
    { label: 'null', output: null },
  ])('retains $label output in the public Result field', ({ output }) => {
    const details = openCodeToolDetails('mcp_search', {
      status: 'completed', input: { query: 'game' }, output,
    });
    expect(details.result).toEqual(output);
    expect(details.output).toBeUndefined();
    expect(details.truncated).toBeUndefined();
    expect(mergePublicToolDetails(details, openCodeToolDetails('mcp_search', {
      status: 'completed', input: { query: 'game' },
    })).result).toEqual(output);
  });
  it('redacts and bounds structured results before persistence', () => {
    const output: Record<string, unknown> = {
      records: Array.from({ length: 300 }, (_, index) => ({ path: `file-${index}.ts` })),
      password: 'structured-secret-must-not-persist',
    };
    output.self = output;
    const details = openCodeToolDetails('mcp_search', { status: 'completed', output });
    expect(details.result).toMatchObject({
      records: output.records,
      password: '[redacted: credentials]',
      self: '[omitted: circular value]',
    });
    expect(details).toMatchObject({ redacted: true, truncated: true });
    expect(JSON.stringify(details)).not.toContain('structured-secret-must-not-persist');
  });
  it('omits internal Context receipts identically for JSON text and structured output', () => {
    const envelope = {
      requestId: 'private-request',
      data: { receiptId: 'private-receipt', scopeRevision: 'private-scope', records: [{ title: 'Public result' }] },
      ok: true,
    };
    const expected = { data: { records: [{ title: 'Public result' }] }, ok: true };
    const details = openCodeToolDetails('vibespace_context', { status: 'completed', output: envelope });
    expect(details.result).toEqual(expected);
    expect(details.redacted).toBe(true);
    const text = openCodeToolDetails('vibespace_context', { status: 'completed', output: JSON.stringify(envelope) });
    expect(JSON.parse(text.output!.text)).toEqual(expected);
    expect(JSON.stringify(details)).not.toMatch(/private-(request|receipt|scope)/);
  });
  it('does not evaluate result accessors', () => {
    let reads = 0;
    const output = Object.defineProperty({}, 'content', {
      enumerable: true, get() { reads++; return 'private-accessor-value'; },
    });
    const details = openCodeToolDetails('mcp_search', { status: 'completed', output });
    expect(reads).toBe(0);
    expect(details.result).toBe('[unavailable]');
    expect(details.truncated).toBe(true);
    expect(JSON.stringify(details)).not.toContain('private-accessor-value');
  });
});


describe('native per-file patch metadata', () => {
  it('retains each actual OpenCode patch without assigning the aggregate diff to every file', () => {
    const first = '@@ -0,0 +1,2 @@\n+first line\n+last line';
    const second = '@@ -1 +1 @@\n-old value\n+new value';
    const details = openCodeToolDetails('apply_patch', {
      status: 'completed', input: { patchText: 'bounded native patch input' }, output: 'Updated two files',
      metadata: { diff: first + '\n' + second, files: [
        { filePath: 'first.ts', type: 'add', patch: first },
        { filePath: 'second.ts', type: 'update', patch: second },
      ] },
    });
    expect(details.changes).toEqual([
      { path: 'first.ts', kind: 'add', diff: first, complete: true },
      { path: 'second.ts', kind: 'update', diff: second, complete: true },
    ]);
    expect(details.truncated).toBeUndefined();
  });
  it('keeps canonical diff precedence and absent per-file evidence visibly incomplete', () => {
    const details = openCodeToolDetails('apply_patch', { status: 'completed', metadata: {
      diff: 'aggregate must not be guessed onto a file', files: [
        { path: 'known.ts', type: 'update', diff: '-old\n+new', patch: 'alternate must not replace canonical' },
        { path: 'missing.ts', type: 'update' },
      ],
    } });
    expect(details.changes).toEqual([
      { path: 'known.ts', kind: 'update', diff: '-old\n+new', complete: true },
      { path: 'missing.ts', kind: 'update', complete: false },
    ]);
  });
  it('passes native patch aliases through the existing redaction boundary', () => {
    const patch = '+https://fixture-user:synthetic-private-value@example.com/result?access_token=synthetic-query-value';
    const details = openCodeToolDetails('apply_patch', { status: 'completed', metadata: {
      files: [{ filePath: 'result.txt', type: 'add', patch }],
    } });
    expect(details.changes?.[0]?.diff).toContain('https://example.com/result');
    expect(JSON.stringify(details)).not.toContain('synthetic-private-value');
    expect(JSON.stringify(details)).not.toContain('synthetic-query-value');
    expect(details.redacted).toBe(true);
  });
  it('marks oversized native patches incomplete under the unchanged byte cap', () => {
    const patch = '+x'.repeat(MAX_PUBLIC_TOOL_OUTPUT_BYTES);
    const details = openCodeToolDetails('apply_patch', { status: 'completed', metadata: {
      files: [{ filePath: 'large.txt', type: 'add', patch }],
    } });
    expect(details.changes?.[0]?.diff?.startsWith('+x')).toBe(true);
    expect(new TextEncoder().encode(details.changes?.[0]?.diff).length).toBeLessThanOrEqual(MAX_PUBLIC_TOOL_OUTPUT_BYTES);
    expect(details.changes?.[0]?.complete).toBe(false);
    expect(details.truncated).toBe(true);
  });
});


describe('nested Context result privacy', () => {
  it.each(['object', 'JSON text'] as const)('omits transport fields throughout a %s result without removing citations', format => {
    const envelope = {
      response: { result: {
        is_error: true, code: 'context_unavailable', requestId: 'private-nested-request',
        data: { receiptId: 'private-nested-receipt', scopeRevision: 'private-nested-scope',
          records: [{ title: 'Known source', citation: 'ctx://fixture/source#L1-L4' }],
          related: [{ requestId: 'private-array-request', message: 'Public detail' }],
        },
      } },
    };
    const details = openCodeToolDetails('vibespace_context', {
      status: 'completed', output: format === 'JSON text' ? JSON.stringify(envelope) : envelope,
    });
    const result = format === 'JSON text' ? JSON.parse(details.output!.text) : details.result;
    expect(result).toEqual({ response: { result: {
      is_error: true, code: 'context_unavailable', data: {
        records: [{ title: 'Known source', citation: 'ctx://fixture/source#L1-L4' }],
        related: [{ message: 'Public detail' }],
      },
    } } });
    expect(details.redacted).toBe(true);
    expect(details.truncated).toBeUndefined();
    expect(JSON.stringify(details)).not.toMatch(/private-(nested|array)-/);
  });
  it('retains ordinary non-Context request identifiers and arguments', () => {
    const output = { response: { requestId: 'public-job-request', receiptId: 'public-job-receipt', count: 4 } };
    expect(openCodeToolDetails('mcp_job_status', {
      status: 'completed', input: { requestId: 'requested-job' }, output,
    })).toMatchObject({ arguments: { requestId: 'requested-job' }, result: output });
  });
  it('keeps the existing cycle bound while omitting nested Context transport fields', () => {
    const output: Record<string, unknown> = { response: { requestId: 'private-cycle-request', answer: 'Public answer' } };
    output.self = output;
    const details = openCodeToolDetails('vibespace_context', { status: 'completed', output });
    expect(details).toMatchObject({ redacted: true, truncated: true,
      result: { response: { answer: 'Public answer' }, self: '[omitted: circular value]' } });
    expect(JSON.stringify(details)).not.toContain('private-cycle-request');
  });
  it('never evaluates nested Context accessors in an otherwise serializable result', () => {
    let reads = 0;
    const nested = Object.defineProperty({}, 'requestId', {
      enumerable: true, get() { reads++; return 'private-getter-request'; },
    });
    const details = openCodeToolDetails('vibespace_context', {
      status: 'completed', output: { response: { nested } },
    });
    expect(reads).toBe(0);
    expect(details.truncated).toBe(true);
    expect(JSON.stringify(details)).not.toContain('private-getter-request');
  });
});
