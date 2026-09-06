import { describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  get: vi.fn(),
  messages: vi.fn(),
  append: vi.fn(),
  active: vi.fn(),
}));
vi.mock('@/lib/db', () => ({
  db: {},
  chatRepo: { getById: mocks.get, create: mocks.create },
  messageRepo: { listByChat: mocks.messages, create: mocks.append },
}));
vi.mock('@/lib/doctor/storageDoctor', () => ({
  requireHealthyLocalChatStorage: vi.fn(),
  runLocalChatStorageOperation: vi.fn(),
}));
vi.mock('@/stores/ui', () => ({
  useUIStore: { getState: () => ({ setActiveChat: mocks.active, setRoute: vi.fn() }) },
}));
import { branchChatFromMessage } from './chatLifecycle';

describe('branch backend authority', () => {
  it('retains the original Codex backend instead of migrating copied history to OpenCode', async () => {
    const affinity = { version: 1, backend: 'codex', locked: true, selectedAt: 1, lockedAt: 2 };
    mocks.get.mockResolvedValue({
      id: 'source',
      workspace_id: 'workspace',
      title: 'Chat',
      mode: 'chat',
      active_agent_ids: [],
      backend_affinity: affinity,
    });
    mocks.messages.mockResolvedValue([
      {
        id: 'message',
        role: 'user',
        parts: [{ kind: 'text', text: 'hello' }],
        created_at: 2,
        updated_at: 2,
      },
    ]);
    mocks.create.mockResolvedValue({ id: 'branch' });
    await branchChatFromMessage({
      chatId: 'source' as never,
      messageId: 'message' as never,
      navigateToChat: false,
    });
    expect(mocks.create).toHaveBeenCalledWith(
      expect.objectContaining({ backend_affinity: affinity }),
    );
    expect(mocks.append).toHaveBeenCalledWith(
      expect.objectContaining({ chat_id: 'branch', role: 'user' }),
    );
  });
});
