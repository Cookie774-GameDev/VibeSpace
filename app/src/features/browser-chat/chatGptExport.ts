import type { JarvisDexie } from '@/lib/db';
import type {
  BrowserChatImportRow,
  BrowserChatSnapshotMessage,
  BrowserChatSnapshotRow,
} from '@/lib/db/schema';

export type ChatGptSnapshotScope = {
  readonly accountId: string;
  readonly workspaceId: string;
};

export type ChatGptImportLimits = {
  readonly maxArchiveBytes: number;
  readonly maxEntries: number;
  readonly maxEntryBytes: number;
  readonly maxCompressionRatio: number;
  readonly maxConversations: number;
  readonly maxMessagesPerConversation: number;
  readonly maxMessageTextBytes: number;
};

export type ChatGptImportProgress = {
  readonly phase: 'reading' | 'hashing' | 'extracting' | 'parsing' | 'writing' | 'complete';
  readonly completed: number;
  readonly total: number;
};

export type ImportChatGptExportInput = ChatGptSnapshotScope & {
  readonly database: JarvisDexie;
  readonly fileName: string;
  readonly archive: Uint8Array | ArrayBuffer;
  readonly signal?: AbortSignal;
  readonly limits?: Partial<ChatGptImportLimits>;
  readonly onProgress?: (progress: ChatGptImportProgress) => void;
  readonly clock?: () => number;
  readonly idFactory?: () => string;
};

export type ChatGptImportResult = {
  readonly importId: string;
  readonly added: number;
  readonly updated: number;
  readonly unchanged: number;
  readonly reusedImport: boolean;
};

export const CHATGPT_EXPORT_MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;

const DEFAULT_LIMITS: ChatGptImportLimits = Object.freeze({
  maxArchiveBytes: CHATGPT_EXPORT_MAX_ARCHIVE_BYTES,
  maxEntries: 4096,
  maxEntryBytes: 24 * 1024 * 1024,
  maxCompressionRatio: 200,
  maxConversations: 25_000,
  maxMessagesPerConversation: 10_000,
  maxMessageTextBytes: 1024 * 1024,
});

const ZIP_LOCAL_HEADER = 0x04034b50;
const ZIP_CENTRAL_HEADER = 0x02014b50;
const ZIP_END = 0x06054b50;
const ZIP_END_MIN_SIZE = 22;
const ZIP_END_MAX_SEARCH = ZIP_END_MIN_SIZE + 0xffff;

type ParsedConversation = {
  providerConversationKey: string;
  title: string;
  providerCreatedAt?: number;
  providerUpdatedAt?: number;
  messages: BrowserChatSnapshotMessage[];
};

type PreparedConversation = ParsedConversation & {
  contentHash: string;
};

function fail(code: string): never {
  throw new Error(code);
}

function checkCancelled(signal?: AbortSignal) {
  if (signal?.aborted) fail('chatgpt_export_cancelled');
}

function boundedString(value: unknown, code: string, maxLength: number): string {
  if (typeof value !== 'string') fail(code);
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength) fail(code);
  return normalized;
}

function normalizeScope(input: ChatGptSnapshotScope): ChatGptSnapshotScope {
  return {
    accountId: boundedString(input.accountId, 'chatgpt_export_account_invalid', 256),
    workspaceId: boundedString(input.workspaceId, 'chatgpt_export_workspace_invalid', 256),
  };
}

function toBytes(value: Uint8Array | ArrayBuffer): Uint8Array {
  return value instanceof Uint8Array ? value : new Uint8Array(value);
}

