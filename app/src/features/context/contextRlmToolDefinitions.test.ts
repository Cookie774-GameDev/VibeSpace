import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { CONTEXT_RLM_ADVANCED_TOOLS } from '@/features/context/contextRlmToolDefinitions';
import { parseToolGatewayRequest, MUTATING_TOOL_GATEWAY_TOOLS } from '@/lib/harness/toolGatewayProtocol';

const names = CONTEXT_RLM_ADVANCED_TOOLS.map(tool => tool.name);
const pointer = { id: 'ptr', recordId: 'record', sourceVersion: 'rev', contentHash: 'a'.repeat(64), byteStart: 0, byteEnd: 8 };
const fixtures = [
  { query: 'owner', limit: 1 }, { pointer, maxBytes: 256 },
  { pointer, beforeBytes: 10, afterBytes: 20 }, { corpusId: 'mapped-source', position: '0' }, { runId: 'rlm-real-run' },
];
const parse = (tool: string, args: unknown) => parseToolGatewayRequest({
  protocolVersion: 1, requestId: 'request', sessionId: 'session', messageId: 'message', tool, args,
});
describe('five actual read-only gateway capabilities', () => {
  it.each(names.map((name, index) => [name, index] as const))('registers %s with fixed operation and exact arguments', (name, index) => {
    const request = parse(name, fixtures[index]);
    expect(request.tool).toBe(name);
    expect(request.args.operation).toBe(name.slice('vibespace_context_'.length));
    expect(MUTATING_TOOL_GATEWAY_TOOLS.has(request.tool)).toBe(false);
    for (const override of [{ operation: 'checkpoint' }, { accountId: 'other' }, { projectId: 'other' }, { chatId: 'other' }])
      expect(() => parse(name, { ...fixtures[index], ...override })).toThrow();
  });
  it('exposes five separate required-argument schemas and rejects invalid trace/address data', () => {
    expect(new Set(names).size).toBe(5);
    expect(CONTEXT_RLM_ADVANCED_TOOLS.every(tool => tool.inputSchema.additionalProperties === false)).toBe(true);
    expect(() => parse(names[4]!, {})).toThrow();
    expect(() => parse(names[4]!, { runId: 'x'.repeat(129) })).toThrow();
    expect(() => parse(names[3]!, { corpusId: 'mapped-source', position: '01' })).toThrow();
    expect(() => parse(names[3]!, { corpusId: 'mapped-source', position: '10000000000000001' })).toThrow();
  });
  it('the actual staged native plugin dispatches each registered name without renaming its receipt', async () => {
    const source = readFileSync('src-tauri/src/harness/server.rs', 'utf8');
    const callSource = source.slice(source.indexOf('async function call(name, args, context)'), source.indexOf('const define = (name, description, args)'));
    const fetch = vi.fn(async (_url: unknown, _options: { body: string }) => ({ ok: true, text: async () => '{"ok":true}' }));
    const call = runInNewContext(`(${callSource})`, { process: { env: {
      VIBESPACE_TOOL_GATEWAY_URL: 'http://127.0.0.1:4567/v1/tool', VIBESPACE_TOOL_GATEWAY_TOKEN: 'fixture-only',
    } }, URL, TextEncoder, crypto: { randomUUID: () => 'request' }, fetch,
      AbortSignal: { timeout: () => new AbortController().signal, any: (signals: AbortSignal[]) => AbortSignal.any(signals) } });
    for (let index=0; index<names.length; index++) {
      expect(source).toContain(`"${names[index]}": define("${names[index]}"`);
      await call(names[index], fixtures[index], { sessionID: 'session', messageID: 'message', abort: new AbortController().signal, ask: vi.fn() });
      expect(JSON.parse(fetch.mock.calls[index]![1]!.body as string).tool).toBe(names[index]);
    }
  });
});
