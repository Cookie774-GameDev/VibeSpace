import { describe, expect, it } from 'vitest';
import type { Message } from '@/types';
import { buildChatOutputInventory } from './chatOutputInventory';

function msg(id: string, role: Message['role'], parts: Message['parts']): Message {
  return {
    id: id as Message['id'],
    chat_id: 'chat_1' as Message['chat_id'],
    role,
    parts,
    created_at: 1,
    updated_at: 1,
  };
}

describe('buildChatOutputInventory', () => {
  it('lists user media as inputs and assistant media as outputs without inventing assets', () => {
    const inventory = buildChatOutputInventory([
      msg('u1', 'user', [
        { kind: 'text', text: 'look' },
        { kind: 'image', url: 'data:image/png;base64,aa', alt: 'shot.png' },
        {
          kind: 'file_ref',
          ref: { kind: 'file', id: 'C:/docs/notes.md' },
        },
      ]),
      msg('a1', 'assistant', [
        { kind: 'text', text: 'done' },
        { kind: 'image', url: 'data:image/png;base64,bb', alt: 'result.png' },
      ]),
      msg('s1', 'system', [{ kind: 'text', text: 'noise' }]),
    ]);

    expect(inventory.inputs.map((a) => a.name)).toEqual(['shot.png', 'notes.md']);
    expect(inventory.outputs.map((a) => a.name)).toEqual(['result.png']);
    expect(inventory.inputs.every((a) => a.side === 'input')).toBe(true);
    expect(inventory.outputs.every((a) => a.side === 'output')).toBe(true);
  });

  it('classifies video paths and data videos', () => {
    const inventory = buildChatOutputInventory([
      msg('u1', 'user', [
        {
          kind: 'file_ref',
          ref: { kind: 'file', id: 'C:/clips/demo.mp4' },
        },
        { kind: 'image', url: 'data:video/webm;base64,aa', alt: 'clip.webm' },
      ]),
    ]);
    expect(inventory.inputs.map((a) => a.kind)).toEqual(['video', 'video']);
  });
});
