/**
 * @file Native HTTP bridge.
 *
 * In a packaged Tauri build the WebView origin is `tauri://localhost`
 * (Windows / Linux) or `tauri.localhost` (macOS), and the browser
 * applies the same CORS rules it would for any other origin. That
 * blocks `fetch('http://localhost:11434/...')` cold — the Ollama
 * daemon is unaware of the WebView and doesn't echo the headers
 * needed to satisfy a preflight, so the chat just silently fails
 * for users running local models.
 *
 * The fix is to route those requests through `tauri-plugin-http`,
 * which proxies them via reqwest in the Rust core. Reqwest doesn't
 * care about origins, so the request lands on Ollama and the
 * response comes back to the WebView through the IPC bridge — same
 * `Response` shape the browser would have produced, no CORS in the
 * way.
 *
 * Why a wrapper module instead of replacing every `fetch` call:
 *
 *   1. The dev build runs at `http://localhost:5173`, where Ollama
 *      *does* honour CORS. We want to keep using browser fetch
 *      there so devtools / the network tab keep working.
 *
 *   2. Cloud providers (OpenAI, Anthropic, Google, Groq) all expose
 *      proper CORS headers, so browser fetch works in both packaged
 *      and dev builds. No reason to take the IPC hop for them.
 *
 *   3. Streaming with the plugin's `fetch` works the same way as
 *      the browser's — the response body is a `ReadableStream<Uint8Array>` —
 *      so the existing SSE parser doesn't need to know which path
 *      the bytes came from.
 *
 * The exported `nativeFetch` resolves to either:
 *   - `@tauri-apps/plugin-http`'s `fetch` when running inside Tauri,
 *   - the global `fetch` otherwise.
 *
 * TIMEOUT: Every request gets a configurable timeout (default 30s).
 * Pass `timeoutMs` in the init options. Any requests that exceed the
 * timeout are aborted and throw.
 */

import { isTauri } from './utils';

type FetchFn = typeof globalThis.fetch;

let cachedTauri: FetchFn | null = null;
let cachePending: Promise<FetchFn> | null = null;

/** Options specific to nativeFetch, extending standard RequestInit. */
export interface NativeFetchInit extends RequestInit {
  /** Timeout in milliseconds. Defaults to 30000 (30s). Set to 0 to disable. */
  timeoutMs?: number;
  /** Allow retrying non-idempotent requests (POST/PUT) on failure. */
  allowRetry?: boolean;
}

/**
 * Resolve to a `fetch` implementation that works regardless of CORS.
 */
export async function getNativeFetch(): Promise<FetchFn> {
  if (!isTauri) {
    return (input, init) => globalThis.fetch(input, init);
  }
  if (cachedTauri) return cachedTauri;
  if (cachePending) return cachePending;

  cachePending = (async () => {
    try {
      const mod = await import('@tauri-apps/plugin-http');
      const f: FetchFn = (input, init) =>
        mod.fetch(input as URL | Request | string, init);
      cachedTauri = f;
      return f;
    } catch (err) {
      console.warn(
        '[tauri/http] plugin-http not available, using browser fetch:',
        err,
      );
      const fallback: FetchFn = (input, init) =>
        globalThis.fetch(input, init);
      cachedTauri = fallback;
      return fallback;
    } finally {
      cachePending = null;
    }
  })();
  return cachePending;
}

/**
 * Convenience wrapper that mirrors the global `fetch` signature and
 * picks the right implementation transparently.
 *
 * Supports a `timeoutMs` option (default 30s). The request is
 * automatically aborted if it doesn't complete within the timeout.
 */
export async function nativeFetch(
  input: RequestInfo | URL,
  init?: NativeFetchInit,
): Promise<Response> {
  const { timeoutMs = 30_000, allowRetry, ...fetchInit } = init ?? {};

  // Combine user-provided signal with our timeout signal
  const controller = new AbortController();
  const existingSignal = fetchInit.signal;

  if (existingSignal) {
    if (existingSignal.aborted) {
      return Promise.reject(new DOMException('Aborted', 'AbortError'));
    }
    existingSignal.addEventListener(
      'abort',
      () => controller.abort((existingSignal as any).reason),
      { once: true },
    );
  }

  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  if (timeoutMs > 0) {
    timeoutId = setTimeout(
      () => controller.abort(new Error(`Request timed out after ${timeoutMs / 1000}s`)),
      timeoutMs,
    );
  }

  try {
    const fn = await getNativeFetch();
    const response = await fn(input, {
      ...fetchInit,
      signal: controller.signal,
    });
    return response;
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
}

/**
 * Fetch with automatic retry on transient failures.
 *
 * Retries up to `maxRetries` times (default 2) on network errors and
 * 5xx responses. Does NOT retry on 4xx, aborts, or timeout (name===AbortError).
 * Uses exponential backoff starting at `retryDelayMs` (default 1000ms).
 *
 * WARNING: Only use for idempotent requests (GET, HEAD, OPTIONS)
 * unless `allowRetry: true` is explicitly set in init.
 */
export interface NativeFetchRetryInit extends NativeFetchInit {
  maxRetries?: number;
  retryDelayMs?: number;
}

export async function nativeFetchWithRetry(
  input: RequestInfo | URL,
  init?: NativeFetchRetryInit,
): Promise<Response> {
  const { maxRetries = 2, retryDelayMs = 1000, ...rest } = init ?? {};
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await nativeFetch(input, rest);
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));

      // Never retry on abort (including timeout)
      if (lastError.name === 'AbortError') throw lastError;

      // Don't retry if we're out of attempts
      if (attempt >= maxRetries) throw lastError;

      // Wait with exponential backoff
      const delay = retryDelayMs * Math.pow(2, attempt);
      await new Promise((r) => setTimeout(r, delay));
    }
  }

  throw lastError!;
}

/**
 * Reset the cached Tauri fetch resolver. Tests use this to swap the
 * implementation between cases; production code never calls it.
 */
export function _resetNativeFetchForTests(impl?: FetchFn | null): void {
  cachedTauri = impl ?? null;
  cachePending = null;
}
