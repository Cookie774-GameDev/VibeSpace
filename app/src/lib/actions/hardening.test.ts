/**
 * @file Tests for the hardened action runner — param type coercion,
 *       URL guarding, and shell-meta rejection on terminal actions.
 *
 * The runner now coerces strings → numbers / booleans where the spec
 * declared a non-string type, and the registry's `terminal.*` actions
 * reject paths that could break out of the `cd "<cwd>"` interpolation.
 * These tests pin both behaviours so the AI can't accidentally cause a
 * shell injection by proposing a clever cwd, and so the user gets a
 * clear error rather than a silent NaN propagating through the runner.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/components/ui/toast', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
  },
}));

import { runAction } from '@/lib/actions/runner';
import { useToolStore } from '@/features/tools/toolStore';
import { useUIStore } from '@/stores/ui';
import { useTerminalCommandQueue } from '@/features/terminals/terminalCommandQueue';

describe('runAction param coercion', () => {
  beforeEach(() => {
    useToolStore.setState({ tools: [] });
    useTerminalCommandQueue.getState().clear();
    // Make sure each test starts with a known route so navigation
    // assertions don't depend on the previous test's state.
    useUIStore.getState().setRoute('chat');
  });

  it('coerces a numeric-string into a number for number-typed params', async () => {
    // wellness.eyeBreak's `durationSec` is `type: 'number'`. The actions
    // palette uses `<input type="number">` whose value is always a
    // string — without coercion the action would treat "30" as invalid
    // and silently fall back to the default of 20.
    const result = await runAction(
      'wellness.eyeBreak',
      { durationSec: '30' },
      { source: 'user' },
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.summary).toBe('Eye break for 30s.');
  });

  it('rejects non-numeric strings on number-typed params', async () => {
    const result = await runAction(
      'wellness.eyeBreak',
      { durationSec: 'banana' },
      { source: 'user' },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/durationSec/);
      expect(result.error).toMatch(/number/);
    }
  });

  it('rejects array-shaped string params instead of stringifying them', async () => {
    // host.openUrl declares url as a string. An object/array would
    // previously coerce to "[object Object]" and bypass the URL check.
    const result = await runAction(
      'host.openUrl',
      { url: ['https://example.com'] as unknown },
      { source: 'user' },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/string/);
  });

  it('aggregates every parameter problem in a single error', async () => {
    // terminal.run has a required string `command`. Send wrong-type
    // command and an out-of-spec extra — only `command` is declared,
    // unknown keys are allowed through verbatim, so the only error
    // should be the missing required param.
    const result = await runAction(
      'terminal.run',
      {},
      { source: 'user' },
      { emitToast: false },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/Missing required.*command/i);
  });
});

describe('terminal action shell-injection guard', () => {
  beforeEach(() => {
    useToolStore.setState({ tools: [] });
    useTerminalCommandQueue.getState().clear();
    useUIStore.getState().setRoute('chat');
  });

  it('rejects a cwd containing a quote that would close the cd target', async () => {
    const result = await runAction(
      'terminal.claude',
      { cwd: 'C:\\proj"; rm -rf /' },
      { source: 'user' },
      { emitToast: false },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/metacharacter/i);
  });

  it('rejects a cwd containing a semicolon that would chain a command', async () => {
    const result = await runAction(
      'terminal.opencode',
      { cwd: '/tmp; whoami' },
      { source: 'user' },
      { emitToast: false },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/metacharacter/i);
  });

  it('rejects a cwd containing a backtick command-substitution', async () => {
    const result = await runAction(
      'terminal.run',
      { command: 'npm test', cwd: '/tmp/`whoami`' },
      { source: 'user' },
      { emitToast: false },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/metacharacter/i);
  });

  it('accepts a normal Windows path with spaces and parens', async () => {
    const result = await runAction(
      'terminal.claude',
      { cwd: 'C:\\Program Files (x86)\\my-app' },
      { source: 'user' },
      { emitToast: false },
    );
    expect(result.ok).toBe(true);
  });

  it('accepts a normal POSIX path', async () => {
    const result = await runAction(
      'terminal.opencode',
      { cwd: '/Users/me/projects/my-app' },
      { source: 'user' },
      { emitToast: false },
    );
    expect(result.ok).toBe(true);
  });

  it('navigates to the Terminals page after queueing', async () => {
    expect(useUIStore.getState().route).toBe('chat');
    const result = await runAction(
      'terminal.claude',
      {},
      { source: 'user' },
      { emitToast: false },
    );
    expect(result.ok).toBe(true);
    expect(useUIStore.getState().route).toBe('terminal');
  });
});

describe('terminal targeted command actions', () => {
  beforeEach(() => {
    useToolStore.setState({ tools: [] });
    useTerminalCommandQueue.getState().clear();
    useUIStore.getState().setRoute('chat');
  });

  it('queues a command for a dragged terminal ref without opening a new pane', async () => {
    const result = await runAction(
      'terminal.sendToRefs',
      { command: 'opencode', paneId: 'pane_1', sessionId: 'pty_1' },
      { source: 'ai' },
      { emitToast: false },
    );

    expect(result.ok).toBe(true);
    expect(useUIStore.getState().route).toBe('terminal');
    const queued = useTerminalCommandQueue.getState().drain();
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({
      kind: 'shell',
      command: 'opencode',
      target: 'refs',
      refs: [{ paneId: 'pane_1', sessionId: 'pty_1' }],
    });
  });

  it('accepts refsJson for multi-terminal targeted sends', async () => {
    const result = await runAction(
      'terminal.sendToRefs',
      {
        command: 'npm test',
        refsJson: JSON.stringify([
          { paneId: 'pane_a', sessionId: 'pty_a' },
          { paneId: 'pane_b', sessionId: 'pty_b' },
        ]),
      },
      { source: 'ai' },
      { emitToast: false },
    );

    expect(result.ok).toBe(true);
    const queued = useTerminalCommandQueue.getState().drain();
    expect(queued[0]).toMatchObject({
      kind: 'shell',
      command: 'npm test',
      target: 'refs',
    });
    expect((queued[0] as { refs?: unknown[] }).refs).toHaveLength(2);
  });

  it('rejects targeted sends without a terminal ref', async () => {
    const result = await runAction(
      'terminal.sendToRefs',
      { command: 'opencode' },
      { source: 'ai' },
      { emitToast: false },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/paneId|sessionId|refsJson/);
    expect(useTerminalCommandQueue.getState().drain()).toHaveLength(0);
  });

  it('queues broadcast sends for all existing panes', async () => {
    const result = await runAction(
      'terminal.sendAll',
      { command: 'git status' },
      { source: 'ai' },
      { emitToast: false },
    );

    expect(result.ok).toBe(true);
    const queued = useTerminalCommandQueue.getState().drain();
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({
      kind: 'shell',
      command: 'git status',
      target: 'all',
    });
  });
});

describe('host.openUrl', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('refuses non-http(s) URLs to prevent file:// or javascript:', async () => {
    const result = await runAction(
      'host.openUrl',
      { url: 'javascript:alert(1)' },
      { source: 'user' },
      { emitToast: false },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/http/i);
  });

  it('accepts a normal https URL', async () => {
    const result = await runAction(
      'host.openUrl',
      { url: 'https://aistudio.google.com/apikey' },
      { source: 'user' },
      { emitToast: false },
    );
    expect(result.ok).toBe(true);
  });
});
