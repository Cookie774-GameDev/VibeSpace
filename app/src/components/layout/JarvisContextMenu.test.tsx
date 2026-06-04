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

  it('does not open while terminal right-drag mode is active', () => {
    document.body.classList.add('jarvis-terminal-right-dragging');
    render(<JarvisContextMenu />);

    openContextMenu();

    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('suppresses the custom menu inside context-map interaction regions', () => {
    render(<JarvisContextMenu />);
    const region = document.createElement('div');
    region.dataset.jarvisSuppressContextMenu = 'true';
    document.body.appendChild(region);
    const event = new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      clientX: 24,
      clientY: 32,
    });

    region.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(screen.queryByRole('menu')).toBeNull();
    region.remove();
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
