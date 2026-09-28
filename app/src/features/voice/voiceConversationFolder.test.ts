import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  isTauri: true,
  appDataDir: vi.fn(async () => 'C:/VibeSpaceData/'),
  createDirectory: vi.fn(async (path: string) => ({ ok: true, path })),
  writeTextFile: vi.fn(async (path: string, _content: string) => ({ ok: true, path })),
  readTextFile: vi.fn(async (path: string) => ({
    ok: false as const,
    error: { code: 'not_found' as const },
    path,
  })),
  listVoiceNativeTasks: vi.fn(async () => ({ ok: true as const, records: [] as unknown[] })),
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
  readTextFile: mocks.readTextFile,
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
vi.mock('./voiceNativeTaskIndex', () => ({
  listVoiceNativeTasks: mocks.listVoiceNativeTasks,
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

  it('adds bounded native task references for the matching scoped voice chat', async () => {
    mocks.listVoiceNativeTasks.mockResolvedValueOnce({
      ok: true,
      records: [
        {
          requestId: 'voice-request-1',
          parentChatId: 'voice-chat-1',
          requestedMainProvider: 'codex',
          requestedWorkerProvider: 'opencode',
          actualWorker: {
            provider: 'opencode',
            modelId: 'opencode/model-x',
            nativeTaskId: 'native-child-1',
          },
          status: 'running',
          updatedAt: '2026-09-28T05:10:00.000Z',
          summary: 'Review the selected files',
        },
        {
          requestId: 'voice-request-2',
          parentChatId: 'another-voice-chat',
          requestedWorkerProvider: 'codex',
          status: 'submitted',
          updatedAt: '2026-09-28T05:09:00.000Z',
          summary: 'Must not leak into this folder',
        },
      ],
    });

    await syncVoiceConversationFolder('voice-chat-1', {
      accountId: 'account-1',
      workspaceId: 'workspace-1',
      projectId: 'project-1',
    });

    const indexCall = mocks.writeTextFile.mock.calls.find(([path]) => path.endsWith('/index.json'));
    expect(indexCall).toBeDefined();
    const index = JSON.parse(indexCall?.[1] ?? '{}') as {
      workers: Array<{ childChatId: string }>;
      nativeTasks: Array<Record<string, unknown>>;
    };
    expect(index.workers).toMatchObject([{ childChatId: 'child-1' }]);
    expect(index.nativeTasks).toEqual([
      {
        requestId: 'voice-request-1',
        parentChatId: 'voice-chat-1',
        requestedMainProvider: 'codex',
        requestedWorkerProvider: 'opencode',
        actualWorkerProvider: 'opencode',
        actualModelId: 'opencode/model-x',
        nativeTaskId: 'native-child-1',
        status: 'running',
        updatedAt: '2026-09-28T05:10:00.000Z',
        summary: 'Review the selected files',
      },
    ]);
  });

  it('preserves prior native task references when a folder refresh has no scope', async () => {
    mocks.readTextFile.mockResolvedValueOnce({
      ok: true,
      path: 'C:/VibeSpaceData/jarvis-voice-conversations/voice-chat-1/index.json',
      content: JSON.stringify({
        nativeTasks: [
          {
            requestId: 'voice-request-1',
            parentChatId: 'voice-chat-1',
            requestedMainProvider: 'codex',
            requestedWorkerProvider: 'codex',
            status: 'running',
            updatedAt: '2026-09-28T05:10:00.000Z',
            summary: 'Still running',
          },
        ],
      }),
    });

    await syncVoiceConversationFolder('voice-chat-1');

    const indexCall = mocks.writeTextFile.mock.calls.find(([path]) => path.endsWith('/index.json'));
    const index = JSON.parse(indexCall?.[1] ?? '{}') as {
      nativeTasks: Array<Record<string, unknown>>;
    };
    expect(index.nativeTasks).toMatchObject([{ requestId: 'voice-request-1', status: 'running' }]);
    expect(mocks.listVoiceNativeTasks).not.toHaveBeenCalled();
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
