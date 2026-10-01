import * as React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
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
  slugify: (value: string) => value.toLowerCase().replace(/\s+/g, '-'),
  parseToolStepsJson: vi.fn(() => []),
}));

vi.mock('@/lib/actions', () => ({
  getBuiltinActions: vi.fn(() => []),
  runAction: vi.fn(async () => ({ ok: true })),
}));

import { ToolsPage } from './ToolsPage';

describe('ToolsPage MonoChrome appearance', () => {
  afterEach(cleanup);

  it('removes the route paper texture while retaining the ordinary theme class and content', async () => {
    const { container } = render(<ToolsPage />);
    await screen.findByText('Available in the installed VibeSpace desktop app.');
    const route = container.querySelector<HTMLElement>('[data-monochrome-route="tools"]');
    expect(route).not.toBeNull();

    expect(route!.className).toContain('bg-paper-warm');
    expect(route!.className).toContain('[html[data-theme=monochrome]_&]:bg-background');
    expect(route!.className).toContain('[html[data-theme=monochrome]_&]:bg-none');
    expect(screen.getByRole('heading', { name: 'Author your own actions' })).toBeTruthy();
    const newTool = screen.getByRole('button', { name: 'New tool' });
    expect(newTool.className).toContain('[html[data-theme=monochrome]_&]:bg-background');
    expect(newTool.className).toContain('[html[data-theme=monochrome]_&]:text-foreground');
  });

  it('removes the quick-start paper texture on MonoChrome hover without changing the action', async () => {
    render(<ToolsPage />);
    await screen.findByText('Available in the installed VibeSpace desktop app.');
    const quickStart = screen.getByRole('button', { name: /Claude in my project/i });

    expect(quickStart.className).toContain('hover:bg-paper-warm');
    expect(quickStart.className).toContain('[html[data-theme=monochrome]_&]:hover:bg-none');
    expect(quickStart.textContent).toContain(
      'Open a terminal and start Claude Code in your main project.',
    );
  });
});
