import { describe, expect, it } from 'vitest';
import { inferFallbackActionProposals } from './fallbackActions';

describe('inferFallbackActionProposals', () => {
  it('proposes opening Settings when a local model only replies in prose', () => {
    const proposals = inferFallbackActionProposals(
      'Okay can you open the settings page please',
      "I'll open the Settings page for you.",
    );

    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({
      action_id: 'settings.open',
      params: {},
      rationale: expect.stringMatching(/settings/i),
    });
  });

  it('proposes the Plugins settings tab for plugin connection questions', () => {
    const proposals = inferFallbackActionProposals(
      'show me connected plugins in VibeSpace',
      'You can navigate to Settings and then Plugins.',
    );

    expect(proposals[0]).toMatchObject({
      action_id: 'settings.plugins',
      params: {},
    });
  });

  it('proposes broadcasting opencode to existing terminals', () => {
    const proposals = inferFallbackActionProposals(
      'type opencode in all of the terminals and click enter please',
      'I will run opencode in all terminals.',
    );

    expect(proposals[0]).toMatchObject({
      action_id: 'terminal.sendAll',
      params: { command: 'opencode' },
    });
  });

  it('proposes opening a requested number of new terminal panes', () => {
    const proposals = inferFallbackActionProposals(
      'open five terminals',
      'Here is some JavaScript you could use to open terminals.',
    );

    expect(proposals[0]).toMatchObject({
      action_id: 'terminal.bulkOpen',
      params: { count: 5 },
      rationale: expect.stringMatching(/5 terminal/i),
    });
  });

  it('proposes opening bulk terminals with a shared startup command', () => {
    const proposals = inferFallbackActionProposals(
      'open 5 terminals with opencode',
      'Run this code to create five panes.',
    );

    expect(proposals[0]).toMatchObject({
      action_id: 'terminal.bulkOpen',
      params: { count: 5, command: 'opencode' },
    });
  });

  it('does not open terminals for vague terminal questions', () => {
    expect(
      inferFallbackActionProposals(
        'why are my terminals weird?',
        'The terminal output may be distorted.',
      ),
    ).toEqual([]);
  });

  it('does not invent actions for vague requests', () => {
    expect(inferFallbackActionProposals('can you help me?', 'Sure.')).toEqual([]);
  });
});
