import * as React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatId } from '@/types';

const mocks = vi.hoisted(() => ({
  update: vi.fn(),
  create: vi.fn(),
  toastError: vi.fn(),
  toastWarning: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
  chatRepo: {
    update: mocks.update,
    create: mocks.create,
  },
}));

vi.mock('@/components/ui/toast', () => ({
  toast: {
    error: mocks.toastError,
    warning: mocks.toastWarning,
  },
}));

import { useChatTitleEditor } from './useChatTitleEditor';

function TitleEditorHarness({ chatId, title }: { chatId: ChatId; title: string }) {
  const editor = useChatTitleEditor({ chatId, title });

  return editor.editing ? (
    <input
      ref={editor.inputRef}
      aria-label={`Rename ${title}`}
      value={editor.draft}
      disabled={editor.saving}
      onChange={(event) => editor.setDraft(event.target.value)}
      onBlur={() => void editor.commit()}
      onKeyDown={editor.handleKeyDown}
      onDoubleClick={editor.startEditing}
    />
  ) : (
    <button type="button" onDoubleClick={editor.startEditing}>
      {title}
    </button>
  );
}

const chatId = 'chat-shared-1' as ChatId;

describe('useChatTitleEditor', () => {
  beforeEach(() => {
    mocks.update.mockReset().mockResolvedValue({ id: chatId, title: 'Renamed chat' });
    mocks.create.mockReset();
    mocks.toastError.mockReset();
    mocks.toastWarning.mockReset();
  });

  it('starts on double-click, selects the initial title, and saves the same chat ID on Enter', async () => {
    render(<TitleEditorHarness chatId={chatId} title="Initial title" />);

    fireEvent.doubleClick(screen.getByRole('button', { name: 'Initial title' }));
    const input = screen.getByRole('textbox', { name: 'Rename Initial title' }) as HTMLInputElement;

    await waitFor(() => {
      expect(input.selectionStart).toBe(0);
      expect(input.selectionEnd).toBe('Initial title'.length);
    });

    fireEvent.change(input, { target: { value: '  Renamed chat  ' } });
    fireEvent.doubleClick(input);
    expect(input.value).toBe('  Renamed chat  ');
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => {
      expect(mocks.update).toHaveBeenCalledWith(chatId, { title: 'Renamed chat' });
      expect(screen.queryByRole('textbox')).toBeNull();
    });
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('cancels on Escape without mutating the chat', () => {
    render(<TitleEditorHarness chatId={chatId} title="Initial title" />);

    fireEvent.doubleClick(screen.getByRole('button', { name: 'Initial title' }));
    const input = screen.getByRole('textbox', { name: 'Rename Initial title' });
    fireEvent.change(input, { target: { value: 'Discard me' } });
    fireEvent.keyDown(input, { key: 'Escape' });

    expect(screen.getByRole('button', { name: 'Initial title' })).toBeTruthy();
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it('saves a valid title on blur', async () => {
    render(<TitleEditorHarness chatId={chatId} title="Initial title" />);

    fireEvent.doubleClick(screen.getByRole('button', { name: 'Initial title' }));
    const input = screen.getByRole('textbox', { name: 'Rename Initial title' });
    fireEvent.change(input, { target: { value: 'Blurred title' } });
    fireEvent.blur(input);

    await waitFor(() => {
      expect(mocks.update).toHaveBeenCalledWith(chatId, { title: 'Blurred title' });
      expect(screen.queryByRole('textbox')).toBeNull();
    });
  });

  it('rejects an empty title without closing the editor or writing', async () => {
    render(<TitleEditorHarness chatId={chatId} title="Initial title" />);

    fireEvent.doubleClick(screen.getByRole('button', { name: 'Initial title' }));
    const input = screen.getByRole('textbox', { name: 'Rename Initial title' });
    fireEvent.change(input, { target: { value: '   ' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => expect(mocks.toastWarning).toHaveBeenCalled());
    expect(screen.getByRole('textbox', { name: 'Rename Initial title' })).toBeTruthy();
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it('keeps the draft editable after repository failure and retries safely', async () => {
    mocks.update
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({ id: chatId, title: 'Retry title' });
    render(<TitleEditorHarness chatId={chatId} title="Initial title" />);

    fireEvent.doubleClick(screen.getByRole('button', { name: 'Initial title' }));
    const input = screen.getByRole('textbox', { name: 'Rename Initial title' });
    fireEvent.change(input, { target: { value: 'Retry title' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() =>
      expect(mocks.toastError).toHaveBeenCalledWith('Could not rename', 'offline'),
    );
    expect(
      (screen.getByRole('textbox', { name: 'Rename Initial title' }) as HTMLInputElement).value,
    ).toBe('Retry title');

    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });

    await waitFor(() => {
      expect(mocks.update).toHaveBeenCalledTimes(2);
      expect(screen.queryByRole('textbox')).toBeNull();
    });
    expect(mocks.update).toHaveBeenNthCalledWith(1, chatId, { title: 'Retry title' });
    expect(mocks.update).toHaveBeenNthCalledWith(2, chatId, { title: 'Retry title' });
    expect(mocks.create).not.toHaveBeenCalled();
  });
});
