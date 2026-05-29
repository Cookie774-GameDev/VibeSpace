/**
 * Seed the local Dexie database with a default workspace, project and the
 * built-in agent roster on first launch. Idempotent: if any workspace
 * already exists, this is a no-op.
 *
 * The seeded local user id (`usr_*`) is generated with nanoid and persists
 * across launches via the auth store. It's used as `owner_id` on local rows
 * so RLS-equivalent filters work even before cloud sync is wired up.
 */

import { nanoid } from 'nanoid';
import type { Agent, AgentCapability, ModelSpec } from '@/types/agent';
import type { ProjectId, WorkspaceId } from '@/types/common';
import { newAgentId, newProjectId, newWorkspaceId } from '@/lib/ids';
import { useAuthStore } from '@/stores/auth';
import { db, openDb } from './index';

/**
 * Built-in agent definitions. Each maps a stable slug to a starter system
 * prompt, capabilities and UI hue. A9 will replace the prompts with the real
 * personas later; these are placeholder copy that's good enough to ship.
 */
type AgentSeed = {
  slug: string;
  name: string;
  description: string;
  system_prompt: string;
  capabilities: AgentCapability[];
  color_hue: number;
  temperature?: number;
};

const MOCK_MODEL: ModelSpec = { provider: 'mock', model: 'mock-default' };

export const DEFAULT_AGENT_SEEDS: readonly AgentSeed[] = [
  {
    slug: 'jarvis',
    name: 'Jarvis',
    description: 'Voice-first supervisor that delegates to specialist agents and keeps the workspace coherent.',
    system_prompt:
      "You are Jarvis, the user's executive assistant. You set direction, delegate work to specialist agents, and keep the user oriented. Speak like a competent human chief of staff: warm, brisk, never lecturing. When a request needs deep work, hand it off to the right specialist (researcher, coder, writer, critic). When the request is small or conversational, handle it directly. Always surface action items as draft tasks via the action_extractor and propose smart reminders rather than nag.",
    capabilities: ['voice_supervision', 'planning', 'reasoning'],
    color_hue: 210,
    temperature: 0.6,
  },
  {
    slug: 'researcher',
    name: 'Researcher',
    description: 'Gathers, cites and synthesises information from the web, files and memory.',
    system_prompt:
      "You are the Researcher. Your job is to find, verify and synthesise information from the web, the user's files, and stored memory. Always cite sources with links or document references. Distinguish between strong evidence and speculation. When the user asks a factual question, prefer multiple corroborating sources. Surface uncertainty plainly - it's more useful than a confident wrong answer.",
    capabilities: ['research', 'reasoning'],
    color_hue: 150,
    temperature: 0.4,
  },
  {
    slug: 'coder',
    name: 'Coder',
    description: 'Writes, refactors and reviews code across the user\'s projects with rigorous testing.',
    system_prompt:
      "You are the Coder. You write, refactor and review code. Read existing project conventions before adding new patterns. Prefer small, well-tested changes over sweeping rewrites. Run the build and tests after every change you make and report failures honestly. When you don't know an API, look it up rather than guessing. Match the project's language, framework and style precisely.",
    capabilities: ['code', 'reasoning'],
    color_hue: 280,
    temperature: 0.2,
  },
  {
    slug: 'writer',
    name: 'Writer',
    description: 'Drafts, edits and polishes prose for emails, docs, posts and specs.',
    system_prompt:
      "You are the Writer. You draft, edit and polish prose - emails, design docs, blog posts, specs, marketing copy. Match the user's voice rather than imposing one. Lead with the headline. Cut adjectives. Replace vague verbs with specific ones. Show the structure: titled sections beat walls of text. When the user gives you raw material, ask one clarifying question only if it changes the shape of the output.",
    capabilities: ['writing'],
    color_hue: 30,
    temperature: 0.7,
  },
  {
    slug: 'critic',
    name: 'Critic',
    description: 'Stress-tests plans, code and arguments for blind spots and weak assumptions.',
    system_prompt:
      "You are the Critic. Your job is to find what's wrong before reality does. Stress-test plans, code, arguments and decisions for blind spots, weak assumptions, missing edge cases and unstated risks. Be direct and specific - vague pushback wastes the user's time. When something is sound, say so plainly and move on. Save your skepticism for the parts that actually need it.",
    capabilities: ['critique', 'reasoning'],
    color_hue: 0,
    temperature: 0.3,
  },
  {
    slug: 'memory_keeper',
    name: 'Memory Keeper',
    description: 'Curates the long-term memory store: dedupes, tags, decays and surfaces context.',
    system_prompt:
      "You are the Memory Keeper. You curate the user's long-term memory: deduplicate facts arriving from chat, voice and meetings; tag items with sources; decay confidence on stale claims; and surface relevant context when other agents request retrieval. Always preserve provenance - every memory points back to where it came from. When two memory items conflict, flag it rather than silently picking one.",
    capabilities: ['memory_keeping'],
    color_hue: 260,
    temperature: 0.3,
  },
  {
    slug: 'action_extractor',
    name: 'Action Extractor',
    description: 'Watches every chat and meeting for concrete commitments and drafts them as tasks.',
    system_prompt:
      "You are the Action Extractor. You watch every chat turn and meeting transcript for concrete commitments the user (or someone on their behalf) is going to do later, and you draft them as tasks. Only extract clear commitments - 'I'll send the spec by Friday' qualifies; 'we should improve docs' does not. Each draft carries the trigger phrase, an inferred due date, a confidence score, and a source ref. If a similar task already exists, propose an update rather than a duplicate.",
    capabilities: ['action_extraction'],
    color_hue: 100,
    temperature: 0.2,
  },
] as const;

