import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Agent } from '@/types';
import type { ProviderEvent } from './adapters/types';
import { useAuthStore } from '@/stores/auth';

const { codexSend } = vi.hoisted(() => ({ codexSend: vi.fn() }));
vi.mock('./adapters/codexPersistent', () => ({
  codexPersistentAdapter: { id: 'codex-app-server', send: codexSend, cancel: vi.fn() },
}));

import { runAgent, type RunAgentRequest } from './router';

const agent: Agent = {
  id: 'learner-test' as Agent['id'],
  slug: 'jarvis-cao',
  name: 'Jarvis CAO',
  description: 'Learning review',
  system_prompt: 'Review supplied evidence.',
  model: { provider: 'openai', model: 'gpt-5.6-terra' },
  tools_allowed: [],
  memory_scope: 'project',
  capabilities: [],
  created_at: 0,
  updated_at: 0,
};
const request: RunAgentRequest = {
  backend: 'codex',
  agent,
  connectionId: 'openai-codex',
  requestId: 'review-1',
  chatId: 'cao-learning:pass-1',
  interactionMode: 'ask',
  accessLevel: 'read-only',
  provider_options: { reasoning_effort: 'high' },
  messages: [{ role: 'user', content: 'Review the observed simulation.' }],
};
const session: ProviderEvent = { type: 'session', sessionId: 'thread-review-1' };
const done: ProviderEvent = { type: 'done', finishReason: 'completed' };
function stream(events: ProviderEvent[], after?: () => void) {
  codexSend.mockImplementationOnce(() =>
    (async function* () {
      for (const event of events) yield event;
      after?.();
    })(),
  );
}

describe('Codex completion evidence for CAO learning', () => {
  beforeEach(() => {
    codexSend.mockReset();
    useAuthStore.setState({ apiKeys: {}, offlineMode: false, plan: 'free' });
  });

  it('issues a receipt only after the validated session finishes, with exact route and usage', async () => {
    const receipt = vi.fn();
    const usage = {
      capturedAt: 100,
      outputTokens: { value: 12, provenance: 'provider-reported' as const },
    };
    stream([session, { type: 'text', delta: 'Evidence review' }, { type: 'usage', usage }, done]);
    await runAgent({ ...request, onProviderCompletionEvidence: receipt });
    expect(receipt).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        requestId: 'review-1',
        sessionId: 'thread-review-1',
        providerId: 'openai',
        connectionId: 'openai-codex',
        modelId: 'gpt-5.6-terra',
        reasoningEffort: 'high',
        finishReason: 'completed',
        usage,
      }),
    );
  });

  it.each([
    [[session], 'provider_completion_terminal_missing'],
    [[done], 'provider_completion_session_missing'],
    [
      [session, { type: 'session', sessionId: 'foreign' }, done],
      'provider_completion_session_mismatch',
    ],
    [[session, { type: 'error', message: 'Provider failed' }], 'Provider failed'],
  ] as const)(
    'withholds receipts from incomplete or invalid streams: %s',
    async (events, error) => {
      const receipt = vi.fn();
      stream([...events]);
      await expect(runAgent({ ...request, onProviderCompletionEvidence: receipt })).rejects.toThrow(
        error,
      );
      expect(receipt).not.toHaveBeenCalled();
    },
  );

  it('withholds a receipt if cancellation arrives as the iterator closes', async () => {
    const controller = new AbortController();
    const receipt = vi.fn();
    stream([session, done], () => controller.abort());
    await expect(
      runAgent({ ...request, signal: controller.signal, onProviderCompletionEvidence: receipt }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(receipt).not.toHaveBeenCalled();
  });

  it.each([
    ['auto', null],
    ['ultra', 'xhigh'],
    ['high', 'high'],
  ] as const)('reports the adapter effective runtime effort %s', async (effort, expected) => {
    const receipt = vi.fn();
    stream([session, done]);
    await runAgent({
      ...request,
      provider_options: undefined,
      runtimeSettings: { effort, fastMode: 'auto', performance: 'quality', rlmEnabled: false },
      onProviderCompletionEvidence: receipt,
    });
    expect(receipt).toHaveBeenCalledWith(expect.objectContaining({ reasoningEffort: expected }));
  });
});
