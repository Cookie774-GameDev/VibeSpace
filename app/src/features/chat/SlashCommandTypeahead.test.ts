import { act, render, screen } from '@testing-library/react';
import { createElement, createRef, useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { HelpCircle, Terminal, Wrench } from 'lucide-react';
import {
  SLASH_COMMANDS,
  findSlashCommandDef,
  getVisibleSlashCommands,
  isChatAttachSlashCmd,
  isImmediateLocalSlashCommand,
  normalizeSlashCmd,
  orderSlashCommandsForDisplay,
  resolveSlashCommandSelection,
  slashCmdMatchScore,
  SlashCommandTypeahead,
  type SlashCommandTypeaheadRef,
  type SlashCommandDef,
} from './SlashCommandTypeahead';
import { SECTION_20_COMMANDS, SLASH_COMMAND_ALIASES } from './slashCommandRouting';

describe('orderSlashCommandsForDisplay', () => {
  it('exposes /goal only for the Codex picker while retaining the live OpenCode dispatch path', () => {
    expect(findSlashCommandDef('goal')?.description).toBe(
      'Set a native Codex goal for this chat',
    );
    expect(getVisibleSlashCommands('codex').some((command) => command.cmd === 'goal')).toBe(true);
    expect(getVisibleSlashCommands('opencode').some((command) => command.cmd === 'goal')).toBe(false);
    expect(getVisibleSlashCommands().some((command) => command.cmd === 'goal')).toBe(false);
  });

  it('shows the canonical /mcp help text without requiring an optional label', () => {
    const mcp = findSlashCommandDef('mcp')!;

    render(
      createElement(SlashCommandTypeahead, {
        commands: [mcp],
        selectedCmd: mcp.cmd,
        query: 'mcp',
        onSelect: vi.fn(),
      }),
    );

    const option = screen.getByRole('option', { name: /\/mcp/i });
    expect(option.textContent).toContain('/mcp');
    expect(option.textContent).toContain('Open MCP connections and custom server management');
  });

  it('exposes a stable listbox and truthful keyboard-selected options', () => {
    const commands: SlashCommandDef[] = [
      { cmd: 'terminals', description: 'Terminal', icon: Terminal, category: 'chat' },
      { cmd: 'tools', description: 'Tools', icon: Wrench, category: 'navigation' },
      { cmd: 'help', description: 'Help', icon: HelpCircle, category: 'utility' },
    ];
    const pickerRef = createRef<SlashCommandTypeaheadRef>();
    const onSelect = vi.fn();

    function Harness() {
      const [selectedCmd, setSelectedCmd] = useState(commands[0]!.cmd);
      return createElement(SlashCommandTypeahead, {
        ref: pickerRef,
        commands,
        selectedCmd,
        query: '',
        onHoverCmd: setSelectedCmd,
        onSelect,
      });
    }

    render(createElement(Harness));

    const listbox = screen.getByRole('listbox', { name: 'Slash commands' });
    const options = screen.getAllByRole('option');
    expect(options).toHaveLength(3);
    expect(new Set(options.map((option) => option.id)).size).toBe(3);
    expect(options[0]?.getAttribute('aria-selected')).toBe('true');
    expect(options[1]?.getAttribute('aria-selected')).toBe('false');
    expect(pickerRef.current?.getListboxId()).toBe(listbox.id);
    expect(pickerRef.current?.getActiveDescendantId()).toBe(options[0]!.id);

    act(() => pickerRef.current?.moveDown());

    expect(options[0]?.getAttribute('aria-selected')).toBe('false');
    expect(options[1]?.getAttribute('aria-selected')).toBe('true');
    expect(pickerRef.current?.getActiveDescendantId()).toBe(options[1]!.id);
    act(() => pickerRef.current?.selectCurrent());
    expect(onSelect).toHaveBeenCalledWith(commands[1]);
  });

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

  it('prefers an exact command or alias over an earlier cross-category fuzzy selection', () => {
    const agents = SLASH_COMMANDS.find((cmd) => cmd.cmd === 'agents')!;
    const subagents = SLASH_COMMANDS.find((cmd) => cmd.cmd === 'subagents')!;
    const terminals = SLASH_COMMANDS.find((cmd) => cmd.cmd === 'terminals')!;

    expect(resolveSlashCommandSelection('agents', [subagents, agents], 'subagents')).toBe('agents');
    expect(resolveSlashCommandSelection('terminal', [terminals], '')).toBe('terminals');
    expect(resolveSlashCommandSelection('agen', [subagents, agents], 'subagents')).toBe(
      'subagents',
    );
  });

  it('selects the highest-scoring command prefix ahead of incidental description matches', () => {
    const candidates = SLASH_COMMANDS.map((command) => ({
      command,
      score: slashCmdMatchScore('conn', command),
    }))
      .filter(({ score }) => score > 0)
      .sort(
        (left, right) =>
          right.score - left.score || left.command.cmd.localeCompare(right.command.cmd),
      )
      .map(({ command }) => command);

    expect(candidates[0]?.cmd).toBe('connect');
    expect(candidates.some((command) => command.cmd === 'fast')).toBe(true);
    expect(resolveSlashCommandSelection('conn', candidates, '')).toBe('connect');
  });

  it('keeps every registered exact alias visible and selects its canonical command', () => {
    for (const [alias, canonical] of Object.entries(SLASH_COMMAND_ALIASES)) {
      const candidates = SLASH_COMMANDS.filter((command) => slashCmdMatchScore(alias, command) > 0);
      expect(
        candidates.map((command) => command.cmd),
        alias,
      ).toContain(canonical);
      const staleSelection = candidates.find((command) => command.cmd !== canonical)?.cmd ?? '';
      expect(resolveSlashCommandSelection(alias, candidates, staleSelection), alias).toBe(
        canonical,
      );
    }
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

  it('registers every canonical Section 20 command exactly once', () => {
    expect(SLASH_COMMANDS.map(({ cmd }) => cmd)).toEqual(SECTION_20_COMMANDS);
    expect(new Set(SLASH_COMMANDS.map(({ cmd }) => cmd)).size).toBe(SECTION_20_COMMANDS.length);
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
    expect(normalizeSlashCmd('themes')).toBe('theme');
  });

  it('keeps Agent, Plan, and Ask under the explicit /permissions picker', () => {
    expect(findSlashCommandDef('permissions')).toMatchObject({
      cmd: 'permissions',
      hasOptions: true,
      description: 'Choose Agent, Plan, or Ask mode',
      argPlaceholder: 'agent | plan | ask',
    });
  });

  it('registers /output for chat media inventory', () => {
    expect(findSlashCommandDef('output')).toMatchObject({
      cmd: 'output',
      category: 'chat',
    });
  });

  it('registers /doctor as a local repair command', () => {
    expect(findSlashCommandDef('doctor')).toMatchObject({
      cmd: 'doctor',
      category: 'utility',
      takesArg: true,
    });
  });

  it('registers /mcp as a local connection-manager command', () => {
    expect(findSlashCommandDef('mcp')).toMatchObject({
      cmd: 'mcp',
      category: 'utility',
      hasOptions: false,
    });
    expect(isImmediateLocalSlashCommand('mcp')).toBe(true);
    expect(isImmediateLocalSlashCommand('doctor')).toBe(true);
    expect(isImmediateLocalSlashCommand('usage')).toBe(false);
  });

  it('offers the five collision-free Instant commands as immediate local actions', () => {
    for (const command of ['connect', 'settings', 'palette', 'launcher', 'back']) {
      expect(findSlashCommandDef(command)).toMatchObject({
        cmd: command,
        category: 'utility',
      });
      expect(isImmediateLocalSlashCommand(command)).toBe(true);
    }
    expect(findSlashCommandDef('connect')).toMatchObject({
      takesArg: true,
      argPlaceholder: '[supported provider]',
    });
  });

  it('keeps picker-selected /usage executable instead of converting it to a decorative chip', () => {
    expect(findSlashCommandDef('usage')).toMatchObject({
      cmd: 'usage',
      category: 'utility',
      takesArg: true,
      argPlaceholder: '[refresh|session|all]',
    });
  });

  it('registers the actual OpenCode /goal command as a free-text agent request', () => {
    expect(findSlashCommandDef('goal')).toMatchObject({
      cmd: 'goal',
      category: 'chat',
      takesArg: true,
      argPlaceholder: '<objective>',
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
    expect(findSlashCommandDef('themes')).toMatchObject({ cmd: 'theme' });
    expect(findSlashCommandDef('appearance')).toMatchObject({
      cmd: 'appearance',
      category: 'utility',
      takesArg: true,
      hasOptions: true,
      description: 'Switch the global VibeSpace appearance',
    });
  });

  it('offers /rlm as a default-on context control', () => {
    expect(findSlashCommandDef('rlm')).toMatchObject({
      cmd: 'rlm',
      category: 'chat',
      takesArg: true,
      hasOptions: true,
      argPlaceholder: 'on | off | status | refresh | trace',
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

  it('offers /chat as a two-engine option picker instead of a navigation reference', () => {
    expect(findSlashCommandDef('chat')).toMatchObject({
      cmd: 'chat',
      category: 'chat',
      hasOptions: true,
    });
  });
});
