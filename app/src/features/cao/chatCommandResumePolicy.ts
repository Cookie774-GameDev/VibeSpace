import type { AccessLevel, InteractionMode } from '@/lib/permissions/OpenCodePermissionProfile';
import type { PermissionAccessLevel } from '@/features/jarvis-interaction/permissionAccessStore';

export function caoResumePolicy(suspended: {
  modelSelectionOverride?: { mode: string; providerId?: string; modelId?: string; connectionId?: string };
  resumeAgentAuthority?: { agentId: string; revision: number };
  interactionMode?: InteractionMode; accessLevel?: AccessLevel;
}, expectedJson: string, currentMode: InteractionMode, currentAccess: PermissionAccessLevel) {
  let expected: { providerId?: string; modelId?: string; connectionId?: string; agentId?: string; agentRevision?: number };
  try { if (expectedJson.length > 4096) throw Error(); expected = JSON.parse(expectedJson); }
  catch { throw Error('cao_control_resume_authority_changed'); }
  const selected = suspended.modelSelectionOverride;
  const agent = suspended.resumeAgentAuthority;
  if (!expected || selected?.mode !== 'single' || !agent || !expected.connectionId ||
      selected.providerId !== expected.providerId || selected.modelId !== expected.modelId ||
      selected.connectionId !== expected.connectionId || agent.agentId !== expected.agentId || agent.revision !== expected.agentRevision)
    throw Error('cao_control_resume_authority_changed');
  const modes: InteractionMode[] = ['ask', 'plan', 'agent'];
  if (!modes.includes(suspended.interactionMode ?? 'ask') || !modes.includes(currentMode)) throw Error('cao_control_resume_authority_changed');
  const interactionMode = modes[Math.min(modes.indexOf(suspended.interactionMode ?? 'ask'), modes.indexOf(currentMode))]!;
  const levels: AccessLevel[] = ['read-only', 'write', 'full'];
  const access = currentAccess === 'read' ? 'read-only' : currentAccess;
  if (!levels.includes(suspended.accessLevel ?? 'read-only') || !levels.includes(access)) throw Error('cao_control_resume_authority_changed');
  const accessLevel = interactionMode !== 'agent' ? 'read-only' : levels[Math.min(levels.indexOf(suspended.accessLevel ?? 'read-only'), levels.indexOf(access))]!;
  return { interactionMode, accessLevel, approveAllForRun: false as const, autoApproveActions: false as const };
}
