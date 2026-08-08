import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(resolve(process.cwd(), 'src/features/chat/ChatView.tsx'), 'utf8');

describe('ChatView Browser Goal activation', () => {
  it('mounts the compact Browser goal status in normal chat before the existing composer', () => {
    const thread = source.indexOf('<ChatThread');
    const goal = source.indexOf('<BrowserGoalStatus');
    const composer = source.indexOf('<Composer');
    expect(thread).toBeGreaterThan(0);
    expect(goal).toBeGreaterThan(thread);
    expect(composer).toBeGreaterThan(goal);
  });

  it('preserves native chat and mounts the dedicated Browser Chat hub only for the browser engine', () => {
    expect(source).toContain("engine === 'browser'");
    expect(source).toContain('<BrowserChatHub');
    expect(source).toContain('<ChatThread');
    expect(source).toContain('<Composer');
    expect(source).not.toMatch(/setSelectedModel|setDefaultProvider/);
    expect(source).toContain('TokenBossCinematic');
  });
});
