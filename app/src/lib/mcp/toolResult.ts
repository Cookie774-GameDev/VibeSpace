export interface NormalizedMcpSourceRef {
  readonly uri: string;
  readonly name: string;
  readonly title?: string;
  readonly mimeType?: string;
}

export interface NormalizedMcpArtifact {
  readonly kind: 'link';
  readonly uri: string;
  readonly title: string;
  readonly mimeType?: string;
}

export interface NormalizedExternalMcpToolResult {
  readonly ok: boolean;
  readonly contentTrust: 'external_untrusted';
  readonly safeSummary: string;
  readonly textExcerpts: readonly string[];
  readonly sourceRefs: readonly NormalizedMcpSourceRef[];
  readonly artifacts: readonly NormalizedMcpArtifact[];
  readonly suggestedNextActions: readonly string[];
  readonly structuredData?: Readonly<Record<string, unknown>>;
  readonly omitted: Readonly<{
    inlineMedia: number;
    unsafeReferences: number;
    truncatedValues: number;
  }>;
}

const MAX_CONTENT_BLOCKS = 32;
const MAX_TEXT_EXCERPTS = 8;
const MAX_TEXT_EXCERPT_CHARS = 1_000;
const MAX_TEXT_CHARS = 4_000;
const MAX_SOURCE_REFS = 16;
const MAX_SUGGESTED_ACTIONS = 8;
const MAX_ACTION_CHARS = 300;
const MAX_URI_CHARS = 2_048;
const MAX_LABEL_CHARS = 200;
const MAX_MIME_CHARS = 100;
const MAX_VALUE_DEPTH = 6;
const MAX_VALUE_NODES = 128;
const MAX_VALUE_KEYS = 24;
const MAX_VALUE_ARRAY = 24;
const MAX_VALUE_STRING_CHARS = 512;
const REDACTION_GUARD_CHARS = 256;
const UNSAFE_TEXT_CHARACTERS = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
const SAFE_MIME = /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,63}\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,63}$/u;
const SAFE_KEY = /^[A-Za-z_][A-Za-z0-9_.-]{0,79}$/u;
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const SENSITIVE_KEY_PARTS = Object.freeze([
  'apikey',
  'authorization',
  'cookie',
  'credential',
  'passwd',
  'password',
  'privatekey',
  'secret',
  'session',
  'token',
]);

interface CopyState {
  nodes: number;
  truncatedValues: number;
  seen: WeakSet<object>;
}

export interface McpArgumentsAuditWithStats {
  readonly value: Readonly<Record<string, unknown>>;
  readonly truncatedValues: number;
}

function invalidResult(): Error {
  return new Error('Invalid MCP tool result.');
}

export function isSensitiveMcpKey(value: string): boolean {
  const compact = value.toLocaleLowerCase('en-US').replace(/[^a-z0-9]/gu, '');
  return SENSITIVE_KEY_PARTS.some((part) => compact.includes(part));
}

const isSensitiveKey = isSensitiveMcpKey;

function plainRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null
    ? (value as Record<string, unknown>)
    : null;
}

function ownValue(record: Record<string, unknown>, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  if (!descriptor) return undefined;
  if (!('value' in descriptor)) throw invalidResult();
  return descriptor.value;
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): Readonly<T> {
  if (!value || typeof value !== 'object') return value;
  if (seen.has(value)) throw invalidResult();
  seen.add(value);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !('value' in descriptor)) throw invalidResult();
    deepFreeze(descriptor.value, seen);
  }
  seen.delete(value);
  return Object.freeze(value);
}

