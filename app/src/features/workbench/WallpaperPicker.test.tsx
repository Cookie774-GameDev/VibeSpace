import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { WallpaperPicker } from './WallpaperPicker';
import { DEFAULT_CANVAS_WALLPAPER } from './wallpaperConfig';

vi.mock('@/features/wallpaper-library/WallpaperLibrary', () => ({
  WallpaperLibrary: () => null,
}));

describe('WallpaperPicker controlled mode', () => {
  it('describes the legacy user-pack id by its actual gradient appearance', () => {
    const onSetWallpaper = vi.fn();
    render(
      <WallpaperPicker
        open
        onClose={vi.fn()}
        config={{ ...DEFAULT_CANVAS_WALLPAPER }}
        onSetWallpaper={onSetWallpaper}
        onConfigureWallpaper={vi.fn()}
      />,
    );

    const option = screen.getByText('Nightfall Haze').closest('button');
    if (!option) throw new Error('Nightfall Haze option is not a button');
    expect(option.textContent).toContain(
      'A static copper and violet glow over a deep charcoal background.',
    );
    expect(option.querySelector('span')?.className).toContain(
      'workbench-wallpaper-preview--nightfall',
    );
    fireEvent.click(option);
    expect(onSetWallpaper).toHaveBeenCalledOnce();
    expect(onSetWallpaper).toHaveBeenCalledWith('user-pack');
  });

  it('persists a Canvas custom video as video data instead of a temporary object URL', async () => {
    const onSetWallpaper = vi.fn();
    const { container } = render(
      <WallpaperPicker
        open
        onClose={vi.fn()}
        config={{ ...DEFAULT_CANVAS_WALLPAPER }}
        onSetWallpaper={onSetWallpaper}
        onConfigureWallpaper={vi.fn()}
        persistCustomVideo
      />,
    );
    const input = container.querySelector<HTMLInputElement>('input[type="file"]');
    expect(input).not.toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /Custom Video/i }));
    fireEvent.change(input!, {
      target: {
        files: [new File(['video-bytes'], 'ambience.mp4', { type: 'video/mp4' })],
      },
    });

    await waitFor(() => expect(onSetWallpaper).toHaveBeenCalledOnce());
    expect(onSetWallpaper.mock.calls[0]?.[0]).toBe('custom-video');
    expect(onSetWallpaper.mock.calls[0]?.[1]).toMatch(/^data:video\/mp4;base64,/);
  });
});
