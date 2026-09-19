import { describe, expect, it } from 'vitest';
import { liveTurnPresentationKey, selectedModelPreview } from './ChatThread';
import { reduceTurn } from './runtime/turn/turnReducer';

describe('selected model session preview', () => {
  it('does not invalidate the heavy chat shell for text-only preview revisions', () => {
    const identity = {
      accountId: 'account',
      chatId: 'chat',
      runId: 'run',
      requestId: 'request',
      attempt: 1,
    };
    let turn = reduceTurn(undefined, { type: 'turn.accepted', identity, at: 1 });
    turn = reduceTurn(turn, { type: 'turn.running', at: 2 });
    const before = liveTurnPresentationKey(turn);
    turn = reduceTurn(turn, {
      type: 'public.snapshot',
      at: 3,
      snapshot: {
        text: 'Fast public text',
        segments: [{ kind: 'text', id: 'text', text: 'Fast public text' }],
        updatedAt: 3,
      },
    });
    expect(liveTurnPresentationKey(turn)).toBe(before);

    turn = reduceTurn(turn, {
      type: 'provider.error',
      at: 4,
      error: { message: 'Provider busy', code: 'busy' },
    });
    expect(liveTurnPresentationKey(turn)).not.toBe(before);
  });

  it('prefers the newly selected exact model over the previous run model', () => {
    expect(
      selectedModelPreview(
        {
          mode: 'single',
          providerId: 'google',
          modelId: 'google/gemini-2.5-flash',
          connectionId: 'opencode-cli',
          connectionMode: 'external-cli',
          authSource: 'opencode-cli-session',
          capabilities: {
            text: true,
            images: false,
            files: true,
            tools: true,
            modelSelection: true,
            structuredOutput: false,
            streaming: true,
            cancellation: true,
            resumeSession: true,
            systemPrompt: true,
            workingDirectory: true,
            usage: true,
            subscriptionQuota: false,
            localOnly: false,
          },
        },
        'deepseek/deepseek-v3.2',
      ),
    ).toBe('google/gemini-2.5-flash');
  });
});
