import { describe, expect, it, vi } from 'vitest';
import { HarnessError } from '@/lib/harness/errors';
import type { VibeSpaceHarness } from '@/lib/harness/types';
import {
  createContextQueryService,
  type ContextQueryRepository,
  type ContextSearchItem,
} from './contextQueryService';
import { createContextPointer, createContextRecord } from './losslessContext';
import {
  createContextMapRlmRepository,
  createOpenCodeRlmChildRunner,
  createProductionFederatedRlmRepository,
  requestsMappedFileAuthority,
  mentionsMappedPath,
  synthesizeEvidencePack,
} from './contextRlmProduction';

const SHA = `sha256:${'a'.repeat(64)}` as const;

describe('synthesizeEvidencePack provider boundary', () => {
  it('keeps child answers and cited source spans whole within a serialized response budget', async () => {
    const pointers = Array.from({ length: 6 }, (_, index) => ({
      id: `pointer-${index}`, recordId: `record-${index}`, byteStart: 0, byteEnd: 9_000,
      sourceVersion: SHA, contentHash: 'a'.repeat(64),
    }));
    const sources = pointers.map((_, index) =>
      `SOURCE_${index}_BEGIN\n${'😀"\\'.repeat(1_500)}\nSOURCE_${index}_END`);
    const childAnswer = 'The cited source establishes the watchdog timer branch at sched/wdog/wd_start.c:80-374.';
    const result = await synthesizeEvidencePack({
      question: 'What happens to the watchdog timer?', scope: {} as never,
      evidence: pointers.map((pointer, index) => ({
        pointer, record: { path: `sched/wdog/source-${index}.c` },
        lineStart: 1, lineEnd: 400, text: sources[index],
      })) as never,
      childAnalyses: [{ answer: childAnswer, citations: [pointers[1]] }] as never,
      signal: new AbortController().signal,
    });

    expect(JSON.stringify(result).length).toBeLessThanOrEqual(20 * 1024);
    expect(result.citations).toEqual(pointers);
    expect(result.answer).toContain(`CHILD_1=${childAnswer}`);
    expect(result.answer).toContain(`EVIDENCE_2_TEXT=${sources[1]}`);
    for (const [index, source] of sources.entries()) {
      const complete = result.answer.includes(`EVIDENCE_${index + 1}_TEXT=${source}`);
      const omitted = result.answer.includes(`EVIDENCE_${index + 1}_TEXT_OMITTED=bounded provider result`);
      expect(complete || omitted).toBe(true);
      expect(complete && omitted).toBe(false);
      expect(result.answer).toContain(`EVIDENCE_${index + 1}_POINTER=`);
    }
  });

  it('fails closed when even the complete child analysis exceeds the provider budget', () => {
    expect(() => synthesizeEvidencePack({
      question: 'Source question', scope: {} as never, evidence: [],
      childAnalyses: [{ answer: 'x'.repeat(21 * 1024), citations: [] }],
      signal: new AbortController().signal,
    })).toThrow('rlm_synthesis_essential_evidence_too_large');
  });
});

async function contentSha(content: string): Promise<`sha256:${string}`> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(content));
  return `sha256:${[...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')}`;
}

async function shardManifestSha(
  shards: readonly Record<string, unknown>[],
): Promise<`sha256:${string}`> {
  return contentSha(
    JSON.stringify(
      shards.map((shard) => [
        shard.index,
        shard.tokenStart,
        shard.tokenEnd,
        shard.file,
        shard.contentSha256,
      ]),
    ),
  );
}

describe('requestsMappedFileAuthority', () => {
  it.each([
    'Please read the files and answer with the exact source filename.',
    'What is the source file for this fact?',
    'Cite the source path.',
  ])('routes explicit mapped-file questions away from chat history: %s', (query) => {
    expect(requestsMappedFileAuthority(query)).toBe(true);
  });

  it('keeps ordinary cross-history research federated', () => {
    expect(requestsMappedFileAuthority('Summarize what we decided about the release.')).toBe(false);
  });
});

describe('mentionsMappedPath original-name chunk matching', () => {
  it('control: recognizes the exact physical chunk path', () => {
    expect(
      mentionsMappedPath(
        'Read the tail of folder/dependencies.txt.part-003.txt.',
        'folder/dependencies.txt.part-003.txt',
      ),
    ).toBe(true);
  });

  it('does not match another file with a similar name', () => {
    expect(
      mentionsMappedPath('Read folder/not-dependencies.txt.bak.', 'folder/dependencies.txt'),
    ).toBe(false);
  });

  it('matches an original source name against its physical chunk path', () => {
    expect(
      mentionsMappedPath(
        'Read the tail of folder/dependencies.txt.',
        'folder/dependencies.txt.part-003.txt',
      ),
    ).toBe(true);
  });

  it('does not match a different original name against a chunk path', () => {
    expect(
      mentionsMappedPath(
        'Read the tail of folder/package-lock.json.',
        'folder/dependencies.txt.part-003.txt',
      ),
    ).toBe(false);
  });

  it('matches an original name whose query mention carries a folder prefix', () => {
    expect(
      mentionsMappedPath(
        'read the tail of 100k/requirements.txt and quote the last declaration',
        'repo/100k/requirements.txt.part-023.txt',
      ),
    ).toBe(true);
  });

  it('matches the query folder suffix against a longer physical path', () => {
    expect(
      mentionsMappedPath(
        'read the tail of 100k/requirements.txt.',
        'C:/repo/corpus-chunks/100k/requirements.txt.part-023.txt',
      ),
    ).toBe(true);
  });

  it('does not match a same-basename chunk in a different folder', () => {
    expect(
      mentionsMappedPath(
        'read the tail of 100k/requirements.txt.',
        'repo/other/requirements.txt.part-001.txt',
      ),
    ).toBe(false);
  });
});

describe('production Context Map RLM repository multi-part logical sources', () => {
  function multiPartRepository(input: {
    partCount: number;
    duplicateBasename?: boolean;
    fillerFiles?: number;
  }) {
    const partOf = (index: number) =>
      `C:\\repo\\100k\\requirements.txt.part-${String(index).padStart(3, '0')}.txt`;
    const partContent = (index: number) =>
      index === input.partCount - 1
        ? `package99999[security]==1.0.0; python_version >= "3.8" \\\n# final logical record`
        : `package${index}[security]==1.0.0; python_version >= "3.8" \\`;
    const contents = new Map<string, string>();
    for (let index = 0; index < input.partCount; index += 1) {
      contents.set(partOf(index), partContent(index));
    }
    if (input.duplicateBasename) {
      contents.set(
        'C:\\repo\\other\\requirements.txt.part-001.txt',
        'package0[security]==9.9.9; python_version >= "3.7" \\',
      );
    }
    for (let index = 0; index < (input.fillerFiles ?? 0); index += 1) {
      contents.set(`C:\\repo\\filler\\notes-${index}.txt`, `unrelated filler content ${index}`);
    }
    const nodes = [...contents.keys()].map((path, index) => ({
      id: `node-${index}`,
      kind: 'file' as const,
      title: path.split('\\').at(-1)!,
      summary: '',
      path,
      sizeBytes: contents.get(path)!.length,
      modifiedAt: 20,
    }));
    const repository = createContextMapRlmRepository({
      loadMaps: vi.fn(async () => [
        {
          id: 'map-corpus',
          projectId: 'project-1',
          rootDir: 'C:\\repo',
          status: 'active' as const,
          updatedAt: 20,
          tree: { nodes },
        },
      ]),
      stat: vi.fn(async (path: string) => ({
        ok: true as const,
        path,
        kind: 'file' as const,
        size: contents.get(path)!.length,
        createdMs: 20,
        modifiedMs: 20,
        sha256: await contentSha(contents.get(path)!),
      })),
      read: vi.fn(async (path: string) => ({
        ok: true as const,
        path,
        content: contents.get(path)!,
      })),
      lexicalSearch: vi.fn(async () => []),
    });
    return { repository, contents };
  }

  it('keeps genuine pagination for an explicitly named source with more than six physical parts', async () => {
    const { repository } = multiPartRepository({ partCount: 8, duplicateBasename: true });
    const service = createContextQueryService({ repository });
    const result = await service.search({
      scope: { accountId: 'account-1', projectId: 'project-1' },
      query: 'Read source file 100k/requirements.txt.', limit: 6,
    });
    expect(result.items).toHaveLength(6);
    expect(result.truncated).toBe(true);
    expect(result.continuation).toBeDefined();
    expect(result.items.every(item => !item.preview.includes('==9.9.9'))).toBe(true);
  });

  it('selects the final logical part for an original-name LAST-record question', async () => {
    const { repository } = multiPartRepository({ partCount: 24 });
    const scope = { accountId: 'account-1', projectId: 'project-1' };
    // Frozen-prompt wording: original source name, not the physical chunk name.
    const hits = await repository.search(
      scope,
      'for the 100k requirements.txt source, give the count of actual packageN[security] requirement declarations and the final package. Quote the last declaration.',
    );
    expect(hits.length).toBeGreaterThan(0);
    const finalHit = hits.find((hit) => hit.preview.includes('package99999'));
    expect(finalHit, 'final logical part must be selected').toBeDefined();
    expect(finalHit!.preview).toContain('[SOURCE FILE: requirements.txt.part-023.txt]');
    // The tail question windows the end of the final part, not its start.
    expect(finalHit!.pointer.byteStart).toBe(0);
    expect(finalHit!.pointer.byteEnd).toBeGreaterThan(finalHit!.pointer.byteStart ?? 0);
    // Duplicate-folder basenames were absent here; every reported hit must be
    // one of this source's own physical parts.
    for (const hit of hits) {
      expect(hit.preview).toContain('requirements.txt.part-');
    }
    // The final part leads because the tail-positioned window names it.
    expect(hits[0]!.preview).toContain('package99999');
  });

  it('keeps duplicate basenames in different folders isolated to the named folder', async () => {
    const { repository } = multiPartRepository({ partCount: 24, duplicateBasename: true });
    const scope = { accountId: 'account-1', projectId: 'project-1' };
    const hits = await repository.search(
      scope,
      'read the tail of 100k/requirements.txt and quote the last declaration',
    );
    expect(hits.length).toBeGreaterThan(0);
    for (const hit of hits) {
      expect(hit.preview).not.toContain('==9.9.9');
    }
    expect(hits.some((hit) => hit.preview.includes('package99999'))).toBe(true);
  });

  it('never boosts a same-basename part from an unnamed folder as the tail boundary', async () => {
    // The unnamed folder carries the globally-highest part number; the tail of
    // the NAMED source must still come from its own final part.
    const { repository } = multiPartRepository({ partCount: 3, duplicateBasename: true });
    const scope = { accountId: 'account-1', projectId: 'project-1' };
    const hits = await repository.search(
      scope,
      'read the tail of 100k/requirements.txt and quote the last declaration',
    );
    expect(hits.length).toBeGreaterThan(0);
    const tail = hits.find((hit) => hit.preview.includes('package99999'));
    expect(tail, 'named source final part must be selected').toBeDefined();
    expect(tail!.preview).toContain('[SOURCE FILE: requirements.txt.part-002.txt]');
    for (const hit of hits) {
      expect(hit.preview).not.toContain('==9.9.9');
    }
  });

  it('treats FINAL-worded frozen prompts as tail requests and boosts the final part', async () => {
    const { repository } = multiPartRepository({ partCount: 24 });
    const scope = { accountId: 'account-1', projectId: 'project-1' };
    // Frozen prompts word the tail as "final", not last/tail/end; the named
    // source's final part must win the boundary boost.
    const hits = await repository.search(
      scope,
      'for the 100k requirements.txt source, quote the final declaration and the final package numeric suffix',
    );
    expect(hits.length).toBeGreaterThan(0);
    const finalHit = hits.find((hit) => hit.preview.includes('package99999'));
    expect(finalHit, 'final-worded prompt must select the final part').toBeDefined();
    expect(finalHit!.preview).toContain('[SOURCE FILE: requirements.txt.part-023.txt]');
  });
});

function fixedRepository(input: {
  id: string;
  sourceId: string;
  sourceKind: 'file_version' | 'chat_message' | 'context_note';
  text: string;
  score: number;
  issuePointers?: (items: readonly ContextSearchItem[]) => boolean;
  authorizePointer?: ContextQueryRepository['authorizePointer'];
}): ContextQueryRepository {
  const contentHash = input.id.endsWith('siyuan')
    ? 'c'.repeat(64)
    : input.id.includes('history')
      ? 'b'.repeat(64)
      : 'a'.repeat(64);
  const bytes = new TextEncoder().encode(input.text);
  const record = createContextRecord({
    id: input.id,
    accountId: 'account-1',
    projectId: 'project-1',
    sourceKind: input.sourceKind,
    sourceId: input.sourceId,
    createdAt: 1,
    contentHash,
    contentRef: `test://${input.sourceId}`,
    title: input.sourceId,
    trustLevel: 'app_verified',
    sensitivity: 'project_private',
  });
  const pointer = createContextPointer({
    id: `ptr:${record.id}:0:${bytes.length}`,
    recordId: record.id,
    byteStart: 0,
    byteEnd: bytes.length,
    sourceVersion: `sha256:${contentHash}`,
    contentHash,
  });
  return {
    async listRecords() {
      return [record];
    },
    async getRecord(id) {
      return id === record.id ? record : undefined;
    },
    async search() {
      return [{ recordId: record.id, pointer, preview: input.text, score: input.score }];
    },
    async readSource(candidate) {
      return candidate.id === record.id
        ? { bytes, contentHash, sourceVersion: `sha256:${contentHash}` }
        : undefined;
    },
    async canOpen(candidate, scope) {
      return (
        candidate.id === record.id &&
        scope.accountId === record.accountId &&
        scope.projectId === record.projectId
      );
    },
    validatePointer(candidate, candidateRecord, source) {
      return (
        candidate.id === pointer.id &&
        candidateRecord.id === record.id &&
        source.contentHash === contentHash
      );
    },
    ...(input.authorizePointer ? { authorizePointer: input.authorizePointer } : {}),
    ...(input.issuePointers
      ? {
          issuePointers(items: readonly ContextSearchItem[]) {
            return input.issuePointers!(items);
          },
        }
      : {}),
  };
}

