import 'fake-indexeddb/auto';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('@/lib/db/database', async () => {
  const { default: Dexie } = await import('dexie');
  const db = new Dexie('backend-affinity-test');
  db.version(1).stores({ chats: 'id', messages: 'id,chat_id' });
  return { db: Object.assign(db, { chats: db.table('chats'), messages: db.table('messages') }) };
});
import { db } from '@/lib/db/database';
import { useChatBackendAffinity } from './useChatBackendAffinity';
import type { Chat, Message } from '@/types/chat';

afterEach(async () => {
  cleanup();
  await db.chats.clear();
  await db.messages.clear();
});

describe('reactive chat backend selection', () => {
  it.each(['codex', 'opencode'] as const)(
    'locks %s immediately after the first saved user message',
    async (backend) => {
      await db.chats.put({
        id: 'a',
        created_at: 1,
        backend_affinity: { version: 1, backend, locked: false, selectedAt: 1 },
      } as Chat);
      const { result } = renderHook(() => useChatBackendAffinity('a'));
      await waitFor(() => expect(result.current).toMatchObject({ backend, locked: false }));
      await act(async () => {
        await db.messages.put({ id: 'm', chat_id: 'a', role: 'user' } as Message);
      });
      await waitFor(() => expect(result.current).toMatchObject({ backend, locked: true }));
    },
  );

  it('fails closed while changing chats and observes external backend selection', async () => {
    await db.chats.put({ id: 'a', created_at: 1 } as Chat);
    const { result, rerender } = renderHook(({ id }) => useChatBackendAffinity(id), {
      initialProps: { id: 'a' },
    });
    await waitFor(() => expect(result.current?.backend).toBe('opencode'));
    await act(async () => {
      await db.chats.update('a' as Chat['id'], {
        backend_affinity: { version: 1, backend: 'codex', locked: false, selectedAt: 2 },
      });
    });
    await waitFor(() => expect(result.current?.backend).toBe('codex'));
    rerender({ id: 'missing' });
    expect(result.current).toBeNull();
  });
});