export function redactMcpText(value: string): string {
  return value
    .replace(
      /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/giu,
      '[REDACTED]',
    )
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/giu, 'Bearer [REDACTED]')
    .replace(/\bsk-(?:proj-)?[A-Za-z0-9_-]{12,}\b/giu, '[REDACTED]')
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/giu, '[REDACTED]')
    .replace(
      /\b(?:password|passwd|api[_-]?key|token|secret)\s*[:=]\s*[^\s,;]+/giu,
      (match) =>
        `${match.slice(0, Math.max(match.indexOf(':'), match.indexOf('=')) + 1)}[REDACTED]`,
    )
    .replace(/([?&](?:authorization|auth|api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|token|password|secret|credential|session(?:[_-]?token)?)=)[^&#\s]+/giu, '$1[REDACTED]')
    .replace(/\b(https?:\/\/)[^/\s:@]+(?::[^/\s@]*)?@/giu, '$1')
    .replace(/\b[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\b/gu, '[REDACTED]');
}

function boundedText(
  value: unknown,
  maxChars: number,
  state: CopyState,
  required = true,
): string | undefined {
  if (value === undefined && !required) return undefined;
  if (typeof value !== 'string') throw invalidResult();
  const inputWasTruncated = value.length > maxChars;
  const trimmed = redactMcpText(value.slice(0, maxChars + REDACTION_GUARD_CHARS)).trim();
  if ((!trimmed && required) || UNSAFE_TEXT_CHARACTERS.test(trimmed)) throw invalidResult();
  if (!inputWasTruncated && trimmed.length <= maxChars) return trimmed;
  state.truncatedValues += 1;
  return `${trimmed.slice(0, Math.max(0, maxChars - 1))}…`;
}

function safeMime(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length > MAX_MIME_CHARS || !SAFE_MIME.test(value)) {
    throw invalidResult();
  }
  return value.toLocaleLowerCase('en-US');
}

function safeExternalUri(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_URI_CHARS) {
    return undefined;
  }
  try {
    const parsed = new URL(value);
    if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password) {
      return undefined;
    }
    let decodedPath: string;
    try {
      decodedPath = decodeURIComponent(parsed.pathname);
    } catch {
      return undefined;
    }
    if (redactMcpText(decodedPath) !== decodedPath) return undefined;
    parsed.hash = '';
    for (const key of [...parsed.searchParams.keys()]) {
      if (isSensitiveKey(key)) {
        parsed.searchParams.delete(key);
        continue;
      }
      const values = parsed.searchParams.getAll(key).map(redactMcpText);
      parsed.searchParams.delete(key);
      for (const entry of values) parsed.searchParams.append(key, entry);
    }
    const normalized = parsed.toString();
    return normalized.length <= MAX_URI_CHARS ? normalized : undefined;
  } catch {
    return undefined;
  }
}

function copySafeValue(
  value: unknown,
  state: CopyState,
  depth = 0,
  omittedRootKeys?: ReadonlySet<string>,
): unknown {
  if (depth > MAX_VALUE_DEPTH) throw invalidResult();
  if (
    value === null ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  ) {
    return value;
  }
  if (typeof value === 'string') {
    const inputWasTruncated = value.length > MAX_VALUE_STRING_CHARS;
    const redacted = redactMcpText(value.slice(0, MAX_VALUE_STRING_CHARS + REDACTION_GUARD_CHARS));
    if (UNSAFE_TEXT_CHARACTERS.test(redacted)) throw invalidResult();
    if (!inputWasTruncated && redacted.length <= MAX_VALUE_STRING_CHARS) return redacted;
    state.truncatedValues += 1;
    return `${redacted.slice(0, MAX_VALUE_STRING_CHARS - 1)}…`;
  }
  if (!value || typeof value !== 'object') throw invalidResult();
  if (state.seen.has(value)) throw invalidResult();
  state.seen.add(value);
  state.nodes += 1;
  if (state.nodes > MAX_VALUE_NODES) throw invalidResult();

  try {
    if (Array.isArray(value)) {
      const limit = Math.min(value.length, MAX_VALUE_ARRAY);
      if (value.length > limit) state.truncatedValues += value.length - limit;
      const output: unknown[] = [];
      for (let index = 0; index < limit; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || !('value' in descriptor)) throw invalidResult();
        output.push(copySafeValue(descriptor.value, state, depth + 1));
      }
      return Object.freeze(output);
    }

    const source = plainRecord(value);
    if (!source) throw invalidResult();
    const keys: string[] = [];
    for (const key in source) {
      if (!Object.hasOwn(source, key)) continue;
      if (keys.length >= MAX_VALUE_KEYS) {
        state.truncatedValues += 1;
        break;
      }
      keys.push(key);
    }
    keys.sort((left, right) => left.localeCompare(right, 'en'));
    const output: Record<string, unknown> = {};
    for (const key of keys) {
      if (depth === 0 && omittedRootKeys?.has(key)) continue;
      if (!SAFE_KEY.test(key) || FORBIDDEN_KEYS.has(key)) throw invalidResult();
      const descriptor = Object.getOwnPropertyDescriptor(source, key);
      if (!descriptor || !('value' in descriptor)) throw invalidResult();
      output[key] = isSensitiveKey(key)
        ? '[REDACTED]'
        : copySafeValue(descriptor.value, state, depth + 1);
    }
    return Object.freeze(output);
  } finally {
    state.seen.delete(value);
  }
}

