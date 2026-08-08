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
    route: 'chat',
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
      workspaceId: 'workspace-sakura',
      projectId: 'project-sakura',
      displayName: 'Sakura',
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

describe('TopBar Sakura native chrome contract', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('keeps an explicit native drag surface while every interactive cluster opts out', () => {
    render(<TopBar />);

    const header = screen.getByRole('banner', { name: 'Application header' });
    const dragSpace = header.querySelector('[data-sakura-drag-space="true"]');
    const controls = Array.from(header.querySelectorAll('button'));

    expect(header.getAttribute('data-sakura-shell-region')).toBe('top-bar');
    expect(header.hasAttribute('data-tauri-drag-region')).toBe(true);
    expect(dragSpace?.hasAttribute('data-tauri-drag-region')).toBe(true);
    expect(controls.length).toBeGreaterThan(0);
    expect(
      controls.every((control) => control.hasAttribute('data-tauri-drag-region') === false),
    ).toBe(true);
    expect(controls.every((control) => control.closest('.no-drag') !== null)).toBe(true);
  });
});
