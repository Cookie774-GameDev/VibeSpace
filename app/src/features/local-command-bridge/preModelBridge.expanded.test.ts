import { describe, expect, it, vi } from 'vitest';
import { createInstantCommandReceipt } from '@/features/instant-command/receipt';
import type {
  InstantCommand,
  InstantCommandExecutionContext,
} from '@/features/instant-command/types';
import { LocalCommandPreModelBridge } from './preModelBridge';

function context(interactionId: string): InstantCommandExecutionContext {
  return {
    correlationId: interactionId,
    accountId: 'account-local-command-expanded',
    workspaceId: 'workspace-local-command-expanded',
    projectId: 'project-local-command-expanded',
  };
}

describe('expanded pre-model local-command bridge', () => {
  it('opens exactly two Claude terminals and preserves vague coordination for the main model', async () => {
    const execute = vi.fn(
      async (command: InstantCommand, executionContext: InstantCommandExecutionContext) =>
        createInstantCommandReceipt({
          commandId: command.kind === 'open-agent-cli' ? 'terminal.open' : 'unexpected',
          correlationId: executionContext.correlationId,
          status: 'completed',
          acceptedAtMs: 1,
          targetIds: [],
        }),
    );
    const bridge = new LocalCommandPreModelBridge({ execute });
    const result = await bridge.process({
      text: 'HEY PLEASE SPAWN 2 CLAUDE AGENTS TERMINALS AND TEELL BOTH OF THEM TO USE THE SKILLS FROM TEH ENVOIRMENT AND LIKE RENFERACE THE DOWNLADOS FOLDER AND ALSO TELL THEM TO DO A READ AUDIT ON VIBESAPCE OAKY',
      interactionId: 'expanded-two-claude',
      context: context('expanded-two-claude'),
    });

    expect(execute).toHaveBeenCalledOnce();
    expect(execute.mock.calls[0]![0]).toEqual({
      kind: 'open-agent-cli',
      provider: 'claude',
      count: 2,
    });
    expect(result.commandOnly).toBe(false);
    expect(result.holdModel).toBe(false);
    expect(result.modelText).toContain('TEELL BOTH OF THEM');
    expect(result.modelText).toContain('DOWNLADOS FOLDER');
    expect(result.modelText).toContain('READ AUDIT ON VIBESAPCE');
    expect(result.modelText).not.toContain('SPAWN 2 CLAUDE AGENTS TERMINALS');
    expect(result.localActionContext).toContain('terminal.open');
    expect(result.localActionContext).toContain('count=2');
  });

  it('executes an explicit provider broadcast locally without inventing vague payloads', async () => {
    const execute = vi.fn(
      async (command: InstantCommand, executionContext: InstantCommandExecutionContext) =>
        createInstantCommandReceipt({
          commandId:
            command.kind === 'open-agent-cli'
              ? 'terminal.open'
              : command.kind === 'terminal-broadcast'
                ? 'terminal.broadcast'
                : 'unexpected',
          correlationId: executionContext.correlationId,
          status: 'completed',
          acceptedAtMs: 1,
          targetIds: [],
        }),
    );
    const bridge = new LocalCommandPreModelBridge({ execute });
    const explicit = await bridge.process({
      text: 'spawn 2 Claude terminals and tell all Claude terminals to run npm test',
      interactionId: 'expanded-broadcast',
      context: context('expanded-broadcast'),
    });

    expect(explicit.commandOnly).toBe(true);
    expect(explicit.modelText).toBe('');
    expect(execute.mock.calls.map(([command]) => command)).toEqual([
      { kind: 'open-agent-cli', provider: 'claude', count: 2 },
      {
        kind: 'terminal-broadcast',
        target: { provider: 'claude', scope: 'all' },
        payload: 'run npm test',
      },
    ]);

    const vagueExecute = vi.fn();
    const vagueBridge = new LocalCommandPreModelBridge({ execute: vagueExecute });
    const vague = await vagueBridge.process({
      text: 'tell both of them to inspect Downloads and use the environment skills',
      interactionId: 'expanded-vague-message',
      context: context('expanded-vague-message'),
    });
    expect(vagueExecute).not.toHaveBeenCalled();
    expect(vague.classification).toBe('llm_only');
    expect(vague.modelText).toContain('tell both of them');
  });
});