export async function readBoundedChatGptExportFile(
  file: File,
  options: {
    readonly signal?: AbortSignal;
    readonly maxBytes?: number;
    readonly onProgress?: (progress: ChatGptImportProgress) => void;
  } = {},
): Promise<ArrayBuffer> {
  const maxBytes = options.maxBytes ?? CHATGPT_EXPORT_MAX_ARCHIVE_BYTES;
  if (!Number.isSafeInteger(file.size) || file.size < 0 || file.size > maxBytes) {
    fail('chatgpt_export_archive_too_large');
  }
  checkCancelled(options.signal);
  options.onProgress?.({ phase: 'reading', completed: 0, total: file.size });
  if (typeof file.stream !== 'function') {
    const archive = await file.arrayBuffer();
    checkCancelled(options.signal);
    if (archive.byteLength !== file.size || archive.byteLength > maxBytes) {
      fail('chatgpt_export_archive_too_large');
    }
    options.onProgress?.({
      phase: 'reading',
      completed: archive.byteLength,
      total: file.size,
    });
    return archive;
  }

  const reader = file.stream().getReader();
  const archive = new Uint8Array(file.size);
  let offset = 0;
  try {
    while (true) {
      checkCancelled(options.signal);
      const result = await reader.read();
      if (result.done) break;
      const chunk = new Uint8Array(result.value);
      if (offset + chunk.byteLength > archive.byteLength || offset + chunk.byteLength > maxBytes) {
        await reader.cancel();
        fail('chatgpt_export_archive_too_large');
      }
      archive.set(chunk, offset);
      offset += chunk.byteLength;
      options.onProgress?.({ phase: 'reading', completed: offset, total: file.size });
    }
  } finally {
    reader.releaseLock();
  }
  checkCancelled(options.signal);
  if (offset !== file.size) fail('chatgpt_export_archive_invalid');
  return archive.buffer;
}

function dataView(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function u16(view: DataView, offset: number): number {
  if (offset < 0 || offset + 2 > view.byteLength) fail('chatgpt_export_archive_invalid');
  return view.getUint16(offset, true);
}

function u32(view: DataView, offset: number): number {
  if (offset < 0 || offset + 4 > view.byteLength) fail('chatgpt_export_archive_invalid');
  return view.getUint32(offset, true);
}

function safeArchivePath(name: string): boolean {
  if (!name || name.includes('\0') || name.includes('\\') || name.startsWith('/')) return false;
  const parts = name.split('/');
  return !parts.some((part) => part === '..' || part === '.') && !/^[A-Za-z]:/.test(name);
}

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

async function inflateRaw(
  bytes: Uint8Array,
  expectedSize: number,
  maxSize: number,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  if (typeof DecompressionStream !== 'function') {
    fail('chatgpt_export_deflate_unsupported');
  }
  try {
    const source = new Response(bytes.slice().buffer).body;
    if (!source) fail('chatgpt_export_archive_invalid');
    const stream = source.pipeThrough(new DecompressionStream('deflate-raw' as CompressionFormat));
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      checkCancelled(signal);
      const result = await reader.read();
      if (result.done) break;
      const chunk = new Uint8Array(result.value);
      total += chunk.length;
      if (total > expectedSize || total > maxSize) {
        await reader.cancel();
        fail('chatgpt_export_entry_too_large');
      }
      chunks.push(chunk);
    }
    const output = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      output.set(chunk, offset);
      offset += chunk.length;
    }
    return output;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('chatgpt_export_')) throw error;
    return fail('chatgpt_export_archive_invalid');
  }
}

