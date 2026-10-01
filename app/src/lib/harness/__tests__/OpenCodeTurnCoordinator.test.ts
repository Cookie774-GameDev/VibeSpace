import { describe, expect, it, vi } from 'vitest';
import type { LiveModelRuntimeMetadata } from '@/features/chat/runtime/runtimeModelControls';
import { OpenCodeTurnCoordinator } from '../OpenCodeTurnCoordinator';
import type { OpenCodeSessionPool } from '../OpenCodeSessionPool';

const metadata: LiveModelRuntimeMetadata = {
  connectionId: 'openai-chatgpt-pro',
  modelId: 'gpt-5.6-sol',
  variants: [
    { id: 'high', kind: 'reasoning', reasoningEffort: 'high' },
    { id: 'high-fast', kind: 'combined', reasoningEffort: 'high', fast: true },
  ],
};

describe('OpenCodeTurnCoordinator', () => {
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
        connectionId: 'openai-chatgpt-pro', providerId: 'openai', modelId: 'gpt-5.6-sol', metadata,
      },
      policy: { mode: 'ask', access: 'read-only', approveAllForRun: false, projectRoot: 'C:/project' },
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
        connectionId: 'openai-chatgpt-pro', providerId: 'openai', modelId: 'gpt-5.6-sol', metadata,
      },
      policy: { mode: 'agent', access: 'full', approveAllForRun: true, projectRoot: 'C:/project' },
    });
    expect(result).toMatchObject({
      kind: 'dispatched', sessionId: 'session', runtimeGeneration: 'generation',
      controls: { connectionId: 'openai-chatgpt-pro', modelId: 'gpt-5.6-sol', variant: 'high-fast' },
      permissions: { gateway: { mutationAuthority: 'autonomous' } },
    });
    expect(sendAsync).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'session',
      text: 'Reply with READY.',
      controls: expect.objectContaining({ modelId: 'gpt-5.6-sol', variant: 'high-fast' }),
    }));
  });

  it('fails unsupported controls before starting a session', async () => {
    const sessions = { sessionForChat: vi.fn() } as unknown as OpenCodeSessionPool;
    const coordinator = new OpenCodeTurnCoordinator(sessions);
    const result = await coordinator.dispatch({
      scope: { accountId: 'account' },
      chatId: 'chat',
      text: 'hello',
      settings: { effort: 'max', fastMode: 'off', performance: 'quality', rlmEnabled: true },
      selection: {
        connectionId: 'openai-chatgpt-pro', providerId: 'openai', modelId: 'spark',
        metadata: { connectionId: 'openai-chatgpt-pro', modelId: 'spark', variants: [{ id: 'medium' }] },
      },
      policy: { mode: 'ask', access: 'read-only', approveAllForRun: false, projectRoot: 'C:/project' },
    });
    expect(result.kind).toBe('rejected');
    expect(sessions.sessionForChat).not.toHaveBeenCalled();
  });
});
