import 'fake-indexeddb/auto';
import { describe, expect, it, vi } from 'vitest';
import { createContextMapRlmRepository } from './contextRlmProduction';
import {
  createFederatedRlmRepository,
  createHistoryRlmRepository,
  loadProductionRlmHistory,
} from './contextRlmHistory';
import { db } from '@/lib/db';
import type { ChatId, MessageId, ProjectId, WorkspaceId } from '@/types/common';

describe('RLM scoped history federation', () => {
  it('retrieves exact evidence from chat history and local files without cross-project leakage', async () => {
    const content = 'Local checkpoint cross-source-uat enabled restart.';
    const contentDigest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(content));
    const contentSha256 = [...new Uint8Array(contentDigest)]
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('');
    const mapRepository = createContextMapRlmRepository({
      loadMaps: vi.fn(async () => [
        {
          id: 'map-1',
          projectId: 'project-1',
          rootDir: 'C:\\repo',
          status: 'active' as const,
          updatedAt: 1,
          sourceType: 'local_folder' as const,
          tree: {
            nodes: [
              {
                id: 'file-1',
                kind: 'file',
                title: 'checkpoint.txt',
                summary: 'checkpoint',
                path: 'C:\\repo\\checkpoint.txt',
              },
            ],
          },
        },
      ]),
      stat: vi.fn(async (path) => ({
        ok: true as const,
        path,
        kind: 'file' as const,
        size: content.length,
        sha256: `sha256:${contentSha256}` as `sha256:${string}`,
      })),
      read: vi.fn(async (path) => ({ ok: true as const, path, content })),
      lexicalSearch: vi.fn(async () => []),
    });
    const historyRepository = createHistoryRlmRepository({
      load: vi.fn(async () => [
        {
          id: 'message-1',
          accountId: 'account-1',
          workspaceId: 'workspace-1',
          projectId: 'project-1',
          sourceKind: 'chat_message' as const,
          sourceId: 'message-1',
          title: 'Provider UAT',
          content: 'Provider checkpoint cross-source-uat enabled local review.',
          createdAt: 1,
        },
        {
          id: 'message-foreign',
          accountId: 'account-1',
          workspaceId: 'workspace-1',
          projectId: 'project-2',
          sourceKind: 'chat_message' as const,
          sourceId: 'message-foreign',
          title: 'Foreign',
          content: 'cross-source-uat must not leak.',
          createdAt: 1,
        },
      ]),
    });
    const repository = createFederatedRlmRepository([mapRepository, historyRepository]);
    const scope = {
      accountId: 'account-1',
      workspaceId: 'workspace-1',
      projectId: 'project-1',
    };

    const hits = await repository.search(scope, '"cross-source-uat"');
    expect(hits).toHaveLength(2);
    const records = await Promise.all(hits.map((hit) => repository.getRecord(hit.recordId)));
    expect(records.map((record) => record?.sourceKind).sort()).toEqual([
      'chat_message',
      'file_version',
    ]);
    expect(records.some((record) => record?.sourceId === 'message-foreign')).toBe(false);
  });

  it('rejects secret-like history content before indexing it', async () => {
    const repository = createHistoryRlmRepository({
      load: vi.fn(async () => [
        {
          id: 'secret',
          accountId: 'account-1',
          sourceKind: 'chat_message' as const,
          sourceId: 'secret',
          title: 'Secret',
          content: 'OPENAI_API_KEY=must-not-index',
          createdAt: 1,
        },
      ]),
    });

    await expect(repository.listRecords({ accountId: 'account-1' })).resolves.toEqual([]);
  });

  it('skips malformed historical metadata without aborting the scoped query', async () => {
    const repository = createHistoryRlmRepository({
      load: vi.fn(async () => [
        {
          id: 'malformed',
          accountId: 'account-1',
          sourceKind: 'chat_message' as const,
          sourceId: 'malformed',
          title: '   ',
          content: 'recoverable history needle',
          createdAt: 1,
        },
        {
          id: 'valid',
          accountId: 'account-1',
          sourceKind: 'chat_message' as const,
          sourceId: 'valid',
          title: 'Valid',
          content: 'recoverable history needle',
          createdAt: 1,
        },
      ]),
    });

    const hits = await repository.search({ accountId: 'account-1' }, '"recoverable history needle"');
    expect(hits).toHaveLength(1);
    expect((await repository.getRecord(hits[0]!.recordId))?.sourceId).toBe('valid');
  });

  it('loads production messages through the indexed chat_id path', async () => {
    const workspaceId = 'rlm-history-workspace' as WorkspaceId;
    const projectId = 'rlm-history-project' as ProjectId;
    const chatId = 'rlm-history-chat' as ChatId;
    await db.workspaces.put({
      id: workspaceId,
      name: 'RLM history',
      owner_id: 'account-1',
      created_at: 1,
      updated_at: 1,
    });
    await db.chats.put({
      id: chatId,
      workspace_id: workspaceId,
      project_id: projectId,
      title: 'Indexed history',
      archived: false,
      mode: 'chat',
      active_agent_ids: [],
      created_at: 1,
      updated_at: 2,
    });
    await db.messages.put({
      id: 'rlm-history-message' as MessageId,
      chat_id: chatId,
      role: 'user',
      parts: [{ kind: 'text', text: 'indexed history needle' }],
      created_at: 1,
      updated_at: 3,
    });

    await expect(
      loadProductionRlmHistory({
        accountId: 'account-1',
        workspaceId,
        projectId,
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        sourceId: 'rlm-history-message',
        content: 'indexed history needle',
      }),
    ]);
  });
});
