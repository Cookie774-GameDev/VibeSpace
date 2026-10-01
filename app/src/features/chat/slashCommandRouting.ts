export type CommandOwner =
  | 'vibespace-ui'
  | 'vibespace-context'
  | 'vibespace-tool'
  | 'opencode-agent';

export type CommandExecution =
  | 'local'
  | 'reference'
  | 'attachment'
  | 'agent-request'
  | 'structured-agent-request';

export const SLASH_COMMAND_ALIASES = {
  terminal: 'terminals',
  contextmap: 'context',
  contexts: 'context',
  multitaksk: 'multitask',
  multiatask: 'multitask',
  mulititask: 'multitask',
  multitaks: 'multitask',
  subagent: 'subagents',
  suabagent: 'subagents',
  subagnts: 'subagents',
  subagens: 'subagents',
  clearfile: 'clearfiles',
  'clear-files': 'clearfiles',
  cearfile: 'clearfiles',
  cearfiles: 'clearfiles',
  permission: 'permissions',
  perms: 'permissions',
  'approve-all': 'approveall',
  themes: 'theme',
} as const;

const ROUTES = {
  permissions: { owner: 'vibespace-ui', execution: 'local' },
  ask: { owner: 'opencode-agent', execution: 'agent-request' },
  plan: { owner: 'opencode-agent', execution: 'agent-request' },
  agent: { owner: 'vibespace-ui', execution: 'local' },
  multitask: { owner: 'opencode-agent', execution: 'agent-request' },
  subagents: { owner: 'opencode-agent', execution: 'agent-request' },
  terminals: { owner: 'vibespace-context', execution: 'reference' },
  context: { owner: 'vibespace-context', execution: 'attachment' },
  plug: { owner: 'vibespace-tool', execution: 'attachment' },
  skills: { owner: 'vibespace-context', execution: 'attachment' },
  allaboutme: { owner: 'vibespace-context', execution: 'attachment' },
  hive: { owner: 'opencode-agent', execution: 'agent-request' },
  file: { owner: 'vibespace-context', execution: 'attachment' },
  md: { owner: 'opencode-agent', execution: 'structured-agent-request' },
  model: { owner: 'vibespace-ui', execution: 'local' },
  effort: { owner: 'vibespace-ui', execution: 'local' },
  fast: { owner: 'vibespace-ui', execution: 'local' },
  performance: { owner: 'vibespace-ui', execution: 'local' },
  rlm: { owner: 'vibespace-ui', execution: 'local' },
  access: { owner: 'vibespace-ui', execution: 'local' },
  approveall: { owner: 'vibespace-ui', execution: 'local' },
  mode: { owner: 'vibespace-ui', execution: 'local' },
  attach: { owner: 'vibespace-context', execution: 'attachment' },
  clearfiles: { owner: 'vibespace-ui', execution: 'local' },
  output: { owner: 'vibespace-ui', execution: 'local' },
  kanban: { owner: 'vibespace-context', execution: 'reference' },
  canvas: { owner: 'vibespace-context', execution: 'attachment' },
  history: { owner: 'vibespace-context', execution: 'reference' },
  tools: { owner: 'vibespace-context', execution: 'reference' },
  agents: { owner: 'vibespace-context', execution: 'reference' },
  schedule: { owner: 'vibespace-tool', execution: 'reference' },
  chat: { owner: 'vibespace-ui', execution: 'local' },
  usage: { owner: 'vibespace-ui', execution: 'local' },
  theme: { owner: 'vibespace-ui', execution: 'local' },
  appearance: { owner: 'vibespace-ui', execution: 'local' },
  undo: { owner: 'vibespace-ui', execution: 'local' },
  redo: { owner: 'vibespace-ui', execution: 'local' },
  commands: { owner: 'vibespace-ui', execution: 'local' },
  help: { owner: 'vibespace-ui', execution: 'local' },
} as const satisfies Record<string, { owner: CommandOwner; execution: CommandExecution }>;

export type Section20Command = keyof typeof ROUTES;

export const SECTION_20_COMMANDS = Object.freeze(Object.keys(ROUTES) as Section20Command[]);

export interface ClassifiedSlashCommand {
  command: Section20Command;
  owner: CommandOwner;
  execution: CommandExecution;
}

export function normalizeSlashCommand(raw: string): string {
  const command = raw.trim().toLowerCase();
  return SLASH_COMMAND_ALIASES[command as keyof typeof SLASH_COMMAND_ALIASES] ?? command;
}

export function classifySlashCommand(raw: string): ClassifiedSlashCommand | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const withoutSlash = trimmed.startsWith('/') ? trimmed.slice(1) : trimmed;
  const token = withoutSlash.split(/\s+/u, 1)[0] ?? '';
  const command = normalizeSlashCommand(token);
  if (!Object.prototype.hasOwnProperty.call(ROUTES, command)) return undefined;
  const canonical = command as Section20Command;
  return { command: canonical, ...ROUTES[canonical] };
}

const REFERENCE_LABELS = {
  terminals: 'Terminal surface',
  kanban: 'Kanban',
  history: 'History',
  tools: 'Tools',
  agents: 'Agents page/editor',
  schedule: 'Schedule',
} as const;

type ReferenceCommand = keyof typeof REFERENCE_LABELS;

export function buildVibeSpaceReferenceRequest(command: ReferenceCommand, request = ''): string {
  const reference = `Context references: /${command} references ${REFERENCE_LABELS[command]}.`;
  const boundedRequest = request.replace(/\s+/gu, ' ').trim();
  return boundedRequest ? `${reference} User request: ${boundedRequest}` : reference;
}
