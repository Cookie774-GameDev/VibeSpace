import * as React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const ui = vi.hoisted(() => ({
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
      workspaceId: 'workspace-foundry',
      projectId: 'project-foundry',
      displayName: 'Builder',
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

describe('TopBar Build Your Own AI entry', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    ui.route = 'chat';
  });

  it('opens the dedicated route from the normal top-right cluster', () => {
    render(<TopBar />);

    fireEvent.click(screen.getByRole('button', { name: 'Open Build Your Own AI' }));

    expect(ui.setRoute).toHaveBeenCalledWith('model-foundry');
  });

  it('keeps the action available from compact chrome', () => {
    ui.route = 'terminal';
    render(<TopBar />);

    fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Build Your Own AI' }));

    expect(ui.setRoute).toHaveBeenCalledWith('model-foundry');
  });
});
