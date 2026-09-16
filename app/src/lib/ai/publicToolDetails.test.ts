import { describe, expect, it } from 'vitest';
import { mergePublicToolDetails, publicToolDetails, publicToolOutput } from './publicToolDetails';

describe('public tool detail safety and merging', () => {
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
