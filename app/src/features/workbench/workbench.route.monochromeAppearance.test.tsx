import * as React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkbenchWallpaperConfig } from './types';
import { PanelPalette } from './PanelPalette';
import { WallpaperHost } from './WallpaperHost';
import { WallpaperPicker } from './WallpaperPicker';
import { WorkbenchContextMenu } from './WorkbenchContextMenu';
import { useWorkbenchStore } from './store';

vi.mock('@/features/wallpaper-library/WallpaperLibrary', () => ({
  WallpaperLibrary: () => null,
}));

const baseWallpaper: WorkbenchWallpaperConfig = {
  id: 'space-clouds',
  paused: false,
  interactive: true,
  intensity: 0.72,
  brightness: 0.5,
  quality: 'balanced',
};

describe('Workbench route MonoChrome appearance', () => {
  beforeEach(() => {
    window.localStorage.clear();
    useWorkbenchStore.getState().resetWorkbench();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => null);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('keeps wallpaper media available to ordinary themes but hides painted media in MonoChrome', () => {
    const view = render(<WallpaperHost config={baseWallpaper} />);
    const canvas = view.container.querySelector<HTMLCanvasElement>('canvas');
    expect(canvas).not.toBeNull();
    expect(canvas!.className).toContain('workbench-wallpaper-canvas');
    expect(canvas!.className).toContain('[html[data-theme=monochrome]_&]:hidden');

    view.rerender(
      <WallpaperHost
        config={{
          ...baseWallpaper,
          id: 'custom-image',
          assetUrl: 'data:image/png;base64,AAAA',
        }}
      />,
    );
    const image = view.container.querySelector<HTMLImageElement>('img');
    expect(image).not.toBeNull();
    expect(image!.className).toContain('[html[data-theme=monochrome]_&]:hidden');

    view.rerender(
      <WallpaperHost
        config={{
          ...baseWallpaper,
          id: 'custom-video',
          assetUrl: 'data:video/mp4;base64,AAAA',
        }}
      />,
    );
    const video = view.container.querySelector<HTMLVideoElement>('video');
    expect(video).not.toBeNull();
    expect(video!.className).toContain('[html[data-theme=monochrome]_&]:hidden');
  });

  it('flattens wallpaper-picker chrome and previews without removing its controls', () => {
    const { container } = render(<WallpaperPicker open onClose={vi.fn()} />);
    const backdrop = container.querySelector<HTMLElement>('.workbench-sheet-backdrop');
    const dialog = screen.getByRole('dialog', { name: 'Interactive wallpapers' });
    expect(backdrop?.className).toContain('[html[data-theme=monochrome]_&]:backdrop-blur-none');
    expect(dialog.className).toContain('[html[data-theme=monochrome]_&]:bg-none');
    expect(dialog.className).toContain('[html[data-theme=monochrome]_&]:bg-panel');
    expect(dialog.className).toContain('[html[data-theme=monochrome]_&]:shadow-none');

    const previews = Array.from(
      container.querySelectorAll<HTMLElement>('.workbench-wallpaper-preview'),
    );
    expect(previews.length).toBeGreaterThan(8);
    for (const preview of previews) {
      expect(preview.className).toContain('[html[data-theme=monochrome]_&]:bg-none');
      expect(preview.className).toContain('[html[data-theme=monochrome]_&]:bg-elevated');
    }

    const selected = container.querySelector<HTMLElement>(
      ".workbench-wallpaper-grid > button[data-selected='true']",
    );
    expect(selected).not.toBeNull();
    expect(selected!.className).toContain('[html[data-theme=monochrome]_&]:shadow-none');
    expect(selected!.className).toContain(
      '[html[data-theme=monochrome]_&]:focus-visible:outline-ring',
    );
    expect(selected!.className).toContain(
      '[html[data-theme=monochrome]_&]:focus-visible:transform-none',
    );
    expect(screen.getByRole('button', { name: 'Pause motion' })).toBeTruthy();
    expect(screen.getByRole('slider', { name: 'Intensity' })).toBeTruthy();
  });

  it('restores visible MonoChrome focus to the open and collapsed panel palette', () => {
    const onAdd = vi.fn();
    const view = render(<PanelPalette onAdd={onAdd} />);
    const terminal = screen.getByRole('button', { name: 'Add Terminal' });
    expect(terminal.className).toContain(
      '[html[data-theme=monochrome]_&]:focus-visible:outline-ring',
    );
    fireEvent.click(terminal);
    expect(onAdd).toHaveBeenCalledWith('terminal');

    view.rerender(<PanelPalette onAdd={onAdd} open={false} />);
    const reopen = screen.getByRole('button', { name: 'Open panels' });
    expect(reopen.className).toContain(
      '[html[data-theme=monochrome]_&]:focus-visible:outline-ring',
    );
  });

  it('flattens the rendered Workbench context menu while preserving its actions', () => {
    render(
      <main className="workbench-shell">
        <div className="workbench-canvas">Canvas</div>
        <WorkbenchContextMenu />
      </main>,
    );
    fireEvent.contextMenu(document.querySelector('.workbench-canvas')!, {
      clientX: 80,
      clientY: 90,
      bubbles: true,
    });

    const menu = screen.getByRole('menu', { name: 'Workbench menu' });
    expect(menu.className).toContain('[html[data-theme=monochrome]_&]:bg-none');
    expect(menu.className).toContain('[html[data-theme=monochrome]_&]:bg-panel');
    expect(menu.className).toContain('[html[data-theme=monochrome]_&]:shadow-none');
    expect(menu.className).toContain('[html[data-theme=monochrome]_&]:backdrop-blur-none');
    expect(screen.getByRole('menuitem', { name: 'Recenter workspace' })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: 'Undo' })).toBeTruthy();
  });
});
