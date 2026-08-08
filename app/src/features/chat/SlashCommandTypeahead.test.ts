import { describe, expect, it } from 'vitest';
import { HelpCircle, Terminal, Wrench } from 'lucide-react';
import {
  SLASH_COMMANDS,
  findSlashCommandDef,
  isChatAttachSlashCmd,
  normalizeSlashCmd,
  orderSlashCommandsForDisplay,
  slashCmdMatchScore,
  type SlashCommandDef,
} from './SlashCommandTypeahead';

describe('orderSlashCommandsForDisplay', () => {
  it('matches the grouped visual order used by the slash dropdown', () => {
    const commands: SlashCommandDef[] = [
      { cmd: 'help', description: 'Help', icon: HelpCircle, category: 'utility' },
      { cmd: 'tools', description: 'Tools', icon: Wrench, category: 'navigation' },
      { cmd: 'terminals', description: 'Terminal', icon: Terminal, category: 'chat' },
    ];

    expect(orderSlashCommandsForDisplay(commands).map((cmd) => cmd.cmd)).toEqual([
      'terminals',
      'tools',
      'help',
    ]);
  });

  it('archives Hive in the full table but hides it from product resolution by default', () => {
    const hive = SLASH_COMMANDS.find((cmd) => cmd.cmd === 'hive');

    expect(hive).toMatchObject({
      cmd: 'hive',
      category: 'chat',
      description: 'Reference Hive Balanced in chat',
    });
    expect(SLASH_COMMANDS.some((cmd) => cmd.cmd === 'vibehive')).toBe(false);
    // Product gate: /hive is not findable while VITE_HIVE_ENABLED is off.
    expect(findSlashCommandDef('hive')).toBeUndefined();
  });

  it('does not duplicate terminal navigation and attach commands', () => {
    const terminalLike = SLASH_COMMANDS.filter((cmd) =>
      ['terminal', 'terminals'].includes(cmd.cmd),
    );
    expect(terminalLike).toHaveLength(1);
    expect(terminalLike[0]?.cmd).toBe('terminals');
    expect(SLASH_COMMANDS.some((cmd) => cmd.cmd === 'files')).toBe(false);
    expect(SLASH_COMMANDS.some((cmd) => cmd.cmd === 'contextmap')).toBe(false);
    expect(SLASH_COMMANDS.some((cmd) => cmd.cmd === 'skillspage')).toBe(false);
  });

  it('normalizes legacy slash spellings', () => {
    expect(normalizeSlashCmd('mode')).toBe('mode');
    expect(normalizeSlashCmd('terminal')).toBe('terminals');
    expect(normalizeSlashCmd('contextmap')).toBe('context');
    expect(normalizeSlashCmd('subagent')).toBe('subagents');
    expect(normalizeSlashCmd('suabagent')).toBe('subagents');
    expect(normalizeSlashCmd('subagnts')).toBe('subagents');
    expect(normalizeSlashCmd('multiatask')).toBe('multitask');
    expect(normalizeSlashCmd('multitaksk')).toBe('multitask');
    expect(normalizeSlashCmd('clearfile')).toBe('clearfiles');
    expect(normalizeSlashCmd('cearfile')).toBe('clearfiles');
  });

  it('keeps Agent, Plan, and Ask under the explicit /permissions picker', () => {
    expect(findSlashCommandDef('permissions')).toMatchObject({
      cmd: 'permissions',
      hasOptions: true,
      argPlaceholder: 'agent | plan | ask',
    });
  });

  it('registers /output for chat media inventory', () => {
    expect(findSlashCommandDef('output')).toMatchObject({
      cmd: 'output',
      category: 'chat',
    });
  });

  it('marks /file as a project-file attach picker command', () => {
    expect(findSlashCommandDef('file')?.hasOptions).toBe(true);
    expect(isChatAttachSlashCmd('file')).toBe(true);
  });

  it('offers /md as a structured Markdown document generator', () => {
    expect(findSlashCommandDef('md')).toMatchObject({
      cmd: 'md',
      category: 'chat',
      takesArg: true,
      hasOptions: true,
    });
  });

  it('marks /canvas as a structured Canvas attachment picker', () => {
    expect(findSlashCommandDef('canvas')).toMatchObject({
      category: 'navigation',
      description: 'Reference Canvas',
      hasOptions: true,
    });
    expect(isChatAttachSlashCmd('canvas')).toBe(true);
  });

  it('matches alias queries to the canonical command', () => {
    const terminals = SLASH_COMMANDS.find((cmd) => cmd.cmd === 'terminals')!;
    expect(slashCmdMatchScore('terminal', terminals)).toBeGreaterThan(0);
  });

  it('includes AllAboutMe as a four-option chat command', () => {
    const allAboutMe = SLASH_COMMANDS.find((cmd) => cmd.cmd === 'allaboutme');

    expect(allAboutMe).toMatchObject({
      cmd: 'allaboutme',
      category: 'chat',
      hasOptions: true,
    });
  });

  it('includes /subagents as a chat command for spawning model-matched child agents', () => {
    expect(SLASH_COMMANDS.find((cmd) => cmd.cmd === 'subagents')).toMatchObject({
      cmd: 'subagents',
      category: 'chat',
      takesArg: true,
    });
  });

  it('includes /undo and /redo utility commands', () => {
    expect(SLASH_COMMANDS.find((cmd) => cmd.cmd === 'undo')).toMatchObject({
      cmd: 'undo',
      category: 'utility',
    });
    expect(SLASH_COMMANDS.find((cmd) => cmd.cmd === 'redo')).toMatchObject({
      cmd: 'redo',
      category: 'utility',
    });
    expect(findSlashCommandDef('undo')?.cmd).toBe('undo');
    expect(findSlashCommandDef('redo')?.cmd).toBe('redo');
  });

  it('separates scoped /theme profiles from global /appearance', () => {
    expect(findSlashCommandDef('theme')).toMatchObject({
      cmd: 'theme',
      category: 'utility',
      takesArg: true,
      description: 'Style this agentic chat console',
      argPlaceholder: 'paper white | sakura mist | graphite | oled void',
    });
    expect(findSlashCommandDef('theme')?.hasOptions).toBe(true);
    expect(findSlashCommandDef('themes')).toMatchObject({
      cmd: 'themes',
      category: 'utility',
      takesArg: true,
      hasOptions: true,
      description: 'Choose the global VibeSpace appearance',
    });
    expect(findSlashCommandDef('appearance')).toMatchObject({
      cmd: 'appearance',
      category: 'utility',
      takesArg: true,
      hasOptions: true,
      description: 'Switch the global VibeSpace appearance',
    });
  });

  it('offers provider-aware effort and policy mode pickers', () => {
    expect(findSlashCommandDef('effort')).toMatchObject({
      cmd: 'effort',
      category: 'chat',
      takesArg: true,
      hasOptions: true,
    });
    expect(findSlashCommandDef('mode')).toMatchObject({
      cmd: 'mode',
      category: 'chat',
      takesArg: true,
      hasOptions: true,
    });
  });

  it('exposes Token Final Boss only through the /mode picker', () => {
    expect(findSlashCommandDef('mode')).toMatchObject({
      cmd: 'mode',
      hasOptions: true,
      argPlaceholder: 'token saver | normal | token final boss',
    });
    expect(findSlashCommandDef('token')).toBeUndefined();
    expect(SLASH_COMMANDS.some((cmd) => cmd.label === 'Token Boss')).toBe(false);
    expect(SLASH_COMMANDS.some((cmd) => cmd.displayCommand === '/token boss')).toBe(false);
  });
});
