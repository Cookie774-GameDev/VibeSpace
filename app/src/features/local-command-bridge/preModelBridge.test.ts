import { describe, expect, it, vi } from 'vitest';
import { createInstantCommandReceipt } from '@/features/instant-command/receipt';
import { LocalCommandPreModelBridge } from './preModelBridge';
import type { InstantCommandReceipt } from '@/features/instant-command/receipt';
import type {
  InstantCommand,
  InstantCommandExecutionContext,
} from '@/features/instant-command/types';

const context = (
  interactionId: string,
  overrides: Partial<InstantCommandExecutionContext> = {},
): InstantCommandExecutionContext => ({
  correlationId: interactionId,
  accountId: 'account-test',
  workspaceId: 'workspace-test',
  projectId: 'project-test',
  ...overrides,
});

function receipt(
  commandId: string,
  correlationId: string,
  status: InstantCommandReceipt['status'] = 'completed',
): InstantCommandReceipt {
  return createInstantCommandReceipt({
    commandId,
    correlationId,
    status,
    acceptedAtMs: 1,
    targetIds: [],
    ...(status === 'needs_confirmation'
      ? { followUp: { kind: 'confirmation' as const, prompt: 'Confirm this action.' } }
      : {}),
  });
}

describe('pre-model local command bridge', () => {
  it.each(['open codec', 'open codez', 'open clode', 'open settings and open codec'])(
    'holds the ambiguous local command %s before any executor or model dispatch',
    async (text) => {
      const execute = vi.fn();
      const bridge = new LocalCommandPreModelBridge({ execute });
      const result = await bridge.process({
        text,
        interactionId: 'interaction-ambiguous',
        context: context('interaction-ambiguous'),
      });
      expect(result.holdModel).toBe(true);
      expect(result.commandOnly).toBe(false);
      expect(result.modelText).toBe(text);
      expect(result.receipts).toMatchObject([{ status: 'needs_clarification' }]);
      expect(execute).not.toHaveBeenCalled();
    },
  );

  it('leaves model-only text unchanged and does not execute', async () => {
    const execute =
      vi.fn<
        (
          command: InstantCommand,
          executionContext: InstantCommandExecutionContext,
        ) => Promise<InstantCommandReceipt>
      >();
    const bridge = new LocalCommandPreModelBridge({ execute });
    const text = 'Explain how to open a Claude terminal without doing it.';
    const result = await bridge.process({
      text,
      interactionId: 'interaction-model',
      context: context('interaction-model'),
    });
    expect(result.modelText).toBe(text);
    expect(result.detectedCommands).toEqual([]);
    expect(result.holdModel).toBe(false);
    expect(execute).not.toHaveBeenCalled();
  });

  it('executes a mapped command and ends command-only turns locally', async () => {
    const execute = vi.fn(
      async (command: InstantCommand, executionContext: InstantCommandExecutionContext) =>
        receipt(
          command.kind === 'open-agent-cli' ? 'terminal.open' : 'unknown',
          executionContext.correlationId,
        ),
    );
    const bridge = new LocalCommandPreModelBridge({ execute });
    const result = await bridge.process({
      text: 'open a Claude terminal',
      interactionId: 'interaction-terminal',
      context: context('interaction-terminal'),
    });
    expect(result.commandOnly).toBe(true);
    expect(result.modelText).toBe('');
    expect(result.receipts).toMatchObject([{ commandId: 'terminal.open', status: 'completed' }]);
    expect(result.localActionContext).toContain('terminal.open provider=claude status=completed');
    expect(result.localActionContext).not.toContain('account-test');
    expect(result.localActionContext).not.toContain('interaction-terminal');
    expect(execute).toHaveBeenCalledOnce();
    expect(execute.mock.calls[0]![0]).toMatchObject({ kind: 'open-agent-cli', provider: 'claude' });
  });

  it('removes only a successful command span before model dispatch', async () => {
    const execute = vi.fn(
      async (_command: InstantCommand, executionContext: InstantCommandExecutionContext) =>
        receipt('terminal.open', executionContext.correlationId),
    );
    const bridge = new LocalCommandPreModelBridge({ execute });
    const result = await bridge.process({
      text: 'Draft a complete HTML game and open a Claude terminal',
      interactionId: 'interaction-mixed',
      context: context('interaction-mixed'),
    });
    expect(result.commandOnly).toBe(false);
    expect(result.holdModel).toBe(false);
    expect(result.modelText).toBe('Draft a complete HTML game');
    expect(result.localActionContext).toContain('terminal.open');
    expect(execute).toHaveBeenCalledOnce();
  });

  it('keeps unsupported router commands in model text and does not claim success', async () => {
    const execute =
      vi.fn<
        (
          command: InstantCommand,
          executionContext: InstantCommandExecutionContext,
        ) => Promise<InstantCommandReceipt>
      >();
    const bridge = new LocalCommandPreModelBridge({ execute });
    const text = 'change the background to green';
    const result = await bridge.process({
      text,
      interactionId: 'interaction-unsupported',
      context: context('interaction-unsupported'),
    });
    expect(result.unsupportedCommands).toMatchObject([{ id: 'appearance.background.set' }]);
    expect(result.modelText).toBe(text);
    expect(result.receipts).toEqual([]);
    expect(result.holdModel).toBe(false);
    expect(execute).not.toHaveBeenCalled();
  });

  it('holds model dispatch for a non-terminal receipt and keeps that span', async () => {
    const execute = vi.fn(
      async (_command: InstantCommand, executionContext: InstantCommandExecutionContext) =>
        receipt('terminal.open', executionContext.correlationId, 'needs_confirmation'),
    );
    const bridge = new LocalCommandPreModelBridge({ execute });
    const text = 'open a Claude terminal';
    const result = await bridge.process({
      text,
      interactionId: 'interaction-held',
      context: context('interaction-held'),
    });
    expect(result.holdModel).toBe(true);
    expect(result.commandOnly).toBe(false);
    expect(result.modelText).toBe(text);
    expect(result.localActionContext).toBeUndefined();
  });

  it('reuses a completed interaction without executing twice', async () => {
    const execute = vi.fn(
      async (_command: InstantCommand, executionContext: InstantCommandExecutionContext) =>
        receipt('terminal.open', executionContext.correlationId),
    );
    const bridge = new LocalCommandPreModelBridge({ execute });
    const input = {
      text: 'open a Claude terminal',
      interactionId: 'interaction-retry',
      context: context('interaction-retry'),
    };
    const first = await bridge.process(input);
    const second = await bridge.process(input);
    expect(second).toEqual(first);
    expect(execute).toHaveBeenCalledOnce();
  });

  it('fails closed when an interaction reuses its ID for changed text', async () => {
    const execute = vi.fn(
      async (_command: InstantCommand, executionContext: InstantCommandExecutionContext) =>
        receipt('terminal.open', executionContext.correlationId),
    );
    const bridge = new LocalCommandPreModelBridge({ execute });
    await bridge.process({
      text: 'open a Claude terminal',
      interactionId: 'interaction-changed',
      context: context('interaction-changed'),
    });
    const changed = await bridge.process({
      text: 'open a Codex terminal',
      interactionId: 'interaction-changed',
      context: context('interaction-changed'),
    });
    expect(changed.holdModel).toBe(true);
    expect(changed.modelText).toBe('open a Codex terminal');
    expect(execute).toHaveBeenCalledOnce();
  });

  it('uses stable per-command correlation IDs for multiple actions', async () => {
    const execute = vi.fn(
      async (command: InstantCommand, executionContext: InstantCommandExecutionContext) =>
        receipt(
          command.kind === 'catalog' ? command.id : 'terminal.open',
          executionContext.correlationId,
        ),
    );
    const bridge = new LocalCommandPreModelBridge({ execute });
    const result = await bridge.process({
      text: 'open settings and play music',
      interactionId: 'interaction-multiple',
      context: context('interaction-multiple'),
    });
    expect(result.commandOnly).toBe(true);
    expect(result.modelText).toBe('');
    expect(execute).toHaveBeenCalledTimes(2);
    expect(
      execute.mock.calls.map(([, executionContext]) => executionContext.correlationId),
    ).toEqual(['interaction-multiple:cmd-1', 'interaction-multiple:cmd-2']);
  });

  it('single-flights the same scoped interaction before the first execution settles', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const execute = vi.fn(
      async (_command: InstantCommand, executionContext: InstantCommandExecutionContext) => {
        await gate;
        return receipt('terminal.open', executionContext.correlationId);
      },
    );
    const bridge = new LocalCommandPreModelBridge({ execute });
    const input = {
      text: 'open a Claude terminal',
      interactionId: 'interaction-concurrent',
      context: context('interaction-concurrent'),
    };
    const first = bridge.process(input);
    const second = bridge.process(input);
    await Promise.resolve();
    expect(execute).toHaveBeenCalledOnce();
    release();
    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(secondResult).toEqual(firstResult);
  });

  it('does not replay an interaction across account, workspace, or project scope', async () => {
    const execute = vi.fn(
      async (_command: InstantCommand, executionContext: InstantCommandExecutionContext) =>
        receipt('terminal.open', executionContext.correlationId),
    );
    const bridge = new LocalCommandPreModelBridge({ execute });
    const text = 'open a Claude terminal';
    await bridge.process({
      text,
      interactionId: 'interaction-scope',
      context: context('interaction-scope'),
    });
    const otherScope = await bridge.process({
      text,
      interactionId: 'interaction-scope',
      context: context('interaction-scope', {
        accountId: 'account-other',
        workspaceId: 'workspace-other',
        projectId: 'project-other',
      }),
    });
    expect(otherScope.holdModel).toBe(true);
    expect(otherScope.modelText).toBe(text);
    expect(execute).toHaveBeenCalledOnce();
  });

  it('settles a scoped interaction when adaptation throws and replays the held result safely', async () => {
    const adapt = vi.fn(() => {
      throw new Error('adapter unavailable');
    });
    const bridge = new LocalCommandPreModelBridge({ adapt });
    const input = {
      text: 'open a Claude terminal',
      interactionId: 'interaction-adapter-throw',
      context: context('interaction-adapter-throw'),
    };

    const first = await bridge.process(input);
    const second = await bridge.process(input);
    expect(first.holdModel).toBe(true);
    expect(first.modelText).toBe(input.text);
    expect(second).toEqual(first);
    expect(adapt).toHaveBeenCalledOnce();
  });
});
