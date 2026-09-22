import { caoMessageEnvelope } from './caoMessageEnvelope';
import { invoke } from '@tauri-apps/api/core';
import { db } from '@/lib/db';
import { getActiveAccountIdentity } from '@/lib/accountIdentity';
import type { ProjectId } from '@/types';
import type { BackendTerminalInfo } from '@/features/terminals/restoreSession';
import { useTerminalTranscriptStore } from '@/features/terminals/transcriptStore';
import { cleanCaoTerminalHistory, readCaoTerminalEvidence } from './terminalEvidence';
import { readLiveTargetSnapshot } from '@/features/instant-command/targetSnapshot';
import { useJarvisLearningStore } from '@/features/jarvis-memory/learningStore';
import { caoGuidanceReady } from '@/features/jarvis-memory/caoGuidance';
import {
  caoChatProposalPersistence,
  caoPermissionKey,
  type CaoChatPermission,
} from '@/features/jarvis-memory/caoChatControlProduction';
import { createCaoTerminalControl } from './terminalControlRuntime';
import { caoTerminalModel } from './terminalControlModel';
import { caoTerminalPaneRegistry } from './terminalPaneControl';
import { runCaoTerminalLifecycle } from './terminalLifecycle';
import type { ExpectedTerminalProcessBinding } from '@/features/terminals/terminalRefs';

function assertAccount(accountId: string) {
  if (
    getActiveAccountIdentity()?.accountId !== accountId ||
    useJarvisLearningStore.getState().activeAccountId !== accountId
  )
    throw Error('cao_account_changed');
}
export async function listCaoTerminals(accountId: string, projectId?: string | null) {
  assertAccount(accountId);
  const native = await invoke<BackendTerminalInfo[]>('terminal_list');
  const targets = await readLiveTargetSnapshot({
    projectId,
    listNativeSessions: async () => native,
  });
  const result = [];
  for (const target of targets) {
    if (!target.projectId) continue;
    const project = await db.projects.get(target.projectId as ProjectId);
    const workspace = project && (await db.workspaces.get(project.workspace_id));
    const process = native.find((row) => row.sessionId === target.sessionId);
    if (workspace?.owner_id !== accountId || !process) continue;
    result.push({
      ...target,
      cwd: process.cwd,
      nativeCommand: process.command,
      canMessage: /(?:^|[\\/])opencode(?:\.exe)?$/i.test(process.command),
    });
  }
  assertAccount(accountId);
  return result;
}
async function authorization(accountId: string) {
  const permission = (await db.settings.get(caoPermissionKey(accountId)))?.value as
    | CaoChatPermission
    | undefined;
  assertAccount(accountId);
  const profile = useJarvisLearningStore.getState().currentProfile();
  return {
    enabled:
      profile.enabled &&
      permission?.enabled === true &&
      permission.learningEpoch === profile.caoLearningEpoch,
    mode:
      permission?.mode === 'full-access'
        ? ('full-access' as const)
        : ('approve-before-send' as const),
    guidance: profile.caoGuidance,
    permissionAuthority: JSON.stringify({
      permission,
      epoch: profile.caoLearningEpoch,
      guidance: profile.caoGuidance,
    }),
  };
}
async function state(accountId: string, terminalId: string) {
  const target = (await listCaoTerminals(accountId)).find((row) => row.sessionId === terminalId);
  if (!target) throw Error('cao_terminal_unavailable');
  const auth = await authorization(accountId);
  return {
    target,
    ...auth,
    authority: JSON.stringify({ target, permissionAuthority: auth.permissionAuthority }),
  };
}
function evidence(target: Awaited<ReturnType<typeof state>>['target']) {
  const transcript = useTerminalTranscriptStore.getState().sessions[target.sessionId];
  if (
    !transcript ||
    transcript.paneId !== target.paneId ||
    transcript.projectId !== target.projectId
  )
    throw Error('cao_terminal_evidence_unavailable');
  return JSON.stringify({
    target,
    observedAt: Date.now(),
    lastOutputAt: transcript.lastWriteAt,
    truncated: transcript.text.length > 24000,
    text: cleanCaoTerminalHistory(transcript.text),
    screen: readCaoTerminalEvidence({
      accountId: getActiveAccountIdentity()!.accountId,
      projectId: target.projectId!,
      paneId: target.paneId,
      sessionId: target.sessionId,
    }),
    historyNote:
      'TUI history may contain redraw fragments. The screen is the latest rendered terminal view. Agent claims alone do not prove successful gameplay.',
  });
}
export const caoTerminalControl = createCaoTerminalControl({
  pending: caoChatProposalPersistence,
  activeAccountId: () => getActiveAccountIdentity()?.accountId,
  state,
  async draft({ accountId, chatId, objective, guidance, signal }) {
    const current = await state(accountId, chatId);
    if (!current.target.canMessage) throw Error('cao_terminal_direct_agent_required');
    const result = await caoTerminalModel({
      accountId,
      objective,
      guidance,
      signal,
      action: 'draft',
      evidence: evidence(current.target),
    });
    await db.settings.put({
      key: `cao.terminal.draft.v1:${accountId}:${result.receipt.requestId}`,
      value: { ...result, terminalId: chatId },
      updated_at: Date.now(),
    });
    return caoMessageEnvelope(result.text, objective);
  },
  async deliver(proposal, signal) {
    const current = await state(proposal.accountId, proposal.chatId);
    if (
      !current.enabled ||
      !caoGuidanceReady(current.guidance) ||
      current.authority !== proposal.authority ||
      !current.target.canMessage ||
      !(
        proposal.authorization === 'user-approval' ||
        (proposal.authorization === 'full-access' && current.mode === 'full-access')
      )
    )
      throw Error('cao_terminal_authority_changed');
    const transcript = useTerminalTranscriptStore.getState().sessions[proposal.chatId];
    if (transcript?.currentInput?.trim()) throw Error('cao_terminal_user_input_pending');
    signal.throwIfAborted();
    assertAccount(proposal.accountId);
    await invoke('terminal_write', {
      sessionId: proposal.chatId,
      data: proposal.text,
      expectedBinding: current.target.processIdentity,
      agentMessage: true,
    });
  },
  async record(value) {
    assertAccount(value.accountId);
    await db.settings.put({
      key: `cao.terminal.delivery.v1:${value.accountId}:${value.id}`,
      value,
      updated_at: Date.now(),
    });
  },
});
export async function reviewCaoTerminal(
  accountId: string,
  terminalId: string,
  objective: string,
  action: 'diagnose' | 'supervise' | 'verify' | 'grade' | 'force-check',
  signal: AbortSignal,
) {
  const initial = await state(accountId, terminalId);
  if (!initial.enabled || !caoGuidanceReady(initial.guidance)) throw Error('cao_not_enabled');
  const result = await caoTerminalModel({
    accountId,
    objective,
    action,
    signal,
    guidance: initial.guidance!,
    evidence: evidence(initial.target),
  });
  if ((await state(accountId, terminalId)).authority !== initial.authority)
    throw Error('cao_terminal_authority_changed');
  await db.settings.put({
    key: `cao.terminal.review.v1:${accountId}:${result.receipt.requestId}`,
    value: { ...result, terminalId, action, objective },
    updated_at: Date.now(),
  });
  return result;
}

