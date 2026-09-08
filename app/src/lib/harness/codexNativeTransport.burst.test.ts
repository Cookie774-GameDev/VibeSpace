import { expect, it, vi } from 'vitest';
import { nativeCodexFrames } from './codexNativeTransport';

async function consume(frames: Record<string, unknown>[]) {
  let deliver: (value: unknown) => void;
  const invoke = vi.fn(async (command: string) => {
    if (command === 'codex_app_server_stream') {
      frames.forEach(frame => deliver({ kind: 'frame', frame }));
      deliver({ kind: 'done' });
    }
  });
  const result = [];
  for await (const frame of nativeCodexFrames('generation-1', undefined, async () => ({
    invoke, channel(handler) { deliver = handler; return { onmessage: handler }; },
  }))) result.push(frame);
  return result;
}
const delta = (text: string, itemId = 'item-1') => ({ method: 'item/agentMessage/delta',
  params: { threadId: 'thread-1', turnId: 'turn-1', itemId, delta: text } });
it('preserves a burst of adjacent text deltas and its terminal receipt within the existing queue bound', async () => {
  const end = { method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } } };
  const result = await consume([...Array.from({ length: 1024 }, () => delta('word ')), end]);
  expect(result).toEqual([delta('word '.repeat(1024)), end]);
});
it('does not merge across item identities, approval frames, or RPC identifiers', async () => {
  const frames = [delta('a'), delta('b', 'item-2'), { id: 7, method: 'item/commandExecution/requestApproval', params: {} },
    delta('c', 'item-2'), { id: 8, ...delta('d', 'item-2') }];
  expect(await consume(frames)).toEqual(frames);
});
it('keeps the byte limit when adjacent deltas can be merged', async () => {
  await expect(consume([delta('a'.repeat(4 * 1024 * 1024)), delta('b'.repeat(4 * 1024 * 1024))]))
    .rejects.toThrow('queue exceeded safe limits');
});
