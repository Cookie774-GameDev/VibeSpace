import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FileAttachmentPreview } from './FileAttachmentPreview';

const fsMocks = vi.hoisted(() => ({
  readTextFileSample: vi.fn(),
}));

vi.mock('@/lib/fs', () => ({
  readTextFileSample: fsMocks.readTextFileSample,
}));

describe('FileAttachmentPreview', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('loads one bounded sample on demand and renders it directly in chat', async () => {
    fsMocks.readTextFileSample.mockResolvedValue({
      ok: true,
      path: 'C:\\project\\notes.txt',
      content: 'first line\nsecond line',
    });

    render(
      <FileAttachmentPreview
        path={String.raw`C:\project\notes.txt`}
        projectRoot={String.raw`C:\project`}
        onClose={() => {}}
      />,
    );

    expect(
      await screen.findByText(
        (_content, element) =>
          element?.tagName === 'PRE' && element.textContent === 'first line\nsecond line',
      ),
    ).toBeTruthy();
    expect(fsMocks.readTextFileSample).toHaveBeenCalledWith(
      String.raw`C:\project\notes.txt`,
      64 * 1024,
      { root: String.raw`C:\project` },
    );
  });

  it('shows a clear recoverable error for binary, denied, or unavailable files', async () => {
    fsMocks.readTextFileSample.mockResolvedValue({
      ok: false,
      path: 'C:\\project\\clip.bin',
      error: { code: 'binary_file', raw: 'Binary files cannot be previewed.' },
    });

    render(
      <FileAttachmentPreview
        path={String.raw`C:\project\clip.bin`}
        projectRoot={String.raw`C:\project`}
        onClose={() => {}}
      />,
    );

    await waitFor(() => expect(screen.getByText('Binary files cannot be previewed.')).toBeTruthy());
  });
});
