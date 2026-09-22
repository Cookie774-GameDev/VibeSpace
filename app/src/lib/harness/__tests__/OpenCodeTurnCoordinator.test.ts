import { describe, expect, it, vi } from 'vitest';
import type { LiveModelRuntimeMetadata } from '@/features/chat/runtime/runtimeModelControls';
import { OpenCodeTurnCoordinator } from '../OpenCodeTurnCoordinator';
import type { OpenCodeSessionPool } from '../OpenCodeSessionPool';

const metadata: LiveModelRuntimeMetadata = {
  connectionId: 'openai-codex',
  modelId: 'gpt-5.6-sol',
  variants: [
    { id: 'high', kind: 'reasoning', reasoningEffort: 'high' },
    { id: 'high-fast', kind: 'combined', reasoningEffort: 'high', fast: true },
  ],
};

describe('OpenCodeTurnCoordinator', () => {
  it('returns command identity while native completion is waiting for approval and observes rejection', async () => {
    let rejectCommand!: (error: unknown) => void;
    const pending = new Promise<void>((_resolve, reject) => { rejectCommand = reject; });
    const signal = new AbortController().signal;
    const sendCommandAsync = vi.fn(() => pending);
    const sessions = {
      sessionForChat: vi.fn(async () => ({
        sessionId: 'session-goal', runtimeGeneration: 'generation',
        client: { sendAsync: vi.fn(), sendCommandAsync },
      })),
    } as unknown as OpenCodeSessionPool;
    const result = await new OpenCodeTurnCoordinator(sessions).dispatch({
      scope: { accountId: 'account' }, chatId: 'chat', text: '/goal Build a game', signal,
      selection: { connectionId: 'openai-codex', providerId: 'openai', modelId: 'gpt-5.6-sol', metadata },
      policy: { mode: 'agent', access: 'full', approveAllForRun: false, projectRoot: 'C:/project' },
    });
    expect(result).toMatchObject({ kind: 'dispatched', sessionId: 'session-goal' });
    expect(sendCommandAsync).toHaveBeenCalledWith(expect.objectContaining({ signal }));
    if (result.kind !== 'dispatched') throw new Error('Expected dispatched command');
    const error = new Error('Provider rejected command');
    rejectCommand(error);
    await expect(result.commandOutcome).resolves.toEqual({ ok: false, error });
  });

  it('consumes VibeSpace runtime commands without sending them to OpenCode', async () => {
    const sendAsync = vi.fn();
    const sessions = {
      sessionForChat: vi.fn(async () => ({
        sessionId: 'session',
        runtimeGeneration: 'generation',
        client: { createSession: vi.fn(), abort: vi.fn(), sendAsync },
      })),
    } as unknown as OpenCodeSessionPool;
    const coordinator = new OpenCodeTurnCoordinator(sessions);
    const result = await coordinator.dispatch({
      scope: { accountId: 'account', projectId: 'project' },
      chatId: 'chat',
      text: '/rlm off',
      selection: {
        connectionId: 'openai-codex',
        providerId: 'openai',
        modelId: 'gpt-5.6-sol',
        metadata,
      },
      policy: {
        mode: 'ask',
        access: 'read-only',
        approveAllForRun: false,
        projectRoot: 'C:/project',
      },
    });
    expect(result.kind).toBe('command');
    expect(sendAsync).not.toHaveBeenCalled();
    expect(sessions.sessionForChat).not.toHaveBeenCalled();
  });

  it('validates exact controls and dispatches through the persistent session client', async () => {
    const sendAsync = vi.fn(async () => undefined);
    const sessions = {
      sessionForChat: vi.fn(async () => ({
        sessionId: 'session',
        runtimeGeneration: 'generation',
        client: { createSession: vi.fn(), abort: vi.fn(), sendAsync },
      })),
    } as unknown as OpenCodeSessionPool;
    const coordinator = new OpenCodeTurnCoordinator(sessions);
    const result = await coordinator.dispatch({
      scope: { accountId: 'account', projectId: 'project' },
      chatId: 'chat',
      text: 'Reply with READY.',
      settings: { effort: 'high', fastMode: 'on', performance: 'quality', rlmEnabled: true },
      selection: {
        connectionId: 'openai-codex',
        providerId: 'openai',
        modelId: 'gpt-5.6-sol',
        metadata,
      },
      policy: { mode: 'agent', access: 'full', approveAllForRun: true, projectRoot: 'C:/project' },
    });
    expect(result).toMatchObject({
      kind: 'dispatched',
      sessionId: 'session',
      runtimeGeneration: 'generation',
      controls: { connectionId: 'openai-codex', modelId: 'gpt-5.6-sol', variant: 'high-fast' },
      permissions: { gateway: { mutationAuthority: 'autonomous' } },
    });
    expect(sendAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'session',
        text: 'Reply with READY.',
        controls: expect.objectContaining({ modelId: 'gpt-5.6-sol', variant: 'high-fast' }),
        agent: 'vibespace-full-auto',
      }),
    );
  });

  it('keeps the persistent review profile on native asks despite a stale run grant', async () => {
    const sendAsync = vi.fn(async () => undefined);
    const sessions = {
      sessionForChat: vi.fn(async () => ({
        sessionId: 'session-review',
        runtimeGeneration: 'generation',
        client: { createSession: vi.fn(), abort: vi.fn(), sendAsync },
      })),
    } as unknown as OpenCodeSessionPool;
    const result = await new OpenCodeTurnCoordinator(sessions).dispatch({
      scope: { accountId: 'account', projectId: 'project' },
      chatId: 'chat',
      text: 'Review the requested change.',
      selection: {
        connectionId: 'openai-codex',
        providerId: 'openai',
        modelId: 'gpt-5.6-sol',
        metadata,
      },
      policy: {
        mode: 'agent',
        access: 'full',
        approveAllForRun: true,
        agentApprovalMode: 'review',
        projectRoot: 'C:/project',
      },
    });
    expect(result).toMatchObject({
      kind: 'dispatched',
      permissions: {
        openCodeAgent: 'vibespace-full',
        openCode: { edit: { 'C:/project/**': 'ask' }, bash: 'ask' },
      },
    });
    expect(sendAsync).toHaveBeenCalledWith(expect.objectContaining({ agent: 'vibespace-full' }));
  });

  it('routes /goal through the official registered OpenCode command endpoint', async () => {
    const sendAsync = vi.fn(async () => undefined);
    const sendCommandAsync = vi.fn(async () => undefined);
    const sessions = {
      sessionForChat: vi.fn(async () => ({
        sessionId: 'session-goal',
        runtimeGeneration: 'generation',
        client: { createSession: vi.fn(), abort: vi.fn(), sendAsync, sendCommandAsync },
      })),
    } as unknown as OpenCodeSessionPool;
    const coordinator = new OpenCodeTurnCoordinator(sessions);
    const result = await coordinator.dispatch({
      scope: { accountId: 'account', projectId: 'project' },
      chatId: 'chat',
      text: '/goal Finish all focused tests with fresh proof',
      settings: { effort: 'high', fastMode: 'on', performance: 'quality', rlmEnabled: true },
      selection: {
        connectionId: 'openai-codex',
        providerId: 'openai',
        modelId: 'gpt-5.6-sol',
        metadata,
      },
      policy: { mode: 'agent', access: 'full', approveAllForRun: false, projectRoot: 'C:/project' },
    });

    expect(result).toMatchObject({ kind: 'dispatched', sessionId: 'session-goal' });
    expect(sendCommandAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'session-goal',
        command: 'goal',
        arguments: 'Finish all focused tests with fresh proof',
        controls: expect.objectContaining({ modelId: 'gpt-5.6-sol', variant: 'high-fast' }),
        agent: 'vibespace-full',
      }),
    );
    expect(sendAsync).not.toHaveBeenCalled();
  });

  it('fails closed for a bare /goal instead of sending it as an ordinary prompt', async () => {
    const sessions = { sessionForChat: vi.fn() } as unknown as OpenCodeSessionPool;
    const coordinator = new OpenCodeTurnCoordinator(sessions);
    const result = await coordinator.dispatch({
      scope: { accountId: 'account', projectId: 'project' },
      chatId: 'chat',
      text: '/goal',
      selection: {
        connectionId: 'openai-codex',
        providerId: 'openai',
        modelId: 'gpt-5.6-sol',
        metadata,
      },
      policy: {
        mode: 'agent',
        access: 'full',
        approveAllForRun: false,
        projectRoot: 'C:/project',
      },
    });

    expect(result).toMatchObject({ kind: 'rejected', code: 'HARNESS_INCOMPATIBLE' });
    expect(sessions.sessionForChat).not.toHaveBeenCalled();
  });

  it.each(['init', 'my_command'])('dispatches live /%s through the command endpoint without arguments', async (command) => {
    const sendAsync = vi.fn(async () => undefined);
    const sendCommandAsync = vi.fn(async () => undefined);
    const listCommandsAsync = vi.fn(async () => [{ name: command }]);
    const sessions = {
      sessionForChat: vi.fn(async () => ({
        sessionId: 'session-init',
        runtimeGeneration: 'generation',
        client: { createSession: vi.fn(), abort: vi.fn(), sendAsync, sendCommandAsync, listCommandsAsync },
      })),
    } as unknown as OpenCodeSessionPool;
    const coordinator = new OpenCodeTurnCoordinator(sessions);

    const result = await coordinator.dispatch({
      scope: { accountId: 'account', projectId: 'project' },
      chatId: 'chat',
      text: `/${command}`,
      selection: {
        connectionId: 'openai-codex',
        providerId: 'openai',
        modelId: 'gpt-5.6-sol',
        metadata,
      },
      policy: { mode: 'agent', access: 'full', approveAllForRun: false, projectRoot: 'C:/project' },
    });

    expect(result).toMatchObject({ kind: 'dispatched', sessionId: 'session-init' });
    expect(listCommandsAsync).toHaveBeenCalledOnce();
    expect(sendCommandAsync).toHaveBeenCalledWith(expect.objectContaining({
      command,
      arguments: '',
    }));
    expect(sendAsync).not.toHaveBeenCalled();
  });

  it('fails closed when the live command catalog query errors', async () => {
    const sendAsync = vi.fn(async () => undefined);
    const listCommandsAsync = vi.fn(async () => { throw new Error('catalog down'); });
    const sessions = {
      sessionForChat: vi.fn(async () => ({
        sessionId: 'session-review',
        runtimeGeneration: 'generation',
        client: { createSession: vi.fn(), abort: vi.fn(), sendAsync, listCommandsAsync },
      })),
    } as unknown as OpenCodeSessionPool;
    const coordinator = new OpenCodeTurnCoordinator(sessions);

    const result = await coordinator.dispatch({
      scope: { accountId: 'account', projectId: 'project' },
      chatId: 'chat',
      text: '/review',
      selection: {
        connectionId: 'openai-codex',
        providerId: 'openai',
        modelId: 'gpt-5.6-sol',
        metadata,
      },
      policy: { mode: 'agent', access: 'full', approveAllForRun: false, projectRoot: 'C:/project' },
    });

    expect(result).toMatchObject({ kind: 'rejected', code: 'HARNESS_INCOMPATIBLE' });
    expect(sendAsync).not.toHaveBeenCalled();
  });

  it('fails closed when a stale picker command is gone from the live catalog', async () => {
    const sendAsync = vi.fn(async () => undefined);
    const sendCommandAsync = vi.fn(async () => undefined);
    const sessions = {
      sessionForChat: vi.fn(async () => ({
        sessionId: 'session-stale',
        runtimeGeneration: 'generation',
        client: {
          createSession: vi.fn(),
          abort: vi.fn(),
          sendAsync,
          sendCommandAsync,
          listCommandsAsync: vi.fn(async () => [{ name: 'init' }]),
        },
      })),
    } as unknown as OpenCodeSessionPool;
    const result = await new OpenCodeTurnCoordinator(sessions).dispatch({
      scope: { accountId: 'account', projectId: 'project' },
      chatId: 'chat',
      text: '/review',
      selection: { connectionId: 'openai-codex', providerId: 'openai', modelId: 'gpt-5.6-sol', metadata },
      policy: { mode: 'agent', access: 'full', approveAllForRun: false, projectRoot: 'C:/project' },
    });
    expect(result).toMatchObject({ kind: 'rejected', code: 'HARNESS_INCOMPATIBLE' });
    expect(sendCommandAsync).not.toHaveBeenCalled();
    expect(sendAsync).not.toHaveBeenCalled();
  });

  it('sends Codex Spark even when leftover max effort is unsupported', async () => {
    const sendAsync = vi.fn(async () => undefined);
    const sessions = {
      sessionForChat: vi.fn(async () => ({
        sessionId: 'session-spark',
        runtimeGeneration: 'gen-1',
        client: { sendAsync },
      })),
    } as unknown as OpenCodeSessionPool;
    const coordinator = new OpenCodeTurnCoordinator(sessions);
    const result = await coordinator.dispatch({
      scope: { accountId: 'account' },
      chatId: 'chat',
      text: 'hello',
      settings: { effort: 'max', fastMode: 'off', performance: 'quality', rlmEnabled: true },
      selection: {
        connectionId: 'openai-chatgpt-pro',
        providerId: 'openai',
        modelId: 'gpt-5.3-codex-spark',
        metadata: {
          connectionId: 'openai-chatgpt-pro',
          modelId: 'gpt-5.3-codex-spark',
          variants: [{ id: 'medium' }],
        },
      },
      policy: {
        mode: 'ask',
        access: 'read-only',
        approveAllForRun: false,
        projectRoot: 'C:/project',
      },
    });
    expect(result.kind).toBe('dispatched');
    expect(sessions.sessionForChat).toHaveBeenCalledOnce();
    expect(sendAsync).toHaveBeenCalledOnce();
    expect(sendAsync).toHaveBeenCalledWith(
      expect.objectContaining({ agent: 'vibespace-readonly' }),
    );
  });

  it('rejects a changed protected session before sending the follow-up prompt', async () => {
    const sendAsync = vi.fn(async () => undefined);
    const sessions = {
      sessionForChat: vi.fn(async () => ({
        sessionId: 'session-restored-different',
        runtimeGeneration: 'gen-2',
        client: { sendAsync },
      })),
    } as unknown as OpenCodeSessionPool;
    const coordinator = new OpenCodeTurnCoordinator(sessions);

    await expect(
      coordinator.dispatch({
        scope: { accountId: 'account' },
        chatId: 'chat',
        text: 'synthesize existing evidence',
        expectedSessionId: 'session-evidence',
        requireExactRuntimeControls: true,
        selection: {
          connectionId: 'openai-chatgpt-pro',
          providerId: 'openai',
          modelId: 'gpt-5.6-sol',
          metadata,
        },
        policy: {
          mode: 'ask',
          access: 'read-only',
          approveAllForRun: false,
          projectRoot: 'C:/project',
        },
      }),
    ).rejects.toThrow('kernel_explicit_root_session_changed_before_dispatch');
    expect(sendAsync).not.toHaveBeenCalled();
  });

  it('does not downgrade unsupported controls for an exact protected phase', async () => {
    const sendAsync = vi.fn(async () => undefined);
    const sessions = {
      sessionForChat: vi.fn(async () => ({
        sessionId: 'session',
        runtimeGeneration: 'generation',
        client: { sendAsync },
      })),
    } as unknown as OpenCodeSessionPool;
    const coordinator = new OpenCodeTurnCoordinator(sessions);
    const result = await coordinator.dispatch({
      scope: { accountId: 'account' },
      chatId: 'chat',
      text: 'collect evidence',
      requireExactRuntimeControls: true,
      settings: { effort: 'max', fastMode: 'off', performance: 'quality', rlmEnabled: false },
      selection: {
        connectionId: 'openai-chatgpt-pro',
        providerId: 'openai',
        modelId: 'gpt-5.3-codex-spark',
        metadata: {
          connectionId: 'openai-chatgpt-pro',
          modelId: 'gpt-5.3-codex-spark',
          variants: [{ id: 'medium' }],
        },
      },
      policy: {
        mode: 'ask',
        access: 'read-only',
        approveAllForRun: false,
        projectRoot: 'C:/project',
      },
    });
    expect(result).toMatchObject({ kind: 'rejected', code: 'MODEL_CONTROL_UNSUPPORTED' });
    expect(sessions.sessionForChat).not.toHaveBeenCalled();
    expect(sendAsync).not.toHaveBeenCalled();
  });
});