describe('production RLM federation authority routing', () => {
  it('rehydrates a missing SiYuan pointer through only its owner', async () => {
    const mapped = fixedRepository({
      id: `rlm:${'1'.repeat(64)}`, sourceId: 'mapped',
      sourceKind: 'file_version', text: 'mapped', score: 1,
    });
    const history = fixedRepository({
      id: 'rlm:history:chat_message:message-1:bbbbbbbbbbbbbbbb', sourceId: 'history',
      sourceKind: 'chat_message', text: 'history', score: 1,
    });
    const siyuan = fixedRepository({
      id: 'siyuan:cccccccccccccccccccccccc:block-siyuan', sourceId: 'siyuan',
      sourceKind: 'context_note', text: 'siyuan', score: 1,
    });
    const mappedList = vi.spyOn(mapped, 'listRecords');
    const historyList = vi.spyOn(history, 'listRecords');
    const siyuanList = vi.spyOn(siyuan, 'listRecords');
    const service = createContextQueryService({
      repository: createProductionFederatedRlmRepository(mapped, history, siyuan),
    });
    const scope = { accountId: 'account-1', projectId: 'project-1' };
    const pointer = createContextPointer({
      id: 'ptr:missing-siyuan',
      recordId: 'siyuan:cccccccccccccccccccccccc:missing-block',
      byteStart: 0, byteEnd: 1,
      sourceVersion: `sha256:${'c'.repeat(64)}`,
      contentHash: 'c'.repeat(64),
    });

    await expect(service.open({ scope, pointer })).rejects.toMatchObject({
      code: 'record_missing',
    });
    expect(siyuanList).toHaveBeenCalledTimes(1);
    expect(mappedList).not.toHaveBeenCalled();
    expect(historyList).not.toHaveBeenCalled();
  });

  it('issues and validates mixed mapped-file, history, and SiYuan pointers through their owner', async () => {
    const mappedIssue = vi.fn((_items: readonly ContextSearchItem[]) => true);
    const siyuanIssue = vi.fn((_items: readonly ContextSearchItem[]) => true);
    const mappedAuthorize = vi.fn(async () => true);
    const historyAuthorize = vi.fn(async () => true);
    const siyuanAuthorize = vi.fn(async () => true);
    const mapped = fixedRepository({
      id: `rlm:${'1'.repeat(64)}`,
      sourceId: 'mapped',
      sourceKind: 'file_version',
      text: 'mapped evidence',
      score: 3,
      issuePointers: mappedIssue,
      authorizePointer: mappedAuthorize,
    });
    const history = fixedRepository({
      id: 'rlm:history:chat_message:message-1:bbbbbbbbbbbbbbbb',
      sourceId: 'history',
      sourceKind: 'chat_message',
      text: 'history evidence',
      score: 2,
      authorizePointer: historyAuthorize,
    });
    const siyuan = fixedRepository({
      id: 'siyuan:cccccccccccccccccccccccc:block-siyuan',
      sourceId: 'siyuan',
      sourceKind: 'context_note',
      text: 'siyuan evidence',
      score: 1,
      issuePointers: siyuanIssue,
      authorizePointer: siyuanAuthorize,
    });
    const service = createContextQueryService({
      repository: createProductionFederatedRlmRepository(mapped, history, siyuan),
    });
    const scope = { accountId: 'account-1', projectId: 'project-1' };

    const result = await service.search({ scope, query: 'evidence' });

    expect(result.items.map((item) => item.record.sourceId)).toEqual([
      'mapped',
      'history',
      'siyuan',
    ]);
    expect(mappedIssue).toHaveBeenCalledTimes(1);
    expect(mappedIssue.mock.calls[0]?.[0]).toHaveLength(1);
    expect(siyuanIssue).toHaveBeenCalledTimes(1);
    expect(siyuanIssue.mock.calls[0]?.[0]).toHaveLength(1);
    await expect(
      Promise.all(result.items.map((item) => service.open({ scope, pointer: item.pointer }))),
    ).resolves.toHaveLength(3);
    expect(mappedAuthorize).toHaveBeenCalledTimes(1);
    expect(historyAuthorize).toHaveBeenCalledTimes(1);
    expect(siyuanAuthorize).toHaveBeenCalledTimes(1);
  });

  it('keeps explicit mapped-file questions out of history and SiYuan search', async () => {
    const mapped = fixedRepository({
      id: `rlm:${'1'.repeat(64)}`,
      sourceId: 'mapped',
      sourceKind: 'file_version',
      text: 'mapped evidence',
      score: 1,
    });
    const history = fixedRepository({
      id: 'rlm:history:chat_message:message-1:bbbbbbbbbbbbbbbb',
      sourceId: 'history',
      sourceKind: 'chat_message',
      text: 'history evidence',
      score: 1,
    });
    const siyuan = fixedRepository({
      id: 'siyuan:cccccccccccccccccccccccc:block-siyuan',
      sourceId: 'siyuan',
      sourceKind: 'context_note',
      text: 'siyuan evidence',
      score: 1,
    });
    const mappedSearch = vi.spyOn(mapped, 'search');
    const historySearch = vi.spyOn(history, 'search');
    const siyuanSearch = vi.spyOn(siyuan, 'search');
    const repository = createProductionFederatedRlmRepository(mapped, history, siyuan);

    const hits = await repository.search(
      { accountId: 'account-1', projectId: 'project-1' },
      'Show the exact source file.',
    );

    expect(hits).toHaveLength(1);
    expect(mappedSearch).toHaveBeenCalledTimes(1);
    expect(historySearch).not.toHaveBeenCalled();
    expect(siyuanSearch).not.toHaveBeenCalled();
  });
});

function maps() {
  return [
    {
      id: 'map-1',
      projectId: 'project-1',
      rootDir: 'C:\\repo',
      status: 'active' as const,
      updatedAt: 20,
      tree: {
        nodes: [
          {
            id: 'file-1',
            kind: 'file' as const,
            title: 'book.txt',
            summary: 'A public-domain story.',
            path: 'C:\\repo\\book.txt',
            sizeBytes: 128,
            modifiedAt: 20,
          },
        ],
      },
    },
    {
      id: 'map-foreign',
      projectId: 'project-2',
      rootDir: 'C:\\other',
      status: 'active' as const,
      updatedAt: 30,
      tree: {
        nodes: [
          {
            id: 'foreign',
            kind: 'file' as const,
            title: 'foreign.txt',
            summary: 'Must stay isolated.',
            path: 'C:\\other\\foreign.txt',
          },
        ],
      },
    },
  ];
}

async function singleShardAddressRepository(
  descriptorInput: Record<string, unknown>,
  options: { duplicateDescriptor?: boolean } = {},
) {
  const shard = 'bounded physical address evidence';
  const shardSha = await contentSha(shard);
  const defaultShards = [
    {
      index: '0',
      tokenStart: '0',
      tokenEnd: '10000000001',
      file: 'shard.txt',
      contentSha256: shardSha,
    },
  ];
  const descriptor = JSON.stringify({
    version: 1,
    corpusId: 'bounded-corpus',
    totalTokens: '10000000001',
    shardSize: '10000000001',
    contentDigest: await shardManifestSha(defaultShards),
    generatedAt: 1,
    shards: defaultShards,
    ...descriptorInput,
  });
  const descriptorSha = await contentSha(descriptor);
  const paths = [
    'C:\\bounded\\.vibespace-large-address-v1.json',
    ...(options.duplicateDescriptor
      ? ['C:\\bounded\\nested\\.vibespace-large-address-v1.json']
      : []),
    'C:\\bounded\\shard.txt',
  ];
  const lexicalSearch = vi.fn(async () => []);
  const repository = createContextMapRlmRepository({
    loadMaps: vi.fn(async () => [
      {
        id: 'map-bounded',
        projectId: 'project-1',
        rootDir: 'C:\\bounded',
        status: 'active' as const,
        updatedAt: 1,
        tree: {
          nodes: paths.map((path, index) => ({
            id: `bounded-${index}`,
            kind: 'file',
            title: path.split('\\').at(-1)!,
            summary: '',
            path,
          })),
        },
      },
    ]),
    stat: vi.fn(async (path) => ({
      ok: true as const,
      path,
      kind: 'file' as const,
      size: path.endsWith('.json') ? descriptor.length : shard.length,
      createdMs: 1,
      modifiedMs: 1,
      sha256: path.endsWith('.json') ? descriptorSha : shardSha,
    })),
    read: vi.fn(async (path) => ({
      ok: true as const,
      path,
      content: path.endsWith('.json') ? descriptor : shard,
    })),
    lexicalSearch,
  });
  return { repository, lexicalSearch };
}

