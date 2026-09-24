import { create } from 'zustand';
import type { FabricPeerRef } from './terminalPeerFabricTool';

export const useFabricPresentationStore = create<{
  selecting: boolean;
  managing: boolean;
  peers: readonly FabricPeerRef[];
  delivery: { id: string; from: string; to: readonly string[] } | null;
  launch(): void;
  manage(): void;
  closeManage(): void;
  close(): void;
  connected(peers: readonly FabricPeerRef[]): void;
}>((set) => ({
  selecting: false,
  managing: false,
  peers: [],
  delivery: null,
  launch: () => set({ selecting: true, managing: false }),
  manage: () => set({ selecting: false, managing: true }),
  closeManage: () => set({ managing: false }),
  close: () => set({ selecting: false }),
  connected: (peers) =>
    set({ peers: peers.map((peer) => ({ ...peer })), selecting: false, managing: true, delivery: null }),
}));

// Presentation only: neither terminal output nor polling is evidence of peer delivery.
export function sameFabricMembers(actual: readonly string[], expected: readonly string[]) {
  return (
    actual.length === expected.length &&
    new Set(actual).size === actual.length &&
    expected.every((id) => actual.includes(id))
  );
}

export function recordFabricDelivery(id: string, from: unknown, to: readonly string[]) {
  const { peers } = useFabricPresentationStore.getState();
  if (
    typeof from !== 'string' ||
    !peers.some((p) => p.sessionId === from) ||
    !to.length ||
    to.some((target) => target === from || !peers.some((p) => p.sessionId === target))
  )
    return;
  useFabricPresentationStore.setState({ delivery: { id, from, to: [...to] } });
}
