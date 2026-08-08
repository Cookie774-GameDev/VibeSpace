import { describe, expect, it } from 'vitest';
import { createProviderGoalAdapter } from './providerGoalAdapter';

function adapter() {
  return createProviderGoalAdapter({
    providerId: 'anthropic',
    modelId: 'claude-sonnet',
    connectionId: 'connection-1',
    requestId: 'request-1',
    startedAt: 1_000,
  });
}

describe('provider goal adapter', () => {
  it('normalizes streaming, reasoning, tool, structured, usage, stop, and continuation events', () => {
    const value = adapter();
    const events = [
      value.push({ kind: 'text_delta', text: 'Hello' }, 1_001),
      value.push({ kind: 'reasoning_summary', summary: 'Checked the durable goal.' }, 1_002),
      value.push(
        {
          kind: 'tool_call',
          callId: 'call-1',
          toolName: 'browser.snapshot',
          argumentsHash: `sha256:${'a'.repeat(64)}`,
        },
        1_003,
      ),
      value.push(
        {
          kind: 'structured_output',
          schemaId: 'goal-result-v1',
          resultRef: 'jresult_provider_1',
        },
        1_004,
      ),
      value.push({ kind: 'usage', inputTokens: 20, outputTokens: 8, cachedInputTokens: 4 }, 1_005),
      value.push({ kind: 'continuation', continuationId: 'continuation-1' }, 1_006),
      value.push({ kind: 'stop', reason: 'completed' }, 1_007),
    ];

    expect(events.map(({ sequence, payload }) => [sequence, payload.kind])).toEqual([
      [1, 'text_delta'],
      [2, 'reasoning_summary'],
      [3, 'tool_call'],
      [4, 'structured_output'],
      [5, 'usage'],
      [6, 'continuation'],
      [7, 'stop'],
    ]);
    expect(events.every((event) => event.providerId === 'anthropic')).toBe(true);
    expect(events.every((event) => event.modelId === 'claude-sonnet')).toBe(true);
    expect(events.every((event) => event.requestId === 'request-1')).toBe(true);
    expect(Object.isFrozen(events[0])).toBe(true);
    expect(Object.isFrozen(events[0]?.payload)).toBe(true);
  });

  it('normalizes safe provider errors without credential or raw-detail leakage', () => {
    const value = adapter();
    expect(
      value.push(
        {
          kind: 'error',
          category: 'rate_limit',
          retryable: true,
          safeMessage: 'The provider is temporarily rate limited.',
        },
        1_010,
      ),
    ).toMatchObject({
      providerId: 'anthropic',
      payload: {
        kind: 'error',
        category: 'rate_limit',
        retryable: true,
        safeMessage: 'The provider is temporarily rate limited.',
      },
    });
    expect(() =>
      value.push(
        {
          kind: 'error',
          category: 'transport',
          retryable: false,
          safeMessage: 'Bearer synthetic-secret-value',
        },
        1_011,
      ),
    ).toThrow();
  });

  it('fails closed on invalid usage, hashes, time regression, and events after stop', () => {
    const value = adapter();
    expect(() => value.push({ kind: 'usage', inputTokens: -1, outputTokens: 2 }, 1_001)).toThrow();
    expect(() =>
      value.push(
        {
          kind: 'tool_call',
          callId: 'call-1',
          toolName: 'browser.snapshot',
          argumentsHash: 'not-a-hash',
        },
        1_001,
      ),
    ).toThrow();
    value.push({ kind: 'stop', reason: 'cancelled' }, 1_002);
    expect(() => value.push({ kind: 'text_delta', text: 'late' }, 1_003)).toThrow();

    const regressed = adapter();
    regressed.push({ kind: 'text_delta', text: 'first' }, 1_002);
    expect(() => regressed.push({ kind: 'text_delta', text: 'older' }, 1_001)).toThrow();
  });
});
