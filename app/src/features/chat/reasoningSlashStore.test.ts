import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearChatReasoningPreferences,
  buildReasoningSlashPickerState,
  parseReasoningEffortArgument,
  parseReasoningModeArgument,
  readChatReasoningPreference,
  writeChatReasoningEffort,
  writeChatReasoningMode,
} from './reasoningSlashStore';

describe('per-chat reasoning slash preferences', () => {
  beforeEach(() => {
    localStorage.clear();
    clearChatReasoningPreferences(localStorage);
  });

  it('defaults each chat to Normal with no manual effort', () => {
    expect(readChatReasoningPreference('chat-a', localStorage)).toEqual({
      mode: 'normal',
      effortOverride: null,
    });
  });

  it('isolates chats and clears a manual override when a mode is selected', () => {
    writeChatReasoningEffort('chat-a', 'high', localStorage);
    writeChatReasoningMode('chat-b', 'token-final-boss', localStorage);
    expect(readChatReasoningPreference('chat-a', localStorage)).toEqual({
      mode: 'normal',
      effortOverride: 'high',
    });
    expect(readChatReasoningPreference('chat-b', localStorage)).toEqual({
      mode: 'token-final-boss',
      effortOverride: null,
    });

    writeChatReasoningMode('chat-a', 'token-saver', localStorage);
    expect(readChatReasoningPreference('chat-a', localStorage)).toEqual({
      mode: 'token-saver',
      effortOverride: null,
    });
  });

  it('recovers safely from malformed persistence', () => {
    localStorage.setItem(
      'vibespace.chat-reasoning.v1',
      JSON.stringify({ version: 1, chats: { 'chat-a': { mode: 'warp', effortOverride: 'all' } } }),
    );
    expect(readChatReasoningPreference('chat-a', localStorage)).toEqual({
      mode: 'normal',
      effortOverride: null,
    });
  });

  it('keeps persistence bounded to the 128 most recently written chats', () => {
    for (let index = 0; index < 140; index += 1) {
      writeChatReasoningEffort(`chat-${index}`, 'low', localStorage);
    }
    const stored = JSON.parse(localStorage.getItem('vibespace.chat-reasoning.v1') ?? '{}');
    expect(Object.keys(stored.chats)).toHaveLength(128);
    expect(stored.chats['chat-0']).toBeUndefined();
    expect(stored.chats['chat-139']).toMatchObject({ effortOverride: 'low' });
  });

  it('builds model-aware effort options and reports the snapped active value', () => {
    const state = buildReasoningSlashPickerState({
      command: 'effort',
      selection: {
        providerId: 'google',
        modelId: 'gemini-2.5-pro',
      },
      preference: { mode: 'normal', effortOverride: 'minimal' },
    });
    expect(state.options.map(({ id }) => id)).toEqual(['auto', 'low', 'medium', 'high']);
    expect(state.selectedId).toBe('low');
    expect(state.error).toBeUndefined();
  });

  it('keeps all three policy modes available even when the model has no effort control', () => {
    const state = buildReasoningSlashPickerState({
      command: 'mode',
      selection: { providerId: 'qwen', modelId: 'qwen3.6-27b' },
      preference: { mode: 'normal', effortOverride: null },
    });
    expect(state.options.map(({ id }) => id)).toEqual([
      'token-saver',
      'normal',
      'token-final-boss',
    ]);
    expect(state.selectedId).toBe('normal');
  });

  it('parses friendly command spellings and rejects unknown values', () => {
    expect(parseReasoningEffortArgument('X-HIGH')).toBe('ultra');
    expect(parseReasoningEffortArgument('default')).toBeNull();
    expect(parseReasoningEffortArgument('impossible')).toBeUndefined();
    expect(parseReasoningModeArgument('token saver')).toBe('token-saver');
    expect(parseReasoningModeArgument('final boss')).toBe('token-final-boss');
    expect(parseReasoningModeArgument('deep forever')).toBeUndefined();
  });
});
