import { expect, it, vi } from 'vitest';
import { createCaoChatControl, type CaoPendingProposal } from './caoChatControl';
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

function durablePendingStore() {
  const rows = new Map<string, CaoPendingProposal>();
  const key = (accountId: string, id: string) => `${accountId}:${id}`;
  return {
    rows,
    save: vi.fn(async (entry: CaoPendingProposal) => {
      rows.set(key(entry.proposal.accountId, entry.proposal.id), entry);
    }),
    take: vi.fn(async (id: string, accountId: string) => {
      const rowKey = key(accountId, id);
      const entry = rows.get(rowKey);
      rows.delete(rowKey);
      return entry;
    }),
    remove: vi.fn(async (id: string, accountId: string) => {
      rows.delete(key(accountId, id));
    }),
  };
}
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

it('recovers an explicit approval after a control instance is recreated', async () => {
  const store = durablePendingStore();
  const send = vi.fn(async () => {});
  let activeAccount = 'account';
  const dependencies = {
    state: async () => ({
      enabled: true,
      mode: 'approve-before-send' as const,
      guidance,
      authority: 'project-a',
    }),
    draft: async () => 'Please verify the scoped result.',
    send,
    pending: store,
    activeAccountId: () => activeAccount,
  };
  const first = createCaoChatControl(dependencies);
  const proposal = await first.prepare('account', 'chat', 'Verify', new AbortController().signal);
  const afterReload = createCaoChatControl(dependencies);

  await afterReload.approve(proposal.id);
  expect(send).toHaveBeenCalledOnce();
  expect(store.take).toHaveBeenCalledWith(proposal.id, 'account');
  activeAccount = 'other-account';
  await expect(afterReload.approve(proposal.id)).rejects.toThrow('cao_proposal_unavailable');
});

it('keeps a proposal scoped to its account when another account tries first', async () => {
  const store = durablePendingStore();
  const send = vi.fn(async () => {});
  let activeAccount = 'account-a';
  const control = createCaoChatControl({
    state: async () => ({
      enabled: true,
      mode: 'approve-before-send' as const,
      guidance,
      authority: 'target-a',
    }),
    draft: async () => 'Send only after explicit approval.',
    send,
    pending: store,
    activeAccountId: () => activeAccount,
  });
  const proposal = await control.prepare(
    'account-a',
    'chat-a',
    'Verify',
    new AbortController().signal,
  );
  activeAccount = 'account-b';
  await expect(control.approve(proposal.id)).rejects.toThrow('cao_account_changed');
  expect(send).not.toHaveBeenCalled();
  activeAccount = 'account-a';
  await control.approve(proposal.id);
  expect(send).toHaveBeenCalledOnce();
});

it('atomically consumes a recovered approval across concurrent approval calls', async () => {
  const store = durablePendingStore();
  const send = vi.fn(async () => {});
  const dependencies = {
    state: async () => ({
      enabled: true,
      mode: 'approve-before-send' as const,
      guidance,
      authority: 'target',
    }),
    draft: async () => 'Run the exact approved message.',
    send,
    pending: store,
    activeAccountId: () => 'account',
  };
  const creator = createCaoChatControl(dependencies);
  const proposal = await creator.prepare('account', 'chat', 'Verify', new AbortController().signal);
  const left = createCaoChatControl(dependencies);
  const right = createCaoChatControl(dependencies);
  const results = await Promise.allSettled([left.approve(proposal.id), right.approve(proposal.id)]);

  expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
  expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
  expect(send).toHaveBeenCalledOnce();
});

it('does not replay a consumed approval after delivery fails', async () => {
  const store = durablePendingStore();
  const send = vi.fn().mockRejectedValueOnce(new Error('delivery_failed'));
  const control = createCaoChatControl({
    state: async () => ({
      enabled: true,
      mode: 'approve-before-send' as const,
      guidance,
      authority: 'target',
    }),
    draft: async () => 'This delivery must be single-use.',
    send,
    pending: store,
    activeAccountId: () => 'account',
  });
  const proposal = await control.prepare('account', 'chat', 'Verify', new AbortController().signal);

  await expect(control.approve(proposal.id)).rejects.toThrow('delivery_failed');
  await expect(control.approve(proposal.id)).rejects.toThrow('cao_proposal_unavailable');
  expect(send).toHaveBeenCalledOnce();
});

it('fails closed with an actionable expiry after the approval window closes', async () => {
  const store = durablePendingStore();
  const send = vi.fn(async () => {});
  const control = createCaoChatControl({
    state: async () => ({
      enabled: true,
      mode: 'approve-before-send' as const,
      guidance,
      authority: 'target',
    }),
    draft: async () => 'This proposal must expire before delivery.',
    send,
    pending: store,
    activeAccountId: () => 'account',
  });
  const proposal = await control.prepare('account', 'chat', 'Verify', new AbortController().signal);
  const key = `account:${proposal.id}`;
  const entry = store.rows.get(key);
  expect(entry).toBeDefined();
  store.rows.set(key, { ...entry!, expiresAt: Date.now() - 1 });

  await expect(control.approve(proposal.id)).rejects.toThrow('cao_proposal_expired');
  expect(send).not.toHaveBeenCalled();
});
