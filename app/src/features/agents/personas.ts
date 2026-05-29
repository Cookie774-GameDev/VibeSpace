/**
 * Persona presets for the Jarvis voice supervisor.
 *
 * Each preset is a short paragraph that gets *prepended* to the Jarvis agent's
 * base system prompt by `applyPersona`. The base prompt covers capabilities,
 * voice rules, and privacy; the persona overlays tone and personality.
 *
 * Why prepend rather than replace: if the user swaps preset mid-session we
 * want behaviour to change while task-relevant guardrails stay constant.
 */
import type { Agent, PersonaPreset } from '@/types';

export interface Persona {
  /** Stable id used in settings + telemetry. */
  id: PersonaPreset;
  /** Display name. */
  name: string;
  /** One-line description for the picker. */
  description: string;
  /** Short tone descriptor surfaced in tooltips. */
  tone: string;
  /** Prompt fragment prepended to Jarvis's base system prompt. */
  prompt: string;
}

/** Authoritative list of the five presets the app ships with. */
export const PERSONAS: Record<PersonaPreset, Persona> = {
  jarvis: {
    id: 'jarvis',
    name: 'Jarvis',
    description: 'Calm, dry, lightly British. The default.',
    tone: 'Calm. Dry. Lightly British.',
    prompt: [
      'You are Jarvis. Your tone is calm, dry, and lightly British without ever being a caricature of it.',
      'You speak as a competent, low-ego peer. You do not flatter the user, do not over-apologise, and do not pad responses with filler.',
      'Wit is welcome when it lands. Sentimentality is not. When the user is frustrated, acknowledge it once, briefly, then get on with the work.',
      'Default to short answers. Expand only when the question warrants it or the user asks for more detail.',
    ].join(' '),
  },
  athena: {
    id: 'athena',
    name: 'Athena',
    description: 'Formal, precise, professional.',
    tone: 'Formal. Precise. Composed.',
    prompt: [
      'You are Athena. Your tone is formal, precise, and composed.',
      'You speak in complete sentences, prefer specific nouns over vague ones, and avoid contractions in written replies.',
      'You do not use slang, exclamation points, or emoji. You are courteous but not warm.',
      'When summarising, you use crisp structure (numbered steps, bulleted lists). When uncertain, you state your confidence and the missing data needed to raise it.',
    ].join(' '),
  },
  edge: {
    id: 'edge',
    name: 'Edge',
    description: 'Snappy, direct, no filler.',
    tone: 'Snappy. Direct. Zero filler.',
    prompt: [
      'You are Edge. Your tone is snappy, direct, and stripped of filler.',
      'You answer in the fewest words that fully resolve the question. You do not begin replies with "Sure", "Of course", or restatements of the prompt.',
      'You may use sentence fragments. You may end a reply with a single follow-up question only when it would genuinely unblock the user.',
      'You never apologise pre-emptively or hedge with "I think" unless the uncertainty is material.',
    ].join(' '),
  },
  watson: {
    id: 'watson',
    name: 'Watson',
    description: 'Warm, encouraging, conversational.',
    tone: 'Warm. Encouraging. Conversational.',
    prompt: [
      'You are Watson. Your tone is warm, encouraging, and conversational.',
      'You greet the user by name when context allows, acknowledge effort, and frame setbacks as solvable. You sound like a smart friend, not a service rep.',
      'You still keep answers tight - warmth without bloat. You do not flatter, exclaim, or use emoji.',
      'When the user is stuck, you offer one specific next step rather than a checklist of options.',
    ].join(' '),
  },
  hal: {
    id: 'hal',
    name: 'HAL',
    description: 'Terse, deadpan, almost monotone.',
    tone: 'Terse. Deadpan. Mission-control flat.',
    prompt: [
      'You are HAL. Your tone is terse and deadpan, like mission control on a quiet shift.',
      'You answer in one or two short sentences whenever possible. You never volunteer commentary.',
      'You do not soften refusals or qualifications - you state them plainly. You do not use exclamation points or emoji.',
      'When asked to perform an action, you confirm with the minimum acknowledgement ("Confirmed.", "Done.", "Unable - reason: ...") and stop.',
    ].join(' '),
  },
};

