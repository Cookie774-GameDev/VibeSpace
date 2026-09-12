import { describe, expect, it } from 'vitest';
import { normalizeOpenCodeEvent } from './eventNormalizer';

describe('normalizeOpenCodeEvent', () => {
  it('normalizes an assistant text delta for the expected session', () => {
    expect(
      normalizeOpenCodeEvent(
        {
          type: 'message.part.updated',
          properties: {
            sessionID: 'session-1',
            delta: 'Hello',
            part: { type: 'text' },
          },
        },
        'session-1',
      ),
    ).toEqual([{ type: 'assistant.delta', text: 'Hello' }]);
  });

  it('ignores cross-session and malformed events', () => {
    expect(
      normalizeOpenCodeEvent(
        {
          type: 'message.part.updated',
          properties: {
            sessionID: 'session-2',
            delta: 'not ours',
            part: { type: 'text' },
          },
        },
        'session-1',
      ),
    ).toEqual([]);
    expect(normalizeOpenCodeEvent({ type: 'message.part.updated' }, 'session-1')).toEqual([]);
    expect(normalizeOpenCodeEvent(null, 'session-1')).toEqual([]);
  });

  it('bounds reasoning deltas before exposing them to the UI', () => {
    const text = 'r'.repeat(40_000);

    expect(
      normalizeOpenCodeEvent(
        {
          type: 'message.part.updated',
          properties: {
            sessionID: 'session-1',
            delta: text,
            part: { type: 'reasoning' },
          },
        },
        'session-1',
      ),
    ).toEqual([{ type: 'reasoning.delta', text: 'r'.repeat(32_768) }]);
  });

  it('normalizes lifecycle events and sanitizes session error text', () => {
    expect(
      normalizeOpenCodeEvent(
        {
          type: 'session.compacted',
          properties: { sessionID: 'session-1' },
        },
        'session-1',
      ),
    ).toEqual([{ type: 'context.compacted' }]);
    expect(
      normalizeOpenCodeEvent(
        {
          type: 'session.idle',
          properties: { sessionID: 'session-1' },
        },
        'session-1',
      ),
    ).toEqual([{ type: 'done', finishReason: 'idle' }]);
    expect(
      normalizeOpenCodeEvent(
        {
          type: 'session.status',
          properties: { sessionID: 'session-1', status: { type: 'idle' } },
        },
        'session-1',
      ),
    ).toEqual([{ type: 'done', finishReason: 'idle' }]);
    expect(
      normalizeOpenCodeEvent(
        {
          type: 'session.updated',
          properties: { info: { id: 'session-1', title: 'Chat' } },
        },
        'session-1',
      ),
    ).toEqual([{ type: 'session.updated', sessionId: 'session-1' }]);
    expect(
      normalizeOpenCodeEvent(
        {
          type: 'session.error',
          properties: {
            sessionID: 'session-1',
            error: { message: 'Bearer highly-sensitive-token' },
          },
        },
        'session-1',
      ),
    ).toEqual([{ type: 'error', message: 'Bearer [REDACTED]' }]);
    expect(
      normalizeOpenCodeEvent(
        {
          type: 'session.error',
          properties: {
            sessionID: 'session-1',
            error: { message: 'Token refresh failed: 401' },
          },
        },
        'session-1',
      ),
    ).toEqual([
      {
        type: 'error',
        code: 'HARNESS_AUTH_FAILED',
        message:
          'OpenAI ChatGPT sign-in expired. Reconnect OpenAI with ChatGPT in the OpenCode terminal (/connect), or pick a local model. The connector can still show Connected while the saved refresh token is dead.',
      },
    ]);
  });

  it('normalizes file edits without leaking unbounded paths', () => {
    expect(
      normalizeOpenCodeEvent(
        {
          type: 'file.edited',
          properties: {
            sessionID: 'session-1',
            file: 'a'.repeat(5_000),
          },
        },
        'session-1',
      ),
    ).toEqual([
      {
        type: 'file.changed',
        path: 'a'.repeat(2_048),
        operation: 'edited',
      },
    ]);
    expect(
      normalizeOpenCodeEvent(
        {
          type: 'session.diff',
          properties: {
            sessionID: 'session-1',
            diff: [{ file: 'src/app.ts', before: '', after: 'new' }],
          },
        },
        'session-1',
      ),
    ).toEqual([{ type: 'file.changed', path: 'src/app.ts', operation: 'diff' }]);
  });

  it('normalizes permission and usage events', () => {
    expect(
      normalizeOpenCodeEvent(
        {
          type: 'permission.updated',
          properties: {
            id: 'permission-1',
            sessionID: 'session-1',
            type: 'bash',
            pattern: ['npm test'],
            title: 'Run tests',
            metadata: {},
          },
        },
        'session-1',
      ),
    ).toEqual([
      {
        type: 'approval.requested',
        approval: {
          id: 'permission-1',
          sessionId: 'session-1',
          title: 'Run tests',
          capability: 'bash',
          pattern: ['npm test'],
        },
      },
    ]);
    expect(
      normalizeOpenCodeEvent(
        {
          type: 'message.updated',
          properties: {
            info: {
              sessionID: 'session-1',
              role: 'assistant',
              cost: 0.25,
              tokens: { input: 10, output: 20, reasoning: 3, cache: { read: 4 } },
              providerID: 'anthropic',
              modelID: 'claude',
            },
          },
        },
        'session-1',
      ),
    ).toEqual([
      {
        type: 'usage.updated',
        usage: {
          inputTokens: 10,
          outputTokens: 20,
          cachedTokens: 4,
          reasoningTokens: 3,
          costUsd: 0.25,
          providerId: 'anthropic',
          modelId: 'claude',
        },
      },
    ]);
  });

  it('maps OpenCode tool parts into specialized VibeSpace events', () => {
    expect(
      normalizeOpenCodeEvent(
        {
          type: 'message.part.updated',
          properties: {
            sessionID: 'session-1',
            part: {
              type: 'tool',
              tool: 'bash',
              callID: 'call-1',
              state: {
                status: 'completed',
                input: { command: 'npm test' },
                output: '2 passed',
                metadata: { exit: 0 },
              },
            },
          },
        },
        'session-1',
      ),
    ).toEqual([
      { type: 'shell.output', id: 'call-1', text: '2 passed' },
      { type: 'shell.completed', id: 'call-1', exitCode: 0 },
    ]);
  });
});
