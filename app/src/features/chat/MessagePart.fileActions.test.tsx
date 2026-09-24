import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import type { Part } from '@/types/chat';

const fileActions = vi.hoisted(() => ({ resolve: vi.fn() }));
vi.mock('./activity-ledger/toolFileActions', () => ({ resolveToolChatRoot: fileActions.resolve }));
vi.mock('./activity-ledger/ToolDetailsInspector', () => ({
  ToolFileLink: ({ path, projectRoot }: { path: string; projectRoot?: string }) =>
    projectRoot ? <button type="button" data-testid="file-action">{path}</button> : <span>{path}</span>,
}));
import { MessagePart } from './MessagePart';

beforeEach(() => vi.clearAllMocks());

it('offers file actions only after the chat project is verified', async () => {
  fileActions.resolve.mockResolvedValue('D:/project');
  const part: Part = { kind: 'file_ref', ref: { kind: 'file', id: 'src/example.ts' } };
  render(<MessagePart part={part} allParts={[part]} chatId="chat-1" />);
  await waitFor(() => expect(fileActions.resolve).toHaveBeenCalledWith('chat-1'));
  expect((await screen.findByTestId('file-action')).textContent).toBe('src/example.ts');
});

it('keeps an unverified file reference inert', async () => {
  fileActions.resolve.mockResolvedValue(undefined);
  const part: Part = { kind: 'file_ref', ref: { kind: 'file', id: 'src/other.ts' } };
  render(<MessagePart part={part} allParts={[part]} chatId="other-chat" />);
  await waitFor(() => expect(fileActions.resolve).toHaveBeenCalledWith('other-chat'));
  expect(screen.queryByTestId('file-action')).toBeNull();
  expect(screen.getByText('src/other.ts')).toBeTruthy();
});
