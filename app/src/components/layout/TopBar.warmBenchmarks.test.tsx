import * as React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { ui } = vi.hoisted(() => ({
  ui: {
    navOpen: true,
    inspectorOpen: false,
    voiceListening: false,
    composerSttListening: false,
    composerStt: true,
    route: 'benchmarks',
    theme: 'warm',
    toggleNav: vi.fn(),
    toggleInspector: vi.fn(),
    setVoiceModalOpen: vi.fn(),
    setPaletteOpen: vi.fn(),
    setSettingsOpen: vi.fn(),
    setLauncherOpen: vi.fn(),
    setAssistantOpen: vi.fn(),
    setWhatsNewOpen: vi.fn(),
    setNewsPanelOpen: vi.fn(),
    setRoute: vi.fn(),
  },
}));

vi.mock('@/stores/ui', () => ({
  createDefaultDoneNotifications: () => ({
    jarvis: false,
    terminal: false,
    tasks: false,
    contextMaps: false,
    skills: false,
    connectors: false,
    reminders: false,
  }),
  useUIStore: (selector: (state: typeof ui) => unknown) => selector(ui),
}));

vi.mock('@/stores/auth', () => ({
  useAuthStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      workspaceId: 'workspace-warm',
      projectId: 'project-warm',
      displayName: 'Surya',
      plan: 'pro',
    }),
}));

vi.mock('@/features/whats-new', () => ({
  useWhatsNew: () => ({ hasUpdate: false, currentVersion: 'test' }),
}));

vi.mock('@/features/call/store', () => ({
  useCallStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({ status: 'idle' }),
}));

vi.mock('@/features/call', () => ({
  isCallConfigured: () => false,
  loadCallService: vi.fn(),
}));

vi.mock('@/lib/admin', () => ({ useAppAdmin: () => false }));
vi.mock('@/lib/jarvis/smoke/config', () => ({ isKernelSmokeEnabled: () => false }));
vi.mock('@/components/ui/tooltip', () => ({
  Hint: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

import { TopBar } from './TopBar';

describe('TopBar Warm Benchmarks reference state', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('renders route-scoped VibeSpace branding and the warm Jarvis avatar without changing account identity', () => {
    render(<TopBar />);

    const header = screen.getByRole('banner', { name: 'Application header' });
    expect(header.getAttribute('data-warm-shell-route')).toBe('benchmarks');
    expect(screen.getByText('VibeSpace')).toBeTruthy();
    expect(screen.queryByText('Workspace')).toBeNull();

    const voiceControl = screen.getByRole('button', { name: 'Open Jarvis voice panel' });
    expect(voiceControl.getAttribute('data-warm-brand-mark')).toBe('true');

    const accountControl = screen.getByRole('button', { name: 'Open account for Surya' });
    expect(accountControl.textContent).toBe('J');
  });
});
