import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenCodeApprovalAcknowledgements } from './OpenCodeApprovalAcknowledgement';

const binding = {
  generation: 'generation-1',
  sessionId: 'session-1',
  approvalId: 'approval-1',
  response: 'once' as const,
};
const event = (properties = {}) => ({
  type: 'permission.replied',
  properties: {
    sessionID: binding.sessionId,
    requestID: binding.approvalId,
    reply: binding.response,
    ...properties,
  },
});

afterEach(() => vi.useRealTimers());
describe('OpenCode approval acknowledgments', () => {
  it('accepts exact SSE acknowledgment while the HTTP reply is still pending, without replay', async () => {
    const acknowledgments = new OpenCodeApprovalAcknowledgements();
    const send = vi.fn(() => new Promise<void>(() => {}));
    const acknowledged = vi.fn();
    const result = acknowledgments.execute(binding, send, acknowledged);
    acknowledgments.observe(binding.generation, event());
    await expect(result).resolves.toBeUndefined();
    expect(acknowledged).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledOnce();
    await acknowledgments.execute(binding, send, acknowledged);
    expect(send).toHaveBeenCalledOnce();
  });

  it('waits for an exact acknowledgment after an uncertain HTTP timeout', async () => {
    vi.useFakeTimers();
    const acknowledgments = new OpenCodeApprovalAcknowledgements();
    const send = vi.fn(async () => {
      throw new Error('OpenCode native request timed out.');
    });
    const result = acknowledgments.execute(binding, send, vi.fn());
    await vi.advanceTimersByTimeAsync(10_000);
    acknowledgments.observe(binding.generation, event());
    await expect(result).resolves.toBeUndefined();
    expect(send).toHaveBeenCalledOnce();
  });

  it.each([
    ['another generation', 'generation-2', {}],
    ['another session', binding.generation, { sessionID: 'session-2' }],
    ['another request', binding.generation, { requestID: 'approval-2' }],
    ['a different decision', binding.generation, { reply: 'reject' }],
  ])('does not treat %s as acknowledgment', async (_, generation, properties) => {
    vi.useFakeTimers();
    const acknowledgments = new OpenCodeApprovalAcknowledgements();
    const send = vi.fn(async () => {
      throw new Error('OpenCode native request timed out.');
    });
    const acknowledged = vi.fn();
    const result = acknowledgments.execute(binding, send, acknowledged).catch((error) => error);
    acknowledgments.observe(generation, event(properties));
    await vi.advanceTimersByTimeAsync(30_001);
    expect(await result).toMatchObject({ message: expect.stringMatching(/outcome is unknown/i) });
    expect(acknowledged).not.toHaveBeenCalled();
    await expect(acknowledgments.execute(binding, send, acknowledged)).rejects.toThrow(
      /outcome is unknown/i,
    );
    expect(send).toHaveBeenCalledOnce();
  });

  it('reconciles a late exact acknowledgment after the bounded wait without another POST', async () => {
    vi.useFakeTimers();
    const acknowledgments = new OpenCodeApprovalAcknowledgements();
    const send = vi.fn(async () => {
      throw new Error('OpenCode native request timed out.');
    });
    const acknowledged = vi.fn();
    const result = acknowledgments.execute(binding, send, acknowledged).catch((error) => error);
    await vi.advanceTimersByTimeAsync(30_001);
    expect(await result).toBeInstanceOf(Error);
    acknowledgments.observe(binding.generation, event());
    await expect(acknowledgments.execute(binding, send, acknowledged)).resolves.toBeUndefined();
    expect(send).toHaveBeenCalledOnce();
    expect(acknowledged).toHaveBeenCalledOnce();
  });

  it('does not infer acknowledgment from permission disappearance or an explicit rejection', async () => {
    const acknowledgments = new OpenCodeApprovalAcknowledgements();
    const acknowledged = vi.fn();
    const result = acknowledgments.execute(
      binding,
      async () => {
        throw new Error('OpenCode rejected the approval response.');
      },
      acknowledged,
    );
    acknowledgments.observe(binding.generation, { type: 'permission.updated', properties: {} });
    await expect(result).rejects.toThrow(/rejected/);
    expect(acknowledged).not.toHaveBeenCalled();
  });
});
