import { describe, expect, it } from 'vitest';
import {
  canRunLocalCommandWithoutModel,
  LocalCommandPreModelBridge,
  requiresLocalCommandPreflight,
} from './preModelBridge';
import { routeLocalCommand } from './router';
import { adaptLocalCommand } from './vibespaceAdapter';

describe('local status.show production bridge', () => {
  it('maps the direct status request to the local authority and bypasses the model', () => {
    const route = routeLocalCommand('show router status');
    expect(route.classification).toBe('command_only');
    expect(route.commands).toHaveLength(1);
    expect(route.commands[0]).toMatchObject({ id: 'status.show', slots: {} });
    expect(adaptLocalCommand(route.commands[0]!)).toMatchObject({
      status: 'mapped',
      command: {
        kind: 'catalog',
        id: 'status.show',
        family: 'navigation',
        authority: 'router.status',
        safety: 'read',
      },
    });
    expect(requiresLocalCommandPreflight('show router status')).toBe(true);
    expect(canRunLocalCommandWithoutModel('show router status')).toBe(true);
  });

  it('executes through the pre-model bridge and records a completed local receipt', async () => {
    const interactionId = 'status-show-production-1';
    const result = await new LocalCommandPreModelBridge({ now: () => 123 }).process({
      text: 'show router status',
      interactionId,
      context: {
        correlationId: interactionId,
        accountId: 'account-1',
        workspaceId: 'workspace-1',
        projectId: 'project-1',
      },
    });

    expect(result).toMatchObject({
      modelText: '',
      commandOnly: true,
      holdModel: false,
      unsupportedCommands: [],
      unexecutedCommands: [],
    });
    expect(result.receipts).toEqual([
      expect.objectContaining({
        commandId: 'status.show',
        correlationId: interactionId,
        status: 'completed',
      }),
    ]);
  });

  it('does not turn a quoted or negated status mention into an executable request', () => {
    expect(canRunLocalCommandWithoutModel('explain the words "show router status"')).toBe(false);
    expect(canRunLocalCommandWithoutModel('do not show router status')).toBe(false);
  });
});
