import { describe, expect, it } from 'vitest';
import { caoResumePolicy } from './chatCommandResumePolicy';
const authority = { providerId: 'opencode', connectionId: 'opencode-cli', modelId: 'openai/model', agentId: 'jarvis', agentRevision: 1 };
const suspended = { modelSelectionOverride: { mode: 'single' as const, ...authority },
  resumeAgentAuthority: { agentId: 'jarvis', revision: 1 }, interactionMode: 'agent' as const, accessLevel: 'full' as const, approveAllForRun: true, autoApproveActions: true };
describe('CAO resume authority', () => {
  it('respects a newly restricted mode and discards historical blanket approvals', () => {
    expect(caoResumePolicy(suspended, JSON.stringify(authority), 'ask', 'read')).toEqual({ interactionMode: 'ask', accessLevel: 'read-only', approveAllForRun: false, autoApproveActions: false });
  });
  it('does not upgrade a formerly read-only turn under a later full-access setting', () => {
    expect(caoResumePolicy({ ...suspended, interactionMode: 'ask', accessLevel: 'read-only' }, JSON.stringify(authority), 'agent', 'full').accessLevel).toBe('read-only');
  });
  it('retains an authorized write ceiling without silently granting full access', () => {
    expect(caoResumePolicy(suspended, JSON.stringify(authority), 'agent', 'write').accessLevel).toBe('write');
  });
  it.each([{ modelId: 'other' }, { connectionId: 'other' }, { agentId: 'other' }, { agentRevision: 2 }])('rejects changed model/agent authority: %j', patch => {
    expect(() => caoResumePolicy(suspended, JSON.stringify({ ...authority, ...patch }), 'agent', 'full')).toThrow('cao_control_resume_authority_changed');
  });
  it('rejects an unbound older turn instead of choosing another agent or model', () => {
    expect(() => caoResumePolicy({}, JSON.stringify(authority), 'agent', 'full')).toThrow('cao_control_resume_authority_changed');
  });
});
