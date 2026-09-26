import { describe, expect, it } from 'vitest';
import {
  SECTION_20_COMMANDS,
  SLASH_COMMAND_ALIASES,
  buildVibeSpaceReferenceRequest,
  classifySlashCommand,
  normalizeSlashCommand,
} from './slashCommandRouting';

const expected = {
  vibecheck: ['vibespace-ui', 'local'],
  permissions: ['vibespace-ui', 'local'],
  ask: ['opencode-agent', 'agent-request'],
  plan: ['opencode-agent', 'agent-request'],
  goal: ['opencode-agent', 'agent-request'],
  agent: ['vibespace-ui', 'local'],
  multitask: ['opencode-agent', 'agent-request'],
  subagents: ['opencode-agent', 'agent-request'],
  terminals: ['vibespace-context', 'reference'],
  notes: ['vibespace-context', 'attachment'],
  context: ['vibespace-context', 'attachment'],
  plug: ['vibespace-tool', 'attachment'],
  skills: ['vibespace-context', 'attachment'],
  allaboutme: ['vibespace-context', 'attachment'],
  hive: ['opencode-agent', 'agent-request'],
  file: ['vibespace-context', 'attachment'],
  md: ['opencode-agent', 'structured-agent-request'],
  model: ['vibespace-ui', 'local'],
  cao: ['vibespace-ui', 'local'],
  effort: ['vibespace-ui', 'local'],
  fast: ['vibespace-ui', 'local'],
  performance: ['vibespace-ui', 'local'],
  rlm: ['vibespace-ui', 'local'],
  access: ['vibespace-ui', 'local'],
  approveall: ['vibespace-ui', 'local'],
  mode: ['vibespace-ui', 'local'],
  attach: ['vibespace-context', 'attachment'],
  clearfiles: ['vibespace-ui', 'local'],
  output: ['vibespace-ui', 'local'],
  kanban: ['vibespace-context', 'reference'],
  canvas: ['vibespace-context', 'attachment'],
  history: ['vibespace-context', 'reference'],
  tools: ['vibespace-context', 'reference'],
  agents: ['vibespace-context', 'reference'],
  schedule: ['vibespace-tool', 'reference'],
  chat: ['vibespace-ui', 'local'],
  usage: ['vibespace-ui', 'local'],
  doctor: ['vibespace-ui', 'local'],
  mcp: ['vibespace-ui', 'local'],
  theme: ['vibespace-ui', 'local'],
  appearance: ['vibespace-ui', 'local'],
  undo: ['vibespace-ui', 'local'],
  redo: ['vibespace-ui', 'local'],
  commands: ['vibespace-ui', 'local'],
  help: ['vibespace-ui', 'local'],
  connect: ['vibespace-ui', 'local'],
  cli: ['vibespace-ui', 'local'],
  settings: ['vibespace-ui', 'local'],
  palette: ['vibespace-ui', 'local'],
  launcher: ['vibespace-ui', 'local'],
  back: ['vibespace-ui', 'local'],
} as const;

describe('Section 20 slash command routing', () => {
  it.each([
    'Run this check tomorrow:\n```python\nif ready:\n    print("two  spaces")\n```',
    'Keep the Markdown hard break.  \nNext line; then a\ttab.',
    '  A naïve café 🧪\r\n    preserve indentation\r\n  ',
  ])('preserves the exact reference request payload: %s', (request) => {
    expect(buildVibeSpaceReferenceRequest('schedule', request)).toBe(
      `Context references: /schedule references Schedule. User request: ${request}`,
    );
  });

  it.each(['', ' \n\t\r\n '])('omits a whitespace-only reference request: %j', (request) => {
    expect(buildVibeSpaceReferenceRequest('schedule', request)).toBe(
      'Context references: /schedule references Schedule.',
    );
  });

  it('freezes the complete canonical command, owner, and execution matrix', () => {
    expect(SECTION_20_COMMANDS).toEqual(Object.keys(expected));
    expect(
      Object.fromEntries(
        SECTION_20_COMMANDS.map((command) => {
          const route = classifySlashCommand(command);
          return [command, [route?.owner, route?.execution]];
        }),
      ),
    ).toEqual(expected);
  });

  it('preserves every intentional and typo-compatible alias', () => {
    expect(SLASH_COMMAND_ALIASES).toEqual({
      terminal: 'terminals',
      contextmap: 'context',
      contexts: 'context',
      multitaksk: 'multitask',
      multiatask: 'multitask',
      mulititask: 'multitask',
      multitaks: 'multitask',
      subagent: 'subagents',
      suabagent: 'subagents',
      subagnts: 'subagents',
      subagens: 'subagents',
      clearfile: 'clearfiles',
      'clear-files': 'clearfiles',
      cearfile: 'clearfiles',
      cearfiles: 'clearfiles',
      permission: 'permissions',
      perms: 'permissions',
      'approve-all': 'approveall',
      themes: 'theme',
    });

    for (const [alias, canonical] of Object.entries(SLASH_COMMAND_ALIASES)) {
      expect(normalizeSlashCommand(alias)).toBe(canonical);
      expect(classifySlashCommand(`/${alias}`)?.command).toBe(canonical);
    }
  });

  it('is case-insensitive, strips one slash, and rejects unknown or malformed input', () => {
    expect(classifySlashCommand('/PeRmIsSiOnS extra words')).toMatchObject({
      command: 'permissions',
      owner: 'vibespace-ui',
    });
    expect(classifySlashCommand('/ACCESS')).toMatchObject({ command: 'access' });
    expect(classifySlashCommand('/approve-all on')).toMatchObject({ command: 'approveall' });
    expect(classifySlashCommand('/connect openrouter')).toMatchObject({
      command: 'connect',
      owner: 'vibespace-ui',
      execution: 'local',
    });
    expect(classifySlashCommand('/cli codex')).toMatchObject({
      command: 'cli',
      owner: 'vibespace-ui',
      execution: 'local',
    });
    expect(classifySlashCommand('nope')).toBeUndefined();
    expect(classifySlashCommand('//help')).toBeUndefined();
    expect(classifySlashCommand('')).toBeUndefined();
  });
});