describe('production Context Map RLM repository', () => {
  it('describes a large scoped map from inventory without hashing all files', async () => {
    const stat = vi.fn(async () => { throw new Error('describe must not stat files'); });
    const read = vi.fn(async () => { throw new Error('describe must not read files'); });
    const nodes = Array.from({ length: 5_734 }, (_, index) => ({
      id: `node-${index}`, kind: 'file' as const, title: `file-${index}.c`,
      summary: '', path: `C:\\repo\\file-${index}.c`,
    }));
    const mapped = createContextMapRlmRepository({
      loadMaps: vi.fn(async () => [{
        id: 'map-large', projectId: 'project-1', rootDir: 'C:\\repo',
        status: 'active' as const, updatedAt: 20, tree: { nodes },
      }]),
      stat, read, lexicalSearch: vi.fn(async () => []),
    });
    const scope = { accountId: 'account-1', projectId: 'project-1' };

    await expect(mapped.describeSummary!(scope)).resolves.toEqual({
      recordCount: 5_734, sourceKinds: ['file_version'],
    });
    expect(stat).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
  });

  it('limits mapped source inventory to the active working root when the project has other maps', async () => {
    const mapped = createContextMapRlmRepository({
      loadMaps: vi.fn(async () => [
        { id: 'old-map', projectId: 'project-1', rootDir: 'D:/old-context',
          status: 'active' as const, updatedAt: 30, tree: { nodes: [
            { id: 'old-file', kind: 'file', title: 'known-facts.md', summary: '', path: 'D:/old-context/known-facts.md' },
          ] } },
        { id: 'nuttx-map', projectId: 'project-1', rootDir: 'D:/NuttX/source-core',
          status: 'active' as const, updatedAt: 20, tree: { nodes: [
            { id: 'wd-file', kind: 'file', title: 'wd_start_abstick.c', summary: '', path: 'D:/NuttX/source-core/wd_start_abstick.c' },
          ] } },
      ]),
      stat: vi.fn(async () => { throw new Error('description must not stat'); }),
      read: vi.fn(async () => { throw new Error('description must not read'); }),
      lexicalSearch: vi.fn(async () => []),
    });
    await expect(mapped.describeSummary!({ accountId: 'account-1', projectId: 'project-1', worktreeId: 'd:\\nuttx\\source-core\\' }))
      .resolves.toEqual({ recordCount: 1, sourceKinds: ['file_version'] });
    await expect(mapped.describeSummary!({ accountId: 'account-1', projectId: 'project-1', worktreeId: 'D:/NuttX' }))
      .resolves.toEqual({ recordCount: 1, sourceKinds: ['file_version'] });
  });

  it('routes an unsafe-integer logical address through one physical mapped descriptor and shard', async () => {
    const shard0 = 'sparse shard zero';
    const shard1 = 'SAFE_TRANSITION_ANSWER=amber-quartz';
    const shard0Sha = await contentSha(shard0);
    const shard1Sha = await contentSha(shard1);
    const shards = [
      {
        index: '0',
        tokenStart: '0',
        tokenEnd: '9007199254740992',
        file: 'shards/shard-0000.txt',
        contentSha256: shard0Sha,
      },
      {
        index: '1',
        tokenStart: '9007199254740992',
        tokenEnd: '9007199254740994',
        file: 'shards/shard-0001.txt',
        contentSha256: shard1Sha,
      },
    ];
    const descriptor = JSON.stringify({
      version: 1,
      corpusId: 'sparse-boundaries',
      totalTokens: '9007199254740994',
      shardSize: '9007199254740992',
      contentDigest: await shardManifestSha(shards),
      generatedAt: 1_700_000_000_000,
      shards,
    });
    const descriptorSha = await contentSha(descriptor);
    const contents: Record<string, string> = {
      'C:\\repo\\.vibespace-large-address-v1.json': descriptor,
      'C:\\repo\\shards\\shard-0000.txt': shard0,
      'C:\\repo\\shards\\shard-0001.txt': shard1,
    };
    const hashes: Record<string, `sha256:${string}`> = {
      'C:\\repo\\.vibespace-large-address-v1.json': descriptorSha,
      'C:\\repo\\shards\\shard-0000.txt': shard0Sha,
      'C:\\repo\\shards\\shard-0001.txt': shard1Sha,
    };
    const lexicalSearch = vi.fn(async () => []);
    const repository = createContextMapRlmRepository({
      loadMaps: vi.fn(async () => [
        {
          id: 'map-address',
          projectId: 'project-1',
          rootDir: 'C:\\repo',
          status: 'active' as const,
          updatedAt: 20,
          tree: {
            nodes: Object.keys(contents).map((path, index) => ({
              id: `node-${index}`,
              kind: 'file',
              title: path.split('\\').at(-1)!,
              summary: '',
              path,
              sizeBytes: contents[path]!.length,
              modifiedAt: 20,
            })),
          },
        },
      ]),
      stat: vi.fn(async (path) => ({
        ok: true as const,
        path,
        kind: 'file' as const,
        size: new TextEncoder().encode(contents[path]!).length,
        createdMs: 20,
        modifiedMs: 20,
        sha256: hashes[path]!,
      })),
      read: vi.fn(async (path) => ({ ok: true as const, path, content: contents[path]! })),
      lexicalSearch,
    });
    const scope = { accountId: 'account-1', projectId: 'project-1' };

    const first = await repository.address(scope, 'sparse-boundaries', '9007199254740993');
    const second = await repository.address(scope, 'sparse-boundaries', '9007199254740993');
    const firstShard = await repository.address(scope, 'sparse-boundaries', '0');

    expect(second).toEqual(first);
    expect(firstShard).toMatchObject({
      address: {
        position: '0',
        shard: '0',
        offset: '0',
        tokenStart: '0',
        tokenEnd: '9007199254740992',
      },
    });
    expect(first).toMatchObject({
      status: 'complete',
      stopReason: 'complete',
      address: {
        position: '9007199254740993',
        shard: '1',
        offset: '1',
        tokenStart: '9007199254740992',
        tokenEnd: '9007199254740994',
      },
      corpus: {
        corpusId: 'sparse-boundaries',
        totalTokens: '9007199254740994',
      },
      evidence: [
        {
          exactExcerpt: shard1,
          provenance: {
            contentDigest: shard1Sha,
            locator: expect.stringContaining('#token=9007199254740993&shard=1&offset=1'),
          },
        },
      ],
    });
    expect(lexicalSearch).not.toHaveBeenCalled();
  });

  it('fails closed on stale descriptor shard bytes before publishing address evidence', async () => {
    const expected = 'expected physical bytes';
    const stale = 'changed physical bytes';
    const expectedSha = await contentSha(expected);
    const shards = [
      {
        index: '0',
        tokenStart: '0',
        tokenEnd: '10000000001',
        file: 'shard.txt',
        contentSha256: expectedSha,
      },
    ];
    const descriptor = JSON.stringify({
      version: 1,
      corpusId: 'stale-corpus',
      totalTokens: '10000000001',
      shardSize: '10000000001',
      contentDigest: await shardManifestSha(shards),
      generatedAt: 1,
      shards,
    });
    const descriptorSha = await contentSha(descriptor);
    const repository = createContextMapRlmRepository({
      loadMaps: vi.fn(async () => [
        {
          id: 'map-stale',
          projectId: 'project-1',
          rootDir: 'C:\\stale',
          status: 'active' as const,
          updatedAt: 1,
          tree: {
            nodes: [
              {
                id: 'descriptor',
                kind: 'file',
                title: '.vibespace-large-address-v1.json',
                summary: '',
                path: 'C:\\stale\\.vibespace-large-address-v1.json',
              },
              {
                id: 'shard',
                kind: 'file',
                title: 'shard.txt',
                summary: '',
                path: 'C:\\stale\\shard.txt',
              },
            ],
          },
        },
      ]),
      stat: vi.fn(async (path) => ({
        ok: true as const,
        path,
        kind: 'file' as const,
        size: path.endsWith('.json') ? descriptor.length : stale.length,
        createdMs: 1,
        modifiedMs: 1,
        sha256: path.endsWith('.json') ? descriptorSha : expectedSha,
      })),
      read: vi.fn(async (path) => ({
        ok: true as const,
        path,
        content: path.endsWith('.json') ? descriptor : stale,
      })),
      lexicalSearch: vi.fn(async () => []),
    });

    await expect(
      repository.address(
        { accountId: 'account-1', projectId: 'project-1' },
        'stale-corpus',
        '10000000000',
      ),
    ).rejects.toThrow('large_address');
  });

  it.each([
    ['numeric token total', { totalTokens: 10_000_000_001 }],
    ['leading-zero token total', { totalTokens: '010000000001' }],
    ['declared digest mismatch', { contentDigest: `sha256:${'0'.repeat(64)}` }],
    [
      'gap before first shard',
      {
        shards: [
          {
            index: '0',
            tokenStart: '1',
            tokenEnd: '10000000001',
            file: 'shard.txt',
            contentSha256: `sha256:${'a'.repeat(64)}`,
          },
        ],
      },
    ],
    [
      'reversed shard range',
      {
        shards: [
          {
            index: '0',
            tokenStart: '10000000001',
            tokenEnd: '0',
            file: 'shard.txt',
            contentSha256: `sha256:${'a'.repeat(64)}`,
          },
        ],
      },
    ],
    [
      'out-of-root shard path',
      {
        shards: [
          {
            index: '0',
            tokenStart: '0',
            tokenEnd: '10000000001',
            file: '../foreign.txt',
            contentSha256: `sha256:${'a'.repeat(64)}`,
          },
        ],
      },
    ],
    [
      'Windows alternate-data-stream shard path',
      {
        shards: [
          {
            index: '0',
            tokenStart: '0',
            tokenEnd: '10000000001',
            file: 'shard.txt:stream',
            contentSha256: `sha256:${'a'.repeat(64)}`,
          },
        ],
      },
    ],
    [
      'duplicate physical shard path',
      {
        totalTokens: '2',
        shardSize: '1',
        shards: [
          {
            index: '0',
            tokenStart: '0',
            tokenEnd: '1',
            file: 'shard.txt',
            contentSha256: `sha256:${'a'.repeat(64)}`,
          },
          {
            index: '1',
            tokenStart: '1',
            tokenEnd: '2',
            file: 'shard.txt',
            contentSha256: `sha256:${'b'.repeat(64)}`,
          },
        ],
      },
    ],
  ])('fails closed for malformed physical descriptor: %s', async (_label, mutation) => {
    const { repository, lexicalSearch } = await singleShardAddressRepository(mutation);
    await expect(
      repository.address(
        { accountId: 'account-1', projectId: 'project-1' },
        'bounded-corpus',
        '10000000000',
      ),
    ).rejects.toThrow('large_address');
    expect(lexicalSearch).not.toHaveBeenCalled();
  });

  it('fails closed for duplicate corpus descriptors and out-of-range positions', async () => {
    const duplicate = await singleShardAddressRepository({}, { duplicateDescriptor: true });
    await expect(
      duplicate.repository.address(
        { accountId: 'account-1', projectId: 'project-1' },
        'bounded-corpus',
        '1',
      ),
    ).rejects.toThrow('large_address');
    expect(duplicate.lexicalSearch).not.toHaveBeenCalled();

    const bounded = await singleShardAddressRepository({});
    await expect(
      bounded.repository.address(
        { accountId: 'account-1', projectId: 'project-1' },
        'bounded-corpus',
        '10000000001',
      ),
    ).rejects.toThrow('large_address');
    expect(bounded.lexicalSearch).not.toHaveBeenCalled();
  });
  it('normalizes copied-file timestamp inversion before constructing authority', async () => {
    const content = 'Observatory Lumen uses cobalt-fern verification 47291.';
    const repository = createContextMapRlmRepository({
      loadMaps: vi.fn(async () => maps()),
      stat: vi.fn(async (path) => ({
        ok: true as const,
        path,
        kind: 'file' as const,
        size: new TextEncoder().encode(content).length,
        createdMs: 200,
        modifiedMs: 100,
        sha256: await contentSha(content),
      })),
      read: vi.fn(async (path) => ({ ok: true as const, path, content })),
      lexicalSearch: vi.fn(async () => []),
    });
    const scope = { accountId: 'account-1', projectId: 'project-1' };

    const hits = await repository.search(scope, 'Observatory Lumen');
    const record = await repository.getRecord(hits[0]!.recordId);

    expect(hits[0]?.preview).toContain('cobalt-fern');
    expect(record).toMatchObject({ createdAt: 100, updatedAt: 200 });
  });

  it('shares one authority-build stat pass across five parallel searches', async () => {
    const fixtureMaps = maps();
    const content = 'Observatory Lumen uses cobalt-fern verification 47291.';
    let releaseLexicalSearch!: () => void;
    const lexicalSearchGate = new Promise<void>((resolve) => {
      releaseLexicalSearch = resolve;
    });
    const stat = vi.fn(async (path: string, _includeSha256?: boolean) => ({
      ok: true as const,
      path,
      kind: 'file' as const,
      size: content.length,
      createdMs: 30,
      modifiedMs: 20,
      sha256: await contentSha(content),
    }));
    const lexicalSearch = vi.fn(async () => {
      await lexicalSearchGate;
      return [];
    });
    const read = vi.fn(async (path) => ({ ok: true as const, path, content }));
    const repository = createContextMapRlmRepository({
      loadMaps: vi.fn(async () => fixtureMaps),
      stat,
      read,
      lexicalSearch,
    });
    const scope = { accountId: 'account-1', projectId: 'project-1' };

    const searches = Array.from({ length: 5 }, () => repository.search(scope, 'Observatory Lumen'));

    await vi.waitFor(() => expect(lexicalSearch).toHaveBeenCalledTimes(5));
    // Small-map sizing is checked before derivative search so the repository
    // can decide whether a missing/partial index is safe to bypass.
    expect(stat).toHaveBeenCalledTimes(5);
    expect(stat.mock.calls.every(([, includeSha256]) => includeSha256 === false)).toBe(true);
    releaseLexicalSearch();

    const results = await Promise.all(searches);
    expect(results.every((hits) => hits[0]?.preview.includes('cobalt-fern'))).toBe(true);
    expect(read).toHaveBeenCalledTimes(1);
    // Five sizing probes and five pre-hash probes preserve the size bound;
    // five SHA snapshots share one physical read and its post-read SHA probe.
    expect(stat).toHaveBeenCalledTimes(16);
    expect(stat.mock.calls.filter(([, sha]) => sha === false)).toHaveLength(10);
    expect(stat.mock.calls.filter(([, sha]) => sha === true)).toHaveLength(6);
    expect(new Set(stat.mock.calls.map(([path]) => path))).toEqual(new Set(['C:\\repo\\book.txt']));

    await repository.search(scope, 'Observatory Lumen');
    expect(read).toHaveBeenCalledTimes(2);
    // A later sequential search performs a fresh authority build and source
    // revalidation rather than retaining source bytes.
    expect(stat).toHaveBeenCalledTimes(20);
    expect(stat.mock.calls.filter(([, sha]) => sha === false)).toHaveLength(12);
    expect(stat.mock.calls.filter(([, sha]) => sha === true)).toHaveLength(8);
  });

  it('stops sizing a large map once the small-map fallback budget is exceeded', async () => {
    const map = maps()[0]!;
    const nodes = Array.from({ length: 58 }, (_, index) => ({
      id: `chunk-${index}`,
      kind: 'file' as const,
      title: `chunk-${index}.txt`,
      summary: '',
      path: `C:\\repo\\chunk-${index}.txt`,
    }));
    const stat = vi.fn(async (path: string) => ({
      ok: true as const,
      path,
      kind: 'file' as const,
      size: 1024 * 1024,
    }));
    const read = vi.fn();
    const indexStatus = vi.fn(async () => ({ documentCount: 58, needsRebuild: false }));
    const lexicalSearch = vi.fn(async () => []);
    const repository = createContextMapRlmRepository({
      loadMaps: async () => [{ ...map, tree: { nodes } }],
      stat,
      read,
      indexStatus,
      lexicalSearch,
    });
    expect(
      await repository.search(
        { accountId: 'account-1', projectId: 'project-1' },
        'R14_NONEXISTENT_6A84F2',
      ),
    ).toEqual([]);
    expect(stat.mock.calls.length).toBeLessThanOrEqual(16);
    expect(indexStatus).toHaveBeenCalledWith('account-1', map.id);
    expect(lexicalSearch).toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
  });

  it('cancels one source-validation waiter without cancelling its concurrent peer', async () => {
    const content = 'Observatory Lumen uses cobalt-fern verification 47291.';
    let releaseRead!: () => void;
    const readGate = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    const read = vi.fn(async (path) => {
      await readGate;
      return { ok: true as const, path, content };
    });
    const stat = vi.fn(async (path: string, _includeSha256?: boolean) => ({
      ok: true as const,
      path,
      kind: 'file' as const,
      size: content.length,
      modifiedMs: 20,
      sha256: await contentSha(content),
    }));
    const repository = createContextMapRlmRepository({
      loadMaps: vi.fn(async () => maps()),
      stat,
      read,
      lexicalSearch: vi.fn(async () => []),
    });
    const scope = { accountId: 'account-1', projectId: 'project-1' };
    const cancelled = new AbortController();

    const first = repository.search(scope, 'Observatory Lumen', cancelled.signal);
    const second = repository.search(scope, 'Observatory Lumen');
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1));
    cancelled.abort();

    await expect(first).rejects.toMatchObject({ name: 'AbortError' });
    releaseRead();
    await expect(second).resolves.toHaveLength(1);
    expect(read).toHaveBeenCalledTimes(1);
    // Each waiter performs sizing + pre-hash + SHA admission; only the
    // surviving shared read performs post-read SHA validation.
    expect(stat).toHaveBeenCalledTimes(7);
    expect(stat.mock.calls.filter(([, sha]) => sha === false)).toHaveLength(4);
    expect(stat.mock.calls.filter(([, sha]) => sha === true)).toHaveLength(3);
  });

  it('bounds concurrent source validation and preserves stable authority ordering', async () => {
    const fixtureMaps = maps();
    fixtureMaps[0]!.tree.nodes = Array.from({ length: 20 }, (_, index) => ({
      id: `file-${String(index + 1).padStart(2, '0')}`,
      kind: 'file' as const,
      title: `book-${String(index + 1).padStart(2, '0')}.txt`,
      summary: '',
      path: `C:\\repo\\book-${String(index + 1).padStart(2, '0')}.txt`,
      sizeBytes: 128,
      modifiedAt: 20,
    }));
    let activeReads = 0;
    let maximumActiveReads = 0;
    let activeStats = 0;
    let maximumActiveStats = 0;
    const read = vi.fn(async (path: string) => {
      activeReads += 1;
      maximumActiveReads = Math.max(maximumActiveReads, activeReads);
      const ordinal = Number(path.match(/(\d+)\.txt$/u)?.[1] ?? 0);
      await new Promise((resolve) => setTimeout(resolve, 1 + ((20 - ordinal) % 5)));
      activeReads -= 1;
      return { ok: true as const, path, content: 'shared anchor' };
    });
    const repository = createContextMapRlmRepository({
      loadMaps: vi.fn(async () => fixtureMaps),
      stat: vi.fn(async (path) => {
        activeStats += 1;
        maximumActiveStats = Math.max(maximumActiveStats, activeStats);
        await new Promise((resolve) => setTimeout(resolve, 1));
        activeStats -= 1;
        return {
          ok: true as const,
          path,
          kind: 'file' as const,
          size: new TextEncoder().encode('shared anchor').length,
          modifiedMs: 20,
          sha256: await contentSha('shared anchor'),
        };
      }),
      read,
      lexicalSearch: vi.fn(async () => []),
    });

    const hits = await repository.search(
      { accountId: 'account-1', projectId: 'project-1' },
      'shared anchor',
    );

    expect(maximumActiveReads).toBeGreaterThan(1);
    expect(maximumActiveReads).toBeLessThanOrEqual(8);
    expect(maximumActiveStats).toBeGreaterThan(1);
    expect(maximumActiveStats).toBeLessThanOrEqual(8);
    expect(read).toHaveBeenCalledTimes(20);
    const filenames = hits.map((hit) => hit.preview.match(/book-(\d+)\.txt/u)?.[1]);
    expect([...filenames].sort()).toEqual(
      Array.from({ length: 20 }, (_, index) => String(index + 1).padStart(2, '0')),
    );
    const repeated = await repository.search(
      { accountId: 'account-1', projectId: 'project-1' },
      'shared anchor',
    );
    expect(repeated.map((hit) => hit.recordId)).toEqual(hits.map((hit) => hit.recordId));
  });

  it('keeps identical map records isolated across account and workspace scopes', async () => {
    const fixtureMaps = maps();
    fixtureMaps[0]!.tree.nodes.push({
      id: 'file-2',
      kind: 'file' as const,
      title: 'second.txt',
      summary: '',
      path: 'C:\\repo\\second.txt',
      sizeBytes: 128,
      modifiedAt: 20,
    });
    const repository = createContextMapRlmRepository({
      loadMaps: vi.fn(async () => fixtureMaps),
      stat: vi.fn(async (path) => ({
        ok: true as const,
        path,
        kind: 'file' as const,
        size: 128,
        modifiedMs: 20,
        sha256: SHA,
      })),
      read: vi.fn(),
      lexicalSearch: vi.fn(),
    });
    const firstRecords = await repository.listRecords({
      accountId: 'account-1',
      workspaceId: 'workspace-1',
      projectId: 'project-1',
    });
    const secondRecords = await repository.listRecords({
      accountId: 'account-2',
      workspaceId: 'workspace-2',
      projectId: 'project-1',
    });
    const first = firstRecords[0]!;
    const second = secondRecords[0]!;

    expect(first?.id).not.toBe(second?.id);
    await expect(repository.getRecord(first!.id)).resolves.toMatchObject({
      accountId: 'account-1',
      workspaceId: 'workspace-1',
    });
    await expect(repository.getRecord(second!.id)).resolves.toMatchObject({
      accountId: 'account-2',
      workspaceId: 'workspace-2',
    });
    await expect(repository.relatedRecordIds!(first.id)).resolves.toEqual([firstRecords[1]!.id]);
  });

  it('evicts a rejected authority build without publishing partial records', async () => {
    const fixtureMaps = maps();
    fixtureMaps[0]!.tree.nodes.push({
      id: 'file-2',
      kind: 'file' as const,
      title: 'second.txt',
      summary: '',
      path: 'C:\\repo\\second.txt',
      sizeBytes: 128,
      modifiedAt: 20,
    });
    let fail = true;
    const stat = vi.fn(async (path: string) => {
      if (fail && path.endsWith('second.txt')) throw new Error('bounded failure');
      return {
        ok: true as const,
        path,
        kind: 'file' as const,
        size: 128,
        modifiedMs: 20,
        sha256: SHA,
      };
    });
    const repository = createContextMapRlmRepository({
      loadMaps: vi.fn(async () => fixtureMaps),
      stat,
      read: vi.fn(),
      lexicalSearch: vi.fn(),
    });
    const scope = { accountId: 'account-1', projectId: 'project-1' };

    await expect(repository.listRecords(scope)).rejects.toThrow('bounded failure');
    const partialId = `rlm:${encodeURIComponent('account-1')}::${encodeURIComponent('project-1')}::map-1:file-1:${'a'.repeat(16)}`;
    await expect(repository.getRecord(partialId)).resolves.toBeUndefined();

    fail = false;
    await expect(repository.listRecords(scope)).resolves.toHaveLength(2);
  });

  it('drains bounded authority workers before rejecting and starting a retry', async () => {
    const fixtureMaps = maps();
    fixtureMaps[0]!.tree.nodes = Array.from({ length: 20 }, (_, index) => ({
      id: `file-${index}`,
      kind: 'file' as const,
      title: `file-${index}.txt`,
      summary: '',
      path: `C:\\repo\\file-${index}.txt`,
      sizeBytes: 128,
      modifiedAt: 20,
    }));
    let failing = true;
    let active = 0;
    let maximumActive = 0;
    let started = 0;
    const stat = vi.fn(async (path: string) => {
      active += 1;
      started += 1;
      maximumActive = Math.max(maximumActive, active);
      if (failing && path.endsWith('file-0.txt')) {
        await new Promise((resolve) => setTimeout(resolve, 1));
        active -= 1;
        throw new Error('first worker failed');
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
      active -= 1;
      return {
        ok: true as const,
        path,
        kind: 'file' as const,
        size: 128,
        modifiedMs: 20,
        sha256: SHA,
      };
    });
    const repository = createContextMapRlmRepository({
      loadMaps: vi.fn(async () => fixtureMaps),
      stat,
      read: vi.fn(),
      lexicalSearch: vi.fn(),
    });
    const scope = { accountId: 'account-1', projectId: 'project-1' };

    await expect(repository.listRecords(scope)).rejects.toThrow('first worker failed');
    expect(active).toBe(0);
    expect(started).toBeLessThanOrEqual(8);

    failing = false;
    await expect(repository.listRecords(scope)).resolves.toHaveLength(20);
    expect(maximumActive).toBeLessThanOrEqual(8);
  });

  it('isolates in-flight authority builds by map revision and rebuilds sequential requests', async () => {
    let revision = 20;
    let releaseStats!: () => void;
    const statGate = new Promise<void>((resolve) => {
      releaseStats = resolve;
    });
    const stat = vi.fn(async (path) => {
      await statGate;
      return {
        ok: true as const,
        path,
        kind: 'file' as const,
        size: 128,
        modifiedMs: revision,
        sha256: SHA,
      };
    });
    const loadMaps = vi.fn(async () => {
      const fixtureMaps = maps();
      fixtureMaps[0]!.updatedAt = revision;
      Object.assign(fixtureMaps[0]!.tree.nodes[0]!, { modifiedAt: revision });
      return fixtureMaps;
    });
    const repository = createContextMapRlmRepository({
      loadMaps,
      stat,
      read: vi.fn(),
      lexicalSearch: vi.fn(),
    });
    const scope = { accountId: 'account-1', projectId: 'project-1' };

    const firstRevision = repository.listRecords(scope);
    await vi.waitFor(() => expect(stat).toHaveBeenCalledTimes(1));
    revision = 21;
    const secondRevision = repository.listRecords(scope);
    await vi.waitFor(() => expect(stat).toHaveBeenCalledTimes(2));
    releaseStats();
    await Promise.all([firstRevision, secondRevision]);

    await repository.listRecords(scope);
    expect(stat).toHaveBeenCalledTimes(3);
  });

  it('does not let an older out-of-order build replace a newer scoped publication', async () => {
    let revision = 20;
    let releaseOld!: () => void;
    const oldGate = new Promise<void>((resolve) => {
      releaseOld = resolve;
    });
    let statCall = 0;
    const stat = vi.fn(async (path) => {
      statCall += 1;
      const currentCall = statCall;
      if (currentCall === 1) await oldGate;
      return {
        ok: true as const,
        path,
        kind: 'file' as const,
        size: 128,
        modifiedMs: currentCall === 1 ? 20 : 21,
        sha256: `sha256:${(currentCall === 1 ? 'a' : 'b').repeat(64)}` as const,
      };
    });
    const repository = createContextMapRlmRepository({
      loadMaps: vi.fn(async () => {
        const fixtureMaps = maps();
        fixtureMaps[0]!.updatedAt = revision;
        Object.assign(fixtureMaps[0]!.tree.nodes[0]!, { modifiedAt: revision });
        return fixtureMaps;
      }),
      stat,
      read: vi.fn(),
      lexicalSearch: vi.fn(),
    });
    const scope = { accountId: 'account-1', projectId: 'project-1' };

    const oldRequest = repository.listRecords(scope);
    await vi.waitFor(() => expect(stat).toHaveBeenCalledTimes(1));
    revision = 21;
    const [newRecord] = await repository.listRecords(scope);
    releaseOld();
    const [oldRecord] = await oldRequest;

    await expect(repository.getRecord(newRecord!.id)).resolves.toBeDefined();
    await expect(repository.getRecord(oldRecord!.id)).resolves.toBeUndefined();
  });

  it('allocates publication generation before an older delayed loadMaps resolves', async () => {
    let releaseOldMaps!: () => void;
    const oldMapsGate = new Promise<void>((resolve) => {
      releaseOldMaps = resolve;
    });
    let loadCall = 0;
    const repository = createContextMapRlmRepository({
      loadMaps: vi.fn(async () => {
        loadCall += 1;
        const currentCall = loadCall;
        if (currentCall === 1) await oldMapsGate;
        const fixtureMaps = maps();
        fixtureMaps[0]!.updatedAt = currentCall === 1 ? 20 : 21;
        Object.assign(fixtureMaps[0]!.tree.nodes[0]!, {
          modifiedAt: currentCall === 1 ? 20 : 21,
        });
        return fixtureMaps;
      }),
      stat: vi.fn(async (path) => ({
        ok: true as const,
        path,
        kind: 'file' as const,
        size: 128,
        modifiedMs: loadCall === 1 ? 20 : 21,
        sha256: `sha256:${(loadCall === 1 ? 'a' : 'b').repeat(64)}` as const,
      })),
      read: vi.fn(),
      lexicalSearch: vi.fn(),
    });
    const scope = { accountId: 'account-1', projectId: 'project-1' };

    const oldRequest = repository.listRecords(scope);
    await vi.waitFor(() => expect(loadCall).toBe(1));
    const [newRecord] = await repository.listRecords(scope);
    await expect(repository.getRecord(newRecord!.id)).resolves.toEqual(newRecord);
    releaseOldMaps();
    const [oldRecord] = await oldRequest;

    await expect(repository.getRecord(newRecord!.id)).resolves.toBeDefined();
    await expect(repository.getRecord(oldRecord!.id)).resolves.toBeUndefined();
  });

  it.each(['projectId', 'workspaceId', 'worktreeId'] as const)(
    'fails closed when runtime scope %s is null instead of missing',
    async (field) => {
      const repository = createContextMapRlmRepository({
        loadMaps: vi.fn(async () => maps()),
        stat: vi.fn(),
        read: vi.fn(),
        lexicalSearch: vi.fn(),
      });

      await expect(
        repository.listRecords({
          accountId: 'account-1',
          [field]: null,
        } as never),
      ).rejects.toThrow('invalid context scope');
    },
  );

  it('uses a fixed-length digest record ID without delimiter or truncated-hash collisions', async () => {
    const longId = 'map:with:delimiters/'.repeat(40);
    const fixtureMaps = maps();
    fixtureMaps[0]!.id = longId;
    fixtureMaps[0]!.tree.nodes[0]!.id = `${longId}:node`;
    fixtureMaps[0]!.tree.nodes[0]!.path = 'C:\\repo\\book.txt';
    let hash: `sha256:${string}` = `sha256:${'a'.repeat(63)}0`;
    const repository = createContextMapRlmRepository({
      loadMaps: vi.fn(async () => fixtureMaps),
      stat: vi.fn(async (path) => ({
        ok: true as const,
        path,
        kind: 'file' as const,
        size: 128,
        modifiedMs: 20,
        sha256: hash,
      })),
      read: vi.fn(),
      lexicalSearch: vi.fn(),
    });
    const scope = {
      accountId: 'account:one',
      workspaceId: 'workspace:two',
      projectId: 'project-1',
      worktreeId: 'worktree/four',
    };

    const [first] = await repository.listRecords(scope);
    hash = `sha256:${'a'.repeat(63)}1`;
    const [second] = await repository.listRecords(scope);

    expect(first!.id).toMatch(/^rlm:[a-f0-9]{64}$/u);
    expect(first!.id.length).toBe(68);
    expect(first!.id.length).toBeLessThanOrEqual(512);
    expect(second!.id).not.toBe(first!.id);
  });

  it('fails closed when source bytes change after the authority snapshot', async () => {
    const originalContent = 'Observatory Lumen uses cobalt-fern verification 47291.';
    const changedContent = originalContent.replace('cobalt', 'violet');
    expect(new TextEncoder().encode(changedContent).length).toBe(new TextEncoder().encode(originalContent).length);
    const originalSha = await contentSha(originalContent);
    const changedSha = await contentSha(changedContent);
    expect(changedSha).not.toBe(originalSha);
    const fixture = (mutateAfterSnapshot: boolean) => {
      let changed = false;
      const stat = vi.fn(async (path: string, includeSha256?: boolean) => ({
        ok: true as const, path, kind: 'file' as const,
        size: new TextEncoder().encode(originalContent).length,
        modifiedMs: changed ? 21 : 20,
        ...(includeSha256 ? { sha256: changed ? changedSha : originalSha } : {}),
      }));
      const read = vi.fn(async (path: string) => {
        changed = mutateAfterSnapshot;
        return { ok: true as const, path, content: changed ? changedContent : originalContent };
      });
      const repository = createContextMapRlmRepository({
        loadMaps: async () => maps(), stat, read,
        lexicalSearch: async () => [{ documentId: 'file-1', excerpt: 'untrusted derivative', score: 10 }],
      });
      return { repository, stat, read };
    };
    const scope = { accountId: 'account-1', projectId: 'project-1' };
    const stable = fixture(false);
    const hits = await stable.repository.search(scope, 'Observatory Lumen');
    expect(hits).toHaveLength(1);
    expect(hits[0]?.preview).toContain('cobalt-fern');
    expect(hits[0]?.preview).not.toContain('untrusted derivative');
    expect(stable.read).toHaveBeenCalledTimes(1);
    expect(stable.stat.mock.calls.filter(([, sha]) => sha === false)).toHaveLength(2);
    expect(stable.stat.mock.calls.filter(([, sha]) => sha === true)).toHaveLength(2);

    const changing = fixture(true);
    await expect(changing.repository.search(scope, 'Observatory Lumen')).resolves.toEqual([]);
    // Correct bytes/hash initially were admitted. Same-length changed bytes
    // are rejected after the snapshot, rather than an exhausted mock or an
    // always-invalid size/hash making this negative pass accidentally.
    expect(changing.read).toHaveBeenCalledTimes(1);
    expect(changing.stat.mock.calls.filter(([, sha]) => sha === false)).toHaveLength(2);
    expect(changing.stat.mock.calls.filter(([, sha]) => sha === true)).toHaveLength(1);
  });

  it('publishes a successful peer when the latest shared-build waiter aborts', async () => {
    let releaseStat!: () => void;
    const statGate = new Promise<void>((resolve) => {
      releaseStat = resolve;
    });
    const repository = createContextMapRlmRepository({
      loadMaps: vi.fn(async () => maps()),
      stat: vi.fn(async (path) => {
        await statGate;
        return {
          ok: true as const,
          path,
          kind: 'file' as const,
          size: new TextEncoder().encode('safe source').length,
          modifiedMs: 20,
          sha256: await contentSha('safe source'),
        };
      }),
      read: vi.fn(async (path) => ({ ok: true as const, path, content: 'safe source' })),
      lexicalSearch: vi.fn(),
    });
    const scope = { accountId: 'account-1', projectId: 'project-1' };
    const controller = new AbortController();

    const successfulPeer = repository.listRecords(scope);
    const cancelledLatest = repository.listRecords(scope, controller.signal);
    controller.abort();
    releaseStat();

    await expect(cancelledLatest).rejects.toMatchObject({ name: 'AbortError' });
    const [record] = await successfulPeer;
    await expect(repository.getRecord(record!.id)).resolves.toEqual(record);
    await expect(repository.readSource!(record!)).resolves.toBeDefined();
  });

  it('evicts a rejected shared source read so a later search can retry', async () => {
    const hash = await contentSha('Observatory Lumen uses cobalt-fern.');
    let failRead = true;
    const read = vi.fn(async (path) => {
      if (failRead) throw new Error('bounded read failure');
      return { ok: true as const, path, content: 'Observatory Lumen uses cobalt-fern.' };
    });
    const repository = createContextMapRlmRepository({
      loadMaps: vi.fn(async () => maps()),
      stat: vi.fn(async (path) => ({
        ok: true as const,
        path,
        kind: 'file' as const,
        size: new TextEncoder().encode('Observatory Lumen uses cobalt-fern.').length,
        modifiedMs: 20,
        sha256: hash,
      })),
      read,
      lexicalSearch: vi.fn(async () => []),
    });
    const scope = { accountId: 'account-1', projectId: 'project-1' };

    const rejected = await Promise.allSettled([
      repository.search(scope, 'Observatory Lumen'),
      repository.search(scope, 'Observatory Lumen'),
    ]);
    expect(rejected).toEqual([
      { status: 'rejected', reason: new Error('bounded read failure') },
      { status: 'rejected', reason: new Error('bounded read failure') },
    ]);
    expect(read).toHaveBeenCalledTimes(1);

    failRead = false;
    await expect(repository.search(scope, 'Observatory Lumen')).resolves.toHaveLength(1);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('creates immutable versioned records from active scoped file authorities', async () => {
    const stat = vi.fn(async (path) => ({
      ok: true as const,
      path,
      kind: 'file' as const,
      size: 128,
      modifiedMs: 20,
      sha256: SHA,
    }));
    const fixtureMaps = maps();
    fixtureMaps[0]!.tree.nodes[0]!.path = 'book.txt';
    const repository = createContextMapRlmRepository({
      loadMaps: vi.fn(async () => fixtureMaps),
      stat,
      read: vi.fn(),
      lexicalSearch: vi.fn(),
    });

    const records = await repository.listRecords({
      accountId: 'account-1',
      projectId: 'project-1',
    });

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      accountId: 'account-1',
      projectId: 'project-1',
      sourceKind: 'file_version',
      sourceId: expect.stringMatching(/^rlm-source:[a-f0-9]{64}$/u),
      contentHash: 'a'.repeat(64),
      contentRef: 'C:\\repo\\book.txt',
      path: 'C:\\repo\\book.txt',
    });
    expect(records[0]?.id).toMatch(/^rlm:[a-f0-9]{64}$/u);
    expect(stat).toHaveBeenCalledWith(
      'C:\\repo\\book.txt',
      true,
      expect.objectContaining({ root: 'C:\\repo' }),
    );
  });

  it('turns indexed lexical hits into exact byte pointers after validating source bytes', async () => {
    const content = 'before\nNeedle: exact punctuation!\nafter';
    const repository = createContextMapRlmRepository({
      loadMaps: vi.fn(async () => maps()),
      stat: vi.fn(async (path) => ({
        ok: true as const,
        path,
        kind: 'file' as const,
        size: content.length,
        modifiedMs: 20,
        sha256: await contentSha(content),
      })),
      read: vi.fn(async (path) => ({ ok: true as const, path, content })),
      lexicalSearch: vi.fn(async () => [
        {
          documentId: 'file-1',
          title: 'book.txt',
          path: 'C:\\repo\\book.txt',
          sourceType: 'local_file',
          excerpt: 'Needle: exact punctuation!',
          matchReason: 'full_text',
          updatedAt: 20,
          score: 9,
        },
      ]),
    });

    const hits = await repository.search(
      { accountId: 'account-1', projectId: 'project-1' },
      'Needle: exact punctuation!',
    );

    const start = new TextEncoder().encode('before\n').length;
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({
      recordId: expect.stringMatching(/^rlm:[a-f0-9]{64}$/u),
      pointer: {
        byteStart: start,
        byteEnd: new TextEncoder().encode(content).length,
        contentHash: (await contentSha(content)).slice('sha256:'.length),
      },
    });
  });

  it('falls back to a bounded exact scan when the derivative index has no hit', async () => {
    const content = 'prefix\nrare anchor across\nlines exact continuation\nsuffix';
    const repository = createContextMapRlmRepository({
      loadMaps: vi.fn(async () => maps()),
      stat: vi.fn(async (path) => ({
        ok: true as const,
        path,
        kind: 'file' as const,
        size: content.length,
        modifiedMs: 20,
        sha256: await contentSha(content),
      })),
      read: vi.fn(async (path) => ({ ok: true as const, path, content })),
      lexicalSearch: vi.fn(async () => []),
    });

    const hits = await repository.search(
      { accountId: 'account-1', projectId: 'project-1' },
      '"rare anchor across lines"',
    );

    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({
      recordId: expect.stringMatching(/^rlm:[a-f0-9]{64}$/u),
      preview: expect.stringContaining('rare anchor across\nlines exact continuation'),
      pointer: {
        contentHash: (await contentSha(content)).slice('sha256:'.length),
      },
    });
  });

  it('admits and exact-scans mapped corpus shards larger than the former 512 KiB ceiling', async () => {
    const anchor = 'Observatory Lumen color cobalt-fern verification 47291';
    const content = `${'bounded corpus filler '.repeat(30_000)}\n${anchor}`;
    expect(new TextEncoder().encode(content).length).toBeGreaterThan(512 * 1024);
    expect(new TextEncoder().encode(content).length).toBeLessThan(1024 * 1024);
    const repository = createContextMapRlmRepository({
      loadMaps: vi.fn(async () => maps()),
      stat: vi.fn(async (path) => ({
        ok: true as const,
        path,
        kind: 'file' as const,
        size: new TextEncoder().encode(content).length,
        modifiedMs: 20,
        sha256: await contentSha(content),
      })),
      read: vi.fn(async (path, maxBytes) => {
        expect(maxBytes).toBe(1024 * 1024);
        return { ok: true as const, path, content };
      }),
      lexicalSearch: vi.fn(async () => []),
    });

    const hits = await repository.search(
      { accountId: 'account-1', projectId: 'project-1' },
      'Please read the files and answer: what color phrase and verification number belong to Observatory Lumen?',
    );

    expect(hits).toHaveLength(1);
    expect(hits[0]?.preview).toContain('[SOURCE FILE: book.txt]');
    expect(hits[0]?.preview).toContain(anchor);
    expect(hits[0]?.score).toBeGreaterThan(1);
  });

  it('retrieves the exact Q1 literature anchor and physical source filename', async () => {
    const fixtureMaps = maps();
    fixtureMaps[0]!.tree.nodes[0]!.title = '0007-pg2600.txt';
    fixtureMaps[0]!.tree.nodes[0]!.path = 'C:\\repo\\0007-pg2600.txt';
    fixtureMaps[0]!.tree.nodes.push({
      id: 'distractor-1',
      kind: 'file' as const,
      title: '0025-pg4300.txt',
      summary: '',
      path: 'C:\\repo\\0025-pg4300.txt',
      sizeBytes: 128,
      modifiedAt: 20,
    });
    const content = `The inhabitants discussed İstanbul and a bit of ordinary business. ${'Kutúzov with a letter about unrelated orders. '.repeat(62)}${'unrelated literature filler '.repeat(30)}commander in chief the buzz of talk ceased and all eyes were fixed on\nKutúzov who, wearing a white cap with a red band, was walking nearby. Kutúzov carried a note about a bit of talk in ordinary business. ${'Kutúzov rode away with unrelated dispatches. '.repeat(45)}`;
    const distractor =
      'The inhabitants discussed a bit of ordinary business while everybody watched the road.';
    const repository = createContextMapRlmRepository({
      loadMaps: vi.fn(async () => fixtureMaps),
      stat: vi.fn(async (path) => ({
        ok: true as const,
        path,
        kind: 'file' as const,
        size: new TextEncoder().encode(path.endsWith('0025-pg4300.txt') ? distractor : content)
          .length,
        modifiedMs: 20,
        sha256: await contentSha(path.endsWith('0025-pg4300.txt') ? distractor : content),
      })),
      read: vi.fn(async (path) => ({
        ok: true as const,
        path,
        content: path.endsWith('0025-pg4300.txt') ? distractor : content,
      })),
      lexicalSearch: vi.fn(async () => []),
    });

    const hits = await repository.search(
      { accountId: 'account-1', projectId: 'project-1' },
      'in the literature files, what are the eight words right after the bit where talk stopped and everybody watched Kutúzov? quote only those words and show me the file',
    );
    const entityOffsets = [...content.matchAll(/Kutúzov/gu)].map((match) => match.index);
    const contextStart = content.indexOf('talk ceased');

    expect(entityOffsets).toHaveLength(109);
    expect(entityOffsets[62]).toBe(content.indexOf('Kutúzov who'));
    expect(hits[0]?.preview).toContain('[SOURCE FILE: 0007-pg2600.txt]');
    expect(hits[0]?.pointer.byteStart).toBe(
      new TextEncoder().encode(content.slice(0, contextStart)).length,
    );
    expect(hits[0]?.preview).toContain(
      '\ntalk ceased and all eyes were fixed on\nKutúzov who, wearing a white cap with a red',
    );
    expect(hits[0]?.preview).toContain('who, wearing a white cap with a red');
    expect(hits[0]!.pointer.byteEnd).toBeGreaterThan(
      new TextEncoder().encode(content.slice(0, content.indexOf('red band') + 'red band'.length))
        .length,
    );
  });

  it('anchors Unicode singleton names without promoting sentence-leading directives', async () => {
    const fixtureMaps = maps();
    const content =
      'Tell the reader about ordinary records. Later everyone watched Élodie, while Łukasz took the cobalt ledger.';
    const repository = createContextMapRlmRepository({
      loadMaps: vi.fn(async () => fixtureMaps),
      stat: vi.fn(async (path) => ({
        ok: true as const,
        path,
        kind: 'file' as const,
        size: new TextEncoder().encode(content).length,
        modifiedMs: 20,
        sha256: await contentSha(content),
      })),
      read: vi.fn(async (path) => ({ ok: true as const, path, content })),
      lexicalSearch: vi.fn(async () => []),
    });

    const hits = await repository.search(
      { accountId: 'account-1', projectId: 'project-1' },
      'Tell me whom everyone watched: Élodie; show the ledger',
    );

    expect(hits[0]?.pointer.byteStart).toBe(
      new TextEncoder().encode(content.slice(0, content.indexOf('Élodie'))).length,
    );
    expect(hits[0]?.preview).toContain('\nÉlodie, while Łukasz');
  });

  it('anchors a singleton name ending in a non-ASCII letter', async () => {
    const fixtureMaps = maps();
    const content =
      'Find ordinary filing instructions first. Much later the witness René recorded the cobalt ledger.';
    const repository = createContextMapRlmRepository({
      loadMaps: vi.fn(async () => fixtureMaps),
      stat: vi.fn(async (path) => ({
        ok: true as const,
        path,
        kind: 'file' as const,
        size: new TextEncoder().encode(content).length,
        modifiedMs: 20,
        sha256: await contentSha(content),
      })),
      read: vi.fn(async (path) => ({ ok: true as const, path, content })),
      lexicalSearch: vi.fn(async () => []),
    });

    const hits = await repository.search(
      { accountId: 'account-1', projectId: 'project-1' },
      'Find what René recorded in the ledger',
    );

    expect(hits[0]?.pointer.byteStart).toBe(
      new TextEncoder().encode(content.slice(0, content.indexOf('René'))).length,
    );
    expect(hits[0]?.preview).toContain('\nRené recorded');
  });

  it('locates only the exact bounded singleton inside a contextual span', async () => {
    const fixtureMaps = maps();
    const content =
      'The clue appeared beside Annette before the exact witness Ann recorded the cobalt ledger.';
    const repository = createContextMapRlmRepository({
      loadMaps: vi.fn(async () => fixtureMaps),
      stat: vi.fn(async (path) => ({
        ok: true as const,
        path,
        kind: 'file' as const,
        size: new TextEncoder().encode(content).length,
        modifiedMs: 20,
        sha256: await contentSha(content),
      })),
      read: vi.fn(async (path) => ({ ok: true as const, path, content })),
      lexicalSearch: vi.fn(async () => []),
    });

    const hits = await repository.search(
      { accountId: 'account-1', projectId: 'project-1' },
      'Find the clue connected to Ann',
    );

    expect(hits[0]?.pointer.byteStart).toBe(
      new TextEncoder().encode(content.slice(0, content.indexOf('Ann recorded'))).length,
    );
    expect(hits[0]?.preview).toContain('\nAnn recorded');
  });

  it('ranks a contiguous entity phrase above scattered generic question words', async () => {
    const fixtureMaps = maps();
    fixtureMaps[0]!.tree.nodes.push({
      id: 'file-2',
      kind: 'file' as const,
      title: 'unrelated.txt',
      summary: '',
      path: 'C:\\repo\\unrelated.txt',
      sizeBytes: 128,
      modifiedAt: 20,
    });
    const repository = createContextMapRlmRepository({
      loadMaps: vi.fn(async () => fixtureMaps),
      stat: vi.fn(async (path) => {
        const content = path.endsWith('book.txt')
          ? 'Observatory Lumen is cobalt-fern, verification number 47291.'
          : 'Many records discuss color phrases and verification numbers.';
        return {
          ok: true as const,
          path,
          kind: 'file' as const,
          size: new TextEncoder().encode(content).length,
          modifiedMs: 20,
          sha256: await contentSha(content),
        };
      }),
      read: vi.fn(async (path) => ({
        ok: true as const,
        path,
        content: path.endsWith('book.txt')
          ? 'Observatory Lumen is cobalt-fern, verification number 47291.'
          : 'Many records discuss color phrases and verification numbers.',
      })),
      lexicalSearch: vi.fn(async () => []),
    });

    const hits = await repository.search(
      { accountId: 'account-1', projectId: 'project-1' },
      'Please read the files: what color phrase and verification number belong to Observatory Lumen?',
    );

    expect(hits[0]?.preview).toContain('Observatory Lumen');
    expect(hits[0]!.score).toBeGreaterThan(hits[1]!.score);
  });

  it('retrieves both exact Q3 neighboring handoff records within the first three results', async () => {
    const fixtureMaps = maps();
    fixtureMaps[0]!.tree.nodes[0]!.title = '0050-orbit.txt';
    fixtureMaps[0]!.tree.nodes[0]!.path = 'C:\\repo\\0050-orbit.txt';
    fixtureMaps[0]!.tree.nodes.push({
      id: 'file-2',
      kind: 'file' as const,
      title: '0051-orbit.txt',
      summary: '',
      path: 'C:\\repo\\0051-orbit.txt',
      sizeBytes: 128,
      modifiedAt: 20,
    });
    fixtureMaps[0]!.tree.nodes.push(
      {
        id: 'literature-44',
        kind: 'file' as const,
        title: '0044-pg1234.txt',
        summary: '',
        path: 'C:\\repo\\0044-pg1234.txt',
        sizeBytes: 128,
        modifiedAt: 20,
      },
      {
        id: 'literature-80',
        kind: 'file' as const,
        title: '0080-pg5678.txt',
        summary: '',
        path: 'C:\\repo\\0080-pg5678.txt',
        sizeBytes: 128,
        modifiedAt: 20,
      },
      {
        id: 'literature-01',
        kind: 'file' as const,
        title: '0001-pg9999.txt',
        summary: '',
        path: 'C:\\repo\\0001-pg9999.txt',
        sizeBytes: 128,
        modifiedAt: 20,
      },
    );
    const contents: Record<string, string> = {
      'C:\\repo\\0050-orbit.txt': `ORBIT HANDOFF PART ONE. ${'ordinary relay ledger filler '.repeat(30)}The phrase left in part one was glass-peregrine.`,
      'C:\\repo\\0051-orbit.txt': `ORBIT HANDOFF PART TWO. ${'ordinary relay ledger filler '.repeat(30)}The receiving clerk gave the answer harbor-saffron.`,
      'C:\\repo\\0044-pg1234.txt':
        'A relay handoff between neighboring literature records mentioned a phrase and answer.',
      'C:\\repo\\0080-pg5678.txt':
        'Part one and part two describe a receiving clerk, phrase, and answer in generic prose.',
      'C:\\repo\\0001-pg9999.txt':
        'A neighboring relay handoff has part one, part two, a phrase, a receiving clerk, and an answer.',
    };
    const dependencies = {
      loadMaps: vi.fn(async () => fixtureMaps),
      stat: vi.fn(async (path) => ({
        ok: true as const,
        path,
        kind: 'file' as const,
        size: contents[path]!.length,
        modifiedMs: 20,
        sha256: await contentSha(contents[path]!),
      })),
      read: vi.fn(async (path) => ({ ok: true as const, path, content: contents[path]! })),
      lexicalSearch: vi.fn(async () => [
        {
          documentId: 'file-1',
          excerpt: contents['C:\\repo\\0050-orbit.txt'],
          score: 100,
        },
        {
          documentId: 'file-2',
          excerpt: contents['C:\\repo\\0051-orbit.txt'],
          score: 1,
        },
        {
          documentId: 'literature-44',
          excerpt: contents['C:\\repo\\0044-pg1234.txt'],
          score: 500,
        },
        {
          documentId: 'literature-80',
          excerpt: contents['C:\\repo\\0080-pg5678.txt'],
          score: 500,
        },
        {
          documentId: 'literature-01',
          excerpt: contents['C:\\repo\\0001-pg9999.txt'],
          score: 500,
        },
      ]),
    };
    const repository = createContextMapRlmRepository(dependencies);

    const productionFederatedRepository = createProductionFederatedRlmRepository(
      repository,
      repository,
    );
    const service = createContextQueryService({ repository: productionFederatedRepository });
    const q3Scope = { accountId: 'account-1', projectId: 'project-1' };
    const q3Query =
      'the orbit relay handoff is split between neighboring files — what phrase was left in part one and what answer did the receiving clerk give in part two? show both files';
    const unpublishedRepositoryHits = await repository.search(q3Scope, q3Query);
    const firstPage = await service.search({
      scope: q3Scope,
      query: q3Query,
      limit: 3,
    });
    const hits = firstPage.items;

    expect(hits.slice(0, 3).map((hit) => hit.preview)).toEqual(
      expect.arrayContaining([
        expect.stringContaining('[SOURCE FILE: 0050-orbit.txt]'),
        expect.stringContaining('[SOURCE FILE: 0051-orbit.txt]'),
      ]),
    );
    expect(hits.find((hit) => hit.preview.includes('0050-orbit.txt'))?.preview).toContain(
      'glass-peregrine',
    );
    expect(hits.find((hit) => hit.preview.includes('0051-orbit.txt'))?.preview).toContain(
      'harbor-saffron',
    );

    const left = hits.find((hit) => hit.preview.includes('0050-orbit.txt'))!;
    const right = hits.find((hit) => hit.preview.includes('0051-orbit.txt'))!;
    expect(left.pointer.id).toBe(
      `ptr:${left.record.id}:${left.pointer.byteStart}:${left.pointer.byteEnd}`,
    );
    expect(right.pointer.id).toBe(
      `ptr:${right.record.id}:${right.pointer.byteStart}:${right.pointer.byteEnd}`,
    );
    expect(right.pointer).not.toEqual(left.pointer);

    await expect(
      service.expand({
        scope: q3Scope,
        pointer: right.pointer,
        beforeBytes: 16,
      }),
    ).resolves.toMatchObject({
      text: expect.stringContaining('harbor-saffron'),
    });
    const hybrid = createContextPointer({
      ...right.pointer,
      id: left.pointer.id,
    });
    await expect(
      service.expand({
        scope: q3Scope,
        pointer: hybrid,
        beforeBytes: 16,
      }),
    ).rejects.toMatchObject({ code: 'pointer_invalid' });

    const alternateSourceSpan = createContextPointer({
      ...right.pointer,
      byteStart: left.pointer.byteStart,
      byteEnd: left.pointer.byteEnd,
      id: `ptr:${right.record.id}:${left.pointer.byteStart}:${left.pointer.byteEnd}`,
    });
    await expect(
      service.expand({
        scope: q3Scope,
        pointer: alternateSourceSpan,
        beforeBytes: 16,
      }),
    ).rejects.toMatchObject({ code: 'pointer_invalid' });

    const hiddenHit = unpublishedRepositoryHits.find(
      (candidate) => !hits.some((item) => item.pointer.id === candidate.pointer.id),
    )!;
    await expect(
      service.open({
        scope: q3Scope,
        pointer: hiddenHit.pointer,
      }),
    ).rejects.toMatchObject({ code: 'pointer_invalid' });
    const continuationPage = await service.search({
      scope: q3Scope,
      query: q3Query,
      limit: 3,
      continuation: firstPage.continuation,
    });
    expect(continuationPage.items.some((item) => item.pointer.id === hiddenHit.pointer.id)).toBe(
      true,
    );
    await expect(
      service.open({
        scope: q3Scope,
        pointer: hiddenHit.pointer,
      }),
    ).resolves.toMatchObject({ status: 'current' });

    const forgedInBoundsStart = right.pointer.byteStart! + 1;
    const forgedInBounds = createContextPointer({
      ...right.pointer,
      byteStart: forgedInBoundsStart,
      id: `ptr:${right.record.id}:${forgedInBoundsStart}:${right.pointer.byteEnd}`,
    });
    await expect(
      service.expand({
        scope: q3Scope,
        pointer: forgedInBounds,
        beforeBytes: 16,
      }),
    ).rejects.toMatchObject({ code: 'pointer_invalid' });

    const freshRepository = createContextMapRlmRepository(dependencies);
    const freshService = createContextQueryService({ repository: freshRepository });
    await expect(
      freshService.expand({
        scope: { accountId: 'account-1', projectId: 'project-1' },
        pointer: right.pointer,
        beforeBytes: 16,
      }),
    ).rejects.toMatchObject({ code: 'pointer_invalid' });

    const freshHits = (
      await freshService.search({
        scope: q3Scope,
        query: q3Query,
        limit: 3,
      })
    ).items;
    const reissuedRight = freshHits.find((hit) => hit.preview.includes('0051-orbit.txt'))!;
    expect(reissuedRight.pointer).toEqual(right.pointer);
    const repeatedConcurrentPointers = await Promise.all(
      Array.from({ length: 5 }, async () => {
        const repeatedHits = await freshService.search({
          scope: q3Scope,
          query: q3Query,
          limit: 3,
        });
        return repeatedHits.items.map((hit) => hit.pointer);
      }),
    );
    expect(repeatedConcurrentPointers).toEqual(
      Array.from({ length: 5 }, () => freshHits.map((hit) => hit.pointer)),
    );
    await expect(
      freshService.expand({
        scope: q3Scope,
        pointer: reissuedRight.pointer,
        beforeBytes: 16,
      }),
    ).resolves.toMatchObject({
      text: expect.stringContaining('harbor-saffron'),
    });

    const atomicRepository = createContextMapRlmRepository(dependencies);
    const atomicHits = await atomicRepository.search(q3Scope, q3Query);
    const atomicRight = atomicHits.find((hit) => hit.preview.includes('0051-orbit.txt'))!;
    const atomicRecord = (await atomicRepository.getRecord(atomicRight.recordId))!;
    const atomicForgedStart = atomicRight.pointer.byteStart! + 1;
    const atomicForgedPointer = createContextPointer({
      ...atomicRight.pointer,
      byteStart: atomicForgedStart,
      id: `ptr:${atomicRight.recordId}:${atomicForgedStart}:${atomicRight.pointer.byteEnd}`,
    });
    expect(
      atomicRepository.issuePointers!(
        [
          {
            record: atomicRecord,
            pointer: atomicRight.pointer,
            preview: atomicRight.preview,
            score: atomicRight.score,
          },
          {
            record: atomicRecord,
            pointer: atomicForgedPointer,
            preview: atomicRight.preview,
            score: atomicRight.score,
          },
        ],
        q3Scope,
      ),
    ).toBe(false);
    const atomicService = createContextQueryService({ repository: atomicRepository });
    await expect(
      atomicService.open({
        scope: q3Scope,
        pointer: atomicRight.pointer,
      }),
    ).rejects.toMatchObject({ code: 'pointer_invalid' });
  });

  it('boosts only exact mapped leaf tokens and never root-path substrings', async () => {
    const fixtureMaps = maps();
    fixtureMaps[0]!.tree.nodes[0]!.title = '0050-orbit.txt';
    fixtureMaps[0]!.tree.nodes[0]!.path = 'C:\\orbit-root\\0050-orbit.txt';
    fixtureMaps[0]!.tree.nodes.push(
      {
        id: 'orbital',
        kind: 'file' as const,
        title: '0051-orbital.txt',
        summary: '',
        path: 'C:\\repo\\0051-orbital.txt',
        sizeBytes: 128,
        modifiedAt: 20,
      },
      {
        id: 'root-only',
        kind: 'file' as const,
        title: '0052-corpus.txt',
        summary: '',
        path: 'C:\\orbit-root\\0052-corpus.txt',
        sizeBytes: 128,
        modifiedAt: 20,
      },
    );
    const content = 'relay handoff phrase answer';
    const repository = createContextMapRlmRepository({
      loadMaps: vi.fn(async () => fixtureMaps),
      stat: vi.fn(async (path) => ({
        ok: true as const,
        path,
        kind: 'file' as const,
        size: content.length,
        modifiedMs: 20,
        sha256: await contentSha(content),
      })),
      read: vi.fn(async (path) => ({ ok: true as const, path, content })),
      lexicalSearch: vi.fn(async () => []),
    });

    const hits = await repository.search(
      { accountId: 'account-1', projectId: 'project-1' },
      'find the orbit relay handoff phrase and answer',
    );
    const scoreByFile = new Map(
      hits.map((hit) => [hit.preview.match(/\[SOURCE FILE: ([^\]]+)\]/)?.[1], hit.score]),
    );

    expect(hits[0]?.preview).toContain('[SOURCE FILE: 0050-orbit.txt]');
    expect(scoreByFile.get('0050-orbit.txt')).toBeGreaterThan(scoreByFile.get('0051-orbital.txt')!);
    expect(scoreByFile.get('0051-orbital.txt')).toBe(scoreByFile.get('0052-corpus.txt'));
  });

  it('returns deterministic tie ordering when derivative input order changes', async () => {
    const fixtureMaps = maps();
    fixtureMaps[0]!.tree.nodes.push({
      id: 'file-2',
      kind: 'file' as const,
      title: 'second.txt',
      summary: '',
      path: 'C:\\repo\\second.txt',
      sizeBytes: 128,
      modifiedAt: 20,
    });
    const content = 'shared deterministic anchor';
    let reverse = false;
    const indexed = [
      { documentId: 'file-1', excerpt: content, score: 10 },
      { documentId: 'file-2', excerpt: content, score: 10 },
    ];
    const repository = createContextMapRlmRepository({
      loadMaps: vi.fn(async () => fixtureMaps),
      stat: vi.fn(async (path) => ({
        ok: true as const,
        path,
        kind: 'file' as const,
        size: content.length,
        modifiedMs: 20,
        sha256: await contentSha(content),
      })),
      read: vi.fn(async (path) => ({ ok: true as const, path, content })),
      lexicalSearch: vi.fn(async () => {
        reverse = !reverse;
        return reverse ? [...indexed].reverse() : indexed;
      }),
    });
    const scope = { accountId: 'account-1', projectId: 'project-1' };

    const first = await repository.search(scope, 'shared deterministic anchor');
    const second = await repository.search(scope, 'shared deterministic anchor');

    expect(second.map((hit) => hit.recordId)).toEqual(first.map((hit) => hit.recordId));
  });

  it('recovers source-authoritative hits omitted by a nonempty stale lexical index', async () => {
    const fixtureMaps = maps();
    fixtureMaps[0]!.tree.nodes.push({
      id: 'file-2',
      kind: 'file' as const,
      title: 'observatory-lumen.txt',
      summary: '',
      path: 'C:\\repo\\observatory-lumen.txt',
      sizeBytes: 128,
      modifiedAt: 20,
    });
    const contents: Record<string, string> = {
      'C:\\repo\\book.txt': 'A generic record mentions a recovery color without naming any site.',
      'C:\\repo\\observatory-lumen.txt': 'Observatory Lumen uses the recovery color cobalt-fern.',
    };
    const repository = createContextMapRlmRepository({
      loadMaps: vi.fn(async () => fixtureMaps),
      stat: vi.fn(async (path) => ({
        ok: true as const,
        path,
        kind: 'file' as const,
        size: contents[path]!.length,
        modifiedMs: 20,
        sha256: await contentSha(contents[path]!),
      })),
      read: vi.fn(async (path) => ({ ok: true as const, path, content: contents[path]! })),
      lexicalSearch: vi.fn(async () => [
        {
          documentId: 'file-1',
          excerpt: contents['C:\\repo\\book.txt'],
          score: 100,
        },
      ]),
    });

    const hits = await repository.search(
      { accountId: 'account-1', projectId: 'project-1' },
      'From the mapped files only: what recovery color belongs to Observatory Lumen?',
    );

    expect(hits[0]?.preview).toContain('[SOURCE FILE: observatory-lumen.txt]');
    expect(hits[0]?.preview).toContain('cobalt-fern');
  });

  it('validates only bounded lexical candidates for a 312-file map', async () => {
    const content = 'Observatory Lumen uses candidate-first cobalt-fern 47291.';
    const hash = await contentSha(content);
    const fixtureMaps = maps();
    fixtureMaps[0]!.tree.nodes = Array.from({ length: 312 }, (_, index) => ({
      id: `file-${String(index).padStart(3, '0')}`,
      kind: 'file' as const,
      title: `shard-${String(index).padStart(3, '0')}.txt`,
      summary: '',
      path: `C:\\repo\\shard-${String(index).padStart(3, '0')}.txt`,
      sizeBytes: content.length,
      modifiedAt: 20,
    }));
    const stat = vi.fn(async (path: string, _includeSha256?: boolean) => ({
      ok: true as const,
      path,
      kind: 'file' as const,
      size: new TextEncoder().encode(content).length,
      modifiedMs: 20,
      sha256: hash,
    }));
    const read = vi.fn(async (path: string) => ({ ok: true as const, path, content }));
    const lexicalSearch = vi.fn(async (request: { limit: number }) => {
      expect(request.limit).toBe(8);
      return Array.from({ length: 8 }, (_, index) => ({
        documentId: `file-${String(index).padStart(3, '0')}`,
        excerpt: 'untrusted derivative excerpt',
        score: 100 - index,
      }));
    });
    const repository = createContextMapRlmRepository({
      loadMaps: vi.fn(async () => fixtureMaps),
      stat,
      read,
      lexicalSearch,
    });

    const hits = await repository.search(
      { accountId: 'account-1', projectId: 'project-1' },
      'Observatory Lumen cobalt-fern',
    );

    expect(hits).toHaveLength(8);
    expect(lexicalSearch).toHaveBeenCalledTimes(1);
    // Each of eight selected candidates has size-only preflight, SHA
    // snapshot and post-read SHA validation; no 312-file hash sweep.
    expect(stat).toHaveBeenCalledTimes(24);
    expect(stat.mock.calls.filter(([, sha]) => sha === false)).toHaveLength(8);
    expect(stat.mock.calls.filter(([, sha]) => sha === true)).toHaveLength(16);
    expect(new Set(stat.mock.calls.map(([path]) => path)).size).toBe(8);
    expect(read).toHaveBeenCalledTimes(8);
    expect(stat.mock.calls.some(([path]) => String(path).endsWith('shard-311.txt'))).toBe(false);
    expect(hits.every((hit) => !hit.preview.includes('untrusted derivative excerpt'))).toBe(true);
  });

  it('keeps a concise code-identifier query intact for the physical index', async () => {
    const content = 'O_NOFOLLOW VFS open: if (desc.nofollow && INODE_IS_SOFTLINK(inode)) ret = -ELOOP;';
    const fixtureMaps = maps();
    fixtureMaps[0]!.tree.nodes = Array.from({ length: 130 }, (_, index) => ({
      id: `file-${index}`,
      kind: 'file' as const,
      title: index === 129 ? 'fs_open.c' : `unrelated-${index}.h`,
      summary: '',
      path: index === 129 ? 'C:\\repo\\fs_open.c' : `C:\\repo\\unrelated-${index}.h`,
      sizeBytes: content.length,
      modifiedAt: 20,
    }));
    const lexicalSearch = vi.fn(async (request: { query: string }) =>
      request.query === 'O_NOFOLLOW VFS open' || request.query === 'VFS open'
        ? [{ documentId: 'file-129', excerpt: content, score: 100 }]
        : [{ documentId: 'file-0', excerpt: 'VFS header', score: 100 }]);
    const repository = createContextMapRlmRepository({
      loadMaps: vi.fn(async () => fixtureMaps),
      stat: vi.fn(async (path) => ({ ok: true as const, path, kind: 'file' as const,
        size: content.length, modifiedMs: 20, sha256: await contentSha(content) })),
      read: vi.fn(async (path) => ({ ok: true as const, path, content })),
      lexicalSearch,
    });

    const hits = await repository.search(
      { accountId: 'account-1', projectId: 'project-1' }, 'O_NOFOLLOW VFS open',
    );

    expect(lexicalSearch).toHaveBeenCalledTimes(1);
    expect(lexicalSearch).toHaveBeenCalledWith(expect.objectContaining({ query: 'O_NOFOLLOW VFS open' }), undefined);
    expect(hits[0]?.preview).toContain('[SOURCE FILE: fs_open.c]');
    const conciseHits = await repository.search(
      { accountId: 'account-1', projectId: 'project-1' }, 'VFS open',
    );
    expect(lexicalSearch).toHaveBeenLastCalledWith(expect.objectContaining({ query: 'VFS open' }), undefined);
    expect(conciseHits[0]?.preview).toContain('[SOURCE FILE: fs_open.c]');
  });

  it('opens the named allocation branch instead of a generic header or later allocation', async () => {
    const prefix = 'TCP buffered send header. '.repeat(55);
    const branch = 'Allocate resources to receive a callback.\nconn->sndcb = tcp_callback_alloc(conn);\n';
    const content = `${prefix}${branch}${'write buffer allocation follows. '.repeat(30)}`;
    const fixtureMaps = maps();
    fixtureMaps[0]!.tree.nodes = Array.from({ length: 130 }, (_, index) => ({
      id: `file-${index}`,
      kind: 'file' as const,
      title: index === 129 ? 'tcp_send_buffered.c' : `unrelated-${index}.h`,
      summary: '',
      path: index === 129 ? 'C:\\repo\\tcp_send_buffered.c' : `C:\\repo\\unrelated-${index}.h`,
      sizeBytes: content.length,
      modifiedAt: 20,
    }));
    const repository = createContextMapRlmRepository({
      loadMaps: vi.fn(async () => fixtureMaps),
      stat: vi.fn(async (path) => ({ ok: true as const, path, kind: 'file' as const,
        size: content.length, modifiedMs: 20, sha256: await contentSha(content) })),
      read: vi.fn(async (path) => ({ ok: true as const, path, content })),
      lexicalSearch: vi.fn(async () => [{ documentId: 'file-129', excerpt: branch, score: 100 }]),
    });

    const hits = await repository.search(
      { accountId: 'account-1', projectId: 'project-1' }, 'buffered TCP callback allocate',
    );

    expect(hits[0]?.pointer.byteStart).toBe(prefix.length);
    expect(hits[0]?.preview).toContain('Allocate resources to receive a callback');
  });

  it('recovers ordinary questions when capitalized directives and phrase queries have no hits', async () => {
    const content = 'Base price is 17. Service owner is Keira.';
    const hash = await contentSha(content);
    const fixtureMaps = maps();
    fixtureMaps[0]!.tree.nodes = Array.from({ length: 312 }, (_, index) => ({
      id: `file-${index}`,
      kind: 'file' as const,
      title: `shard-${index}.txt`,
      summary: '',
      path: `C:\\repo\\shard-${index}.txt`,
      sizeBytes: content.length,
      modifiedAt: 20,
    }));
    // The native literal index intersects terms. A natural-language phrase
    // does not match merely because one useful keyword occurs in the source.
    const lexicalSearch = vi.fn(async ({ query }: { query: string }) =>
      query.split(/\s+/u).every((term) => content.toLowerCase().includes(term.toLowerCase()))
        ? [{ documentId: 'file-2', excerpt: 'untrusted index excerpt', score: 10 }]
        : [],
    );
    const stat = vi.fn(async (path: string) => ({
      ok: true as const,
      path,
      kind: 'file' as const,
      size: content.length,
      modifiedMs: 20,
      sha256: hash,
    }));
    const read = vi.fn(async (path: string) => ({ ok: true as const, path, content }));
    const repository = createContextMapRlmRepository({
      loadMaps: async () => fixtureMaps,
      stat,
      read,
      lexicalSearch,
    });

    const hits = await repository.search(
      { accountId: 'account-1', projectId: 'project-1' },
      'Report pricing and ownership. Cite the base price and service owner from project files.',
    );

    expect(hits).toHaveLength(1);
    expect(hits[0]!.preview).toContain('Keira');
    expect(hits[0]!.preview).not.toContain('untrusted index excerpt');
    expect(lexicalSearch.mock.calls.length).toBeLessThanOrEqual(20);
    expect(read).toHaveBeenCalledTimes(1);
    expect(stat.mock.calls.every(([path]) => path === 'C:\\repo\\shard-2.txt')).toBe(true);
  });

  it('returns no large-map hits when its derivative index is empty', async () => {
    const fixtureMaps = maps();
    fixtureMaps[0]!.tree.nodes = Array.from({ length: 312 }, (_, index) => ({
      id: `file-${index}`,
      kind: 'file' as const,
      title: `shard-${index}.txt`,
      summary: '',
      path: `C:\\repo\\shard-${index}.txt`,
      sizeBytes: 128,
      modifiedAt: 20,
    }));
    const stat = vi.fn();
    const read = vi.fn();
    const repository = createContextMapRlmRepository({
      loadMaps: vi.fn(async () => fixtureMaps),
      stat,
      read,
      lexicalSearch: vi.fn(async () => []),
    });

    await expect(
      repository.search(
        { accountId: 'account-1', projectId: 'project-1' },
        'Observatory Lumen cobalt-fern',
      ),
    ).resolves.toEqual([]);
    expect(stat).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
  });

  it('does not search a large persisted map while its native index requires rebuilding', async () => {
    const fixtureMaps = maps();
    fixtureMaps[0]!.tree.nodes = Array.from({ length: 312 }, (_, index) => ({
      id: `file-${index}`,
      kind: 'file' as const,
      title: `shard-${index}.txt`,
      summary: '',
      path: `C:\\repo\\shard-${index}.txt`,
      sizeBytes: 128,
      modifiedAt: 20,
    }));
    const lexicalSearch = vi.fn(async () => [
      { documentId: 'file-0', excerpt: 'must remain unavailable', score: 100 },
    ]);
    const indexStatus = vi.fn(async () => ({ documentCount: 311, needsRebuild: true }));
    const repository = createContextMapRlmRepository({
      loadMaps: vi.fn(async () => fixtureMaps),
      stat: vi.fn(),
      read: vi.fn(),
      lexicalSearch,
      indexStatus,
    });

    await expect(
      repository.search(
        { accountId: 'account-1', projectId: 'project-1' },
        'Observatory Lumen cobalt-fern',
      ),
    ).rejects.toMatchObject({code: 'context_index_unavailable', reason: 'index_empty_or_rebuild'});
    expect(indexStatus).toHaveBeenCalledWith('account-1', 'map-1');
    expect(lexicalSearch).not.toHaveBeenCalled();
  });

  it('caps large-map lexical fanout at five maps and twenty physical candidates globally', async () => {
    const content = 'global candidate cap Observatory Lumen cobalt-fern';
    const hash = await contentSha(content);
    const fixtureMaps = Array.from({ length: 6 }, (_, mapIndex) => ({
      ...maps()[0]!,
      id: `map-${mapIndex}`,
      rootDir: `C:\\repo-${mapIndex}`,
      updatedAt: 100 - mapIndex,
      tree: {
        nodes: Array.from({ length: 30 }, (__, nodeIndex) => ({
          id: `file-${nodeIndex}`,
          kind: 'file' as const,
          title: `shard-${nodeIndex}.txt`,
          summary: '',
          path: `C:\\repo-${mapIndex}\\shard-${nodeIndex}.txt`,
          sizeBytes: content.length,
          modifiedAt: 20,
        })),
      },
    }));
    const lexicalSearch = vi.fn(async () =>
      Array.from({ length: 8 }, (_, index) => ({
        documentId: `file-${index}`,
        excerpt: content,
        score: 100 - index,
      })),
    );
    const read = vi.fn(async (path: string) => ({ ok: true as const, path, content }));
    const repository = createContextMapRlmRepository({
      loadMaps: vi.fn(async () => fixtureMaps),
      stat: vi.fn(async (path) => ({
        ok: true as const,
        path,
        kind: 'file' as const,
        size: new TextEncoder().encode(content).length,
        modifiedMs: 20,
        sha256: hash,
      })),
      read,
      lexicalSearch,
    });

    const hits = await repository.search(
      { accountId: 'account-1', projectId: 'project-1' },
      'Observatory Lumen cobalt-fern',
    );

    expect(lexicalSearch).toHaveBeenCalledTimes(5);
    expect(read).toHaveBeenCalledTimes(20);
    expect(hits).toHaveLength(20);
    expect(read.mock.calls.some(([path]) => String(path).startsWith('C:\\repo-5\\'))).toBe(false);
  });

  it('does not emit an indexed candidate whose current physical bytes do not match the query', async () => {
    const content = 'current physical bytes contain unrelated material only';
    const hash = await contentSha(content);
    const fixtureMaps = maps();
    fixtureMaps[0]!.tree.nodes = Array.from({ length: 129 }, (_, index) => ({
      id: `file-${index}`,
      kind: 'file' as const,
      title: `shard-${index}.txt`,
      summary: '',
      path: `C:\\repo\\shard-${index}.txt`,
      sizeBytes: content.length,
      modifiedAt: 20,
    }));
    const repository = createContextMapRlmRepository({
      loadMaps: vi.fn(async () => fixtureMaps),
      stat: vi.fn(async (path) => ({
        ok: true as const,
        path,
        kind: 'file' as const,
        size: new TextEncoder().encode(content).length,
        modifiedMs: 20,
        sha256: hash,
      })),
      read: vi.fn(async (path) => ({ ok: true as const, path, content })),
      lexicalSearch: vi.fn(async () => [
        {
          documentId: 'file-0',
          excerpt: 'Observatory Lumen cobalt-fern from a stale derivative index',
          score: 1_000_000,
        },
      ]),
    });

    await expect(
      repository.search(
        { accountId: 'account-1', projectId: 'project-1' },
        'Observatory Lumen cobalt-fern',
      ),
    ).resolves.toEqual([]);
  });

  it('rejects a lexical candidate when returned bytes do not match both physical SHA observations', async () => {
    const indexedContent = 'Observatory Lumen uses indexed cobalt-fern 47291.';
    const returnedContent = 'Observatory Lumen uses changed cobalt-fern 47291.';
    const indexedHash = await contentSha(indexedContent);
    const fixtureMaps = maps();
    fixtureMaps[0]!.tree.nodes = Array.from({ length: 129 }, (_, index) => ({
      id: `file-${index}`,
      kind: 'file' as const,
      title: `shard-${index}.txt`,
      summary: '',
      path: `C:\\repo\\shard-${index}.txt`,
      sizeBytes: indexedContent.length,
      modifiedAt: 20,
    }));
    const repository = createContextMapRlmRepository({
      loadMaps: vi.fn(async () => fixtureMaps),
      stat: vi.fn(async (path) => ({
        ok: true as const,
        path,
        kind: 'file' as const,
        size: new TextEncoder().encode(returnedContent).length,
        modifiedMs: 20,
        sha256: indexedHash,
      })),
      read: vi.fn(async (path) => ({ ok: true as const, path, content: returnedContent })),
      lexicalSearch: vi.fn(async () => [
        { documentId: 'file-0', excerpt: indexedContent, score: 100 },
      ]),
    });

    await expect(
      repository.search(
        { accountId: 'account-1', projectId: 'project-1' },
        'Observatory Lumen cobalt-fern',
      ),
    ).resolves.toEqual([]);
  });

  it('preserves empty-index physical fallback for a 96-file map below 8 MiB', async () => {
    const content = `${'bounded filler '.repeat(4_000)} Observatory Lumen cobalt-fern 47291.`;
    const bytes = new TextEncoder().encode(content).length;
    const hash = await contentSha(content);
    expect(bytes * 96).toBeLessThanOrEqual(8 * 1024 * 1024);
    const fixtureMaps = maps();
    fixtureMaps[0]!.tree.nodes = Array.from({ length: 96 }, (_, index) => ({
      id: `file-${String(index).padStart(3, '0')}`,
      kind: 'file' as const,
      title: `shard-${String(index).padStart(3, '0')}.txt`,
      summary: '',
      path: `C:\\repo\\shard-${String(index).padStart(3, '0')}.txt`,
      sizeBytes: bytes,
      modifiedAt: 20,
    }));
    const stat = vi.fn(async (path: string, includeSha256: boolean) => ({
      ok: true as const,
      path,
      kind: 'file' as const,
      size: bytes,
      modifiedMs: 20,
      ...(includeSha256 ? { sha256: hash } : {}),
    }));
    const read = vi.fn(async (path: string) => ({ ok: true as const, path, content }));
    const repository = createContextMapRlmRepository({
      loadMaps: vi.fn(async () => fixtureMaps),
      stat,
      read,
      lexicalSearch: vi.fn(async () => []),
    });

    const hits = await repository.search(
      { accountId: 'account-1', projectId: 'project-1' },
      'Observatory Lumen cobalt-fern',
    );

    expect(hits).toHaveLength(20);
    expect(read).toHaveBeenCalledTimes(96);
    // One sizing pass plus one pre-hash probe for each of 96 candidates.
    expect(stat.mock.calls.filter(([, includeSha]) => includeSha === false)).toHaveLength(192);
    expect(stat.mock.calls.filter(([, includeSha]) => includeSha === true)).toHaveLength(192);
    for (const node of fixtureMaps[0]!.tree.nodes) {
      expect(read.mock.calls.filter(([path]) => path === node.path)).toHaveLength(1);
      expect(stat.mock.calls.filter(([path, sha]) => path === node.path && sha === false)).toHaveLength(2);
      expect(stat.mock.calls.filter(([path, sha]) => path === node.path && sha === true)).toHaveLength(2);
    }
  });

  it('retrieves bounded files in a small mixed-size map without reading oversized bodies', async () => {
    const content = 'The release owner is Mara Chen.';
    const hash = await contentSha(content);
    const fixtureMaps = maps();
    fixtureMaps[0]!.tree.nodes = ['small.txt', 'large.txt'].map((name) => ({
      id: name,
      kind: 'file' as const,
      title: name,
      summary: '',
      path: 'C:\\repo\\' + name,
    }));
    const read = vi.fn(async (path: string) => ({ ok: true as const, path, content }));
    const repository = createContextMapRlmRepository({
      loadMaps: async () => fixtureMaps,
      stat: async (path: string) => ({
        ok: true as const,
        path,
        kind: 'file' as const,
        size: path.endsWith('large.txt') ? 2 * 1024 * 1024 : content.length,
        modifiedMs: 20,
        sha256: hash,
      }),
      read,
      lexicalSearch: async () => [],
      indexStatus: async () => ({
        documentCount: 0,
        indexId: 'empty',
        engine: 'tantivy-0.22.1',
        schemaVersion: 1,
        recoveredCorruption: false,
        needsRebuild: false,
      }),
    });
    const hits = await repository.search(
      { accountId: 'account-1', projectId: 'project-1' },
      'Mara Chen',
    );
    expect(hits).toHaveLength(1);
    expect(hits[0]?.preview).toContain('Mara Chen');
    expect(read.mock.calls.map(([path]) => path)).toEqual(['C:\\repo\\small.txt']);
  });

  it.each([
    { named: true, query: 'source file fs/vfs/fs_open.c: What happens to a null pathname before inode search?' },
    { named: false, query: 'What happens to a null pathname before inode search?' },
  ])('respects explicit source selection without hiding broad search pagination (named=$named)', async ({ named, query }) => {
    const content = 'A null pathname returns an error before inode search.';
    const hash = await contentSha(content);
    const fixtureMaps = maps();
    fixtureMaps[0]!.tree.nodes = Array.from({ length: 130 }, (_, index) => ({
      id: `file-${index}`, kind: 'file' as const,
      title: index === 0 ? 'fs_open.c' : `unrelated-${index}.c`, summary: '',
      path: index === 0 ? 'fs/vfs/fs_open.c' : `other/unrelated-${index}.c`,
    }));
    const read = vi.fn(async (path: string) => ({ ok: true as const, path, content }));
    const lexicalSearch = vi.fn(async () => Array.from({ length: 9 }, (_, index) => ({
      documentId: `file-${index}`, excerpt: content, score: 100 - index,
    })));
    const repository = createContextMapRlmRepository({
      loadMaps: async () => fixtureMaps,
      stat: async (path: string) => ({ ok: true as const, path, kind: 'file' as const,
        size: content.length, modifiedMs: 20, sha256: hash }),
      read,
      lexicalSearch,
      indexStatus: async () => ({ documentCount: 130, needsRebuild: false }),
    });
    const service = createContextQueryService({ repository });
    const result = await service.search({
      scope: { accountId: 'account-1', projectId: 'project-1' }, query, limit: 6,
    });
    expect(result.items).toHaveLength(named ? 1 : 6);
    expect(result.truncated).toBe(!named);
    if (named) {
      expect(result.items[0]?.preview).toContain('SOURCE FILE: fs_open.c');
      expect(result.continuation).toBeUndefined();
      expect(lexicalSearch).not.toHaveBeenCalled();
      expect([...new Set(read.mock.calls.map(([path]) => path))]).toEqual(['C:\\repo\\fs\\vfs\\fs_open.c']);
    } else {
      expect(result.continuation).toBeDefined();
      expect(lexicalSearch).toHaveBeenCalled();
    }
  });

  it('opens an explicitly named mapped file when broad lexical queries miss it', async () => {
    const content = 'package33332 == 2.8.3';
    const hash = await contentSha(content);
    const fixtureMaps = maps();
    fixtureMaps[0]!.tree.nodes = Array.from({ length: 129 }, (_, i) => ({
      id: 'file-' + i,
      kind: 'file' as const,
      title: 'part-' + i + '.txt',
      summary: '',
      path: 'part-' + i + '.txt',
    }));
    const read = vi.fn(async (path: string) => ({ ok: true as const, path, content }));
    const lexicalSearch = vi.fn(async () => []);
    const repository = createContextMapRlmRepository({
      loadMaps: async () => fixtureMaps,
      stat: async (path: string) => ({
        ok: true as const,
        path,
        kind: 'file' as const,
        size: content.length,
        modifiedMs: 20,
        sha256: hash,
      }),
      read,
      lexicalSearch,
      indexStatus: async () => ({
        documentCount: 129,
        indexId: 'ready',
        engine: 'tantivy-0.22.1',
        schemaVersion: 1,
        recoveredCorruption: false,
        needsRebuild: false,
      }),
    });
    const scope = { accountId: 'account-1', projectId: 'project-1' };
    const hits = await repository.search(scope, 'Audit the contents of part-128.txt.');
    expect(hits).toHaveLength(1);
    expect(hits[0]?.preview).toContain('package33332');
    expect(read.mock.calls.map(([path]) => path)).toEqual(['C:\\repo\\part-128.txt']);
    read.mockClear();
    await expect(repository.search(scope, 'Audit not-part-128.txt.bak')).resolves.toEqual([]);
    expect(read).not.toHaveBeenCalled();
  });

  it('searches an indexed large map whose graph also retains one oversized file', async () => {
    const content = 'wd_start_abstick returns -EINVAL for a null callback.';
    const hash = await contentSha(content);
    const map = maps()[0]!;
    const nodes = Array.from({ length: 129 }, (_, index) => ({
      id: `file-${index}`, kind: 'file' as const, title: `part-${index}.c`,
      summary: '', path: `part-${index}.c`,
    }));
    const lexicalSearch = vi.fn(async () => [{
      documentId: 'file-128', excerpt: content, score: 100,
    }]);
    const repository = createContextMapRlmRepository({
      loadMaps: async () => [{ ...map, tree: { nodes } }],
      stat: async (path) => ({ ok: true as const, path, kind: 'file' as const,
        size: content.length, modifiedMs: 20, sha256: hash }),
      read: async (path) => ({ ok: true as const, path, content }),
      lexicalSearch,
      indexStatus: async () => ({ documentCount: 128, needsRebuild: false }),
    });

    const hits = await repository.search(
      { accountId: 'account-1', projectId: 'project-1' },
      'wd_start_abstick null callback',
    );
    expect(lexicalSearch).toHaveBeenCalled();
    expect(hits.some((hit) => hit.preview.includes('-EINVAL'))).toBe(true);
  });

  it('keeps head and tail requests attached to their own named file clauses', async () => {
    const content = 'HEAD verified field\n' + 'filler '.repeat(4000) + '\nTAIL final entry';
    const hash = await contentSha(content);
    const fixtureMaps = maps();
    fixtureMaps[0]!.tree.nodes = ['header.txt', 'tail.txt'].map((name) => ({
      id: name,
      kind: 'file' as const,
      title: name,
      path: name,
      summary: '',
    }));
    const repository = createContextMapRlmRepository({
      loadMaps: async () => fixtureMaps,
      stat: async (path: string) => ({
        ok: true as const,
        path,
        kind: 'file' as const,
        size: content.length,
        modifiedMs: 20,
        sha256: hash,
      }),
      read: async (path: string) => ({ ok: true as const, path, content }),
      lexicalSearch: async () => [],
    });
    const hits = await repository.search(
      { accountId: 'account-1', projectId: 'project-1' },
      'Read header.txt (root field); tail.txt (last entry).',
    );
    expect(hits).toHaveLength(2);
    const head = hits.find((hit) => hit.preview.includes('SOURCE FILE: header.txt'));
    const tail = hits.find((hit) => hit.preview.includes('SOURCE FILE: tail.txt'));
    expect(head?.pointer.byteStart).toBe(0);
    expect(head?.preview).toContain('HEAD verified');
    expect(tail?.pointer.byteStart).toBeGreaterThan(content.length - 1024);
  });

  it('rejects traversing relative node paths before native filesystem access', async () => {
    const fixtureMaps = maps();
    fixtureMaps[0]!.tree.nodes[0]!.path = '../outside.txt';
    const stat = vi.fn();
    const repository = createContextMapRlmRepository({
      loadMaps: vi.fn(async () => fixtureMaps),
      stat,
      read: vi.fn(),
      lexicalSearch: vi.fn(),
    });

    await expect(
      repository.listRecords({ accountId: 'account-1', projectId: 'project-1' }),
    ).resolves.toEqual([]);
    expect(stat).not.toHaveBeenCalled();
  });

  it('preserves local and Git source families and retrieves bounded evidence from both', async () => {
    const localContent = 'Restart support landed with checkpoint marker cross-source-uat.';
    const fixtureMaps = [
      {
        ...maps()[0]!,
        sourceType: 'local_folder' as const,
        tree: {
          nodes: [
            {
              ...maps()[0]!.tree.nodes[0]!,
              summary: localContent,
            },
          ],
        },
      },
      {
        id: 'map-git',
        projectId: 'project-1',
        rootDir: 'https://github.com/acme/vibespace/tree/abc123',
        status: 'active' as const,
        updatedAt: 21,
        sourceType: 'github_repository' as const,
        github: {
          owner: 'acme',
          repository: 'vibespace',
          resolvedCommitSha: 'abc123',
          visibility: 'private' as const,
        },
        tree: {
          nodes: [
            {
              id: 'git-file-1',
              kind: 'file' as const,
              title: 'pause.ts',
              summary: 'Pause support landed with checkpoint marker cross-source-uat.',
              path: 'https://github.com/acme/vibespace/blob/abc123/pause.ts',
            },
          ],
        },
      },
    ];
    const repository = createContextMapRlmRepository({
      loadMaps: vi.fn(async () => fixtureMaps),
      stat: vi.fn(async (path) => ({
        ok: true as const,
        path,
        kind: 'file' as const,
        size: localContent.length,
        modifiedMs: 20,
        sha256: await contentSha(localContent),
      })),
      read: vi.fn(async (path) => ({ ok: true as const, path, content: localContent })),
      lexicalSearch: vi.fn(async () => []),
    });
    const scope = { accountId: 'account-1', projectId: 'project-1' };

    const records = await repository.listRecords(scope);
    expect(records.map((record) => record.sourceKind).sort()).toEqual(['file_version', 'git']);
    expect(records.find((record) => record.sourceKind === 'git')).toMatchObject({
      gitCommit: 'abc123',
      contentRef: 'https://github.com/acme/vibespace/blob/abc123/pause.ts',
    });

    const hits = await repository.search(scope, '"cross-source-uat"');
    expect(hits).toHaveLength(2);
    await expect(
      Promise.all(
        hits.map(async (hit) => {
          const record = await repository.getRecord(hit.recordId);
          expect(record).toBeDefined();
          expect(await repository.canOpen(record!, scope)).toBe(true);
          return repository.readSource(record!);
        }),
      ),
    ).resolves.toHaveLength(2);
  });

  it('re-checks path and content policy, denying credential paths and secret-like bytes', async () => {
    const fixtureMaps = maps();
    fixtureMaps[0]!.tree.nodes[0]!.path = 'C:\\repo\\.env';
    const repository = createContextMapRlmRepository({
      loadMaps: vi.fn(async () => fixtureMaps),
      stat: vi.fn(async (path) => ({
        ok: true as const,
        path,
        kind: 'file' as const,
        size: 30,
        sha256: SHA,
      })),
      read: vi.fn(async (path) => ({
        ok: true as const,
        path,
        content: 'OPENAI_API_KEY=must-not-escape',
      })),
      lexicalSearch: vi.fn(async () => []),
    });
    const [record] = await repository.listRecords({
      accountId: 'account-1',
      projectId: 'project-1',
    });

    await expect(
      repository.canOpen(record!, {
        accountId: 'account-1',
        projectId: 'project-1',
      }),
    ).resolves.toBe(false);
  });

  it('denies canOpen for the same account across a foreign workspace/project/worktree scope', async () => {
    const repository = createContextMapRlmRepository({
      loadMaps: vi.fn(async () => maps()),
      stat: vi.fn(async (path) => ({
        ok: true as const,
        path,
        kind: 'file' as const,
        size: 128,
        sha256: SHA,
      })),
      read: vi.fn(async (path) => ({ ok: true as const, path, content: 'safe text' })),
      lexicalSearch: vi.fn(),
    });
    const sourceScope = {
      accountId: 'account-1',
      workspaceId: 'workspace-1',
      projectId: 'project-1',
      worktreeId: 'worktree-1',
    };
    const [record] = await repository.listRecords(sourceScope);

    await expect(
      repository.canOpen!(record!, {
        accountId: 'account-1',
        workspaceId: 'workspace-2',
        projectId: 'project-1',
        worktreeId: 'worktree-1',
      }),
    ).resolves.toBe(false);
  });

  it('denies a forged record with a valid ID and never reads its substituted path', async () => {
    const read = vi.fn(async (path) => ({ ok: true as const, path, content: 'safe text' }));
    const repository = createContextMapRlmRepository({
      loadMaps: vi.fn(async () => maps()),
      stat: vi.fn(async (path) => ({
        ok: true as const,
        path,
        kind: 'file' as const,
        size: 128,
        sha256: SHA,
      })),
      read,
      lexicalSearch: vi.fn(),
    });
    const scope = { accountId: 'account-1', projectId: 'project-1' };
    const [record] = await repository.listRecords(scope);
    const forged = {
      ...record!,
      contentRef: 'C:\\repo\\forged.txt',
      path: 'C:\\repo\\forged.txt',
    };

    await expect(repository.canOpen!(forged, scope)).resolves.toBe(false);
    expect(read).not.toHaveBeenCalledWith(
      'C:\\repo\\forged.txt',
      expect.anything(),
      expect.anything(),
    );
  });
});

