import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { z } from 'zod';
import { RLM_CONTEXT_OPERATIONS } from '@/features/context/rlmOpenCodeTool';
import { CONTEXT_RLM_ADVANCED_TOOLS } from '@/features/context/contextRlmToolDefinitions';
import { parseToolGatewayRequest } from '@/lib/harness/toolGatewayProtocol';
import { toProviderSafeOpenCodeTools } from '@/lib/harness/OpenCodeSdkSessionClient';
import type { ProviderRequest } from '@/lib/ai/adapters/types';
import { createCodexToolGateway } from './codexContextTool';

// Only authority/dependency edges are synthetic. Actual provider definition
// construction, Zod schemas, wire conversion and protocol decoder execute.
vi.mock('@/features/context/rlmPreferenceStore', () => ({ resolveRlmEnabled: () => ({ enabled: true }), recordRlmRoute: vi.fn() }));
vi.mock('@/lib/harness/toolGatewayAuthority', () => ({ captureToolGatewayAuthorityClaim: () => ({
  scope: { accountId: 'account', workspaceId: 'workspace', projectId: 'project' }, generation: 1,
}) }));
vi.mock('@/lib/harness/toolGatewayProduction', () => ({ createProductionToolGatewayDependencies: () => ({}) }));
vi.mock('@/lib/harness/toolGatewayRuntime', () => ({ createToolGatewayRuntime: () => ({
  execute: () => { throw Error('No handler execution is authorized in schema fixture'); },
}) }));
type Definition = { args: Record<string, z.ZodType> };
async function generatedPlugin() {
  const rust = fs.readFileSync(path.resolve(__dirname, '../../../../src-tauri/src/harness/server.rs'), 'utf8');
  const raw = /const TOOL_GATEWAY_PLUGIN: &str = r#"([\s\S]*?)"#;/.exec(rust)?.[1];
  if (!raw) throw Error('Actual generated plugin not found');
  // Exact installed @opencode-ai/plugin/dist/tool.js contract: tool(input)
  // returns input; tool.schema=z. This uses actual Zod rather than a recorder.
  const tool = Object.assign((definition: Definition) => definition, { schema: z });
  const context = vm.createContext({ tool });
  vm.runInContext(raw.replace(/^import \{ tool \} from "@opencode-ai\/plugin"\s*/, '')
    .replace('export const VibeSpaceToolGateway', 'globalThis.VibeSpaceToolGateway'), context);
  const factory = context.VibeSpaceToolGateway as () => Promise<{ tool: Record<string, Definition> }>;
  return (await factory()).tool;
}
const request: ProviderRequest = {
  requestId: 'request-1', accountId: 'account', workspaceId: 'workspace', projectId: 'project', chatId: 'chat',
  prompt: 'Schema fixture only', connection: {
    id: 'openai-codex', adapterId: 'codex-app-server', providerId: 'openai', displayName: 'Synthetic fixture',
    mode: 'external-cli', authSource: 'subscription', enabled: true, promptTransport: 'native-system',
    capabilities: { text: true, images: false, files: false, tools: true, modelSelection: true,
      structuredOutput: false, streaming: true, cancellation: true, resumeSession: true,
      systemPrompt: true, workingDirectory: true, usage: true, subscriptionQuota: true, localOnly: false },
  },
};
const pointer = { id: 'pointer-1', recordId: 'record-1', sourceVersion: 'revision-1', contentHash: 'a'.repeat(64), lineStart: 1, lineEnd: 2 };
const samples: Record<(typeof RLM_CONTEXT_OPERATIONS)[number], Record<string, unknown>> = {
  query: { query: 'fixture' }, describe: {}, search: { query: 'fixture' },
  open: { pointer }, expand: { pointer }, address: { corpusId: 'corpus-1', position: '0' },
  related: { recordId: 'record-1' }, timeline: {}, sources: {}, checkpoint: {},
  investigate: { query: 'fixture' }, trace: { runId: 'run-1' },
};
const malformed: Record<string, Record<string, unknown>> = {
  search: { query: '' }, open: { pointer: { ...pointer, contentHash: 'invalid' } },
  expand: { pointer: 'not-an-issued-pointer' }, address: { corpusId: 'corpus-1', position: 0 },
  trace: { runId: 'a'.repeat(129) },
};
const decode = (tool: string, args: Record<string, unknown>) => parseToolGatewayRequest({
  protocolVersion: 1, requestId: 'request-1', sessionId: 'session-1', messageId: 'message-1',
  tool, args, directory: 'C:\\fixture', worktree: 'C:\\fixture',
});
describe('actual generated schemas, Codex dynamicTools, SDK wire map and decoder', () => {
  it('passes all twelve facade operation fields through both advertised schemas and decoder', async () => {
    const plugin = await generatedPlugin();
    const bridge = await createCodexToolGateway(request);
    expect(bridge).not.toBeNull();
    const facade = bridge!.dynamicTools!.find(t => t.name === 'vibespace_context')!;
    const cx = facade.inputSchema as { properties: Record<string, { enum?: string[] }> };
    const oc = z.object(plugin.vibespace_context.args).strict();
    expect((plugin.vibespace_context.args.operation as z.ZodEnum).options.slice().sort()).toEqual([...RLM_CONTEXT_OPERATIONS].sort());
    expect(cx.properties.operation.enum!.slice().sort()).toEqual([...RLM_CONTEXT_OPERATIONS].sort());
    for (const operation of RLM_CONTEXT_OPERATIONS) {
      const args = { operation, ...samples[operation] };
      const parsed = oc.safeParse(args);
      expect(parsed.success).toBe(true);
      if (parsed.success) expect(parsed.data).toEqual(args);
      for (const key of Object.keys(args)) expect(cx.properties).toHaveProperty(key);
      expect(decode(facade.name, args).args).toEqual(args);
      expect(oc.safeParse({ ...args, projectId: 'foreign' }).success).toBe(false);
      expect(() => decode(facade.name, { ...args, projectId: 'foreign' })).toThrow();
    }
    bridge!.dispose();
  });
  it('joins every dedicated positive and malformed argument route through actual dynamicTools and SDK', async () => {
    const plugin = await generatedPlugin(), bridge = await createCodexToolGateway(request);
    const tools = toProviderSafeOpenCodeTools(Object.fromEntries(bridge!.dynamicTools!.map(t => [t.name, true])));
    for (const definition of CONTEXT_RLM_ADVANCED_TOOLS) {
      const operation = definition.name.slice('vibespace_context_'.length) as keyof typeof samples;
      const actual = bridge!.dynamicTools!.find(t => t.name === definition.name)!;
      expect(actual).toEqual(definition); expect(tools[actual.name]).toBe(true);
      const schema = z.object(plugin[actual.name].args).strict();
      const parsed = schema.safeParse(samples[operation]);
      expect(parsed.success).toBe(true);
      if (parsed.success) expect(parsed.data).toEqual(samples[operation]);
      for (const key of Object.keys(samples[operation])) expect(definition.inputSchema.properties).toHaveProperty(key);
      expect(decode(actual.name, samples[operation]).args).toEqual({ operation, ...samples[operation] });
      expect(schema.safeParse(malformed[operation]).success).toBe(false);
      expect(() => decode(actual.name, malformed[operation])).toThrow();
      expect(() => decode(actual.name, { ...samples[operation], projectId: 'foreign' })).toThrow();
    }
    bridge!.dispose();
  });
  it('keeps actual legacy wire conversion and unsupported operations closed', () => {
    expect(toProviderSafeOpenCodeTools({ 'context.read': true })).toEqual({ context_read: true });
    expect(() => decode('vibespace_context', { operation: 'delete' })).toThrow();
    expect(() => decode('vibespace_context_trace', { runId: '../foreign' })).toThrow();
  });
});
