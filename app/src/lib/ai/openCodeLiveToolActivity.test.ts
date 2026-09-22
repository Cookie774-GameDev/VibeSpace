import { describe, expect, it } from 'vitest';
import { projectOpenCodeLiveToolActivity } from './openCodeLiveToolActivity';

describe('progressive OpenCode live tool activity', () => {
  it.each([
    ['task', 'coordination', 'Coordinating agents', 'Coordinated agents'],
    ['read', 'file', 'Reading file', 'Read file'],
    ['grep', 'context', 'Searching', 'Searched'],
    ['bash', 'context', 'Running command', 'Ran command'],
    ['apply_patch', 'writing', 'Editing file', 'Edited file'],
    ['verify', 'context', 'Verifying', 'Verified'],
    ['manual-browser', 'context', 'Using browser', 'Used browser'],
    ['mcp__playwright__browser_navigate', 'context', 'Using browser', 'Used browser'],
  ] as const)(
    'projects %s lifecycle updates into truthful %s semantics',
    (name, category, runningTitle, doneTitle) => {
      expect(projectOpenCodeLiveToolActivity({ name, status: 'started' })).toMatchObject({
        event: { category, status: 'running', title: runningTitle, subtitle: name },
        phase: { category, title: `Jarvis is ${runningTitle.toLocaleLowerCase('en-US')}` },
      });
      expect(projectOpenCodeLiveToolActivity({ name, status: 'completed' })).toMatchObject({
        event: { category, status: 'done', title: doneTitle, subtitle: name },
        phase: { category, title: `Jarvis ${doneTitle.toLocaleLowerCase('en-US')}` },
      });
    },
  );

  it('projects failed checks and commands as terminal errors instead of completed reads', () => {
    expect(projectOpenCodeLiveToolActivity({ name: 'manual-browser', status: 'failed' })).toMatchObject({
      event: { category: 'context', status: 'error', title: 'Browser tool failed', subtitle: 'manual-browser' },
    });
    expect(projectOpenCodeLiveToolActivity({ name: 'npm_test', status: 'failed' })).toMatchObject({
      event: { category: 'context', status: 'error', title: 'Verification failed' },
      phase: { category: 'context', title: 'Jarvis verification failed' },
    });
    expect(
      projectOpenCodeLiveToolActivity({ name: 'terminal.exec', status: 'failed' }),
    ).toMatchObject({
      event: { category: 'context', status: 'error', title: 'Command failed' },
      phase: { category: 'context', title: 'Jarvis command failed' },
    });
  });

  it('preserves only a safe leaf file label and keeps the tool identity separately visible', () => {
    expect(
      projectOpenCodeLiveToolActivity({
        name: 'write',
        status: 'started',
        fileLabel: 'C:\\Users\\viper\\project\\notes.md',
      }),
    ).toMatchObject({
      event: {
        category: 'writing',
        title: 'Editing file',
        subtitle: 'notes.md',
        filePath: 'notes.md',
      },
      phase: { category: 'writing', title: 'Jarvis is editing file', subtitle: 'notes.md' },
    });
  });

  it('falls back to a visible generic tool lifecycle without inventing a read', () => {
    expect(
      projectOpenCodeLiveToolActivity({ name: 'custom.safe_tool', status: 'started' }),
    ).toMatchObject({
      event: {
        category: 'context',
        status: 'running',
        title: 'Running tool',
        subtitle: 'custom.safe_tool',
      },
      phase: { category: 'context', title: 'Jarvis is running a tool' },
    });
  });

  it('rejects control-bearing or oversized public labels', () => {
    expect(() =>
      projectOpenCodeLiveToolActivity({ name: 'read\u0000secret', status: 'started' }),
    ).toThrow('opencode_live_tool_name_invalid');
    expect(() =>
      projectOpenCodeLiveToolActivity({ name: 'x'.repeat(257), status: 'started' }),
    ).toThrow('opencode_live_tool_name_invalid');
  });
});
