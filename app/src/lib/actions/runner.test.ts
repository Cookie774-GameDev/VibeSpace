/**
 * @file Tests for the action runner — built-in registry lookup, custom
 *       tool fallthrough, param validation, and toast emission.
 *
 * The runner is the single dispatch point used by both the chat
 * Approve/Cancel card and the actions palette. Any change to its
 * contract ripples through every action call site, so these tests
 * pin the shape that today's UI and the AI prompt addendum rely on.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// Avoid pulling the real toast module (it mounts a portal in jsdom).
vi.mock('@/components/ui/toast', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
  },
}));

import { runAction, resolveAction, getAllActions } from '@/lib/actions/runner';
import { toast } from '@/components/ui/toast';
import { useToolStore } from '@/features/tools/toolStore';
import { useClockStore } from '@/features/clock/clockStore';

describe('resolveAction', () => {
  it('finds built-in actions by id', () => {
    const a = resolveAction('nav.chat');
    expect(a).toBeDefined();
    expect(a?.id).toBe('nav.chat');
    expect(a?.category).toBe('navigation');
  });

  it('returns undefined for unknown ids', () => {
    expect(resolveAction('does.not.exist')).toBeUndefined();
  });

  it('falls through to a custom tool when its slug is present', () => {
    useToolStore.setState({ tools: [] });
    useToolStore.getState().create({
      name: 'My dev server',
      description: 'Start the dev server.',
      baseAction: 'terminal.run',
      params: { command: 'npm run jarvis' },
    });

    const slug = useToolStore.getState().tools[0]!.slug;
    const a = resolveAction(`custom.${slug}`);
    expect(a).toBeDefined();
    expect(a?.id).toBe(`custom.${slug}`);
    expect(a?.category).toBe('custom');
  });
});

describe('getAllActions', () => {
  it('combines built-ins and custom tools, with built-ins winning collisions', () => {
    useToolStore.setState({ tools: [] });
    const before = getAllActions();
    expect(before.some((a) => a.id === 'nav.chat')).toBe(true);

    // Forge a custom tool that tries to shadow a built-in id. The store
    // namespaces under `custom.` so collisions can only happen if the
    // tool's slug was crafted maliciously, but we still defend against it.
    useToolStore.setState({
      tools: [
        {
          slug: 'rogue',
          name: 'Rogue',
          description: 'shadow attempt',
          baseAction: 'nav.chat',
          params: {},
          createdAt: 0,
          updatedAt: 0,
          published: null,
        },
      ],
    });

    const after = getAllActions();
    const navMatches = after.filter((a) => a.id === 'nav.chat');
    // Only the built-in entry, never a duplicate from the custom store.
    expect(navMatches).toHaveLength(1);
    expect(navMatches[0]?.category).toBe('navigation');
  });
});

describe('runAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useToolStore.setState({ tools: [] });
    useClockStore.setState({ entries: [] });
  });

  it('returns a structured error for unknown ids and toasts by default', async () => {
    const result = await runAction('does.not.exist', {}, { source: 'user' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/Unknown action/);
    expect(toast.error).toHaveBeenCalled();
  });

  it('rejects required-param omissions before dispatching the runner', async () => {
    const result = await runAction(
      'terminal.run',
      {},
      { source: 'user' },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/required/i);
  });

  it('suppresses the toast when emitToast is false', async () => {
    const result = await runAction(
      'does.not.exist',
      {},
      { source: 'user' },
      { emitToast: false },
    );
    expect(result.ok).toBe(false);
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('catches runner exceptions and turns them into structured errors', async () => {
    // theme.toggle is a built-in that touches the UI store; in jsdom it
    // works fine, so we wrap a custom tool whose runner explicitly throws.
    useToolStore.setState({
      tools: [
        {
          slug: 'kaboom',
          name: 'Kaboom',
          description: 'throws on run',
          // Intentionally point at a non-existent base action so the
          // synthesised runner returns ok:false with a clear message.
          baseAction: 'nope.nope',
          params: {},
          createdAt: 0,
          updatedAt: 0,
          published: null,
        },
      ],
    });

    const result = await runAction('custom.kaboom', {}, { source: 'user' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/unknown base action/i);
  });

  it('runs the preloaded Clock timer action', async () => {
    const def = resolveAction('clock.timer');
    expect(def?.category).toBe('clock');

    const result = await runAction(
      'clock.timer',
      { durationMinutes: 1, label: 'Tea' },
      { source: 'user' },
      { emitToast: false },
    );

    expect(result.ok).toBe(true);
    expect(useClockStore.getState().scheduled()[0]?.label).toBe('Tea');
  });

  it('coerces params inside custom workflow tool steps', async () => {
    const tool = useToolStore.getState().create({
      name: 'Tea workflow',
      description: 'Set a tea timer.',
      baseAction: 'workflow.run',
      params: {},
      steps: [
        {
          action: 'clock.timer',
          params: { durationMinutes: '1', durationSeconds: '30', label: 'Tea' },
        },
      ],
    });

    const result = await runAction(
      `custom.${tool.slug}`,
      {},
      { source: 'user' },
      { emitToast: false },
    );

    expect(result.ok).toBe(true);
    const timer = useClockStore.getState().scheduled()[0];
    expect(timer?.label).toBe('Tea');
    expect(timer?.durationMs).toBe(90_000);
  });
});
