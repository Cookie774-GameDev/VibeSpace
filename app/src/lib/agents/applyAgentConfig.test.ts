import { describe, expect, it } from 'vitest';
import type { Agent, AgentId } from '@/types';
import { NO_BS_PROMPT_SECTION, setNoBsPromptSection } from '@/features/agents/noBs';
import {
  RECOMMENDED_MAX_OUTPUT_TOKENS,
  applyAgentRuntimeConfig,
  applyConfiguredAgentSkills,
  configuredSkillIds,
  isValidMaxOutputTokens,
  resolveMaxOutputTokens,
} from './applyAgentConfig';

const base: Agent = {
  id: 'agent_test' as AgentId,
  slug: 'test',
  name: 'Test',
  description: 'd',
  system_prompt: 'Base prompt.',
  model: { provider: 'mock', model: 'mock-default' },
  tools_allowed: ['files.read'],
  memory_scope: 'project',
  capabilities: ['writing'],
  skills: ['build', 'role:scout'],
  persona: 'friday',
  created_at: 1,
  updated_at: 1,
};

describe('applyAgentConfig', () => {
  it('strips role tags from configured skill ids', () => {
    expect(configuredSkillIds(['build', 'role:scout', ' build ', ''])).toEqual(['build']);
  });

  it('appends skill addenda and unions tools at runtime', () => {
    const next = applyConfiguredAgentSkills(base);
    expect(next.system_prompt).toContain('Base prompt.');
    expect(next.system_prompt).toContain('Skill: Build.');
    expect(next.tools_allowed).toEqual(
      expect.arrayContaining(['files.read', 'files', 'terminal', 'github']),
    );
  });

  it('applies friday persona and skills together', () => {
    const next = applyAgentRuntimeConfig(base);
    expect(next.system_prompt).toMatch(/You are Friday/i);
    expect(next.system_prompt).toContain('Skill: Build.');
  });

  it('keeps the NO BS directive exactly once at the end after persona and skills', () => {
    const next = applyAgentRuntimeConfig({
      ...base,
      system_prompt: setNoBsPromptSection(base.system_prompt, true),
    });

    expect(next.system_prompt.endsWith(NO_BS_PROMPT_SECTION)).toBe(true);
    expect(next.system_prompt.match(/vibespace:no-bs:start/g)).toHaveLength(1);
    expect(next.system_prompt.indexOf('Skill: Build.')).toBeLessThan(
      next.system_prompt.indexOf('## NO BS'),
    );
  });

  it('treats recommended max tokens as 4096 and rejects invalid values', () => {
    expect(resolveMaxOutputTokens(null)).toBe(RECOMMENDED_MAX_OUTPUT_TOKENS);
    expect(isValidMaxOutputTokens(null)).toBe(true);
    expect(isValidMaxOutputTokens(0)).toBe(false);
    expect(isValidMaxOutputTokens(1.5)).toBe(false);
    expect(isValidMaxOutputTokens(2048)).toBe(true);
  });
});
