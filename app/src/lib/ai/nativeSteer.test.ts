import { describe, expect, it, vi } from 'vitest';
import type { MessageId } from '@/types';
import {
  dispatchRuntimeNativeSteer,
  NativeTurnControlOutcomeUnknownError,
  nativeSteerFailureDisposition,
} from './nativeSteer';

describe('dispatchRuntimeNativeSteer', () => {
  it('requires review for unknown or acknowledged failures and permits retry only before acceptance', () => {
    expect(nativeSteerFailureDisposition(new NativeTurnControlOutcomeUnknownError(), false)).toBe('review_required');
    expect(nativeSteerFailureDisposition(new Error('db write failed'), true)).toBe('review_required');
    expect(nativeSteerFailureDisposition(new Error('server rejected request'), false)).toBe('retryable');
  });

  it('waits for native acknowledgement, persists exactly once, then acknowledges the composer', async () => {
    const order: string[] = [];
    const appendUserMessage = vi.fn(async (message) => {
      order.push('persist');
      return { ...message, id: 'msg_native_steer' as MessageId, created_at: 2, updated_at: 2 };
    });
    const control = {
      steer: vi.fn(async (input: { clientUserMessageId: string; text: string }) => {
        expect(input).toEqual({
          clientUserMessageId: 'composer_queued_1',
          text: 'Refine this task.',
        });
        order.push('ack');
      }),
    };
    const accepted = vi.fn();
    await expect(
      dispatchRuntimeNativeSteer({
        control,
        clientUserMessageId: 'composer_queued_1',
        chatId: 'chat_native_steer',
        text: 'Refine this task.',
        isStillActive: () => true,
        appendUserMessage,
        acceptedCancellationKey: 'msg_active_turn' as MessageId,
        onAccepted: accepted,
      }),
    ).resolves.toBe('msg_native_steer');
    expect(order).toEqual(['ack', 'persist']);
    expect(control.steer).toHaveBeenCalledOnce();
    expect(appendUserMessage).toHaveBeenCalledOnce();
    expect(accepted).toHaveBeenCalledOnce();
    expect(accepted).toHaveBeenCalledWith('msg_active_turn');
  });

  it('does not call a stale control or persist after native rejection', async () => {
    const appendUserMessage = vi.fn();
    const accepted = vi.fn();
    const control = {
      steer: vi.fn(async () => {
        throw new Error('turn mismatch');
      }),
    };
    await expect(
      dispatchRuntimeNativeSteer({
        control,
        clientUserMessageId: 'queued_2',
        chatId: 'chat_native_steer',
        text: 'Do not lose this.',
        isStillActive: () => true,
        appendUserMessage,
        acceptedCancellationKey: 'msg_active_turn' as MessageId,
        onAccepted: accepted,
      }),
    ).rejects.toThrow('turn mismatch');
    expect(appendUserMessage).not.toHaveBeenCalled();
    expect(accepted).not.toHaveBeenCalled();

    await expect(
      dispatchRuntimeNativeSteer({
        control,
        clientUserMessageId: 'queued_3',
        chatId: 'chat_native_steer',
        text: 'Stale control.',
        isStillActive: () => false,
        appendUserMessage,
        acceptedCancellationKey: 'msg_active_turn' as MessageId,
        onAccepted: accepted,
      }),
    ).rejects.toThrow('no longer active');
    expect(control.steer).toHaveBeenCalledOnce();
  });

  it('carries the exact selected Codex skill reference into a native steer', async () => {
    const skill = {
      cwd: 'C:\\project', name: 'review', description: 'Review skill',
      path: 'C:\\project\\.agents\\skills\\review\\SKILL.md', scope: 'repo' as const,
      enabled: true, pluginId: null,
    };
    const control = { steer: vi.fn(async () => undefined) };
    const appendUserMessage = vi.fn(async () => ({ id: 'msg_skill' as MessageId }));
    await dispatchRuntimeNativeSteer({
      control, clientUserMessageId: 'queued_skill', chatId: 'chat_skill', text: 'Use review.',
      skills: [skill], isStillActive: () => true, appendUserMessage,
      acceptedCancellationKey: 'active' as MessageId,
    });
    expect(control.steer).toHaveBeenCalledWith({
      clientUserMessageId: 'queued_skill', text: 'Use review.', skills: [skill],
    });
    expect(appendUserMessage).toHaveBeenCalledOnce();
  });
});
