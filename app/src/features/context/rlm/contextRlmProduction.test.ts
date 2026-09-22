import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_CHAT_RUNTIME_SETTINGS } from '@/features/chat/runtime/chatRuntimeCommandController';
import type { RepositoryRetrievalResult } from '@/features/context/repositoryRetrieval';
import { formatRepositoryRetrievalItem } from '@/features/context/repositoryRetrievalRuntime';
import { prepareProductionRlmContext } from './contextRlmProduction';

function result(path = 'src/example.ts', count = 1): RepositoryRetrievalResult {
  return {
    mapId: 'map-1',
    repositoryRevision: 'repo-v1',
    structuralRevision: 1,
    items: Array.from({ length: count }, (_, index) => {
      const suffix = index + 1;
      return {
        path: count === 1 ? path : `${path}.${suffix}`,
        language: 'typescript',
        representation: 'full',
        content: 'export const answer = 42;',
        tokens: 8,
        whySelected: ['task_relevance'],
        symbols: [],
        evidence: {
          mapId: 'map-1',
          entityId: `entity-${suffix}`,
          sourceId: `source-${suffix}`,
          provenanceId: `provenance-${suffix}`,
          sourceRevision: 'source-v1',
          repositoryRevision: 'repo-v1',
          contentHash: `sha256:${'a'.repeat(64)}`,
          astHash: `sha256:${'b'.repeat(64)}`,
          parserId: 'tree-sitter',
          parserVersion: '1',
        },
      };
    }),
    relationships: [],
    exclusions: [],
    totalTokens: 8,
    remainingTokens: 1_000,
    parsedChangedPaths: [],
  };
}

const dependencies = (retrieveRepository = vi.fn(async () => result())) => ({
  retrieveRepository,
  now: () => 100,
  createId: () => 'rlm-run-1',
});

