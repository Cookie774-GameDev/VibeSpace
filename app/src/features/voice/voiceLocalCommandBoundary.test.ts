import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createInstantCommandReceipt } from '@/features/instant-command/receipt';
import type { InstantCommandReceipt } from '@/features/instant-command/receipt';
import type { InstantCommand, InstantCommandExecutionContext } from '@/features/instant-command/types';
import { useUIStore } from '@/stores/ui';
import { createVoiceLocalCommandBoundary } from './voiceLocalCommandBoundary';

const context = (id: string): InstantCommandExecutionContext => ({
  correlationId: id, accountId: 'voice-local-account',
  workspaceId: 'voice-local-workspace', projectId: 'voice-local-project',
});
const receipt = (command: InstantCommand, ctx: InstantCommandExecutionContext,
  status: InstantCommandReceipt['status'] = 'completed') => createInstantCommandReceipt({
  commandId: command.kind === 'catalog' ? command.id : 'terminal.open',
  correlationId: ctx.correlationId, acceptedAtMs: 1, targetIds: [], status,
  ...(status === 'needs_confirmation' ? { followUp: { kind: 'confirmation' as const, prompt: 'Approve this action.' } } : {}),
});

describe('Voice local command boundary', () => {
  beforeEach(() => useUIStore.setState({ settingsOpen: false }));

  it('uses the existing real Settings authority and receipt with no model route', async () => {
    const run = createVoiceLocalCommandBoundary({
      text: 'open settings', interactionId: 'voice-local-real',
      context: context('voice-local-real'), isCurrent: () => true,
    });
    const outcome = await run();
    expect(useUIStore.getState().settingsOpen).toBe(true);
    expect(outcome.status).toBe('command_only');
    expect(outcome.result.receipts).toMatchObject([{ commandId: 'settings.open', status: 'completed' }]);
    expect(outcome.result.modelText).toBe('');
  });

  it('single-flights one exact submission and does not replay a committed action', async () => {
    const execute = vi.fn(async (cmd: InstantCommand, ctx: InstantCommandExecutionContext) => receipt(cmd, ctx));
    const run = createVoiceLocalCommandBoundary({
      text: 'open settings', interactionId: 'voice-local-once',
      context: context('voice-local-once'), isCurrent: () => true,
    }, { execute });
    const results = await Promise.all([run(), run(), run()]);
    expect(execute).toHaveBeenCalledOnce();
    expect(results.every((value) => value.status === 'command_only')).toBe(true);
    await run();
    expect(execute).toHaveBeenCalledOnce();
  });

  it('keeps original mixed input separate from the receipt-grounded residual', async () => {
    const execute = vi.fn(async (cmd: InstantCommand, ctx: InstantCommandExecutionContext) => receipt(cmd, ctx));
    const text = 'open settings; Explain a compiler';
    const outcome = await createVoiceLocalCommandBoundary({
      text, interactionId: 'voice-local-mixed', context: context('voice-local-mixed'), isCurrent: () => true,
    }, { execute })();
    expect(outcome.status).toBe('model');
    expect(outcome.result.originalText).toBe(text);
    expect(outcome.result.modelText).toBe('Explain a compiler');
    expect(outcome.result.localActionContext).toContain('settings.open route=settings status=completed');
    expect(execute).toHaveBeenCalledOnce();
  });

  it.each(['"open settings"', 'do not open settings'])(
    'does not execute quoted or negated data %s', async (text) => {
      const execute = vi.fn();
      const result = await createVoiceLocalCommandBoundary({
        text, interactionId: 'voice-local-inert', context: context('voice-local-inert'), isCurrent: () => true,
      }, { execute })();
      expect(execute).not.toHaveBeenCalled();
      expect(result.status).toBe('model');
      expect(result.result.modelText).toBe(text);
    },
  );

  it('holds an ambiguous action before execution', async () => {
    const execute = vi.fn();
    const result = await createVoiceLocalCommandBoundary({
      text: 'open codec', interactionId: 'voice-local-ambiguous', context: context('voice-local-ambiguous'), isCurrent: () => true,
    }, { execute })();
    expect(execute).not.toHaveBeenCalled();
    expect(result.status).toBe('held');
    expect(result.result.receipts).toMatchObject([{ status: 'needs_clarification' }]);
  });

  it('preserves confirmation-required receipts and holds later actions', async () => {
    const execute = vi.fn(async (cmd: InstantCommand, ctx: InstantCommandExecutionContext) => receipt(cmd, ctx, 'needs_confirmation'));
    const result = await createVoiceLocalCommandBoundary({
      text: 'open settings and play music', interactionId: 'voice-local-confirm', context: context('voice-local-confirm'), isCurrent: () => true,
    }, { execute })();
    expect(execute).toHaveBeenCalledOnce();
    expect(result.status).toBe('held');
    expect(result.completedCount).toBe(0);
    expect(result.result.receipts).toMatchObject([{ status: 'needs_confirmation' }]);
    expect(result.result.unexecutedCommands).toHaveLength(1);
  });

  it('rejects a revoked scope before the first action', async () => {
    const execute = vi.fn();
    const result = await createVoiceLocalCommandBoundary({
      text: 'open settings', interactionId: 'voice-local-revoked', context: context('voice-local-revoked'), isCurrent: () => false,
    }, { execute })();
    expect(execute).not.toHaveBeenCalled();
    expect(result.status).toBe('revoked');
    expect(result.completedCount).toBe(0);
  });

  it.each(['close', 'project ABA', 'account change'])(
    'retains a committed receipt after %s and stops the next action without replay', async (cause) => {
      let revision = 0;
      let open = true;
      let account = 'original-account';
      const captured = revision;
      const execute = vi.fn(async (cmd: InstantCommand, ctx: InstantCommandExecutionContext) => {
        if (cause === 'close') open = false;
        else if (cause === 'account change') account = 'different-account';
        else revision += 2; // Project changes away and back still revoke the old generation.
        return receipt(cmd, ctx);
      });
      const run = createVoiceLocalCommandBoundary({
        text: 'open settings and play music', interactionId: 'voice-local-partial',
        context: context('voice-local-partial'),
        isCurrent: () => open && account === 'original-account' && revision === captured,
      }, { execute });
      const result = await run();
      expect(result.status).toBe('revoked');
      expect(result.completedCount).toBe(1);
      expect(result.result.receipts.map((value) => value.status)).toEqual(['completed', 'rejected']);
      expect(execute).toHaveBeenCalledOnce();
      await run();
      expect(execute).toHaveBeenCalledOnce();
    },
  );
});
