/**
 * Apply agent-configured persona + skills at runtime.
 *
 * Skills assigned on an agent are not decorative: their system-prompt
 * addenda and tool grants must ride with the agent on every turn.
 * Role tags (`role:scout` etc.) are UI/pipeline markers and are skipped.
 */
import type { Agent, AgentPersona, PersonaPreset } from '@/types';
import { applyPersona } from '@/features/agents/personas';
import {
  composeCatalogSkillAddenda,
  resolveCatalogSkills,
  unionCatalogSkillTools,
} from '@/features/skills/skillCatalog';
import { hasNoBsPromptSection, setNoBsPromptSection } from '@/features/agents/noBs';

/** Recommended default when the agent does not set an explicit max. */
export const RECOMMENDED_MAX_OUTPUT_TOKENS = 4096;

const ROLE_SKILL_PREFIX = 'role:';

export function configuredSkillIds(skills: readonly string[] | undefined): string[] {
  return Array.from(
    new Set(
      (skills ?? [])
        .map((id) => id.trim())
        .filter((id) => id.length > 0 && !id.startsWith(ROLE_SKILL_PREFIX)),
    ),
  );
}

export function isValidMaxOutputTokens(value: number | null | undefined): boolean {
  if (value === null || value === undefined) return true;
  return Number.isInteger(value) && value > 0 && value <= 1_000_000;
}

/**
 * Resolve the effective max output tokens for an agent.
 * `null`/`undefined` → recommended default (callers may still omit and let
 * the provider default apply; this helper is for explicit recommended use).
 */
export function resolveMaxOutputTokens(value: number | null | undefined): number {
  if (value === null || value === undefined) return RECOMMENDED_MAX_OUTPUT_TOKENS;
  return value;
}

export function applyConfiguredAgentSkills(agent: Agent): Agent {
  const skillIds = configuredSkillIds(agent.skills);
  if (skillIds.length === 0) return agent;

  const resolved = resolveCatalogSkills(skillIds);
  if (resolved.length === 0) return agent;

  const addenda = composeCatalogSkillAddenda(skillIds).trim();
  const skillTools = unionCatalogSkillTools(skillIds);
  const tools = agent.tools_allowed.includes('*')
    ? agent.tools_allowed
    : Array.from(new Set([...agent.tools_allowed, ...skillTools]));

  if (!addenda && tools === agent.tools_allowed) return agent;

  return {
    ...agent,
    tools_allowed: tools as Agent['tools_allowed'],
    system_prompt: addenda
      ? `${agent.system_prompt ?? ''}\n\n## Agent skills\n${addenda}`.trim()
      : agent.system_prompt,
  };
}

export function applyConfiguredAgentPersona(
  agent: Agent,
  options: { forcePersona?: AgentPersona | PersonaPreset | null } = {},
): Agent {
  const preset = options.forcePersona ?? agent.persona;
  if (!preset || (preset !== 'jarvis' && preset !== 'friday')) return agent;
  return applyPersona(agent, preset);
}

/** Full config application used by the chat runtime before a turn. */
export function applyAgentRuntimeConfig(
  agent: Agent,
  options: { forcePersona?: AgentPersona | PersonaPreset | null } = {},
): Agent {
  const noBsEnabled = hasNoBsPromptSection(agent.system_prompt);
  const baseAgent = noBsEnabled
    ? { ...agent, system_prompt: setNoBsPromptSection(agent.system_prompt, false) }
    : agent;
  const configured = applyConfiguredAgentSkills(applyConfiguredAgentPersona(baseAgent, options));
  return noBsEnabled
    ? {
        ...configured,
        system_prompt: setNoBsPromptSection(configured.system_prompt, true),
      }
    : configured;
}
