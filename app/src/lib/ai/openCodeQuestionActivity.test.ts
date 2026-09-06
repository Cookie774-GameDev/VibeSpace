import { describe, expect, it, vi } from 'vitest';
import { questionEventsWithActivity } from './openCodeQuestionActivity';
import type { ProviderEvent } from './adapters/types';

const question: Extract<ProviderEvent, { type: 'question' }> = {
  type: 'question',
  request: {
    id: 'question-1',
    sessionId: 'session-1',
    questions: [],
    tool: { messageId: 'message-1', callId: 'private-call-1' },
  },
};
describe('immediate native question activity', () => {
  it('projects the tool before the question using the same private-safe lifecycle identity', () => {
    const seen = new Set<string>();
    const observed = vi.fn();
    const events = questionEventsWithActivity(question, () => 'opencode-tool-1', seen, observed);
    expect(events).toEqual([
      { type: 'tool', name: 'question', status: 'started', callId: 'opencode-tool-1' },
      question,
    ]);
    expect(seen.has('opencode-tool-1:started')).toBe(true);
    expect(questionEventsWithActivity(question, () => 'opencode-tool-1', seen, observed)).toEqual([
      question,
    ]);
    expect(observed).toHaveBeenCalledOnce();
  });
  it('does not duplicate an already observed start or invent missing tool identity', () => {
    expect(
      questionEventsWithActivity(
        question,
        () => 'opencode-tool-1',
        new Set(['opencode-tool-1:started']),
      ),
    ).toEqual([question]);
    const withoutTool = { ...question, request: { ...question.request, tool: undefined } };
    expect(
      questionEventsWithActivity(
        withoutTool,
        () => {
          throw Error('must not call');
        },
        new Set(),
      ),
    ).toEqual([withoutTool]);
  });
});