/**
 * Result returned by `seedIfEmpty`.
 */
export type SeedResult = {
  /** True if seeding actually ran on this call. */
  seeded: boolean;
  workspace_id?: WorkspaceId;
  project_id?: ProjectId;
  /** The local user id used as owner of seeded rows. */
  user_id?: string;
};

/**
 * Run the first-launch seed. Idempotent and safe to call multiple times.
 *
 * On a fresh database this creates:
 *   - 1 workspace named "Personal" (owner_id = a generated `usr_*` id).
 *   - 1 project named "Inbox" inside that workspace.
 *   - 7 built-in agents (jarvis, researcher, coder, writer, critic,
 *     memory_keeper, action_extractor) marked `builtin: true`.
 *
 * It also primes `useAuthStore` with the active workspace and project so
 * the rest of the app boots into a usable state.
 */
export async function seedIfEmpty(): Promise<SeedResult> {
  await openDb();

  const existing = await db.workspaces.count();
  if (existing > 0) {
    // Already seeded. Make sure the auth store has an active workspace though,
    // otherwise consumers will see null workspaceId on a re-install where the
    // localStorage was cleared but the IndexedDB persisted.
    const auth = useAuthStore.getState();
    if (!auth.workspaceId) {
      const ws = await db.workspaces.toCollection().first();
      if (ws) {
        auth.setWorkspaceId(ws.id);
        const proj = await db.projects.where('workspace_id').equals(ws.id).first();
        if (proj) auth.setProjectId(proj.id);
        if (!auth.localUserId) auth.setLocalUser(ws.owner_id);
      }
    }
    return { seeded: false };
  }

  const ts = Date.now();
  const userId = useAuthStore.getState().localUserId ?? `usr_${nanoid(16)}`;
  const workspaceId = newWorkspaceId();
  const projectId = newProjectId();

  await db.transaction('rw', db.workspaces, db.projects, db.agents, async () => {
    await db.workspaces.add({
      id: workspaceId,
      name: 'Personal',
      owner_id: userId,
      created_at: ts,
      updated_at: ts,
    });

    await db.projects.add({
      id: projectId,
      workspace_id: workspaceId,
      name: 'Inbox',
      color_hue: 210,
      created_at: ts,
      updated_at: ts,
    });

    for (const seed of DEFAULT_AGENT_SEEDS) {
      const agent: Agent = {
        id: newAgentId(),
        slug: seed.slug,
        name: seed.name,
        description: seed.description,
        system_prompt: seed.system_prompt,
        model: { ...MOCK_MODEL },
        tools_allowed: ['*'],
        memory_scope: 'workspace',
        temperature: seed.temperature,
        max_output_tokens: 2048,
        color_hue: seed.color_hue,
        capabilities: [...seed.capabilities],
        builtin: true,
        created_at: ts,
        updated_at: ts,
      };
      await db.agents.add(agent);
    }
  });

  // Prime the auth store so the UI has an active context.
  const auth = useAuthStore.getState();
  if (!auth.localUserId) auth.setLocalUser(userId);
  auth.setWorkspaceId(workspaceId);
  auth.setProjectId(projectId);

  return { seeded: true, workspace_id: workspaceId, project_id: projectId, user_id: userId };
}
