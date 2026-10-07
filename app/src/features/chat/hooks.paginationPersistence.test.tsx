import 'fake-indexeddb/auto';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createJarvisDb, type JarvisDexie } from '@/lib/db/database';
import { TEST_INDEXED_DB, uniqueTestDbName } from '@/test/indexedDb';
import type { ChatId, Message, MessageId } from '@/types';

const fixture = vi.hoisted(() => ({ database: null as JarvisDexie | null }));
// Only select the isolated database. The hook, Dexie query chain, live-query
// subscription and IndexedDB operations all run unchanged.
vi.mock('@/lib/db', () => ({ get db() { return fixture.database!; } }));
import { DEFAULT_CHAT_MESSAGE_PAGE_SIZE, usePagedChatMessages } from './hooks';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
type ReadGate = { entered: ReturnType<typeof deferred>; release: ReturnType<typeof deferred> };
type ReadTrace = { chatId: string; index: string | null; limit: number | undefined; rows?: number };
let database: JarvisDexie;
let traces: ReadTrace[];
let gates: Map<string, ReadGate>;
let held: ReadGate[];

function row(chatId: string, number: number): Message {
  return { id: `${chatId}-${number}` as MessageId, chat_id: chatId as ChatId,
    role: number % 2 ? 'user' : 'assistant',
    parts: [{ kind: 'text', text: `Synthetic ${chatId} message ${number}.` }],
    created_at: number, updated_at: number };
}
function ids(chatId: string, from: number, to: number) {
  return Array.from({ length: to - from + 1 }, (_, index) => `${chatId}-${from + index}`);
}
async function seed(chatId: string, count: number) {
  await database.messages.bulkAdd(Array.from({ length: count }, (_, i) => row(chatId, i + 1)));
}
function holdNextRead(chatId: string): ReadGate {
  const gate = { entered: deferred(), release: deferred() };
  gates.set(chatId, gate); held.push(gate); return gate;
}

beforeEach(async () => {
  traces = []; gates = new Map(); held = [];
  database = createJarvisDb(uniqueTestDbName('chat-real-pagination'), TEST_INDEXED_DB);
  fixture.database = database;
  database.use({ stack: 'dbcore', name: 'observe-real-chat-pagination', level: 1000,
    create: down => ({ ...down, table: name => {
      const table = down.table(name);
      if (name !== 'messages') return table;
      return { ...table, query: async request => {
        const lower = request.query.range.lower;
        const trace: ReadTrace = { chatId: Array.isArray(lower) ? String(lower[0]) : '',
          index: request.query.index.name, limit: request.limit };
        traces.push(trace);
        const result = await table.query(request);
        trace.rows = result.result.length;
        const gate = gates.get(trace.chatId);
        if (gate) {
          gates.delete(trace.chatId);
          gate.entered.resolve();
          // Delay delivery of an actual IndexedDB result, never manufacture rows.
          await gate.release.promise;
        }
        return result;
      } };
    } }),
  });
  await database.open();
});
afterEach(async () => {
  cleanup();
  for (const gate of held) gate.release.resolve();
  await Promise.resolve();
  database.close(); await database.delete(); fixture.database = null;
});

describe('real persisted chat paging', () => {
  it('pages beyond 400 rows, observes a live append and reopens the newest bounded page', async () => {
    await seed('long-chat', 650);
    await seed('unrelated-chat', 450);
    const view = renderHook(() => usePagedChatMessages('long-chat'));
    await waitFor(() => expect(view.result.current.messages.map(m => m.id)).toEqual(ids('long-chat', 251, 650)));
    expect(view.result.current.hasOlder).toBe(true);
    for (const first of [151, 51, 1]) {
      act(() => view.result.current.loadOlder());
      await waitFor(() => expect(view.result.current.messages.map(m => m.id)).toEqual(ids('long-chat', first, 650)));
      expect(new Set(view.result.current.messages.map(m => m.id)).size).toBe(view.result.current.messages.length);
    }
    expect(view.result.current.hasOlder).toBe(false);
    await act(async () => { await database.messages.add(row('long-chat', 651)); });
    await waitFor(() => expect(view.result.current.messages.map(m => m.id)).toEqual(ids('long-chat', 1, 651)));
    view.unmount();
    const reopened = renderHook(() => usePagedChatMessages('long-chat'));
    await waitFor(() => expect(reopened.result.current.messages.map(m => m.id)).toEqual(ids('long-chat', 252, 651)));
    expect(reopened.result.current.hasOlder).toBe(true);
    expect(await database.messages.where('chat_id').equals('long-chat').count()).toBe(651);
    const observed = traces.filter(trace => trace.chatId === 'long-chat');
    expect(observed.length).toBeGreaterThanOrEqual(6);
    expect(new Set(observed.map(trace => trace.limit))).toEqual(new Set([401, 501, 601, 701]));
    for (const trace of observed) {
      expect(trace.index).toBe('[chat_id+created_at]');
      expect(trace.rows).toBeLessThanOrEqual(trace.limit!);
    }
    expect(observed.at(-1)?.limit).toBe(DEFAULT_CHAT_MESSAGE_PAGE_SIZE + 1);
  });

  it('never publishes old-chat rows while an older page finishes after switching chats', async () => {
    await seed('chat-a', 650); await seed('chat-b', 470);
    const samples: Array<{ chatId: string; rows: string[]; hasOlder: boolean }> = [];
    const view = renderHook(({ chatId }) => {
      const page = usePagedChatMessages(chatId);
      samples.push({ chatId, rows: page.messages.map(message => String(message.chat_id)), hasOlder: page.hasOlder });
      return page;
    }, { initialProps: { chatId: 'chat-a' } });
    await waitFor(() => expect(view.result.current.messages).toHaveLength(400));
    const oldPage = holdNextRead('chat-a');
    act(() => view.result.current.loadOlder());
    await oldPage.entered.promise;
    const nextPage = holdNextRead('chat-b');
    view.rerender({ chatId: 'chat-b' });
    await nextPage.entered.promise;
    await act(async () => { oldPage.release.resolve(); await Promise.resolve(); });
    expect(samples.filter(sample => sample.chatId === 'chat-b').every(sample => sample.rows.length === 0 && !sample.hasOlder)).toBe(true);
    expect(view.result.current.messages).toEqual([]);
    expect(traces.filter(trace => trace.chatId === 'chat-b').at(-1)?.limit).toBe(401);
    await act(async () => { nextPage.release.resolve(); });
    await waitFor(() => expect(view.result.current.messages.map(m => m.id)).toEqual(ids('chat-b', 71, 470)));
    act(() => view.result.current.loadOlder());
    await waitFor(() => expect(view.result.current.messages.map(m => m.id)).toEqual(ids('chat-b', 1, 470)));
    expect(view.result.current.hasOlder).toBe(false);
    expect(samples.filter(sample => sample.chatId === 'chat-b').every(sample => sample.rows.every(chatId => chatId === 'chat-b'))).toBe(true);
  });

  it('clears the current page immediately when no chat is selected', async () => {
    await seed('closed-chat', 450);
    const view = renderHook(({ chatId }: { chatId: string | null }) => usePagedChatMessages(chatId),
      { initialProps: { chatId: 'closed-chat' as string | null } });
    await waitFor(() => expect(view.result.current.messages).toHaveLength(400));
    view.rerender({ chatId: null });
    expect(view.result.current.messages).toEqual([]);
    expect(view.result.current.hasOlder).toBe(false);
  });
});
