import { describe, expect, it } from 'vitest';
import { deskRoomCount, deskRoomIndex } from './deskRooms';
describe('CAO desk rooms', () => {
  it.each([0, 1, 6, 7, 32, 100])('keeps every worker reachable at team size %i', (count) => {
    const indices: number[] = [];
    for (let room = 0; room < deskRoomCount(count); room++)
      for (let slot = 0; slot < 6; slot++) {
        const index = deskRoomIndex(room, slot, count);
        if (index !== null) indices.push(index);
      }
    expect(indices).toEqual(Array.from({ length: count }, (_, i) => i));
  });
  it('rejects invalid desk messages and leaves unused desks empty', () => {
    expect(deskRoomIndex(0, -1, 6)).toBeNull();
    expect(deskRoomIndex(0, 6, 12)).toBeNull();
    expect(deskRoomIndex(1, 1, 7)).toBeNull();
    expect(deskRoomIndex(0.5, 0, 12)).toBeNull();
  });
});
