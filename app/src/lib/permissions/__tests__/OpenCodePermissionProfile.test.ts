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
        expect(profile.openCode.external_directory).toBe('ask');
        expect(profile.gateway.hardDenyExternalDirectory).toBe(true);
      }
    }
  });

  it('allows the non-mutating native skill loader without widening gateway authority', () => {
    for (const mode of modes) {
      for (const access of levels) {
        const profile = buildEffectivePermissionProfile({
          mode,
          access,
          approveAllForRun: false,
          projectRoot: '/project',
        });
        expect(profile.openCode.skill).toBe('allow');
        expect(profile.gateway.hardDenySecrets).toBe(true);
        expect(profile.gateway.hardDenyProductionMutation).toBe(true);
        if (mode !== 'agent') {
          expect(profile.gateway.mutationAuthority).toBe('none');
          expect(profile.openCode.edit['/project/**']).toBe('deny');
        }
      }
    }
  });

  it('keeps Ask + Read Only non-mutating', () => {
    const profile = buildEffectivePermissionProfile({
      mode: 'ask',
      access: 'read-only',
      approveAllForRun: false,
      projectRoot: '/project',
    });
    expect(profile.gateway.mutationAuthority).toBe('none');
    expect(profile.openCode.edit['/project/**']).toBe('deny');
    expect(profile.openCode.bash).toMatchObject({
      '*': 'deny',
      pwd: 'allow',
      ls: 'allow',
      'git status': 'allow',
      'git diff': 'allow',
      'git log': 'allow',
    });
  });

  it('keeps Ask non-mutating even when access and Approve All are set', () => {
    const profile = buildEffectivePermissionProfile({
      mode: 'ask',
      access: 'full',
      approveAllForRun: true,
      projectRoot: '/project',
    });
    expect(profile.gateway.mutationAuthority).toBe('none');
    expect(profile.gateway.terminalAuthority).toBe('none');
    expect(profile.gateway.autoApproveExactRequestedActions).toBe(false);
    expect(profile.openCode.edit['/project/**']).toBe('deny');
    expect(profile.openCode.bash).toMatchObject({ '*': 'deny', pwd: 'allow' });
    expect(profile.openCodeAgent).toBe('vibespace-readonly');
    expect(profile.gateway.allowDelete).toBe(false);
  });

  it('keeps Plan non-mutating and binds the read-only OpenCode agent', () => {
    const profile = buildEffectivePermissionProfile({
      mode: 'plan',
      access: 'full',
      approveAllForRun: true,
      projectRoot: '/project',
    });
    expect(profile.gateway.mutationAuthority).toBe('none');
    expect(profile.gateway.terminalAuthority).toBe('none');
    expect(profile.openCode.edit['/project/**']).toBe('deny');
    expect(profile.openCode.bash).toMatchObject({ '*': 'deny', pwd: 'allow' });
    expect(profile.openCodeAgent).toBe('vibespace-readonly');
    expect(profile.gateway.planArtifactGlobs).toContain('/project/docs/plans/**');
    expect(profile.gateway.allowDelete).toBe(false);
  });

  it.each([
    ['read-only', false, 'vibespace-readonly'],
    ['write', false, 'vibespace-write'],
    ['write', true, 'vibespace-write-auto'],
    ['full', false, 'vibespace-full'],
    ['full', true, 'vibespace-full-auto'],
  ] as const)('binds Agent + %s + approveAll=%s to %s', (access, approveAllForRun, expected) => {
    const profile = buildEffectivePermissionProfile({
      mode: 'agent',
      access,
      approveAllForRun,
      projectRoot: '/project',
    });
    expect(profile.openCodeAgent).toBe(expected);
  });

  it('allows scoped Agent + Full operations without repeated asks when Approve All is on', () => {
    const profile = buildEffectivePermissionProfile({
      mode: 'agent',
      access: 'full',
      approveAllForRun: true,
      projectRoot: 'C:\\work\\project',
    });
    expect(profile.openCode.edit['C:/work/project/**']).toBe('allow');
    expect(profile.openCode.bash).toBe('allow');
    expect(profile.openCode.task).toBe('allow');
    expect(profile.gateway.mutationAuthority).toBe('autonomous');
    expect(profile.gateway.autoApproveAutonomousActions).toBe(true);
    expect(profile.gateway.allowDelete).toBe(true);
  });

  it('uses native full access only for the persistent full profile', () => {
    const full = buildEffectivePermissionProfile({
      mode: 'agent',
      access: 'full',
      approveAllForRun: false,
      agentApprovalMode: 'full',
      projectRoot: '/project',
    });
    expect(full.openCodeAgent).toBe('vibespace-full-auto');
    expect(full.openCode.read['*']).toBe('allow');
    expect(full.openCode.read['**/.env']).toBe('deny');
    expect(full.openCode.edit['*']).toBe('allow');
    expect(full.openCode.edit['/project/**']).toBe('allow');
    expect(full.openCode.bash).toBe('allow');
    expect(full.openCode.external_directory).toBe('allow');
    expect(full.gateway.approveAllForRun).toBe(true);
    expect(full.gateway.autoApproveAutonomousActions).toBe(true);
    expect(full.gateway.hardDenyExternalDirectory).toBe(true);
    expect(full.gateway.hardDenyPrivilegeElevation).toBe(true);
    expect(full.gateway.hardDenyProductionMutation).toBe(true);

    const review = buildEffectivePermissionProfile({
      mode: 'agent',
      access: 'full',
      // A stale legacy bit must not turn review into native blanket access.
      approveAllForRun: true,
      agentApprovalMode: 'review',
      projectRoot: '/project',
    });
    expect(review.openCodeAgent).toBe('vibespace-full');
    expect(review.openCode.read['*']).toBe('deny');
    expect(review.openCode.edit['*']).toBe('deny');
    expect(review.openCode.edit['/project/**']).toBe('allow');
    expect(review.openCode.bash).toMatchObject({
      '*': 'ask',
      pwd: 'allow',
      'git status': 'allow',
      'rm *': 'ask',
      'Remove-Item *': 'ask',
      'git clean *': 'ask',
      'git reset *': 'ask',
      'git push *': 'ask',
      'sudo *': 'ask',
    });
    expect(review.openCode.bash).not.toHaveProperty('npm test');
    expect(review.openCode.external_directory).toBe('ask');
    expect(review.openCode.doom_loop).toBe('ask');
    expect(review.gateway.approveAllForRun).toBe(false);
    expect(review.gateway.autoApproveAutonomousActions).toBe(false);
  });

  it('allows project edits but keeps native shell disabled for Agent + Write Review', () => {
    const review = buildEffectivePermissionProfile({
      mode: 'agent',
      access: 'write',
      approveAllForRun: true,
      agentApprovalMode: 'review',
      projectRoot: '/project',
    });
    expect(review.openCodeAgent).toBe('vibespace-write');
    expect(review.openCode.edit['*']).toBe('deny');
    expect(review.openCode.edit['/project/**']).toBe('allow');
    expect(review.openCode.bash).toMatchObject({ '*': 'deny', pwd: 'allow' });
    expect(review.openCode.external_directory).toBe('ask');
    expect(review.openCode.doom_loop).toBe('ask');
  });

  it('preserves nested secret and external-directory denies in every mode', () => {
    const profile = buildEffectivePermissionProfile({
      mode: 'agent',
      access: 'full',
      approveAllForRun: true,
      projectRoot: '/project',
    });
    expect(profile.openCode.read['**/.env']).toBe('deny');
    expect(profile.openCode.read['**/.env.*']).toBe('deny');
    expect(profile.openCode.read['**/.ssh/**']).toBe('deny');
    expect(profile.openCode.read['**/*.key']).toBe('deny');
    expect(profile.openCode.external_directory).toBe('ask');
    expect(profile.openCode.doom_loop).toBe('deny');
  });
});
