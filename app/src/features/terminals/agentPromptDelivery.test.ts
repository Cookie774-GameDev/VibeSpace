/**
 * @file Tests for the agent prompt delivery system.
 *
 * Covers the regression the user reported: a code word placed in the
 * agent's system prompt must actually reach the spawned CLI. Delivery is
 * file-based (AGENTS.md managed block + coordination doc) plus spawn env
 * vars, so the tests pin:
 *   1. Prompt composition — agent prompt + shared base rules + project
 *      context + context map + sibling agents + coordination pointer.
 *   2. Managed-block merging — user content around the block survives,
 *      switching agents replaces only our block, clearing removes it.
 *   3. The writer — what files get written, with what content.
 *   4. Spawn env construction.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Agent } from '@/types';

const fsMocks = vi.hoisted(() => ({
  readTextFile: vi.fn(),
  writeTextFile: vi.fn(),
}));

vi.mock('@/lib/fs', () => ({
  readTextFile: fsMocks.readTextFile,
  writeTextFile: fsMocks.writeTextFile,
}));

vi.mock('@/lib/db', () => ({
  projectRepo: {
    getById: vi.fn(async (id: string) =>
      id === 'proj_ctx'
        ? { id, system_prompt_context: 'Project context blob: ship v2 safely.' }
        : undefined,
    ),
  },
}));

import {
  BASE_TERMINAL_AGENT_RULES,
  MANAGED_BLOCK_END,
  MANAGED_BLOCK_START,
  agentsFilePath,
  buildAgentSpawnEnv,
  buildTerminalAgentInjectionMessage,
  composeAgentBriefing,
  coordinationFilePath,
  defaultCoordinationDoc,
  deliverAgentTerminalContext,
  detectInteractiveAgentCli,
  gatherSiblingAgentActivity,
  joinPath,
  mergeManagedBlock,
  resolveAgentForSlug,
  summarizeContextTree,
  wrapManagedBlock,
} from './agentPromptDelivery';
import { useAgentStore } from '@/stores/agents';
import { useTerminalTranscriptStore } from './transcriptStore';
import type { ProjectContextTree } from '@/features/context/tree';

function makeAgent(slug: string, name: string, system_prompt: string): Agent {
  return {
    id: `agent_${slug}`,
    slug,
    name,
    description: '',
    system_prompt,
    model: { provider: 'mock', model: 'mock-default' },
    tools_allowed: ['*'],
    memory_scope: 'project',
    temperature: 0.7,
    max_output_tokens: 4096,
    color_hue: 10,
    capabilities: [],
    builtin: true,
    created_at: 1,
    updated_at: 1,
  } as unknown as Agent;
}

beforeEach(() => {
  fsMocks.readTextFile.mockReset();
  fsMocks.writeTextFile.mockReset();
  useAgentStore.setState({ agents: {}, runStates: {}, verbs: {}, tokens: {} });
  useTerminalTranscriptStore.getState().reset();
});

/* -------------------------------------------------------------------------- */
/*  Path helpers                                                              */
/* -------------------------------------------------------------------------- */

describe('path helpers', () => {
  it('joins with the separator style of the directory', () => {
    expect(joinPath('C:\\repo\\proj', 'AGENTS.md')).toBe('C:\\repo\\proj\\AGENTS.md');
    expect(joinPath('/home/dev/proj/', 'AGENTS.md')).toBe('/home/dev/proj/AGENTS.md');
  });

  it('builds the AGENTS.md and coordination doc paths in the session cwd', () => {
    expect(agentsFilePath('C:\\repo')).toBe('C:\\repo\\AGENTS.md');
    expect(coordinationFilePath('C:\\repo')).toBe('C:\\repo\\.jarvis-coordination.md');
  });
});

/* -------------------------------------------------------------------------- */
/*  Composition                                                               */
/* -------------------------------------------------------------------------- */

