/**
 * Agent prompt delivery — makes the per-pane agent assignment *real* for
 * spawned CLI agents (opencode, claude, codex, …).
 *
 * The problem this solves: assigning an agent to a terminal pane used to
 * be UI metadata only. The agent's user-editable `system_prompt` fed
 * in-app LLM chats, but a CLI spawned inside the pane never saw it — ask
 * opencode "what's your code word?" and it had no idea.
 *
 * Delivery mechanism (two channels, both written before the CLI runs):
 *
 *   1. `AGENTS.md` in the session's working directory. This is the
 *      de-facto standard instructions file that opencode, codex, and
 *      other CLI agents read on session start. We own a fenced "managed
 *      block" inside it (HTML-comment markers) so user-authored content
 *      around the block is never touched, and switching agents replaces
 *      only our block.
 *   2. Environment variables on the PTY (`JARVIS_AGENT_SLUG`, …) so
 *      shell prompts / wrappers / custom CLIs can also discover the
 *      assignment without parsing markdown.
 *
 * The managed block composes, in order:
 *   - the assigned agent's editable prompt (per-agent, user-editable),
 *   - the shared base prompt every agent gets (project context blob,
 *     project context map, what other agents are doing right now),
 *   - a pointer to the shared coordination document that all agents
 *     append to so they don't overlap.
 *
 * The coordination document (`.jarvis-coordination.md`, same directory)
 * is created on first delivery and never overwritten after that — agents
 * and the user own its contents.
 *
 * Re-delivery: `TerminalView` calls `deliverAgentTerminalContext` again
 * whenever the user switches the pane's agent. The managed block is
 * rewritten in place; a CLI started after the switch picks up the new
 * briefing (a CLI already mid-session reads instructions at session
 * start, so the user restarts it — this matches how AGENTS.md works for
 * every tool that consumes it).
 */

import { readTextFile, writeTextFile } from '@/lib/fs';
import { useAgentStore } from '@/stores/agents';
import { composeSkillAddenda } from '@/lib/agents/skills';
import { loadStoredContextTree, type ProjectContextTree } from '@/features/context/tree';
import { useTerminalTranscriptStore } from './transcriptStore';

/* -------------------------------------------------------------------------- */
/*  Constants                                                                 */
/* -------------------------------------------------------------------------- */

export const AGENTS_FILE_NAME = 'AGENTS.md';
export const COORDINATION_FILE_NAME = '.jarvis-coordination.md';

export const MANAGED_BLOCK_START = '<!-- VIBESPACE:AGENT-BRIEFING:START — managed by VibeSpace, do not edit between markers -->';
export const MANAGED_BLOCK_END = '<!-- VIBESPACE:AGENT-BRIEFING:END -->';

/** Character budgets so AGENTS.md stays a briefing, not a dump. */
const MAX_AGENT_PROMPT_CHARS = 12_000;
const MAX_PROJECT_CONTEXT_CHARS = 6_000;
const MAX_CONTEXT_MAP_CHARS = 4_000;
const MAX_OTHER_AGENT_TAIL_CHARS = 160;

/**
 * The shared base rules every terminal agent receives, regardless of
 * which agent persona is assigned. Project-specific sections (context
 * blob, context map, sibling agents, coordination doc) are appended by
 * `composeAgentBriefing`.
 */
export const BASE_TERMINAL_AGENT_RULES = [
  'You are one of possibly several AI CLI agents working in this project inside VibeSpace, the user\'s multi-agent workspace. Each agent runs in its own terminal pane.',
  '',
  'Shared operating rules for every agent:',
  '1. Read the shared coordination document (path below) before starting work, and append your task claim and status updates to it so agents do not overlap or conflict.',
  '2. If the coordination document shows another agent already owns a task or file, pick different work or coordinate through the document instead of duplicating effort.',
  '3. Stay inside this project directory unless the user explicitly directs you elsewhere.',
  '4. Prefer small, verifiable changes. Run the project\'s tests when you change code.',
  '5. Never delete or rewrite other agents\' entries in the coordination document — append only.',
].join('\n');

