import { expect, it, vi } from 'vitest';
import type { CaoPendingProposal } from '@/features/jarvis-memory/caoChatControl';
import { createCaoTerminalControl } from './terminalControlRuntime';
import { CAO_GUIDANCE_AREAS, parseCaoGuidance } from '@/features/jarvis-memory/caoGuidance';

const guidance = parseCaoGuidance(
  JSON.stringify({
    sections: Object.fromEntries(
      CAO_GUIDANCE_AREAS.map((area) => [
        area,
        {
          guidance: 'Use observed results and focused instructions when coordinating an agent.',
          sourceIds: ['m1'],
        },
      ]),
    ),
  }),
  ['m1'],
);
function fixture() {
  let authority = 'process-one';
  let enabled = true;
  const deliver = vi.fn(async () => {});
  const record = vi.fn(async () => {});
  const control = createCaoTerminalControl({
    state: async () => ({ enabled, mode: 'approve-before-send', guidance, authority }),
    draft: async () => 'Build and test the game in the assigned directory.',
    deliver,
    record,
  });
  return {
    control,
    deliver,
    record,
    replace: () => {
      authority = 'process-two';
    },
    revoke: () => {
      enabled = false;
    },
  };
}

function durablePendingStore() {
  const rows = new Map<string, CaoPendingProposal>();
  return {
    save: vi.fn(async (entry: CaoPendingProposal) => {
      rows.set(`${entry.proposal.accountId}:${entry.proposal.id}`, entry);
    }),
    take: vi.fn(async (id: string, accountId: string) => {
      const key = `${accountId}:${id}`;
      const entry = rows.get(key);
      rows.delete(key);
      return entry;
    }),
    remove: vi.fn(async (id: string, accountId: string) => {
      rows.delete(`${accountId}:${id}`);
    }),
  };
}
it('requires approval, consumes it once and records delivered rather than completed', async () => {
  const f = fixture();
  const proposal = await f.control.prepare(
    'account',
    'tty_one',
    'Build game',
    new AbortController().signal,
  );
  expect(f.deliver).not.toHaveBeenCalled();
  await f.control.approve(proposal.id);
  await expect(f.control.approve(proposal.id)).rejects.toThrow();
  expect(f.deliver).toHaveBeenCalledTimes(1);
  expect(f.record).toHaveBeenLastCalledWith(
    expect.objectContaining({ status: 'delivered', terminalId: 'tty_one' }),
  );
});

it('recovers an explicit terminal approval after runtime recreation and consumes it once', async () => {
  const store = durablePendingStore();
  const deliver = vi.fn(async () => {});
  const record = vi.fn(async () => {});
  const dependencies = {
    state: async () => ({
      enabled: true,
      mode: 'approve-before-send' as const,
      guidance,
      authority: 'process-one',
    }),
    draft: async () => 'Build and verify the exact assigned target.',
    deliver,
    record,
    pending: store,
    activeAccountId: () => 'account',
  };
  const first = createCaoTerminalControl(dependencies);
  const proposal = await first.prepare(
    'account',
    'tty_one',
    'Build game',
    new AbortController().signal,
  );
  const afterReload = createCaoTerminalControl(dependencies);

  await afterReload.approve(proposal.id);
  await expect(afterReload.approve(proposal.id)).rejects.toThrow('cao_proposal_unavailable');
  expect(deliver).toHaveBeenCalledOnce();
  expect(store.take).toHaveBeenCalledWith(proposal.id, 'account');
});
it.each(['replace', 'revoke'] as const)('rejects pending input after %s', async (change) => {
  const f = fixture();
  const proposal = await f.control.prepare(
    'account',
    'tty_one',
    'Build game',
    new AbortController().signal,
  );
  f[change]();
  await expect(f.control.approve(proposal.id)).rejects.toThrow();
  expect(f.deliver).not.toHaveBeenCalled();
});
it('records an ambiguous delivery failure without replaying', async () => {
  const f = fixture();
  f.deliver.mockRejectedValueOnce(Error('native timeout'));
  const proposal = await f.control.prepare(
    'account',
    'tty_one',
    'Build game',
    new AbortController().signal,
  );
  await expect(f.control.approve(proposal.id)).rejects.toThrow('native timeout');
  expect(f.record).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'unconfirmed' }));
  await expect(f.control.approve(proposal.id)).rejects.toThrow();
  expect(f.deliver).toHaveBeenCalledTimes(1);
});
