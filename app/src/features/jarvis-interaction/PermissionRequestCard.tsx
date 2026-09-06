import { useRef, useState } from 'react';
import { ShieldAlert } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { messageRepo } from '@/lib/db/repositories';
import { respondToPersistentOpenCodeApproval } from '@/lib/ai/adapters/opencodePersistent';
import { recordOpenCodeApprovalStatus } from '@/lib/harness/openCodeApprovalState';
import { grantToolGatewayMutation } from '@/lib/harness/toolGatewayProduction';
import type { MessageId, Part } from '@/types';
import { useJarvisInteractionStore } from './sessionStore';
import type { JarvisPermissionRequest, JarvisPermissionStatus } from './types';

type PermissionPart = Extract<Part, { kind: 'permission_request' }>;

function sameImmutableRequest(
  left: Readonly<JarvisPermissionRequest>,
  right: Readonly<JarvisPermissionRequest>,
): boolean {
  return (
    left.id === right.id &&
    left.title === right.title &&
    left.description === right.description &&
    left.risk === right.risk &&
    left.action === right.action &&
    left.planId === right.planId &&
    JSON.stringify(left.targets ?? []) === JSON.stringify(right.targets ?? []) &&
    JSON.stringify(left.harness ?? null) === JSON.stringify(right.harness ?? null)
  );
}

export interface PermissionRequestCardProps {
  part: PermissionPart;
  messageId?: MessageId;
  chatId?: string;
}

