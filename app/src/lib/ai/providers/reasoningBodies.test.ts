import { describe, expect, it } from 'vitest';
import type { LLMRequest } from '../types';
import { buildAnthropicRequestBody } from './anthropic';
import { buildGoogleRequestBody } from './google';
import { buildGroqRequestBody } from './groq';
import { buildOpenAIRequestBody } from './openai';

function request(provider: string, model: string, providerOptions: Record<string, unknown>) {
  return {
    agent: {
      id: 'reasoning-test',
      slug: 'reasoning-test',
      name: 'Reasoning test',
      description: '',
      system_prompt: 'Be concise.',
      model: { provider, model },
      tools_allowed: [],
      memory_scope: 'workspace',
      temperature: 0.2,
      max_output_tokens: 1024,
    },
    messages: [{ role: 'user', content: 'Hello' }],
    provider_options: providerOptions,
  } as unknown as LLMRequest;
}

describe('provider reasoning request bodies', () => {
  it('serializes the verified OpenAI and Groq wire fields', () => {
    expect(
      buildOpenAIRequestBody(
        request('openai', 'gpt-5.5', { reasoning_effort: 'xhigh', ignored: 'value' }),
      ),
    ).toMatchObject({ model: 'gpt-5.5', reasoning_effort: 'xhigh' });
    expect(
      buildGroqRequestBody(request('groq', 'openai/gpt-oss-20b', { reasoning_effort: 'high' })),
    ).toMatchObject({ model: 'openai/gpt-oss-20b', reasoning_effort: 'high' });
  });

  it('serializes Anthropic effort and Gemini thinking using provider schemas', () => {
    expect(
      buildAnthropicRequestBody(
        request('anthropic', 'claude-opus-4-8', { reasoning_effort: 'max' }),
      ),
    ).toMatchObject({ output_config: { effort: 'max' } });
    expect(
      buildGoogleRequestBody(request('google', 'gemini-3.5-flash', { thinking_level: 'minimal' })),
    ).toMatchObject({
      generationConfig: { thinkingConfig: { thinkingLevel: 'minimal' } },
    });
  });

  it('drops unsupported or forged options instead of forwarding them', () => {
    expect(
      buildOpenAIRequestBody(
        request('openai', 'gpt-4o', { reasoning_effort: 'high', unsafe: 'value' }),
      ),
    ).not.toHaveProperty('reasoning_effort');
    expect(
      buildGoogleRequestBody(request('google', 'gemini-2.5-pro', { thinking_level: 'ultra' }))
        .generationConfig,
    ).not.toHaveProperty('thinkingConfig');
  });
});
