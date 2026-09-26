import type { LLMProvider, LLMRequest, LLMResponse } from '../types';
import { estimateInputTokens, llmContentToText } from '../types';
import { generateFromFoundryArtifact } from '@/features/model-foundry/nativeBridge';
import { canRoutePromotedAdapter } from '@/features/model-foundry/adapterRegistry';
import { isTauri } from '@/lib/utils';

const MODEL_ID = /^([A-Za-z0-9_-]{1,64})--([A-Za-z0-9_-]{1,64})$/;

function parseArtifactModelId(model: string): {
  projectId: string;
  jobId: string;
  nativeArtifact: boolean;
} {
  const match = MODEL_ID.exec(model);
  if (!match) throw new Error('Choose a verified Foundry adapter before sending.');
  return { projectId: match[1]!, jobId: match[2]!, nativeArtifact: match[1] === 'artifact' };
}

function buildMessages(
  req: LLMRequest,
): Array<{ role: 'system' | 'user' | 'assistant'; content: string }> {
  const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [];
  const systemPrompt = req.agent.system_prompt?.trim();
  if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
  for (const message of req.messages.slice(-12)) {
    const content = llmContentToText(message.content);
    if (content.trim()) messages.push({ role: message.role, content });
  }
  return messages;
}

function buildPromptForEstimate(messages: readonly { role: string; content: string }[]): string {
  return [
    ...messages.map((message) => `${message.role.toUpperCase()}: ${message.content}`),
    'ASSISTANT:',
  ].join('\n\n');
}

export const foundryProvider: LLMProvider = {
  id: 'foundry',
  name: 'Build Your Own AI',
  isAvailable: () => isTauri,
  async run(req): Promise<LLMResponse> {
    if (req.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const { projectId, jobId, nativeArtifact } = parseArtifactModelId(req.agent.model.model);
    if (
      !nativeArtifact &&
      (typeof window === 'undefined' ||
        !canRoutePromotedAdapter(window.localStorage, projectId, jobId))
    ) {
      throw new Error(
        'Choose a promoted Foundry adapter that has passed its current local evaluation.',
      );
    }
    const messages = buildMessages(req);
    const prompt = buildPromptForEstimate(messages);
    const response = await generateFromFoundryArtifact({
      projectId,
      jobId,
      prompt,
      messages,
      maxNewTokens: Math.min(512, Math.max(1, req.max_output_tokens ?? 320)),
    });
    if (req.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    req.onChunk?.({ delta: response.text, first: true });
    req.onChunk?.({ delta: '', done: true });
    return {
      text: response.text,
      usage: {
        input_tokens: response.inputTokens || estimateInputTokens(prompt),
        output_tokens: response.outputTokens,
        cost_usd: 0,
      },
      provider: 'foundry',
      model: req.agent.model.model,
      finish_reason: 'stop',
    };
  },
};
