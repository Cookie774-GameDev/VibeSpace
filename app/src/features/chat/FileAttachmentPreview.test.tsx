import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FileAttachmentPreview } from './FileAttachmentPreview';

const fsMocks = vi.hoisted(() => ({
  readTextFileSample: vi.fn(),
  statProjectPath: vi.fn(),
}));

vi.mock('@/lib/fs', () => ({
  readTextFileSample: fsMocks.readTextFileSample,
  statProjectPath: fsMocks.statProjectPath,
}));

describe('FileAttachmentPreview', () => {
  afterEach(() => {
    cleanup();
    vi.resetAllMocks();
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

  it('discloses when a 96 KiB attachment is shown as a 64 KiB sample', async () => {
    const path = String.raw`C:\project\qa-large-96k.txt`;
    fsMocks.readTextFileSample.mockResolvedValue({
      ok: true,
      path,
      content: 'a'.repeat(64 * 1024),
    });
    fsMocks.statProjectPath.mockResolvedValue({
      ok: true,
      path,
      kind: 'file',
      size: 96 * 1024,
    });

    render(
      <FileAttachmentPreview path={path} projectRoot={String.raw`C:\project`} onClose={() => {}} />,
    );

    expect(await screen.findByText(/Showing first 64 KiB of 96 KiB/)).toBeTruthy();
    expect(document.querySelector('aside pre')?.textContent).toHaveLength(64 * 1024);
    expect(fsMocks.statProjectPath).toHaveBeenCalledWith(path, false, {
      root: String.raw`C:\project`,
    });
  });

  it('does not show a truncation warning for a complete 64 KiB attachment', async () => {
    const path = String.raw`C:\project\exact-64k.txt`;
    fsMocks.readTextFileSample.mockResolvedValue({
      ok: true,
      path,
      content: 'b'.repeat(64 * 1024),
    });
    fsMocks.statProjectPath.mockResolvedValue({ ok: true, path, kind: 'file', size: 64 * 1024 });

    render(
      <FileAttachmentPreview path={path} projectRoot={String.raw`C:\project`} onClose={() => {}} />,
    );

    await waitFor(() =>
      expect(document.querySelector('aside pre')?.textContent).toHaveLength(64 * 1024),
    );
    expect(screen.queryByText(/Showing first|may be truncated/)).toBeNull();
  });

  it('warns conservatively when a full sample has no readable size', async () => {
    const path = String.raw`C:\project\unknown-size.txt`;
    fsMocks.readTextFileSample.mockResolvedValue({
      ok: true,
      path,
      content: 'c'.repeat(64 * 1024),
    });
    fsMocks.statProjectPath.mockResolvedValue({
      ok: false,
      path,
      error: { code: 'unavailable' },
    });

    render(
      <FileAttachmentPreview path={path} projectRoot={String.raw`C:\project`} onClose={() => {}} />,
    );

    expect(await screen.findByText(/Preview may be truncated after 64 KiB/)).toBeTruthy();
  });
});
