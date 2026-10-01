import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearApproveAllForRun,
  readChatRuntimePolicyState,
  sanitizeChatRuntimePolicyState,
  writeChatRuntimePolicyState,
} from './chatRuntimeSettingsStore';
import { resolveRlmEnabled, setChatRlmEnabled } from '@/features/context/rlmPreferenceStore';
import { useAuthStore } from '@/stores/auth';

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
    expect(
      sanitizeChatRuntimePolicyState({ access: 'root', settings: { effort: 'impossible' } }),
    ).toEqual({
      settings: { effort: 'auto', fastMode: 'auto', performance: 'quality', rlmEnabled: true },
      access: 'full',
      approveAllForRun: false,
    });
  });

  it('preserves legacy runtime off for context tools and permits an explicit shared on', () => {
    localStorage.setItem(
      'vibespace.chat-runtime-settings.v1',
      JSON.stringify({
        schemaVersion: 1,
        chats: { legacy: { settings: { rlmEnabled: false } } },
      }),
    );
    expect(readChatRuntimePolicyState('legacy').settings.rlmEnabled).toBe(false);
    expect(resolveRlmEnabled({ chatId: 'legacy' }).enabled).toBe(false);
    const state = readChatRuntimePolicyState('legacy');
    writeChatRuntimePolicyState('legacy', {
      ...state,
      settings: { ...state.settings, rlmEnabled: true },
    });
    expect(readChatRuntimePolicyState('legacy').settings.rlmEnabled).toBe(true);
    expect(resolveRlmEnabled({ chatId: 'legacy' }).enabled).toBe(true);
  });

  it('preserves context off when unrelated runtime controls change', () => {
    setChatRlmEnabled('context-off', false);
    const state = readChatRuntimePolicyState('context-off');
    writeChatRuntimePolicyState('context-off', {
      ...state,
      settings: { ...state.settings, performance: 'responsive' },
    });
    expect(readChatRuntimePolicyState('context-off').settings.rlmEnabled).toBe(false);
    expect(resolveRlmEnabled({ chatId: 'context-off' }).enabled).toBe(false);
  });

  it('honors the applicable workspace disabled preference for a fresh chat', () => {
    const workspaceId = useAuthStore.getState().workspaceId;
    useAuthStore.setState({ workspaceId: 'rlm-off-workspace' as never });
    try {
      localStorage.setItem(
        'vibespace.rlm-preference.v1',
        JSON.stringify({
          version: 1,
          userDefault: true,
          chats: {},
          workspaces: { 'rlm-off-workspace': { enabled: false, updatedAt: 1 } },
        }),
      );
      expect(readChatRuntimePolicyState('new-chat').settings.rlmEnabled).toBe(false);
    } finally {
      useAuthStore.setState({ workspaceId });
    }
  });
});