describe('composeAgentBriefing', () => {
  const baseInputs = {
    agentSlug: 'coder',
    agentName: 'Coder',
    agentPrompt: 'You write code. The code word is APPLE.',
    projectName: 'VibeSpace',
    projectContext: 'This project ships a desktop AI workspace.',
    contextMapSummary: 'Top-level areas:\n- app/src — React frontend',
    otherAgents: [
      { agentSlug: 'reviewer', command: 'opencode', idleMs: 12_000, lastLine: 'Reviewing diff…' },
    ],
    coordinationFilePath: 'C:\\repo\\.jarvis-coordination.md',
  };

  it('includes the user-editable agent prompt (code word regression)', () => {
    const briefing = composeAgentBriefing(baseInputs);
    expect(briefing).toContain('The code word is APPLE.');
  });

  it('includes every required section', () => {
    const briefing = composeAgentBriefing(baseInputs);
    expect(briefing).toContain('## Your instructions (Coder)');
    expect(briefing).toContain(BASE_TERMINAL_AGENT_RULES);
    expect(briefing).toContain('## Project context');
    expect(briefing).toContain('This project ships a desktop AI workspace.');
    expect(briefing).toContain('## Project context map');
    expect(briefing).toContain('app/src — React frontend');
    expect(briefing).toContain('## Other agents currently in this workspace');
    expect(briefing).toContain('`reviewer`');
    expect(briefing).toContain('running `opencode`');
    expect(briefing).toContain('Reviewing diff…');
    expect(briefing).toContain('## Coordination document (required reading)');
    expect(briefing).toContain('C:\\repo\\.jarvis-coordination.md');
  });

  it('orders the agent prompt before the shared rules and coordination pointer', () => {
    const briefing = composeAgentBriefing(baseInputs);
    const promptIdx = briefing.indexOf('## Your instructions');
    const rulesIdx = briefing.indexOf('## Shared rules');
    const coordIdx = briefing.indexOf('## Coordination document');
    expect(promptIdx).toBeGreaterThan(-1);
    expect(rulesIdx).toBeGreaterThan(promptIdx);
    expect(coordIdx).toBeGreaterThan(rulesIdx);
  });

  it('omits empty optional sections', () => {
    const briefing = composeAgentBriefing({
      agentSlug: 'coder',
      agentName: 'Coder',
      agentPrompt: 'Prompt.',
      coordinationFilePath: '/p/.jarvis-coordination.md',
    });
    expect(briefing).not.toContain('## Project context\n');
    expect(briefing).not.toContain('## Project context map');
    expect(briefing).not.toContain('## Other agents');
  });

  it('truncates an oversized agent prompt instead of dumping it whole', () => {
    const briefing = composeAgentBriefing({
      ...baseInputs,
      agentPrompt: 'X'.repeat(50_000),
    });
    expect(briefing.length).toBeLessThan(30_000);
    expect(briefing).toContain('…[truncated by VibeSpace]');
  });
});

/* -------------------------------------------------------------------------- */
/*  Managed block merging                                                     */
/* -------------------------------------------------------------------------- */