export function PermissionRequestCard({ part, messageId, chatId }: PermissionRequestCardProps) {
  const { request } = part;
  const [editOpen, setEditOpen] = useState(false);
  const [instruction, setInstruction] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busyRef = useRef(false);

  const readPendingAuthority = async () => {
    if (!messageId) throw new Error('Permission request is no longer available.');
    const message = await messageRepo.getById(messageId);
    if (!message || (chatId && String(message.chat_id) !== chatId)) {
      throw new Error('Permission request is no longer available.');
    }
    const persisted = message.parts.find(
      (messagePart): messagePart is PermissionPart =>
        messagePart.kind === 'permission_request' && messagePart.request.id === request.id,
    );
    if (
      !persisted ||
      persisted.request.status !== 'pending' ||
      !sameImmutableRequest(persisted.request, request)
    ) {
      throw new Error('Permission request changed or is no longer pending.');
    }
    return { message, persisted };
  };

  const writeStatus = async (status: JarvisPermissionStatus, nextInstruction?: string) => {
    const { message } = await readPendingAuthority();
    await messageRepo.update(message.id, {
      parts: message.parts.map((messagePart) =>
        messagePart.kind === 'permission_request' && messagePart.request.id === request.id
          ? {
              kind: 'permission_request',
              request: {
                ...messagePart.request,
                status,
                instruction: nextInstruction ?? messagePart.request.instruction,
              },
            }
          : messagePart,
      ),
    });
  };

  const sendPermissionContext = (status: JarvisPermissionStatus, nextInstruction?: string) => {
    if (!chatId) return;
    window.dispatchEvent(
      new CustomEvent('jarvis:send', {
        detail: {
          chatId,
          text: nextInstruction
            ? `Permission response for ${request.title}: ${nextInstruction}`
            : `Permission response for ${request.title}: ${status}`,
          interactionMode: 'agent',
          structuredContext: {
            kind: 'permission_response',
            sourceMessageId: messageId,
            payload: {
              request,
              status,
              instruction: nextInstruction,
            },
          },
        },
      }),
    );
  };

  const approve = async (status: JarvisPermissionStatus) => {
    if (busyRef.current || request.status !== 'pending') return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      await readPendingAuthority();
      if (request.harness) {
        const response = status === 'approved_plan' ? 'always' : 'once';
        const revoke = request.harness.approvalId.startsWith('codex-approval-') ? undefined : grantToolGatewayMutation(
          request.harness.sessionId,
          request.harness.capability,
          response,
        );
        try {
          await respondToPersistentOpenCodeApproval({
            sessionId: request.harness.sessionId,
            approvalId: request.harness.approvalId,
            response,
            route: request.harness,
          });
        } catch (error) {
          revoke?.();
          throw error;
        }
        recordOpenCodeApprovalStatus(request.harness.sessionId, request.harness.approvalId, status);
        await writeStatus(status);
        return;
      }
      await writeStatus(status);
      if (status === 'approved_plan' && chatId) {
        useJarvisInteractionStore.getState().setPlanSafeApproval(chatId, true);
      }
      sendPermissionContext(status);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Permission could not be saved. Please retry.');
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const reject = async (status: 'denied' | 'cancelled') => {
    if (busyRef.current || request.status !== 'pending') return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      await readPendingAuthority();
      if (request.harness) {
        await respondToPersistentOpenCodeApproval({
          sessionId: request.harness.sessionId,
          approvalId: request.harness.approvalId,
          response: 'reject',
          route: request.harness,
        });
        recordOpenCodeApprovalStatus(request.harness.sessionId, request.harness.approvalId, status);
      }
      await writeStatus(status);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Permission could not be denied. Please retry.',
      );
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const edit = async () => {
    if (busyRef.current || request.status !== 'pending' || !instruction.trim()) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      const narrowed = instruction.trim();
      await readPendingAuthority();
      if (request.harness) {
        await respondToPersistentOpenCodeApproval({
          sessionId: request.harness.sessionId,
          approvalId: request.harness.approvalId,
          response: 'reject',
          route: request.harness,
        });
        recordOpenCodeApprovalStatus(
          request.harness.sessionId,
          request.harness.approvalId,
          'edited',
        );
      }
      await writeStatus('edited', narrowed);
      sendPermissionContext('edited', narrowed);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Permission could not be edited. Please retry.',
      );
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  return (
    <section
      data-testid="permission-request"
      data-approval-id={request.harness?.approvalId ?? request.id}
      data-approval-status={request.status}
      className="rounded-xl border border-destructive/35 bg-destructive/5 p-3 shadow-[0_0_20px_-16px_hsl(var(--destructive))]"
    >
      <div className="mb-2 flex items-start gap-2">
        <div className="rounded-full border border-destructive/40 bg-destructive/10 p-1">
          <ShieldAlert className="h-3.5 w-3.5 text-destructive" />
        </div>
        <div>
          <div className="text-ui-strong text-foreground">{request.title}</div>
          <p className="text-secondary text-muted-foreground">{request.description}</p>
        </div>
      </div>
      <div className="mb-2 flex flex-wrap gap-1.5 text-metadata">
        <span className="rounded-full border border-border bg-background px-2 py-0.5">
          Risk: {request.risk}
        </span>
        <span className="rounded-full border border-border bg-background px-2 py-0.5">
          Action: {request.action}
        </span>
        {request.targets?.map((target) => (
          <span
            key={target}
            className="rounded-full border border-border bg-background px-2 py-0.5"
          >
            {target}
          </span>
        ))}
      </div>
      {request.status !== 'pending' && (
        <p className="mb-2 text-secondary text-muted-foreground">
          Permission status: {request.status}
        </p>
      )}
      {error && (
        <p role="alert" className="mb-2 text-secondary text-destructive">
          {error}
        </p>
      )}
      {editOpen && (
        <div className="mb-3 flex flex-col gap-2">
          <textarea
            className="min-h-16 w-full resize-y rounded-md border border-border bg-background px-2 py-1.5 text-secondary text-foreground outline-none focus:border-destructive/60"
            placeholder="Add instruction or narrow the request"
            value={instruction}
            onChange={(event) => setInstruction(event.target.value)}
          />
          <Button
            type="button"
            size="sm"
            variant="accent"
            disabled={busy || !instruction.trim()}
            onClick={edit}
          >
            Send instruction
          </Button>
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          size="sm"
          variant="accent"
          disabled={busy || request.status !== 'pending'}
          onClick={() => void approve('approved')}
        >
          Approve once
        </Button>
        <Button
          type="button"
          size="sm"
          variant="secondary"
          disabled={busy || request.status !== 'pending'}
          onClick={() => void approve('approved_plan')}
        >
          Approve all safe changes
        </Button>
        <Button
          type="button"
          size="sm"
          variant="secondary"
          disabled={busy || request.status !== 'pending'}
          onClick={() => setEditOpen((open) => !open)}
        >
          Edit request
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={busy || request.status !== 'pending'}
          onClick={() => void reject('denied')}
        >
          Deny
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={busy || request.status !== 'pending'}
          onClick={() => void reject('cancelled')}
        >
          Cancel
        </Button>
      </div>
    </section>
  );
}
