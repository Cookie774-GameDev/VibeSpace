import { beforeEach, describe, expect, it } from 'vitest';
import {
  getLocalAccountReadyReceipt,
  revokeLocalAccountReadiness,
  settleLocalAccountReadiness,
} from './localAccountReadiness';
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
beforeEach(() => {
  revokeLocalAccountReadiness();
});
describe('local account recovery readiness', () => {
  it('waits for cloud teardown before publishing persistence-bound readiness', async () => {
    const teardown = deferred();
    const pending = settleLocalAccountReadiness({
      accountId: 'local',
      persistenceGeneration: 7,
      teardown: teardown.promise,
      isCurrent: () => true,
    });
    expect(getLocalAccountReadyReceipt()).toBeNull();
    teardown.resolve();
    await pending;
    expect(getLocalAccountReadyReceipt()).toMatchObject({
      accountId: 'local',
      persistenceGeneration: 7,
    });
  });
  it('rejects readiness ABA and a stale completing teardown', async () => {
    const teardown = deferred();
    const pending = settleLocalAccountReadiness({
      accountId: 'local',
      persistenceGeneration: 7,
      teardown: teardown.promise,
      isCurrent: () => true,
    });
    revokeLocalAccountReadiness();
    await settleLocalAccountReadiness({
      accountId: 'local',
      persistenceGeneration: 8,
      teardown: Promise.resolve(),
      isCurrent: () => true,
    });
    const receipt = getLocalAccountReadyReceipt();
    teardown.resolve();
    await pending;
    expect(getLocalAccountReadyReceipt()).toBe(receipt);
  });
  it.each([false, true])('does not publish stale or rejected authority (%s)', async (reject) => {
    await settleLocalAccountReadiness({
      accountId: 'local',
      persistenceGeneration: 1,
      teardown: reject ? Promise.reject(new Error('teardown')) : Promise.resolve(),
      isCurrent: () => false,
    });
    expect(getLocalAccountReadyReceipt()).toBeNull();
  });
});
