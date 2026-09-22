import { describe, expect, it, vi } from 'vitest';
import { syntheticCredentialFixture } from '@/test/syntheticCredentialFixture';
import type { LLMResponse } from '@/lib/ai/types';
import type { RunAgentRequest } from '@/lib/ai/router';
import { TOOL_GATEWAY_CATALOG } from '@/lib/harness/toolGatewayProtocol';
import type { ChatImageAttachment } from '@/lib/ai/vision';
import type { PromptForgeJob } from './contracts';
import type { ResolvedPromptForgeModel } from './modelSelection';
import type { PromptPreservationContract } from './preservation';
import type { PromptForgeSourcePack } from './sourcePack';
import { PromptForgeExecutionError, createPromptForgeExecutor } from './promptForgeExecutor';

const requestScope = Object.freeze({
  accountId: 'account-1',
  workspaceId: 'workspace-1',
  projectId: 'project-1',
});
function scopedExecutor(dependencies: Parameters<typeof createPromptForgeExecutor>[0] = {}) {
  return createPromptForgeExecutor({ resolveScope: async () => requestScope, ...dependencies });
}
const job = {
  id: 'forge-job-1',
  accountId: 'account-1',
  chatId: 'chat-1',
  projectId: 'project-1',
  originalDraft: 'Keep "exact words" and use app/src/main.ts.',
  regenerationInstructions: 'Keep the verification section concise.',
  createdAt: 100,
} satisfies Pick<
  PromptForgeJob,
  | 'id'
  | 'originalDraft'
  | 'regenerationInstructions'
  | 'createdAt'
  | 'accountId'
  | 'chatId'
  | 'projectId'
>;

const model: ResolvedPromptForgeModel = Object.freeze({
  providerId: 'openai',
  modelId: 'gpt-5.6-sol',
  label: 'GPT-5.6 Sol',
  connectionId: 'openai-codex',
  connectionMode: 'external-cli',
  effort: 'high',
  local: false,
  billingClass: 'subscription_connection',
});

const nativeVisionModel: ResolvedPromptForgeModel = Object.freeze({
  providerId: 'openai',
  modelId: 'gpt-4o',
  label: 'GPT-4o',
  connectionId: 'openai-api',
  connectionMode: 'native-api',
  local: false,
  billingClass: 'provider_billed',
});

const image: ChatImageAttachment = Object.freeze({
  id: 'image-1',
  name: 'diagram.png',
  mimeType: 'image/png',
  data: 'iVBORw0KGgo=',
  sourcePath: 'C:\\private\\diagram.png',
  size: 8,
});

const sourcePack: PromptForgeSourcePack = Object.freeze({
  markdown: [
    '# Prompt Forge source pack',
    '--- BEGIN UNTRUSTED SOURCE DATA ---',
    'app/src/main.ts exists and owns application bootstrap.',
    '--- END UNTRUSTED SOURCE DATA ---',
  ].join('\n'),
  sources: Object.freeze([]),
  warnings: Object.freeze([]),
  builtAt: 101,
});

const preservation: PromptPreservationContract = Object.freeze({
  schemaVersion: 1,
  originalLength: job.originalDraft.length,
  elements: Object.freeze([
    Object.freeze({ kind: 'quote' as const, value: '"exact words"' }),
    Object.freeze({ kind: 'path' as const, value: 'app/src/main.ts' }),
  ]),
});

function response(text: string): LLMResponse {
  return {
    text,
    usage: { input_tokens: 21, output_tokens: 13, cost_usd: 0 },
    provider: 'openai',
    model: 'gpt-5.6-sol',
    finish_reason: 'stop',
  };
}

