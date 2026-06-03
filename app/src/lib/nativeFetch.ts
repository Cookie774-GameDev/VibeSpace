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
 */

import { isTauri } from './utils';

type FetchFn = typeof globalThis.fetch;

let cachedTauri: FetchFn | null = null;
let cachePending: Promise<FetchFn> | null = null;

/**
 * Resolve to a `fetch` implementation that works regardless of CORS.
 *
 * The first call inside a Tauri build dynamically imports the plugin
 * (so non-Tauri / web bundles never pay the cost). Subsequent calls
 * reuse the cached function. In a non-Tauri environment we delegate
 * to whatever `globalThis.fetch` is at the moment of the call —
 * deliberately not caching so test suites that swap `fetch` per-case
 * see the latest binding.
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
      // The plugin's fetch type is structurally compatible with the
      // global fetch — same `Request` / `Response` semantics — but
      // narrowed to (URL | Request | string). Bind to a thin shim
      // that accepts anything `fetch` would.
      const f: FetchFn = (input, init) =>
        mod.fetch(input as URL | Request | string, init);
      cachedTauri = f;
      return f;
    } catch (err) {
      // If the plugin isn't registered (older build, dev sandbox),
      // fall back to browser fetch instead of crashing the call.
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
 * picks the right implementation transparently. Use this anywhere we
 * call out to `localhost` (Ollama, future local sidecars) — and
 * anywhere a packaged build might be blocked by CORS.
 */
export async function nativeFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const fn = await getNativeFetch();
  return fn(input, init);
}

/**
 * Reset the cached Tauri fetch resolver. Tests use this to swap the
 * implementation between cases; production code never calls it.
 */
export function _resetNativeFetchForTests(impl?: FetchFn | null): void {
  cachedTauri = impl ?? null;
  cachePending = null;
}
