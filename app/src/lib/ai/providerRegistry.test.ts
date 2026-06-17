import { describe, expect, it } from 'vitest';
import {
  formatProviderOptionLabel,
  getProviderDisplayName,
  isProviderConnected,
} from './providerRegistry';

describe('providerRegistry', () => {
  it('maps google internal id to Gemini display name', () => {
    expect(getProviderDisplayName('google')).toBe('Gemini');
  });

  it('formats connected provider labels for dropdowns', () => {
    const label = formatProviderOptionLabel('groq', {
      apiKeys: { groq: 'gsk_test' },
      offlineMode: false,
      plan: 'free',
    });
    expect(label).toBe('Groq — Connected');
  });

  it('marks missing API key providers as not connected on free plan', () => {
    expect(
      isProviderConnected('google', {
        apiKeys: {},
        offlineMode: false,
        plan: 'free',
      }),
    ).toBe(false);
  });

  it('allows hosted google on paid plans without BYOK', () => {
    expect(
      isProviderConnected('google', {
        apiKeys: {},
        offlineMode: false,
        plan: 'starter',
      }),
    ).toBe(true);
  });
});