function sourceReference(
  source: Record<string, unknown>,
  state: CopyState,
): NormalizedMcpSourceRef | undefined {
  const uri = safeExternalUri(ownValue(source, 'uri'));
  if (!uri) return undefined;
  const name = boundedText(ownValue(source, 'name'), MAX_LABEL_CHARS, state);
  const title = boundedText(ownValue(source, 'title'), MAX_LABEL_CHARS, state, false);
  const mimeType = safeMime(ownValue(source, 'mimeType'));
  return deepFreeze({
    uri,
    name: name!,
    ...(title === undefined ? {} : { title }),
    ...(mimeType === undefined ? {} : { mimeType }),
  });
}

function countLabel(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function buildSafeSummary(input: {
  ok: boolean;
  textCount: number;
  sourceCount: number;
  hasStructuredData: boolean;
  inlineMedia: number;
  unsafeReferences: number;
}): string {
  const details: string[] = [];
  if (input.textCount > 0) details.push(countLabel(input.textCount, 'text result'));
  if (input.sourceCount > 0) details.push(countLabel(input.sourceCount, 'source reference'));
  if (input.hasStructuredData) details.push('structured data');
  const prefix = input.ok
    ? 'External MCP tool completed'
    : 'External MCP tool reported an execution error';
  const primary =
    details.length === 0
      ? `${prefix}.`
      : `${prefix} with ${
          details.length === 1
            ? details[0]
            : `${details.slice(0, -1).join(', ')} and ${details.at(-1)}`
        }.`;

  const omitted: string[] = [];
  if (input.inlineMedia > 0) {
    omitted.push(countLabel(input.inlineMedia, 'inline media item'));
  }
  if (input.unsafeReferences > 0) {
    omitted.push(countLabel(input.unsafeReferences, 'unsafe reference'));
  }
  if (omitted.length === 0) return primary;
  return `${primary.slice(0, -1)}; ${
    omitted.length === 1 ? omitted[0] : `${omitted[0]} and ${omitted[1]}`
  } ${input.inlineMedia + input.unsafeReferences === 1 ? 'was' : 'were'} omitted.`;
}

export function normalizeExternalMcpToolResult(value: unknown): NormalizedExternalMcpToolResult {
  const root = plainRecord(value);
  if (!root) throw invalidResult();
  const state: CopyState = {
    nodes: 0,
    truncatedValues: 0,
    seen: new WeakSet(),
  };
  const hasProtocolContent = Object.hasOwn(root, 'content');
  const rawContent = hasProtocolContent ? ownValue(root, 'content') : [];
  if (!Array.isArray(rawContent) || rawContent.length > MAX_CONTENT_BLOCKS) {
    throw invalidResult();
  }
  const rawError = hasProtocolContent ? ownValue(root, 'isError') : undefined;
  if (rawError !== undefined && typeof rawError !== 'boolean') throw invalidResult();
  const rawStructured = hasProtocolContent ? ownValue(root, 'structuredContent') : root;
  if (rawStructured !== undefined && !plainRecord(rawStructured)) throw invalidResult();

  const textExcerpts: string[] = [];
  const sourceRefs: NormalizedMcpSourceRef[] = [];
  const artifacts: NormalizedMcpArtifact[] = [];
  let aggregateTextChars = 0;
  let inlineMedia = 0;
  let unsafeReferences = 0;

  const addText = (rawText: unknown) => {
    if (textExcerpts.length >= MAX_TEXT_EXCERPTS || aggregateTextChars >= MAX_TEXT_CHARS) {
      state.truncatedValues += 1;
      return;
    }
    const remaining = Math.min(MAX_TEXT_EXCERPT_CHARS, MAX_TEXT_CHARS - aggregateTextChars);
    const text = boundedText(rawText, remaining, state);
    textExcerpts.push(text!);
    aggregateTextChars += text!.length;
  };

  for (let index = 0; index < rawContent.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(rawContent, String(index));
    if (!descriptor || !('value' in descriptor)) throw invalidResult();
    const content = plainRecord(descriptor.value);
    if (!content) throw invalidResult();
    const type = ownValue(content, 'type');
    if (type === 'text') {
      addText(ownValue(content, 'text'));
      continue;
    }
    if (type === 'image' || type === 'audio') {
      if (typeof ownValue(content, 'data') !== 'string') throw invalidResult();
      safeMime(ownValue(content, 'mimeType'));
      inlineMedia += 1;
      continue;
    }
    if (type === 'resource_link') {
      const source = sourceReference(content, state);
      if (!source) {
        unsafeReferences += 1;
        continue;
      }
      if (sourceRefs.length >= MAX_SOURCE_REFS) {
        state.truncatedValues += 1;
        continue;
      }
      sourceRefs.push(source);
      artifacts.push(
        deepFreeze({
          kind: 'link' as const,
          uri: source.uri,
          title: source.title ?? source.name,
          ...(source.mimeType === undefined ? {} : { mimeType: source.mimeType }),
        }),
      );
      continue;
    }
    if (type === 'resource') {
      const resource = plainRecord(ownValue(content, 'resource'));
      if (!resource) throw invalidResult();
      const uri = safeExternalUri(ownValue(resource, 'uri'));
      if (!uri) {
        unsafeReferences += 1;
      } else if (sourceRefs.length < MAX_SOURCE_REFS) {
        sourceRefs.push(
          deepFreeze({
            uri,
            name: uri,
            ...(safeMime(ownValue(resource, 'mimeType')) === undefined
              ? {}
              : { mimeType: safeMime(ownValue(resource, 'mimeType')) }),
          }),
        );
      } else {
        state.truncatedValues += 1;
      }
      const text = ownValue(resource, 'text');
      const blob = ownValue(resource, 'blob');
      if (text !== undefined) addText(text);
      else if (blob !== undefined) {
        if (typeof blob !== 'string') throw invalidResult();
        inlineMedia += 1;
      } else {
        throw invalidResult();
      }
      continue;
    }
    throw invalidResult();
  }

  let suggestedNextActions: string[] = [];
  let structuredData: Readonly<Record<string, unknown>> | undefined;
  if (rawStructured !== undefined) {
    const structured = plainRecord(rawStructured)!;
    const rawActions = ownValue(structured, 'suggestedNextActions');
    if (rawActions !== undefined) {
      if (!Array.isArray(rawActions)) throw invalidResult();
      const limit = Math.min(rawActions.length, MAX_SUGGESTED_ACTIONS);
      if (rawActions.length > limit) state.truncatedValues += rawActions.length - limit;
      suggestedNextActions = Array.from({ length: limit }, (_, index) => {
        const descriptor = Object.getOwnPropertyDescriptor(rawActions, String(index));
        if (!descriptor || !('value' in descriptor)) throw invalidResult();
        return boundedText(descriptor.value, MAX_ACTION_CHARS, state)!;
      });
    }
    const copied = copySafeValue(
      structured,
      state,
      0,
      new Set(['suggestedNextActions']),
    ) as Readonly<Record<string, unknown>>;
    if (Object.keys(copied).length > 0) structuredData = copied;
  }

  const ok = rawError !== true;
  const result: NormalizedExternalMcpToolResult = {
    ok,
    contentTrust: 'external_untrusted',
    safeSummary: buildSafeSummary({
      ok,
      textCount: textExcerpts.length,
      sourceCount: sourceRefs.length,
      hasStructuredData: structuredData !== undefined,
      inlineMedia,
      unsafeReferences,
    }),
    textExcerpts: Object.freeze(textExcerpts),
    sourceRefs: Object.freeze(sourceRefs),
    artifacts: Object.freeze(artifacts),
    suggestedNextActions: Object.freeze(suggestedNextActions),
    ...(structuredData === undefined ? {} : { structuredData }),
    omitted: Object.freeze({
      inlineMedia,
      unsafeReferences,
      truncatedValues: state.truncatedValues,
    }),
  };
  return deepFreeze(result);
}

export function redactMcpArgumentsForAuditWithStats(
  value: unknown,
): McpArgumentsAuditWithStats {
  if (!plainRecord(value)) throw new Error('Invalid MCP invocation arguments.');
  const state: CopyState = {
    nodes: 0,
    truncatedValues: 0,
    seen: new WeakSet(),
  };
  const safeValue = deepFreeze(copySafeValue(value, state) as Record<string, unknown>);
  return Object.freeze({ value: safeValue, truncatedValues: state.truncatedValues });
}

export function redactMcpArgumentsForAudit(value: unknown): Readonly<Record<string, unknown>> {
  return redactMcpArgumentsForAuditWithStats(value).value;
}
