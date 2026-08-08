import 'fake-indexeddb/auto';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EmojiPicker } from './EmojiPicker';
import { createEmojiAssetStore } from './uploadStore';

const databaseNames: string[] = [];

function pngFile(): File {
  const bytes = new Uint8Array(32);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return new File([bytes], 'custom-agent.png', { type: 'image/png' });
}

afterEach(async () => {
  cleanup();
  await Promise.all(
    databaseNames.splice(0).map(
      (name) =>
        new Promise<void>((resolve) => {
          const request = indexedDB.deleteDatabase(name);
          request.onsuccess = () => resolve();
          request.onerror = () => resolve();
          request.onblocked = () => resolve();
        }),
    ),
  );
});

describe('EmojiPicker', () => {
  it('keeps the editor compact with five choices and a plus control', () => {
    render(<EmojiPicker value="vibe:aurora-spark" onChange={vi.fn()} label="Agent icon" />);

    expect(screen.getAllByRole('button', { name: /^Choose /u })).toHaveLength(5);
    expect(screen.getByRole('button', { name: 'Open full Agent icon picker' })).toBeTruthy();
    expect(screen.queryByRole('dialog', { name: 'Choose Agent icon' })).toBeNull();
  });

  it('searches the full catalog and supports arrow-key selection', () => {
    const onChange = vi.fn();
    render(<EmojiPicker value="vibe:aurora-spark" onChange={onChange} label="Agent icon" />);

    fireEvent.click(screen.getByRole('button', { name: 'Open full Agent icon picker' }));
    const dialog = screen.getByRole('dialog', { name: 'Choose Agent icon' });
    fireEvent.change(within(dialog).getByRole('searchbox', { name: 'Search Agent icon' }), {
      target: { value: 'builder' },
    });

    const options = within(dialog).getAllByRole('option');
    expect(options).toHaveLength(10);
    expect(options[0]?.getAttribute('aria-label')).toBe('Aurora Builder');

    options[0]?.focus();
    fireEvent.keyDown(options[0]!, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(options[1]);
    fireEvent.keyDown(options[1]!, { key: 'Enter' });

    expect(onChange).toHaveBeenCalledWith('vibe:ember-builder');
    expect(screen.queryByRole('dialog', { name: 'Choose Agent icon' })).toBeNull();
  });

  it('validates and persists a custom upload before selecting its stable token', async () => {
    const databaseName = `vibespace-picker-${crypto.randomUUID()}`;
    databaseNames.push(databaseName);
    const assetStore = createEmojiAssetStore(databaseName);
    const onChange = vi.fn();
    render(
      <EmojiPicker
        value="✨"
        onChange={onChange}
        label="Skill emoji"
        assetStore={assetStore}
        readDimensions={async () => ({ width: 128, height: 128 })}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Open full Skill emoji picker' }));
    fireEvent.change(screen.getByLabelText('Upload custom emoji'), {
      target: { files: [pngFile()] },
    });

    const uploaded = await screen.findByRole('option', { name: 'custom-agent' });
    expect(uploaded).toBeTruthy();
    expect(onChange).toHaveBeenCalledWith(expect.stringMatching(/^upload:/u));
    expect(await assetStore.list()).toHaveLength(1);
  });
});
