import { describe, expect, it } from 'vitest';
import type { Message } from '@/types';
import { buildLocalTurnReceipt, localTurnOutcome } from './localTurnReceipt';

function user(parts: Message['parts']): Message {
  return {
    id: 'local' as Message['id'],
    chat_id: 'chat' as Message['chat_id'],
    role: 'user',
    parts,
    created_at: 1,
    updated_at: 1,
  };
}
describe('durable local-only receipt', () => {
  it('stores only canonical status and command ids, with no generated answer', () => {
    const input = {
      commandId: 'settings.open',
      status: 'completed',
      payload: 'private prompt',
      targetIds: ['internal'],
      correlationId: 'private',
    };
    const parts = buildLocalTurnReceipt([input]);
    expect(parts).toEqual([
      {
        kind: 'local_command_receipt',
        version: 1,
        modelDispatch: 'skipped',
        receipts: [{ commandId: 'settings.open', status: 'completed' }],
      },
    ]);
    expect(localTurnOutcome(user(JSON.parse(JSON.stringify(parts))))).toBe('completed');
    expect(JSON.stringify(parts)).not.toContain('private');
  });
  it('preserves queued acceptance instead of claiming terminal readiness', () => {
    expect(
      localTurnOutcome(
        user(buildLocalTurnReceipt([{ commandId: 'terminal.open', status: 'queued' }])),
      ),
    ).toBe('queued');
  });
  it('never manufactures success for empty, failed, pending, or malformed receipts', () => {
    expect(buildLocalTurnReceipt([])).toEqual([]);
    for (const status of [
      'needs_confirmation',
      'needs_clarification',
      'rejected',
      'timed_out',
      undefined,
    ]) {
      expect(buildLocalTurnReceipt([{ commandId: 'settings.open', status }])).toEqual([]);
    }
    expect(
      buildLocalTurnReceipt([{ commandId: 'free text to inject', status: 'completed' }]),
    ).toEqual([]);
    expect(
      buildLocalTurnReceipt([
        { commandId: 'settings.open', status: 'completed' },
        { commandId: 'terminal.open', status: 'rejected' },
      ]),
    ).toEqual([]);
  });
});
