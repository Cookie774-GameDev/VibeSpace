import type { ToolDef } from '@/lib/mcp/registry';
import { DEFAULT_CHAT_RUNTIME_SETTINGS } from '@/features/chat/runtime/chatRuntimeCommandController';
import type { PerformanceProfile } from '@/features/chat/runtime/performanceProfile';
import type { ProductionRlmContextResult } from './contextRlmProduction';

export interface RlmOpenCodeToolInput {
  question: string;
  projectId?: string;
  performance?: PerformanceProfile;
}

export interface RlmOpenCodeToolScope {
  accountId: string;
  projectId: string;
}

export interface RlmOpenCodeToolDependencies {
  resolveScope(): Promise<RlmOpenCodeToolScope>;
  query(input: {
    accountId: string;
    projectId: string;
    question: string;
    performance: PerformanceProfile;
  }): Promise<Readonly<ProductionRlmContextResult>>;
}

const DEFAULT_DEPENDENCIES: RlmOpenCodeToolDependencies = Object.freeze({
  async resolveScope() {
    const [{ useAuthStore }, { resolveAccountIdentity }] = await Promise.all([
      import('@/stores/auth'),
      import('@/lib/accountIdentity'),
    ]);
    const auth = useAuthStore.getState();
    const identity = resolveAccountIdentity(auth);
    const projectId = auth.projectId?.trim();
    if (!identity?.accountId || !projectId) {
      throw new Error('No active account-scoped project is available for Context/RLM.');
    }
    return { accountId: identity.accountId, projectId };
  },
  async query(input: Parameters<RlmOpenCodeToolDependencies['query']>[0]) {
    const { prepareProductionRlmContext } = await import('./contextRlmProduction');
    return prepareProductionRlmContext({
      accountId: input.accountId,
      projectId: input.projectId,
      question: input.question,
      settings: {
        ...DEFAULT_CHAT_RUNTIME_SETTINGS,
        performance: input.performance,
        rlmEnabled: true,
      },
    });
  },
});

function validPerformance(value: unknown): value is PerformanceProfile {
  return value === 'responsive' || value === 'balanced' || value === 'quality';
}

/**
 * High-level, project-scoped context tool exposed through VibeSpace's MCP/tool
 * registry. The current authenticated scope is authoritative; model-provided
 * account or cross-project identifiers are never accepted.
 */
export function createRlmOpenCodeTool(
  dependencies: Readonly<RlmOpenCodeToolDependencies> = DEFAULT_DEPENDENCIES,
): ToolDef<RlmOpenCodeToolInput, Readonly<ProductionRlmContextResult>> {
  return Object.freeze({
    name: 'vibespace_context.query',
    description:
      'Retrieve bounded, pointer-validated project evidence through VibeSpace Context/RLM.',
    scope: 'project',
    tags: ['context', 'rlm', 'opencode'],
    inputSchema: {
      type: 'object',
      properties: {
        question: { type: 'string', minLength: 1, maxLength: 4096 },
        projectId: { type: 'string' },
        performance: {
          type: 'string',
          enum: ['responsive', 'balanced', 'quality'],
        },
      },
      required: ['question'],
      additionalProperties: false,
    },
    async invoke(input: RlmOpenCodeToolInput) {
      const question = input?.question?.trim();
      if (!question || question.length > 4_096 || /[\u0000-\u001f\u007f]/u.test(question)) {
        throw new Error('question must be safe, non-empty text of at most 4096 characters');
      }
      const scope = await dependencies.resolveScope();
      if (input.projectId?.trim() && input.projectId.trim() !== scope.projectId) {
        throw new Error('Requested project does not match the active authenticated project scope.');
      }
      const performance = validPerformance(input.performance) ? input.performance : 'quality';
      return dependencies.query({
        accountId: scope.accountId,
        projectId: scope.projectId,
        question,
        performance,
      });
    },
  });
}
