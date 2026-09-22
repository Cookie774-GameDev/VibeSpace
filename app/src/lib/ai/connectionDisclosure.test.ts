import { beforeEach, describe, expect, it } from 'vitest';
import {
  acknowledgeConnectionRouteDisclosure,
  buildConnectionRouteDisclosure,
  needsConnectionRouteDisclosure,
  resetConnectionRouteDisclosuresForTests,
} from './connectionDisclosure';

const codex = {
  accountId: 'account-a',
  connectionId: 'openai-codex',
  connectionMode: 'external-cli' as const,
  providerId: 'OpenAI',
  modelLabel: 'GPT-5.6 Sol',
};

describe('connection route disclosure', () => {
  beforeEach(resetConnectionRouteDisclosuresForTests);

  it('requires one local disclosure per account and exact billing route', () => {
    expect(needsConnectionRouteDisclosure(codex)).toBe(true);
    acknowledgeConnectionRouteDisclosure(codex);
    expect(needsConnectionRouteDisclosure(codex)).toBe(false);
    expect(
      needsConnectionRouteDisclosure({
        ...codex,
        connectionId: 'openai-api',
        connectionMode: 'native-api',
      }),
    ).toBe(true);
  });

  it('clearly distinguishes subscription allowance from API billing', () => {
    expect(buildConnectionRouteDisclosure(codex)).toContain('not your OpenAI API key');
    expect(buildConnectionRouteDisclosure(codex)).toContain('Codex / ChatGPT subscription');
    expect(
      buildConnectionRouteDisclosure({
        ...codex,
        connectionId: 'zai-coding-plan',
        providerId: 'Z.AI / GLM',
        modelLabel: 'GLM 5.3',
      }),
    ).toContain('Z.AI Coding Plan subscription');
    const managedOpenAi = buildConnectionRouteDisclosure({
      ...codex,
      connectionId: 'opencode-cli',
      providerId: 'opencode',
      modelLabel: 'openai/gpt-5.6-sol',
    });
    expect(managedOpenAi).toContain('OpenCode managed provider connection');
    expect(managedOpenAi).toContain('authentication selected in OpenCode');
    expect(managedOpenAi).not.toContain('ChatGPT subscription');
    expect(managedOpenAi).not.toContain('not your OpenAI API key');
    expect(
      buildConnectionRouteDisclosure({
        ...codex,
        connectionId: 'openai-api',
        connectionMode: 'native-api',
      }),
    ).toContain('may incur provider API charges');
  });
});
