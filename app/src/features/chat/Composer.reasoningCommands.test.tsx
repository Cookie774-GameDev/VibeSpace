import { describe, expect, it } from 'vitest';
import {
  applyChatReasoningMode,
  reasoningSelectionFromChatModel,
  tokenBossContextFromChatModel,
  tokenBossProviderForMode,
} from './Composer';
import { readChatReasoningPreference } from './reasoningSlashStore';
import { browserTokenOptimizationPreferences } from '@/features/token-optimizer';

describe('Composer reasoning command selection', () => {
  it('captures the exact single model and connection without changing it', () => {
    expect(
      reasoningSelectionFromChatModel({
        mode: 'single',
        providerId: 'openai',
        modelId: 'gpt-5.6-sol',
        connectionId: 'openai-codex',
      }),
    ).toEqual({
      providerId: 'openai',
      modelId: 'gpt-5.6-sol',
      connectionId: 'openai-codex',
    });
  });

  it('does not pretend a Hive or empty selection has one adjustable model', () => {
    expect(reasoningSelectionFromChatModel({ mode: 'none' })).toBeNull();
    expect(reasoningSelectionFromChatModel({ mode: 'hive', hiveId: 'balanced' })).toBeNull();
  });

  it('captures the current model context used by Token Boss without creating another model store', () => {
    expect(
      tokenBossContextFromChatModel({
        mode: 'single',
        providerId: 'openai',
        modelId: 'gpt-5.6-sol',
        connectionId: 'openai-codex',
      }),
    ).toEqual({
      providerId: 'openai',
      modelId: 'gpt-5.6-sol',
      connectionId: 'openai-codex',
    });
    expect(tokenBossContextFromChatModel({ mode: 'none' })).toBeNull();
  });

  it('activates Token Boss only for Final Boss mode using the selected model provider', () => {
    const selection = {
      mode: 'single',
      providerId: 'google',
      modelId: 'gemini-2.5-pro',
      connectionId: 'gemini-cloud',
    };

    expect(tokenBossProviderForMode('normal', selection)).toBeNull();
    expect(tokenBossProviderForMode('token-saver', selection)).toBeNull();
    expect(tokenBossProviderForMode('token-final-boss', selection)?.id).toBe('gemini');
    expect(tokenBossProviderForMode('token-final-boss', { mode: 'hive' })).toBeNull();
  });

  it('makes /mode update both reasoning and the matching per-chat optimization runtime', () => {
    window.localStorage.clear();
    browserTokenOptimizationPreferences.refresh();

    applyChatReasoningMode('chat-final-boss', 'token-final-boss');
    expect(readChatReasoningPreference('chat-final-boss')).toEqual({
      mode: 'token-final-boss',
      effortOverride: null,
    });
    expect(browserTokenOptimizationPreferences.resolveMode('chat-final-boss')).toBe('final_boss');

    applyChatReasoningMode('chat-saver', 'token-saver');
    expect(browserTokenOptimizationPreferences.resolveMode('chat-saver')).toBe('saver');

    applyChatReasoningMode('chat-normal', 'normal');
    expect(browserTokenOptimizationPreferences.resolveMode('chat-normal')).toBe('normal');
  });
});