/* -------------------------------------------------------------------------- */
/*  Pure helpers                                                              */
/* -------------------------------------------------------------------------- */

/** Join `dir` + `name` matching the directory's existing separator style. */
export function joinPath(dir: string, name: string): string {
  const clean = dir.trim().replace(/[\\/]+$/g, '');
  const separator = clean.includes('\\') ? '\\' : '/';
  return `${clean}${separator}${name}`;
}

export function agentsFilePath(cwd: string): string {
  return joinPath(cwd, AGENTS_FILE_NAME);
}

export function coordinationFilePath(cwd: string): string {
  return joinPath(cwd, COORDINATION_FILE_NAME);
}

function clip(text: string, max: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max)}\n…[truncated by VibeSpace]`;
}

/** Sibling agent descriptor for the "what other AIs are doing" section. */
export interface SiblingAgentActivity {
  agentSlug: string;
  command?: string | null;
  /** Milliseconds since the sibling's last terminal output. */
  idleMs?: number;
  /** Last visible line of the sibling's transcript (already ANSI-free). */
  lastLine?: string;
}

export interface AgentBriefingInputs {
  agentSlug: string;
  agentName: string;
  /** The user-editable per-agent prompt (Agent.system_prompt + skills). */
  agentPrompt: string;
  projectName?: string | null;
  /** Project-level context blob (`Project.system_prompt_context`). */
  projectContext?: string | null;
  /** Bounded summary of the generated project context map. */
  contextMapSummary?: string | null;
  otherAgents?: SiblingAgentActivity[];
  coordinationFilePath: string;
}

function formatIdle(idleMs: number | undefined): string {
  if (idleMs == null || !Number.isFinite(idleMs)) return 'activity unknown';
  const sec = Math.max(0, Math.round(idleMs / 1000));
  if (sec < 90) return `active ${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 90) return `active ${min}m ago`;
  return `active ${Math.round(min / 60)}h ago`;
}

/**
 * Compose the full briefing body (without managed-block markers).
 * Pure — fully unit-testable.
 */
export function composeAgentBriefing(inputs: AgentBriefingInputs): string {
  const sections: string[] = [];

  sections.push(`# VibeSpace agent briefing — ${inputs.agentName}`);
  sections.push(
    `You are operating as the **${inputs.agentName}** agent (slug: \`${inputs.agentSlug}\`)` +
      (inputs.projectName ? ` in the **${inputs.projectName}** project.` : '.'),
  );

  const prompt = inputs.agentPrompt.trim();
  if (prompt) {
    sections.push(`## Your instructions (${inputs.agentName})\n${clip(prompt, MAX_AGENT_PROMPT_CHARS)}`);
  }

  sections.push(`## Shared rules for all VibeSpace agents\n${BASE_TERMINAL_AGENT_RULES}`);

  const projectContext = inputs.projectContext?.trim();
  if (projectContext) {
    sections.push(`## Project context\n${clip(projectContext, MAX_PROJECT_CONTEXT_CHARS)}`);
  }

  const contextMap = inputs.contextMapSummary?.trim();
  if (contextMap) {
    sections.push(`## Project context map\n${clip(contextMap, MAX_CONTEXT_MAP_CHARS)}`);
  }

  const others = inputs.otherAgents ?? [];
  if (others.length > 0) {
    const rows = others.map((other) => {
      const bits: string[] = [`- \`${other.agentSlug}\``];
      if (other.command) bits.push(`running \`${other.command}\``);
      bits.push(`(${formatIdle(other.idleMs)})`);
      const line = other.lastLine?.trim();
      if (line) bits.push(`— last output: "${clip(line, MAX_OTHER_AGENT_TAIL_CHARS)}"`);
      return bits.join(' ');
    });
    sections.push(
      `## Other agents currently in this workspace\n${rows.join('\n')}\n\nDo not duplicate their work. Coordinate through the shared coordination document.`,
    );
  }

  sections.push(
    [
      '## Coordination document (required reading)',
      `Shared coordination document: \`${inputs.coordinationFilePath}\``,
      'Read it before starting work. Append your task claim when you start, and update your status when you finish. All agents in this project write to this same file so work never overlaps.',
    ].join('\n'),
  );

  return sections.join('\n\n');
}

