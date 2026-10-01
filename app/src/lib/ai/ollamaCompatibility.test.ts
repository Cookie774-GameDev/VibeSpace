import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  classifyOllamaModel,
  clearOllamaCompatibilityCache,
  type OllamaCompatibilityDependencies,
} from './ollamaCompatibility';

function dependencies(
  overrides: Partial<OllamaCompatibilityDependencies> = {},
): OllamaCompatibilityDependencies {
  return {
    inspect: vi.fn(async () => ({
      digest: 'sha256:model-a',
      capabilities: ['completion', 'tools'],
      contextWindowTokens: 65_536,
    })),
    probeTools: vi.fn(async () => ({ supported: true })),
    storage: window.localStorage,
    ...overrides,
  };
}

describe('Ollama local-agent compatibility', () => {
  beforeEach(() => {
    window.localStorage.clear();
    clearOllamaCompatibilityCache(window.localStorage);
  });

  it.each(['llama3.2', 'qwen3.5:4b', 'gpt-oss:20b'])(
    'classifies tool-capable %s fixtures as agent ready',
    async (model) => {
      const deps = dependencies();

      await expect(classifyOllamaModel(model, deps)).resolves.toEqual(
        expect.objectContaining({
          model,
          digest: 'sha256:model-a',
          status: 'agent_ready',
          contextWindowTokens: 65_536,
        }),
      );
      expect(deps.probeTools).toHaveBeenCalledWith(model);
    },
  );

  it('keeps an unlisted installed model discoverable and classifies it from capabilities', async () => {
    const deps = dependencies({
      inspect: vi.fn(async () => ({
        digest: 'sha256:private',
        capabilities: ['completion'],
        contextWindowTokens: 32_768,
      })),
    });

    await expect(classifyOllamaModel('private/unlisted:latest', deps)).resolves.toEqual(
      expect.objectContaining({
        model: 'private/unlisted:latest',
        status: 'chat_only',
        reason: expect.stringMatching(/tool calling/i),
      }),
    );
    expect(deps.probeTools).not.toHaveBeenCalled();
  });

  it('marks embedding-only models unsupported with a reason', async () => {
    const deps = dependencies({
      inspect: vi.fn(async () => ({
        digest: 'sha256:embed',
        capabilities: ['embedding'],
      })),
    });

    await expect(classifyOllamaModel('nomic-embed-text', deps)).resolves.toEqual(
      expect.objectContaining({
        status: 'unsupported',
        reason: expect.stringMatching(/chat completion/i),
      }),
    );
  });

  it('returns unknown when Ollama or model details are unavailable', async () => {
    const deps = dependencies({
      inspect: vi.fn(async () => null),
    });

    await expect(classifyOllamaModel('missing', deps)).resolves.toEqual(
      expect.objectContaining({
        status: 'unknown',
        reason: expect.stringMatching(/not reachable|details/i),
      }),
    );
  });

  it('uses a digest-keyed cache and reprobes when the installed digest changes', async () => {
    const inspect = vi
      .fn()
      .mockResolvedValueOnce({
        digest: 'sha256:first',
        capabilities: ['completion', 'tools'],
        contextWindowTokens: 65_536,
      })
      .mockResolvedValueOnce({
        digest: 'sha256:first',
        capabilities: ['completion', 'tools'],
        contextWindowTokens: 65_536,
      })
      .mockResolvedValueOnce({
        digest: 'sha256:second',
        capabilities: ['completion', 'tools'],
        contextWindowTokens: 65_536,
      });
    const probeTools = vi.fn(async () => ({ supported: true }));
    const deps = dependencies({ inspect, probeTools });

    expect((await classifyOllamaModel('llama3.2', deps)).cached).toBe(false);
    expect((await classifyOllamaModel('llama3.2', deps)).cached).toBe(true);
    expect((await classifyOllamaModel('llama3.2', deps)).cached).toBe(false);
    expect(probeTools).toHaveBeenCalledTimes(2);
  });

  it('does not claim agent readiness when the safe tool roundtrip fails', async () => {
    const deps = dependencies({
      probeTools: vi.fn(async () => ({
        supported: false,
        reason: 'No tool call was returned.',
      })),
    });

    await expect(classifyOllamaModel('llama3.2', deps)).resolves.toEqual(
      expect.objectContaining({
        status: 'chat_only',
        reason: 'No tool call was returned.',
      }),
    );
  });
});
