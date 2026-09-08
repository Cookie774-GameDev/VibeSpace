import { describe, expect, it, vi } from 'vitest';
import { createCaoChatCommandTransport } from './chatCommandTransport';
import type { ChatRunState } from '@/features/chat/runtime/chatRunState';

function harness() {
  const events = new EventTarget();
  let state: ChatRunState | undefined = { chatId: 'chat-1', status: 'running', cancellationKey: 'turn-1' };
  const sent: { type: string; detail: Record<string, string> }[] = [];
  const publish = (next: ChatRunState) => {
    state = next;
    events.dispatchEvent(new CustomEvent('jarvis:run-state', { detail: next }));
  };
  const dispatch = vi.fn((type: string, detail: Record<string, string>) => {
    sent.push({ type, detail });
    if (type === 'jarvis:cancel') publish({ chatId: 'chat-1', status: 'cancelled', cancellationKey: detail.messageId });
    else publish({ chatId: 'chat-1', status: 'running', cancellationKey: detail.cancellationKey });
  });
  return { sent, publish, dispatch, setState: (value: ChatRunState | undefined) => { state = value; },
    transport: createCaoChatCommandTransport({ events, read: () => state, dispatch, timeoutMs: 50 }),
  };
}

describe('CAO exact chat controls', () => {
  it('cancels only the captured request and requires its acknowledgement', async () => {
    const h = harness();
    expect(await h.transport.execute('cancel', 'chat-1', 'turn-1', 'resume-1', new AbortController().signal, async () => {})).toBe('cancelled');
    expect(h.sent).toEqual([{ type: 'jarvis:cancel', detail: { chatId: 'chat-1', messageId: 'turn-1' } }]);
  });
  it('restarts by stopping the captured turn then resuming its retained session', async () => {
    const h = harness();
    expect(await h.transport.execute('restart', 'chat-1', 'turn-1', 'resume-1', new AbortController().signal, async () => {})).toBe('resumed');
    expect(h.sent.map(x => x.type)).toEqual(['jarvis:cancel', 'jarvis:resume']);
    expect(h.sent[1]?.detail.cancellationKey).toBe('resume-1');
  });
  it('does not stop a replacement request', async () => {
    const h = harness(); h.setState({ chatId: 'chat-1', status: 'running', cancellationKey: 'turn-2' });
    await expect(h.transport.execute('restart', 'chat-1', 'turn-1', 'resume-1', new AbortController().signal, async () => {})).rejects.toThrow('cao_control_turn_changed');
    expect(h.sent).toHaveLength(0);
  });
  it('rechecks permission after cancellation and before resuming', async () => {
    const h = harness(); let checks = 0;
    await expect(h.transport.execute('restart', 'chat-1', 'turn-1', 'resume-1', new AbortController().signal, async () => { if (++checks === 2) throw Error('revoked'); })).rejects.toThrow('revoked');
    expect(h.sent.map(x => x.type)).toEqual(['jarvis:cancel']);
  });
  it('rejects an unrelated acknowledgement and never broadens cancellation', async () => {
    const h = harness(); h.dispatch.mockImplementation(() => h.publish({ chatId: 'other', status: 'cancelled', cancellationKey: 'turn-1' }));
    await expect(h.transport.execute('cancel', 'chat-1', 'turn-1', 'resume-1', new AbortController().signal, async () => {})).rejects.toThrow('cao_control_acknowledgement_unavailable');
    expect(h.dispatch).toHaveBeenCalledTimes(1);
  });
  it('does not dispatch after cancellation', async () => {
    const h = harness(); const aborter = new AbortController(); aborter.abort();
    await expect(h.transport.execute('cancel', 'chat-1', 'turn-1', 'resume-1', aborter.signal, async () => {})).rejects.toThrow();
    expect(h.sent).toHaveLength(0);
  });
});