function lifecycleControl(action: 'restart' | 'cancel') {
  return createCaoTerminalControl({
    pending: caoChatProposalPersistence,
    activeAccountId: () => getActiveAccountIdentity()?.accountId,
    state,
    async draft({ accountId, chatId, objective, guidance, signal }) {
      const current = await state(accountId, chatId);
      if (!current.target.canMessage) throw Error('cao_terminal_direct_agent_required');
      caoTerminalPaneRegistry
        .capture(accountId, current.target.projectId!, current.target.paneId, chatId)
        .assert();
      const review = await caoTerminalModel({
        accountId,
        objective,
        guidance,
        signal,
        action: 'diagnose',
        evidence: evidence(current.target),
      });
      await db.settings.put({
        key: `cao.terminal.lifecycle-review.v1:${accountId}:${review.receipt.requestId}`,
        value: { ...review, action, terminalId: chatId },
        updated_at: Date.now(),
      });
      return `${action === 'restart' ? 'Restart the captured OpenCode process in a fresh session. This does not replay or resume its previous prompt.' : 'Stop the captured OpenCode process.'}\n\n${caoMessageEnvelope(review.text, objective)}`;
    },
    async deliver(proposal, signal) {
      const current = await state(proposal.accountId, proposal.chatId);
      if (
        current.authority !== proposal.authority ||
        !current.enabled ||
        !caoGuidanceReady(current.guidance) ||
        !current.target.canMessage ||
        !(
          proposal.authorization === 'user-approval' ||
          (proposal.authorization === 'full-access' && current.mode === 'full-access')
        )
      )
        throw Error('cao_terminal_authority_changed');
      const pane = caoTerminalPaneRegistry.capture(
        proposal.accountId,
        current.target.projectId!,
        current.target.paneId,
        proposal.chatId,
      );
      await runCaoTerminalLifecycle(
        action,
        {
          sessionId: proposal.chatId,
          command: current.target.nativeCommand,
          cwd: current.target.cwd,
          projectId: current.target.projectId!,
          binding: current.target.processIdentity,
        },
        {
          async authorize() {
            const auth = await authorization(proposal.accountId);
            if (!auth.enabled || auth.permissionAuthority !== current.permissionAuthority)
              throw Error('cao_terminal_authority_changed');
            pane.assert();
            if (
              useTerminalTranscriptStore.getState().sessions[proposal.chatId]?.currentInput?.trim()
            )
              throw Error('cao_terminal_user_input_pending');
          },
          kill: (sessionId, expectedBinding) =>
            invoke('terminal_kill', { sessionId, expectedBinding }),
          list: () => invoke<BackendTerminalInfo[]>('terminal_list'),
          async spawn(input) {
            const result = await invoke<ExpectedTerminalProcessBinding & { sessionId: string }>(
              'terminal_spawn',
              input,
            );
            return { ...result, projectId: current.target.projectId! };
          },
          attach: pane.replace,
          async record(result) {
            assertAccount(proposal.accountId);
            await db.settings.put({
              key: `cao.terminal.lifecycle.v1:${proposal.accountId}:${proposal.id}`,
              value: {
                ...result,
                action,
                terminalId: proposal.chatId,
                authority: proposal.authority,
              },
              updated_at: Date.now(),
            });
          },
          wait: () => new Promise((resolve) => setTimeout(resolve, 250)),
        },
        signal,
      );
    },
    async record(value) {
      assertAccount(value.accountId);
      await db.settings.put({
        key: `cao.terminal.delivery.v1:${value.accountId}:${value.id}`,
        value: { ...value, action },
        updated_at: Date.now(),
      });
    },
  });
}
export const caoTerminalLifecycleControls = {
  restart: lifecycleControl('restart'),
  cancel: lifecycleControl('cancel'),
};
