import { describe, expect, it } from 'vitest';
import { inferFallbackActionProposals } from './fallbackActions';

describe('inferFallbackActionProposals', () => {
  it('does not invent actions for protected Context turns', () => {
    const proposals = inferFallbackActionProposals(
      [
        'Call the real `vibespace_context` function now.',
        'If a search item preview contains the answer, cite its exact title and path.',
        'Only call operation="open" when the preview is insufficient.',
      ].join('\n'),
      'I will run those bounded Context searches.',
    );

    expect(proposals).toEqual([]);
  });

  it('does not infer VibeSpace file I/O or arbitrary shell execution', () => {
    const requests = [
      ['Read C:\\Users\\viper\\Downloads\\notes.txt and summarize it.', 'I will read it.'],
      ['Create C:\\Users\\viper\\Downloads\\notes.txt containing hello.', 'Created.'],
      ['Replace the entire contents of C:\\Users\\viper\\Downloads\\notes.txt with hello.', 'Updated.'],
      ['Open a terminal and run Get-Location.', 'I will run that command.'],
      ['Run this PowerShell: Set-Content C:\\tmp\\note.txt hello.', 'Running it now.'],
    ] as const;

    for (const [userText, assistantText] of requests) {
      const proposals = inferFallbackActionProposals(userText, assistantText);
      expect(proposals.map(({ action_id }) => action_id)).toEqual([]);
    }
  });

  it('opens the requested Settings surface when the model only gives navigation prose', () => {
    expect(
      inferFallbackActionProposals('Open Settings.', 'You can find that under Settings.')[0],
    ).toMatchObject({ action_id: 'settings.open', params: {} });
    expect(
      inferFallbackActionProposals('Show connected plugins.', 'Open Settings, then Plugins.')[0],
    ).toMatchObject({ action_id: 'settings.plugins', params: {} });
  });

  it('opens one terminal pane without trying to execute arbitrary commands', () => {
    expect(
      inferFallbackActionProposals('Open a new terminal for me.', 'I cannot open terminals.' )[0],
    ).toMatchObject({ action_id: 'terminal.bulkOpen', params: { count: 1 } });
    expect(
      inferFallbackActionProposals(
        'Open a terminal and run Get-Location.',
        'I already ran it.',
      ),
    ).toEqual([]);
  });

  it('starts only a named native CLI through terminal.start_cli', () => {
    expect(
      inferFallbackActionProposals(
        'Open a terminal and run OpenCode.',
        'I will start the CLI.',
      )[0],
    ).toMatchObject({ action_id: 'terminal.start_cli', params: { cli: 'opencode' } });
    expect(
      inferFallbackActionProposals(
        'Open a new terminal and run Claude Code.',
        'I will start Claude.',
      )[0],
    ).toMatchObject({ action_id: 'terminal.start_cli', params: { cli: 'claude' } });
  });

  it('preserves bounded terminal open, close, and existing-pane messaging actions', () => {
    expect(
      inferFallbackActionProposals('Open five terminals with Codex.', 'Here is the plan.')[0],
    ).toMatchObject({
      action_id: 'terminal.bulkOpen',
      params: { count: 5, command: 'codex' },
    });
    expect(
      inferFallbackActionProposals('Close all terminals.', 'I will close them.')[0],
    ).toMatchObject({ action_id: 'terminal.bulkClose', params: { count: 10 } });
    expect(
      inferFallbackActionProposals(
        'Type opencode in all terminals and press enter.',
        'I will send it to every pane.',
      )[0],
    ).toMatchObject({ action_id: 'terminal.sendAll', params: { command: 'opencode' } });
  });

  it('keeps creator, saved-agent, and schedule fallbacks available', () => {
    expect(
      inferFallbackActionProposals('Create a Jarvis skill.', 'I can open the skill creator.')[0],
    ).toMatchObject({ action_id: 'creator.start', params: { kind: 'skill' } });
    expect(
      inferFallbackActionProposals(
        'Spawn one child agent to review the cache. Use the saved agent id agt_local_llama.',
        'I will launch the exact saved agent.',
      )[0],
    ).toMatchObject({ action_id: 'agent.run', params: { agentId: 'agt_local_llama' } });
    expect(
      inferFallbackActionProposals(
        'Create a daily schedule to summarize the project each morning.',
        'I can set that up.',
      )[0],
    ).toMatchObject({ action_id: 'schedule.create' });
  });

  it('does nothing for vague requests', () => {
    expect(inferFallbackActionProposals('Can you help me?', 'Sure.')).toEqual([]);
  });
});