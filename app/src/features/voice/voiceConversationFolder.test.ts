import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  isTauri: true,
  appDataDir: vi.fn(async () => 'C:/VibeSpaceData/'),
  createDirectory: vi.fn(async (path: string) => ({ ok: true, path })),
  writeTextFile: vi.fn(async (path: string) => ({ ok: true, path })),
  listByChat: vi.fn(async () => [
    { id: 'message-1', role: 'user', created_at: 1, parts: [{ kind: 'text', text: 'Help me' }] },
    { id: 'message-2', role: 'assistant', created_at: 2, parts: [{ kind: 'text', text: 'Done' }] },
  ]),
  agentsForChat: vi.fn(() => [
    {
      agentId: 'worker-1',
      childChatId: 'child-1',
      modelLabel: 'OpenCode · model',
      status: 'thinking',
      updatedAt: '2026-09-27T19:00:00Z',
    },
  ]),
}));

vi.mock('@tauri-apps/api/path', () => ({ appDataDir: mocks.appDataDir }));
vi.mock('@/lib/db', () => ({ messageRepo: { listByChat: mocks.listByChat } }));
vi.mock('@/lib/fs', () => ({
  createDirectory: mocks.createDirectory,
  writeTextFile: mocks.writeTextFile,
}));
vi.mock('@/lib/utils', () => ({
  get isTauri() {
    return mocks.isTauri;
  },
}));
vi.mock('@/features/jarvis-interaction/sessionStore', () => ({
  useJarvisInteractionStore: { getState: () => ({ agentsForChat: mocks.agentsForChat }) },
}));

import { syncVoiceConversationFolder } from './voiceConversationFolder';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.isTauri = true;
});

describe('voice conversation folder', () => {
  it('writes chat logs and existing worker references under the validated chat ID', async () => {
    await expect(syncVoiceConversationFolder('voice-chat-1')).resolves.toMatchObject({
      ok: true,
      folder: 'C:/VibeSpaceData/jarvis-voice-conversations/voice-chat-1',
      messageCount: 2,
    });
    expect(mocks.createDirectory).toHaveBeenCalledWith(
      'C:/VibeSpaceData/jarvis-voice-conversations/voice-chat-1',
      { root: 'C:/VibeSpaceData' },
    );
    expect(mocks.writeTextFile).toHaveBeenCalledWith(
      'C:/VibeSpaceData/jarvis-voice-conversations/voice-chat-1/chat-0001.jsonl',
      expect.stringContaining('Help me'),
      { root: 'C:/VibeSpaceData' },
    );
    expect(mocks.writeTextFile).toHaveBeenCalledWith(
      'C:/VibeSpaceData/jarvis-voice-conversations/voice-chat-1/index.json',
      expect.stringContaining('child-1'),
      { root: 'C:/VibeSpaceData' },
    );
  });

  it('rejects unsafe chat IDs before touching the filesystem', async () => {
    await expect(syncVoiceConversationFolder('../another-account')).resolves.toMatchObject({
      ok: false,
    });
    expect(mocks.createDirectory).not.toHaveBeenCalled();
  });

  it('reports a folder failure while preserving the database chat', async () => {
    mocks.createDirectory.mockResolvedValueOnce({ ok: false, path: 'C:/VibeSpaceData' });
    await expect(syncVoiceConversationFolder('voice-chat-2')).resolves.toMatchObject({
      ok: false,
      error: 'Could not create the voice chat folder.',
    });
    expect(mocks.listByChat).not.toHaveBeenCalled();
  });
});
