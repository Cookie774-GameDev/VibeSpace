import { describe, expect, it, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { syncDiscoveredOllamaModels } from './models';
import { buildModelPickerGroups, useAccessibleChatModels } from './useAccessibleChatModels';

describe('useAccessibleChatModels', () => {
  beforeEach(() => {
    syncDiscoveredOllamaModels([]);
  });

  it('includes discovered Ollama models in picker groups', () => {
    syncDiscoveredOllamaModels(['qwen3:4b']);

    const groups = buildModelPickerGroups({
      apiKeys: {},
      offlineMode: false,
      plan: 'free',
      defaultLocalModel: 'qwen3:4b',
    });

    expect(groups.some((group) => group.provider === 'ollama')).toBe(true);
    expect(groups.find((group) => group.provider === 'ollama')?.options).toEqual([
      expect.objectContaining({ modelId: 'qwen3:4b', label: 'qwen3:4b' }),
    ]);
  });

  it('reacts when Ollama discovery updates', () => {
    const { result, rerender } = renderHook(() => useAccessibleChatModels());
    expect(result.current.hasAny).toBe(false);

    syncDiscoveredOllamaModels(['llama3.2']);
    rerender();

    expect(result.current.hasAny).toBe(true);
    expect(result.current.flatOptions[0]?.modelId).toBe('llama3.2');
  });
});
