import { describe, expect, it, vi } from 'vitest';
import { createCouncilExecutor } from './workflowProduction';
import type { CouncilExecution } from './workflow';
import type { RunAgentRequest } from '@/lib/ai/router';

const input: CouncilExecution = {
  requestId: 'run:one',
  accountId: 'account',
  workspaceId: 'workspace',
  projectId: 'project',
  chatId: 'chat',
  route: {
    backend: 'codex',
    connectionId: 'openai-codex',
    providerId: 'openai',
    modelId: 'model-a',
    effort: 'high',
  },
  prompt: 'Compare options',
  instruction: 'Review the evidence',
  context: { mapId: 'map', updatedAt: 1, text: 'Selected evidence', sourceIds: ['source'] },
  signal: new AbortController().signal,
  onText: vi.fn(),
};
const response = {
  text: 'Answer',
  provider: 'openai' as const,
  model: 'model-a',
  usage: { input_tokens: 1, output_tokens: 1, cost_usd: 0 },
};

describe('Council production model adapter', () => {
  it('uses the exact backend and connection, captures authoritative identity and disables mutations', async () => {
    const dispatch = vi.fn(async (req: RunAgentRequest) => {
      req.onProviderCompletionEvidence?.({
        requestId: req.requestId!,
        sessionId: 'native-session',
        providerId: 'openai',
        connectionId: 'openai-codex',
        modelId: 'model-a',
        reasoningEffort: 'high',
        observedAt: 1,
        usage: { capturedAt: 1 },
      });
      return response;
    });
    const result = await createCouncilExecutor(dispatch)(input);
    expect(dispatch.mock.calls[0]![0]).toMatchObject({
      backend: 'codex',
      connectionId: 'openai-codex',
      accessLevel: 'read-only',
      interactionMode: 'ask',
      approveAllForRun: false,
    });
    expect(dispatch.mock.calls[0]![0].messages[1]!.content).toContain('Selected evidence');
    expect(result.receipt).toMatchObject({
      ...input.route,
      sessionId: 'native-session',
      requestId: input.requestId,
    });
  });
  it('rejects a completion without observed identity instead of manufacturing a receipt', async () => {
    await expect(createCouncilExecutor(async () => response)(input)).rejects.toThrow(
      'council_execution_identity_unavailable',
    );
  });
});