async function extractConversationsJson(
  archive: Uint8Array,
  limits: ChatGptImportLimits,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  const view = dataView(archive);
  const minimum = Math.max(0, archive.length - ZIP_END_MAX_SEARCH);
  let endOffset = -1;
  for (let offset = archive.length - ZIP_END_MIN_SIZE; offset >= minimum; offset -= 1) {
    if (u32(view, offset) === ZIP_END) {
      endOffset = offset;
      break;
    }
  }
  if (endOffset < 0) fail('chatgpt_export_archive_invalid');
  if (u16(view, endOffset + 4) !== 0 || u16(view, endOffset + 6) !== 0) {
    fail('chatgpt_export_archive_multidisk_unsupported');
  }
  const entryCount = u16(view, endOffset + 10);
  const centralSize = u32(view, endOffset + 12);
  const centralOffset = u32(view, endOffset + 16);
  if (entryCount > limits.maxEntries) fail('chatgpt_export_archive_too_many_entries');
  if (centralOffset + centralSize > endOffset) fail('chatgpt_export_archive_invalid');

  const decoder = new TextDecoder('utf-8', { fatal: true });
  let cursor = centralOffset;
  let conversationsEntry:
    | {
        flags: number;
        method: number;
        checksum: number;
        compressedSize: number;
        uncompressedSize: number;
        localOffset: number;
      }
    | undefined;

  for (let index = 0; index < entryCount; index += 1) {
    checkCancelled(signal);
    if (u32(view, cursor) !== ZIP_CENTRAL_HEADER) fail('chatgpt_export_archive_invalid');
    const flags = u16(view, cursor + 8);
    const method = u16(view, cursor + 10);
    const checksum = u32(view, cursor + 16);
    const compressedSize = u32(view, cursor + 20);
    const uncompressedSize = u32(view, cursor + 24);
    const nameLength = u16(view, cursor + 28);
    const extraLength = u16(view, cursor + 30);
    const commentLength = u16(view, cursor + 32);
    const localOffset = u32(view, cursor + 42);
    const next = cursor + 46 + nameLength + extraLength + commentLength;
    if (next > centralOffset + centralSize) fail('chatgpt_export_archive_invalid');
    let name: string;
    try {
      name = decoder.decode(archive.subarray(cursor + 46, cursor + 46 + nameLength));
    } catch {
      return fail('chatgpt_export_archive_path_invalid');
    }
    if (!safeArchivePath(name)) fail('chatgpt_export_archive_path_invalid');
    if ((flags & 0x0001) !== 0) fail('chatgpt_export_archive_encrypted');
    if (uncompressedSize > limits.maxEntryBytes) fail('chatgpt_export_entry_too_large');
    if (
      uncompressedSize > 1024 * 1024 &&
      uncompressedSize / Math.max(1, compressedSize) > limits.maxCompressionRatio
    ) {
      fail('chatgpt_export_archive_compression_ratio_invalid');
    }
    if (name === 'conversations.json') {
      if (conversationsEntry) fail('chatgpt_export_conversations_duplicate');
      conversationsEntry = {
        flags,
        method,
        checksum,
        compressedSize,
        uncompressedSize,
        localOffset,
      };
    }
    cursor = next;
  }
  if (cursor !== centralOffset + centralSize) fail('chatgpt_export_archive_invalid');
  if (!conversationsEntry) fail('chatgpt_export_conversations_missing');

  const entry = conversationsEntry;
  if (u32(view, entry.localOffset) !== ZIP_LOCAL_HEADER) fail('chatgpt_export_archive_invalid');
  const localFlags = u16(view, entry.localOffset + 6);
  const localMethod = u16(view, entry.localOffset + 8);
  if (localFlags !== entry.flags || localMethod !== entry.method) {
    fail('chatgpt_export_archive_invalid');
  }
  const localNameLength = u16(view, entry.localOffset + 26);
  const localExtraLength = u16(view, entry.localOffset + 28);
  const dataOffset = entry.localOffset + 30 + localNameLength + localExtraLength;
  const dataEnd = dataOffset + entry.compressedSize;
  if (dataEnd > centralOffset) fail('chatgpt_export_archive_invalid');
  const compressed = archive.subarray(dataOffset, dataEnd);
  let output: Uint8Array;
  if (entry.method === 0) output = compressed.slice();
  else if (entry.method === 8) {
    output = await inflateRaw(compressed, entry.uncompressedSize, limits.maxEntryBytes, signal);
  } else return fail('chatgpt_export_compression_unsupported');
  if (output.length !== entry.uncompressedSize || crc32(output) !== entry.checksum) {
    fail('chatgpt_export_archive_checksum_invalid');
  }
  return output;
}

