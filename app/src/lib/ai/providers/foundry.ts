import type { LLMProvider, LLMRequest, LLMResponse } from '../types';
import { estimateInputTokens, llmContentToText } from '../types';
import { generateFromFoundryArtifact } from '@/features/model-foundry/nativeBridge';
import { canRoutePromotedAdapter } from '@/features/model-foundry/adapterRegistry';
import { isTauri } from '@/lib/utils';

const MODEL_ID = /^([A-Za-z0-9_-]{1,64})--([A-Za-z0-9_-]{1,64})$/;

function parseArtifactModelId(model: string): { projectId: string; jobId: string } {
  const match = MODEL_ID.exec(model);
  if (!match) throw new Error('Choose a verified Foundry adapter before sending.');
  return { projectId: match[1]!, jobId: match[2]! };
}

function buildPrompt(req: LLMRequest): string {
  const turns = req.messages.slice(-12).map((message) => `${message.role.toUpperCase()}: ${llmContentToText(message.content)}`);
  return [req.agent.system_prompt?.trim(), ...turns, 'ASSISTANT:'].filter(Boolean).join('\n\n');
}

export const foundryProvider: LLMProvider = {
  id: 'foundry',
  name: 'Build Your Own AI',
  isAvailable: () => isTauri,
  async run(req): Promise<LLMResponse> {
    if (req.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const { projectId, jobId } = parseArtifactModelId(req.agent.model.model);
    if (typeof window === 'undefined' || !canRoutePromotedAdapter(window.localStorage, projectId, jobId)) {
      throw new Error('Choose a promoted Foundry adapter that has passed its current local evaluation.');
    }
    const prompt = buildPrompt(req);
    const response = await generateFromFoundryArtifact({
      projectId,
      jobId,
      prompt,
      maxNewTokens: Math.min(512, Math.max(1, req.max_output_tokens ?? 320)),
    });
    if (req.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    req.onChunk?.({ delta: response.text, first: true });
    req.onChunk?.({ delta: '', done: true });
    return {
      text: response.text,
      usage: { input_tokens: response.inputTokens || estimateInputTokens(prompt), output_tokens: response.outputTokens, cost_usd: 0 },
      provider: 'foundry',
      model: req.agent.model.model,
      finish_reason: 'stop',
    };
  },
};
