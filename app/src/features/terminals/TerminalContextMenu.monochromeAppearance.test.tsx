import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TerminalContextMenu } from './TerminalContextMenu';

describe('TerminalContextMenu MonoChrome appearance', () => {
  afterEach(cleanup);

  it('keeps ordinary menu elevation while suppressing MonoChrome effects and reduced motion', () => {
    render(
      <TerminalContextMenu
        x={24}
        y={32}
        onClose={vi.fn()}
        onAskJarvis={vi.fn()}
        onCopyOutput={vi.fn()}
        onRename={vi.fn()}
        onClear={vi.fn()}
        onSplit={vi.fn()}
        onCloseTerminal={vi.fn()}
      />,
    );

    const menu = screen.getByText(/^Ask (Jarvis|Friday)$/).closest<HTMLElement>('[class*="shadow-lg"]');
    expect(menu?.className).toContain('animate-in');
    expect(menu?.className).toContain('shadow-lg');
    expect(menu?.className).toContain('[html[data-theme=monochrome]_&]:shadow-none');
    expect(menu?.className).toContain('[html[data-theme=monochrome]_&]:animate-none');
    expect(menu?.className).toContain('motion-reduce:animate-none');
  });
});
