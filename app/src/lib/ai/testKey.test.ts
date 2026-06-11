/**
 * @file Tests for the per-provider key validation runner.
 *
 * The runner is deliberately decoupled from the chat provider adapters:
 * it only needs `fetch` to be present and to know which endpoint to
 * probe per provider. We mock `fetch` here to assert on the request
 * shape (URL + headers) and the result classification.
 *
 * What we pin:
 *   - Each implemented provider hits the right validation endpoint with
 *     the right auth header.
 *   - `ok` / `invalid` / `network` / `unconfigured` are classified
 *     correctly, including extracting `error.message` from JSON bodies.
 *   - Providers without real adapters report `unsupported` so the UI
 *     never claims a fake green check.
 *   - Ollama treats the field as a URL, not a secret (empty = default).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { testProviderKey } from '@/lib/ai/testKey';

type FetchMock = ReturnType<typeof vi.fn> & typeof fetch;

const okResponse = (body: unknown = {}) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

const errorResponse = (status: number, body: unknown) =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

let fetchMock: FetchMock;

beforeEach(() => {
  fetchMock = vi.fn() as FetchMock;
  globalThis.fetch = fetchMock;
});

describe('testProviderKey', () => {
  describe('OpenAI', () => {
    it('GETs /v1/models with bearer auth and returns ok on 200', async () => {
      fetchMock.mockResolvedValueOnce(okResponse({ data: [] }));
      const result = await testProviderKey('openai', 'sk-test');
      expect(result.kind).toBe('ok');
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0]!;
      expect(url).toBe('https://api.openai.com/v1/models');
      const headers = new Headers((init as RequestInit).headers);
      expect(headers.get('Authorization')).toBe('Bearer sk-test');
    });

    it('classifies a 401 as invalid and surfaces the API error message', async () => {
      fetchMock.mockResolvedValueOnce(
        errorResponse(401, { error: { message: 'Incorrect API key provided' } }),
      );
      const result = await testProviderKey('openai', 'sk-bogus');
      expect(result.kind).toBe('invalid');
      if (result.kind === 'invalid') {
        expect(result.status).toBe(401);
        expect(result.detail).toBe('Incorrect API key provided');
      }
    });

    it('treats network failures as the network kind', async () => {
      fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'));
      const result = await testProviderKey('openai', 'sk-test');
      expect(result.kind).toBe('network');
    });
  });

  describe('Anthropic', () => {
    it('sends x-api-key + version + browser-access headers', async () => {
      fetchMock.mockResolvedValueOnce(okResponse({ data: [] }));
      const result = await testProviderKey('anthropic', 'sk-ant-xyz');
      expect(result.kind).toBe('ok');
      const [, init] = fetchMock.mock.calls[0]!;
      const headers = new Headers((init as RequestInit).headers);
      expect(headers.get('x-api-key')).toBe('sk-ant-xyz');
      expect(headers.get('anthropic-version')).toBe('2023-06-01');
      expect(headers.get('anthropic-dangerous-direct-browser-access')).toBe('true');
    });

    it('reports invalid with the parsed error message on 401', async () => {
      fetchMock.mockResolvedValueOnce(
        errorResponse(401, { error: { type: 'authentication_error', message: 'invalid x-api-key' } }),
      );
      const result = await testProviderKey('anthropic', 'sk-ant-bad');
      expect(result.kind).toBe('invalid');
      if (result.kind === 'invalid') {
        expect(result.detail).toBe('invalid x-api-key');
      }
    });
  });

  describe('Google', () => {
    it('sends the key via the x-goog-api-key header, never in the URL', async () => {
      fetchMock.mockResolvedValueOnce(okResponse({ models: [] }));
      const result = await testProviderKey('google', 'AIza-test/with+chars');
      expect(result.kind).toBe('ok');
      const [url, init] = fetchMock.mock.calls[0]!;
      expect(url).toBe('https://generativelanguage.googleapis.com/v1beta/models');
      expect(url as string).not.toContain('key=');
      const headers = (init as RequestInit | undefined)?.headers as Record<string, string>;
      expect(headers['x-goog-api-key']).toBe('AIza-test/with+chars');
    });
  });

  describe('Groq', () => {
    it('hits the OpenAI-compatible /openai/v1/models endpoint', async () => {
      fetchMock.mockResolvedValueOnce(okResponse({ data: [] }));
      await testProviderKey('groq', 'gsk_test');
      const [url] = fetchMock.mock.calls[0]!;
      expect(url).toBe('https://api.groq.com/openai/v1/models');
    });
  });

  describe('Ollama', () => {
    it('treats the empty string as "use default localhost"', async () => {
      fetchMock.mockResolvedValueOnce(okResponse({ models: [] }));
      const result = await testProviderKey('ollama', '');
      const [url] = fetchMock.mock.calls[0]!;
      expect(url).toBe('http://localhost:11434/api/tags');
      expect(result.kind).toBe('ok');
    });

    it('strips trailing slashes from a custom base URL', async () => {
      fetchMock.mockResolvedValueOnce(okResponse({ models: [] }));
      await testProviderKey('ollama', 'http://10.0.0.5:11434/');
      const [url] = fetchMock.mock.calls[0]!;
      expect(url).toBe('http://10.0.0.5:11434/api/tags');
    });

    it('reports model count on success', async () => {
      fetchMock.mockResolvedValueOnce(
        okResponse({
          models: [{ name: 'llama3.2' }, { name: 'mistral' }],
        }),
      );
      const result = await testProviderKey('ollama', '');
      expect(result.kind).toBe('ok');
      if (result.kind === 'ok') expect(result.detail).toMatch(/2 models/);
    });

    it('flags responses that are reachable but not Ollama-shaped', async () => {
      // 200 OK but no `models` field — could be a misconfigured proxy.
      fetchMock.mockResolvedValueOnce(okResponse({ status: 'unrelated' }));
      const result = await testProviderKey('ollama', '');
      expect(result.kind).toBe('invalid');
    });

    it('classifies refused connections as network errors', async () => {
      fetchMock.mockRejectedValueOnce(
        Object.assign(new TypeError('fetch failed'), { code: 'ECONNREFUSED' }),
      );
      const result = await testProviderKey('ollama', '');
      expect(result.kind).toBe('network');
    });
  });

  describe('common behaviour', () => {
    it('returns unconfigured for non-Ollama providers when key is blank', async () => {
      const result = await testProviderKey('openai', '   ');
      expect(result.kind).toBe('unconfigured');
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('returns unsupported for adapters without real validation', async () => {
      for (const id of ['xai', 'openrouter', 'deepseek', 'cohere'] as const) {
        const result = await testProviderKey(id, 'something');
        expect(result.kind).toBe('unsupported');
        expect(result.provider).toBe(id);
      }
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });
});
