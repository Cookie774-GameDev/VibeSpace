import { describe, expect, it, vi } from 'vitest';
import {
  createCouncilWorkflow,
  type CouncilRequest,
  type CouncilRun,
  type CouncilExecution,
} from './workflow';

const route = {
  backend: 'codex' as const,
  providerId: 'openai',
  connectionId: 'openai-codex',
  modelId: 'model-a',
  effort: 'high',
};
const request: CouncilRequest = {
  id: 'run-1',
  accountId: 'account-1',
  workspaceId: 'workspace-1',
  projectId: 'project-1',
  chatId: 'chat-1',
  prompt: 'Compare these options.',
  context: { mapId: 'map-1', updatedAt: 10, text: 'Selected map summary', sourceIds: ['source-1'] },
  perspectives: [
    { id: 'one', name: 'Researcher', instruction: 'Find evidence.', route },
    {
      id: 'two',
      name: 'Critic',
      instruction: 'Check risks.',
      route: { ...route, modelId: 'model-b' },
    },
  ],
  synthesisRoute: route,
};
const success = (input: Pick<CouncilExecution, 'route' | 'requestId'>) => ({
  text: 'Verified answer',
  receipt: { ...input.route, requestId: input.requestId, sessionId: 'session-1' },
});

describe('Council workflow', () => {
  it('captures exact routes/context and persists final synthesis with source receipts', async () => {
    const saved: CouncilRun[] = [];
    const execute = vi.fn(async (input) => success(input));
    const workflow = createCouncilWorkflow({
      save: async (run) => {
        saved.push(structuredClone(run));
      },
      execute,
    });
    const result = await workflow.run(request);
    expect(execute).toHaveBeenCalledTimes(3);
    expect(execute.mock.calls[0]![0].route).toEqual(route);
    expect(execute.mock.calls[1]![0].route.modelId).toBe('model-b');
    expect(execute.mock.calls[0]![0].context).toEqual(request.context);
    expect(result.status).toBe('completed');
    expect(result.synthesis?.sourceRequestIds).toEqual(result.perspectives.map((p) => p.requestId));
    expect(saved.at(-1)).toEqual(result);
    expect(saved.some((run) => run.perspectives.some((p) => p.status === 'running'))).toBe(true);
  });

  it('cancels one perspective without aborting the other or accepting a late answer', async () => {
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const execute = vi.fn(async (input) => {
      if (input.requestId.endsWith(':one')) {
        started();
        await new Promise<void>((resolve) =>
          input.signal.addEventListener('abort', () => resolve(), { once: true }),
        );
      }
      return success(input);
    });
    const workflow = createCouncilWorkflow({ save: async () => {}, execute });
    const pending = workflow.run(request);
    await ready;
    expect(workflow.cancel('run-1', 'one')).toBe(true);
    const result = await pending;
    expect(result.perspectives.map((p) => p.status)).toEqual(['cancelled', 'completed']);
    expect(result.perspectives[0]!.text).toBe('');
    expect(result.status).toBe('partial');
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('fails an unavailable or substituted route without retrying another model', async () => {
    const execute = vi.fn(async (input) => {
      if (input.requestId.endsWith(':one')) throw new Error('route unavailable');
      return { ...success(input), receipt: { ...success(input).receipt, modelId: 'substituted' } };
    });
    const result = await createCouncilWorkflow({ save: async () => {}, execute }).run(request);
    expect(result.perspectives.map((p) => p.status)).toEqual(['failed', 'failed']);
    expect(result.perspectives[1]!.error).toBe('council_route_identity_mismatch');
    expect(result.status).toBe('failed');
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('does not dispatch when durable creation fails', async () => {
    const execute = vi.fn();
    const workflow = createCouncilWorkflow({
      save: async () => {
        throw new Error('disk unavailable');
      },
      execute,
    });
    await expect(workflow.run(request)).rejects.toThrow('disk unavailable');
    expect(execute).not.toHaveBeenCalled();
  });

  it('rejects empty, duplicate, and unbounded participant selections', async () => {
    const execute = vi.fn();
    const workflow = createCouncilWorkflow({ save: async () => {}, execute });
    for (const perspectives of [
      [],
      [request.perspectives[0]!, request.perspectives[0]!],
      Array.from({ length: 9 }, (_, i) => ({ ...request.perspectives[0]!, id: String(i) })),
    ]) {
      await expect(workflow.run({ ...request, perspectives })).rejects.toThrow(
        'council_request_invalid',
      );
    }
    expect(execute).not.toHaveBeenCalled();
  });

  it('recovers an interrupted persisted run without silently reissuing model work', async () => {
    const saved: CouncilRun[] = [];
    const execute = vi.fn(async (input) => success(input));
    const workflow = createCouncilWorkflow({
      save: async (run) => {
        saved.push(structuredClone(run));
      },
      execute,
    });
    await workflow.run(request);
    const interrupted = saved.find((run) => run.perspectives.some((p) => p.status === 'running'))!;
    const fresh = createCouncilWorkflow({ save: async () => {}, execute });
    const recovered = await fresh.recover(interrupted);
    expect(
      recovered.perspectives.every((p) => p.status !== 'running' && p.status !== 'queued'),
    ).toBe(true);
    expect(execute).toHaveBeenCalledTimes(3);
  });
});
