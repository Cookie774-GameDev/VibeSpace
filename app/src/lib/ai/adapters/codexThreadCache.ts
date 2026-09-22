import type { CodexDynamicTool } from './codexAppServerProtocol';

const SESSION_ID = /^[A-Za-z0-9._:-]{1,256}$/u;
const MAX_CACHE_CHARS = 131_072;
function manifest(tools: readonly CodexDynamicTool[]): string {
  return JSON.stringify([...tools].sort((a, b) => a.name.localeCompare(b.name)));
}

/** Implicit reuse must not inherit an earlier thread's smaller tool inventory.
 * Explicit provider-session resume is deliberately handled by the caller. */
export function encodeCodexThreadCache(
  sessionId: string,
  tools?: readonly CodexDynamicTool[],
): string {
  if (!SESSION_ID.test(sessionId)) throw new TypeError('Invalid Codex session identity.');
  if (!tools) return sessionId;
  const value = JSON.stringify({ version: 2, sessionId, manifest: manifest(tools) });
  if (value.length > MAX_CACHE_CHARS)
    throw new TypeError('Codex thread manifest exceeds cache limit.');
  return value;
}

export function decodeCodexThreadCache(
  value: string | null | undefined,
  tools?: readonly CodexDynamicTool[],
): string | undefined {
  if (!value || value.length > MAX_CACHE_CHARS) return undefined;
  if (!tools) return SESSION_ID.test(value) ? value : undefined;
  try {
    const record: unknown = JSON.parse(value);
    if (!record || typeof record !== 'object' || Array.isArray(record)) return undefined;
    const data = record as Record<string, unknown>;
    return data.version === 2 &&
      typeof data.sessionId === 'string' &&
      SESSION_ID.test(data.sessionId) &&
      data.manifest === manifest(tools)
      ? data.sessionId
      : undefined;
  } catch {
    return undefined;
  }
}
