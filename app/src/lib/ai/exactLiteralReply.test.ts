import { describe, expect, it } from 'vitest';
import {
  explicitExactLiteralFromRequest,
  reconcileExplicitExactLiteral,
} from './exactLiteralReply';

describe('explicit exact-literal replies', () => {
  it.each([
    ['TOKEN_SAVER_OK', 'TOKEN-SAVER-OK'],
    ['FINAL_BOSS_OK', 'FINAL BOSS OK!'],
    ['FINAL_BOSS_OK', '  FINAL_BOSS_OK...  '],
  ])('restores %s from separator/punctuation equivalent %s', (literal, response) => {
    expect(reconcileExplicitExactLiteral(`Reply with exactly: ${literal}`, response)).toBe(literal);
  });

  it.each([
    ['lowercase wrapper', 'here is TOKEN-SAVER-OK'],
    ['mixed-case wrapper', 'Result: TOKEN-SAVER-OK'],
    ['refusal', 'I cannot comply, but TOKEN-SAVER-OK'],
    ['emoji', 'TOKEN-SAVER-OK ✅'],
    ['unexpected symbol', 'TOKEN/SAVER/OK'],
    ['extra identifier', 'TOKEN-SAVER-OK EXTRA'],
    ['action syntax', 'TOKEN-SAVER-OK ```action```'],
    ['multiline content', 'TOKEN-SAVER-OK\nDone'],
  ])('does not erase a %s', (_name, response) => {
    expect(reconcileExplicitExactLiteral('Reply with exactly: TOKEN_SAVER_OK', response)).toBe(
      response,
    );
  });

  it('detects only one unambiguous uppercase underscore-delimited request literal', () => {
    expect(
      explicitExactLiteralFromRequest('Return exactly FINAL_BOSS_OK after checking twice.'),
    ).toBe('FINAL_BOSS_OK');
    expect(explicitExactLiteralFromRequest('Explain exactly why this works.')).toBeNull();
    expect(
      explicitExactLiteralFromRequest(
        'Reply with exactly: FIRST_TOKEN and return exactly SECOND_TOKEN.',
      ),
    ).toBeNull();
  });
});
