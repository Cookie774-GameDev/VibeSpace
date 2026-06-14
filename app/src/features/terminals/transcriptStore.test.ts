/**
 * @file Tests for the per-session transcript ring buffer.
 *
 * The store is the foundation for "what did Builder just do?" queries
 * in chat. Three things matter most:
 *   1. ANSI escape codes get stripped (the LLM doesn't want raw colour
 *      sequences in its prompt).
 *   2. The buffer stays bounded — long-running sessions don't grow
 *      memory linearly.
 *   3. The by-agent index reflects the user's latest re-tag.
 *
 * Tests pin all three plus the lifecycle calls TerminalView relies on
 * (`registerSession`, `forgetSession`).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  MAX_BYTES_PER_SESSION,
  deserializeTranscriptSessions,
  flushTranscriptStorage,
  getSessionTranscript,
  getSessionsForAgent,
  loadInitialSessions,
  stripAnsi,
  terminalRestoreText,
  useTerminalTranscriptStore,
} from '@/features/terminals/transcriptStore';

beforeEach(() => {
  useTerminalTranscriptStore.getState().reset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('stripAnsi', () => {
  it('removes CSI colour codes', () => {
    const input = '\x1B[31mhello\x1B[0m world';
    expect(stripAnsi(input)).toBe('hello world');
  });

  it('removes cursor movement sequences', () => {
    const input = 'before\x1B[2J\x1B[H\x1B[3;7Hafter';
    expect(stripAnsi(input)).toBe('beforeafter');
  });

  it('removes OSC sequences (window title, hyperlinks)', () => {
    const input = '\x1B]0;tab title\x07real text';
    expect(stripAnsi(input)).toBe('real text');
  });

  it('keeps newlines, tabs, and carriage returns', () => {
    const input = 'line1\nline2\tindented\r\nline3';
    expect(stripAnsi(input)).toBe('line1\nline2\tindented\r\nline3');
  });

  it('drops bell and other C0 control characters', () => {
    const input = 'beep\x07after\x0Cclear';
    expect(stripAnsi(input)).toBe('beepafterclear');
  });

  it('removes orphan CSI fragments from split PTY chunks', () => {
    expect(stripAnsi('[0mready[999Ddone\n[?25hnext')).toBe('readydone\nnext');
    expect(stripAnsi('array [0] stays')).toBe('array [0] stays');
  });

  it('removes orphan OSC palette fragments from split PTY chunks', () => {
    expect(stripAnsi(']4;6;rgb:12/34/56\x07ready')).toBe('ready');
    expect(stripAnsi('\x1B]4;6;rgb:12/34/56\x07ready')).toBe('ready');
    expect(stripAnsi(']10;rgb:ee/ee/ee\nprompt')).toBe('prompt');
    expect(stripAnsi('value ]10;rgb: stays')).toBe('value ]10;rgb: stays');
  });

  it('removes midline orphan fragments after PowerShell prompts', () => {
    expect(stripAnsi('PS C:\\Users\\dev> [0\nnext')).toBe('PS C:\\Users\\dev> \nnext');
    expect(stripAnsi('PS C:\\Users\\dev> [I\nnext')).toBe('PS C:\\Users\\dev> \nnext');
    expect(stripAnsi('PS C:\\Users\\dev> [0[[0[0[0[\nnext')).toBe('PS C:\\Users\\dev> \nnext');
    expect(stripAnsi('PS C:\\Users\\dev> [0[I\nnext')).toBe('PS C:\\Users\\dev> \nnext');
    expect(stripAnsi('PS C:\\Users\\devuser>]4;0;rgb:2a2a/2020/1818[0[0[')).toBe(
      'PS C:\\Users\\devuser>',
    );
  });
});

describe('terminalRestoreText', () => {
  it('prefers safe plain transcript text over raw escape buffers', () => {
    const restored = terminalRestoreText({
      text: 'ready\nAPPLE\n',
      rawText: '\x1B[2J\x1B[0mready\x1B[999Dcorrupt',
    });

    expect(restored).toBe('ready\r\nAPPLE\r\n');
    expect(restored).not.toContain('\x1B');
    expect(restored).not.toContain('[0m');
  });

  it('sanitizes orphan CSI fragments from stored plain transcript text', () => {
    const restored = terminalRestoreText({
      text: '[0mready\nwork[999Ddone\n[?25h',
    });

    expect(restored).toBe('ready\r\nworkdone\r\n');
    expect(restored).not.toContain('[0m');
    expect(restored).not.toContain('[999D');
    expect(restored).not.toContain('[?25h');
  });

  it('sanitizes legacy orphan OSC palette fragments from stored text', () => {
    const restored = terminalRestoreText({
      text: ']4;6;rgb:12/34/56\x07ready\n]10;rgb:ee/ee/ee\nprompt',
    });

    expect(restored).toBe('ready\r\nprompt');
    expect(restored).not.toContain(']4;');
    expect(restored).not.toContain(']10;');
    expect(restored).not.toContain('rgb:');
  });

  it('sanitizes mid-line OSC palette garbage attached to a PowerShell prompt', () => {
    const restored = terminalRestoreText({
      text: 'PS C:\\Users\\devuser>]4;0;rgb:2a2a/2020/1818[0[0[\nnext line',
    });

    expect(restored).toBe('PS C:\\Users\\devuser>\r\nnext line');
    expect(restored).not.toContain(']4;');
    expect(restored).not.toContain('rgb:');
  });

  it('sanitizes legacy raw-only transcripts and caps replayed lines', () => {
    const rawText = Array.from({ length: 900 }, (_, i) => `\x1B[32mline-${i}\x1B[0m`).join('\n');
    const restored = terminalRestoreText({ rawText });

    expect(restored).not.toContain('\x1B');
    expect(restored).not.toContain('line-0');
    expect(restored).toContain('line-899');
    expect(restored.split('\r\n')).toHaveLength(800);
  });
});

describe('transcript restore round-trip (reload path)', () => {
  const KEY = 'jarvis-terminal-transcripts';

  it('persists chunked output and restores it in order after a simulated reload', () => {
    const store = useTerminalTranscriptStore.getState();
    store.registerSession('pty_rt', { agentSlug: 'coder', command: 'opencode', paneId: 'pane_rt', projectId: 'proj_rt' });
    // Chunks arrive with colours and a split escape across boundaries —
    // exactly what the PTY does.
    store.appendOutput('pty_rt', '\x1B[32m$ npm test\x1B[0m\r\n');
    store.appendOutput('pty_rt', 'Tests: 12 passed\r\n\x1B[');
    store.appendOutput('pty_rt', '33mwarn: slow test\x1B[0m\r\nDone in 3.2s\r\n');

    flushTranscriptStorage();

    // Simulated reload: parse what landed in localStorage from scratch.
    const reloaded = deserializeTranscriptSessions(window.localStorage.getItem(KEY));
    const session = reloaded?.pty_rt;
    expect(session).toBeDefined();

    const restored = terminalRestoreText(session);
    // Order preserved, escapes gone, lines joined with CRLF for xterm replay.
    expect(restored).toBe(
      '$ npm test\r\nTests: 12 passed\r\nwarn: slow test\r\nDone in 3.2s\r\n',
    );
    expect(restored).not.toContain('\x1B');
  });

  it('keeps the newest lines when the round-trip exceeds the replay cap', () => {
    const store = useTerminalTranscriptStore.getState();
    store.registerSession('pty_rt_cap', { agentSlug: null });
    for (let i = 0; i < 950; i++) {
      store.appendOutput('pty_rt_cap', `line-${i}\n`);
    }
    flushTranscriptStorage();

    const reloaded = deserializeTranscriptSessions(window.localStorage.getItem(KEY));
    const restored = terminalRestoreText(reloaded?.pty_rt_cap);
    const lines = restored.split('\r\n');
    expect(lines.length).toBeLessThanOrEqual(800);
    expect(restored).toContain('line-949');
    expect(restored).not.toContain('line-0\r\n');
  });
});

describe('transcript store persistence performance', () => {
  it('can recover sessions from the last-known-good snapshot when primary JSON is corrupt', () => {
    const backup = JSON.stringify({
      sessions: {
        pty_backup: {
          sessionId: 'pty_backup',
          paneId: 'pane_backup',
          projectId: 'project_backup',
          agentSlug: null,
          command: 'powershell.exe',
          text: 'restored output\n',
          rawText: '',
          currentInput: '',
          lastWriteAt: 10,
          bytesSeen: 16,
        },
      },
    });

    expect(deserializeTranscriptSessions('{broken json')).toBeNull();
    expect(deserializeTranscriptSessions(backup)?.pty_backup?.text).toBe('restored output\n');
  });

  it('debounces localStorage writes instead of flushing every output chunk', () => {
    vi.useFakeTimers();
    const store = useTerminalTranscriptStore.getState();
    store.registerSession('pty_debounce', { agentSlug: 'builder', projectId: 'proj_a' });
    store.appendOutput('pty_debounce', 'first\n');
    store.appendOutput('pty_debounce', 'second\n');

    expect(window.localStorage.getItem('jarvis-terminal-transcripts')).toBeNull();

    vi.advanceTimersByTime(349);
    expect(window.localStorage.getItem('jarvis-terminal-transcripts')).toBeNull();

    vi.advanceTimersByTime(1);
    const persisted = window.localStorage.getItem('jarvis-terminal-transcripts');
    expect(persisted).toContain('pty_debounce');
    expect(persisted).toContain('first\\nsecond\\n');
  });
});

describe('transcript store — append + retrieve', () => {
  it('stores stripped output for a registered session', () => {
    const store = useTerminalTranscriptStore.getState();
    store.registerSession('pty_abc', { agentSlug: 'builder', command: 'claude' });
    store.appendOutput('pty_abc', '\x1B[32m> hello from claude\x1B[0m\n');

    const snap = getSessionTranscript('pty_abc');
    expect(snap?.text).toBe('> hello from claude\n');
    expect(snap?.agentSlug).toBe('builder');
    expect(snap?.command).toBe('claude');
    expect(snap?.bytesSeen).toBeGreaterThan(0);
  });

  it('appends sequential output in order', () => {
    const store = useTerminalTranscriptStore.getState();
    store.registerSession('pty_seq', { agentSlug: 'scout' });
    store.appendOutput('pty_seq', 'first\n');
    store.appendOutput('pty_seq', 'second\n');
    store.appendOutput('pty_seq', 'third\n');
    expect(getSessionTranscript('pty_seq')?.text).toBe('first\nsecond\nthird\n');
  });

  it('does not persist split CSI fragments as visible text', () => {
    const store = useTerminalTranscriptStore.getState();
    store.registerSession('pty_split_csi', { agentSlug: null });

    store.appendOutput('pty_split_csi', '\x1B[');
    store.appendOutput('pty_split_csi', '0mready\n');

    expect(getSessionTranscript('pty_split_csi')?.text).toBe('ready\n');
    expect(terminalRestoreText(getSessionTranscript('pty_split_csi'))).toBe('ready\r\n');
  });

  it('does not persist split OSC fragments as visible text', () => {
    const store = useTerminalTranscriptStore.getState();
    store.registerSession('pty_split_osc', { agentSlug: null });

    store.appendOutput('pty_split_osc', '\x1B]4;6;rgb:12/34/');
    store.appendOutput('pty_split_osc', '56\x07ready\n');

    expect(getSessionTranscript('pty_split_osc')?.text).toBe('ready\n');
    expect(terminalRestoreText(getSessionTranscript('pty_split_osc'))).toBe('ready\r\n');
  });

  it('still tracks bytesSeen for ANSI-only output that strips to empty', () => {
    const store = useTerminalTranscriptStore.getState();
    store.registerSession('pty_clear', { agentSlug: null });
    const before = getSessionTranscript('pty_clear');
    store.appendOutput('pty_clear', '\x1B[2J\x1B[H'); // clear screen
    const after = getSessionTranscript('pty_clear');
    expect(after?.text).toBe('');
    // Even though the visible text didn't change, the pane is "alive".
    expect(after?.bytesSeen).toBeGreaterThan(before?.bytesSeen ?? 0);
  });

  it('drops late output for a session that was never registered', () => {
    // The original behaviour was to lazily create a session record
    // here, but that left ghost transcripts hanging around when the
    // Tauri output listener fired after `forgetSession` had already
    // run (the audit's "ghost transcripts" finding). The store now
    // ties lifecycle strictly to register/forget — late or
    // unregistered output is dropped.
    useTerminalTranscriptStore
      .getState()
      .appendOutput('pty_lazy', 'pre-register output\n');
    expect(getSessionTranscript('pty_lazy')).toBeUndefined();
  });
});

describe('transcript store — bounded ring buffer', () => {
  it('keeps text under MAX_BYTES_PER_SESSION when output exceeds the cap', () => {
    const store = useTerminalTranscriptStore.getState();
    store.registerSession('pty_big', { agentSlug: 'reviewer' });
    // Push twice the cap as one chunk so the trim path runs.
    const huge = 'A'.repeat(MAX_BYTES_PER_SESSION * 2);
    store.appendOutput('pty_big', huge);
    const snap = getSessionTranscript('pty_big');
    expect(snap).toBeDefined();
    expect((snap?.text.length ?? 0)).toBeLessThanOrEqual(MAX_BYTES_PER_SESSION);
  });

  it('prefixes a truncation marker after trimming', () => {
    const store = useTerminalTranscriptStore.getState();
    store.registerSession('pty_trim', { agentSlug: null });
    store.appendOutput('pty_trim', 'X'.repeat(MAX_BYTES_PER_SESSION + 100));
    const text = getSessionTranscript('pty_trim')?.text ?? '';
    expect(text.startsWith('[…earlier output trimmed…]\n')).toBe(true);
  });

  it('keeps the most recent bytes after a trim, not the oldest', () => {
    const store = useTerminalTranscriptStore.getState();
    store.registerSession('pty_recent', { agentSlug: null });
    // Fill with marker A, then push a smaller-but-significant tail of B.
    store.appendOutput('pty_recent', 'A'.repeat(MAX_BYTES_PER_SESSION));
    store.appendOutput('pty_recent', 'B'.repeat(2_000));
    const text = getSessionTranscript('pty_recent')?.text ?? '';
    // The tail must be Bs (recent) — there'd be a regression if the
    // store dropped from the back.
    expect(text.endsWith('B'.repeat(100))).toBe(true);
  });
});

describe('transcript store — by-agent index', () => {
  it('groups sessions by agent slug', () => {
    const store = useTerminalTranscriptStore.getState();
    store.registerSession('pty_b1', { agentSlug: 'builder' });
    store.registerSession('pty_b2', { agentSlug: 'builder' });
    store.registerSession('pty_s1', { agentSlug: 'scout' });
    store.appendOutput('pty_b1', 'b1\n');
    store.appendOutput('pty_s1', 's1\n');
    store.appendOutput('pty_b2', 'b2\n');

    const builders = getSessionsForAgent('builder');
    expect(builders).toHaveLength(2);
    expect(builders.map((s) => s.sessionId).sort()).toEqual(['pty_b1', 'pty_b2']);
    const scouts = getSessionsForAgent('scout');
    expect(scouts).toHaveLength(1);
    expect(scouts[0]?.text).toBe('s1\n');
  });

  it('orders by most-recent activity', () => {
    const store = useTerminalTranscriptStore.getState();
    store.registerSession('pty_old', { agentSlug: 'builder' });
    store.registerSession('pty_new', { agentSlug: 'builder' });
    store.appendOutput('pty_old', 'old\n');
    // Force a different lastWriteAt by waiting one millisecond. Tiny
    // sleep keeps the test deterministic without relying on fake
    // timers (and dragging vi.useFakeTimers into a store-only test).
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        store.appendOutput('pty_new', 'new\n');
        const ordered = getSessionsForAgent('builder');
        expect(ordered[0]?.sessionId).toBe('pty_new');
        expect(ordered[1]?.sessionId).toBe('pty_old');
        resolve();
      }, 5);
    });
  });

  it('respects retagSession when the user changes role mid-stream', () => {
    const store = useTerminalTranscriptStore.getState();
    store.registerSession('pty_retag', { agentSlug: 'builder' });
    store.appendOutput('pty_retag', 'as builder\n');
    expect(getSessionsForAgent('builder')).toHaveLength(1);

    store.retagSession('pty_retag', 'reviewer');
    expect(getSessionsForAgent('builder')).toHaveLength(0);
    const asReviewer = getSessionsForAgent('reviewer');
    expect(asReviewer).toHaveLength(1);
    // Keeps the captured bytes — re-tag shouldn't lose context.
    expect(asReviewer[0]?.text).toBe('as builder\n');
  });

  it('excludes sessions without an agent slug', () => {
    const store = useTerminalTranscriptStore.getState();
    store.registerSession('pty_anon', { agentSlug: null });
    store.appendOutput('pty_anon', 'no role\n');
    expect(getSessionsForAgent('builder')).toHaveLength(0);
  });
});

describe('transcript store — lifecycle', () => {
  it('forgetSession drops a session entirely', () => {
    const store = useTerminalTranscriptStore.getState();
    store.registerSession('pty_kill', { agentSlug: 'builder' });
    store.appendOutput('pty_kill', 'goodbye\n');
    store.forgetSession('pty_kill');
    expect(getSessionTranscript('pty_kill')).toBeUndefined();
    expect(getSessionsForAgent('builder')).toHaveLength(0);
  });

  it('registerSession on an existing id preserves captured text', () => {
    // The TileGrid re-mounts TerminalView when the leaf re-keys; we
    // don't want re-registering the same session id to wipe the
    // captured transcript.
    const store = useTerminalTranscriptStore.getState();
    store.registerSession('pty_keep', { agentSlug: 'builder' });
    store.appendOutput('pty_keep', 'persisted\n');
    store.registerSession('pty_keep', { agentSlug: 'builder', command: 'claude' });
    expect(getSessionTranscript('pty_keep')?.text).toBe('persisted\n');
    expect(getSessionTranscript('pty_keep')?.command).toBe('claude');
  });

  it('stores and transfers project ownership metadata', () => {
    const store = useTerminalTranscriptStore.getState();
    store.registerSession('pty_project_old', {
      agentSlug: 'builder',
      command: 'claude',
      paneId: 'pane_project',
      projectId: 'proj_a',
    });
    store.appendOutput('pty_project_old', 'owned output\n');
    store.transferSession('pty_project_old', 'pty_project_new');

    expect(getSessionTranscript('pty_project_old')).toBeUndefined();
    expect(getSessionTranscript('pty_project_new')?.projectId).toBe('proj_a');
    expect(getSessionTranscript('pty_project_new')?.paneId).toBe('pane_project');
    expect(getSessionTranscript('pty_project_new')?.text).toBe('owned output\n');
  });
});


describe('transcript persistence durability', () => {
  const KEY = 'jarvis-terminal-transcripts';
  const BACKUP = 'jarvis-terminal-transcripts-backup';

  const validSnapshot = (id: string, text: string) =>
    JSON.stringify({
      sessions: {
        [id]: {
          sessionId: id,
          paneId: null,
          projectId: null,
          agentSlug: null,
          command: null,
          text,
          rawText: '',
          currentInput: '',
          lastWriteAt: 42,
          bytesSeen: text.length,
        },
      },
    });

  beforeEach(() => {
    useTerminalTranscriptStore.getState().reset(); // also clears both storage keys
  });

  it('restores from backup when the primary transcript is empty', () => {
    window.localStorage.setItem(KEY, JSON.stringify({ sessions: {} }));
    window.localStorage.setItem(BACKUP, validSnapshot('pty_b', 'kept output\n'));
    const loaded = loadInitialSessions();
    expect(loaded.pty_b?.text).toBe('kept output\n');
  });

  it('restores from backup when the primary transcript is missing', () => {
    window.localStorage.removeItem(KEY);
    window.localStorage.setItem(BACKUP, validSnapshot('pty_c', 'recovered\n'));
    expect(loadInitialSessions().pty_c?.text).toBe('recovered\n');
  });

  it('prefers the primary when it has sessions (backup is only a fallback)', () => {
    window.localStorage.setItem(KEY, validSnapshot('pty_primary', 'fresh\n'));
    window.localStorage.setItem(BACKUP, validSnapshot('pty_old', 'stale\n'));
    const loaded = loadInitialSessions();
    expect(loaded.pty_primary?.text).toBe('fresh\n');
    expect(loaded.pty_old).toBeUndefined();
  });

  it('never overwrites a valid saved transcript with empty state on flush', () => {
    // Simulate the dangerous case: durable history exists on disk, but the
    // in-memory store is empty (e.g. panes unmounted on app close).
    window.localStorage.setItem(KEY, validSnapshot('pty_v', 'precious history\n'));
    expect(Object.keys(useTerminalTranscriptStore.getState().sessions)).toHaveLength(0);

    flushTranscriptStorage();

    const after = window.localStorage.getItem(KEY);
    expect(after).not.toBeNull();
    expect(deserializeTranscriptSessions(after)?.pty_v?.text).toBe('precious history\n');
  });

  it('persists an intentional per-session clear (entry kept, transcript emptied)', () => {
    const store = useTerminalTranscriptStore.getState();
    store.registerSession('pty_clear', { agentSlug: null });
    store.appendOutput('pty_clear', 'some output\n');
    store.clearSessionTranscript('pty_clear');

    flushTranscriptStorage();

    const persisted = deserializeTranscriptSessions(window.localStorage.getItem(KEY));
    expect(persisted?.pty_clear).toBeTruthy();
    expect(persisted?.pty_clear?.text).toBe('');
  });

  it('an intentional full reset wipes persisted transcripts', () => {
    const store = useTerminalTranscriptStore.getState();
    store.registerSession('pty_wipe', { agentSlug: null });
    store.appendOutput('pty_wipe', 'output\n');
    flushTranscriptStorage();
    expect(window.localStorage.getItem(KEY)).not.toBeNull();

    store.reset();
    expect(window.localStorage.getItem(KEY)).toBeNull();
    expect(window.localStorage.getItem(BACKUP)).toBeNull();
  });
});
