import {
  createCaoChatControl,
  type CaoChatControlDependencies,
} from '@/features/jarvis-memory/caoChatControl';

export interface CaoTerminalDelivery {
  id: string;
  accountId: string;
  terminalId: string;
  text: string;
  authority?: string;
  status: 'dispatching' | 'delivered' | 'unconfirmed';
  createdAt: number;
}

/** Reuses the learned guidance, revocation and single-use approval contract. */
export function createCaoTerminalControl(
  dependencies: Omit<CaoChatControlDependencies, 'send'> & {
    deliver: CaoChatControlDependencies['send'];
    record(value: CaoTerminalDelivery): Promise<void>;
  },
) {
  return createCaoChatControl({
    ...dependencies,
    async send(proposal, signal) {
      const entry: CaoTerminalDelivery = {
        id: proposal.id,
        accountId: proposal.accountId,
        terminalId: proposal.chatId,
        text: proposal.text,
        authority: proposal.authority,
        status: 'dispatching',
        createdAt: Date.now(),
      };
      await dependencies.record(entry);
      try {
        signal.throwIfAborted();
        await dependencies.deliver(proposal, signal);
        await dependencies.record({ ...entry, status: 'delivered' });
      } catch (error) {
        await dependencies.record({ ...entry, status: 'unconfirmed' });
        throw error;
      }
    },
  });
}
