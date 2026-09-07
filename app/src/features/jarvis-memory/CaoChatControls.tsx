import { useEffect, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '@/lib/db';
import { Button } from '@/components/ui/button';
import { useJarvisLearningStore } from './learningStore';
import { CAO_GUIDANCE_AREAS, caoGuidanceReady } from './caoGuidance';
import {
  caoChatControl,
  caoPermissionKey,
  setCaoChatPermission,
  type CaoChatPermission,
} from './caoChatControlProduction';
import type { CaoChatProposal, CaoSendMode } from './caoChatControl';

export function CaoChatControls() {
  const accountId = useJarvisLearningStore((state) => state.activeAccountId);
  const profile = useJarvisLearningStore((state) => state.profiles[accountId]);
  const ready = Boolean(profile?.enabled && caoGuidanceReady(profile.caoGuidance));
  const permission = useLiveQuery(
    async () =>
      (await db.settings.get(caoPermissionKey(accountId)))?.value as CaoChatPermission | undefined,
    [accountId],
  );
  const chats = useLiveQuery(async () => {
    const workspaces = await db.workspaces.where('owner_id').equals(accountId).toArray();
    const owned = new Set(workspaces.map((workspace) => workspace.id));
    return db.chats
      .filter(
        (chat) =>
          owned.has(chat.workspace_id) &&
          !chat.archived &&
          Boolean(chat.project_id && chat.connection?.modelId),
      )
      .toArray();
  }, [accountId]);
  const [chatId, setChatId] = useState('');
  const [objective, setObjective] = useState('');
  const [proposal, setProposal] = useState<CaoChatProposal>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const controller = useRef<AbortController>();
  const proposalRef = useRef<CaoChatProposal>();
  useEffect(() => {
    setProposal(undefined);
    setChatId('');
    setObjective('');
    setError('');
    setBusy(false);
    return () => {
      controller.current?.abort();
      if (proposalRef.current) caoChatControl.reject(proposalRef.current.id);
    };
  }, [accountId]);
  const mode = permission?.mode ?? 'approve-before-send';
  const configure = async (enabled: boolean, nextMode: CaoSendMode) => {
    setError('');
    try {
      await setCaoChatPermission(accountId, { enabled, mode: nextMode });
    } catch {
      setError('CAO settings could not be saved.');
    }
  };
  const prepare = async () => {
    setBusy(true);
    setError('');
    if (proposalRef.current) caoChatControl.reject(proposalRef.current.id);
    setProposal(undefined);
    const aborter = new AbortController();
    controller.current = aborter;
    try {
      const next = await caoChatControl.prepare(accountId, chatId, objective, aborter.signal);
      if (!aborter.signal.aborted) {
        setProposal(next);
        proposalRef.current = next;
      }
    } catch {
      if (!aborter.signal.aborted)
        setError(
          'CAO could not prepare or send this message. Check learning, the selected chat, and the connected learner.',
        );
    } finally {
      if (controller.current === aborter) setBusy(false);
    }
  };
  const approve = async () => {
    if (!proposal) return;
    setBusy(true);
    setError('');
    const aborter = new AbortController();
    controller.current = aborter;
    try {
      await caoChatControl.approve(proposal.id, aborter.signal);
      if (!aborter.signal.aborted) setProposal({ ...proposal, status: 'sent' });
    } catch {
      if (!aborter.signal.aborted)
        setError('Message was not confirmed as sent. Check the target chat before trying again.');
      if (controller.current === aborter) setProposal(undefined);
    } finally {
      if (controller.current === aborter) setBusy(false);
    }
  };
  return (
    <section className="space-y-3 border-t border-border pt-3" aria-label="CAO chat management">
      <h4 className="font-medium">CAO chat management</h4>
      <p className="text-sm text-muted-foreground">
        Learns from your wording, conversation logs, file actions, corrections, and agent
        management. Guidance is saved in learning.md.
      </p>
      <p aria-label="CAO learning readiness" className="text-sm">
        {ready
          ? 'Guidance ready — you can enable CAO.'
          : `Still learning: ${CAO_GUIDANCE_AREAS.filter((area) => !profile?.caoGuidance?.sections[area]).join(', ') || 'learning is paused'}.`}
      </p>
      <details>
        <summary className="cursor-pointer text-sm">Review learned CAO guidance</summary>
        <div className="space-y-2 mt-2">
          {CAO_GUIDANCE_AREAS.map((area) => (
            <div key={area}>
              <strong className="text-sm">{area}</strong>
              <p className="text-sm whitespace-pre-wrap">
                {profile?.caoGuidance?.sections[area]?.guidance ?? 'More evidence needed.'}
              </p>
            </div>
          ))}
        </div>
      </details>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          aria-label="Enable CAO"
          disabled={!ready || busy}
          checked={ready && permission?.enabled === true}
          onChange={(event) => void configure(event.target.checked, mode)}
        />
        Enable CAO
      </label>
      <label className="flex items-center gap-2 text-sm">
        Message permissions
        <select
          aria-label="CAO message permissions"
          disabled={!ready || busy}
          value={mode}
          onChange={(event) =>
            void configure(permission?.enabled === true, event.target.value as CaoSendMode)
          }
        >
          <option value="approve-before-send">Approve before sending</option>
          <option value="full-access">Full access to send messages</option>
        </select>
      </label>
      <label className="block text-sm">
        Target chat
        <select
          aria-label="CAO target chat"
          value={chatId}
          disabled={busy}
          onChange={(event) => {
            setChatId(event.target.value);
            if (proposalRef.current) caoChatControl.reject(proposalRef.current.id);
            setProposal(undefined);
          }}
        >
          <option value="">Choose a chat</option>
          {chats?.map((chat) => (
            <option key={chat.id} value={chat.id}>
              {chat.title}
            </option>
          ))}
        </select>
      </label>
      <textarea
        className="w-full rounded border border-border bg-background p-2 text-sm"
        aria-label="CAO objective"
        placeholder="What should CAO help this agent accomplish?"
        value={objective}
        maxLength={8000}
        disabled={busy}
        onChange={(event) => setObjective(event.target.value)}
      />
      <Button
        size="sm"
        disabled={!ready || !permission?.enabled || !chatId || !objective.trim() || busy}
        onClick={() => void prepare()}
      >
        {busy ? 'Working…' : mode === 'full-access' ? 'Prepare and send' : 'Prepare message'}
      </Button>
      {busy && (
        <Button size="sm" variant="ghost" onClick={() => controller.current?.abort()}>
          Cancel
        </Button>
      )}
      {proposal && (
        <div className="space-y-2">
          <p className="text-sm whitespace-pre-wrap">{proposal.text}</p>
          {proposal.status === 'approval-required' ? (
            <>
              <Button size="sm" disabled={busy} onClick={() => void approve()}>
                Approve and send
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => {
                  caoChatControl.reject(proposal.id);
                  setProposal(undefined);
                }}
              >
                Discard
              </Button>
            </>
          ) : (
            <p role="status" className="text-sm">
              Message sent to the selected chat.
            </p>
          )}
        </div>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </section>
  );
}