describe('Prompt Forge model execution', () => {
  it('runs one tool-free cancellable prompt_forge request through the selected connection', async () => {
    let received: RunAgentRequest | undefined;
    const runModel = vi.fn(async (request: RunAgentRequest) => {
      received = request;
      return response(
        'Objective: Keep "exact words".\n\nRelevant source: app/src/main.ts.\n\nVerification: test it.',
      );
    });
    const controller = new AbortController();
    const chunks: string[] = [];
    const executor = scopedExecutor({
      runModel,
      now: (() => {
        const values = [200, 240];
        return () => values.shift() ?? 240;
      })(),
    });

    const result = await executor.execute({
      job,
      model,
      sourcePack,
      preservation,
      signal: controller.signal,
      workingDirectory: 'C:\\project',
      onChunk: (chunk) => chunks.push(chunk.delta),
    });

    expect(result).toEqual({
      upgradedPrompt:
        'Objective: Keep "exact words".\n\nRelevant source: app/src/main.ts.\n\nVerification: test it.',
      validation: {
        passed: true,
        missing: [],
        preservedCount: 2,
        checkedCount: 2,
      },
      usage: { input_tokens: 21, output_tokens: 13, cost_usd: 0 },
      provider: 'openai',
      model: 'gpt-5.6-sol',
      finishReason: 'stop',
      startedAt: 200,
      completedAt: 240,
    });
    expect(received).toMatchObject({
      purpose: 'prompt_forge',
      ...requestScope,
      connectionId: 'openai-codex',
      requestId: 'prompt-forge:forge-job-1',
      signal: controller.signal,
      workingDirectory: 'C:\\project',
      temperature: 0.2,
      max_output_tokens: 16_384,
      runtimeSettings: {
        effort: 'high',
        fastMode: 'auto',
        performance: 'quality',
        rlmEnabled: true,
      },
      agent: {
        slug: 'prompt-forge',
        model: { provider: 'openai', model: 'gpt-5.6-sol' },
        effort: 'high',
        tools_allowed: [],
        memory_scope: 'project',
      },
    });
    expect(received?.chatId).toBeUndefined();
    expect(received?.agent.effort).toBe('high');
    expect(received?.agent.effort).not.toBe('medium');
    expect(received?.agent.system_prompt).toMatch(/untrusted source data/i);
    expect(received?.agent.system_prompt).toMatch(/Prompt Forge upgrade contract/i);
    expect(received?.agent.system_prompt).toMatch(/opt-in automatic mode upgrades then sends/i);
    expect(received?.agent.system_prompt).toMatch(/Cancellation must stop delivery/i);
    expect(received?.agent.system_prompt).toMatch(
      /instruct the downstream agent to perform the requested task now/i,
    );
    expect(received?.agent.system_prompt).toMatch(
      /never ask the downstream agent to rewrite, improve, or explain the prompt/i,
    );
    expect(received?.messages).toHaveLength(1);
    expect(received?.messages[0]?.content).toContain(job.originalDraft);
    expect(received?.messages[0]?.content).toContain('Additional regeneration instructions');
    expect(received?.messages[0]?.content).toContain(job.regenerationInstructions);
    expect(received?.messages[0]?.content).toContain(sourcePack.markdown);
    expect(received?.messages[0]?.content).toMatch(
      /make the result an executable instruction that tells the downstream agent to perform the original task/i,
    );
    expect(received?.onChunk).toEqual(expect.any(Function));
    expect(Object.keys(received?.tools ?? {})).toEqual(TOOL_GATEWAY_CATALOG);
    expect(Object.values(received?.tools ?? {})).toEqual(TOOL_GATEWAY_CATALOG.map(() => false));
  });

  it('stops before transport when ownership resolution fails or cancellation arrives during the lookup', async () => {
    const runModel = vi.fn(async () => response('must not run'));
    const missing = scopedExecutor({
      runModel,
      resolveScope: async () => {
        throw new Error('scope unavailable');
      },
    });
    await expect(missing.execute({ job, model, sourcePack, preservation })).rejects.toThrow(
      'scope unavailable',
    );
    const controller = new AbortController();
    const cancelled = scopedExecutor({
      runModel,
      resolveScope: async () => {
        controller.abort();
        return requestScope;
      },
    });
    await expect(
      cancelled.execute({ job, model, sourcePack, preservation, signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(runModel).not.toHaveBeenCalled();
  });

  it('returns a failed preservation verdict instead of claiming verification', async () => {
    const executor = scopedExecutor({
      runModel: async () => response('A different result without the protected elements.'),
      now: () => 300,
    });

    const result = await executor.execute({ job, model, sourcePack, preservation });

    expect(result.validation).toMatchObject({
      passed: false,
      preservedCount: 0,
      checkedCount: 2,
    });
    expect(result.validation.missing.map((element) => element.value)).toEqual([
      '"exact words"',
      'app/src/main.ts',
    ]);
  });

  it('sends current Composer images as ordered multimodal parts without persisting path data', async () => {
    let received: RunAgentRequest | undefined;
    const executor = scopedExecutor({
      runModel: async (request) => {
        received = request;
        return { ...response('Keep "exact words" from app/src/main.ts.'), model: 'gpt-4o' };
      },
      now: () => 300,
    });

    await executor.execute({
      job,
      model: nativeVisionModel,
      sourcePack,
      preservation,
      imageAttachments: [image],
    });

    const content = received?.messages[0]?.content;
    expect(Array.isArray(content)).toBe(true);
    expect(content).toEqual([
      { type: 'text', text: expect.stringContaining(job.originalDraft) },
      {
        type: 'image',
        data: 'iVBORw0KGgo=',
        mimeType: 'image/png',
        name: 'diagram.png',
      },
    ]);
    expect(received).toMatchObject({ connectionRequirements: { images: true } });
    expect(JSON.stringify(received)).not.toContain('C:\\');
  });

  it('propagates cancellation and rejects empty or silently substituted output', async () => {
    const controller = new AbortController();
    controller.abort();
    const neverRun = vi.fn(async () => response('must not run'));
    const cancelled = scopedExecutor({ runModel: neverRun, now: () => 400 });
    await expect(
      cancelled.execute({ job, model, sourcePack, preservation, signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(neverRun).not.toHaveBeenCalled();

    const empty = scopedExecutor({
      runModel: async () => response(' \n '),
      now: () => 400,
    });
    await expect(empty.execute({ job, model, sourcePack, preservation })).rejects.toMatchObject({
      code: 'empty_output',
    } satisfies Partial<PromptForgeExecutionError>);

    const substituted = scopedExecutor({
      runModel: async () => ({ ...response('Valid-looking result.'), model: 'other-model' }),
      now: () => 400,
    });
    await expect(
      substituted.execute({ job, model, sourcePack, preservation }),
    ).rejects.toMatchObject({
      code: 'model_mismatch',
    } satisfies Partial<PromptForgeExecutionError>);
  });

  it('rejects secrets in every provider-bound user field before invoking the model', async () => {
    const runModel = vi.fn(async () => response('must not run'));
    const executor = scopedExecutor({ runModel, now: () => 500 });
    const secret = syntheticCredentialFixture('ghp_', 'SyntheticCredentialValue1234567890');

    await expect(
      executor.execute({
        job: { ...job, originalDraft: `Deploy with ${secret}.` },
        model,
        sourcePack,
        preservation,
      }),
    ).rejects.toMatchObject({ code: 'sensitive_input' });
    await expect(
      executor.execute({
        job: { ...job, regenerationInstructions: `Authenticate with ${secret}.` },
        model,
        sourcePack,
        preservation,
      }),
    ).rejects.toMatchObject({ code: 'sensitive_input' });
    expect(runModel).not.toHaveBeenCalled();
  });
});
