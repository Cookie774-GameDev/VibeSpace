import { describe, expect, it } from 'vitest';
import { enforceJarvisOutputReferencePolicy } from './outputReferencePolicy';
import { restoreJarvisStructuredRegions, tokenizeJarvisResponse } from './tokenizer';

function assess(text: string) {
  const result = enforceJarvisOutputReferencePolicy(tokenizeJarvisResponse(text), []);
  return {
    ...result,
    text: restoreJarvisStructuredRegions(result.proseWithPlaceholders, result.structuredRegions),
  };
}

describe('output location source operands', () => {
  it('preserves historical move and copy sources in a corpus answer', () => {
    const text = 'Fixtures moved from `../targets/dependency_aware/perf/` because tests copying `../targets/` into `/tmp` consumed more than 4G per run.';
    expect(assess(text)).toMatchObject({ text, violationCodes: [] });
  });

  it.each(['copy', 'copies'])('preserves a historical moved-out-of source and %s-into operand', (verb) => {
    const text = `Fixtures were moved out of \`../targets/dependency_aware/perf/\` because a test ${verb} \`../targets/\` into \`/tmp\`, consuming more than 4G per run.`;
    expect(assess(text)).toMatchObject({ text, violationCodes: [] });
  });

  it('does not mistake a completed copy output for a source operand', () => {
    const result = assess('Copied `output/result.txt`.');
    expect(result.text).not.toContain('output/result.txt');
    expect(result.violationCodes).toHaveLength(1);
  });

  it.each(['moved', 'copied'])('retains the %s-from source but rejects an unverified destination', (verb) => {
    const result = assess(`I ${verb} from \`input/source.txt\` to \`output/result.txt\`.`);
    expect(result.text).toContain('`input/source.txt`');
    expect(result.text).not.toContain('output/result.txt');
    expect(result.violationCodes).toHaveLength(1);
  });

  it('still rejects a newly created output and an unverified link', () => {
    const result = assess('Created `output/result.txt`. Download [report](https://example.test/report).');
    expect(result.text).not.toContain('output/result.txt');
    expect(result.text).not.toContain('https://example.test/report');
    expect(result.violationCodes.length).toBeGreaterThanOrEqual(2);
  });
});
