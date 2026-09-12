import { describe, expect, it } from 'vitest';
import {
  SECTION_20_COMMANDS,
  SLASH_COMMAND_ALIASES,
  classifySlashCommand,
  normalizeSlashCommand,
} from './slashCommandRouting';

const expected = {
  permissions: ['vibespace-ui', 'local'],
  ask: ['opencode-agent', 'agent-request'],
  plan: ['opencode-agent', 'agent-request'],
  agent: ['vibespace-ui', 'local'],
  multitask: ['opencode-agent', 'agent-request'],
  subagents: ['opencode-agent', 'agent-request'],
  terminals: ['vibespace-context', 'reference'],
  context: ['vibespace-context', 'attachment'],
  plug: ['vibespace-tool', 'attachment'],
  skills: ['vibespace-context', 'attachment'],
  allaboutme: ['vibespace-context', 'attachment'],
  hive: ['opencode-agent', 'agent-request'],
  file: ['vibespace-context', 'attachment'],
  md: ['opencode-agent', 'structured-agent-request'],
  model: ['vibespace-ui', 'local'],
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
  theme: ['vibespace-ui', 'local'],
  appearance: ['vibespace-ui', 'local'],
  undo: ['vibespace-ui', 'local'],
  redo: ['vibespace-ui', 'local'],
  commands: ['vibespace-ui', 'local'],
  help: ['vibespace-ui', 'local'],
} as const;

describe('Section 20 slash command routing', () => {
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
    expect(classifySlashCommand('nope')).toBeUndefined();
    expect(classifySlashCommand('//help')).toBeUndefined();
    expect(classifySlashCommand('')).toBeUndefined();
  });
});
