import { describe, expect, it, vi } from 'vitest';
import { createCodexPersistentAdapter } from './codexPersistent';

function modelListFrame(id: string, data: readonly Record<string, unknown>[], nextCursor: string | null) {
  return { id, result: { data, nextCursor } };
}

describe('Codex persistent model catalog', () => {
  it('discovers authenticated app-server models through model/list and caches the verified page set', async () => {
    const writes: Record<string, unknown>[] = [];
    const starts: Array<Record<string, unknown>> = [];
    const stops: string[] = [];
    let streamCount = 0;
    const dependencies = {
      contextTool: undefined,
      workingDirectory: async (selected: string | undefined) => selected ?? 'C:\\workspace',
      findExecutable: vi.fn(async () => ({ executableId: 'codex.exe' })),
      start: vi.fn(async (...args: unknown[]) => {
        starts.push({ executableId: args[0], ownerId: args[1], modelId: args[2], route: args[3] });
        return { generation: 'catalog-generation' };
      }),
      frames: vi.fn(() => {
        streamCount += 1;
        return {
          ready: Promise.resolve(),
          stream: (async function* () {
            yield { method: 'server/ready', params: {} };
            yield modelListFrame('vibespace-codex-model-catalog_model_1', [
              {
                model: 'gpt-5.6-luna',
                displayName: 'GPT-5.6 Luna',
                supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'high' }],
              },
            ], 'next-page');
            yield modelListFrame('vibespace-codex-model-catalog_model_2', [
              { model: 'gpt-5.6-sol', displayName: 'GPT-5.6 Sol' },
            ], null);
          })(),
        };
      }),
      write: vi.fn(async (_generation: string, message: Record<string, unknown>) => {
        writes.push(message);
      }),
      stop: vi.fn(async (generation: string) => {
        stops.push(generation);
        return true;
      }),
    };

    const adapter = createCodexPersistentAdapter(dependencies);
    const first = await adapter.listModels?.();
    const second = await adapter.listModels?.();

    expect(first).toEqual([
      { id: 'gpt-5.6-luna', label: 'GPT-5.6 Luna', variants: ['low', 'high'] },
      { id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol' },
    ]);
    expect(second).toEqual(first);
    expect(streamCount).toBe(1);
    expect(dependencies.start).toHaveBeenCalledOnce();
    expect(starts[0]).toMatchObject({
      executableId: 'codex.exe',
      ownerId: 'vibespace-codex-model-catalog',
      modelId: 'gpt-5.6-luna',
      route: { kind: 'official-codex', connectionId: 'openai-codex' },
    });
    expect(writes).toEqual([
      expect.objectContaining({
        method: 'model/list',
        params: { limit: 100, includeHidden: true },
      }),
      expect.objectContaining({
        method: 'model/list',
        params: { cursor: 'next-page', limit: 100, includeHidden: true },
      }),
    ]);
    expect(stops).toEqual(['catalog-generation']);
  });

  it('fails closed on a malformed native catalog and releases its discovery generation', async () => {
    const stop = vi.fn(async () => true);
    const adapter = createCodexPersistentAdapter({
      findExecutable: async () => ({ executableId: 'codex.exe' }),
      start: async () => ({ generation: 'malformed-generation' }),
      frames: () => ({
        ready: Promise.resolve(),
        stream: (async function* () {
          yield { method: 'server/ready', params: {} };
          yield modelListFrame('vibespace-codex-model-catalog_model_1', [{ model: 'bad model' }], null);
        })(),
      }),
      write: async () => undefined,
      stop,
    });

    await expect(adapter.listModels?.()).resolves.toEqual([]);
    expect(stop).toHaveBeenCalledWith('malformed-generation');
  });

  it('does not recover or stop a remembered generation before discovery', async () => {
    sessionStorage.setItem('vibespace.codex-native-generation.v1', 'active-turn-generation');
    const stop = vi.fn(async () => true);
    const adapter = createCodexPersistentAdapter({
      findExecutable: async () => ({ executableId: 'codex.exe' }),
      start: async () => ({ generation: 'catalog-generation-2' }),
      frames: () => ({
        ready: Promise.resolve(),
        stream: (async function* () {
          yield { method: 'server/ready', params: {} };
          yield modelListFrame(
            'vibespace-codex-model-catalog_model_1',
            [{ model: 'gpt-5.6-luna', displayName: 'GPT-5.6 Luna' }],
            null,
          );
        })(),
      }),
      write: async () => undefined,
      stop,
    });

    await expect(adapter.listModels?.()).resolves.toEqual([
      { id: 'gpt-5.6-luna', label: 'GPT-5.6 Luna' },
    ]);
    expect(stop).toHaveBeenCalledWith('catalog-generation-2');
    expect(stop).not.toHaveBeenCalledWith('active-turn-generation');
    sessionStorage.removeItem('vibespace.codex-native-generation.v1');
  });

  it('does not cache a failed discovery as an authoritative empty catalog', async () => {
    let attempt = 0;
    const adapter = createCodexPersistentAdapter({
      findExecutable: async () => {
        attempt += 1;
        if (attempt === 1) throw new Error('another native generation is active');
        return { executableId: 'codex.exe' };
      },
      start: async () => ({ generation: 'catalog-generation-3' }),
      frames: () => ({
        ready: Promise.resolve(),
        stream: (async function* () {
          yield { method: 'server/ready', params: {} };
          yield modelListFrame(
            'vibespace-codex-model-catalog_model_1',
            [{ model: 'gpt-5.6-luna', displayName: 'GPT-5.6 Luna' }],
            null,
          );
        })(),
      }),
      write: async () => undefined,
      stop: async () => true,
    });

    await expect(adapter.listModels?.()).resolves.toEqual([]);
    await expect(adapter.listModels?.()).resolves.toEqual([
      { id: 'gpt-5.6-luna', label: 'GPT-5.6 Luna' },
    ]);
    expect(attempt).toBe(2);
  });
});
