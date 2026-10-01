import { renderHook } from '@testing-library/react';
import type { PropsWithChildren } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { PluginManagementCapability } from './runtime';
import {
  PluginManagementCapabilityProvider,
  usePluginManagementCapability,
} from './managementContext';

function capability(): PluginManagementCapability {
  return {
    beginAuthorization: vi.fn(async () => ({
      ok: false as const,
      error: 'not configured',
    })),
    cancelAuthorization: vi.fn(async () => undefined),
    saveCredential: vi.fn(async () => undefined),
    testConnection: vi.fn(async () => ({ ok: true })),
    disconnect: vi.fn(async () => undefined),
  };
}

describe('plugin management context', () => {
  it('exposes only the injected closed capability', () => {
    const management = capability();
    const wrapper = ({ children }: PropsWithChildren) => (
      <PluginManagementCapabilityProvider value={management}>
        {children}
      </PluginManagementCapabilityProvider>
    );

    expect(renderHook(() => usePluginManagementCapability(), { wrapper }).result.current).toBe(
      management,
    );
  });

  it('is unavailable when the trusted host did not provide authority', () => {
    expect(renderHook(() => usePluginManagementCapability()).result.current).toBeUndefined();
  });
});