describe('production OpenCode RLM child runner', () => {
  it.each(['opencode-persistent', 'opencode-cli'])(
    'creates a fresh child on the exact observed %s route with no tools', async (transportAdapterId) => {
    const send = vi.fn(async function* () {
      yield { type: 'assistant.delta' as const, text: 'bounded local analysis' };
      yield { type: 'done' as const };
    });
    const harness = {
      createSession: vi.fn(async () => ({ id: 'child-session', chatId: 'rlm-child' })),
      send,
      deleteSession: vi.fn(async () => undefined),
      listModels: vi.fn(async () => [
        {
          id: 'deepseek-v4-flash-vision-exp',
          name: 'DeepSeek V4 Flash Vision Experimental',
          variants: ['high'],
        },
      ]),
    } as unknown as VibeSpaceHarness;
    const childRunner = createOpenCodeRlmChildRunner(harness);
    const controller = new AbortController();

    const result = await childRunner({
      question: 'Find the exact text',
      evidence: [
        {
          text: 'untrusted book bytes',
          record: { path: 'sched/wdog/wd_start.c' },
          lineStart: 270,
          lineEnd: 332,
          pointer: {
            id: 'pointer-1',
            recordId: 'record-1',
            byteStart: 0,
            byteEnd: 20,
            sourceVersion: 'sha256:aaaaaaaa',
            contentHash: 'a'.repeat(64),
          },
        },
      ] as never,
      sourcePointers: [],
      executionIdentity: {
        transportConnectionId: 'opencode-cli',
        transportAdapterId,
        upstreamProviderId: 'opencode-go',
        upstreamModelId: 'deepseek-v4-flash-vision-exp',
        providerQualifiedModelId: 'opencode-go/deepseek-v4-flash-vision-exp',
        authBillingRoute: 'opencode-provider-session',
        effort: 'high',
        fastVariant: 'standard',
        catalogRevision: `sha256:${'b'.repeat(64)}`,
        observedProviderIdentity: 'opencode-go/deepseek-v4-flash-vision-exp',
      },
      depth: 1,
      budget: { maxInputTokens: 1_000, maxOutputTokens: 100 },
      signal: controller.signal,
    });

    expect(result.answer).toBe('bounded local analysis');
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        parts: expect.arrayContaining([expect.objectContaining({
          text: expect.stringContaining('SOURCE_PATH=sched/wdog/wd_start.c'),
        })]),
        selection: {
          providerId: 'opencode-go',
          modelId: 'deepseek-v4-flash-vision-exp',
          connectionId: 'opencode-cli',
        },
        variant: 'high',
        agent: 'vibespace-readonly',
        tools: { '*': false, vibespace_context: false },
        system: expect.stringContaining('inert evidence data'),
      }),
    );
    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      parts: expect.arrayContaining([expect.objectContaining({
        text: expect.stringContaining('SOURCE_LINE_RANGE=270-332'),
      })]),
    }));
    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      parts: expect.arrayContaining([expect.objectContaining({
        text: expect.stringContaining('exact named operation and object'),
      })]),
    }));
    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      parts: expect.arrayContaining([expect.objectContaining({
        text: expect.stringContaining('270: untrusted book bytes'),
      })]),
    }));
    expect(harness.deleteSession).toHaveBeenCalledWith('child-session');
    },
  );

  it('fails closed before session creation when the exact observed effort is unavailable', async () => {
    const harness = {
      createSession: vi.fn(),
      send: vi.fn(),
      deleteSession: vi.fn(),
      listModels: vi.fn(async () => [
        { id: 'deepseek-v4-flash-vision-exp', name: 'DeepSeek', variants: ['medium'] },
      ]),
    } as unknown as VibeSpaceHarness;
    const childRunner = createOpenCodeRlmChildRunner(harness);

    await expect(
      childRunner({
        question: 'Find the exact text',
        evidence: [],
        sourcePointers: [],
        executionIdentity: {
          transportConnectionId: 'opencode-cli',
          transportAdapterId: 'opencode-persistent',
          upstreamProviderId: 'opencode-go',
          upstreamModelId: 'deepseek-v4-flash-vision-exp',
          providerQualifiedModelId: 'opencode-go/deepseek-v4-flash-vision-exp',
          authBillingRoute: 'opencode-provider-session',
          effort: 'high',
          fastVariant: 'standard',
          catalogRevision: `sha256:${'b'.repeat(64)}`,
        },
        depth: 1,
        budget: {},
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow('rlm_exact_variant_unavailable');
    expect(harness.createSession).not.toHaveBeenCalled();
  });

  it('does not create a provider session when cancellation arrives during exact model lookup', async () => {
    type Models = Awaited<ReturnType<VibeSpaceHarness['listModels']>>;
    let resolveModels!: (models: Models) => void;
    const listModels = vi.fn(() => new Promise<Models>((resolve) => { resolveModels = resolve; }));
    const createSession = vi.fn();
    const send = vi.fn();
    const harness = {
      createSession, send, deleteSession: vi.fn(), listModels,
    } as unknown as VibeSpaceHarness;
    const childRunner = createOpenCodeRlmChildRunner(harness);
    const controller = new AbortController();
    const pending = childRunner({
      question: 'Find the exact text',
      evidence: [],
      sourcePointers: [],
      executionIdentity: {
        transportConnectionId: 'opencode-cli',
        transportAdapterId: 'opencode-persistent',
        upstreamProviderId: 'opencode-go',
        upstreamModelId: 'deepseek-v4-flash-vision-exp',
        providerQualifiedModelId: 'opencode-go/deepseek-v4-flash-vision-exp',
        authBillingRoute: 'opencode-provider-session',
        effort: 'high',
        fastVariant: 'standard',
        catalogRevision: `sha256:${'b'.repeat(64)}`,
      },
      depth: 1,
      budget: {},
      signal: controller.signal,
    });

    await vi.waitFor(() => expect(listModels).toHaveBeenCalledOnce());
    controller.abort('owner_cancelled');
    resolveModels([{ id: 'deepseek-v4-flash-vision-exp', name: 'DeepSeek', variants: ['high'] }]);

    await expect(pending).rejects.toMatchObject({ code: 'cancelled' });
    expect(createSession).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it('maps a failed native abort acknowledgement to the RLM unconfirmed state', async () => {
    const controller = new AbortController();
    const send = vi.fn(async function* (request: { signal?: AbortSignal }) {
      await new Promise<void>((resolve) => {
        if (request.signal?.aborted) resolve();
        else request.signal?.addEventListener('abort', () => resolve(), { once: true });
      });
      throw new HarnessError({
        code: 'HARNESS_ABORT_UNCONFIRMED',
        message: 'The OpenCode server did not confirm cancellation.',
        repair: 'Check the OpenCode server session before retrying.',
        recoverable: true,
      });
    });
    const deleteSession = vi.fn(async () => {
      throw new Error('child session cleanup failed');
    });
    const harness = {
      createSession: vi.fn(async () => ({ id: 'child-session', chatId: 'rlm-child' })),
      send,
      deleteSession,
      listModels: vi.fn(async () => [
        { id: 'deepseek-v4-flash-vision-exp', name: 'DeepSeek', variants: ['high'] },
      ]),
    } as unknown as VibeSpaceHarness;
    const childRunner = createOpenCodeRlmChildRunner(harness);
    const pending = childRunner({
      question: 'confirm native abort acknowledgement',
      evidence: [],
      sourcePointers: [],
      executionIdentity: {
        transportConnectionId: 'opencode-cli',
        transportAdapterId: 'opencode-persistent',
        upstreamProviderId: 'opencode-go',
        upstreamModelId: 'deepseek-v4-flash-vision-exp',
        providerQualifiedModelId: 'opencode-go/deepseek-v4-flash-vision-exp',
        authBillingRoute: 'opencode-provider-session',
        effort: 'high',
        fastVariant: 'standard',
        catalogRevision: `sha256:${'b'.repeat(64)}`,
      },
      depth: 1,
      budget: {},
      signal: controller.signal,
    });

    await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
    controller.abort('owner_cancelled');

    await expect(pending).rejects.toMatchObject({
      name: 'RlmRuntimeError',
      code: 'abort_unconfirmed',
      message: 'rlm_abort_acknowledgement_failed',
    });
    expect(deleteSession).toHaveBeenCalledWith('child-session');
  });

  it.each(['codex-cli', 'codex-app-server'])(
    'rejects %s before dispatch when native tool isolation is unavailable',
    async (transportAdapterId) => {
      const harness = {
        createSession: vi.fn(), send: vi.fn(), deleteSession: vi.fn(), listModels: vi.fn(),
      } as unknown as VibeSpaceHarness;
      const childRunner = createOpenCodeRlmChildRunner(harness);
      await expect(childRunner({
        question: 'Investigate the marker', evidence: [], sourcePointers: [],
        executionIdentity: {
          transportConnectionId: 'openai-codex', transportAdapterId,
          upstreamProviderId: 'openai', upstreamModelId: 'gpt-5.6-luna',
          providerQualifiedModelId: 'openai/gpt-5.6-luna',
          authBillingRoute: 'codex-cli-session', effort: 'low', fastVariant: 'standard',
          catalogRevision: `sha256:${'e'.repeat(64)}`,
        },
        depth: 1, budget: {}, signal: new AbortController().signal,
      })).rejects.toThrow('rlm_codex_tool_free_execution_unavailable');
      expect(harness.createSession).not.toHaveBeenCalled();
      expect(harness.send).not.toHaveBeenCalled();
      expect(harness.listModels).not.toHaveBeenCalled();
    },
  );
});
