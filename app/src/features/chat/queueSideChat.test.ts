import { afterEach, expect, it, vi } from 'vitest';
import {
  openQueuedSideChat,
  QUEUE_SIDE_CHAT_EVENT,
  registerQueueSideSender,
  type QueueSideChatRequest,
} from './queueSideChat';
const fake = vi.hoisted(() => ({
  get: vi.fn(),
  create: vi.fn(),
  messages: vi.fn(),
  auth: { workspaceId: 'w', projectId: null },
}));
vi.mock('@/lib/db', () => ({
  chatRepo: { getById: fake.get, createAuthorized: fake.create },
  messageRepo: { listByChat: fake.messages },
}));
vi.mock('@/stores/auth', () => ({ useAuthStore: { getState: () => fake.auth } }));
vi.mock('@/lib/accountIdentity', () => ({ resolveAccountIdentity: () => ({ accountId: 'a' }) }));
vi.mock('@/lib/cloudSyncQueueOwner', () => ({
  captureSyncQueueOwner: () => ({ state: 'unbound' }),
}));
const stops: Array<() => void> = [];
afterEach(() => {
  stops.splice(0).forEach((stop) => stop());
  vi.clearAllMocks();
});
it('preserves attachments and context, reusing a rejected target on retry', async () => {
  const source = {
    id: 'source',
    workspace_id: 'w',
    project_id: null,
    title: 'Original',
    mode: 'chat',
    active_agent_ids: [],
    created_at: 1,
    updated_at: 1,
  };
  fake.get.mockResolvedValue(source);
  fake.create.mockResolvedValue({ ...source, id: 'target' });
  fake.messages.mockResolvedValue([
    {
      id: 'm1',
      chat_id: 'source',
      role: 'user',
      parts: [{ kind: 'text', text: 'Context marker 493' }],
      created_at: Date.now(),
      updated_at: Date.now(),
    },
  ]);
  const sender = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
  stops.push(registerQueueSideSender('target', sender));
  const listener = (event: Event) => {
    const r = (event as CustomEvent<QueueSideChatRequest>).detail;
    void r.create().then(() => r.resolve(true));
  };
  window.addEventListener(QUEUE_SIDE_CHAT_EVENT, listener);
  stops.push(() => window.removeEventListener(QUEUE_SIDE_CHAT_EVENT, listener));
  const message = {
    id: 'queue-side-test',
    text: 'Use that context',
    createdAt: Date.now(),
    flushMode: 'after-run' as const,
    attachments: {
      files: ['sample.txt'],
      images: [],
      terminals: [],
      plugins: [],
      contexts: [],
      commands: [],
      agents: [],
      catalog: [],
    },
  };
  expect(await openQueuedSideChat('source', message)).toBe(false);
  expect(await openQueuedSideChat('source', message)).toBe(true);
  expect(fake.create).toHaveBeenCalledTimes(1);
  expect(sender.mock.calls[0][0]).toBe(message);
  expect(JSON.stringify(sender.mock.calls[0][1])).toContain('Context marker 493');
});
it('creates nothing when another pane is rejected', async () => {
  fake.get.mockResolvedValue({
    id: 'source',
    workspace_id: 'w',
    title: 'Original',
    created_at: 1,
    updated_at: 1,
  });
  fake.messages.mockResolvedValue([]);
  const listener = (event: Event) =>
    (event as CustomEvent<QueueSideChatRequest>).detail.resolve(false);
  window.addEventListener(QUEUE_SIDE_CHAT_EVENT, listener);
  stops.push(() => window.removeEventListener(QUEUE_SIDE_CHAT_EVENT, listener));
  await expect(
    openQueuedSideChat('source', {
      id: 'limit',
      text: 'Keep me',
      createdAt: 1,
      flushMode: 'after-run',
    }),
  ).rejects.toThrow('Could not open');
  expect(fake.create).not.toHaveBeenCalled();
});
