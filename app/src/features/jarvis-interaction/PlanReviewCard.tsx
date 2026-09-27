import { useRef, useState } from 'react';
import { ClipboardList, Plus, RotateCcw, XCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { messageRepo } from '@/lib/db/repositories';
import type { MessageId, Part } from '@/types';
import { useJarvisInteractionStore } from './sessionStore';
import type { JarvisPlanReview } from './types';

type PlanPart = Extract<Part, { kind: 'plan_review' }>;

export interface PlanReviewCardProps {
  part: PlanPart;
  messageId?: MessageId;
  chatId?: string;
}

function samePlanDefinition(left: JarvisPlanReview, right: JarvisPlanReview): boolean {
  return (
    left.id === right.id &&
    left.title === right.title &&
    left.summary === right.summary &&
    (left.executable ?? true) === (right.executable ?? true) &&
    left.steps.length === right.steps.length &&
    left.steps.every((step, index) => step === right.steps[index]) &&
    (left.risks ?? []).length === (right.risks ?? []).length &&
    (left.risks ?? []).every((risk, index) => risk === (right.risks ?? [])[index])
  );
}

export function PlanReviewCard({ part, messageId, chatId }: PlanReviewCardProps) {
  const { plan } = part;
  const canExecute = plan.executable !== false;
  const [redoOpen, setRedoOpen] = useState(false);
  const [revision, setRevision] = useState('');
  const [adding, setAdding] = useState(false);
  const [pendingAction, setPendingAction] = useState<'build' | 'revision' | 'cancel' | null>(null);
  const busy = pendingAction !== null;
  const [error, setError] = useState<string | null>(null);
  const busyRef = useRef(false);

  const writeStatus = async (status: JarvisPlanReview['status']) => {
    if (!messageId || !chatId) throw new Error('Plan approval is unavailable.');
    const message = await messageRepo.getById(messageId);
    const persistedPart = message?.parts.find(
      (messagePart): messagePart is PlanPart =>
        messagePart.kind === 'plan_review' && messagePart.plan.id === plan.id,
    );
    if (
      !message ||
      String(message.chat_id) !== chatId ||
      !persistedPart ||
      persistedPart.plan.status !== 'pending' ||
      !samePlanDefinition(persistedPart.plan, plan)
    ) {
      throw new Error('Plan approval is no longer pending.');
    }
    await messageRepo.update(messageId, {
      parts: message.parts.map((messagePart) =>
        messagePart.kind === 'plan_review' && messagePart.plan.id === plan.id
          ? { kind: 'plan_review', plan: { ...messagePart.plan, status } }
          : messagePart,
      ),
    });
  };

  const handleBuild = async () => {
    if (!chatId || busyRef.current || plan.status !== 'pending') return;
    busyRef.current = true;
    setPendingAction('build');
    setError(null);
    try {
      if (!canExecute) {
        await writeStatus('built');
        return;
      }
      await writeStatus('building');
      useJarvisInteractionStore.getState().setChatMode(chatId, 'agent');
      window.dispatchEvent(
        new CustomEvent('jarvis:send', {
          detail: {
            chatId,
            // Preserve the entire validated plan in structuredContext below.
            // Quoting pre-approval restrictions as the new instruction can
            // incorrectly disable the tools needed after approval.
            text: 'Implement the approved plan in the attached structured context. In-app approval has been granted; use only the tools needed for that plan, preserve its constraints, then verify the result.',
            interactionMode: 'agent',
            structuredContext: {
              kind: 'plan_build',
              sourceMessageId: messageId,
              payload: { plan },
            },
          },
        }),
      );
    } catch {
      setError('The plan could not start. Please retry.');
    } finally {
      busyRef.current = false;
      setPendingAction(null);
    }
  };

  const handleRedo = async () => {
    if (!chatId || busyRef.current || plan.status !== 'pending' || !revision.trim()) return;
    busyRef.current = true;
    setPendingAction('revision');
    setError(null);
    try {
      await writeStatus('redone');
      useJarvisInteractionStore.getState().setChatMode(chatId, 'plan');
      const text = `Redo this plan with this instruction: ${adding ? 'Preserve the existing requirements and add: ' : ''}${revision.trim()}`;
      await messageRepo.create({
        chat_id: chatId as never,
        role: 'user',
        parts: [{ kind: 'text', text }],
      });
      window.dispatchEvent(
        new CustomEvent('jarvis:send', {
          detail: {
            chatId,
            text,
            interactionMode: 'plan',
            structuredContext: {
              kind: 'plan_redo',
              sourceMessageId: messageId,
              payload: { plan, revision: revision.trim() },
            },
          },
        }),
      );
      setRedoOpen(false);
    } catch {
      setError('The plan revision could not be saved. Check the plan status before retrying.');
    } finally {
      busyRef.current = false;
      setPendingAction(null);
    }
  };

  const handleCancel = async () => {
    if (busyRef.current || plan.status !== 'pending') return;
    busyRef.current = true;
    setPendingAction('cancel');
    setError(null);
    try {
      await writeStatus('cancelled');
    } catch {
      setError('The plan could not be cancelled. Please retry.');
    } finally {
      busyRef.current = false;
      setPendingAction(null);
    }
  };

  return (
    <section className="w-full min-w-[min(720px,100%)] rounded-xl border border-accent-copper/35 bg-accent-copper/5 p-3 shadow-[0_0_20px_-16px_hsl(var(--accent-copper))]">
      <div className="mb-2 flex items-start gap-2">
        <div className="rounded-full border border-accent-copper/40 bg-accent-copper/10 p-1">
          <ClipboardList className="h-3.5 w-3.5 text-accent-copper" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-ui-strong text-foreground">{plan.title}</div>
          <Dialog>
            <DialogTrigger asChild>
              <Button type="button" size="sm" variant="ghost" className="my-1 px-0">
                View full plan
              </Button>
            </DialogTrigger>
            <DialogContent className="max-w-4xl max-h-[calc(100dvh-2rem)] overflow-y-auto">
              <DialogHeader>
                <DialogTitle>{plan.title}</DialogTitle>
                <DialogDescription className="whitespace-pre-wrap break-words">
                  {plan.summary}
                </DialogDescription>
              </DialogHeader>
              <ol className="ml-5 list-decimal space-y-2 text-secondary text-foreground">
                {plan.steps.map((step, index) => (
                  <li key={`${plan.id}:full-step:${index}`} className="break-words">
                    {step}
                  </li>
                ))}
              </ol>
              {plan.risks?.length ? (
                <div className="rounded-md border border-border bg-background/60 px-3 py-2">
                  <div className="text-metadata uppercase tracking-wide text-muted-foreground">Risks</div>
                  <ul className="ml-5 list-disc text-secondary text-muted-foreground">
                    {plan.risks.map((risk, index) => (
                      <li key={`${plan.id}:full-risk:${index}`} className="break-words">
                        {risk}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </DialogContent>
          </Dialog>
          <p className="whitespace-pre-wrap text-secondary text-muted-foreground">{plan.summary}</p>
        </div>
      </div>
      <ol className="ml-5 list-decimal space-y-1 text-secondary text-foreground">
        {plan.steps.map((step, index) => (
          <li key={`${plan.id}:step:${index}`}>{step}</li>
        ))}
      </ol>
      {plan.risks?.length ? (
        <div className="mt-2 rounded-md border border-border bg-background/60 px-2 py-1.5">
          <div className="text-metadata uppercase tracking-wide text-muted-foreground">Risks</div>
          <ul className="ml-4 list-disc text-secondary text-muted-foreground">
            {plan.risks.map((risk, index) => (
              <li key={`${plan.id}:risk:${index}`}>{risk}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {plan.status !== 'pending' && (
        <p className="mt-2 text-secondary text-muted-foreground">Plan status: {plan.status}</p>
      )}
      {error && (
        <p role="alert" className="mt-2 text-secondary text-destructive">
          {error}
        </p>
      )}
      {redoOpen && (
        <div className="mt-3 flex flex-col gap-2">
          <textarea
            className="min-h-16 w-full resize-y rounded-md border border-border bg-background px-2 py-1.5 text-secondary text-foreground outline-none focus:border-accent-copper"
            placeholder={adding ? 'What should Jarvis add to the plan?' : 'What should Jarvis change in the next plan?'}
            value={revision}
            onChange={(event) => setRevision(event.target.value)}
          />
          <Button
            type="button"
            size="sm"
            variant="accent"
            disabled={busy || plan.status !== 'pending' || !revision.trim()}
            onClick={handleRedo}
          >
            {pendingAction === 'revision' ? 'Saving revision…' : 'Send Revision'}
          </Button>
        </div>
      )}
      {canExecute && plan.status === 'pending' ? (
        <p className="mt-3 text-secondary font-medium text-foreground">Implement this plan?</p>
      ) : null}
      <div
        className="mt-3 flex flex-wrap gap-2"
        role={canExecute && plan.status === 'pending' ? 'group' : undefined}
        aria-label={canExecute && plan.status === 'pending' ? 'Implement this plan?' : undefined}
      >
        <Button
          type="button"
          size="sm"
          variant="accent"
          disabled={busy || plan.status !== 'pending'}
          onClick={handleBuild}
        >
          {canExecute ? (pendingAction === 'build' ? 'Implementing…' : 'Yes — Implement Plan') : 'Done'}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="secondary"
          disabled={busy || plan.status !== 'pending'}
          onClick={() => { setAdding(false); setRedoOpen(true); }}
        >
          <RotateCcw className="h-3 w-3" />
          Redo Plan
        </Button>
        <Button
          type="button"
          size="sm"
          variant="secondary"
          disabled={busy || plan.status !== 'pending'}
          onClick={() => { setAdding(true); setRedoOpen(true); }}
        >
          <Plus className="h-3 w-3" />
          Add to Plan
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={busy || plan.status !== 'pending'}
          onClick={handleCancel}
        >
          <XCircle className="h-3 w-3" />
          {pendingAction === 'cancel' ? 'Cancelling…' : canExecute ? 'No — Cancel' : 'Cancel'}
        </Button>
      </div>
    </section>
  );
}
