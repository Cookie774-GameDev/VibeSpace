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
export type CaoPendingProposal = Readonly<{
  proposal: CaoChatProposal;
  guidance: string;
  authority?: string;
  expiresAt: number;
}>;
export interface CaoChatProposalPersistence {
  save(entry: CaoPendingProposal): Promise<void>;
  /** Atomically claim and remove one exact proposal for this account. */
  take(id: string, accountId: string): Promise<CaoPendingProposal | undefined>;
  remove(id: string, accountId: string): Promise<void>;
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
  pending?: CaoChatProposalPersistence;
  activeAccountId?: () => string | undefined;
}
export const CAO_PENDING_PROPOSAL_TTL_MS = 5 * 60 * 1000;

function validPendingProposal(value: unknown): value is CaoPendingProposal {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const entry = value as Partial<CaoPendingProposal>;
  const proposal = entry.proposal;
  return (
    typeof entry.guidance === 'string' &&
    typeof entry.expiresAt === 'number' &&
    Number.isSafeInteger(entry.expiresAt) &&
    entry.expiresAt >= 0 &&
    typeof proposal === 'object' &&
    proposal !== null &&
    !Array.isArray(proposal) &&
    typeof proposal.id === 'string' &&
    typeof proposal.accountId === 'string' &&
    typeof proposal.chatId === 'string' &&
    typeof proposal.text === 'string' &&
    proposal.status === 'approval-required' &&
    (proposal.authority === undefined || typeof proposal.authority === 'string') &&
    proposal.authorization === undefined
  );
}

export function createCaoChatControl(dependencies: CaoChatControlDependencies) {
  const pending = new Map<string, CaoPendingProposal>();
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
        const entry: CaoPendingProposal = {
          proposal: structuredClone(proposal),
          guidance: JSON.stringify(current.guidance),
          authority: current.authority,
          expiresAt: Date.now() + CAO_PENDING_PROPOSAL_TTL_MS,
        };
        if (dependencies.pending) await dependencies.pending.save(entry);
        pending.set(proposal.id, entry);
      }
      return proposal;
    },
    async approve(id: string, signal = new AbortController().signal): Promise<void> {
      const inMemory = pending.get(id);
      pending.delete(id);
      const activeAccountId = dependencies.activeAccountId?.();
      if (dependencies.activeAccountId && !activeAccountId) throw new Error('cao_account_changed');
      if (activeAccountId && inMemory && inMemory.proposal.accountId !== activeAccountId)
        throw new Error('cao_account_changed');
      const entry = dependencies.pending
        ? await dependencies.pending.take(id, activeAccountId ?? inMemory?.proposal.accountId ?? '')
        : inMemory;
      if (!entry) throw new Error('cao_proposal_unavailable');
      if (!validPendingProposal(entry)) throw new Error('cao_proposal_unavailable');
      if (entry.expiresAt <= Date.now()) throw new Error('cao_proposal_expired');
      if (activeAccountId && entry.proposal.accountId !== activeAccountId)
        throw new Error('cao_account_changed');
      // The durable take happens before revalidation and send, so approval is single-use even
      // across renderer instances. A failed send therefore requires a new proposal.
      const state = await check(entry.proposal.accountId, entry.proposal.chatId);
      if (state.authority !== entry.authority) throw new Error('cao_target_changed');
      if (JSON.stringify(state.guidance) !== entry.guidance)
        throw new Error('cao_learning_changed');
      signal.throwIfAborted();
      await dependencies.send({ ...entry.proposal, authorization: 'user-approval' }, signal);
    },
    reject(id: string) {
      const entry = pending.get(id);
      pending.delete(id);
      const accountId = dependencies.activeAccountId?.() ?? entry?.proposal.accountId;
      if (dependencies.pending && accountId)
        void dependencies.pending.remove(id, accountId).catch(() => undefined);
    },
  };
}

export { validPendingProposal as isCaoPendingProposal };
