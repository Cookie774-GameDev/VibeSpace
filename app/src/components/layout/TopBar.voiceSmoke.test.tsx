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
const smokeGate = vi.hoisted(() => ({ enabled: false }));
const whatsNew = vi.hoisted(() => ({ hasUpdate: false, currentVersion: 'test' }));

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
      workspaceId: 'workspace-smoke',
      projectId: 'project-smoke',
      displayName: 'Smoke',
      plan: 'pro',
    }),
}));

vi.mock('@/features/whats-new', () => ({
  useWhatsNew: () => whatsNew,
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
vi.mock('@/lib/jarvis/smoke/config', () => ({
  isKernelSmokeEnabled: () => smokeGate.enabled,
}));

vi.mock('@/components/ui/tooltip', () => ({
  Hint: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

import { TopBar } from './TopBar';

function renderTopBar(enabled: boolean) {
  smokeGate.enabled = enabled;
  render(<TopBar />);
}

function expectVisibleHeaderControlsToPreserveMinimumPointerTargets() {
  const header = screen.getByRole('banner', { name: 'Application header' });
  const controls = Array.from(header.querySelectorAll<HTMLButtonElement>('button'));

  expect(controls.length).toBeGreaterThan(0);
  for (const control of controls) {
    expect(control.className, control.getAttribute('aria-label') ?? control.textContent).toContain(
      'min-h-6',
    );
    expect(control.className, control.getAttribute('aria-label') ?? control.textContent).toContain(
      'min-w-6',
    );
  }
}

describe('TopBar voice smoke evidence', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    ui.voiceListening = false;
    ui.composerSttListening = false;
    ui.route = 'chat';
    whatsNew.hasUpdate = false;
  });

  it('fails closed without the exact development smoke flag', async () => {
    renderTopBar(false);

    const opener = screen.getByRole('button', { name: 'Open Jarvis voice panel' });
    expect(opener.getAttribute('data-sik-evidence')).toBeNull();
  });

  it('does not expose the obsolete Jarvis Assistant header launcher', () => {
    renderTopBar(false);

    expect(screen.queryByRole('button', { name: 'Open Jarvis Assistant' })).toBeNull();
    expect(screen.queryByRole('menuitem', { name: /Assistant/i })).toBeNull();
  });

  it('exposes one top-right Chat Modes entry with the shared pointer target', () => {
    renderTopBar(false);

    const control = screen.getByRole('button', { name: /chat modes/i });
    expect(control.className).toContain('min-h-6');
    expect(control.className).toContain('min-w-6');
  });

  it('places the unique voice.open selector on the genuine opener', async () => {
    renderTopBar(true);

    const opener = screen.getByRole('button', { name: 'Open Jarvis voice panel' });
    expect(opener.getAttribute('data-sik-evidence')).toBe('voice.open');
    expect(document.querySelectorAll('[data-sik-evidence="voice.open"]')).toHaveLength(1);

    fireEvent.click(opener);
    expect(ui.setVoiceModalOpen).toHaveBeenCalledWith(true);
  });

  it('marks every decorative listening pulse for MonoChrome suppression', () => {
    ui.voiceListening = true;
    ui.composerSttListening = true;

    renderTopBar(false);

    expect(
      document.querySelectorAll('[data-monochrome-voice-listening-effect="true"]'),
    ).toHaveLength(2);
    expect(screen.getByRole('button', { name: 'Stop dictation' })).toBeTruthy();
  });

  it('marks the unread ring for the shared MonoChrome shadow override', () => {
    whatsNew.hasUpdate = true;

    renderTopBar(false);

    const indicator = document.querySelector('[data-monochrome-unread-indicator="true"]');
    expect(indicator).not.toBeNull();
    expect(indicator?.className).toContain('ring-2 ring-panel');
  });

  it('keeps every visible normal and compact header control at least 24 by 24 pixels', () => {
    const rendered = render(<TopBar />);
    expectVisibleHeaderControlsToPreserveMinimumPointerTargets();

    ui.route = 'terminal';
    rendered.rerender(<TopBar />);
    expectVisibleHeaderControlsToPreserveMinimumPointerTargets();
  });
});