/** Wrap a briefing body in the managed-block markers. */
export function wrapManagedBlock(body: string): string {
  return `${MANAGED_BLOCK_START}\n\n${body.trim()}\n\n${MANAGED_BLOCK_END}`;
}

/**
 * Merge the managed block into an existing AGENTS.md.
 *
 *   - markers present  → replace only the marked region (user content
 *     around it is preserved byte-for-byte),
 *   - markers absent   → append the block after the existing content,
 *   - no existing file → the block becomes the whole file,
 *   - `block === null` → remove the managed region (agent cleared).
 *
 * Returns `null` when no write is needed (e.g. removing a block from a
 * file that never had one).
 */
export function mergeManagedBlock(existing: string | null, block: string | null): string | null {
  const startIdx = existing?.indexOf(MANAGED_BLOCK_START) ?? -1;
  const endIdx = existing?.indexOf(MANAGED_BLOCK_END) ?? -1;
  const hasMarkers = existing != null && startIdx !== -1 && endIdx !== -1 && endIdx > startIdx;

  if (block == null) {
    if (!hasMarkers || existing == null) return null;
    const before = existing.slice(0, startIdx).replace(/\n+$/, '\n');
    const after = existing.slice(endIdx + MANAGED_BLOCK_END.length).replace(/^\n+/, '\n');
    const merged = `${before}${after}`.trim();
    return merged.length > 0 ? `${merged}\n` : '';
  }

  if (existing == null || existing.trim().length === 0) {
    return `${block}\n`;
  }

  if (hasMarkers) {
    const before = existing.slice(0, startIdx);
    const after = existing.slice(endIdx + MANAGED_BLOCK_END.length);
    return `${before}${block}${after}`;
  }

  return `${existing.replace(/\n+$/, '')}\n\n${block}\n`;
}

/** Initial contents of the shared coordination document. */
export function defaultCoordinationDoc(projectName?: string | null): string {
  return [
    `# VibeSpace agent coordination board${projectName ? ` — ${projectName}` : ''}`,
    '',
    'Shared scratchpad for every AI agent working in this project. Append entries; never delete or rewrite another agent\'s rows.',
    '',
    '## How to use this board',
    '1. Before starting work, read the active claims below.',
    '2. When you start a task, add a row claiming it (agent, task/files, status, timestamp).',
    '3. Update your row\'s status when you finish or hand off.',
    '',
    '## Active claims',
    '',
    '| Agent | Task / files | Status | Updated |',
    '|---|---|---|---|',
    '',
    '## Notes between agents',
    '',
  ].join('\n');
}

/**
 * Bounded, human/LLM-readable summary of the project context map.
 * Returns '' when there is nothing useful to show.
 */
export function summarizeContextTree(tree: ProjectContextTree | null): string {
  if (!tree) return '';
  const lines: string[] = [];
  if (tree.summary?.trim()) lines.push(tree.summary.trim());
  if (tree.rootDir) lines.push(`Project root: \`${tree.rootDir}\``);
  if (tree.recommendedEntryPoints && tree.recommendedEntryPoints.length > 0) {
    lines.push(`Recommended entry points: ${tree.recommendedEntryPoints.slice(0, 8).map((p) => `\`${p}\``).join(', ')}`);
  }
  const nodes = (tree.nodes ?? []).slice(0, 12);
  if (nodes.length > 0) {
    lines.push('Top-level areas:');
    for (const node of nodes) {
      const path = node.path ? ` (\`${node.path}\`)` : '';
      const summary = node.summary?.trim() ? ` — ${node.summary.trim()}` : '';
      lines.push(`- ${node.title}${path}${summary}`);
    }
  }
  return clip(lines.join('\n'), MAX_CONTEXT_MAP_CHARS);
}

/**
 * Environment variables attached to the spawned PTY so the assignment is
 * discoverable by any process in the pane, not just AGENTS.md readers.
 * File-path variables are included only when the working directory is
 * known at spawn time.
 */
