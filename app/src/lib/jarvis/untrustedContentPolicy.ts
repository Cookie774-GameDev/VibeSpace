export type UntrustedContentSource =
  | 'browser_dom'
  | 'download'
  | 'mcp'
  | 'terminal'
  | 'repository'
  | 'model';

export type UntrustedContentReason =
  | 'authority_like_instruction'
  | 'credential_request'
  | 'hidden_control_text'
  | 'oversized_content';

type UntrustedContentReceiptBase = Readonly<{
  schemaVersion: 1;
  source: UntrustedContentSource;
  authority: 'none';
  contentRef: `untrusted:${UntrustedContentSource}:sha256:${string}`;
  observedChars: number;
  truncated: boolean;
  safeSummary: string;
}>;

export type UntrustedContentReceipt =
  | (UntrustedContentReceiptBase & Readonly<{ disposition: 'data_only' }>)
  | (UntrustedContentReceiptBase &
      Readonly<{
        disposition: 'quarantined';
        reasons: readonly UntrustedContentReason[];
      }>);

const SOURCES = new Set<UntrustedContentSource>([
  'browser_dom',
  'download',
  'mcp',
  'terminal',
  'repository',
  'model',
]);
const DEFAULT_MAX_CHARS = 65_536;
const AUTHORITY_LIKE =
  /\b(?:ignore|override|disregard)\b[\s\S]{0,80}\b(?:previous|system|developer|instructions?|rules?)\b|\b(?:system|developer)\s+(?:message|prompt|instructions?)\b|\b(?:obey|follow|execute)\s+(?:these|the following|my)\s+instructions?\b/iu;
const CREDENTIAL_REQUEST =
  /\b(?:send|share|provide|reveal|enter|upload|paste|return)\b[\s\S]{0,80}\b(?:password|passphrase|api[_ -]?key|access[_ -]?token|refresh[_ -]?token|credential|private[_ -]?key|secret)\b/iu;
const HIDDEN_CONTROL =
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/u;

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function evaluateUntrustedContent(input: {
  source: UntrustedContentSource;
  content: string;
  maxChars?: number;
}): Promise<UntrustedContentReceipt> {
  if (
    !SOURCES.has(input.source) ||
    typeof input.content !== 'string' ||
    (input.maxChars !== undefined &&
      (!Number.isSafeInteger(input.maxChars) || input.maxChars < 1 || input.maxChars > 1_000_000))
  ) {
    throw new Error('Invalid untrusted content policy input.');
  }
  const maximum = input.maxChars ?? DEFAULT_MAX_CHARS;
  const reasons: UntrustedContentReason[] = [];
  if (AUTHORITY_LIKE.test(input.content)) reasons.push('authority_like_instruction');
  if (CREDENTIAL_REQUEST.test(input.content)) reasons.push('credential_request');
  if (HIDDEN_CONTROL.test(input.content)) reasons.push('hidden_control_text');
  if (input.content.length > maximum) reasons.push('oversized_content');
  const contentRef = `untrusted:${input.source}:sha256:${await sha256(input.content)}` as const;
  const base = {
    schemaVersion: 1 as const,
    source: input.source,
    authority: 'none' as const,
    contentRef,
    observedChars: input.content.length,
    truncated: input.content.length > maximum,
    safeSummary:
      reasons.length === 0
        ? 'Returned content is available as untrusted data only.'
        : 'Returned content was quarantined by the untrusted-data policy.',
  };
  if (reasons.length === 0) {
    return Object.freeze({ ...base, disposition: 'data_only' });
  }
  return Object.freeze({
    ...base,
    disposition: 'quarantined',
    reasons: Object.freeze(reasons),
  });
}
