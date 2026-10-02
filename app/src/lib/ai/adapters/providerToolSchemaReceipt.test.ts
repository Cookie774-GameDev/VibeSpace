import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { canonicalSchema, recordCodexSchemaReceipt, recordOpenCodeToolPolicyReceipt, RLM_SCHEMA_RECEIPT_NAMES, toolReceiptBinding } from './providerToolSchemaReceipt';
import type { ProviderRequest } from './types';

type Metadata = Readonly<Record<string, string | number | boolean | null | undefined>>;
const recorder = () => vi.fn((_kind: string, _phase: string, _data: Metadata) => undefined);
const schemas = () => RLM_SCHEMA_RECEIPT_NAMES.map(name => ({
  name, inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
}));
const request: ProviderRequest = {
  requestId: 'jreq_123', accountId: 'synthetic-private-account', chatId: 'synthetic-chat', prompt: 'PRIVATE_PROMPT_NOT_FOR_DIAGNOSTICS',
  protectedAttempt: { requestId: 'jreq_123', accountId: 'synthetic-private-account', runId: 'jrun_123', attemptNumber: 1 },
  modelId: 'openai/gpt-6-luna', reasoningEffort: 'low',
  connection: {
    id: 'openai-codex', adapterId: 'codex-app-server', providerId: 'openai', displayName: 'Codex',
    mode: 'external-cli', authSource: 'codex-cli-session', promptTransport: 'native-system', enabled: true,
    capabilities: { text: true, images: false, files: true, tools: true, modelSelection: true,
      structuredOutput: true, streaming: true, cancellation: true, resumeSession: true, systemPrompt: true,
      workingDirectory: true, usage: true, subscriptionQuota: false, localOnly: false },
  },
};

describe('actual provider schema metadata', () => {
  it('canonicalizes object keys, retains array order and refuses getters/bounds', () => {
    expect(canonicalSchema({ b: 2, a: [1, 2] })).toBe(canonicalSchema({ a: [1, 2], b: 2 }));
    expect(canonicalSchema([1, 2])).not.toBe(canonicalSchema([2, 1]));
    expect(() => canonicalSchema({ get value() { throw new Error('should not invoke'); } })).toThrow('accessor');
    expect(() => canonicalSchema({ value: 'x'.repeat(32769) })).toThrow('bounds');
  });

  it('hashes exactly the five sent schemas without private payload or local catalog additions', async () => {
    const record = recorder(); const binding = await toolReceiptBinding(request, 'native-generation');
    const frame = { id: 'actual-rpc', method: 'thread/start', params: {
      dynamicTools: schemas(), developerInstructions: 'PRIVATE_SYSTEM_NOT_FOR_DIAGNOSTICS',
    } };
    await recordCodexSchemaReceipt(binding, frame, 'sent', undefined, record);
    const [kind, phase, data] = record.mock.calls[0];
    expect(kind).toBe('model.tool-schema.codex'); expect(phase).toBe('sent');
    expect(data.completeFiveSchemas).toBe(true); expect(data.schemaAcceptanceVerified).toBe(false);
    expect(data.identityBindingValidated).toBe(false);
    expect(data.vibespace_context_search_schemaHash).toBe(createHash('sha256').update(canonicalSchema(schemas()[0].inputSchema)).digest('hex'));
    expect(JSON.stringify(data)).not.toMatch(/PRIVATE_|synthetic-private-account|developerInstructions|inputSchema/);
    expect(data.accountScopeHash).toBe(createHash('sha256').update(request.accountId!).digest('hex'));
    expect(data.authenticatedAccountVerified).toBe(false);
  });

  it('RPC acceptance retains bound thread identity but does not claim model-side schema acceptance', async () => {
    const record = recorder();
    await recordCodexSchemaReceipt({ requestId: 'actual-request' }, { id: 'actual-rpc', method: 'thread/start', params: { dynamicTools: schemas() } }, 'rpc-accepted', 'actual-thread', record);
    expect(record.mock.calls[0][2]).toMatchObject({ sessionId: 'actual-thread', identityBindingValidated: true, completeFiveSchemas: true, schemaAcceptanceVerified: false });
  });

  it('resume and duplicate or missing definitions cannot fabricate complete schema proof', async () => {
    const record = recorder();
    await recordCodexSchemaReceipt({}, { id: 'resume', method: 'thread/resume', params: { threadId: 'old-thread' } }, 'sent', undefined, record);
    expect(record.mock.calls[0][2]).toMatchObject({ schemaCount: 0, schemasObserved: false, completeFiveSchemas: false });
    await recordCodexSchemaReceipt({}, { params: { dynamicTools: [...schemas(), schemas()[0]] } }, 'sent', undefined, record);
    expect(record.mock.calls[1][2].completeFiveSchemas).toBe(false);
  });

  it('mismatched protected attempt cannot publish account/run binding', async () => {
    const binding = await toolReceiptBinding({ ...request, requestId: 'another-request' }, 'generation');
    expect(binding.protectedAttemptBound).toBe(false);
    expect(binding.accountScopeHash).toBeUndefined(); expect(binding.runId).toBeUndefined();
  });

  it('OpenCode acknowledgement proves boolean policy only and omits private body', () => {
    const record = recorder();
    recordOpenCodeToolPolicyReceipt({ requestId: 'request' }, { tools: { vibespace_context_search: true }, parts: [{ text: 'PRIVATE_TEXT' }] }, 'message', 'session', 'http-accepted', record);
    expect(record.mock.calls[0][2]).toMatchObject({ schemasObserved: false, schemaAcceptanceVerified: false, vibespace_context_search_enabled: true, vibespace_context_open_enabled: false });
    expect(JSON.stringify(record.mock.calls)).not.toContain('PRIVATE_TEXT');
  });

  it('a recording failure remains observational', async () => {
    const fail = () => { throw new Error('diagnostic unavailable'); };
    await expect(recordCodexSchemaReceipt({}, { params: { dynamicTools: schemas() } }, 'sent', undefined, fail)).resolves.toBeUndefined();
    expect(() => recordOpenCodeToolPolicyReceipt({}, {}, 'message', 'session', 'http-accepted', fail)).not.toThrow();
  });
});