export function buildAgentSpawnEnv(opts: {
  agentSlug: string;
  agentName?: string | null;
  cwd?: string | null;
  projectName?: string | null;
}): Record<string, string> {
  const env: Record<string, string> = {
    JARVIS_AGENT_SLUG: opts.agentSlug,
  };
  if (opts.agentName) env.JARVIS_AGENT_NAME = opts.agentName;
  if (opts.projectName) env.JARVIS_PROJECT_NAME = opts.projectName;
  if (opts.cwd) {
    env.JARVIS_AGENTS_FILE = agentsFilePath(opts.cwd);
    env.JARVIS_COORDINATION_FILE = coordinationFilePath(opts.cwd);
  }
  return env;
}

const INTERACTIVE_AGENT_COMMAND_RE =
  /\b(opencode|open-code|open\s+code|claude|codex|gemini|cursor-agent|cline|aider|goose|qwen|openai)\b/i;

const INTERACTIVE_AGENT_OUTPUT_RE =
  /\b(OpenCode\s+Zen|ctrl\+p\s+commands|Claude\s+Code|Codex|Gemini|Aider|Cline|Goose|Qwen)\b/i;

export function detectInteractiveAgentCli(opts: {
  command?: string | null;
  startupCommand?: string | null;
  transcript?: string | null;
}): boolean {
  const command = [opts.command, opts.startupCommand].filter(Boolean).join(' ');
  if (INTERACTIVE_AGENT_COMMAND_RE.test(command)) return true;
  const tail = (opts.transcript ?? '').slice(-4000);
  return INTERACTIVE_AGENT_OUTPUT_RE.test(tail);
}

export async function buildTerminalAgentInjectionMessage(opts: {
  agentSlug: string;
  userInput: string;
  cwd?: string | null;
  projectId?: string | null;
  projectName?: string | null;
  excludeSessionId?: string | null;
}): Promise<string> {
  const coordinationPath = opts.cwd
    ? coordinationFilePath(opts.cwd)
    : COORDINATION_FILE_NAME;
  const agentsPath = opts.cwd ? agentsFilePath(opts.cwd) : AGENTS_FILE_NAME;

  return [
    'VibeSpace terminal context:',
    `Read and follow the managed project instructions in \`${agentsPath}\` before answering.`,
    `Use the shared coordination document at \`${coordinationPath}\` so multiple agents do not overlap.`,
    'The instructions are stored as project documents, not pasted into this chat.',
    '',
    'User message:',
    opts.userInput.trim(),
  ].join('\n');
}

/* -------------------------------------------------------------------------- */
/*  Input gathering (store/db reads)                                          */
/* -------------------------------------------------------------------------- */

/** Resolve display name + effective prompt for an agent slug. */
export function resolveAgentForSlug(agentSlug: string): { name: string; prompt: string } {
  const agents = Object.values(useAgentStore.getState().agents);
  const agent = agents.find((a) => a.slug === agentSlug);
  if (!agent) return { name: agentSlug, prompt: '' };
  const addenda = agent.skills && agent.skills.length > 0 ? composeSkillAddenda(agent.skills) : '';
  const prompt = [addenda, agent.system_prompt ?? ''].filter((p) => p.trim().length > 0).join('\n\n');
  return { name: agent.name || agentSlug, prompt };
}

/**
 * Snapshot of what the *other* terminal agents in this project are doing,
 * sourced from the live transcript store.
 */
export function gatherSiblingAgentActivity(opts: {
  projectId?: string | null;
  excludeSessionId?: string | null;
}): SiblingAgentActivity[] {
  const sessions = Object.values(useTerminalTranscriptStore.getState().sessions);
  const now = Date.now();
  return sessions
    .filter((s) => s.agentSlug && s.sessionId !== opts.excludeSessionId)
    .filter((s) => (s.projectId ?? null) === (opts.projectId ?? null))
    .sort((a, b) => b.lastWriteAt - a.lastWriteAt)
    .slice(0, 8)
    .map((s) => {
      const lines = s.text.split('\n').map((l) => l.trim()).filter(Boolean);
      return {
        agentSlug: s.agentSlug as string,
        command: s.command,
        idleMs: now - s.lastWriteAt,
        lastLine: lines[lines.length - 1],
      };
    });
}

