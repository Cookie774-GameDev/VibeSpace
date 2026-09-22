import { describe, expect, it } from 'vitest';
import {
  applyChatReasoningMode,
  authoritativeLiveEffortsFromDiscoveredModels,
  authoritativeLiveEffortsForSelection,
  liveAuthorityRejectsEffort,
  liveEffortPickerState,
  reasoningSelectionFromChatModel,
  tokenBossContextFromChatModel,
  tokenBossProviderForMode,
} from './Composer';
import { readChatReasoningPreference } from './reasoningSlashStore';
import { browserTokenOptimizationPreferences } from '@/features/token-optimizer';
import type { ProviderId } from '@/types';

describe('Composer reasoning command selection', () => {
  const deepSeekSelection = {
    mode: 'single' as const,
    providerId: 'opencode' as ProviderId,
    modelId: 'opencode-go/deepseek-v4-flash-vision-exp',
    connectionId: 'opencode-cli',
  };
  const deepSeekOption = {
    id: 'opencode-cli:opencode-go/deepseek-v4-flash-vision-exp',
    provider: 'opencode' as ProviderId,
    modelId: 'opencode-go/deepseek-v4-flash-vision-exp',
    label: 'DeepSeek V4 Flash Vision Exp',
    connectionId: 'opencode-cli',
    catalogSource: 'opencode-live' as const,
    variants: ['low', 'high', 'max'] as const,
  };

  it('uses only the exact selected live model variants as effort authority', () => {
    const allowed = authoritativeLiveEffortsForSelection(deepSeekSelection, [deepSeekOption]);
    expect(allowed).toEqual(['auto', 'low', 'high', 'max']);
    expect(liveAuthorityRejectsEffort('medium', allowed)).toBe(true);
    expect(liveAuthorityRejectsEffort('high', allowed)).toBe(false);
    expect(liveEffortPickerState(allowed!, 'medium')).toMatchObject({
      selectedId: 'auto',
      options: [{ id: 'auto' }, { id: 'low' }, { id: 'high' }, { id: 'max' }],
    });
  });

  it('uses the authenticated Codex catalog for the same picker and slash effort choices', () => {
    const selection = { ...deepSeekSelection, providerId: 'openai' as ProviderId,
      connectionId: 'openai-codex', modelId: 'gpt-5.6-luna' };
    const allowed = authoritativeLiveEffortsForSelection(selection, [{
      ...deepSeekOption, id: 'openai-codex:gpt-5.6-luna', provider: 'openai' as ProviderId,
      connectionId: 'openai-codex', modelId: 'gpt-5.6-luna', catalogSource: 'provider-live',
      variants: ['low', 'high'],
    }]);
    expect(allowed).toEqual(['auto', 'low', 'high']);
    expect(liveEffortPickerState(allowed!, 'medium').options.map(({ id }) => id))
      .toEqual(['auto', 'low', 'high']);
    expect(liveAuthorityRejectsEffort('medium', allowed)).toBe(true);
  });

  it.each([
    ['missing row', []],
    ['cold offline row', [{ ...deepSeekOption, catalogSource: 'offline-cache' as const }]],
    ['unknown variants', [{ ...deepSeekOption, variants: undefined }]],
  ] as const)('keeps %s adapter-authoritative without rejecting effort', (_label, options) => {
    const allowed = authoritativeLiveEffortsForSelection(deepSeekSelection, options);
    expect(allowed).toBeNull();
    expect(liveAuthorityRejectsEffort('medium', allowed)).toBe(false);
  });

  it('treats an authoritative empty variant list as Auto-only without substitution', () => {
    const allowed = authoritativeLiveEffortsForSelection(deepSeekSelection, [
      { ...deepSeekOption, variants: [] },
    ]);
    expect(allowed).toEqual(['auto']);
    expect(liveAuthorityRejectsEffort('medium', allowed)).toBe(true);
    expect(liveEffortPickerState(allowed!, 'medium').selectedId).toBe('auto');
  });

  it('recovers exact effort authority from the live OpenCode catalog only', () => {
    const allowed = authoritativeLiveEffortsFromDiscoveredModels(deepSeekSelection, [
      {
        id: 'opencode-go/deepseek-v4-flash-vision-exp',
        label: 'DeepSeek V4 Flash Vision Exp',
        variants: ['low', 'high', 'max'],
      },
      { id: 'other/model', label: 'Other', variants: ['medium'] },
    ]);
    expect(allowed).toEqual(['auto', 'low', 'high', 'max']);
    expect(
      authoritativeLiveEffortsFromDiscoveredModels(
        { ...deepSeekSelection, connectionId: 'openai-codex' },
        [{ id: deepSeekSelection.modelId, label: 'Wrong connection', variants: ['medium'] }],
      ),
    ).toBeNull();
    expect(
      authoritativeLiveEffortsFromDiscoveredModels(deepSeekSelection, [
        {
          id: 'another-provider/deepseek-v4-flash-vision-exp',
          label: 'Same leaf, wrong route',
          variants: ['medium'],
        },
      ]),
    ).toBeNull();
    expect(
      authoritativeLiveEffortsFromDiscoveredModels(deepSeekSelection, [
        {
          id: 'opencode-go/deepseek-v4-flash-vision-exp',
          label: 'Unknown variants',
        },
      ]),
    ).toBeNull();
    expect(
      authoritativeLiveEffortsFromDiscoveredModels(deepSeekSelection, [
        {
          id: 'opencode-go/deepseek-v4-flash-vision-exp',
          label: 'Auto only',
          variants: [],
        },
      ]),
    ).toEqual(['auto']);
    expect(authoritativeLiveEffortsFromDiscoveredModels(deepSeekSelection, [])).toBeNull();
  });

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
    expect(browserTokenOptimizationPreferences.resolveMode('chat-normal')).toBe('off');
  });
});