function optionalTimestamp(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.round(value * 1000)
    : undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function messageText(message: Record<string, unknown>, limits: ChatGptImportLimits): string {
  const content = record(message.content);
  const parts = Array.isArray(content?.parts) ? content.parts : [];
  const text = parts.filter((part): part is string => typeof part === 'string').join('\n');
  if (new TextEncoder().encode(text).length > limits.maxMessageTextBytes) {
    fail('chatgpt_export_message_too_large');
  }
  return text;
}

function normalizeRole(value: unknown): BrowserChatSnapshotMessage['role'] {
  return value === 'user' || value === 'assistant' || value === 'system' || value === 'tool'
    ? value
    : 'unknown';
}

function parseConversation(
  value: unknown,
  limits: ChatGptImportLimits,
  signal?: AbortSignal,
): ParsedConversation {
  const source = record(value);
  if (!source) fail('chatgpt_export_conversation_invalid');
  const providerConversationKey = boundedString(
    source.id,
    'chatgpt_export_conversation_id_invalid',
    512,
  );
  const title =
    typeof source.title === 'string' && source.title.trim()
      ? source.title.trim().slice(0, 4096)
      : 'Untitled ChatGPT conversation';
  const mapping = record(source.mapping);
  if (!mapping) fail('chatgpt_export_mapping_invalid');
  const messages: BrowserChatSnapshotMessage[] = [];
  const currentNode = typeof source.current_node === 'string' ? source.current_node : undefined;
  const orderedNodes: Record<string, unknown>[] = [];
  const mappedNodes = Object.entries(mapping)
    .map(([id, value]) => [id, record(value)] as const)
    .filter((entry): entry is readonly [string, Record<string, unknown>] => entry[1] !== undefined);
  const parentIds = new Set(
    mappedNodes.flatMap(([, node]) =>
      typeof node.parent === 'string' && mapping[node.parent] ? [node.parent] : [],
    ),
  );
  const leafIds = mappedNodes.map(([id]) => id).filter((id) => !parentIds.has(id));
  const selectedNode =
    currentNode && record(mapping[currentNode])
      ? currentNode
      : leafIds.length === 1
        ? leafIds[0]
        : undefined;
  if (!selectedNode) fail('chatgpt_export_conversation_branch_ambiguous');

  const seen = new Set<string>();
  let nodeId: string | undefined = selectedNode;
  while (nodeId) {
    checkCancelled(signal);
    if (seen.has(nodeId)) fail('chatgpt_export_mapping_cycle');
    seen.add(nodeId);
    const node = record(mapping[nodeId]);
    if (!node) fail('chatgpt_export_mapping_invalid');
    orderedNodes.push(node);
    nodeId = typeof node.parent === 'string' ? node.parent : undefined;
    if (orderedNodes.length > limits.maxMessagesPerConversation * 2) {
      fail('chatgpt_export_mapping_too_large');
    }
  }
  orderedNodes.reverse();

  for (const [index, node] of orderedNodes.entries()) {
    checkCancelled(signal);
    const sourceMessage = record(node.message);
    if (!sourceMessage) continue;
    const author = record(sourceMessage.author);
    const text = messageText(sourceMessage, limits);
    if (!text) continue;
    const id =
      typeof sourceMessage.id === 'string' && sourceMessage.id.trim()
        ? sourceMessage.id.trim().slice(0, 512)
        : `${providerConversationKey}:message:${index}`;
    messages.push({
      id,
      parentId:
        typeof node.parent === 'string' && node.parent.trim()
          ? node.parent.trim().slice(0, 512)
          : undefined,
      role: normalizeRole(author?.role),
      createdAt: optionalTimestamp(sourceMessage.create_time),
      text,
    });
    if (messages.length > limits.maxMessagesPerConversation) {
      fail('chatgpt_export_conversation_too_large');
    }
  }

  return {
    providerConversationKey,
    title,
    providerCreatedAt: optionalTimestamp(source.create_time),
    providerUpdatedAt: optionalTimestamp(source.update_time),
    messages,
  };
}

function parseConversationsJson(
  bytes: Uint8Array,
  limits: ChatGptImportLimits,
  signal?: AbortSignal,
): ParsedConversation[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    return fail('chatgpt_export_json_invalid');
  }
  if (!Array.isArray(parsed)) fail('chatgpt_export_json_invalid');
  if (parsed.length > limits.maxConversations) fail('chatgpt_export_too_many_conversations');
  const conversations = parsed.map((value) => parseConversation(value, limits, signal));
  const ids = new Set<string>();
  for (const conversation of conversations) {
    if (ids.has(conversation.providerConversationKey)) {
      fail('chatgpt_export_conversation_duplicate');
    }
    ids.add(conversation.providerConversationKey);
  }
  return conversations;
}

