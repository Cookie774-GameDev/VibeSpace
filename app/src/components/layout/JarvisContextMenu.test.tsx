import * as React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, afterEach } from 'vitest';
import { JarvisContextMenu } from './JarvisContextMenu';

function openContextMenu() {
  window.dispatchEvent(
    new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      clientX: 24,
      clientY: 32,
    }),
  );
}

describe('JarvisContextMenu', () => {
  afterEach(() => {
    delete document.body.dataset.jarvisSuppressContextMenuUntil;
    document.body.classList.remove('jarvis-terminal-right-dragging');
  });

  it('does not open while a right-drag suppression window is active', () => {
    document.body.dataset.jarvisSuppressContextMenuUntil = String(Date.now() + 1000);
    render(<JarvisContextMenu />);

    openContextMenu();

    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('does not open for already prevented context-map events', () => {
    render(<JarvisContextMenu />);
    const event = new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      clientX: 24,
      clientY: 32,
    });
    event.preventDefault();

    window.dispatchEvent(event);

    expect(screen.queryByRole('menu')).toBeNull();
  });
});
