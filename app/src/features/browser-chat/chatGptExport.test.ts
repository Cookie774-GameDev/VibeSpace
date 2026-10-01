import { deflateRawSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createJarvisDb, type JarvisDexie } from '@/lib/db';
import { TEST_INDEXED_DB, uniqueTestDbName } from '@/test/indexedDb';
import {
  createChatGptSnapshotRepository,
  importChatGptExport,
  readBoundedChatGptExportFile,
  type ChatGptImportProgress,
} from './chatGptExport';

type ZipEntry = {
  name: string;
  content: Uint8Array;
  compression?: 'store' | 'deflate';
};

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function writeU16(target: number[], value: number) {
  target.push(value & 0xff, (value >>> 8) & 0xff);
}

function writeU32(target: number[], value: number) {
  target.push(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff);
}

function append(target: number[], bytes: Uint8Array) {
  target.push(...bytes);
}

function zip(entries: ZipEntry[]): Uint8Array {
  const encoder = new TextEncoder();
  const local: number[] = [];
  const central: number[] = [];

  for (const entry of entries) {
    const name = encoder.encode(entry.name);
    const compressed =
      entry.compression === 'deflate'
        ? new Uint8Array(deflateRawSync(entry.content))
        : entry.content;
    const method = entry.compression === 'deflate' ? 8 : 0;
    const checksum = crc32(entry.content);
    const localOffset = local.length;

    writeU32(local, 0x04034b50);
    writeU16(local, 20);
    writeU16(local, 0x0800);
    writeU16(local, method);
    writeU16(local, 0);
    writeU16(local, 0);
    writeU32(local, checksum);
    writeU32(local, compressed.length);
    writeU32(local, entry.content.length);
    writeU16(local, name.length);
    writeU16(local, 0);
    append(local, name);
    append(local, compressed);

    writeU32(central, 0x02014b50);
    writeU16(central, 20);
    writeU16(central, 20);
    writeU16(central, 0x0800);
    writeU16(central, method);
    writeU16(central, 0);
    writeU16(central, 0);
    writeU32(central, checksum);
    writeU32(central, compressed.length);
    writeU32(central, entry.content.length);
    writeU16(central, name.length);
    writeU16(central, 0);
    writeU16(central, 0);
    writeU16(central, 0);
    writeU16(central, 0);
    writeU32(central, 0);
    writeU32(central, localOffset);
    append(central, name);
  }

  const archive = [...local, ...central];
  writeU32(archive, 0x06054b50);
  writeU16(archive, 0);
  writeU16(archive, 0);
  writeU16(archive, entries.length);
  writeU16(archive, entries.length);
  writeU32(archive, central.length);
  writeU32(archive, local.length);
  writeU16(archive, 0);
  return new Uint8Array(archive);
}

function conversation(title = 'Alpha <script>alert(1)</script>', assistantText = 'Safe reply') {
  return {
    id: 'conversation-a',
    title,
    create_time: 10,
    update_time: 20,
    current_node: 'assistant-node',
    mapping: {
      root: { id: 'root', parent: null, children: ['user-node'] },
      'user-node': {
        id: 'user-node',
        parent: 'root',
        children: ['assistant-node'],
        message: {
          id: 'message-user',
          author: { role: 'user' },
          create_time: 11,
          content: { content_type: 'text', parts: ['Literal <b>question</b>'] },
        },
      },
      'assistant-node': {
        id: 'assistant-node',
        parent: 'user-node',
        children: [],
        message: {
          id: 'message-assistant',
          author: { role: 'assistant' },
          create_time: 12,
          content: { content_type: 'text', parts: [assistantText] },
        },
      },
    },
  };
}

function exportZip(
  conversations: unknown[],
  compression: ZipEntry['compression'] = 'deflate',
  extraEntries: ZipEntry[] = [],
) {
  return zip([
    ...extraEntries,
    {
      name: 'conversations.json',
      content: new TextEncoder().encode(JSON.stringify(conversations)),
      compression,
    },
  ]);
}

