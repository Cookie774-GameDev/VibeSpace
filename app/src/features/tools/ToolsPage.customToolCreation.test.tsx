import * as React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const toolState = vi.hoisted(() => ({
  tools: [],
  importMany: vi.fn(() => 0),
  create: vi.fn(() => ({ slug: 'a3-open-chat-qa' })),
  update: vi.fn(),
  remove: vi.fn(),
}));

vi.mock('./toolStore', () => ({
  useToolStore: (selector: (state: typeof toolState) => unknown) => selector(toolState),
  slugify: (value: string) => value.toLowerCase().replace(/\s+/gu, '-'),
  parseToolStepsJson: vi.fn(() => []),
}));

vi.mock('@/lib/actions', () => ({
  getBuiltinActions: vi.fn(() => [
    {
      id: 'nav.chat',
      label: 'Open Chat',
      category: 'navigation',
      description: 'Open the Chat route',
      params: [],
    },
  ]),
  runAction: vi.fn(async () => ({ ok: true })),
}));

vi.mock('./open-in-terminal/OpenInTerminalDialog', () => ({
  OpenInTerminalDialog: () => null,
}));

vi.mock('./terminal-peer-fabric/TerminalPeerFabricSetupDialog', () => ({
  TerminalPeerFabricSetupDialog: () => null,
}));

import { ToolsPage } from './ToolsPage';

describe('ToolsPage custom tool creation', () => {
  beforeEach(() => toolState.create.mockClear());
  afterEach(cleanup);

  it('creates the action shown in the untouched new-tool dropdown', () => {
    render(<ToolsPage />);
    fireEvent.click(screen.getByRole('button', { name: 'New tool' }));
    const dialog = screen.getByRole('dialog', { name: 'New custom tool' });
    const action = dialog.querySelector<HTMLSelectElement>('#tool-base');
    expect(action?.value).toBe('nav.chat');
    fireEvent.change(screen.getByPlaceholderText('Run my dev server'), {
      target: { value: 'A3 Open Chat QA' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create tool' }));

    expect(toolState.create).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'A3 Open Chat QA', baseAction: 'nav.chat' }),
    );
  });
});
