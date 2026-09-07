import { expect, it, vi } from 'vitest';
import { createCaoChatControl } from './caoChatControl';
import { CAO_GUIDANCE_AREAS, parseCaoGuidance } from './caoGuidance';

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
it('requires established learning and explicit activation, then holds exact draft for approval', async () => {
  let enabled = false;
  const send = vi.fn(async () => {});
  const control = createCaoChatControl({
    state: async () => ({ enabled, mode: 'approve-before-send', guidance }),
    draft: async () => 'Please run the focused checks and report the results.',
    send,
  });
  await expect(
    control.prepare('account', 'chat', 'Verify this task', new AbortController().signal),
  ).rejects.toThrow('cao_not_enabled');
  enabled = true;
  const proposal = await control.prepare(
    'account',
    'chat',
    'Verify this task',
    new AbortController().signal,
  );
  expect(proposal.status).toBe('approval-required');
  expect(send).not.toHaveBeenCalled();
  await control.approve(proposal.id);
  expect(send).toHaveBeenCalledWith(
    expect.objectContaining({ text: proposal.text, chatId: 'chat' }),
    expect.any(AbortSignal),
  );
  await expect(control.approve(proposal.id)).rejects.toThrow();
  expect(send).toHaveBeenCalledTimes(1);
});
it('full access sends once and revocation invalidates pending drafts', async () => {
  let enabled = true;
  let mode: 'full-access' | 'approve-before-send' = 'full-access';
  const send = vi.fn(async () => {});
  const control = createCaoChatControl({
    state: async () => ({ enabled, mode, guidance }),
    draft: async () => 'Please inspect the failing check.',
    send,
  });
  expect(
    (await control.prepare('account', 'chat', 'Investigate', new AbortController().signal)).status,
  ).toBe('sent');
  mode = 'approve-before-send';
  const pending = await control.prepare(
    'account',
    'chat',
    'Investigate',
    new AbortController().signal,
  );
  enabled = false;
  await expect(control.approve(pending.id)).rejects.toThrow('cao_not_enabled');
  expect(send).toHaveBeenCalledTimes(1);
});
it('invalidates approval when the selected chat route or agent changes', async () => {
  let authority = 'codex-agent-one';
  const send = vi.fn(async () => {});
  const control = createCaoChatControl({
    state: async () => ({ enabled: true, mode: 'approve-before-send', guidance, authority }),
    draft: async () => 'Please verify the fix.',
    send,
  });
  const proposal = await control.prepare('account', 'chat', 'Verify', new AbortController().signal);
  authority = 'opencode-agent-two';
  await expect(control.approve(proposal.id)).rejects.toThrow('cao_target_changed');
  expect(send).not.toHaveBeenCalled();
});
