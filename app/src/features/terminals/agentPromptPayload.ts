import type { AgentCoordinationMode } from './agentCoordination';

export interface AgentPromptPayloadInput {
  mode?: AgentCoordinationMode;
  cwd?: string | null;
  terminalId?: string | null;
  agentSlug: string | null;
  agentName?: string | null;
  agentPrompt?: string | null;
  projectName?: string | null;
  projectContext?: string | null;
  contextMapSummary?: string | null;
  coordinationSummary?: string | null;
  coordinationFilePath?: string | null;
  otherAgents?: Array<{
    agentSlug: string;
    command?: string | null;
    idleMs?: number;
    lastLine?: string;
  }>;
}

export interface AgentPromptPayload {
  mode: AgentCoordinationMode;
  shouldWriteInstructionFiles: boolean;
  shouldEnsureCoordinationDoc: boolean;
  allowLedgerWrites: boolean;
  allowFileLocks: boolean;
  briefingBody: string | null;
  managedBlock: string | null;
}

const MANAGED_BLOCK_START = '<!-- VIBESPACE:AGENT-BRIEFING:START — managed by VibeSpace, do not edit between markers -->';
const MANAGED_BLOCK_END = '<!-- VIBESPACE:AGENT-BRIEFING:END -->';
const MAX_AGENT_PROMPT_CHARS = 12_000;
const MAX_PROJECT_CONTEXT_CHARS = 6_000;
const MAX_CONTEXT_MAP_CHARS = 4_000;
const MAX_COORDINATION_SUMMARY_CHARS = 4_000;

const BASE_RULES = [
  'You are one of possibly several AI CLI agents working in this project inside VibeSpace, the user\'s multi-agent workspace. Each agent runs in its own terminal pane.',
  '',
  'Shared operating rules for every agent:',
  '1. Stay inside this project directory unless the user explicitly directs you elsewhere.',
  '2. Prefer small, verifiable changes. Run the project\'s tests when you change code.',
  '3. Never delete or rewrite another agent\'s coordination entries.',
].join('\n');

const COORDINATED_RULES = [
  'Coordinated mode rules:',
  '1. Read the coordination summary and hidden `.vibespace` ledger before editing.',
  '2. Claim or lock files before editing them.',
  '3. If another active agent owns a file, wait, choose different work, or hand off clearly.',
  '4. Release locks when the edit is complete.',
  '5. Treat stale locks carefully: they are warnings, not permission to blindly overwrite work.',
].join('\n');

function clip(text: string | null | undefined, max: number): string {
  const clean = (text ?? '').trim();
  if (clean.length <= max) return clean;
  return `${clean.slice(0, max)}\n...[truncated by VibeSpace]`;
}

function formatIdle(idleMs: number | undefined): string {
  if (idleMs == null || !Number.isFinite(idleMs)) return 'activity unknown';
  const sec = Math.max(0, Math.round(idleMs / 1000));
  if (sec < 90) return `active ${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 90) return `active ${min}m ago`;
  return `active ${Math.round(min / 60)}h ago`;
}

function wrapManagedBlock(body: string): string {
  return `${MANAGED_BLOCK_START}\n\n${body.trim()}\n\n${MANAGED_BLOCK_END}`;
}

export function buildAgentPromptPayload(input: AgentPromptPayloadInput): AgentPromptPayload {
  const mode = input.mode ?? 'default';
  const coordinated = mode === 'coordinated';

  if (mode === 'no-context' || !input.agentSlug) {
    return {
      mode,
      shouldWriteInstructionFiles: false,
      shouldEnsureCoordinationDoc: false,
      allowLedgerWrites: false,
      allowFileLocks: false,
      briefingBody: null,
      managedBlock: null,
    };
  }

  const agentName = input.agentName?.trim() || input.agentSlug;
  const sections: string[] = [];
  sections.push(`# VibeSpace agent briefing — ${agentName}`);
  sections.push(
    `You are operating as the **${agentName}** agent (slug: \`${input.agentSlug}\`)` +
      (input.projectName ? ` in the **${input.projectName}** project.` : '.'),
  );
  sections.push(`## Shared rules for all VibeSpace agents\n${BASE_RULES}`);

  if (coordinated) {
    sections.push(`## Coordinated context mode\n${COORDINATED_RULES}`);
    sections.push(
      [
        '## Terminal identity',
        `Terminal ID: \`${input.terminalId ?? 'unknown'}\``,
        `Mode: \`${mode}\``,
        input.cwd ? `Workspace: \`${input.cwd}\`` : null,
      ].filter(Boolean).join('\n'),
    );
  }

  const prompt = clip(input.agentPrompt, MAX_AGENT_PROMPT_CHARS);
  if (prompt) sections.push(`## Your instructions (${agentName})\n${prompt}`);

  const projectContext = clip(input.projectContext, MAX_PROJECT_CONTEXT_CHARS);
  if (projectContext) sections.push(`## Project context\n${projectContext}`);

  const contextMap = clip(input.contextMapSummary, MAX_CONTEXT_MAP_CHARS);
  if (contextMap) sections.push(`## Project context map\n${contextMap}`);

  if (coordinated) {
    const coordinationSummary = clip(input.coordinationSummary, MAX_COORDINATION_SUMMARY_CHARS);
    if (coordinationSummary) sections.push(coordinationSummary);
  }

  const others = input.otherAgents ?? [];
  if (others.length > 0) {
    const rows = others.map((other) => {
      const bits: string[] = [`- \`${other.agentSlug}\``];
      if (other.command) bits.push(`running \`${other.command}\``);
      bits.push(`(${formatIdle(other.idleMs)})`);
      if (other.lastLine?.trim()) bits.push(`— last output: "${clip(other.lastLine, 160)}"`);
      return bits.join(' ');
    });
    sections.push(`## Other agents currently in this workspace\n${rows.join('\n')}`);
  }

  if (input.coordinationFilePath) {
    sections.push(
      [
        '## Coordination document (required reading)',
        `Shared coordination document: \`${input.coordinationFilePath}\``,
        coordinated
          ? 'Also check `.vibespace/agent-state.json`, `.vibespace/agent-locks.json`, and `.vibespace/agent-coordination.jsonl` before editing.'
          : 'Read it before starting work and append status updates if you coordinate manually.',
      ].join('\n'),
    );
  }

  const briefingBody = sections.join('\n\n');
  return {
    mode,
    shouldWriteInstructionFiles: true,
    shouldEnsureCoordinationDoc: true,
    allowLedgerWrites: coordinated,
    allowFileLocks: coordinated,
    briefingBody,
    managedBlock: wrapManagedBlock(briefingBody),
  };
}
