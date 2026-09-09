import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Chat } from '@/types/chat';
import { useChatPointerDrag } from './useChatPointerDrag';
import { readChatDragPayload } from './chatDragPayload';

class Transfer {
  values = new Map<string, string>();
  setData(type: string, value: string) {
    this.values.set(type, value);
  }
  getData(type: string) {
    return this.values.get(type) ?? '';
  }
  get types() {
    return [...this.values.keys()];
  }
}
class Drag extends MouseEvent {
  dataTransfer: DataTransfer | null;
  constructor(type: string, init: DragEventInit = {}) {
    super(type, init);
    this.dataTransfer = init.dataTransfer ?? null;
  }
}
class Pointer extends MouseEvent {
  pointerId: number;
  constructor(type: string, init: PointerEventInit = {}) {
    super(type, init);
    this.pointerId = init.pointerId ?? 1;
  }
}
const chat = {
  id: 'source',
  title: 'Source',
  workspace_id: 'workspace',
  project_id: null,
} as unknown as Chat;
const originalHitTest = Object.getOwnPropertyDescriptor(document, 'elementFromPoint');
function Source({ click }: { click: () => void }) {
  return (
    <div data-testid="source" {...useChatPointerDrag(chat)}>
      <button onClick={click}>Source</button>
      <button aria-label="Pin Source" onClick={click}>
        Pin
      </button>
    </div>
  );
}
beforeEach(() => {
  Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: vi.fn() });
  vi.stubGlobal('DataTransfer', Transfer);
  vi.stubGlobal('DragEvent', Drag);
  vi.stubGlobal('PointerEvent', Pointer);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  if (originalHitTest) Object.defineProperty(document, 'elementFromPoint', originalHitTest);
  else Reflect.deleteProperty(document, 'elementFromPoint');
});

it('delivers a typed UI drag and drop without starting browser/native drag', () => {
  const click = vi.fn();
  const over = vi.fn();
  const drop = vi.fn();
  render(
    <>
      <Source click={click} />
      <div
        data-testid="target"
        onDragOver={over}
        onDrop={(e) => drop(readChatDragPayload(e.dataTransfer))}
      />
    </>,
  );
  vi.spyOn(document, 'elementFromPoint').mockReturnValue(screen.getByTestId('target'));
  expect(screen.getByTestId('source').getAttribute('draggable')).toBe('false');
  fireEvent.pointerDown(screen.getByText('Source'), {
    button: 0,
    pointerId: 1,
    clientX: 10,
    clientY: 10,
  });
  fireEvent.pointerMove(window, { pointerId: 1, clientX: 100, clientY: 100 });
  expect(over).toHaveBeenCalledTimes(1);
  fireEvent.pointerUp(window, { pointerId: 1, clientX: 100, clientY: 100 });
  expect(drop).toHaveBeenCalledWith({
    version: 1,
    chatId: 'source',
    workspaceId: 'workspace',
    projectId: null,
    title: 'Source',
  });
  fireEvent.click(screen.getByText('Source'));
  expect(click).not.toHaveBeenCalled();
});

it('preserves normal clicks and pin buttons and cancels on Escape', () => {
  const click = vi.fn();
  const drop = vi.fn();
  render(
    <>
      <Source click={click} />
      <div data-testid="target" onDrop={drop} />
    </>,
  );
  vi.spyOn(document, 'elementFromPoint').mockReturnValue(screen.getByTestId('target'));
  const source = screen.getByText('Source');
  fireEvent.pointerDown(source, { button: 0, pointerId: 1, clientX: 10, clientY: 10 });
  fireEvent.pointerMove(window, { pointerId: 1, clientX: 12, clientY: 12 });
  fireEvent.pointerUp(window, { pointerId: 1 });
  fireEvent.click(source);
  expect(click).toHaveBeenCalledTimes(1);
  fireEvent.pointerDown(source, { button: 0, pointerId: 1 });
  fireEvent.pointerMove(window, { pointerId: 1, clientX: 100, clientY: 100 });
  fireEvent.keyDown(window, { key: 'Escape' });
  fireEvent.pointerUp(window, { pointerId: 1 });
  expect(drop).not.toHaveBeenCalled();
  fireEvent.pointerDown(screen.getByText('Pin'), { button: 0, pointerId: 1 });
  fireEvent.pointerMove(window, { pointerId: 1, clientX: 100 });
  fireEvent.pointerUp(window, { pointerId: 1 });
  expect(drop).not.toHaveBeenCalled();
});
