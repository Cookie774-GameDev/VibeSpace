import { describe, expect, it } from 'vitest';
import { buildEffectivePermissionProfile } from '../OpenCodePermissionProfile';

const modes = ['ask', 'plan', 'agent'] as const;
const levels = ['read-only', 'write', 'full'] as const;

describe('buildEffectivePermissionProfile', () => {
  it('defines all nine mode/access combinations without widening the root', () => {
    for (const mode of modes) {
      for (const access of levels) {
        const profile = buildEffectivePermissionProfile({
          mode,
          access,
          approveAllForRun: true,
          projectRoot: 'C:\\work\\project',
        });
        expect(profile.gateway.projectRoot).toBe('C:/work/project');
        expect(profile.openCode.read['C:/work/project/**']).toBe('allow');
        expect(profile.openCode.external_directory).toBe('deny');
        expect(profile.gateway.hardDenyExternalDirectory).toBe(true);
      }
    }
  });

  it('keeps Ask + Read Only non-mutating', () => {
    const profile = buildEffectivePermissionProfile({
      mode: 'ask', access: 'read-only', approveAllForRun: false, projectRoot: '/project',
    });
    expect(profile.gateway.mutationAuthority).toBe('none');
    expect(profile.openCode.edit['/project/**']).toBe('deny');
    expect(profile.openCode.bash).toBe('deny');
  });

  it('models Ask writes as exact-request authority even when Approve All is active', () => {
    const profile = buildEffectivePermissionProfile({
      mode: 'ask', access: 'full', approveAllForRun: true, projectRoot: '/project',
    });
    expect(profile.gateway.mutationAuthority).toBe('exact-request');
    expect(profile.gateway.terminalAuthority).toBe('exact-request');
    expect(profile.gateway.autoApproveExactRequestedActions).toBe(true);
    expect(profile.openCode.edit['/project/**']).toBe('ask');
    expect(profile.openCode.bash).toBe('ask');
    expect(profile.gateway.allowDelete).toBe(false);
  });

  it('limits Plan writes to plan artifacts and inspection-only terminal authority', () => {
    const profile = buildEffectivePermissionProfile({
      mode: 'plan', access: 'full', approveAllForRun: true, projectRoot: '/project',
    });
    expect(profile.gateway.mutationAuthority).toBe('plan-artifacts');
    expect(profile.gateway.terminalAuthority).toBe('inspection-only');
    expect(profile.openCode.edit['/project/**']).toBe('ask');
    expect(profile.openCode.bash).toBe('ask');
    expect(profile.gateway.planArtifactGlobs).toContain('/project/docs/plans/**');
    expect(profile.gateway.allowDelete).toBe(false);
  });

  it('allows scoped Agent + Full operations without repeated asks when Approve All is on', () => {
    const profile = buildEffectivePermissionProfile({
      mode: 'agent', access: 'full', approveAllForRun: true, projectRoot: 'C:\\work\\project',
    });
    expect(profile.openCode.edit['C:/work/project/**']).toBe('allow');
    expect(profile.openCode.bash).toBe('allow');
    expect(profile.openCode.task).toBe('allow');
    expect(profile.gateway.mutationAuthority).toBe('autonomous');
    expect(profile.gateway.autoApproveAutonomousActions).toBe(true);
    expect(profile.gateway.allowDelete).toBe(true);
  });

  it('preserves nested secret and external-directory denies in every mode', () => {
    const profile = buildEffectivePermissionProfile({
      mode: 'agent', access: 'full', approveAllForRun: true, projectRoot: '/project',
    });
    expect(profile.openCode.read['**/.env']).toBe('deny');
    expect(profile.openCode.read['**/.env.*']).toBe('deny');
    expect(profile.openCode.read['**/.ssh/**']).toBe('deny');
    expect(profile.openCode.read['**/*.key']).toBe('deny');
    expect(profile.openCode.external_directory).toBe('deny');
    expect(profile.openCode.doom_loop).toBe('deny');
  });
});
