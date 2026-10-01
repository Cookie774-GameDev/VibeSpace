import { describe, expect, it } from 'vitest';
import {
  MAX_IMAGES_PER_BATCH,
  MAX_VIDEOS_PER_BATCH,
  appendComposerMedia,
  appendComposerMediaResult,
  browserFileLocalPath,
  classifyBrowserFilesForAttach,
  splitAttachableFiles,
  splitImageFiles,
  splitVideoFiles,
} from './imageAttachments';

function fileWithPath(name: string, type: string, path?: string): File {
  const file = new File(['content'], name, { type });
  if (path) {
    Object.defineProperty(file, 'path', { value: path, configurable: true });
  }
  return file;
}

describe('image attachments', () => {
  it('keeps only image types supported by provider adapters', () => {
    const files = [
      new File(['png'], 'a.png', { type: 'image/png' }),
      new File(['svg'], 'a.svg', { type: 'image/svg+xml' }),
      new File(['bmp'], 'a.bmp', { type: 'image/bmp' }),
      new File(['jpg'], 'a.jpg', { type: 'image/jpeg' }),
    ];

    expect(splitImageFiles(files).map((file) => file.name)).toEqual(['a.png', 'a.jpg']);
  });

  it('classifies mixed FileList drops into images, videos, and general files', () => {
    const files = [
      fileWithPath('shot.png', 'image/png'),
      fileWithPath('clip.mp4', 'video/mp4'),
      fileWithPath('notes.md', 'text/markdown', 'C:\\project\\notes.md'),
      fileWithPath('blob.bin', 'application/octet-stream'),
      new File(['hello'], 'readme.txt', { type: 'text/plain' }),
    ];

    const split = splitAttachableFiles(files);
    expect(split.images.map((f) => f.name)).toEqual(['shot.png']);
    expect(split.videos.map((f) => f.name)).toEqual(['clip.mp4']);
    expect(split.other.map((f) => f.name)).toEqual(['notes.md', 'blob.bin', 'readme.txt']);

    const classified = classifyBrowserFilesForAttach(files);
    expect(classified.images.map((f) => f.name)).toEqual(['shot.png']);
    expect(classified.videos.map((f) => f.name)).toEqual(['clip.mp4']);
    expect(classified.pathFiles.map((entry) => entry.path)).toEqual(['C:\\project\\notes.md']);
    expect(classified.textWithoutPath.map((f) => f.name)).toEqual(['readme.txt']);
    expect(classified.unsupportedWithoutPath.map((f) => f.name)).toEqual(['blob.bin']);
  });

  it('reads desktop File.path for general-file paste/drop attach', () => {
    const withPath = fileWithPath('a.json', 'application/json', '/Users/me/a.json');
    const without = new File(['{}'], 'b.json', { type: 'application/json' });
    expect(browserFileLocalPath(withPath)).toBe('/Users/me/a.json');
    expect(browserFileLocalPath(without)).toBeNull();
  });

  it('does not drop general files when images and videos are also present', () => {
    // Mixed DataTransfer must keep the .md path alongside media — the Composer
    // must not early-return after only handling images/videos.
    const files = [
      fileWithPath('a.png', 'image/png'),
      fileWithPath('spec.md', 'text/markdown', 'D:\\docs\\spec.md'),
    ];
    const classified = classifyBrowserFilesForAttach(files);
    expect(classified.images).toHaveLength(1);
    expect(classified.pathFiles).toEqual([expect.objectContaining({ path: 'D:\\docs\\spec.md' })]);
  });

  it('classifies multi-image and multi-video FileLists for one drag/drop', () => {
    const files = [
      new File(['1'], 'a.png', { type: 'image/png' }),
      new File(['2'], 'b.png', { type: 'image/png' }),
      new File(['3'], 'c.jpg', { type: 'image/jpeg' }),
      new File(['v1'], 'one.mp4', { type: 'video/mp4' }),
      new File(['v2'], 'two.webm', { type: 'video/webm' }),
      new File(['v3'], 'three.mov', { type: 'video/quicktime' }),
    ];
    expect(splitImageFiles(files).map((f) => f.name)).toEqual(['a.png', 'b.png', 'c.jpg']);
    expect(splitVideoFiles(files).map((f) => f.name)).toEqual(['one.mp4', 'two.webm', 'three.mov']);
    const classified = classifyBrowserFilesForAttach(files);
    expect(classified.images).toHaveLength(3);
    expect(classified.videos).toHaveLength(3);
    expect(MAX_IMAGES_PER_BATCH).toBeGreaterThanOrEqual(3);
    expect(MAX_VIDEOS_PER_BATCH).toBeGreaterThanOrEqual(3);
  });

  it('appends media without deduping so multi-drop of the same file is kept', () => {
    const a = {
      id: '1',
      name: 'same.png',
      mimeType: 'image/png',
      data: 'aa',
      size: 10,
    };
    const b = {
      id: '2',
      name: 'same.png',
      mimeType: 'image/png',
      data: 'bb',
      size: 10,
    };
    expect(appendComposerMedia([a], [b])).toHaveLength(2);
    expect(appendComposerMedia([a], [b]).map((m) => m.id)).toEqual(['1', '2']);
    const capped = appendComposerMediaResult([a], [b, { ...b, id: '3' }], 2);
    expect(capped.items).toHaveLength(2);
    expect(capped.truncated).toBe(1);
  });
});
