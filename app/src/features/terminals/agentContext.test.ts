/**
 * @file Tests for the agent terminal-context builder.
 *
 * The builder is the bridge between "what's in the pane right now" and
 * "what the LLM sees when the user asks the agent a question". It has
 * three jobs that need pinning:
 *
 *   1. Surface only sessions tagged with the requested slug.
 *   2. Drop stale (idle > FRESHNESS_WINDOW_MS) and empty sessions.
 *   3. Format the result as a fenced block so a malicious CLI can't
 *      hijack the system prompt with "ignore previous instructions".
 *
 * The freshness window is 10 minutes — the test that exercises it
 * mocks `Date.now` rather than waiting in real time.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { useTerminalTranscriptStore } from '@/features/terminals/transcriptStore';
import { buildAgentTerminalContext } from '@/features/terminals/agentContext';

beforeEach(() => {
  useTerminalTranscriptStore.getState().reset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('buildAgentTerminalContext', () => {
  it('returns empty string when no sessions exist for the slug', () => {
    expect(buildAgentTerminalContext('builder')).toBe('');
  });

  it('returns empty string when sessions exist but have no output yet', () => {
    const store = useTerminalTranscriptStore.getState();
    store.registerSession('pty_silent', { agentSlug: 'builder' });
    // No appendOutput call — the session is registered but empty.
    expect(buildAgentTerminalContext('builder')).toBe('');
  });

  it('returns empty string when called with an empty slug', () => {
    const store = useTerminalTranscriptStore.getState();
    store.registerSession('pty_anon', { agentSlug: null });
    store.appendOutput('pty_anon', 'no role\n');
    expect(buildAgentTerminalContext('')).toBe('');
  });

  it('emits a fenced block for a single tagged session', () => {
    const store = useTerminalTranscriptStore.getState();
    store.registerSession('pty_one', {
      agentSlug: 'builder',
      command: 'claude',
    });
    store.appendOutput('pty_one', 'tests passed\n');

    const ctx = buildAgentTerminalContext('builder');
    expect(ctx).toContain('You are also operating a terminal pane');
    expect(ctx).toContain('session=pty_one');
    expect(ctx).toContain('command=claude');
    // The block is fenced so untrusted output can't escape.
    expect(ctx).toMatch(/```\ntests passed\n```/);
  });

  it('plural-frames the intro when multiple sessions match', () => {
    const store = useTerminalTranscriptStore.getState();
    store.registerSession('pty_a', { agentSlug: 'builder' });
    store.registerSession('pty_b', { agentSlug: 'builder' });
    store.appendOutput('pty_a', 'first\n');
    store.appendOutput('pty_b', 'second\n');
    const ctx = buildAgentTerminalContext('builder');
    expect(ctx).toContain('You are also operating 2 terminal panes');
  });

  it('caps the number of sessions surfaced (MAX_SESSIONS = 3)', () => {
    const store = useTerminalTranscriptStore.getState();
    for (let i = 0; i < 5; i++) {
      const id = `pty_${i}`;
      store.registerSession(id, { agentSlug: 'builder' });
      store.appendOutput(id, `pane ${i}\n`);
    }
    const ctx = buildAgentTerminalContext('builder');
    // Each session contributes exactly one `--- session=...` header,
    // so counting those is a more reliable signal than counting fence
    // markers (which appear twice per session — once at the open, once
    // at the close).
    const sessionHeaders = (ctx.match(/--- session=/g) ?? []).length;
    expect(sessionHeaders).toBe(3);
  });

  it('skips other slugs when surfacing context for a specific agent', () => {
    const store = useTerminalTranscriptStore.getState();
    store.registerSession('pty_b', { agentSlug: 'builder' });
    store.registerSession('pty_s', { agentSlug: 'scout' });
    store.appendOutput('pty_b', 'builder output\n');
    store.appendOutput('pty_s', 'scout output\n');

    const builderCtx = buildAgentTerminalContext('builder');
    expect(builderCtx).toContain('builder output');
    expect(builderCtx).not.toContain('scout output');

    const scoutCtx = buildAgentTerminalContext('scout');
    expect(scoutCtx).toContain('scout output');
    expect(scoutCtx).not.toContain('builder output');
  });

  it('drops sessions whose last write is older than the freshness window', () => {
    // 0.  Real time at "now" so the test is deterministic.
    const baseTime = 1_700_000_000_000;
    vi.useFakeTimers();
    vi.setSystemTime(baseTime);

    const store = useTerminalTranscriptStore.getState();
    store.registerSession('pty_stale', { agentSlug: 'builder' });
    store.appendOutput('pty_stale', 'old work\n');

    // 1.  Jump 30 minutes forward — well past the 10-minute window.
    vi.setSystemTime(baseTime + 30 * 60 * 1000);

    const ctx = buildAgentTerminalContext('builder');
    // Stale session is silently dropped, so the result is empty.
    expect(ctx).toBe('');
  });

  it('keeps fresh sessions and drops stale ones in the same call', () => {
    const baseTime = 1_700_000_000_000;
    vi.useFakeTimers();
    vi.setSystemTime(baseTime);

    const store = useTerminalTranscriptStore.getState();
    store.registerSession('pty_old', { agentSlug: 'builder' });
    store.appendOutput('pty_old', 'old work\n');

    vi.setSystemTime(baseTime + 30 * 60 * 1000);
    store.registerSession('pty_fresh', { agentSlug: 'builder' });
    store.appendOutput('pty_fresh', 'just-now work\n');

    const ctx = buildAgentTerminalContext('builder');
    expect(ctx).toContain('just-now work');
    expect(ctx).not.toContain('old work');
  });

  it('surfaces the most-recent session first', () => {
    const baseTime = 1_700_000_000_000;
    vi.useFakeTimers();
    vi.setSystemTime(baseTime);

    const store = useTerminalTranscriptStore.getState();
    store.registerSession('pty_first', { agentSlug: 'builder' });
    store.appendOutput('pty_first', 'first wrote earlier\n');

    vi.setSystemTime(baseTime + 1_000); // 1 s later
    store.registerSession('pty_latest', { agentSlug: 'builder' });
    store.appendOutput('pty_latest', 'latest just now\n');

    const ctx = buildAgentTerminalContext('builder');
    const firstIdx = ctx.indexOf('first wrote earlier');
    const latestIdx = ctx.indexOf('latest just now');
    expect(latestIdx).toBeGreaterThan(-1);
    expect(firstIdx).toBeGreaterThan(-1);
    // Most recent should appear *before* the older one in the prompt
    // (LLMs weight earlier system context as primary).
    expect(latestIdx).toBeLessThan(firstIdx);
  });

  it('truncates long per-session output to PER_SESSION_TAIL_CHARS', () => {
    const store = useTerminalTranscriptStore.getState();
    store.registerSession('pty_huge', { agentSlug: 'builder' });
    // Push 20 KB of distinct content so truncation is observable.
    const chunk = 'X'.repeat(20 * 1024);
    store.appendOutput('pty_huge', chunk);
    const ctx = buildAgentTerminalContext('builder');
    // The fenced block should be much smaller than the full chunk —
    // PER_SESSION_TAIL_CHARS is 6 KB, so total length is well under 8 KB
    // including the surrounding scaffolding.
    expect(ctx.length).toBeLessThan(8 * 1024);
    // Tail characters survive (the cap drops from the front).
    expect(ctx).toContain('XXX');
  });
});
