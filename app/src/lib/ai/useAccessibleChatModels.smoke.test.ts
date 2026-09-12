import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/jarvis/smoke/config', () => ({ isKernelSmokeEnabled: () => true }));

import { activateKernelSmokeBinding, clearKernelSmokeBinding } from './providers/kernelSmoke';
import { useAccessibleChatModels } from './useAccessibleChatModels';

describe('smoke connection model access', () => {
  afterEach(() => clearKernelSmokeBinding());

  it('exposes both attested smoke transports only after the development binding activates', async () => {
    const { result } = renderHook(() => useAccessibleChatModels());
    expect(
      result.current.flatOptions.filter(
        ({ provider }) => String(provider) === 'vibespace-kernel-smoke',
      ),
    ).toEqual([]);

    act(() => {
      activateKernelSmokeBinding({
        nativePid: 42,
        cdpPort: 39177,
        profileSha256: 'a'.repeat(64),
        nonce: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      });
    });

    await waitFor(() =>
      expect(
        result.current.flatOptions
          .filter(({ provider }) => String(provider) === 'vibespace-kernel-smoke')
          .map(({ id, available }) => ({ id, available })),
      ).toEqual([
        { id: 'vibespace-kernel-smoke-cli:kernel-smoke-v1', available: true },
        { id: 'vibespace-kernel-smoke-native:kernel-smoke-v1', available: true },
      ]),
    );
  });
});
