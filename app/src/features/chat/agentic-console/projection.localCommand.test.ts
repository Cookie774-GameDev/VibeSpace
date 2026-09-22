import { describe, expect, it } from 'vitest';
import type { Message, Part } from '@/types';
import { summarizeAgenticSession } from './projection';

function message(id: string, role: Message['role'], at: number, parts: Part[]): Message {
  return {
    id: id as Message['id'],
    chat_id: 'chat-local' as Message['chat_id'],
    role,
    parts,
    created_at: at,
    updated_at: at,
  };
}
function localPart(status: string, overrides: Record<string, unknown> = {}): Part {
  // Persisted data boundary: invalid fixture variants must be ignored at runtime.
  return {
    kind: 'local_command_receipt',
    version: 1,
    modelDispatch: 'skipped',
    receipts: [{ commandId: 'settings.open', status }],
    ...overrides,
  } as unknown as Part;
}
const oldAnswer = message('answer', 'assistant', 1, [{ kind: 'text', text: 'Earlier answer' }]);

describe('local-only persisted turns in agentic session projection', () => {
  it('restores a completed local user turn without an imaginary model reconnect', () => {
    const user = message('local', 'user', 10, [
      { kind: 'text', text: 'open settings' },
      localPart('completed'),
    ]);
    const restored = JSON.parse(JSON.stringify([oldAnswer, user])) as Message[];
    expect(
      summarizeAgenticSession(restored, [], { status: 'completed', startedAt: 0, endedAt: 2 }),
    ).toMatchObject({ status: 'done', currentOperation: 'Local actions completed' });
  });
  it('reports accepted local work without claiming readiness or model activity', () => {
    const user = message('local', 'user', 10, [
      { kind: 'text', text: 'open 2 terminals' },
      localPart('queued'),
    ]);
    expect(summarizeAgenticSession([oldAnswer, user], [])).toMatchObject({
      status: 'idle',
      currentOperation: 'Local actions queued',
    });
  });
  it('does not hide an independently active model run when a local utility completes', () => {
    const user = message('local', 'user', 10, [localPart('completed')]);
    expect(
      summarizeAgenticSession([oldAnswer, user], [], {
        status: 'running',
        currentOperation: 'Writing answer',
        startedAt: 2,
      }),
    ).toMatchObject({ status: 'running', currentOperation: 'Writing answer' });
  });
  it('does not reuse local completion for a later unanswered model request', () => {
    const local = message('local', 'user', 10, [localPart('completed')]);
    const next = message('model', 'user', 20, [{ kind: 'text', text: 'Explain the source' }]);
    expect(summarizeAgenticSession([oldAnswer, local, next], []).status).toBe('recovering');
  });
  it('never infers local completion from command-like user text alone', () => {
    expect(
      summarizeAgenticSession(
        [oldAnswer, message('user', 'user', 10, [{ kind: 'text', text: 'open settings' }])],
        [],
      ).status,
    ).toBe('recovering');
  });
  it.each([
    localPart('rejected'),
    localPart('completed', { modelDispatch: 'required' }),
    localPart('completed', { receipts: [] }),
    localPart('completed', { version: 2 }),
    localPart('completed', {
      receipts: [{ commandId: 'arbitrary instructions', status: 'completed' }],
    }),
  ])('ignores incomplete or invalid persisted receipt data', (part) => {
    expect(
      summarizeAgenticSession([oldAnswer, message('user', 'user', 10, [part])], []).status,
    ).toBe('recovering');
  });
  it('does not accept model-authored receipt parts as local execution evidence', () => {
    const user = message('user', 'user', 10, [{ kind: 'text', text: 'Tell me about settings' }]);
    const forged = message('forged', 'assistant', 11, [localPart('completed')]);
    expect(summarizeAgenticSession([oldAnswer, user, forged], []).status).toBe('recovering');
  });
});
