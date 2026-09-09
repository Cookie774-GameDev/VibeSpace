import { expect, it } from 'vitest';
import { petContextMenuPosition } from './petContextMenuPosition';

it('moves all three menu items back inside a small pet window at the bottom right', () => {
  expect(petContextMenuPosition(
    { x: 150, y: 140 }, { width: 148, height: 112 }, { width: 192, height: 192 },
  )).toEqual({ x: 40, y: 76 });
});

it('preserves the click position when the menu already fits', () => {
  expect(petContextMenuPosition(
    { x: 20, y: 30 }, { width: 148, height: 112 }, { width: 400, height: 300 },
  )).toEqual({ x: 20, y: 30 });
});

it('keeps the origin reachable when the viewport is smaller than the menu', () => {
  expect(petContextMenuPosition(
    { x: -5, y: 140 }, { width: 148, height: 112 }, { width: 100, height: 100 },
  )).toEqual({ x: 4, y: 4 });
});
