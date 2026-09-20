import { describe, expect, it } from 'vitest';
import {
  buildCodexGoalSetRequest,
  parseCodexGoalObjective,
  validateCodexGoalSetResult,
} from './codexGoalCommand';

describe('native Codex goal commands', () => {
  it('accepts only a whole leading command and retains a multiline objective', () => {
    expect(parseCodexGoalObjective('/goal Build a game\nthen test it')).toBe(
      'Build a game\nthen test it',
    );
    expect(parseCodexGoalObjective('Explain /goal to me')).toBeUndefined();
    expect(parseCodexGoalObjective('/goals')).toBeUndefined();
  });
  it.each(['/goal', '/goal   ', '/goal bad\u0000input'])(
    'rejects malformed command %j',
    (prompt) => {
      expect(() => parseCodexGoalObjective(prompt)).toThrow('Use /goal <objective>');
    },
  );
  it('sets the actual thread goal without inventing a token budget', () => {
    expect(buildCodexGoalSetRequest('req_goal', 'thread_1', 'Build a game')).toEqual({
      id: 'req_goal',
      method: 'thread/goal/set',
      params: { threadId: 'thread_1', objective: 'Build a game', status: 'active' },
    });
    expect(() =>
      validateCodexGoalSetResult(
        { goal: { threadId: 'thread_1', objective: 'Build a game', status: 'active' } },
        'thread_1',
        'Build a game',
      ),
    ).not.toThrow();
    expect(() =>
      validateCodexGoalSetResult(
        { goal: { threadId: 'other', objective: 'Build a game', status: 'active' } },
        'thread_1',
        'Build a game',
      ),
    ).toThrow('did not confirm');
  });
});
