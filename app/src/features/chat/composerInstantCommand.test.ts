import { describe, expect, it, vi } from 'vitest';

import { InstantCommandEntryBoundary } from '@/features/instant-command';
import { createInstantCommandReceipt } from '@/features/instant-command/receipt';
import {
  COMPOSER_INSTANT_SLASH_COMMANDS,
  isComposerInstantCommandSource,
  submitComposerInstantCommand,
} from './composerInstantCommand';

const scope = Object.freeze({
  accountId: 'account-1',
  workspaceId: 'workspace-1',
  projectId: 'project-1',
});

function acceptingBoundary(execute = vi.fn()) {
  execute.mockImplementation(async (command, context) =>
    createInstantCommandReceipt({
      commandId: command.kind === 'catalog' ? command.id : 'unexpected',
      correlationId: context.correlationId,
      status: 'completed',
      acceptedAtMs: 1,
      targetIds: [],
    }),
  );
  return { boundary: new InstantCommandEntryBoundary({ execute }), execute };
}

describe('Composer Instant Command bridge', () => {
  it.each([
    'chat',
    'canvas',
    'workbench',
    'kanban',
    'schedule',
    'agents',
    'skills',
    'benchmarks',
    'history',
    'tools',
    'files',
    'notes',
  ])('handles open %s before any model dependency', async (route) => {
    const { boundary, execute } = acceptingBoundary();
    const source = `open ${route}`;
    expect(isComposerInstantCommandSource(source)).toBe(true);
    const start = performance.now();
    const result = await submitComposerInstantCommand(
      { source, interactionId: `local-${route}`, ...scope },
      boundary,
    );
    expect(result).toMatchObject({ handled: true, ok: true, commandId: 'page.open' });
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({ slots: { route } }),
      expect.anything(),
    );
    expect(performance.now() - start).toBeLessThan(500);
  });

  it.each([
    'do not open notes',
    'explain how to open notes',
    'open notes and delete everything',
    '/notes',
    'open Codex',
  ])('leaves non-navigation or non-exact input untouched: %s', (source) => {
    expect(isComposerInstantCommandSource(source)).toBe(false);
  });

  it('executes five collision-free slash commands through their canonical local authorities', async () => {
    expect(COMPOSER_INSTANT_SLASH_COMMANDS).toEqual([
      'connect',
      'settings',
      'palette',
      'launcher',
      'back',
    ]);
    const cases = [
      ['/connect', 'connections.open'],
      ['/settings', 'settings.open'],
      ['/palette', 'palette.open'],
      ['/launcher', 'launcher.open'],
      ['/back', 'page.back'],
    ] as const;

    for (const [source, commandId] of cases) {
      const { boundary, execute } = acceptingBoundary();
      await expect(
        submitComposerInstantCommand(
          { source, interactionId: `chat-${commandId}`, ...scope },
          boundary,
        ),
      ).resolves.toEqual({
        handled: true,
        ok: true,
        commandId,
        status: 'completed',
        message: `Instant command completed (${commandId}).`,
      });
      expect(execute).toHaveBeenCalledOnce();
    }
  });

  it('preserves an exact safe provider focus and rejects unsafe connect text without echo or execution', async () => {
    const accepted = acceptingBoundary();
    await expect(
      submitComposerInstantCommand(
        { source: '/connect openrouter', interactionId: 'chat-connect-safe', ...scope },
        accepted.boundary,
      ),
    ).resolves.toMatchObject({ handled: true, ok: true, commandId: 'connections.open' });
    expect(accepted.execute.mock.calls[0]?.[0]).toMatchObject({
      kind: 'catalog',
      id: 'connections.open',
      slots: { section: 'providers', providerId: 'openrouter' },
    });

    for (const source of [
      '/connect ollama',
      '/connect unknown',
      '/connect openai extra',
      '/connect sk-private',
      '/connect openai\u0000private',
    ]) {
      const rejected = acceptingBoundary();
      const result = await submitComposerInstantCommand(
        { source, interactionId: `chat-reject-${source.length}`, ...scope },
        rejected.boundary,
      );
      expect(result).toEqual({
        handled: true,
        ok: false,
        message: source.includes('\u0000')
          ? 'Invalid interaction source.'
          : 'Choose one supported provider in Settings.',
      });
      expect(JSON.stringify(result)).not.toContain(source);
      expect(rejected.execute).not.toHaveBeenCalled();
    }
  });

  it('deduplicates an exact interaction and leaves ordinary Chat text unmatched', async () => {
    const pending = acceptingBoundary(
      vi.fn(async (command, context) =>
        createInstantCommandReceipt({
          commandId: command.kind === 'catalog' ? command.id : 'unexpected',
          correlationId: context.correlationId,
          status: 'completed',
          acceptedAtMs: 1,
          targetIds: [],
        }),
      ),
    );
    const input = { source: '/settings', interactionId: 'chat-dedupe', ...scope };
    const [first, second] = await Promise.all([
      submitComposerInstantCommand(input, pending.boundary),
      submitComposerInstantCommand(input, pending.boundary),
    ]);
    expect(first).toEqual(second);
    expect(pending.execute).toHaveBeenCalledOnce();

    await expect(
      submitComposerInstantCommand(
        { source: 'explain this code', interactionId: 'chat-model-text', ...scope },
        pending.boundary,
      ),
    ).resolves.toEqual({ handled: false });
  });
});
