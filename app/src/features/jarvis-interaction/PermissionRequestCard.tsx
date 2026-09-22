import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { ShieldAlert } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { messageRepo } from '@/lib/db/repositories';
import { respondToPersistentOpenCodeApproval } from '@/lib/ai/adapters/opencodePersistent';
import { readOpenCodeApprovalStatus, recordOpenCodeApprovalStatus, subscribeOpenCodeApprovalStatuses } from '@/lib/harness/openCodeApprovalState';
import { grantToolGatewayMutation } from '@/lib/harness/toolGatewayProduction';
import { MUTATING_TOOL_GATEWAY_TOOLS } from '@/lib/harness/toolGatewayProtocol';
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
  const acknowledgedStatus = useSyncExternalStore(
    subscribeOpenCodeApprovalStatuses,
    () => request.harness ? readOpenCodeApprovalStatus(request.harness.sessionId, request.harness.approvalId) : undefined,
    () => undefined,
  );
  const effectiveStatus = request.status === 'pending' ? acknowledgedStatus ?? request.status : request.status;
  const [editOpen, setEditOpen] = useState(false);
  const [instruction, setInstruction] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busyRef = useRef(false);
  const persistedStatusRef = useRef<{ request: JarvisPermissionRequest; status: JarvisPermissionStatus } | undefined>(undefined);

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
    persistedStatusRef.current = { request, status };
  };

  useEffect(() => {
    if (busy || (persistedStatusRef.current?.request === request && persistedStatusRef.current.status === acknowledgedStatus) || request.status !== 'pending' || !acknowledgedStatus || acknowledgedStatus === 'pending') return;
    // Kernel permissions are standalone messages. Persist their exact native
    // acknowledgment for reloads; streaming messages remain owned by runtime.
    let disposed = false;
    void readPendingAuthority().then(async ({ message }) => {
      if (disposed || busyRef.current || message.parts.length !== 1) return;
      await writeStatus(acknowledgedStatus);
    }).catch(() => { /* Persisted authority may already have settled. */ });
    return () => { disposed = true; };
  }, [acknowledgedStatus, busy, request, messageId, chatId]);

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
    if (busyRef.current || effectiveStatus !== 'pending') return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      await readPendingAuthority();
      if (request.harness) {
        const response = status === 'approved_plan' ? 'always' : 'once';
        // Builtin OpenCode permissions are authorized by their native session.
        // Only semantic mutations need a separate live Context Gateway grant.
        const needsGatewayGrant = !request.harness.approvalId.startsWith('codex-approval-') &&
          MUTATING_TOOL_GATEWAY_TOOLS.has(request.harness.capability as never);
        const revoke = !needsGatewayGrant ? undefined : grantToolGatewayMutation(
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
    if (busyRef.current || effectiveStatus !== 'pending') return;
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
    if (busyRef.current || effectiveStatus !== 'pending' || !instruction.trim()) return;
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
      data-approval-status={effectiveStatus}
      className="w-full rounded-xl border border-border bg-elevated/70 px-3 py-2 text-xs shadow-sm"
    >
      <div className="mb-1.5 flex items-start gap-2">
        <div className="rounded-full border border-destructive/40 bg-destructive/10 p-1">
          <ShieldAlert className="h-3.5 w-3.5 text-destructive" />
        </div>
        <div>
          <div className="text-xs font-semibold text-foreground">{request.title}</div>
          <p className="text-xs leading-snug text-muted-foreground">{request.description}</p>
        </div>
      </div>
      <div className="mb-1.5 flex flex-wrap items-center gap-1 text-[10px]">
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
      {effectiveStatus !== 'pending' && (
        <p className="mb-2 text-secondary text-muted-foreground">
          Permission status: {effectiveStatus}
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
      <div className="flex flex-wrap gap-1.5 [&_button]:h-7 [&_button]:px-2 [&_button]:text-[11px]">
        <Button
          type="button"
          size="sm"
          variant="accent"
          disabled={busy || effectiveStatus !== 'pending'}
          onClick={() => void approve('approved')}
        >
          Approve once
        </Button>
        <Button
          type="button"
          size="sm"
          variant="secondary"
          disabled={busy || effectiveStatus !== 'pending'}
          onClick={() => void approve('approved_plan')}
        >
          Approve all safe changes
        </Button>
        <Button
          type="button"
          size="sm"
          variant="secondary"
          disabled={busy || effectiveStatus !== 'pending'}
          onClick={() => setEditOpen((open) => !open)}
        >
          Edit request
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={busy || effectiveStatus !== 'pending'}
          onClick={() => void reject('denied')}
        >
          Deny
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={busy || effectiveStatus !== 'pending'}
          onClick={() => void reject('cancelled')}
        >
          Cancel
        </Button>
      </div>
    </section>
  );
}
