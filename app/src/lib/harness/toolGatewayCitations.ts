import type { JarvisContextItem } from '@/lib/jarvis/contracts';

/**
 * Canonical Context citation registry. Leaf module (no context/gateway
 * imports) so both the tool gateway and the RLM fallback path can register
 * validated citation handles without a circular dependency.
 */

const MAX_CONTEXT_CITATION_RECORDS = 128;
const contextCitationItems = new Map<string, readonly Readonly<JarvisContextItem>[]>();
const SAFE_CITATION_TEXT = /^[^\u0000-\u001f\u007f]{1,1024}$/u;

export function canonicalContextUri(kind: 'receipt' | 'source' | 'evidence', id: string): string {
  const segment =
    kind === 'receipt'
      ? [...new TextEncoder().encode(id)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
      : encodeURIComponent(id);
  return `vibespace:context/${kind}/${segment}`;
}

export function contextCitationItem(input: {
  id: string;
  kind: 'receipt' | 'source' | 'evidence';
  label: string;
  accountId: string;
  projectId: string;
  observedAt: number;
}): Readonly<JarvisContextItem> {
  return Object.freeze({
    source: Object.freeze({
      id: input.id,
      kind: input.kind === 'receipt' ? ('tool_result' as const) : ('context_node' as const),
      label: input.label,
      uri: canonicalContextUri(input.kind, input.id),
      accountId: input.accountId,
      projectId: input.projectId,
      trust: 'app_verified' as const,
      origin: 'app_observed' as const,
      sensitivity: 'private' as const,
      observedAt: input.observedAt,
    }),
    purpose: 'citation' as const,
    excerpt: `${input.label} verified by the VibeSpace Context Gateway.`,
    freshness: 'current' as const,
    truncated: false,
  });
}

export function replaceToolGatewayContextCitationItems(
  sessionId: string,
  items: readonly Readonly<JarvisContextItem>[],
): void {
  contextCitationItems.delete(sessionId);
  while (contextCitationItems.size >= MAX_CONTEXT_CITATION_RECORDS) {
    const oldest = contextCitationItems.keys().next().value as string | undefined;
    if (!oldest) break;
    contextCitationItems.delete(oldest);
  }
  contextCitationItems.set(sessionId, items);
}

export function consumeToolGatewayContextCitationItems(
  sessionId: string,
): readonly Readonly<JarvisContextItem>[] {
  const items = contextCitationItems.get(sessionId) ?? [];
  contextCitationItems.delete(sessionId);
  return Object.freeze(items.map((item) => Object.freeze(structuredClone(item))));
}

export function clearToolGatewayContextCitationItems(): void {
  contextCitationItems.clear();
}

/**
 * Register canonical citation handles for evidence retrieved through the
 * fallback search/open/expand path (which bypasses the investigate receipt).
 * Without this, final-answer spans citing those pointers are stripped as
 * unverified. Only validated pointer/record identifiers are registered; no
 * arbitrary links are accepted.
 */
export function registerToolGatewayFallbackCitations(
  sessionId: string,
  citations: ReadonlyArray<{
    pointerId: string;
    recordId: string;
    sourceRevision: string;
    contentHash: string;
  }>,
  scope: Readonly<{ accountId: string; projectId: string }>,
): void {
  if (citations.length === 0) return;
  if (
    citations.some(
      (citation) =>
        !SAFE_CITATION_TEXT.test(citation.pointerId) ||
        !SAFE_CITATION_TEXT.test(citation.recordId) ||
        !SAFE_CITATION_TEXT.test(citation.sourceRevision) ||
        !SAFE_CITATION_TEXT.test(citation.contentHash),
    )
  ) {
    return;
  }
  const observedAt = Date.now();
  const additions = citations.map((citation) =>
    contextCitationItem({
      id: citation.pointerId,
      kind: 'evidence',
      label: 'Context evidence handle',
      accountId: scope.accountId,
      projectId: scope.projectId,
      observedAt,
    }),
  );
  const existing = contextCitationItems.get(sessionId) ?? [];
  const existingIds = new Set(existing.map((item) => item.source.id));
  const merged = [...existing];
  for (const item of additions) {
    if (existingIds.has(item.source.id)) continue;
    existingIds.add(item.source.id);
    merged.push(item);
  }
  replaceToolGatewayContextCitationItems(sessionId, Object.freeze(merged));
}
