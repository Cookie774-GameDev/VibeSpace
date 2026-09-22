import { INSTANT_COMMAND_CATALOG } from './catalog';
import type { CommandSafety } from './catalogTypes';

export type AuthorityInventoryEntry = Readonly<{
  id: string;
  canonicalSeam: string;
  currentState: 'ready' | 'capability-gated';
}>;

function authority(
  id: string,
  canonicalSeam: string,
  currentState: AuthorityInventoryEntry['currentState'] = 'ready',
): AuthorityInventoryEntry {
  return Object.freeze({ id, canonicalSeam, currentState });
}

export const AUTHORITY_INVENTORY: readonly AuthorityInventoryEntry[] = Object.freeze([
  authority('ui.route', 'navigation route schema and UI store'),
  authority('router.status', 'read-only local command router status snapshot'),
  authority('terminal.queue', 'terminal command queue'),
  authority('terminal.pane', 'terminal pane tree'),
  authority('terminal.snapshot', 'verified live target snapshot'),
  authority('terminal.project-move', 'terminal project move authority'),
  authority('terminal.lifecycle', 'native terminal lifecycle'),
  authority('terminal.prompt-delivery', 'verified terminal prompt delivery'),
  authority('agent.registry', 'agent registry'),
  authority('project.registry', 'project repository'),
  authority('chat.lifecycle', 'chat lifecycle'),
  authority('chat.delete', 'permanent chat deletion authority'),
  authority('schedule.repository', 'Jarvis schedule repository'),
  authority('schedule.runner', 'Jarvis schedule runner'),
  authority('schedule.timer', 'local schedule timer boundary'),
  authority('settings.allowlist', 'typed non-secret preference allowlist'),
  authority('media.player', 'shared music player store'),
  authority('media.ambient', 'ambient audio store'),
  authority('tool.registry', 'first-party and custom tool registry'),
  authority('tool.gateway', 'tool gateway approval boundary'),
  authority('skill.registry', 'skill catalog'),
  authority('plugin.registry', 'plugin connection registry'),
  authority('files.reader', 'bounded files read authority'),
  authority('context.gateway', 'Context Gateway'),
  authority('task.repository', 'task repository'),
  authority('workbench.registry', 'Workbench state authority'),
  authority(
    'terminal-peer-fabric',
    'versioned native Terminal Peer Fabric command port',
    'capability-gated',
  ),
]);

export type CommandAuthorityInventoryEntry = Readonly<{
  commandId: string;
  authorityId: string;
  canonicalSeam: string;
  safety: CommandSafety;
  requiredContext: readonly string[];
  testSeam: string;
  currentState: 'ready' | 'blocked' | 'capability-gated';
}>;

const authorityById = new Map(AUTHORITY_INVENTORY.map((entry) => [entry.id, entry]));

function requiredContext(authorityId: string): readonly string[] {
  if (authorityId === 'ui.route') return Object.freeze(['account session']);
  if (authorityId.startsWith('terminal.')) {
    return Object.freeze(['account session', 'active project', 'verified terminal snapshot']);
  }
  if (authorityId === 'terminal-peer-fabric') {
    return Object.freeze(['account session', 'active project', 'compatible native capability']);
  }
  return Object.freeze(['account session', 'workspace/project scope', 'authority capability']);
}

const plannedButUncataloged = Object.freeze([
  ['page.open', 'ui.route', 'read'],
  ['page.back', 'ui.route', 'read'],
  ['page.forward', 'ui.route', 'read'],
  ['page.home', 'ui.route', 'read'],
  ['settings.open', 'ui.route', 'read'],
  ['settings.close', 'ui.route', 'read'],
  ['settings.section.open', 'ui.route', 'read'],
  ['palette.open', 'ui.route', 'read'],
  ['launcher.open', 'ui.route', 'read'],
  ['fullscreen.set', 'settings.allowlist', 'reversible'],
  ['project.rename', 'project.registry', 'reversible'],
  ['project.list', 'project.registry', 'read'],
  ['chat.create', 'chat.lifecycle', 'reversible'],
] satisfies readonly (readonly [string, string, CommandSafety])[]);

const catalogCommandIds = new Set(INSTANT_COMMAND_CATALOG.map((command) => command.id));

function blockedPlannedEntry(
  commandId: string,
  authorityId: string,
  safety: CommandSafety,
): CommandAuthorityInventoryEntry {
  const authority = authorityById.get(authorityId);
  if (!authority) throw new Error(`Missing authority inventory for ${commandId}`);
  return Object.freeze({
    commandId,
    authorityId,
    canonicalSeam: authority.canonicalSeam,
    safety,
    requiredContext: requiredContext(authorityId),
    testSeam: `instant-command catalog and ${authorityId} authority tests`,
    currentState: 'blocked',
  });
}

export const COMMAND_AUTHORITY_INVENTORY: readonly CommandAuthorityInventoryEntry[] = Object.freeze(
  [
    ...INSTANT_COMMAND_CATALOG.map((command) => {
      const authority = authorityById.get(command.authority);
      if (!authority) throw new Error(`Missing authority inventory for ${command.id}`);
      return Object.freeze({
        commandId: command.id,
        authorityId: authority.id,
        canonicalSeam: authority.canonicalSeam,
        safety: command.safety,
        requiredContext: requiredContext(authority.id),
        testSeam: `instant-command catalog and ${authority.id} authority tests`,
        currentState:
          command.availability === 'blocked'
            ? ('blocked' as const)
            : authority.currentState === 'capability-gated' ||
                command.availability === 'capability-gated'
              ? ('capability-gated' as const)
              : ('ready' as const),
      });
    }),
    ...plannedButUncataloged
      .filter(([id]) => !catalogCommandIds.has(id))
      .map(([id, authorityId, safety]) => blockedPlannedEntry(id, authorityId, safety)),
  ],
);