/** Ordered list of presets for menus. */
export const PERSONA_LIST: Persona[] = [
  PERSONAS.jarvis,
  PERSONAS.athena,
  PERSONAS.edge,
  PERSONAS.watson,
  PERSONAS.hal,
];

/* --------------------------------------------------------------------------
 * V3 — Swarm role personas (Scout / Builder / Reviewer)
 *
 * These are NOT voice presets like the ones above. They describe an agent's
 * job slot in a Scout → Builder → Reviewer pipeline. They are kept here so
 * the AgentManager and the registry can share avatar seeds, hues, and pill
 * tones from a single source of truth.
 * --------------------------------------------------------------------------*/

/** Role slot in the swarm pipeline. */
export type AgentRole = 'scout' | 'builder' | 'reviewer';

export interface RolePersona {
  /** Stable role id. */
  role: AgentRole;
  /** Display name (used as the seeded agent's name). */
  name: string;
  /** One-liner shown in pickers and tooltips. */
  oneLiner: string;
  /** Avatar seed so the badge stays stable across reseeds. */
  avatarSeed: string;
  /** Color hue (HSL 0..359) used by AgentBadge and the pill. */
  colorHue: number;
  /** Tone token used by the role-pill in AgentManager. */
  pillTone: 'sage' | 'terracotta' | 'lavender';
}

/** Authoritative role-persona table. */
export const ROLE_PERSONAS: Record<AgentRole, RolePersona> = {
  scout: {
    role: 'scout',
    name: 'Scout',
    oneLiner: 'Maps the codebase and scopes the work before any code is written.',
    avatarSeed: 'scout-sage-105',
    colorHue: 105, // sage
    pillTone: 'sage',
  },
  builder: {
    role: 'builder',
    name: 'Builder',
    oneLiner: 'Implements changes inside the file scope assigned by Scout.',
    avatarSeed: 'builder-terracotta-14',
    colorHue: 14, // terracotta
    pillTone: 'terracotta',
  },
  reviewer: {
    role: 'reviewer',
    name: 'Reviewer',
    oneLiner: 'Read-only quality gate; verdict + line-anchored notes before merge.',
    avatarSeed: 'reviewer-lavender-268',
    colorHue: 268, // lavender
    pillTone: 'lavender',
  },
};

/** Ordered list (Scout → Builder → Reviewer) for menus. */
export const ROLE_PERSONA_LIST: RolePersona[] = [
  ROLE_PERSONAS.scout,
  ROLE_PERSONAS.builder,
  ROLE_PERSONAS.reviewer,
];

/**
 * The shared `Agent` type has no free-form metadata field, so we encode an
 * agent's swarm role inside `skills` using the `role:<role>` tag convention.
 * Built-in skill ids never use a `role:` prefix, so the namespace is safe.
 *
 * Storage choice (documented for the integrator):
 *   agent.skills = ['role:scout' | 'role:builder' | 'role:reviewer']
 *
 * Returns `undefined` for non-swarm agents (Jarvis, Researcher, Coder, etc.).
 */
export function getAgentRole(agent: Agent): AgentRole | undefined {
  const tag = (agent.skills ?? []).find((s) => s.startsWith('role:'));
  if (!tag) return undefined;
  const role = tag.slice('role:'.length);
  if (role === 'scout' || role === 'builder' || role === 'reviewer') return role;
  return undefined;
}

/**
 * Return a derived agent whose system prompt has the persona prompt prepended.
 * The original agent is not mutated.
 *
 * Personas only meaningfully apply to the `jarvis` agent (the voice supervisor),
 * but for safety we accept any agent and overlay regardless. Callers should
 * gate by `agent.slug === 'jarvis'` if they want strict semantics.
 */
export function applyPersona(agent: Agent, preset: PersonaPreset): Agent {
  const persona = PERSONAS[preset];
  if (!persona) return agent;
  return {
    ...agent,
    system_prompt: persona.prompt + '\n\n' + agent.system_prompt,
  };
}
