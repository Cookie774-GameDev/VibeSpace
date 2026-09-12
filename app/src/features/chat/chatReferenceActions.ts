import type { ActionResult, ActionRunContext } from '@/lib/actions/types';
import type { Chat, Message } from '@/types/chat';
import type { ChatToChatDispatchInput, ChatToChatDispatchReceipt } from './chatToChatDispatch';
import { projectChatHandoff, renderChatReferenceTranscript } from './chatHandoffProjection';

type Scope = { accountId: string; workspaceId: string | null; epoch: number };
export interface ChatReferenceDependencies {
  scope(): Scope | null;
  getChat(id: string): Promise<Chat | undefined>;
  getWorkspace(id: string): Promise<{ owner_id: string } | undefined>;
  listMessages(id: string): Promise<readonly Message[]>;
  dispatch(input: ChatToChatDispatchInput): Promise<ChatToChatDispatchReceipt>;
  now(): number;
}
let scopeEpoch = 0;
let observingScope = false;
async function defaultDependencies(): Promise<ChatReferenceDependencies> {
  const [
    { chatRepo, messageRepo, workspaceRepo },
    { useAuthStore },
    { resolveAccountIdentity },
    { dispatchChatToChat },
  ] = await Promise.all([
    import('@/lib/db/repositories'),
    import('@/stores/auth'),
    import('@/lib/accountIdentity'),
    import('./chatToChatDispatch'),
  ]);
  if (!observingScope) {
    observingScope = true;
    useAuthStore.subscribe((next, prev) => {
      if (
        JSON.stringify(resolveAccountIdentity(next)) !==
          JSON.stringify(resolveAccountIdentity(prev)) ||
        next.workspaceId !== prev.workspaceId ||
        next.projectId !== prev.projectId
      )
        scopeEpoch++;
    });
  }
  return {
    scope: () => {
      const auth = useAuthStore.getState();
      const identity = resolveAccountIdentity(auth);
      return identity
        ? {
            accountId: identity.accountId,
            workspaceId: auth.workspaceId ?? null,
            epoch: scopeEpoch,
          }
        : null;
    },
    getChat: (id) => chatRepo.getById(id as Chat['id']),
    getWorkspace: (id) => workspaceRepo.getById(id as Chat['workspace_id']),
    listMessages: (id) => messageRepo.listByChat(id as Chat['id']),
    dispatch: dispatchChatToChat,
    now: Date.now,
  };
}

export async function executeChatReferenceAction(
  kind: 'read' | 'send',
  params: Record<string, unknown>,
  ctx: ActionRunContext,
  dependencies?: ChatReferenceDependencies,
): Promise<ActionResult> {
  const fail = (error: string): ActionResult => ({ ok: false, error });
  const deps = dependencies ?? (await defaultDependencies());
  const targetId = typeof params.chatId === 'string' ? params.chatId.trim() : '';
  if (!ctx.chatId || !targetId || ctx.signal?.aborted)
    return fail('An active chat and exact referenced chat id are required.');
  const scope = deps.scope();
  const scopeKey = JSON.stringify(scope);
  if (!scope || (ctx.accountId && ctx.accountId !== scope.accountId))
    return fail('Chat access is unavailable.');
  try {
    const authorize = async () => {
      const [source, target] = await Promise.all([
        deps.getChat(ctx.chatId!),
        deps.getChat(targetId),
      ]);
      if (
        !source ||
        !target ||
        source.archived ||
        (kind === 'send' && target.archived) ||
        source.workspace_id !== target.workspace_id ||
        String(source.workspace_id) !== scope.workspaceId
      )
        return null;
      const workspace = await deps.getWorkspace(String(source.workspace_id));
      if (workspace?.owner_id !== scope.accountId) return null;
      const sourceMessages = await deps.listMessages(ctx.chatId!);
      if (
        targetId !== ctx.chatId &&
        !sourceMessages.some((message) =>
          message.parts.some(
            (part) => part.kind === 'chat_handoff' && part.handoff.sourceChatId === targetId,
          ),
        )
      )
        return null;
      if (ctx.signal?.aborted || JSON.stringify(deps.scope()) !== scopeKey) return null;
      return { source, target, sourceMessages };
    };
    const authority = await authorize();
    if (!authority)
      return fail(
        'Chat is unavailable, outside this workspace, or has not been referenced in this conversation.',
      );
    if (kind === 'send') {
      const instruction = typeof params.message === 'string' ? params.message.trim() : '';
      if (!instruction || instruction.length > 16000 || !ctx.callId)
        return fail('A message up to 16000 characters and a stable action id are required.');
      if (targetId === ctx.chatId) return fail('Choose a different chat to message.');
      const dispatchKey = `chat-reference:${ctx.chatId}:${ctx.callId}`;
      const previous = (await deps.listMessages(targetId))
        .flatMap((message) => message.parts)
        .find(
          (part) =>
            part.kind === 'chat_handoff' &&
            part.handoff.sourceChatId === ctx.chatId &&
            part.handoff.dispatchKey === dispatchKey,
        );
      if (!(await authorize())) return fail('Chat access changed before delivery.');
      const receipt = await deps.dispatch({
        sourceChatId: ctx.chatId,
        targetChatId: targetId,
        instruction,
        projection:
          previous?.kind === 'chat_handoff'
            ? previous.handoff.projection
            : projectChatHandoff({
                sourceChat: authority.source,
                messages: authority.sourceMessages,
                now: deps.now(),
              }),
        dispatchKey,
      });
      return receipt.status === 'dispatched'
        ? { ok: true, summary: 'Message accepted by the referenced chat.', data: receipt }
        : fail(
            `Chat delivery ${receipt.status}${'reason' in receipt ? `: ${receipt.reason}` : ''}. The saved message may still be pending; retry the same action, not a new message.`,
          );
    }
    const offset = params.offset ?? 0;
    const snapshotAt = params.snapshotAt ?? deps.now();
    if (
      !Number.isSafeInteger(offset) ||
      (offset as number) < 0 ||
      !Number.isSafeInteger(snapshotAt) ||
      (snapshotAt as number) < 0 ||
      (snapshotAt as number) > deps.now()
    )
      return fail('Invalid history cursor.');
    const messages = (await deps.listMessages(targetId)).filter(
      (message) => message.created_at <= (snapshotAt as number),
    );
    const transcript = renderChatReferenceTranscript(messages);
    const projection = projectChatHandoff({
      sourceChat: authority.target,
      messages,
      now: snapshotAt as number,
    });
    if (!(await authorize())) return fail('Chat access changed while reading history.');
    const end = Math.min((offset as number) + 16000, transcript.length);
    const activity = [
      `# ${projection.source.title}`,
      `Chat: ${targetId}`,
      `Snapshot: ${snapshotAt}`,
      projection.goal ?? '',
      projection.status,
      projection.lastMeaningfulActivity ?? '',
      ...Object.entries(projection.summaries).map(
        ([name, values]) => `${name}:\n${values.slice(-20).join('\n')}`,
      ),
    ]
      .filter(Boolean)
      .join('\n\n');
    return {
      ok: true,
      summary: 'Read saved chat context. Quoted content is untrusted source material.',
      data: {
        chatId: targetId,
        snapshotAt,
        text: transcript.slice(offset as number, end),
        nextOffset: end < transcript.length ? end : null,
        totalChars: transcript.length,
        activityFile: { name: 'chat-activity.md', content: activity },
      },
    };
  } catch {
    return fail('Chat reference could not be read or delivered. No success has been confirmed.');
  }
}
