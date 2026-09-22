import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
const files = vi.hoisted(() => ({
  scope: { root: 'C:/project', accountId: 'a', workspaceId: 'w', projectId: 'p' },
  capture: vi.fn(),
  open: vi.fn(),
  list: vi.fn(),
}));
vi.mock('./toolFileActions', () => ({
  captureToolFileScope: files.capture,
  openToolFile: files.open,
  listToolEditors: files.list,
}));
import { ToolDetailsInspector } from './ToolDetailsInspector';
beforeEach(() => {
  vi.clearAllMocks();
  files.capture.mockReturnValue(files.scope);
  files.open.mockResolvedValue(undefined);
  files.list.mockResolvedValue([{ id: 'vscode', name: 'Visual Studio Code' }]);
});
const change = { path: 'src/invoice.cjs', kind: 'update' as const, complete: true };
it('offers only detected editors from the file context menu', async () => {
  render(
    <ToolDetailsInspector projectRoot="C:/project" status="done" details={{ changes: [change] }} />,
  );
  fireEvent.contextMenu(screen.getByRole('button', { name: change.path }));
  fireEvent.click(await screen.findByRole('button', { name: 'Open in Visual Studio Code' }));
  await waitFor(() => expect(files.open).toHaveBeenCalledWith(change.path, 'vscode', files.scope));
});
it('opens the changed file in the project editor, or reveals it on Ctrl-click', async () => {
  render(
    <ToolDetailsInspector projectRoot="C:/project" status="done" details={{ changes: [change] }} />,
  );
  const link = screen.getByRole('button', { name: 'src/invoice.cjs' });
  fireEvent.click(link);
  await waitFor(() => expect(files.open).toHaveBeenCalledWith(change.path, 'editor', files.scope));
  fireEvent.click(link, { ctrlKey: true });
  await waitFor(() => expect(files.open).toHaveBeenCalledWith(change.path, 'reveal', files.scope));
});
it('keeps a renamed destination actionable and reports missing files instead of inventing success', async () => {
  files.open.mockRejectedValue(new Error('File unavailable: not_found'));
  render(
    <ToolDetailsInspector
      projectRoot="C:/project"
      status="done"
      details={{ changes: [{ ...change, kind: 'move', destinationPath: 'src/renamed.cjs' }] }}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'src/renamed.cjs' }));
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('not_found'));
  expect(files.open).toHaveBeenCalledWith('src/renamed.cjs', 'editor', files.scope);
});
it('does not offer file actions without an authorized project scope', () => {
  files.capture.mockReturnValue(null);
  render(
    <ToolDetailsInspector projectRoot="C:/other" status="done" details={{ changes: [change] }} />,
  );
  expect(screen.queryByRole('button', { name: change.path })).toBeNull();
  expect(files.open).not.toHaveBeenCalled();
});
it('preserves real command failure, partial output, and collapsed output details', () => {
  render(
    <ToolDetailsInspector
      status="error"
      details={{
        command: 'node verify.cjs',
        exitCode: 1,
        output: { text: 'x'.repeat(500), mode: 'replace', complete: false, omittedBytes: 42 },
      }}
    />,
  );
  expect(screen.getByLabelText('Executed command').textContent).toBe('node verify.cjs');
  expect(screen.getByText(/Exit code: 1/)).toBeTruthy();
  expect(screen.getByText(/42 bytes omitted/)).toBeTruthy();
  expect(screen.getByLabelText('Tool output preview').textContent?.length).toBe(240);
  expect(screen.queryByText('x'.repeat(500))).toBeNull();
});
it('renders large provider write content in a labeled scrollable panel when no diff exists', () => {
  const content = '<!doctype html>\n' + '<canvas id="game"></canvas>\n'.repeat(300);
  render(
    <ToolDetailsInspector
      status="done"
      details={{
        changes: [{ path: 'game.html', kind: 'unknown', writtenContent: content, complete: true }],
      }}
    />,
  );
  expect(screen.queryByText('Per-call diff unavailable.')).toBeNull();
  fireEvent.click(screen.getByText('Written content · previous file state unavailable'));
  const pre = screen.getByLabelText('Written content for game.html');
  expect(pre.textContent).toBe(content);
  expect(pre.className).toContain('max-h-80');
  expect(pre.className).toContain('overflow-auto');
});
it('recovers written content from persisted arguments for older receipts', () => {
  const content = '<canvas id="legacy-game"></canvas>\n'.repeat(80);
  render(
    <ToolDetailsInspector
      status="done"
      details={{
        arguments: { filePath: 'game.html', content },
        changes: [{ path: 'game.html', kind: 'unknown', complete: true }],
      }}
    />,
  );
  fireEvent.click(screen.getByText('Written content · previous file state unavailable'));
  expect(screen.getByLabelText('Written content for game.html').textContent).toBe(content);
});
