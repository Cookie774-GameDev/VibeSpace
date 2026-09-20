import { describe, expect, it, vi } from 'vitest';
import { CODEX_CLI_CONNECTION } from './catalog';
import { createCodexPersistentAdapter } from './codexPersistent';
import { buildCodexThreadPolicyUpdateRequest } from './codexAppServerProtocol';

function fixture(rejectPolicy = false) {
  const write = vi.fn(async (_generation: string, _message: Record<string, unknown>) => undefined);
  const stop = vi.fn(async () => true);
  async function* frames() {
    yield { id: 'policy_1_model_1', result: { data: [{ model: 'gpt-5.6-luna', supportedReasoningEfforts: [], serviceTiers: [] }], nextCursor: null } };
    yield { id: 'policy_1_resume', result: { thread: { id: 'saved_thread' } } };
    yield { id: 'policy_1_policy', ...(rejectPolicy ? { error: { code: -32601, message: 'unsupported' } } : { result: {} }) };
    yield { method: 'turn/started', params: { threadId: 'saved_thread', turn: { id: 'turn_1' } } };
    yield { method: 'turn/completed', params: { threadId: 'saved_thread', turnId: 'turn_1', turn: { id: 'turn_1', status: 'completed' } } };
  }
  return { write, stop, adapter: createCodexPersistentAdapter({
    findExecutable: async () => ({ executableId: 'trusted-codex' }),
    start: async () => ({ generation: 'policy-generation' }),
    frames: () => ({ stream: frames(), ready: Promise.resolve() }),
    write, stop,
  }) };
}

async function run(currentPolicy: string, rejectPolicy = false) {
  const f = fixture(rejectPolicy);
  const consume = async () => {
    for await (const _ of f.adapter.send!({
      requestId: 'policy_1', connection: CODEX_CLI_CONNECTION,
      codexRoute: { kind: 'official-codex', connectionId: 'openai-codex', providerId: 'openai', modelId: 'gpt-5.6-luna' },
      sessionId: 'saved_thread', modelId: 'gpt-5.6-luna',
      workingDirectory: 'C:\\workspace', interactionMode: 'ask',
      prompt: 'Read the requested file.', systemPrompt: currentPolicy,
    })) { /* Exercise the real adapter protocol ordering. */ }
  };
  return { ...f, consume };
}

describe('Codex current-turn policy on resumed sessions', () => {
  it.each(['', '  ', 'unsafe\u0000policy', 'x'.repeat(1_048_577)])('rejects empty, oversized, or control-bearing policy', policy => {
    expect(() => buildCodexThreadPolicyUpdateRequest({ requestId: 'r1', threadId: 't1', developerInstructions: policy })).toThrow('Codex current-turn policy is invalid.');
  });
  it.each([
    'Normal mode: native file tools are available for the current request.',
    'Token Saver: PONYTAIL MODE ACTIVE — level: full',
    'Token Final Boss: maximum supported quality and effort.',
  ])('publishes the current policy before the resumed turn: %s', async policy => {
    const f = await run(policy);
    await f.consume();
    const writes = f.write.mock.calls.map(call => call[1]);
    expect(writes.map(m => m.method)).toEqual(['model/list', 'thread/resume', 'thread/inject_items', 'turn/start']);
    expect(writes[2]).toMatchObject({ params: { threadId: 'saved_thread', items: [{ type: 'message', role: 'developer', content: [{ type: 'input_text', text: expect.stringContaining(policy) }] }] } });
    expect(writes[3]).toMatchObject({ params: { collaborationMode: { settings: { developer_instructions: null } }, sandboxPolicy: { type: 'readOnly', networkAccess: false } } });
    expect(f.stop).toHaveBeenCalledWith('policy-generation');
  });

  it('does not start a turn under stale instructions when policy delivery fails', async () => {
    const f = await run('Current policy', true);
    await expect(f.consume()).rejects.toThrow('Codex current-turn policy update failed.');
    expect(f.write.mock.calls.map(call => (call[1]).method)).not.toContain('turn/start');
    expect(f.stop).toHaveBeenCalledWith('policy-generation');
  });
});
