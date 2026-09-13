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
  it('removes incomplete terminal escape controls', () => {
    expect(publicToolOutput('safe\u001b[31').text).not.toContain('\u001b');
  });
});
