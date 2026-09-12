import { describe, expect, it } from 'vitest';
import { extractVideoFramesAsImages } from './videoAttachments';

describe('video chat attachments', () => {
  it('rejects clips above the documented 40 MB limit before decoding', async () => {
    const file = {
      name: 'large.mp4',
      type: 'video/mp4',
      size: 40 * 1024 * 1024 + 1,
    } as File;

    await expect(extractVideoFramesAsImages(file)).rejects.toThrow(
      'Video is too large. Use a clip under 40 MB.',
    );
  });
});
