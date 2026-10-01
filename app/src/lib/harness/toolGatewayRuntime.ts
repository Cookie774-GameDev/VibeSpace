import {
  boundToolGatewayResponse,
  type ToolGatewayRequest,
  type ToolGatewayResponse,
  type ToolGatewayTool,
  MUTATING_TOOL_GATEWAY_TOOLS,
} from './toolGatewayProtocol';

export interface ToolGatewayExecutionContext {
  requestId: string;
  sessionId: string;
  messageId: string;
  directory?: string;
  worktree?: string;
  mutationApproved: boolean;
}

type SemanticMethod = (
  args: Record<string, unknown>,
  context: ToolGatewayExecutionContext,
) => unknown | Promise<unknown>;

export interface ToolGatewayDependencies {
  authorizeRequest(request: ToolGatewayRequest): boolean | Promise<boolean>;
  authorizeMutation(request: ToolGatewayRequest): boolean | Promise<boolean>;
  terminal: {
    list: SemanticMethod;
    open: SemanticMethod;
    focus: SemanticMethod;
    spawn: SemanticMethod;
    write: SemanticMethod;
    read: SemanticMethod;
    schedule: SemanticMethod;
  };
  command: { list: SemanticMethod; run: SemanticMethod };
  profile: { readAllAboutMe: SemanticMethod; updateAllAboutMe: SemanticMethod };
  learning: { read: SemanticMethod; update: SemanticMethod };
  context: {
    list: SemanticMethod;
    read: SemanticMethod;
    attach: SemanticMethod;
    rlm: SemanticMethod;
  };
  skills: { list: SemanticMethod; load: SemanticMethod };
  plugins: { list: SemanticMethod; run: SemanticMethod };
  tasks: { create: SemanticMethod; update: SemanticMethod };
  schedule: { create: SemanticMethod };
  app: { navigate: SemanticMethod; getState: SemanticMethod };
}

function executionContext(
  request: ToolGatewayRequest,
  mutationApproved: boolean,
): ToolGatewayExecutionContext {
  return {
    requestId: request.requestId,
    sessionId: request.sessionId,
    messageId: request.messageId,
    ...(request.directory ? { directory: request.directory } : {}),
    ...(request.worktree ? { worktree: request.worktree } : {}),
    mutationApproved,
  };
}

export function createToolGatewayRuntime(deps: ToolGatewayDependencies): {
  execute(request: ToolGatewayRequest): Promise<ToolGatewayResponse>;
} {
  const handlers: Record<ToolGatewayTool, SemanticMethod> = {
    'terminal.list': deps.terminal.list,
    'terminal.open': deps.terminal.open,
    'terminal.focus': deps.terminal.focus,
    'terminal.spawn': deps.terminal.spawn,
    'terminal.write': deps.terminal.write,
    'terminal.read': deps.terminal.read,
    'terminal.schedule': deps.terminal.schedule,
    'command.list': deps.command.list,
    'command.run': deps.command.run,
    'profile.allAboutMe.read': deps.profile.readAllAboutMe,
    'profile.allAboutMe.update': deps.profile.updateAllAboutMe,
    'memory.learning.read': deps.learning.read,
    'memory.learning.update': deps.learning.update,
    'context.list': deps.context.list,
    'context.read': deps.context.read,
    'context.attach': deps.context.attach,
    vibespace_context: deps.context.rlm,
    'skills.list': deps.skills.list,
    'skills.load': deps.skills.load,
    'plugins.list': deps.plugins.list,
    'plugins.run': deps.plugins.run,
    'tasks.create': deps.tasks.create,
    'tasks.update': deps.tasks.update,
    'schedule.create': deps.schedule.create,
    'app.navigate': deps.app.navigate,
    'app.getState': deps.app.getState,
  };

  return {
    async execute(request) {
      const mutation = MUTATING_TOOL_GATEWAY_TOOLS.has(request.tool);
      try {
        if (!(await deps.authorizeRequest(request))) {
          return {
            requestId: request.requestId,
            ok: false,
            code: 'authority_revoked',
            message: 'The VibeSpace account or workspace authority changed.',
          };
        }
        if (mutation && !(await deps.authorizeMutation(request))) {
          return {
            requestId: request.requestId,
            ok: false,
            code: 'permission_denied',
            message: 'VibeSpace did not approve this semantic mutation.',
          };
        }
        const data = await handlers[request.tool](
          request.args,
          executionContext(request, mutation),
        );
        return boundToolGatewayResponse({
          requestId: request.requestId,
          ok: true,
          code: 'ok',
          message: 'The semantic tool completed.',
          ...(data === undefined ? {} : { data }),
        });
      } catch {
        return {
          requestId: request.requestId,
          ok: false,
          code: 'tool_failed',
          message: 'The semantic tool could not be completed.',
        };
      }
    },
  };
}
