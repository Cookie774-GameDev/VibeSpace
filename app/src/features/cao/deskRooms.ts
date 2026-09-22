export const DESKS_PER_ROOM = 6;
export function deskRoomCount(count: number): number {
  return Math.max(1, Math.ceil(Math.max(0, count) / DESKS_PER_ROOM));
}
export function deskRoomIndex(room: number, slot: number, count: number): number | null {
  if (
    !Number.isInteger(room) ||
    !Number.isInteger(slot) ||
    room < 0 ||
    slot < 0 ||
    slot >= DESKS_PER_ROOM
  )
    return null;
  const index = room * DESKS_PER_ROOM + slot;
  return index < count ? index : null;
}