async function sha256(value: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', value.slice().buffer);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function prepareConversations(
  conversations: ParsedConversation[],
  signal?: AbortSignal,
): Promise<PreparedConversation[]> {
  const prepared: PreparedConversation[] = [];
  for (const conversation of conversations) {
    checkCancelled(signal);
    prepared.push({
      ...conversation,
      contentHash: await sha256(
        new TextEncoder().encode(
          JSON.stringify({
            title: conversation.title,
            providerCreatedAt: conversation.providerCreatedAt,
            providerUpdatedAt: conversation.providerUpdatedAt,
            messages: conversation.messages,
          }),
        ),
      ),
    });
  }
  return prepared;
}

export function createChatGptSnapshotRepository(database: JarvisDexie) {
  return {
    async list(scopeInput: ChatGptSnapshotScope, search = ''): Promise<BrowserChatSnapshotRow[]> {
      const scope = normalizeScope(scopeInput);
      const rows = await database.browser_chat_snapshots
        .where('[accountId+workspaceId]')
        .equals([scope.accountId, scope.workspaceId])
        .toArray();
      const needle = search.trim().toLocaleLowerCase();
      return rows
        .filter(
          (row) =>
            !needle ||
            row.title.toLocaleLowerCase().includes(needle) ||
            row.messages.some((message) => message.text.toLocaleLowerCase().includes(needle)),
        )
        .sort((left, right) => right.updatedAt - left.updatedAt);
    },

    async get(
      scopeInput: ChatGptSnapshotScope,
      idInput: string,
    ): Promise<BrowserChatSnapshotRow | undefined> {
      const scope = normalizeScope(scopeInput);
      const id = boundedString(idInput, 'chatgpt_export_snapshot_id_invalid', 256);
      const row = await database.browser_chat_snapshots.get(id);
      return row?.accountId === scope.accountId && row.workspaceId === scope.workspaceId
        ? row
        : undefined;
    },

    async remove(scopeInput: ChatGptSnapshotScope, idInput: string): Promise<void> {
      const scope = normalizeScope(scopeInput);
      const id = boundedString(idInput, 'chatgpt_export_snapshot_id_invalid', 256);
      await database.transaction('rw', database.browser_chat_snapshots, async () => {
        const row = await database.browser_chat_snapshots.get(id);
        if (row?.accountId !== scope.accountId || row.workspaceId !== scope.workspaceId) {
          fail('chatgpt_export_snapshot_not_found');
        }
        await database.browser_chat_snapshots.delete(id);
      });
    },
  };
}

