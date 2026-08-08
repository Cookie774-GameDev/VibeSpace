import { describe, expect, it } from 'vitest';
import { parseSecondBrainProposal, secondBrainMarkdownUpdate } from './nightlySecondBrainRuntime';

describe('nightly second-brain production runtime helpers', () => {
  it('accepts only bounded proposals with real source provenance', () => {
    expect(
      parseSecondBrainProposal(
        'prefix {"updates":[{"target":"related_markdown","content":"Remember the launch checklist.","provenance":["chat:1"],"confidence":0.9}]} suffix',
        new Set(['chat:1']),
      ),
    ).toEqual([
      {
        target: 'related_markdown',
        content: 'Remember the launch checklist.',
        provenance: ['chat:1'],
        confidence: 0.9,
      },
    ]);
  });

  it('deduplicates markdown facts instead of rewriting the document', () => {
    const before = '# Second Brain\n\n- Keep builds green.\n';
    expect(secondBrainMarkdownUpdate(before, 'Keep builds green.')).toBe(before);
    expect(secondBrainMarkdownUpdate(before, 'Ship the accessibility pass.')).toContain(
      '- Ship the accessibility pass.',
    );
  });
});