/* -------------------------------------------------------------------------- */
/*  Delivery                                                                  */
/* -------------------------------------------------------------------------- */

export interface AgentDeliveryResult {
  ok: boolean;
  agentsFilePath: string;
  coordinationFilePath: string;
  /** Slug delivered, or null when the managed block was removed. */
  agentSlug: string | null;
  error?: string;
}

async function loadProjectContext(projectId: string | null | undefined): Promise<string | null> {
  if (!projectId) return null;
  try {
    // Dynamic import keeps Dexie out of the module graph for unit tests
    // and non-DB consumers of the pure helpers above.
    const { projectRepo } = await import('@/lib/db');
    const project = await projectRepo.getById(projectId as never);
    return (project as { system_prompt_context?: string } | undefined)?.system_prompt_context ?? null;
  } catch {
    return null;
  }
}

/**
 * Write (or update) the agent briefing for a terminal working directory.
 *
 *   - `agentSlug` set  → compose the briefing and upsert the managed
 *     block in `<cwd>/AGENTS.md`; create the coordination document if it
 *     does not exist yet.
 *   - `agentSlug` null → remove the managed block (pane back to plain
 *     shell); never touches user-authored content or the coordination doc.
 *
 * Failures are reported, not thrown — terminal spawn must never break
 * because a briefing could not be written (read-only folder, web preview
 * without the Tauri bridge, …).
 */
export async function deliverAgentTerminalContext(opts: {
  cwd: string;
  agentSlug: string | null;
  projectId?: string | null;
  projectName?: string | null;
  excludeSessionId?: string | null;
}): Promise<AgentDeliveryResult> {
  const agentsPath = agentsFilePath(opts.cwd);
  const coordinationPath = coordinationFilePath(opts.cwd);
  const base: AgentDeliveryResult = {
    ok: false,
    agentsFilePath: agentsPath,
    coordinationFilePath: coordinationPath,
    agentSlug: opts.agentSlug,
  };

  try {
    const existingRead = await readTextFile(agentsPath);
    if (!existingRead.ok && existingRead.error.code === 'unavailable') {
      return { ...base, error: 'File system bridge unavailable (not running in the desktop app).' };
    }
    const existing = existingRead.ok ? existingRead.content : null;

    if (opts.agentSlug == null) {
      const merged = mergeManagedBlock(existing, null);
      if (merged == null) return { ...base, ok: true };
      const write = await writeTextFile(agentsPath, merged);
      return write.ok ? { ...base, ok: true } : { ...base, error: write.error.raw ?? write.error.code };
    }

    // Ensure the shared coordination document exists (never overwrite).
    const coordinationRead = await readTextFile(coordinationPath);
    if (!coordinationRead.ok && coordinationRead.error.code === 'not_found') {
      await writeTextFile(coordinationPath, defaultCoordinationDoc(opts.projectName));
    }

    const { name, prompt } = resolveAgentForSlug(opts.agentSlug);
    const projectContext = await loadProjectContext(opts.projectId);
    let contextMapSummary = '';
    try {
      contextMapSummary = summarizeContextTree(loadStoredContextTree(opts.projectId ?? null));
    } catch {
      contextMapSummary = '';
    }

    const briefing = composeAgentBriefing({
      agentSlug: opts.agentSlug,
      agentName: name,
      agentPrompt: prompt,
      projectName: opts.projectName,
      projectContext,
      contextMapSummary,
      otherAgents: gatherSiblingAgentActivity({
        projectId: opts.projectId,
        excludeSessionId: opts.excludeSessionId,
      }),
      coordinationFilePath: coordinationPath,
    });

    const merged = mergeManagedBlock(existing, wrapManagedBlock(briefing));
    if (merged == null) return { ...base, ok: true };
    const write = await writeTextFile(agentsPath, merged);
    return write.ok ? { ...base, ok: true } : { ...base, error: write.error.raw ?? write.error.code };
  } catch (err) {
    return { ...base, error: err instanceof Error ? err.message : String(err) };
  }
}