describe('production Context/RLM adapter', () => {
  it.each(['focused', 'deep'] as const)(
    'reports partial coverage for oversized files on the %s route',
    async (requestedRoute) => {
      const retrieved = result();
      retrieved.exclusions = [
        { path: 'large-corpus.txt', reason: 'file_too_large' },
        { path: 'private-name.txt', reason: 'secret_risk' },
      ];
      const value = await prepareProductionRlmContext(
        {
          accountId: 'account-1',
          projectId: 'project-1',
          question: 'Review the entire project including the large corpus.',
          requestedRoute,
          settings: DEFAULT_CHAT_RUNTIME_SETTINGS,
        },
        dependencies(vi.fn(async () => retrieved)),
      );

      expect(value.truncated).toBe(true);
      expect(value.promptBlock).toContain('1 candidate file exceeded the bounded read limit');
      expect(value.promptBlock).toContain('bounded range reads');
      expect(value.promptBlock).not.toContain('private-name');
      expect(value.evidenceCount).toBeGreaterThan(0);
      expect(value.evidence[0]?.text).toContain('export const answer = 42;');
    },
  );

  it('truncates oversized multibyte evidence at a valid UTF-8 boundary', async () => {
    const base = result();
    const item = base.items[0]!;
    const emptyFormatted = formatRepositoryRetrievalItem({ ...item, content: '' });
    const contentMarker = '\n--- END PROJECT FILE DATA ---';
    const contentStart = emptyFormatted.indexOf(contentMarker);
    expect(contentStart).toBeGreaterThan(0);
    const prefixBytes = new TextEncoder().encode(
      emptyFormatted.slice(0, contentStart + 1),
    ).byteLength;
    const maxBytes = 256 * 1_024;
    const leadingAsciiBytes = maxBytes - prefixBytes - 1;
    const retrieved: RepositoryRetrievalResult = {
      ...base,
      items: [
        {
          ...item,
          content: `${'a'.repeat(leadingAsciiBytes)}🙂tail`,
        },
      ],
    };

    const value = await prepareProductionRlmContext(
      {
        accountId: 'account-1',
        projectId: 'project-1',
        question: 'What was the previous decision?',
        requestedRoute: 'focused',
        settings: DEFAULT_CHAT_RUNTIME_SETTINGS,
      },
      dependencies(vi.fn(async () => retrieved)),
    );

    const evidence = value.evidence[0]?.text ?? '';
    expect(value.truncated).toBe(true);
    expect(evidence).not.toContain('\uFFFD');
    expect(new TextEncoder().encode(evidence).byteLength).toBeLessThanOrEqual(maxBytes);
    expect(evidence.endsWith('a')).toBe(true);
  });

  it('keeps ordinary current-turn work direct with no repository read', async () => {
    const retrieveRepository = vi.fn(async () => result());
    const value = await prepareProductionRlmContext(
      {
        accountId: 'account-1',
        projectId: 'project-1',
        question: 'Rename this local variable.',
        settings: DEFAULT_CHAT_RUNTIME_SETTINGS,
      },
      dependencies(retrieveRepository),
    );
    expect(value.route).toBe('direct');
    expect(value.promptBlock).toBe('');
    expect(retrieveRepository).not.toHaveBeenCalled();
  });

  it('uses bounded retrieval and publishes exact visible pointer provenance', async () => {
    const value = await prepareProductionRlmContext(
      {
        accountId: 'account-1',
        projectId: 'project-1',
        question: 'What was the previous decision in the project?',
        settings: DEFAULT_CHAT_RUNTIME_SETTINGS,
      },
      dependencies(),
    );
    expect(value.route).toBe('retrieval');
    expect(value.evidenceCount).toBe(1);
    expect(value.promptBlock).toContain('Pointer: rlm-run-1-p1');
    expect(value.promptBlock).toContain(`Content hash: sha256:${'a'.repeat(64)}`);
    expect(value.evidence).toEqual([
      expect.objectContaining({
        handle: 'rlm-run-1-p1',
        sourceId: 'source-1',
        sourceRevision: 'source-v1',
        text: expect.stringContaining('export const answer = 42;'),
      }),
    ]);
  });

  it('reports all ranked candidates while hydrating only the focused top five', async () => {
    const value = await prepareProductionRlmContext(
      {
        accountId: 'account-1',
        projectId: 'project-1',
        question: 'What was the previous project decision?',
        settings: DEFAULT_CHAT_RUNTIME_SETTINGS,
      },
      dependencies(vi.fn(async () => result('src/candidate.ts', 7))),
    );

    expect(value).toMatchObject({
      route: 'retrieval',
      candidateCount: 7,
      hydratedCount: 5,
      evidenceCount: 5,
    });
  });

  it('honors the caller-authoritative exact route without independent broad routing', async () => {
    const retrieveRepository = vi.fn(async () => result());
    const value = await prepareProductionRlmContext(
      {
        accountId: 'account-1',
        projectId: 'project-1',
        question: 'Read src/example.ts exactly.',
        requestedRoute: 'exact',
        explicitEntityIds: ['entity-1'],
        settings: { ...DEFAULT_CHAT_RUNTIME_SETTINGS, rlmEnabled: false },
      },
      dependencies(retrieveRepository),
    );
    expect(value.route).toBe('retrieval');
    expect(retrieveRepository).toHaveBeenCalledTimes(1);
  });

  it('runs a bounded recursive investigation for whole-project root-cause work', async () => {
    const retrieveRepository = vi.fn(async () => result());
    const value = await prepareProductionRlmContext(
      {
        accountId: 'account-1',
        projectId: 'project-1',
        question: 'Check the entire project archive and explain the root cause across all files.',
        settings: DEFAULT_CHAT_RUNTIME_SETTINGS,
      },
      dependencies(retrieveRepository),
    );
    expect(value.route).toBe('rlm');
    expect(value.childCalls).toBeGreaterThan(0);
    expect(value.maxDepth).toBe(1);
    expect(retrieveRepository).toHaveBeenCalled();
    expect(value.evidenceCount).toBe(1);
    expect(value.hydratedCount).toBe(1);
    expect(value.promptBlock.match(/### Evidence /gu)).toHaveLength(1);
  });

  it('bounds concurrent deep subquery searches with the existing performance policy', async () => {
    const gates = Array.from({ length: 3 }, () => {
      let resolve!: (value: RepositoryRetrievalResult) => void;
      return {
        promise: new Promise<RepositoryRetrievalResult>((done) => {
          resolve = done;
        }),
        resolve,
      };
    });
    let active = 0;
    let maxActive = 0;
    const retrieveRepository = vi.fn(async () => {
      const index = retrieveRepository.mock.calls.length - 1;
      active += 1;
      maxActive = Math.max(maxActive, active);
      const value = await gates[index]!.promise;
      active -= 1;
      return value;
    });
    const pending = prepareProductionRlmContext(
      {
        accountId: 'account-1',
        projectId: 'project-1',
        question: 'Check the entire project archive and explain the root cause across all files.',
        settings: DEFAULT_CHAT_RUNTIME_SETTINGS,
      },
      dependencies(retrieveRepository),
    );

    try {
      await vi.waitFor(() => expect(retrieveRepository).toHaveBeenCalledTimes(2));
      expect(maxActive).toBe(2);
      gates[1]!.resolve(result('src/second.ts'));
      gates[0]!.resolve(result('src/first.ts'));
      await vi.waitFor(() => expect(retrieveRepository).toHaveBeenCalledTimes(3));
      expect(maxActive).toBe(2);
      gates[2]!.resolve(result('src/third.ts'));

      const value = await pending;
      expect(value.route).toBe('rlm');
      expect(value.childCalls).toBe(3);
      expect(value.evidence.map((item) => item.text)).toEqual([
        expect.stringContaining('src/first.ts'),
        expect.stringContaining('src/second.ts'),
        expect.stringContaining('src/third.ts'),
      ]);
      expect(maxActive).toBe(2);
    } finally {
      for (const gate of gates) gate.resolve(result());
    }
  });

  it('does not launch another deep subquery after concurrent search cancellation', async () => {
    const gates = Array.from({ length: 2 }, () => {
      let resolve!: (value: RepositoryRetrievalResult) => void;
      return {
        promise: new Promise<RepositoryRetrievalResult>((done) => {
          resolve = done;
        }),
        resolve,
      };
    });
    const controller = new AbortController();
    const retrieveRepository = vi.fn(async () => {
      const index = retrieveRepository.mock.calls.length - 1;
      return gates[index]!.promise;
    });
    const pending = prepareProductionRlmContext(
      {
        accountId: 'account-1',
        projectId: 'project-1',
        question: 'Check the entire project archive and explain the root cause across all files.',
        settings: DEFAULT_CHAT_RUNTIME_SETTINGS,
        signal: controller.signal,
      },
      dependencies(retrieveRepository),
    );
    await vi.waitFor(() => expect(retrieveRepository).toHaveBeenCalledTimes(2));

    controller.abort();
    for (const gate of gates) gate.resolve(result());

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(retrieveRepository).toHaveBeenCalledTimes(2);
  });

  it('honors /rlm off without hidden retrieval', async () => {
    const retrieveRepository = vi.fn(async () => result());
    const value = await prepareProductionRlmContext(
      {
        accountId: 'account-1',
        projectId: 'project-1',
        question: 'Search the entire project history.',
        settings: { ...DEFAULT_CHAT_RUNTIME_SETTINGS, rlmEnabled: false },
      },
      dependencies(retrieveRepository),
    );
    expect(value.route).toBe('direct');
    expect(retrieveRepository).not.toHaveBeenCalled();
  });

  it('propagates cancellation before retrieval', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      prepareProductionRlmContext(
        {
          accountId: 'account-1',
          projectId: 'project-1',
          question: 'Search the archive.',
          settings: DEFAULT_CHAT_RUNTIME_SETTINGS,
          signal: controller.signal,
        },
        dependencies(),
      ),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });
});