export async function importChatGptExport(
  input: ImportChatGptExportInput,
): Promise<ChatGptImportResult> {
  const scope = normalizeScope(input);
  const limits = { ...DEFAULT_LIMITS, ...input.limits };
  const archive = toBytes(input.archive);
  const fileName = boundedString(input.fileName, 'chatgpt_export_file_name_invalid', 512);
  const clock = input.clock ?? Date.now;
  const idFactory = input.idFactory ?? (() => crypto.randomUUID());
  if (archive.length > limits.maxArchiveBytes) fail('chatgpt_export_archive_too_large');
  checkCancelled(input.signal);
  input.onProgress?.({ phase: 'hashing', completed: 0, total: archive.length });
  const fileHash = await sha256(archive);
  checkCancelled(input.signal);

  const priorImport = await input.database.browser_chat_imports
    .where('[accountId+workspaceId+provider+fileHash]')
    .equals([scope.accountId, scope.workspaceId, 'chatgpt', fileHash])
    .first();
  if (priorImport) {
    input.onProgress?.({ phase: 'complete', completed: 1, total: 1 });
    return {
      importId: priorImport.id,
      added: 0,
      updated: 0,
      unchanged: priorImport.conversationCount,
      reusedImport: true,
    };
  }

  input.onProgress?.({ phase: 'extracting', completed: 0, total: 1 });
  const jsonBytes = await extractConversationsJson(archive, limits, input.signal);
  checkCancelled(input.signal);
  input.onProgress?.({ phase: 'parsing', completed: 0, total: jsonBytes.length });
  checkCancelled(input.signal);
  const conversations = await prepareConversations(
    parseConversationsJson(jsonBytes, limits, input.signal),
    input.signal,
  );
  checkCancelled(input.signal);
  input.onProgress?.({ phase: 'writing', completed: 0, total: conversations.length });
  checkCancelled(input.signal);

  const importId = boundedString(idFactory(), 'chatgpt_export_import_id_invalid', 256);
  const importedAt = clock();
  const importRow: BrowserChatImportRow = {
    id: importId,
    ...scope,
    provider: 'chatgpt',
    fileName,
    fileSize: archive.length,
    fileHash,
    status: 'complete',
    conversationCount: conversations.length,
    importedAt,
  };

  const result = await input.database.transaction(
    'rw',
    input.database.browser_chat_imports,
    input.database.browser_chat_snapshots,
    async () => {
      const duplicate = await input.database.browser_chat_imports
        .where('[accountId+workspaceId+provider+fileHash]')
        .equals([scope.accountId, scope.workspaceId, 'chatgpt', fileHash])
        .first();
      if (duplicate) {
        return {
          importId: duplicate.id,
          added: 0,
          updated: 0,
          unchanged: duplicate.conversationCount,
          reusedImport: true,
        };
      }

      let added = 0;
      let updated = 0;
      let unchanged = 0;
      for (const [index, conversation] of conversations.entries()) {
        checkCancelled(input.signal);
        const current = await input.database.browser_chat_snapshots
          .where('[accountId+workspaceId+provider+providerConversationKey]')
          .equals([
            scope.accountId,
            scope.workspaceId,
            'chatgpt',
            conversation.providerConversationKey,
          ])
          .first();
        if (current?.contentHash === conversation.contentHash) {
          unchanged += 1;
        } else if (current) {
          await input.database.browser_chat_snapshots.put({
            ...current,
            ...conversation,
            importId,
            messageCount: conversation.messages.length,
            revision: current.revision + 1,
            updatedAt: importedAt,
          });
          updated += 1;
        } else {
          const row: BrowserChatSnapshotRow = {
            id: boundedString(idFactory(), 'chatgpt_export_snapshot_id_invalid', 256),
            ...scope,
            provider: 'chatgpt',
            providerConversationKey: conversation.providerConversationKey,
            importId,
            title: conversation.title,
            providerCreatedAt: conversation.providerCreatedAt,
            providerUpdatedAt: conversation.providerUpdatedAt,
            messageCount: conversation.messages.length,
            contentHash: conversation.contentHash,
            revision: 1,
            messages: conversation.messages,
            createdAt: importedAt,
            updatedAt: importedAt,
          };
          await input.database.browser_chat_snapshots.add(row);
          added += 1;
        }
        input.onProgress?.({
          phase: 'writing',
          completed: index + 1,
          total: conversations.length,
        });
      }
      checkCancelled(input.signal);
      await input.database.browser_chat_imports.add(importRow);
      return { importId, added, updated, unchanged, reusedImport: false };
    },
  );
  input.onProgress?.({ phase: 'complete', completed: 1, total: 1 });
  return result;
}
