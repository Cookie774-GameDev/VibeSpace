import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Message, Part } from '@/types';
import type { MessageId } from '@/types/common';
import { MessagePart } from './MessagePart';

const { messageRepoMock } = vi.hoisted(() => ({
  messageRepoMock: {
    getById: vi.fn<(id: MessageId) => Promise<Message | undefined>>(),
    update: vi.fn<(id: MessageId, patch: Partial<Message>) => Promise<Message>>(),
  },
}));

vi.mock('@/lib/db/repositories', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/db/repositories')>();
  return { ...actual, messageRepo: messageRepoMock };
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('MessagePart image preview and edit persistence', () => {
  beforeEach(() => {
    const context = {
      drawImage: vi.fn(),
      beginPath: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      stroke: vi.fn(),
      fill: vi.fn(),
      arc: vi.fn(),
      strokeStyle: '',
      fillStyle: '',
      lineWidth: 1,
      lineCap: 'round',
      lineJoin: 'round',
    };
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(
      function getCanvas2dContext(this: HTMLCanvasElement, contextId: string) {
        return contextId === '2d' ? (context as unknown as CanvasRenderingContext2D) : null;
      } as unknown as typeof HTMLCanvasElement.prototype.getContext,
    );
    vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue(
      'data:image/png;base64,ZWRpdGVk',
    );
    messageRepoMock.getById.mockReset();
    messageRepoMock.update.mockReset();
  });

  it('keeps the source Part, saves an edited copy, and lets history reopen that copy', async () => {
    const source: Part = {
      kind: 'image',
      url: 'data:image/png;base64,b3JpZ2luYWw=',
      alt: 'diagram.png',
    };
    const companion: Part = { kind: 'text', text: 'Original answer.' };
    const parts: Part[] = [source, companion];
    const message = {
      id: 'message-image-edit',
      chat_id: 'chat-image-edit',
      role: 'assistant',
      created_at: 1,
      updated_at: 1,
      parts,
    } as Message;
    messageRepoMock.getById.mockResolvedValue(message);
    messageRepoMock.update.mockResolvedValue(message);

    render(<MessagePart part={source} allParts={parts} messageId={message.id} />);
    fireEvent.click(screen.getByRole('button', { name: 'Open image editor for diagram.png' }));
    expect(screen.getByRole('dialog', { name: 'Preview diagram.png' }).parentElement).toBe(
      document.body,
    );
    const images = screen.getAllByRole('img', { name: 'diagram.png' }) as HTMLImageElement[];
    const editorImage = images[images.length - 1]!;
    Object.defineProperty(editorImage, 'naturalWidth', { configurable: true, value: 100 });
    Object.defineProperty(editorImage, 'naturalHeight', { configurable: true, value: 60 });
    editorImage.getBoundingClientRect = () =>
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
    fireEvent.load(editorImage);
    fireEvent.click(screen.getByRole('button', { name: 'Draw on image' }));
    const stage = screen.getByTestId('media-preview-stage');
    fireEvent.pointerDown(stage, { button: 0, pointerId: 1, clientX: 20, clientY: 30 });
    fireEvent.pointerMove(stage, { pointerId: 1, clientX: 50, clientY: 50 });
    fireEvent.pointerUp(stage, { pointerId: 1, clientX: 50, clientY: 50 });
    fireEvent.click(screen.getByRole('button', { name: 'Save edited copy to chat' }));

    await waitFor(() => expect(messageRepoMock.update).toHaveBeenCalledTimes(1));
    const updateCall = messageRepoMock.update.mock.calls[0];
    if (!updateCall) throw new Error('Expected the edited message update.');
    const updatedParts = updateCall[1].parts;
    if (!updatedParts) throw new Error('The edited message update omitted its Parts array.');
    expect(updatedParts[0]).toEqual(source);
    expect(updatedParts[1]).toMatchObject({
      kind: 'image',
      url: 'data:image/png;base64,ZWRpdGVk',
      alt: 'Edited copy of diagram.png',
    });
    expect(updatedParts[2]).toEqual(companion);

    cleanup();
    const edited = updatedParts[1]!;
    render(<MessagePart part={edited} allParts={updatedParts} messageId={message.id} />);
    fireEvent.click(
      screen.getByRole('button', { name: 'Open image editor for Edited copy of diagram.png' }),
    );
    expect(screen.getByRole('dialog', { name: 'Preview Edited copy of diagram.png' })).toBeTruthy();
  });
});
