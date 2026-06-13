import { describe, expect, it } from 'vitest';
import { HelpCircle, Terminal, Wrench } from 'lucide-react';
import { orderSlashCommandsForDisplay, type SlashCommandDef } from './SlashCommandTypeahead';

describe('orderSlashCommandsForDisplay', () => {
  it('matches the grouped visual order used by the slash dropdown', () => {
    const commands: SlashCommandDef[] = [
      { cmd: 'help', description: 'Help', icon: HelpCircle, category: 'utility' },
      { cmd: 'tools', description: 'Tools', icon: Wrench, category: 'navigation' },
      { cmd: 'terminal', description: 'Terminal', icon: Terminal, category: 'action' },
    ];

    expect(orderSlashCommandsForDisplay(commands).map((cmd) => cmd.cmd)).toEqual([
      'terminal',
      'tools',
      'help',
    ]);
  });
});
