import { expect, it, vi } from 'vitest';
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
