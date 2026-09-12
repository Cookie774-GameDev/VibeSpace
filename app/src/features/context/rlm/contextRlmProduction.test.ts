import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_CHAT_RUNTIME_SETTINGS } from '@/features/chat/runtime/chatRuntimeCommandController';
import type { RepositoryRetrievalResult } from '@/features/context/repositoryRetrieval';
import { prepareProductionRlmContext } from './contextRlmProduction';

function result(path = 'src/example.ts'): RepositoryRetrievalResult {
  return {
    mapId: 'map-1',
    repositoryRevision: 'repo-v1',
    structuralRevision: 1,
    items: [
      {
        path,
        language: 'typescript',
        representation: 'full',
        content: 'export const answer = 42;',
        tokens: 8,
        whySelected: ['task_relevance'],
        symbols: [],
        evidence: {
          mapId: 'map-1',
          entityId: 'entity-1',
          sourceId: 'source-1',
          provenanceId: 'provenance-1',
          sourceRevision: 'source-v1',
          repositoryRevision: 'repo-v1',
          contentHash: `sha256:${'a'.repeat(64)}`,
          astHash: `sha256:${'b'.repeat(64)}`,
          parserId: 'tree-sitter',
          parserVersion: '1',
        },
      },
    ],
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
  it('keeps ordinary current-turn work direct with no repository read', async () => {
    const retrieveRepository = vi.fn(async () => result());
    const value = await prepareProductionRlmContext({
      accountId: 'account-1',
      projectId: 'project-1',
      question: 'Rename this local variable.',
      settings: DEFAULT_CHAT_RUNTIME_SETTINGS,
    }, dependencies(retrieveRepository));
    expect(value.route).toBe('direct');
    expect(value.promptBlock).toBe('');
    expect(retrieveRepository).not.toHaveBeenCalled();
  });

  it('uses bounded retrieval and publishes exact visible pointer provenance', async () => {
    const value = await prepareProductionRlmContext({
      accountId: 'account-1',
      projectId: 'project-1',
      question: 'What was the previous decision in the project?',
      settings: DEFAULT_CHAT_RUNTIME_SETTINGS,
    }, dependencies());
    expect(value.route).toBe('retrieval');
    expect(value.evidenceCount).toBe(1);
    expect(value.promptBlock).toContain('Pointer: rlm-run-1-p1');
    expect(value.promptBlock).toContain(`Content hash: sha256:${'a'.repeat(64)}`);
  });

  it('runs a bounded recursive investigation for whole-project root-cause work', async () => {
    const retrieveRepository = vi.fn(async () => result());
    const value = await prepareProductionRlmContext({
      accountId: 'account-1',
      projectId: 'project-1',
      question: 'Check the entire project archive and explain the root cause across all files.',
      settings: DEFAULT_CHAT_RUNTIME_SETTINGS,
    }, dependencies(retrieveRepository));
    expect(value.route).toBe('rlm');
    expect(value.childCalls).toBeGreaterThan(0);
    expect(value.maxDepth).toBe(1);
    expect(retrieveRepository).toHaveBeenCalled();
  });

  it('honors /rlm off without hidden retrieval', async () => {
    const retrieveRepository = vi.fn(async () => result());
    const value = await prepareProductionRlmContext({
      accountId: 'account-1',
      projectId: 'project-1',
      question: 'Search the entire project history.',
      settings: { ...DEFAULT_CHAT_RUNTIME_SETTINGS, rlmEnabled: false },
    }, dependencies(retrieveRepository));
    expect(value.route).toBe('direct');
    expect(retrieveRepository).not.toHaveBeenCalled();
  });

  it('propagates cancellation before retrieval', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(prepareProductionRlmContext({
      accountId: 'account-1',
      projectId: 'project-1',
      question: 'Search the archive.',
      settings: DEFAULT_CHAT_RUNTIME_SETTINGS,
      signal: controller.signal,
    }, dependencies())).rejects.toMatchObject({ name: 'AbortError' });
  });
});
