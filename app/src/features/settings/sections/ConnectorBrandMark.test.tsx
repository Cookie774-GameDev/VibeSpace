import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ConnectorBrandMark } from './ConnectorBrandMark';

const PROVIDERS = [
  'openai',
  'anthropic',
  'google',
  'github',
  'xai',
  'deepseek',
  'qwen',
  'ollama',
  'opencode',
  'groq',
  'cerebras',
  'fireworks',
  'together',
  'mistral',
  'cohere',
  'perplexity',
  'openrouter',
  'replicate',
  'huggingface',
  'azure',
  'bedrock',
  'hyperbolic',
  'novita',
  'lambda',
  'deepgram',
  'zai',
] as const;

describe('ConnectorBrandMark', () => {
  it.each(PROVIDERS)('renders a local audited brand identity for %s', (providerId) => {
    render(
      <ConnectorBrandMark
        providerId={providerId}
        connectionId={`${providerId}-connection`}
        title={providerId}
      />,
    );

    const mark = screen.getByRole('img', { name: providerId });
    expect(mark.getAttribute('data-brand-status')).toBe('audited');
    expect(mark.getAttribute('data-provider-id')).toBe(providerId);
    expect(mark.querySelector('svg')).toBeTruthy();
  });
});
