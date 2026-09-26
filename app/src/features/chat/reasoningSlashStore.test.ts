import { beforeEach, describe, expect, it } from 'vitest';
import { resolveReasoningPolicy } from '@/lib/ai/reasoningControls';
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

  it.each(['token-saver', 'token-final-boss'] as const)(
    'keeps %s selected when the model effort changes or resets',
    (mode) => {
      writeChatReasoningMode('chat-mode', mode, localStorage);
      writeChatReasoningEffort('chat-mode', 'low', localStorage);
      expect(readChatReasoningPreference('chat-mode', localStorage)).toEqual({
        mode,
        effortOverride: 'low',
      });
      writeChatReasoningEffort('chat-mode', null, localStorage);
      expect(readChatReasoningPreference('chat-mode', localStorage)).toEqual({
        mode,
        effortOverride: null,
      });
    },
  );

  it('keeps persistence bounded to the 128 most recently written chats', () => {
    for (let index = 0; index < 140; index += 1) {
      writeChatReasoningEffort(`chat-${index}`, 'low', localStorage);
    }
    const stored = JSON.parse(localStorage.getItem('vibespace.chat-reasoning.v1') ?? '{}');
    expect(Object.keys(stored.chats)).toHaveLength(128);
    expect(stored.chats['chat-0']).toBeUndefined();
    expect(stored.chats['chat-139']).toMatchObject({ effortOverride: 'low' });
  });

  it('builds model-aware effort options and reports a supported active value', () => {
    const state = buildReasoningSlashPickerState({
      command: 'effort',
      selection: {
        providerId: 'google',
        modelId: 'gemini-2.5-pro',
      },
      preference: { mode: 'normal', effortOverride: 'low' },
    });
    expect(state.options.map(({ id }) => id)).toEqual(['auto', 'low', 'medium', 'high']);
    expect(state.selectedId).toBe('low');
    expect(state.error).toBeUndefined();
  });

  it.each([
    {
      label: 'a saved level below the supported range',
      selection: { providerId: 'google', modelId: 'gemini-2.5-pro' },
      requested: 'minimal',
    },
    {
      label: 'Ultra on the distinct Luna effort range',
      selection: {
        providerId: 'openai',
        modelId: 'gpt-5.6-luna',
        connectionId: 'openai-codex',
      },
      requested: 'ultra',
    },
    {
      label: 'a saved level above a single-effort model',
      selection: {
        providerId: 'openai',
        modelId: 'gpt-5.3-codex-spark',
        connectionId: 'openai-codex',
      },
      requested: 'high',
    },
  ] as const)(
    'does not mark a substitute active when dispatch rejects $label',
    ({ selection, requested }) => {
      writeChatReasoningEffort('chat-stale', requested, localStorage);
      const preference = readChatReasoningPreference('chat-stale', localStorage);
      expect(() => resolveReasoningPolicy({ selection, preference })).toThrow('is unsupported');

      const state = buildReasoningSlashPickerState({
        command: 'effort',
        selection,
        preference,
      });

      expect(state.selectedId).toBe('');
      expect(state.options.some(({ id }) => id === requested)).toBe(false);
      expect(state.options.some(({ id }) => id === 'auto')).toBe(true);
      // An error replaces the option list in the existing picker. Keep the
      // valid choices visible so the user can explicitly repair the selection.
      expect(state.error).toBeUndefined();
      expect(readChatReasoningPreference('chat-stale', localStorage)).toEqual(preference);
      expect(preference.effortOverride).toBe(requested);
    },
  );

  it('marks Auto active only when there is no saved effort override', () => {
    const state = buildReasoningSlashPickerState({
      command: 'effort',
      selection: { providerId: 'google', modelId: 'gemini-2.5-pro' },
      preference: { mode: 'normal', effortOverride: null },
    });
    expect(state.selectedId).toBe('auto');
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
    expect(parseReasoningEffortArgument('max')).toBe('max');
    expect(parseReasoningEffortArgument('maximum')).toBe('max');
    expect(parseReasoningEffortArgument('default')).toBeNull();
    expect(parseReasoningEffortArgument('impossible')).toBeUndefined();
    expect(parseReasoningModeArgument('token saver')).toBe('token-saver');
    expect(parseReasoningModeArgument('final boss')).toBe('token-final-boss');
    expect(parseReasoningModeArgument('deep forever')).toBeUndefined();
  });

  it('offers distinct Ultra and Max controls for OpenCode models', () => {
    const state = buildReasoningSlashPickerState({
      command: 'effort',
      selection: {
        providerId: 'openai',
        modelId: 'gpt-5.6-sol',
        connectionId: 'openai-codex',
      },
      preference: { mode: 'normal', effortOverride: 'max' },
    });
    expect(state.options.map(({ id }) => id)).toEqual([
      'auto',
      'low',
      'medium',
      'high',
      'ultra',
      'max',
    ]);
    expect(state.selectedId).toBe('max');
  });
});
