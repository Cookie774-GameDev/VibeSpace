import * as React from 'react';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/ai/models', () => ({
  useOllamaModelOptions: () => [],
}));

vi.mock('@/lib/ai/ollamaBootstrap', () => ({
  bootstrapOllamaConnection: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/features/local-models/OllamaConnectionHost', () => ({
  OllamaConnectionHost: () => <div data-testid="ollama-host" />,
}));

vi.mock('@/features/onboarding', () => ({
  Onboarding: () => <div data-testid="onboarding" />,
}));

vi.mock('./RequireModelAccess', () => ({
  RequireModelAccess: () => <div data-testid="model-access" />,
}));

vi.mock('@/lib/jarvis/smoke/config', () => ({
  isKernelSmokeEnabled: () => true,
}));

import {
  activateKernelSmokeBinding,
  clearKernelSmokeBinding,
} from '@/lib/ai/providers/kernelSmoke';
import { useAuthStore } from '@/stores/auth';
import { useUIStore } from '@/stores/ui';
import { bootstrapOllamaConnection } from '@/lib/ai/ollamaBootstrap';
import { AuthGate } from './AuthGate';

const binding = Object.freeze({
  nativePid: 42,
  cdpPort: 39177,
  profileSha256: 'a'.repeat(64),
  nonce: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
});

describe('AuthGate kernel smoke entry', () => {
  beforeEach(() => {
    vi.mocked(bootstrapOllamaConnection).mockClear();
    clearKernelSmokeBinding();
    useAuthStore.setState(useAuthStore.getInitialState(), true);
    useUIStore.setState(useUIStore.getInitialState(), true);
    useAuthStore.setState({
      localUserId: 'account-smoke',
      offlineMode: false,
      apiKeys: {},
    });
    useUIStore.setState({ onboardingComplete: false });
  });

  afterEach(() => {
    cleanup();
    clearKernelSmokeBinding();
    useAuthStore.setState(useAuthStore.getInitialState(), true);
    useUIStore.setState(useUIStore.getInitialState(), true);
  });

  it('keeps a fresh profile behind onboarding before native attestation', () => {
    render(
      <AuthGate>
        <div data-testid="workspace" />
      </AuthGate>,
    );

    expect(screen.getByTestId('onboarding')).toBeTruthy();
    expect(screen.queryByTestId('workspace')).toBeNull();
  });

  it('leaves Ollama discovery to the mounted connection host without a duplicate bootstrap', () => {
    const view = render(
      <AuthGate>
        <div data-testid="workspace" />
      </AuthGate>,
    );

    expect(screen.getByTestId('ollama-host')).toBeTruthy();
    expect(bootstrapOllamaConnection).not.toHaveBeenCalled();

    view.unmount();

    expect(bootstrapOllamaConnection).not.toHaveBeenCalled();
  });

  it('keeps an onboarded profile behind model access before native attestation', () => {
    useUIStore.setState({ onboardingComplete: true });

    render(
      <AuthGate>
        <div data-testid="workspace" />
      </AuthGate>,
    );

    expect(screen.getByTestId('model-access')).toBeTruthy();
    expect(screen.queryByTestId('workspace')).toBeNull();
  });

  it('admits only the attested debug smoke provider without persisting onboarding or credentials', () => {
    activateKernelSmokeBinding(binding);

    render(
      <AuthGate>
        <div data-testid="workspace" />
      </AuthGate>,
    );

    expect(screen.getByTestId('workspace')).toBeTruthy();
    expect(screen.queryByTestId('onboarding')).toBeNull();
    expect(screen.queryByTestId('model-access')).toBeNull();
    expect(useUIStore.getState().onboardingComplete).toBe(false);
    expect(useAuthStore.getState().offlineMode).toBe(false);
    expect(useAuthStore.getState().apiKeys).toEqual({});
  });

  it('closes the workspace again when the in-memory native binding is cleared', () => {
    activateKernelSmokeBinding(binding);
    render(
      <AuthGate>
        <div data-testid="workspace" />
      </AuthGate>,
    );
    expect(screen.getByTestId('workspace')).toBeTruthy();

    act(() => clearKernelSmokeBinding());

    expect(screen.getByTestId('onboarding')).toBeTruthy();
    expect(screen.queryByTestId('workspace')).toBeNull();
  });
});
