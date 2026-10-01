import { afterEach, describe, expect, it, vi } from 'vitest';
import { installPetContextMenuDismissal } from './petContextMenuDismissal';

describe('pet context-menu dismissal', () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  it('closes for outside pointer, Escape, route changes, blur, and another context menu', () => {
    const menu = document.createElement('div');
    const inside = document.createElement('button');
    const outside = document.createElement('button');
    menu.appendChild(inside);
    document.body.append(menu, outside);
    const close = vi.fn();
    const dispose = installPetContextMenuDismissal({ menuElement: menu, close });

    outside.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    window.dispatchEvent(new PopStateEvent('popstate'));
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    window.dispatchEvent(new Event('blur'));
    outside.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));

    expect(close).toHaveBeenCalledTimes(6);
    dispose();
  });

  it('keeps the menu open for pointer and context-menu interaction inside it', () => {
    const menu = document.createElement('div');
    const inside = document.createElement('button');
    menu.appendChild(inside);
    document.body.appendChild(menu);
    const close = vi.fn();
    const dispose = installPetContextMenuDismissal({ menuElement: menu, close });

    inside.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    inside.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));

    expect(close).not.toHaveBeenCalled();
    dispose();
  });

  it('removes every listener during cleanup', () => {
    const menu = document.createElement('div');
    const outside = document.createElement('button');
    document.body.append(menu, outside);
    const close = vi.fn();
    const dispose = installPetContextMenuDismissal({ menuElement: menu, close });
    dispose();

    outside.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    window.dispatchEvent(new Event('blur'));

    expect(close).not.toHaveBeenCalled();
  });
});
