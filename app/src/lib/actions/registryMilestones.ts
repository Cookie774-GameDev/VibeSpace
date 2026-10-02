import { Flag } from 'lucide-react';
import { useAuthStore } from '@/stores/auth';
import { getActiveAccountIdentity } from '@/lib/accountIdentity';
import { chatRepo } from '@/lib/db/repositories';
import { useMilestonesStore } from '@/features/inspector/milestonesStore';
import type { ActionDef, ActionRunContext } from '@/lib/actions/types';
import { assertActionRequestLive, throwIfActionRequestCancelled } from '@/lib/actions/types';

export type MilestoneActionScope = Readonly<{
  accountId: string;
  workspaceId: string;
  projectId: string;
  requestId: string;
}>;

type StoredMilestone = {
  id: string;
  title: string;
  description?: string;
  deadlineAt?: number;
  scope?: MilestoneActionScope;
};
export type MilestoneActionDependencies = {
  resolveScope(context: ActionRunContext): Promise<MilestoneActionScope | null>;
  isScopeCurrent(scope: MilestoneActionScope): boolean;
  list(): readonly StoredMilestone[];
  create(
    title: string,
    description: string | undefined,
    deadlineAt: number | undefined,
    scope: MilestoneActionScope,
  ): string;
};

export function validateMilestoneCreateParameters(
  input: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  if (Object.keys(input).some((key) => !['title', 'description', 'deadlineAt'].includes(key)))
    throw new Error('Unknown milestone parameter.');
  const title = typeof input.title === 'string' ? input.title.trim() : '';
  if (!title || title.length > 240 || /[\u0000-\u001f\u007f]/u.test(title))
    throw new Error('Milestone title must contain 1–240 printable characters.');
  const output: Record<string, unknown> = { title };
  if (input.description !== undefined) {
    if (
      typeof input.description !== 'string' ||
      input.description.length > 4000 ||
      /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(input.description)
    )
      throw new Error('Milestone description is invalid.');
    output.description = input.description.trim();
  }
  if (input.deadlineAt !== undefined) {
    if (
      typeof input.deadlineAt !== 'number' ||
      !Number.isSafeInteger(input.deadlineAt) ||
      input.deadlineAt <= 0 ||
      input.deadlineAt > 8.64e15
    )
      throw new Error('Milestone deadline must be a valid Unix millisecond timestamp.');
    output.deadlineAt = input.deadlineAt;
  }
  return Object.freeze(output);
}

const production: MilestoneActionDependencies = {
  async resolveScope(context) {
    const auth = useAuthStore.getState();
    const accountId = getActiveAccountIdentity()?.accountId;
    if (
      !accountId ||
      !auth.workspaceId ||
      !auth.projectId ||
      context.source !== 'ai' ||
      context.accountId !== accountId ||
      !context.chatId ||
      !context.requestId
    )
      return null;
    const scope = {
      accountId,
      workspaceId: String(auth.workspaceId),
      projectId: String(auth.projectId),
      requestId: context.requestId,
    };
    const chat = await chatRepo.getById(context.chatId as never);
    if (
      !chat ||
      String(chat.workspace_id) !== scope.workspaceId ||
      String(chat.project_id ?? '') !== scope.projectId ||
      !production.isScopeCurrent(scope)
    )
      return null;
    return scope;
  },
  isScopeCurrent(scope) {
    const auth = useAuthStore.getState();
    return (
      getActiveAccountIdentity()?.accountId === scope.accountId &&
      String(auth.workspaceId ?? '') === scope.workspaceId &&
      String(auth.projectId ?? '') === scope.projectId
    );
  },
  list: () => useMilestonesStore.getState().items,
  create: (title, description, deadlineAt, scope) =>
    useMilestonesStore.getState().addMilestone(title, 'milestone', description, deadlineAt, scope),
};

export function createMilestoneActions(
  dependencies: MilestoneActionDependencies = production,
): ActionDef[] {
  return [
    {
      id: 'milestone.create',
      category: 'custom',
      label: 'Create milestone',
      description:
        'Create one persistent milestone in the active project with optional description and deadline. Requires owner approval.',
      icon: Flag,
      destructive: true,
      params: [
        { key: 'title', label: 'Milestone title', type: 'string', required: true },
        { key: 'description', label: 'Description', type: 'string' },
        {
          key: 'deadlineAt',
          label: 'Deadline',
          type: 'number',
          help: 'Unix milliseconds. Omit when no deadline exists.',
        },
      ],
      async run(params, context) {
        let validated: Readonly<Record<string, unknown>>;
        try {
          validated = validateMilestoneCreateParameters(params);
        } catch (error) {
          return {
            ok: false,
            error: error instanceof Error ? error.message : 'Invalid milestone.',
          };
        }
        await assertActionRequestLive(context);
        const scope = await dependencies.resolveScope(context);
        if (!scope)
          return {
            ok: false,
            error:
              'Milestone creation requires a current account, project, and approved chat request.',
          };
        await assertActionRequestLive(context);
        throwIfActionRequestCancelled(context);
        if (!dependencies.isScopeCurrent(scope))
          return { ok: false, error: 'The account or project changed before milestone creation.' };
        const previous = dependencies
          .list()
          .find(
            (item) =>
              item.scope?.accountId === scope.accountId &&
              item.scope.workspaceId === scope.workspaceId &&
              item.scope.projectId === scope.projectId &&
              item.scope.requestId === scope.requestId,
          );
        const description =
          typeof validated.description === 'string'
            ? validated.description || undefined
            : undefined;
        const deadlineAt =
          typeof validated.deadlineAt === 'number' ? validated.deadlineAt : undefined;
        if (
          previous &&
          (previous.title !== validated.title ||
            previous.description !== description ||
            previous.deadlineAt !== deadlineAt)
        )
          return {
            ok: false,
            error: 'This milestone request already completed with different parameters.',
          };
        const milestoneId =
          previous?.id ??
          dependencies.create(String(validated.title), description, deadlineAt, scope);
        return {
          ok: true,
          summary: `Milestone ${previous ? 'already saved' : 'created'}: ${validated.title}`,
          data: { milestoneId, ...scope },
        };
      },
    },
  ];
}
