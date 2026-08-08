import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const thread = readFileSync(resolve(__dirname, 'ChatThread.tsx'), 'utf8');
const prefs = readFileSync(resolve(__dirname, 'activity/chatActivityPreferences.ts'), 'utf8');
const consoleSrc = readFileSync(resolve(__dirname, 'agentic-console/AgenticConsole.tsx'), 'utf8');

describe('chat mini command center mount contract', () => {
  it('uses one header path per view: agentic SessionHeader, classic timeline (not both stacked)', () => {
    // Exactly two timeline mounts: agentic error fallback + classic path.
    // Never a third always-on timeline stacked with AgenticConsole SessionHeader.
    const timelineMounts = thread.match(/<ChatActivityTimeline\b/g) ?? [];
    expect(timelineMounts).toHaveLength(2);
    expect(thread).toMatch(/Fallback only:[\s\S]*ChatActivityTimeline/);
    expect(thread).toMatch(/Classic path:[\s\S]*ChatActivityTimeline/);
    expect(thread).toContain('Single top mini command center lives inside AgenticConsole');
    expect(thread).toContain('<AgenticConsole');
  });

  it('defaults the session panel preference to visible when unset', () => {
    expect(prefs).toMatch(/stored === null \? true/);
  });

  it('keeps agentic session header test id for the mini command center', () => {
    expect(consoleSrc).toContain('data-testid="jarvis-session-panel"');
    expect(consoleSrc).toContain('hasTranscriptWork');
    expect(consoleSrc).toContain('Expand all');
    expect(consoleSrc).toContain('Export session');
    expect(consoleSrc).toContain('Copy summary');
  });
});
