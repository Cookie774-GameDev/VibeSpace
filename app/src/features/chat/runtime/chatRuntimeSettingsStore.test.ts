import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearApproveAllForRun,
  readChatRuntimePolicyState,
  sanitizeChatRuntimePolicyState,
  writeChatRuntimePolicyState,
} from './chatRuntimeSettingsStore';

describe('chatRuntimeSettingsStore', () => {
  beforeEach(() => localStorage.clear());

  it('defaults RLM on, quality, exact-auto controls, and full access', () => {
    expect(readChatRuntimePolicyState('chat-1')).toEqual({
      settings: { effort: 'auto', fastMode: 'auto', performance: 'quality', rlmEnabled: true },
      access: 'full',
      approveAllForRun: false,
    });
  });

  it('persists orthogonal access and clears run-scoped approval after dispatch', () => {
    writeChatRuntimePolicyState('chat-1', {
      settings: { effort: 'max', fastMode: 'on', performance: 'responsive', rlmEnabled: false },
      access: 'write',
      approveAllForRun: true,
    });
    expect(readChatRuntimePolicyState('chat-1').access).toBe('write');
    expect(clearApproveAllForRun('chat-1').approveAllForRun).toBe(false);
    expect(readChatRuntimePolicyState('chat-1').settings.effort).toBe('max');
  });

  it('fails closed to safe bounded defaults for malformed state', () => {
    expect(sanitizeChatRuntimePolicyState({ access: 'root', settings: { effort: 'impossible' } }))
      .toEqual({
        settings: { effort: 'auto', fastMode: 'auto', performance: 'quality', rlmEnabled: true },
        access: 'full',
        approveAllForRun: false,
      });
  });
});
