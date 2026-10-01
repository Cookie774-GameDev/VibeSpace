import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ComposerMediaStrip } from './ComposerMediaStrip';

describe('ComposerMediaStrip', () => {
  it('renders image thumbnails and file cards above the composer input', () => {
    const onRemoveImage = vi.fn();
    const onRemoveFile = vi.fn();
    render(
      <ComposerMediaStrip
        images={[
          {
            id: 'img1',
            name: 'shot.png',
            mimeType: 'image/png',
            data: 'iVBORw0KGgo=',
          },
          {
            id: 'vid1',
            name: 'clip.mp4@0.5s.jpg',
            mimeType: 'image/jpeg',
            data: '/9j/4AAQ=',
          },
        ]}
        files={['C:\\docs\\notes.md']}
        onRemoveImage={onRemoveImage}
        onRemoveFile={onRemoveFile}
      />,
    );

    expect(screen.getByLabelText('Attached media')).toBeTruthy();
    // Both entries are image/* thumbs (second is a still filename, not video/*).
    expect(document.querySelectorAll('[data-composer-media-preview="image"]').length).toBe(2);
    expect(document.querySelectorAll('[data-composer-media-preview="video"]').length).toBe(0);
    expect(screen.getByText('notes.md')).toBeTruthy();
    fireEvent.click(screen.getByLabelText('Remove shot.png'));
    expect(onRemoveImage).toHaveBeenCalledWith('img1');
  });

  it('renders full video attachments with a video element', () => {
    render(
      <ComposerMediaStrip
        images={[
          {
            id: 'v1',
            name: 'clip.mp4',
            mimeType: 'video/mp4',
            data: 'AAAA',
          },
        ]}
        files={[]}
        onRemoveImage={vi.fn()}
        onRemoveFile={vi.fn()}
      />,
    );
    expect(document.querySelectorAll('[data-composer-media-preview="video"]').length).toBe(1);
    expect(document.querySelector('video')).toBeTruthy();
  });
});
