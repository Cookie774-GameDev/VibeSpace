// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { toProviderSafeOpenCodeTools } from './OpenCodeSdkSessionClient';
import { MUTATING_TOOL_GATEWAY_TOOLS } from './toolGatewayProtocol';
import { buildEffectivePermissionProfile, type PermissionDecision } from '../permissions/OpenCodePermissionProfile';

const NATIVE_PERMISSION_TOOLS = ['edit', 'write', 'patch', 'bash', 'shell', 'task'] as const;

type PermissionRule = Readonly<{
  permission: string;
  pattern: string;
  action: PermissionDecision;
}>;

function permissionRulesFor(
  permission: string,
  value: PermissionDecision | Readonly<Record<string, PermissionDecision>>,
): PermissionRule[] {
  const entries = typeof value === 'string' ? [['*', value] as const] : Object.entries(value);
  return entries.map(([pattern, action]) => ({ permission, pattern, action }));
}

function permissionPatternMatches(rule: string, requested: string): boolean {
  if (rule === '*') return true;
  if (rule.endsWith('/**')) return requested.startsWith(rule.slice(0, -2));
  if (rule.endsWith(' *')) return requested.startsWith(rule.slice(0, -1));
  return rule === requested;
}

function effectivePermission(
  permission: string,
  requestedPattern: string,
  agentRules: readonly PermissionRule[],
  sessionRules: readonly PermissionRule[],
): PermissionDecision {
  // OpenCode merges the agent rules before session rules and picks the last
  // matching rule. This fixture models only those exact precedence cases.
  const rules: readonly PermissionRule[] = [...agentRules, ...sessionRules];
  for (let index = rules.length - 1; index >= 0; index -= 1) {
    const rule = rules[index];
    if (rule && rule.permission === permission && permissionPatternMatches(rule.pattern, requestedPattern)) {
      return rule.action;
    }
  }
  return 'ask';
}

describe('OpenCode prompt tool flags preserve native semantic approval policy', () => {
  it.each([...MUTATING_TOOL_GATEWAY_TOOLS])('does not convert available %s into an unconditional permission grant', (name) => {
    const wireName = name.replace(/[^a-zA-Z0-9_-]/gu, '_');
    const wire = toProviderSafeOpenCodeTools({ 'context.list': true, [name]: true });
    // OpenCode prompt tools:true becomes a session-level allow rule. Omitting
    // a semantic mutation preserves the selected native agent's ask/deny rule.
    expect(wire).not.toHaveProperty(wireName);
    expect(wire.context_list).toBe(true);
    expect(Object.isFrozen(wire)).toBe(true);
  });

  it.each([...MUTATING_TOOL_GATEWAY_TOOLS])('keeps an explicit disabled %s denied', (name) => {
    expect(toProviderSafeOpenCodeTools({ [name]: false }))
      .toHaveProperty(name.replace(/[^a-zA-Z0-9_-]/gu, '_'), false);
  });

  it.each(NATIVE_PERMISSION_TOOLS)('keeps an explicit disabled native %s denied', (name) => {
    expect(toProviderSafeOpenCodeTools({ [name]: false })).toHaveProperty(name, false);
  });

  it('does not let an already-normalized mutation bypass the same rule', () => {
    expect(toProviderSafeOpenCodeTools({ mcp_run: true, plugins_run: true, vibespace_context: true }))
      .toEqual({ vibespace_context: true });
  });

  it('detects conflicting semantic aliases before omitting positive flags', () => {
    expect(() => toProviderSafeOpenCodeTools({ 'mcp.run': true, mcp_run: false }))
      .toThrow(/collision/);
  });

  it('retains nonmutating discovery and disabled Context values without changing the caller map', () => {
    const input = Object.freeze({ 'mcp.list': true, 'plugins.list': true, vibespace_context: false, 'mcp.run': true });
    expect(toProviderSafeOpenCodeTools(input)).toEqual({ mcp_list: true, plugins_list: true, vibespace_context: false });
    expect(input['mcp.run']).toBe(true);
  });

  it('keeps a normal Full tool map from overriding the selected Review agent permissions', () => {
    const profile = buildEffectivePermissionProfile({
      mode: 'agent',
      access: 'full',
      approveAllForRun: false,
      agentApprovalMode: 'review',
      projectRoot: 'C:/workspace',
    }).openCode;
    const fullTools = toProviderSafeOpenCodeTools({
      read: true,
      glob: true,
      grep: true,
      list: true,
      edit: true,
      write: true,
      patch: true,
      bash: true,
      shell: true,
      task: true,
      todo: true,
      todoread: true,
      todowrite: true,
      webfetch: true,
      websearch: true,
      'context.list': true,
      'skills.load': false,
      vibespace_context: false,
    });
    const sessionRules: PermissionRule[] = Object.entries(fullTools).map(([permission, enabled]) => ({
      permission,
      pattern: '*',
      action: enabled ? 'allow' : 'deny',
    }));
    const agentRules = [
      ...permissionRulesFor('edit', profile.edit),
      ...permissionRulesFor('bash', profile.bash),
      ...permissionRulesFor('task', profile.task),
    ];

    expect(effectivePermission('edit', 'D:/outside/secret.txt', agentRules, sessionRules)).toBe('deny');
    expect(effectivePermission('edit', 'C:/workspace/src/app.ts', agentRules, sessionRules)).toBe('allow');
    expect(effectivePermission('bash', 'rm -rf data', agentRules, sessionRules)).toBe('ask');
    expect(effectivePermission('task', '*', agentRules, sessionRules)).toBe('ask');
    expect(sessionRules.some((rule) =>
      ['edit', 'write', 'patch', 'bash', 'shell', 'task'].includes(rule.permission) &&
      rule.action === 'allow',
    )).toBe(false);
    expect(fullTools).toMatchObject({
      read: true,
      glob: true,
      grep: true,
      list: true,
      webfetch: true,
      websearch: true,
      context_list: true,
      skills_load: false,
      vibespace_context: false,
    });
    expect(sessionRules.length).toBeGreaterThan(0);
  });
});
