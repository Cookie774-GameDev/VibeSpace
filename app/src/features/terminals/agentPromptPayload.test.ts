import { describe, expect, it } from 'vitest';
import { coordinationFilePath } from './agentPromptDelivery';
import { buildAgentPromptPayload } from './agentPromptPayload';

const CWD = 'C:\\repo';
const COORD = coordinationFilePath(CWD);

describe('buildAgentPromptPayload', () => {
  it('preserves default-mode briefing behavior for selected agents', () => {
    const payload = buildAgentPromptPayload({
      mode: 'default',
      cwd: CWD,
      agentSlug: 'coder',
      agentName: 'Coder',
      agentPrompt: 'The code word is APPLE.',
      projectName: 'VibeSpace',
      projectContext: 'Desktop AI workspace.',
      contextMapSummary: 'app/src — frontend',
      coordinationFilePath: COORD,
    });

    expect(payload.shouldWriteInstructionFiles).toBe(true);
    expect(payload.shouldEnsureCoordinationDoc).toBe(true);
    expect(payload.allowLedgerWrites).toBe(false);
    expect(payload.allowFileLocks).toBe(false);
    expect(payload.briefingBody).toContain('The code word is APPLE.');
    expect(payload.briefingBody).toContain('Desktop AI workspace.');
    expect(payload.briefingBody).not.toContain('## Coordination Summary');
  });

  it('adds terminal identity and coordination summary only in coordinated mode', () => {
    const payload = buildAgentPromptPayload({
      mode: 'coordinated',
      cwd: CWD,
      terminalId: 'tty-a',
      agentSlug: 'critic',
      agentName: 'Critic',
      agentPrompt: 'Review carefully.',
      projectName: 'VibeSpace',
      contextMapSummary: 'app/src/features/terminals — terminal system',
      coordinationSummary: '## Coordination Summary\n- Gemini owns AgentRolePicker.tsx',
      coordinationFilePath: COORD,
    });

    expect(payload.shouldWriteInstructionFiles).toBe(true);
    expect(payload.shouldEnsureCoordinationDoc).toBe(true);
    expect(payload.allowLedgerWrites).toBe(true);
    expect(payload.allowFileLocks).toBe(true);
    expect(payload.briefingBody).toContain('## Terminal identity');
    expect(payload.briefingBody).toContain('tty-a');
    expect(payload.briefingBody).toContain('Gemini owns AgentRolePicker.tsx');
  });

  it('returns an isolated empty plan for no-context mode', () => {
    const payload = buildAgentPromptPayload({
      mode: 'no-context',
      cwd: CWD,
      terminalId: 'tty-a',
      agentSlug: 'coder',
      agentName: 'Coder',
      agentPrompt: 'The code word is APPLE.',
      projectName: 'VibeSpace',
      projectContext: 'Private project context.',
      contextMapSummary: 'Secret file map.',
      coordinationSummary: 'Locked files.',
      coordinationFilePath: COORD,
    });

    expect(payload.shouldWriteInstructionFiles).toBe(false);
    expect(payload.shouldEnsureCoordinationDoc).toBe(false);
    expect(payload.allowLedgerWrites).toBe(false);
    expect(payload.allowFileLocks).toBe(false);
    expect(payload.briefingBody).toBeNull();
    expect(payload.managedBlock).toBeNull();
  });
});
