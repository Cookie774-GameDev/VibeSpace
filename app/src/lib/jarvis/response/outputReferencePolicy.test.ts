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

  it('preserves technical slash compounds beside an asserted output location', () => {
    const text =
      'Created `index.html` (532 lines, self-contained, inline CSS/JS, zero external/assets assets) in `case-01-neon-dodge/vibespace`.';
    const result = assess(text);

    expect(result.text).toContain('CSS/JS');
    expect(result.text).toContain('external/assets');
    expect(result.text).not.toContain('case-01-neon-dodge/vibespace');
    expect(result.violationCodes).toEqual(['unverified_output_location:0']);
  });

  it('does not combine a descriptive produced claim with a relative source path', () => {
    const text =
      'The project has produced a broad feature surface: shared docs/Canvas.md content and connectors.';
    expect(assess(text)).toMatchObject({ text, violationCodes: [] });
  });

  it('retains direct reverse and absolute output-location claims', () => {
    const describedFile = assess('Created the new file output/report.txt.');
    expect(describedFile.text).not.toContain('output/report.txt');
    expect(describedFile.violationCodes).toEqual(['unverified_output_location:0']);

    const relative = assess('reports/output was created.');
    expect(relative.text).not.toContain('reports/output');
    expect(relative.violationCodes).toEqual(['unverified_output_location:0']);

    const absolutePath = 'C:\\workspace\\reports\\out.md';
    const absolute = assess(`Created ${absolutePath}.`);
    expect(absolute.text).not.toContain(absolutePath);
    expect(absolute.violationCodes).toEqual(['unverified_output_location:0']);
  });
});

describe('descriptive slash compounds are prose rather than output locations', () => {
  it.each([
    'Heavy export I/O may starve indexing while an archive is streamed.',
    'Concurrent export I/O may still starve indexing or interactive work.',
    'Publish inclusion/exclusion definitions before reviewing the release.',
    'Describe input/output terminology and review the tradeoffs.',
  ])('preserves a descriptive noun use exactly: %s', (text) => {
    expect(assess(text)).toMatchObject({ text, violationCodes: [] });
  });

  it.each([
    'Created I/O.',
    'Saved inclusion/exclusion.',
    'Published inclusion/exclusion definitions.',
    'Produced inclusion/exclusion definitions.',
    'I produced input/output terminology.',
    'I/O was created.',
    'inclusion/exclusion was saved.',
    'Publish `inclusion/exclusion` definitions.',
    'Publish "inclusion/exclusion" definitions.',
    'Publish inclusion/exclusion.txt definitions.',
    'Publish ./inclusion/exclusion definitions.',
    'Publish /inclusion/exclusion definitions.',
    'Publish inclusion\\exclusion definitions.',
    'Publish reports/output definitions.',
    'Publish the file inclusion/exclusion definitions.',
    'Saved the report at inclusion/exclusion definitions.',
    'Created reports/output.',
  ])('retains unverified real-path and completed-output protection: %s', (text) => {
    const result = assess(text);
    expect(result.text).toContain('[unverified output location omitted]');
    expect(result.violationCodes).toContain('unverified_output_location:0');
  });

  it.each(['public', 'private', 'restricted', 'secret'] as const)(
    'retains existing %s source-reference permission semantics',
    (sensitivity) => {
      const text = 'Created C:\\workspace\\reports\\out.md.';
      const result = enforceJarvisOutputReferencePolicy(tokenizeJarvisResponse(text), [
        {
          id: 'synthetic-output',
          kind: 'artifact',
          label: 'Synthetic output',
          uri: 'C:\\workspace\\reports\\out.md',
          accountId: 'synthetic-account',
          trust: 'app_verified',
          sensitivity,
        },
      ]);
      const displayed = restoreJarvisStructuredRegions(
        result.proseWithPlaceholders,
        result.structuredRegions,
      );
      if (sensitivity === 'restricted' || sensitivity === 'secret') {
        expect(displayed).toContain('[unverified output location omitted]');
        expect(result.violationCodes).toContain('unverified_output_location:0');
      } else {
        expect(displayed).toBe(text);
        expect(result.violationCodes).toEqual([]);
      }
    },
  );
});
