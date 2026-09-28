import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { MediaPreviewPanel } from './MediaPreviewPanel';

afterEach(cleanup);

const imageTarget = {
  kind: 'media' as const,
  name: 'diagram.png',
  url: 'data:image/png;base64,aGVsbG8=',
  mediaKind: 'image' as const,
};

function setImageMetrics(image: HTMLImageElement) {
  Object.defineProperty(image, 'naturalWidth', { configurable: true, value: 100 });
  Object.defineProperty(image, 'naturalHeight', { configurable: true, value: 60 });
  image.getBoundingClientRect = () =>
    ({
      x: 10,
      y: 20,
      left: 10,
      top: 20,
      right: 110,
      bottom: 80,
      width: 100,
      height: 60,
      toJSON: () => ({}),
    }) as DOMRect;
}

describe('MediaPreviewPanel image editor', () => {
  it('loads an image, draws a stroke, and restores it through undo and redo', () => {
    render(<MediaPreviewPanel target={imageTarget} onClose={() => undefined} />);
    const image = screen.getByRole('img', { name: 'diagram.png' }) as HTMLImageElement;
    expect(screen.getByRole('status').textContent).toContain('Loading image');
    setImageMetrics(image);
    fireEvent.load(image);

    const draw = screen.getByRole('button', { name: 'Draw on image' });
    expect((draw as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(draw);
    expect(
      screen.getByRole('button', { name: 'Finish drawing' }).getAttribute('aria-pressed'),
    ).toBe('true');

    const stage = screen.getByTestId('media-preview-stage');
    fireEvent.pointerDown(stage, { button: 0, pointerId: 1, clientX: 20, clientY: 30 });
    fireEvent.pointerMove(stage, { pointerId: 1, clientX: 50, clientY: 50 });
    fireEvent.pointerUp(stage, { pointerId: 1, clientX: 50, clientY: 50 });

    expect(
      (screen.getByRole('button', { name: 'Undo drawing' }) as HTMLButtonElement).disabled,
    ).toBe(false);
    expect(stage.querySelector('svg path')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Undo drawing' }));
    expect(
      (screen.getByRole('button', { name: 'Undo drawing' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      (screen.getByRole('button', { name: 'Redo drawing' }) as HTMLButtonElement).disabled,
    ).toBe(false);
    expect(stage.querySelector('svg path')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Redo drawing' }));
    expect(
      (screen.getByRole('button', { name: 'Undo drawing' }) as HTMLButtonElement).disabled,
    ).toBe(false);
    expect(stage.querySelector('svg path')).toBeTruthy();
  });

  it('shows a recoverable message when an image fails to load', () => {
    render(<MediaPreviewPanel target={imageTarget} onClose={() => undefined} />);
    fireEvent.error(screen.getByRole('img', { name: 'diagram.png' }));
    expect(screen.getByRole('alert').textContent).toContain('Verify its source');
    expect(
      (screen.getByRole('button', { name: 'Draw on image' }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });
});
