import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { createBrowserTokenOptimizationPreferences } from './browserPreferences';

describe('browser Token Optimize preferences', () => {
  it('persists global and per-chat choices without changing a model setting', () => {
    const values = new Map<string, string>();
    const preferences = createBrowserTokenOptimizationPreferences({
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => void values.set(key, value),
      removeItem: (key) => void values.delete(key),
    });
    preferences.setGlobalMode('saver');
    preferences.setChatOverride('chat-1', 'final_boss');
    expect(preferences.resolveMode('chat-1')).toBe('final_boss');
    expect(preferences.resolveMode('chat-2')).toBe('saver');
    const persisted = [...values.values()].join('');
    expect(persisted).toContain('"neverChangeSelectedModel":true');
    expect(persisted).not.toMatch(/"(?:selectedModel|modelId|providerId)"/i);
  });

  it('uses accessible radio semantics for the global setting', async () => {
    const { TokenOptimizationGlobalSettings } = await import('./TokenOptimizationGlobalSettings');
    render(<TokenOptimizationGlobalSettings />);
    fireEvent.click(screen.getByRole('radio', { name: 'Token Saver' }));
    expect(screen.getByRole('radio', { name: 'Token Saver' }).getAttribute('aria-checked')).toBe(
      'true',
    );
  });
});
