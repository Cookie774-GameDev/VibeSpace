import * as React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const toolState = vi.hoisted(() => ({
  tools: [],
  importMany: vi.fn(() => 0),
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
}));

vi.mock('./toolStore', () => ({
  useToolStore: (selector: (state: typeof toolState) => unknown) => selector(toolState),
  slugify: (value: string) => value.toLowerCase().replace(/\s+/gu, '-'),
  parseToolStepsJson: vi.fn(() => []),
}));

vi.mock('@/lib/actions', () => ({
  getBuiltinActions: vi.fn(() => []),
  runAction: vi.fn(async () => ({ ok: true })),
}));

vi.mock('./open-in-terminal/OpenInTerminalDialog', () => ({
  OpenInTerminalDialog: ({ open }: { open: boolean }) =>
    open ? <div role="dialog" aria-label="Open in Terminal fixture" /> : null,
}));

vi.mock('./terminal-peer-fabric/TerminalPeerFabricSetupDialog', () => ({
  TerminalPeerFabricSetupDialog: ({ open }: { open: boolean }) =>
    open ? <div role="dialog" aria-label="Terminal Peer Fabric fixture" /> : null,
}));

import { ToolsPage } from './ToolsPage';
import { useUIStore } from '@/stores/ui';
import { useFabricPresentationStore } from './terminal-peer-fabric/fabricPresentationStore';

describe('ToolsPage preloaded Open in Terminal tool', () => {
  afterEach(cleanup);

  it('bundles the tool as a compact first-party entry and opens its flow', async () => {
    render(<ToolsPage />);

    expect(screen.getByRole('heading', { name: 'Preloaded tools' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Open in Terminal/i }));
    expect(screen.getByRole('dialog', { name: 'Open in Terminal fixture' })).toBeTruthy();
  });

  it('opens the preloaded Fabric setup from the deterministic command event', async () => {
    render(<ToolsPage />);
    await act(async () => window.dispatchEvent(new Event('jarvis:terminal-peer-fabric:open')));
    expect(useFabricPresentationStore.getState().selecting).toBe(true);
    expect(useUIStore.getState().route).toBe('terminal');
  });
});
