import { afterEach, beforeEach, vi } from 'vitest';
import { useAuthStore } from '@/stores/auth';
import { _resetNativeFetchForTests } from '@/lib/nativeFetch';
import { listOllamaModelInfo, pullOllamaModel } from './ollama';

describe('ollama provider utilities', () => {
  beforeEach(() => {
    useAuthStore.setState({
      apiKeys: { ollama: 'http://localhost:11434' },
    });
    _resetNativeFetchForTests(null);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    _resetNativeFetchForTests(null);
  });

  it('lists installed model metadata from /api/tags', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        models: [
          {
            name: 'llama3.2:latest',
            size: 2_013_265_920,
            modified_at: '2026-06-07T10:00:00Z',
          },
        ],
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(listOllamaModelInfo()).resolves.toEqual([
      {
        name: 'llama3.2:latest',
        size: 2_013_265_920,
        modifiedAt: '2026-06-07T10:00:00Z',
      },
    ]);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:11434/api/tags',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('streams pull progress and reports percent complete', async () => {
    const progress: string[] = [];
    const percents: number[] = [];
    // Mock that returns NDJSON for pull AND a model list for verification
    const fetchMock = vi.fn().mockImplementation((url: string, _init?: RequestInit) => {
      if (url.includes('/api/pull')) {
        return Promise.resolve(
          ndjsonResponse([
            { status: 'pulling manifest' },
            { status: 'downloading', completed: 50, total: 100 },
            { status: 'success' },
          ]),
        );
      }
      if (url.includes('/api/tags')) {
        return Promise.resolve(
          jsonResponse({ models: [{ name: 'llama3.2', size: 2_000_000_000 }] }),
        );
      }
      return Promise.resolve(jsonResponse({ models: [] }));
    });
    vi.stubGlobal('fetch', fetchMock);

    await pullOllamaModel('llama3.2', (event) => {
      progress.push(event.status);
      if (event.percent !== undefined) percents.push(event.percent);
    });

    expect(progress).toEqual(['pulling manifest', 'downloading', 'success']);
    expect(percents).toEqual([50]);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:11434/api/pull',
      expect.objectContaining({
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'llama3.2', stream: true }),
      }),
    );
  });

  it('surfaces pull errors from Ollama', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(ndjsonResponse([{ error: 'model not found' }])),
    );

    await expect(pullOllamaModel('missing-model')).rejects.toThrow('model not found');
  });
});

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function ndjsonResponse(lines: unknown[]): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const line of lines) {
          controller.enqueue(encoder.encode(`${JSON.stringify(line)}\n`));
        }
        controller.close();
      },
    }),
    {
      status: 200,
      headers: { 'content-type': 'application/x-ndjson' },
    },
  );
}
