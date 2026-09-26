import { describe, expect, it } from 'vitest';
import { JARVIS_COMMAND_CATALOG } from './commands';

describe('Jarvis command examples', () => {
  it('retains native CLI launch and terminal messaging without suggesting direct shell execution', () => {
    expect(JARVIS_COMMAND_CATALOG).toContain('open opencode');
    expect(JARVIS_COMMAND_CATALOG).toContain('open 4 terminals with opencode');
    expect(JARVIS_COMMAND_CATALOG).toContain('message terminal 3: run npm test');
    expect(JARVIS_COMMAND_CATALOG).toContain('give all terminals all context');
    expect(JARVIS_COMMAND_CATALOG).not.toContain('run npm test in all terminals');
    expect(JARVIS_COMMAND_CATALOG).not.toContain('run pnpm install in all terminals');
    expect(JARVIS_COMMAND_CATALOG).not.toContain('run npm run build in all terminals');
    expect(JARVIS_COMMAND_CATALOG).not.toContain('run git status in all terminals');
    expect(JARVIS_COMMAND_CATALOG).not.toContain('create command dev server to run npm run dev');
    expect(JARVIS_COMMAND_CATALOG).not.toContain('run command dev server');
  });
});
