import { beforeEach, describe, expect, it, vi } from 'vitest';
import { syncDiscoveredOllamaModels } from './models';
import { getDiscoveredConnectionModels } from './connectionCatalog';
import {
  getModelsForProvider,
  loadProviderModels,
  modelBelongsToProvider,
  MODEL_CATALOG_REFRESH_INTERVAL_MS,
  refreshConnectedProviderModels,
  resetProviderModelCache,
  resolveModelOnProviderChange,
  resolveSelectedModelOrDisable,
  sanitizeModelIdForInput,
  validateProviderModelSelection,
} from './providerModelCatalog';

const ctx = {
  apiKeys: { google: 'test-key', groq: 'gsk_test' },
  offlineMode: false,
  plan: 'free' as const,
  defaultLocalModel: '',
};

describe('providerModelCatalog', () => {
  beforeEach(() => {
    resetProviderModelCache();
    syncDiscoveredOllamaModels([]);
  });

  it('sanitizes manual model ids', () => {
    expect(sanitizeModelIdForInput('  gemini-3.5-flash \n')).toBe('gemini-3.5-flash');
  });

  it('does not expose Gemini fallback rows before live discovery', () => {
    const models = getModelsForProvider('google', ctx);
    expect(models).toEqual([]);
  });

  it('does not expose static OpenAI entries before an authenticated catalog exists', () => {
    const openai = getModelsForProvider('openai', {
      ...ctx,
      apiKeys: { openai: 'test-key' },
    });
    expect(openai).toEqual([]);
  });

  it('discovers the Qwen models from the authenticated region endpoint only', async () => {
    const { setActiveQwenCompatibleBaseUrlForTests } = await import('./nativeConnectionProbe');
    setActiveQwenCompatibleBaseUrlForTests(
      'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
    );
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          data: [
            { id: 'qwen3.7-plus' },
            { id: 'qwen3-coder-next' },
            { id: 'qwen3.5-omni-plus' },
            { id: 'qwen-image-3.0-pro' },
            { id: 'qwen-audio-3.0-asr-flash' },
            { id: 'qwen3.5-livetranslate-flash-realtime' },
            { id: 'qwen3.5-omni-plus-realtime' },
          ],
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      ),
    );
    const qwenCtx = { ...ctx, apiKeys: { qwen: 'qwen-test-key' } };

    const models = await loadProviderModels('qwen', qwenCtx, { force: true });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://dashscope-intl.aliyuncs.com/compatible-mode/v1/models',
      expect.objectContaining({
        headers: { Authorization: 'Bearer qwen-test-key' },
      }),
    );
    expect(models.map((model) => model.id)).toEqual(
      expect.arrayContaining(['qwen3.7-plus', 'qwen3-coder-next', 'qwen3.5-omni-plus']),
    );
    expect(models.map((model) => model.id)).not.toEqual(
      expect.arrayContaining([
        'qwen-image-3.0-pro',
        'qwen-audio-3.0-asr-flash',
        'qwen3.5-livetranslate-flash-realtime',
        'qwen3.5-omni-plus-realtime',
      ]),
    );
    fetchMock.mockRestore();
    setActiveQwenCompatibleBaseUrlForTests(undefined);
  });

  it('keeps Gemini model discovery on the chat transport', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          models: [
            {
              name: 'models/gemini-3.7-flash',
              displayName: 'Gemini 3.7 Flash',
              supportedGenerationMethods: ['generateContent'],
            },
            {
              name: 'models/deep-research-max-preview-04-2026',
              displayName: 'Deep Research Max Preview',
              supportedGenerationMethods: ['interactions.create'],
            },
            {
              name: 'models/gemini-3-pro-image',
              displayName: 'Gemini 3 Pro Image',
              supportedGenerationMethods: ['generateContent'],
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );

    const models = await loadProviderModels(
      'google',
      { ...ctx, apiKeys: { google: 'google-key' } },
      { force: true },
    );

    expect(models.map((model) => model.id)).toEqual(['gemini-3.7-flash']);
    fetchMock.mockRestore();
  });

  it('refreshes every OpenAI-compatible chat catalog and excludes non-chat models', async () => {
    const endpoints = {
      deepseek: 'https://api.deepseek.com/models',
      mistral: 'https://api.mistral.ai/v1/models',
      together: 'https://api.together.xyz/models',
      xai: 'https://api.x.ai/v1/language-models',
    } as const;
    const fetchMock = vi.spyOn(globalThis, 'fetch');

    for (const [provider, endpoint] of Object.entries(endpoints)) {
      fetchMock.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: [
              { id: `${provider}-chat`, type: 'chat' },
              { id: `${provider}-image`, type: 'image' },
              { id: `${provider}-translation`, type: 'language' },
              { id: `${provider}-deep-research-preview`, type: 'language' },
              { id: `${provider}-agent-endpoint`, type: 'language' },
              { id: `${provider}-computer-use-preview`, type: 'language' },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      );
      const models = await loadProviderModels(
        provider as keyof typeof endpoints,
        {
          ...ctx,
          apiKeys: { [provider]: `${provider}-key` },
        },
        { force: true },
      );

      expect(fetchMock).toHaveBeenLastCalledWith(
        endpoint,
        expect.objectContaining({
          headers: { Authorization: `Bearer ${provider}-key` },
        }),
      );
      expect(models.some((model) => model.id === `${provider}-chat`)).toBe(true);
      expect(models.some((model) => model.id === `${provider}-image`)).toBe(false);
      expect(models.some((model) => model.id === `${provider}-translation`)).toBe(false);
      expect(models.some((model) => model.id === `${provider}-deep-research-preview`)).toBe(false);
      expect(models.some((model) => model.id === `${provider}-agent-endpoint`)).toBe(false);
      expect(models.some((model) => model.id === `${provider}-computer-use-preview`)).toBe(false);
    }
    fetchMock.mockRestore();
  });

  it('keeps OpenRouter text-and-image output capability and free-price metadata account scoped', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          data: [
            {
              id: 'google/gemini-image-chat',
              architecture: { output_modalities: ['text', 'image'] },
              pricing: { prompt: '0.000001', completion: '0.000002', image: '0', request: '0' },
            },
            {
              id: 'provider/image-only',
              architecture: { output_modalities: ['image'] },
              pricing: { prompt: '0', completion: '0', image: '0', request: '0' },
            },
            {
              id: 'provider/image-metadata-missing',
              architecture: { input_modalities: ['image'], output_modalities: ['text'] },
              pricing: { prompt: '0', completion: '0', image: '0', request: '0' },
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );

    const models = await loadProviderModels(
      'openrouter',
      { ...ctx, apiKeys: { openrouter: 'openrouter-key' } },
      { force: true },
    );

    expect(fetchMock).toHaveBeenCalledWith(
      'https://openrouter.ai/api/v1/models/user',
      expect.objectContaining({
        headers: { Authorization: 'Bearer openrouter-key' },
      }),
    );
    expect(models).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'google/gemini-image-chat',
          supportsImageOutput: true,
          isImageOutputFree: false,
        }),
      ]),
    );
    expect(models.map((model) => model.id)).not.toEqual(
      expect.arrayContaining(['provider/image-only', 'provider/image-metadata-missing']),
    );
    fetchMock.mockRestore();
  });

  it('keeps a verified free image-output model in the bounded OpenRouter picker', async () => {
    const rows = Array.from({ length: 40 }, (_, index) => ({ id: `provider/chat-model-${index}` }));
    rows.push({
      id: 'google/gemini-free-image-chat',
      architecture: { output_modalities: ['text', 'image'] },
      pricing: { prompt: '0', completion: '0', image: '0', request: '0' },
    } as typeof rows[number]);
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ data: rows }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    const models = await loadProviderModels(
      'openrouter',
      { ...ctx, apiKeys: { openrouter: 'openrouter-key' } },
      { force: true },
    );

    expect(models).toHaveLength(40);
    expect(models[0]).toMatchObject({
      id: 'google/gemini-free-image-chat',
      supportsImageOutput: true,
      isImageOutputFree: true,
    });
    expect(models.some((model) => model.id === 'provider/chat-model-39')).toBe(false);
    fetchMock.mockRestore();
  });

  it('clears mismatched model when provider changes', () => {
    const next = resolveModelOnProviderChange('groq', 'gemini-3.5-flash', ctx);
    expect(modelBelongsToProvider('groq', next)).toBe(true);
    expect(next).not.toBe('gemini-3.5-flash');
  });

  it('does not silently substitute a disappeared model on the same provider', () => {
    const result = resolveSelectedModelOrDisable('google', 'gemini-2.0-flash', ctx);
    expect(result).toEqual({
      status: 'missing',
      modelId: 'gemini-2.0-flash',
      error: 'gemini-2.0-flash is no longer available for Gemini. Choose another model.',
    });
  });

  it('retains only a previously verified catalog when a refresh fails', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            models: [
              {
                name: 'models/gemini-live',
                supportedGenerationMethods: ['generateContent'],
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      )
      .mockRejectedValueOnce(new Error('network unavailable'));
    const live = await loadProviderModels('google', ctx, { force: true });
    expect(live.map((model) => model.id)).toEqual(['gemini-live']);

    const refreshed = await loadProviderModels('google', ctx, { force: true });
    expect(refreshed.map((model) => model.id)).toEqual(['gemini-live']);
    fetchMock.mockRestore();
  });

  it('refreshes only connected BYOK catalogs with a five-minute no-inference list pass', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ models: [{ name: 'models/gemini-3.7-flash' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: [{ id: 'deepseek-v4-flash', type: 'chat' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );

    const report = await refreshConnectedProviderModels({
      ...ctx,
      apiKeys: { google: 'google-key', deepseek: 'deepseek-key', mock: 'demo-only' },
    });

    expect(MODEL_CATALOG_REFRESH_INTERVAL_MS).toBe(5 * 60 * 1000);
    expect(report).toEqual([
      { providerId: 'google', status: 'refreshed' },
      { providerId: 'deepseek', status: 'refreshed' },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(getModelsForProvider('google', { ...ctx, apiKeys: { google: 'google-key' } })).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'gemini-3.7-flash' })]),
    );
    expect(
      getModelsForProvider('deepseek', { ...ctx, apiKeys: { deepseek: 'deepseek-key' } }),
    ).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'deepseek-v4-flash' })]));
    fetchMock.mockRestore();
  });

  it('retires a removed upstream ID instead of silently replacing the selected model', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: [{ id: 'deepseek-v4-flash', type: 'chat' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: [{ id: 'deepseek-v4-vision-exp', type: 'chat' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    const deepseekCtx = { ...ctx, apiKeys: { deepseek: 'deepseek-key' } };

    await loadProviderModels('deepseek', deepseekCtx, { force: true });
    expect(resolveSelectedModelOrDisable('deepseek', 'deepseek-v4-flash', deepseekCtx)).toEqual({
      status: 'available',
      modelId: 'deepseek-v4-flash',
    });

    await loadProviderModels('deepseek', deepseekCtx, { force: true });

    expect(resolveSelectedModelOrDisable('deepseek', 'deepseek-v4-flash', deepseekCtx)).toEqual({
      status: 'missing',
      modelId: 'deepseek-v4-flash',
      error: 'deepseek-v4-flash is no longer available for DeepSeek. Choose another model.',
    });
    expect(getModelsForProvider('deepseek', deepseekCtx).map((model) => model.id)).toEqual([
      'deepseek-v4-vision-exp',
    ]);
    expect(getDiscoveredConnectionModels('deepseek-api').map((model) => model.id)).toEqual([
      'deepseek-v4-vision-exp',
    ]);
    fetchMock.mockRestore();
  });

  it('does not show a previous account catalog after the provider key changes', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: [{ id: 'deepseek-v4-flash', type: 'chat' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: [{ id: 'deepseek-v4-vision-exp', type: 'chat' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    const firstAccount = { ...ctx, apiKeys: { deepseek: 'first-key' } };
    const secondAccount = { ...ctx, apiKeys: { deepseek: 'second-key' } };

    await loadProviderModels('deepseek', firstAccount, { force: true });
    expect(getModelsForProvider('deepseek', secondAccount)).toEqual([]);
    await loadProviderModels('deepseek', secondAccount);
    expect(getModelsForProvider('deepseek', secondAccount).map((model) => model.id)).toEqual([
      'deepseek-v4-vision-exp',
    ]);
    fetchMock.mockRestore();
  });

  it.each(['old-first', 'new-first'] as const)('isolates reconnect discovery from an old account still in flight (%s)', async (order) => {
    let finishOld!: (response: Response) => void;
    let finishNew!: (response: Response) => void;
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockImplementationOnce(() => new Promise<Response>((resolve) => { finishOld = resolve; }))
      .mockImplementationOnce(() => new Promise<Response>((resolve) => { finishNew = resolve; }));
    const oldAccount = { ...ctx, apiKeys: { deepseek: 'old-test-key' } };
    const newAccount = { ...ctx, apiKeys: { deepseek: 'new-test-key' } };
    const oldLoad = loadProviderModels('deepseek', oldAccount, { force: true });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const newLoad = loadProviderModels('deepseek', newAccount, { force: true });
    const response = (id: string) => new Response(JSON.stringify({ data: [{ id, type: 'chat' }] }), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
    try {
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2), { timeout: 500 });
      if (order === 'old-first') {
        finishOld(response('deepseek-old-account'));
        expect(await oldLoad).toEqual([]);
        // A late old-account completion must not remove the new fetch's dedupe slot.
        const duplicate = loadProviderModels('deepseek', newAccount, { force: true });
        finishNew(response('deepseek-new-account'));
        expect((await duplicate).map((model) => model.id)).toEqual(['deepseek-new-account']);
        expect(fetchMock).toHaveBeenCalledTimes(2);
      }
      finishNew(response('deepseek-new-account'));
      expect((await newLoad).map((model) => model.id)).toEqual(['deepseek-new-account']);
      finishOld(response('deepseek-old-account'));
      expect(await oldLoad).toEqual([]);
      expect(getModelsForProvider('deepseek', newAccount).map((model) => model.id)).toEqual(['deepseek-new-account']);
      expect(getDiscoveredConnectionModels('deepseek-api').map((model) => model.id)).toEqual(['deepseek-new-account']);
    } finally {
      // Always settle the mocked fetches, including when the initial race assertion fails.
      finishOld(response('deepseek-old-account'));
      finishNew?.(response('deepseek-new-account'));
      await Promise.all([oldLoad, newLoad]);
      fetchMock.mockRestore();
    }
  });

  it('invalidates pending discovery on disconnect and deduplicates same-account reads', async () => {
    let finish!: (response: Response) => void;
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockImplementationOnce(() => new Promise<Response>((resolve) => { finish = resolve; }));
    const account = { ...ctx, apiKeys: { deepseek: 'disconnect-test-key' } };
    const first = loadProviderModels('deepseek', account, { force: true });
    const duplicate = loadProviderModels('deepseek', account, { force: true });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    try {
      expect(await loadProviderModels('deepseek', { ...ctx, apiKeys: {} })).toEqual([]);
      finish(new Response(JSON.stringify({ data: [{ id: 'deepseek-disconnected', type: 'chat' }] }), {
        status: 200, headers: { 'content-type': 'application/json' },
      }));
      expect(await first).toEqual([]);
      expect(await duplicate).toEqual([]);
      expect(getModelsForProvider('deepseek', account)).toEqual([]);
      expect(getDiscoveredConnectionModels('deepseek-api')).toEqual([]);
    } finally {
      finish(new Response('{}', { status: 200 }));
      await Promise.all([first, duplicate]);
      fetchMock.mockRestore();
    }
  });

  it('does not mark unverified static picker rows as provider models', () => {
    const models = getModelsForProvider('google', ctx);
    expect(models).toEqual([]);
  });

  it('does not expose unknown saved models as dropdown options', () => {
    const models = getModelsForProvider('google', ctx, 'my-old-custom-model');
    expect(models.some((model) => model.id === 'my-old-custom-model')).toBe(false);
  });

  it('blocks provider/model mismatch validation', () => {
    const result = validateProviderModelSelection('groq', 'gemini-3.5-flash', ctx);
    expect(result.ok).toBe(false);
  });

  it('rejects custom model ids even when a legacy caller asks for custom allowance', () => {
    const result = validateProviderModelSelection('google', 'totally-custom-id', ctx, {
      allowCustom: true,
    });
    expect(result.ok).toBe(false);
  });
});
