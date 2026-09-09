import { describe, expect, it } from 'vitest';
import {
  recordFabricDelivery,
  sameFabricMembers,
  useFabricPresentationStore,
} from './fabricPresentationStore';
describe('fabric presentation receipts', () => {
  it('requires exact distinct confirmed members', () => {
    expect(sameFabricMembers(['b', 'a'], ['a', 'b'])).toBe(true);
    expect(sameFabricMembers(['a', 'a'], ['a', 'b'])).toBe(false);
    expect(sameFabricMembers(['a', 'b', 'c'], ['a', 'b'])).toBe(false);
  });
  it('does not invent connections when selection opens or is cancelled', () => {
    useFabricPresentationStore.setState({ peers: [], selecting: false });
    useFabricPresentationStore.getState().launch();
    expect(useFabricPresentationStore.getState().peers).toEqual([]);
    useFabricPresentationStore.getState().close();
    expect(useFabricPresentationStore.getState().peers).toEqual([]);
  });
  it('ignores activity from terminals outside the confirmed team', () => {
    useFabricPresentationStore
      .getState()
      .connected(
        ['a', 'b'].map((sessionId) => ({
          sessionId,
          paneId: sessionId,
          projectId: 'p',
          runtimeGeneration: 'g',
        })),
      );
    recordFabricDelivery('foreign', 'c', ['a']);
    recordFabricDelivery('self', 'a', ['a']);
    expect(useFabricPresentationStore.getState().delivery).toBeNull();
    recordFabricDelivery('real', 'a', ['b']);
    expect(useFabricPresentationStore.getState().delivery?.id).toBe('real');
  });
});
