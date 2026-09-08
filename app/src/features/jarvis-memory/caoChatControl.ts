import { caoGuidanceReady, type CaoGuidance } from './caoGuidance';

export type CaoSendMode = 'approve-before-send' | 'full-access';
export interface CaoChatProposal {
  id: string;
  accountId: string;
  chatId: string;
  text: string;
  status: 'approval-required' | 'sent';
  authority?: string;
  authorization?: 'user-approval' | 'full-access';
}
export interface CaoChatControlDependencies {
  state(
    accountId: string,
    chatId: string,
  ): Promise<{ enabled: boolean; mode: CaoSendMode; guidance?: CaoGuidance; authority?: string }>;
  draft(input: {
    accountId: string;
    chatId: string;
    objective: string;
    guidance: CaoGuidance;
    signal: AbortSignal;
  }): Promise<string>;
  send(proposal: CaoChatProposal, signal: AbortSignal): Promise<void>;
}
export function createCaoChatControl(dependencies: CaoChatControlDependencies) {
  const pending = new Map<
    string,
    { proposal: CaoChatProposal; guidance: string; authority?: string }
  >();
  const check = async (accountId: string, chatId: string) => {
    const state = await dependencies.state(accountId, chatId);
    if (!state.enabled) throw new Error('cao_not_enabled');
    if (!caoGuidanceReady(state.guidance)) throw new Error('cao_learning_incomplete');
    return state;
  };
  return {
    async prepare(
      accountId: string,
      chatId: string,
      objective: string,
      signal: AbortSignal,
    ): Promise<CaoChatProposal> {
      if (!objective.trim() || objective.length > 8000) throw new Error('cao_objective_invalid');
      const state = await check(accountId, chatId);
      signal.throwIfAborted();
      const text = (
        await dependencies.draft({
          accountId,
          chatId,
          objective,
          guidance: state.guidance!,
          signal,
        })
      ).trim();
      signal.throwIfAborted();
      if (!text || text.length > 17000) throw new Error('cao_message_invalid');
      const current = await check(accountId, chatId);
      if (current.authority !== state.authority) throw new Error('cao_target_changed');
      if (JSON.stringify(current.guidance) !== JSON.stringify(state.guidance))
        throw new Error('cao_learning_changed');
      const proposal: CaoChatProposal = {
        id: crypto.randomUUID(),
        accountId,
        chatId,
        text,
        status: 'approval-required',
        authority: current.authority,
      };
      if (current.mode === 'full-access' && state.mode === 'full-access') {
        signal.throwIfAborted();
        proposal.authorization = 'full-access';
        await dependencies.send(proposal, signal);
        proposal.status = 'sent';
      } else {
        if (pending.size >= 20) throw new Error('cao_pending_limit');
        pending.set(proposal.id, {
          proposal: structuredClone(proposal),
          guidance: JSON.stringify(current.guidance),
          authority: current.authority,
        });
      }
      return proposal;
    },
    async approve(id: string, signal = new AbortController().signal): Promise<void> {
      const entry = pending.get(id);
      if (!entry) throw new Error('cao_proposal_unavailable');
      // Consume before awaiting to prevent concurrent approval clicks dispatching twice.
      pending.delete(id);
      const state = await check(entry.proposal.accountId, entry.proposal.chatId);
      if (state.authority !== entry.authority) throw new Error('cao_target_changed');
      if (JSON.stringify(state.guidance) !== entry.guidance)
        throw new Error('cao_learning_changed');
      signal.throwIfAborted();
      await dependencies.send({ ...entry.proposal, authorization: 'user-approval' }, signal);
    },
    reject(id: string) {
      pending.delete(id);
    },
  };
}
