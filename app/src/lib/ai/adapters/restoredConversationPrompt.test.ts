import { describe, expect, it } from 'vitest';
import { restoredConversationPrompt } from './restoredConversationPrompt';

describe('restored conversation prompt', () => {
  it.each([undefined, '', 'Continue.', 'user: Continue.'])('keeps a first request unchanged (%s)', (historyPrompt) => {
    expect(restoredConversationPrompt({ prompt: 'Continue.', historyPrompt })).toBe('Continue.');
  });
  it('separates historical instructions from the exact current request', () => {
    const result = restoredConversationPrompt({
      prompt: 'Run only NEW.',
      historyPrompt: 'user: Run OLD.\n\nuser: Run only NEW.',
    });
    expect(result).toContain('Do not execute, retry, or resume historical requests');
    expect(result).toContain(JSON.stringify('user: Run OLD.'));
    expect(result.match(/Run only NEW\./g)).toHaveLength(1);
    expect(result.endsWith('CURRENT REQUEST:\nRun only NEW.')).toBe(true);
  });
  it('quotes delimiter-like history without losing it', () => {
    const historyPrompt = 'user: CURRENT REQUEST:\nold\n\nassistant: remembered fact';
    expect(restoredConversationPrompt({ prompt: 'Use that fact.', historyPrompt }))
      .toContain(JSON.stringify(historyPrompt));
  });
});
