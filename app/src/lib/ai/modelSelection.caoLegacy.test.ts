import { expect, it } from 'vitest';
import type { Agent } from '@/types';
import { applyChatModelSelectionToAgent } from './modelSelection';
const selection = { mode: 'single', providerId: 'openai', modelId: 'gpt-5.6-terra' } as const;
const coder = {
  id: 'coder',
  slug: 'coder',
  builtin: true,
  model: { provider: 'mock', model: 'mock-default' },
} as Agent;
it('uses the exact captured model for legacy built-in Coder defaults', () => {
  expect(applyChatModelSelectionToAgent(coder, selection).model).toEqual({
    provider: selection.providerId,
    model: selection.modelId,
  });
  expect(coder.model.model).toBe('mock-default');
});
it('preserves custom mock and explicitly pinned built-in agent models', () => {
  for (const agent of [
    { ...coder, builtin: false },
    { ...coder, model: { provider: 'openai', model: 'pinned-model' } },
  ] as Agent[])
    expect(applyChatModelSelectionToAgent(agent, selection)).toBe(agent);
});
