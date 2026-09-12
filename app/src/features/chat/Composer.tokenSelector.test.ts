import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('Composer token-mode access', () => {
  it('keeps token optimization in slash commands without mounting a footer selector', () => {
    const composer = readFileSync(resolve('src/features/chat/Composer.tsx'), 'utf8');
    const slashCommands = readFileSync(
      resolve('src/features/chat/SlashCommandTypeahead.tsx'),
      'utf8',
    );

    expect(composer).not.toContain('<TokenOptimizationChatControl');
    expect(composer).toContain('automaticModelRoutingEligible: false');
    expect(slashCommands).toContain("cmd: 'mode'");
    expect(slashCommands).toContain('Token Saver, Normal, or Token Final Boss');
  });
});
