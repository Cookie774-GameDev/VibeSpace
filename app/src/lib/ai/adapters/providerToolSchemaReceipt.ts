import { appActivityLog } from '@/lib/diagnostics/appActivityLog';
import type { ProviderRequest } from './types';

export const RLM_SCHEMA_RECEIPT_NAMES = Object.freeze([
  'vibespace_context_search', 'vibespace_context_open', 'vibespace_context_expand',
  'vibespace_context_address', 'vibespace_context_trace',
] as const);
type Metadata = Readonly<Record<string, string | number | boolean | null | undefined>>;
type Recorder = (kind: string, phase: string, data: Metadata) => unknown;
const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;

/** Bounded canonical JSON: object key order is insignificant; array order is preserved. */
export function canonicalSchema(value: unknown): string {
  let remaining = 4096;
  function visit(item: unknown, depth: number): unknown {
    if (--remaining < 0 || depth > 24) throw new Error('Schema metadata exceeds bounds.');
    if (item === null || typeof item === 'boolean' || typeof item === 'string') return item;
    if (typeof item === 'number' && Number.isFinite(item)) return item;
    if (Array.isArray(item)) return item.map(entry => visit(entry, depth + 1));
    const record = object(item);
    if (!record) throw new Error('Schema is not JSON.');
    return Object.fromEntries(Object.keys(record).sort().map(key => {
      const descriptor = Object.getOwnPropertyDescriptor(record, key);
      if (!descriptor || !('value' in descriptor)) throw new Error('Schema accessor is unsupported.');
      return [key, visit(descriptor.value, depth + 1)];
    }));
  }
  const json = JSON.stringify(visit(value, 0));
  if (json.length > 32768) throw new Error('Schema metadata exceeds bounds.');
  return json;
}
async function hash(value: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

export async function toolReceiptBinding(request: ProviderRequest, generation: string): Promise<Metadata> {
  const attempt = request.protectedAttempt;
  const bound = attempt !== undefined && attempt.requestId === request.requestId && attempt.accountId === request.accountId;
  return {
    requestId: request.requestId, chatId: request.chatId, generation,
    connectionId: request.connection.id, modelId: request.modelId,
    runId: bound ? attempt.runId : undefined,
    accountScopeHash: bound ? await hash(attempt.accountId) : undefined,
    protectedAttemptBound: bound,
    // Product account scope is NOT authenticated provider account identity.
    authenticatedAccountVerified: false,
    effort: request.reasoningEffort ?? request.runtimeSettings?.effort ?? 'provider-default',
    fastVariant: request.runtimeSettings?.fastMode === 'on' ? 'priority' : 'standard',
  };
}

/** Hash only schemas actually present in this sent frame, never a local catalog. */
export async function recordCodexSchemaReceipt(
  binding: Metadata, frame: unknown, phase: 'sent' | 'rpc-accepted', threadId?: string,
  record: Recorder = appActivityLog.recordMetadata,
): Promise<void> {
  try {
    const rpc = object(frame); const params = object(rpc?.params);
    const tools = Array.isArray(params?.dynamicTools) ? params.dynamicTools : [];
    const selected = tools.map(object).filter(tool => tool &&
      RLM_SCHEMA_RECEIPT_NAMES.some(name => name === tool.name));
    const metadata: Record<string, string | number | boolean | null | undefined> = {
      ...binding, harness: 'codex', transportRequestId: typeof rpc?.id === 'string' ? rpc.id : undefined,
      method: typeof rpc?.method === 'string' ? rpc.method : undefined, sessionId: threadId,
      schemaCount: selected.length, schemasObserved: selected.length > 0,
      schemaAcceptanceVerified: false, identityBindingValidated: phase === 'rpc-accepted',
    };
    for (const name of RLM_SCHEMA_RECEIPT_NAMES) {
      const matches = selected.filter(tool => tool?.name === name);
      if (matches.length === 1 && matches[0]?.inputSchema !== undefined)
        metadata[name + '_schemaHash'] = await hash(canonicalSchema(matches[0].inputSchema));
    }
    metadata.completeFiveSchemas = RLM_SCHEMA_RECEIPT_NAMES.every(name =>
      typeof metadata[name + '_schemaHash'] === 'string');
    record('model.tool-schema.codex', phase, metadata);
  } catch { /* Diagnostics never grant authority or fail a provider turn. */ }
}

/** OpenCode prompt transports boolean policy, not parameter schemas. */
export function recordOpenCodeToolPolicyReceipt(
  binding: Metadata, body: unknown, messageId: string, sessionId: string,
  phase: 'dispatch-started' | 'http-accepted', record: Recorder = appActivityLog.recordMetadata,
): void {
  try {
    const payload = object(body);
    const tools = object(payload?.tools);
    const model = object(payload?.model);
    const metadata: Record<string, string | number | boolean | null | undefined> = {
      ...binding, harness: 'opencode', messageId, sessionId,
      schemasObserved: false, schemaAcceptanceVerified: false,
      identityBindingValidated: false,
      providerId: typeof model?.providerID === 'string' ? model.providerID : undefined,
      upstreamModelId: typeof model?.modelID === 'string' ? model.modelID : undefined,
      nativeVariant: typeof payload?.variant === 'string' ? payload.variant : undefined,
      modelControlsObserved: false,
    };
    for (const name of RLM_SCHEMA_RECEIPT_NAMES) metadata[name + '_enabled'] = tools?.[name] === true;
    record('model.tool-policy.opencode', phase, metadata);
  } catch { /* Observational only; server-side schemas require a separate actual receipt. */ }
}