describe('mergeManagedBlock', () => {
  const block = wrapManagedBlock('# Briefing v1\ncontent one');
  const blockV2 = wrapManagedBlock('# Briefing v2\ncontent two');

  it('creates a new file from just the block', () => {
    const merged = mergeManagedBlock(null, block);
    expect(merged).toBe(`${block}\n`);
    expect(merged).toContain(MANAGED_BLOCK_START);
    expect(merged).toContain(MANAGED_BLOCK_END);
  });

  it('appends after user content when no markers exist', () => {
    const merged = mergeManagedBlock('# My own rules\nDo not break prod.\n', block);
    expect(merged?.startsWith('# My own rules\nDo not break prod.')).toBe(true);
    expect(merged).toContain('content one');
  });

  it('replaces only the managed region on agent switch', () => {
    const existing = `# User header\n\n${block}\n\n# User footer\n`;
    const merged = mergeManagedBlock(existing, blockV2);
    expect(merged).toContain('# User header');
    expect(merged).toContain('# User footer');
    expect(merged).toContain('content two');
    expect(merged).not.toContain('content one');
    // Exactly one managed block remains.
    expect(merged?.split(MANAGED_BLOCK_START)).toHaveLength(2);
  });

  it('removes the managed region when the agent is cleared', () => {
    const existing = `# User header\n\n${block}\n\n# User footer\n`;
    const merged = mergeManagedBlock(existing, null);
    expect(merged).toContain('# User header');
    expect(merged).toContain('# User footer');
    expect(merged).not.toContain(MANAGED_BLOCK_START);
    expect(merged).not.toContain('content one');
  });

  it('returns null (no write needed) when clearing a file without markers', () => {
    expect(mergeManagedBlock('# Only user content\n', null)).toBeNull();
    expect(mergeManagedBlock(null, null)).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/*  Coordination doc + context map summary + env                              */
/* -------------------------------------------------------------------------- */

describe('defaultCoordinationDoc', () => {
  it('contains usage rules and the claims table', () => {
    const doc = defaultCoordinationDoc('VibeSpace');
    expect(doc).toContain('VibeSpace');
    expect(doc).toContain('## Active claims');
    expect(doc).toContain('| Agent | Task / files | Status | Updated |');
    expect(doc).toContain('never delete or rewrite another agent');
  });
});

describe('summarizeContextTree', () => {
  it('returns empty for a missing tree', () => {
    expect(summarizeContextTree(null)).toBe('');
  });

  it('summarises root, entry points, and top-level nodes', () => {
    const tree: ProjectContextTree = {
      version: 1,
      projectId: 'p1',
      rootDir: 'C:\\repo',
      generatedAt: 1,
      model: 'local',
      fileCount: 10,
      totalBytes: 1000,
      summary: 'Desktop AI workspace.',
      recommendedEntryPoints: ['app/src/App.tsx'],
      nodes: [
        { id: 'n1', title: 'Frontend', kind: 'area', summary: 'React UI', path: 'app/src' },
      ],
    };
    const summary = summarizeContextTree(tree);
    expect(summary).toContain('Desktop AI workspace.');
    expect(summary).toContain('C:\\repo');
    expect(summary).toContain('app/src/App.tsx');
    expect(summary).toContain('- Frontend (`app/src`) — React UI');
  });
});

describe('buildAgentSpawnEnv', () => {
  it('includes file-path vars when the cwd is known', () => {
    const env = buildAgentSpawnEnv({
      agentSlug: 'coder',
      agentName: 'Coder',
      cwd: 'C:\\repo',
      projectName: 'VibeSpace',
    });
    expect(env).toEqual({
      JARVIS_AGENT_SLUG: 'coder',
      JARVIS_AGENT_NAME: 'Coder',
      JARVIS_PROJECT_NAME: 'VibeSpace',
      JARVIS_AGENTS_FILE: 'C:\\repo\\AGENTS.md',
      JARVIS_COORDINATION_FILE: 'C:\\repo\\.jarvis-coordination.md',
    });
  });

  it('omits path vars when the cwd is unknown', () => {
    const env = buildAgentSpawnEnv({ agentSlug: 'coder' });
    expect(env).toEqual({ JARVIS_AGENT_SLUG: 'coder' });
  });
});

describe('interactive CLI injection helpers', () => {
  it('detects an already-running OpenCode pane from recent output', () => {
    expect(
      detectInteractiveAgentCli({
        command: 'powershell',
        transcript: 'Build · Nemotron 3 Ultra Free · OpenCode Zen\nctrl+p commands',
      }),
    ).toBe(true);
  });

  it('does not treat a plain shell transcript as an agent CLI', () => {
    expect(
      detectInteractiveAgentCli({
        command: 'powershell',
        transcript: 'PS C:\\repo> git status\nOn branch main',
      }),
    ).toBe(false);
  });

  it('builds a first-message prelude with the selected agent prompt and user message', async () => {
    useAgentStore.getState().registerAgent(
      makeAgent('critic', 'Critic', 'You are the Critic. The code word is APPLE.'),
    );

    const message = await buildTerminalAgentInjectionMessage({
      agentSlug: 'critic',
      userInput: 'what is your code word?',
      cwd: 'C:\\repo',
      projectId: 'proj_ctx',
      projectName: 'VibeSpace',
    });

    expect(message).toContain('Treat everything in <vibespace_system_prompt>');
    expect(message).toContain('You are the Critic. The code word is APPLE.');
    expect(message).toContain('Project context blob: ship v2 safely.');
    expect(message).toContain('User message:\nwhat is your code word?');
  });
});

/* -------------------------------------------------------------------------- */
/*  Store-backed gathering                                                    */
/* -------------------------------------------------------------------------- */

describe('resolveAgentForSlug', () => {
  it('returns the registered agent name and editable prompt', () => {
    useAgentStore.getState().registerAgent(makeAgent('coder', 'Coder', 'The code word is APPLE.'));
    const resolved = resolveAgentForSlug('coder');
    expect(resolved.name).toBe('Coder');
    expect(resolved.prompt).toContain('The code word is APPLE.');
  });

  it('falls back to the slug for unknown agents', () => {
    expect(resolveAgentForSlug('ghost')).toEqual({ name: 'ghost', prompt: '' });
  });
});

describe('gatherSiblingAgentActivity', () => {
  it('lists same-project agent sessions, excluding the caller', () => {
    const store = useTerminalTranscriptStore.getState();
    store.registerSession('pty_self', { agentSlug: 'coder', projectId: 'p1' });
    store.registerSession('pty_sib', { agentSlug: 'reviewer', command: 'opencode', projectId: 'p1' });
    store.registerSession('pty_other_proj', { agentSlug: 'writer', projectId: 'p2' });
    store.registerSession('pty_untagged', { agentSlug: null, projectId: 'p1' });
    store.appendOutput('pty_sib', 'checking tests\nreviewing diff now\n');

    const siblings = gatherSiblingAgentActivity({ projectId: 'p1', excludeSessionId: 'pty_self' });
    expect(siblings).toHaveLength(1);
    expect(siblings[0]?.agentSlug).toBe('reviewer');
    expect(siblings[0]?.command).toBe('opencode');
    expect(siblings[0]?.lastLine).toBe('reviewing diff now');
  });
});

/* -------------------------------------------------------------------------- */
/*  End-to-end delivery (mocked fs)                                           */
/* -------------------------------------------------------------------------- */

describe('deliverAgentTerminalContext', () => {
  const CWD = 'C:\\repo';
  const AGENTS = 'C:\\repo\\AGENTS.md';
  const COORD = 'C:\\repo\\.jarvis-coordination.md';

  const notFound = (path: string) => ({ ok: false as const, error: { code: 'not_found' as const }, path });
  const okRead = (path: string, content: string) => ({ ok: true as const, content, path });
  const okWrite = (path: string) => ({ ok: true as const, path });

  function writtenContent(path: string): string | undefined {
    const call = [...fsMocks.writeTextFile.mock.calls].reverse().find((c) => c[0] === path);
    return call?.[1];
  }

  it('writes the coordination doc and an AGENTS.md containing the code word', async () => {
    useAgentStore.getState().registerAgent(makeAgent('coder', 'Coder', 'The code word is APPLE.'));
    fsMocks.readTextFile.mockImplementation(async (path: string) => notFound(path));
    fsMocks.writeTextFile.mockImplementation(async (path: string) => okWrite(path));

    const result = await deliverAgentTerminalContext({
      cwd: CWD,
      agentSlug: 'coder',
      projectId: 'proj_ctx',
      projectName: 'VibeSpace',
    });

    expect(result.ok).toBe(true);
    expect(result.agentsFilePath).toBe(AGENTS);
    expect(result.coordinationFilePath).toBe(COORD);

    const coordination = writtenContent(COORD);
    expect(coordination).toContain('## Active claims');

    const agentsMd = writtenContent(AGENTS);
    expect(agentsMd).toContain(MANAGED_BLOCK_START);
    expect(agentsMd).toContain('The code word is APPLE.');
    // Shared base prompt + project context + coordination pointer all land.
    expect(agentsMd).toContain('Shared operating rules for every agent');
    expect(agentsMd).toContain('Project context blob: ship v2 safely.');
    expect(agentsMd).toContain(COORD);
  });

  it('does not overwrite an existing coordination doc', async () => {
    useAgentStore.getState().registerAgent(makeAgent('coder', 'Coder', 'prompt'));
    fsMocks.readTextFile.mockImplementation(async (path: string) =>
      path === COORD ? okRead(path, 'existing claims') : notFound(path),
    );
    fsMocks.writeTextFile.mockImplementation(async (path: string) => okWrite(path));

    await deliverAgentTerminalContext({ cwd: CWD, agentSlug: 'coder' });

    expect(fsMocks.writeTextFile.mock.calls.some((c) => c[0] === COORD)).toBe(false);
    expect(fsMocks.writeTextFile.mock.calls.some((c) => c[0] === AGENTS)).toBe(true);
  });

  it('preserves user AGENTS.md content and replaces only the managed block on re-delivery', async () => {
    useAgentStore.getState().registerAgent(makeAgent('coder', 'Coder', 'old prompt v1'));
    fsMocks.readTextFile.mockImplementation(async (path: string) => notFound(path));
    fsMocks.writeTextFile.mockImplementation(async (path: string) => okWrite(path));
    await deliverAgentTerminalContext({ cwd: CWD, agentSlug: 'coder' });
    const firstWrite = writtenContent(AGENTS)!;

    // User adds their own rules around our block, then switches agents.
    const userAuthored = `# Team conventions\nUse pnpm.\n\n${firstWrite}`;
    useAgentStore.getState().registerAgent(makeAgent('reviewer', 'Reviewer', 'new prompt v2'));
    fsMocks.readTextFile.mockImplementation(async (path: string) =>
      path === AGENTS ? okRead(path, userAuthored) : okRead(path, 'claims'),
    );
    fsMocks.writeTextFile.mockClear();
    fsMocks.writeTextFile.mockImplementation(async (path: string) => okWrite(path));

    await deliverAgentTerminalContext({ cwd: CWD, agentSlug: 'reviewer' });
    const secondWrite = writtenContent(AGENTS)!;

    expect(secondWrite).toContain('# Team conventions');
    expect(secondWrite).toContain('new prompt v2');
    expect(secondWrite).not.toContain('old prompt v1');
    expect(secondWrite.split(MANAGED_BLOCK_START)).toHaveLength(2);
  });

  it('removes the managed block when the agent is cleared', async () => {
    const existing = `# Keep me\n\n${wrapManagedBlock('stale briefing')}\n`;
    fsMocks.readTextFile.mockImplementation(async (path: string) =>
      path === AGENTS ? okRead(path, existing) : notFound(path),
    );
    fsMocks.writeTextFile.mockImplementation(async (path: string) => okWrite(path));

    const result = await deliverAgentTerminalContext({ cwd: CWD, agentSlug: null });
    expect(result.ok).toBe(true);
    const cleared = writtenContent(AGENTS);
    expect(cleared).toContain('# Keep me');
    expect(cleared).not.toContain(MANAGED_BLOCK_START);
  });

  it('is a no-op when clearing and no managed block exists', async () => {
    fsMocks.readTextFile.mockImplementation(async (path: string) =>
      path === AGENTS ? okRead(path, '# Pure user file\n') : notFound(path),
    );
    const result = await deliverAgentTerminalContext({ cwd: CWD, agentSlug: null });
    expect(result.ok).toBe(true);
    expect(fsMocks.writeTextFile).not.toHaveBeenCalled();
  });

  it('fails gracefully when the fs bridge is unavailable', async () => {
    fsMocks.readTextFile.mockImplementation(async (path: string) => ({
      ok: false as const,
      error: { code: 'unavailable' as const },
      path,
    }));
    const result = await deliverAgentTerminalContext({ cwd: CWD, agentSlug: 'coder' });
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
    expect(fsMocks.writeTextFile).not.toHaveBeenCalled();
  });

  it('reports a failed AGENTS.md write instead of throwing', async () => {
    useAgentStore.getState().registerAgent(makeAgent('coder', 'Coder', 'prompt'));
    fsMocks.readTextFile.mockImplementation(async (path: string) => notFound(path));
    fsMocks.writeTextFile.mockImplementation(async (path: string) =>
      path === AGENTS
        ? { ok: false as const, error: { code: 'unknown' as const, raw: 'disk full' }, path }
        : okWrite(path),
    );
    const result = await deliverAgentTerminalContext({ cwd: CWD, agentSlug: 'coder' });
    expect(result.ok).toBe(false);
    expect(result.error).toBe('disk full');
  });
});