describe('official ChatGPT export snapshots', () => {
  let database: JarvisDexie;

  beforeEach(async () => {
    database = createJarvisDb(uniqueTestDbName('chatgpt-export'), TEST_INDEXED_DB);
    await database.open();
  });

  afterEach(async () => {
    database.close();
    await database.delete();
  });

  it('rejects the declared file size before allocation and reports bounded read progress', async () => {
    const arrayBuffer = vi.fn(async () => new ArrayBuffer(1));
    await expect(
      readBoundedChatGptExportFile(
        {
          size: 11,
          arrayBuffer,
        } as unknown as File,
        { maxBytes: 10 },
      ),
    ).rejects.toThrow('chatgpt_export_archive_too_large');
    expect(arrayBuffer).not.toHaveBeenCalled();

    const progress: ChatGptImportProgress[] = [];
    const archive = await readBoundedChatGptExportFile(
      new File([new Uint8Array([1, 2, 3])], 'export.zip'),
      {
        maxBytes: 3,
        onProgress: (value) => progress.push(value),
      },
    );
    expect(archive.byteLength).toBe(3);
    expect(progress.at(0)).toEqual({ phase: 'reading', completed: 0, total: 3 });
    expect(progress.at(-1)).toEqual({ phase: 'reading', completed: 3, total: 3 });
  });

  it('imports the current branch as inert provider-owned snapshot text', async () => {
    const result = await importChatGptExport({
      database,
      accountId: 'account-a',
      workspaceId: 'workspace-a',
      fileName: 'chatgpt-export.zip',
      archive: exportZip([conversation()]),
    });

    expect(result).toMatchObject({ added: 1, updated: 0, unchanged: 0, reusedImport: false });
    const snapshots = await database.browser_chat_snapshots.toArray();
    expect(snapshots).toEqual([
      expect.objectContaining({
        providerConversationKey: 'conversation-a',
        title: 'Alpha <script>alert(1)</script>',
        revision: 1,
        messageCount: 2,
        messages: [
          expect.objectContaining({ role: 'user', text: 'Literal <b>question</b>' }),
          expect.objectContaining({ role: 'assistant', text: 'Safe reply' }),
        ],
      }),
    ]);
    await expect(database.messages.toArray()).resolves.toEqual([]);
    await expect(
      createChatGptSnapshotRepository(database).list(
        { accountId: 'account-a', workspaceId: 'workspace-a' },
        'safe reply',
      ),
    ).resolves.toHaveLength(1);
  });

  it('updates one stable conversation snapshot on re-import and deduplicates an exact archive', async () => {
    const first = exportZip([conversation('Alpha', 'Version one')]);
    const second = exportZip([conversation('Alpha updated', 'Version two')]);

    await importChatGptExport({
      database,
      accountId: 'account-a',
      workspaceId: 'workspace-a',
      fileName: 'first.zip',
      archive: first,
    });
    const updated = await importChatGptExport({
      database,
      accountId: 'account-a',
      workspaceId: 'workspace-a',
      fileName: 'second.zip',
      archive: second,
    });
    const reused = await importChatGptExport({
      database,
      accountId: 'account-a',
      workspaceId: 'workspace-a',
      fileName: 'second-again.zip',
      archive: second,
    });

    expect(updated).toMatchObject({ added: 0, updated: 1, unchanged: 0 });
    expect(reused).toMatchObject({ added: 0, updated: 0, unchanged: 1, reusedImport: true });
    await expect(database.browser_chat_snapshots.count()).resolves.toBe(1);
    await expect(database.browser_chat_imports.count()).resolves.toBe(2);
    expect(await database.browser_chat_snapshots.toCollection().first()).toMatchObject({
      title: 'Alpha updated',
      revision: 2,
    });
  });

  it('deletes only the selected local snapshot', async () => {
    await importChatGptExport({
      database,
      accountId: 'account-a',
      workspaceId: 'workspace-a',
      fileName: 'export.zip',
      archive: exportZip([conversation()]),
    });
    const snapshot = await database.browser_chat_snapshots.toCollection().first();
    const repository = createChatGptSnapshotRepository(database);

    await expect(
      repository.list({ accountId: 'account-b', workspaceId: 'workspace-a' }),
    ).resolves.toEqual([]);
    await expect(
      repository.remove({ accountId: 'account-b', workspaceId: 'workspace-a' }, snapshot!.id),
    ).rejects.toThrow('chatgpt_export_snapshot_not_found');
    await expect(database.browser_chat_snapshots.count()).resolves.toBe(1);

    await repository.remove({ accountId: 'account-a', workspaceId: 'workspace-a' }, snapshot!.id);

    await expect(database.browser_chat_snapshots.count()).resolves.toBe(0);
    await expect(database.browser_chat_imports.count()).resolves.toBe(1);
    await expect(database.chats.count()).resolves.toBe(0);
    await expect(database.messages.count()).resolves.toBe(0);
  });

  it('rejects hostile archive paths and oversized archives before persistence', async () => {
    const hostile = exportZip([conversation()], 'store', [
      { name: '../outside.txt', content: new TextEncoder().encode('nope') },
    ]);
    await expect(
      importChatGptExport({
        database,
        accountId: 'account-a',
        workspaceId: 'workspace-a',
        fileName: 'hostile.zip',
        archive: hostile,
      }),
    ).rejects.toThrow('chatgpt_export_archive_path_invalid');
    await expect(
      importChatGptExport({
        database,
        accountId: 'account-a',
        workspaceId: 'workspace-a',
        fileName: 'oversized.zip',
        archive: exportZip([conversation()], 'store'),
        limits: { maxArchiveBytes: 10 },
      }),
    ).rejects.toThrow('chatgpt_export_archive_too_large');
    await expect(database.browser_chat_imports.count()).resolves.toBe(0);
  });

  it('cancels before the atomic write and leaves no partial import', async () => {
    const controller = new AbortController();
    const progress: ChatGptImportProgress[] = [];

    await expect(
      importChatGptExport({
        database,
        accountId: 'account-a',
        workspaceId: 'workspace-a',
        fileName: 'cancel.zip',
        archive: exportZip([conversation()], 'store'),
        signal: controller.signal,
        onProgress(value) {
          progress.push(value);
          if (value.phase === 'parsing') controller.abort();
        },
      }),
    ).rejects.toThrow('chatgpt_export_cancelled');

    expect(progress.map((value) => value.phase)).toContain('parsing');
    await expect(database.browser_chat_imports.count()).resolves.toBe(0);
    await expect(database.browser_chat_snapshots.count()).resolves.toBe(0);
  });

  it('rejects an ambiguous branched conversation when current_node is unavailable', async () => {
    const branched = structuredClone(conversation()) as unknown as {
      current_node?: string;
      mapping: Record<
        string,
        {
          id: string;
          parent: string | null;
          children: string[];
          message?: unknown;
        }
      >;
    };
    delete branched.current_node;
    branched.mapping['alternate-assistant'] = {
      id: 'alternate-assistant',
      parent: 'user-node',
      children: [],
      message: {
        id: 'message-alternate',
        author: { role: 'assistant' },
        create_time: 13,
        content: { content_type: 'text', parts: ['Alternate branch'] },
      },
    };
    branched.mapping['user-node']!.children = ['assistant-node', 'alternate-assistant'];

    await expect(
      importChatGptExport({
        database,
        accountId: 'account-a',
        workspaceId: 'workspace-a',
        fileName: 'ambiguous.zip',
        archive: exportZip([branched], 'store'),
      }),
    ).rejects.toThrow('chatgpt_export_conversation_branch_ambiguous');
    await expect(database.browser_chat_snapshots.count()).resolves.toBe(0);
  });
});
